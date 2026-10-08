import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudSync} from '../../src/lib/cloud-sync.js';
import {cloudStatus,renderCloudPanel,renderImportedRuns} from '../../src/lib/cloud-panel.js';
import {fixture} from './fixture.mjs';

function memory(initial){let value=initial??{format:1,store:null,generation:null,epoch:null,revision:null,entities:{},outbox:[],conflicts:[],importedRuns:[],importStatus:null};return {async read(){return structuredClone(value);},async update(fn){const d=structuredClone(value),r=fn(d);value=d;return structuredClone(r);}};}
function network(f){const n={failures:{},actions:[],commands:[],hold:null,loseAck:false,receipt:null,bundled:null};n.fetcher=async(path,opts)=>{
 if(path==='/api/auth/session'||path==='/api/auth/login')return Response.json({ok:true,authenticated:true,csrf:'test'});
 const {action,payload}=JSON.parse(opts.body);if(['pull','recover'].includes(action))return Response.json({ok:false,error:'ACTION_INVALID'},{status:400});n.actions.push(action);if(n.hold)await n.hold(action);
 if(n.failures[action])return Response.json({ok:false,error:n.failures[action],retryable:true},{status:503});
 let result;
 if(action==='command'){n.commands.push(structuredClone(payload));try{result=f.api.command(payload);}catch(e){return Response.json({ok:false,error:e.message},{status:409});}if(n.loseAck){n.loseAck=false;throw Error('Lost ACK');}if(n.receipt)result=n.receipt(result);}
 else if(action==='snapshot'){result=f.api.snapshot(payload);delete result.syncMeta;if(n.bundled&&payload.cursor===null)result.syncMeta=structuredClone(n.bundled);}
 else if(action==='imports')result={revision:f.writer.status().revision,runs:[],nextCursor:null};
 else result={status:'idle'};
 return Response.json({ok:true,result});
};return n;}
const edit=a=>a.commit(a.state(),{...a.state(),wake:{'2026-10-07':'07:15'}});
const saved=view=>/Google Drive に保存済み/.test(cloudStatus(view,'cloud'));
const bundle=(revision=0)=>({format:1,imports:{ok:true,result:{revision,runs:[],nextCursor:null}},importStatus:{ok:true,result:{status:'idle'}}});

test('a matching durable ACK remains saved when the following record read yields, including after reload',async()=>{
 const f=fixture(),storage=memory(),n=network(f),a=createCloudSync({storage,fetcher:n.fetcher});await a.init();n.failures.snapshot='STORE_YIELD';
 await edit(a);await a.sync();assert.equal(a.view().pending,0);assert.equal(a.view().recordsConfirmed,true);assert.equal(a.view().confirmationKind,'receipt');assert.equal(a.view().verified,false);assert.equal(a.view().errorPhase,'snapshot');
 assert.equal(cloudStatus(a.view(),'cloud'),'Google Drive に保存済み · 最新の記録は確認待ち');assert.match(renderCloudPanel(a.view(),'cloud'),/最新の記録の確認/);
 const persisted=await storage.read();assert.equal(persisted.format,1);assert.equal(persisted.recordConfirmation.kind,'receipt');assert.equal(persisted.entities['wake:2026-10-07'].value,'07:15');assert.deepEqual(persisted.outbox,[]);a.destroy();
 const b=createCloudSync({storage,fetcher:n.fetcher});await b.init();assert.equal(b.state().wake['2026-10-07'],'07:15');assert.equal(saved(b.view()),true);assert.match(cloudStatus(b.view(),'cloud'),/最新の記録は確認待ち/);b.destroy();
});

test('markerless legacy caches and mismatched confirmation metadata never imply remote saved from pending zero',async()=>{
 const f=fixture(),n=network(f),s=memory(),a=createCloudSync({storage:s,fetcher:n.fetcher});await a.init();a.destroy();const original=await s.read();
 for(const mutate of [d=>{delete d.recordConfirmation;},d=>{d.recordConfirmation.generation='other';},d=>{d.recordConfirmation.store='other';},d=>{d.recordConfirmation.epoch='other';},d=>{d.recordConfirmation.revision++;},d=>{d.recordConfirmation.kind='unknown';}]){
  const d=structuredClone(original);mutate(d);n.failures.snapshot='STORE_YIELD';const b=createCloudSync({storage:memory(d),fetcher:n.fetcher});await b.init();assert.equal(b.view().ready,true);assert.equal(b.view().pending,0);assert.equal(b.view().recordsConfirmed,false);assert.equal(saved(b.view()),false);b.destroy();
 }
 const b=createCloudSync({storage:memory(),fetcher:n.fetcher});await b.init();assert.equal(b.view().ready,false);assert.equal(saved(b.view()),false);b.destroy();
});

test('a lost ACK retains the identical queued command and cannot reuse old confirmation to claim saved',async()=>{
 const f=fixture(),n=network(f),s=memory(),a=createCloudSync({storage:s,fetcher:n.fetcher});await a.init();n.loseAck=true;await edit(a);await a.sync({automatic:true});
 const queued=(await s.read()).outbox[0];assert.equal(a.view().pending,1);assert.equal(saved(a.view()),false);assert.equal(a.view().errorPhase,'command');assert.equal(f.api.snapshot({cursor:null,revision:null}).entities[0].value,'07:15');
 a.destroy();const b=createCloudSync({storage:s,fetcher:n.fetcher});await b.init();assert.equal(b.view().pending,0);assert.equal(n.commands.length,2);assert.deepEqual(n.commands[1],queued.command);assert.equal(f.api.snapshot({cursor:null,revision:null}).entities[0].version,1);assert.equal(saved(b.view()),true);b.destroy();
});

test('an invalid receipt never drops or rewrites the outbox command',async()=>{
 const f=fixture(),n=network(f),s=memory(),a=createCloudSync({storage:s,fetcher:n.fetcher});await a.init();n.receipt=r=>({...r,operationId:'unrelated'});await edit(a);await a.sync({automatic:true});
 const queued=(await s.read()).outbox;assert.equal(queued.length,1);assert.equal(queued[0].status,'pending');assert.deepEqual(queued[0].command,n.commands[0]);assert.equal(saved(a.view()),false);assert.equal(a.view().error,'RECEIPT_INVALID');a.destroy();
});

test('another browser can confirm the saved record even when CSV status is busy',async()=>{
 const f=fixture(),n=network(f),a=createCloudSync({storage:memory(),fetcher:n.fetcher});await a.init();await edit(a);await a.sync();a.destroy();
 n.failures.importStatus='WRITER_BUSY';const b=createCloudSync({storage:memory(),fetcher:n.fetcher});await b.init();
 assert.equal(b.state().wake['2026-10-07'],'07:15');assert.equal(b.view().pending,0);assert.equal(b.view().verified,true);assert.equal(b.view().error,null);assert.deepEqual(b.view().importErrors,{importStatus:'WRITER_BUSY'});assert.equal(cloudStatus(b.view(),'cloud'),'Google Drive に保存済み · ランの確認待ち');
 assert.match(renderCloudPanel(b.view(),'cloud'),/ランの取り込み状況: ほかの保存処理が終わるのを待っています/);assert.doesNotMatch(renderCloudPanel(b.view(),'cloud'),/復旧を要確認|同期できません|WRITER_BUSY/);b.destroy();
});

test('failed import listing retains its cached runs while status can still succeed',async()=>{
 const f=fixture(),n=network(f),s=memory(),a=createCloudSync({storage:s,fetcher:n.fetcher});await a.init();await s.update(d=>{d.importedRuns=[{id:'previous',sampleCount:2}];});n.failures.imports='STORE_YIELD';await a.sync();
 assert.equal(a.view().verified,true);assert.equal(a.view().error,null);assert.deepEqual(a.view().importErrors,{imports:'STORE_YIELD'});assert.equal(a.view().importStatus.status,'idle');assert.equal(a.view().importedRuns[0].id,'previous');assert.match(renderImportedRuns(a.view()),/取り込み済みのラン: 確認に時間/);a.destroy();
});

test('bundled snapshot metadata avoids separate import and status requests',async()=>{
 const f=fixture(),n=network(f);n.bundled=bundle();const a=createCloudSync({storage:memory(),fetcher:n.fetcher});await a.init();assert.deepEqual(n.actions,['snapshot']);assert.equal(a.view().verified,true);assert.equal(a.view().importStatus.status,'idle');assert.deepEqual(a.view().importErrors,{});a.destroy();
});

test('bundled auxiliary errors preserve record confirmation and have their own retry state',async()=>{
 const f=fixture(),n=network(f);n.bundled=bundle();n.bundled.imports={ok:false,error:'STORE_YIELD',retryable:true};n.bundled.importStatus={ok:false,error:'WRITER_BUSY',retryable:true};
 const a=createCloudSync({storage:memory(),fetcher:n.fetcher,now:()=>100});await a.init();assert.deepEqual(n.actions,['snapshot']);assert.equal(a.view().recordsConfirmed,true);assert.equal(a.view().verified,true);assert.equal(a.view().error,null);assert.equal(a.view().retryAt,0);assert.equal(a.view().importRetryAt,60100);assert.equal(saved(a.view()),true);a.destroy();
});

test('ancillary backoff and required import setup do not block a newly saved diary edit',async()=>{
 for(const error of ['WRITER_BUSY','WRITER_RECOVERY_SETUP_REQUIRED']){
  const f=fixture(),n=network(f),a=createCloudSync({storage:memory(),fetcher:n.fetcher,now:()=>100});n.failures.importStatus=error;await a.init();const before=n.actions.filter(x=>x==='importStatus').length;
  await edit(a);await a.sync({automatic:true});assert.equal(a.view().pending,0);assert.equal(a.view().error,null);assert.equal(a.view().automaticPaused,false);assert.equal(a.view().verified,true);assert.equal(n.commands.length,1);assert.equal(n.actions.filter(x=>x==='importStatus').length,before);assert.equal(a.view().importErrors.importStatus,error);a.destroy();
 }
});

test('an edit during an ancillary request drains after the request even if that request fails',async()=>{
 const f=fixture(),n=network(f),a=createCloudSync({storage:memory(),fetcher:n.fetcher});await a.init();let inject=true;
 n.hold=async action=>{if(inject&&action==='importStatus'){inject=false;await edit(a);}};n.failures.importStatus='WRITER_BUSY';await a.sync();
 assert.equal(a.view().pending,0);assert.equal(n.commands.length,1);assert.equal(a.state().wake['2026-10-07'],'07:15');assert.equal(saved(a.view()),true);assert.equal(a.view().importErrors.importStatus,'WRITER_BUSY');a.destroy();
});

test('conflicts override confirmed saves and ancillary failures without rewriting pending operations',async()=>{
 const f=fixture(),n=network(f),s=memory(),a=createCloudSync({storage:memory(),fetcher:n.fetcher}),b=createCloudSync({storage:s,fetcher:n.fetcher});await a.init();await b.init();await edit(a);await a.sync();
 n.failures.importStatus='WRITER_BUSY';await b.commit(b.state(),{...b.state(),wake:{'2026-10-07':'09:00'}});await b.sync();
 assert.equal(b.view().pending,1);assert.equal(b.view().conflicts.length,1);assert.equal(saved(b.view()),false);assert.match(cloudStatus(b.view(),'cloud'),/別の変更があります/);const queued=(await s.read()).outbox[0];assert.equal(queued.status,'conflict');assert.equal(queued.command.expectedVersion,0);assert.equal(queued.command.value,'09:00');a.destroy();b.destroy();
});

test('logout during an ancillary reply hides confirmation and prevents another auxiliary request',async()=>{
 const f=fixture(),n=network(f),a=createCloudSync({storage:memory(),fetcher:n.fetcher});await a.init();let release,entered;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
 n.hold=async action=>{if(action==='imports'){entered();await wait;}};n.failures.imports='WRITER_BUSY';const ongoing=a.sync();await started;const at=n.actions.length;a.lock();release();await ongoing;
 assert.equal(n.actions.length,at);assert.equal(a.view().authenticated,false);assert.equal(a.view().verified,false);assert.deepEqual(a.view().importErrors,{});assert.equal(saved(a.view()),false);a.destroy();
});

function maintenanceNetwork(f,{error=null,hold=null,tamper=r=>r}={}){
 const n=network(f);n.bundled={...bundle(),storageMaintenance:{due:true,replayFrames:16,softLimit:16,hardLimit:64}};const original=n.fetcher;
 n.fetcher=async(path,opts)=>{
  if(path==='/api/sync'&&JSON.parse(opts.body).action==='maintain'){
   n.actions.push('maintain');if(hold)await hold();
   if(error)return Response.json({ok:false,error,retryable:true},{status:503});
   const status=f.writer.status();return Response.json({ok:true,result:tamper({protocol:2,ready:true,store:status.storeId,generation:status.datasetGeneration,revision:status.revision,headHash:status.headHash,writerFence:status.writerFence,maintenance:{due:false,replayFrames:0,softLimit:16,hardLimit:64}})});
  }return original(path,opts);
 };return n;
}
test('idle maintenance is an auxiliary single request and failure cannot revoke a confirmed save',async()=>{
 const f=fixture(),n=maintenanceNetwork(f,{error:'WRITER_RECOVERY_PENDING'}),a=createCloudSync({storage:memory(),fetcher:n.fetcher,now:()=>100});await a.init();
 assert.equal(n.actions.filter(x=>x==='maintain').length,1);assert.equal(a.view().error,null);assert.equal(a.view().verified,true);assert.equal(a.view().recordsConfirmed,true);assert.equal(saved(a.view()),true);assert.equal(a.view().maintenanceError,'WRITER_RECOVERY_PENDING');assert.equal(a.view().maintenanceRetryAt,60100);
 await a.sync({automatic:true});assert.equal(n.actions.filter(x=>x==='maintain').length,1);a.destroy();
});
test('a local edit made during one maintenance slice persists immediately and drains before further maintenance',async()=>{
 const f=fixture();let a,inject=false;
 const n=maintenanceNetwork(f,{error:'STORE_YIELD',hold:async()=>{if(inject){inject=false;await edit(a);assert.equal(a.view().pending,1);}}});
 a=createCloudSync({storage:memory(),fetcher:n.fetcher,now:()=>100});await a.init();
 // First failed auxiliary request backs off; use a fresh authenticated client
 // over the same durable state to exercise an edit during a new slice.
 a.destroy();const storage=memory();inject=false;a=createCloudSync({storage,fetcher:n.fetcher,now:()=>100});await a.init();a.destroy();
 a=createCloudSync({storage,fetcher:n.fetcher,now:()=>100});inject=true;await a.init();
 assert.equal(a.view().pending,0);assert.equal(n.commands.at(-1).value,'07:15');assert.equal(a.view().error,null);a.destroy();
});


test('maintenance success never changes the locally verified cut or record confirmation',async()=>{
 const f=fixture(),n=maintenanceNetwork(f),storage=memory(),a=createCloudSync({storage,fetcher:n.fetcher});await a.init();
 assert.equal(n.actions.filter(x=>x==='maintain').length,1);assert.equal(a.view().maintenanceError,null);assert.equal(a.view().verified,true);assert.equal(a.view().revision,f.writer.status().revision);assert.equal(a.view().confirmationKind,'snapshot');a.destroy();
});
for(const patch of [{store:'foreign'},{generation:'foreign'}])test(`foreign maintenance ${Object.keys(patch)[0]} cannot be accepted as local maintenance`,async()=>{
 const f=fixture(),n=maintenanceNetwork(f,{tamper:r=>({...r,...patch})}),a=createCloudSync({storage:memory(),fetcher:n.fetcher});await a.init();
 assert.equal(a.view().maintenanceError,'MAINTENANCE_IDENTITY_CHANGED');assert.equal(a.view().error,null);assert.equal(a.view().verified,true);assert.equal(a.view().recordsConfirmed,true);a.destroy();
});
test('logout during maintenance leaves records retained without reviving session or auxiliary status',async()=>{
 const f=fixture();let a;const n=maintenanceNetwork(f,{hold:async()=>a.lock()}),storage=memory();a=createCloudSync({storage,fetcher:n.fetcher});await a.init();
 assert.equal(a.view().authenticated,false);assert.equal(a.view().maintenanceError,null);assert.equal(a.view().maintenanceRetryAt,0);assert.equal((await storage.read()).store,'store');a.destroy();
});
