import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudSync} from '../../src/lib/cloud-sync.js';
import {cloudStatus,cloudErrorText,renderCloudPanel} from '../../src/lib/cloud-panel.js';
import {fixture} from './fixture.mjs';

function memory(){let value={format:1,store:null,generation:null,epoch:null,revision:null,entities:{},outbox:[],conflicts:[],importedRuns:[],importStatus:null};return {async read(){return structuredClone(value);},async update(fn){const d=structuredClone(value),r=fn(d);value=d;return structuredClone(r);}};}
function network(f){const n={failure:null,status:503,paths:[],actions:[],commands:[],hold:null};n.fetcher=async(path,opts)=>{
 n.paths.push(path);
 if(path==='/api/auth/session'||path==='/api/auth/login')return Response.json({ok:true,authenticated:true,csrf:'test'});
 const {action,payload}=JSON.parse(opts.body);if(['pull','recover'].includes(action))return Response.json({ok:false,error:'ACTION_INVALID'},{status:400});n.actions.push(action);
 if(n.hold)await n.hold(action);
 if(n.failure)return Response.json({ok:false,error:n.failure},{status:n.status});
 let result;
 if(action==='command'){n.commands.push(payload);result=f.api.command(payload);}
 else if(action==='snapshot')result=f.api.snapshot(payload);
 else if(action==='imports')result={revision:f.writer.status().revision,runs:[],nextCursor:null};
 else result={status:'idle'};
 return Response.json({ok:true,result});
};return n;}

for(const code of ['WRITER_RECOVERY_SETUP_REQUIRED'])test(`${code} pauses automatic calls without losing edits; manual success clears pause`,async()=>{
 const f=fixture(),storage=memory(),n=network(f);let now=0;const a=createCloudSync({storage,fetcher:n.fetcher,now:()=>now});await a.init();
 n.failure=code;await a.refreshSession({automatic:true});assert.equal(a.view().automaticPaused,true);assert.equal(a.view().verified,false);
 const at=n.paths.length;
 for(let i=0;i<4;i++){now+=3600000;await a.refreshSession({automatic:true});await a.sync({automatic:true});}
 assert.equal(n.paths.length,at,'timer/visibility/online calls do not restart paused recovery');
 await a.commit(a.state(),{...a.state(),wake:{'2026-10-06':'07:20'}});
 assert.equal(n.paths.length,at,'a durable edit does not bypass the pause');
 const queued=await storage.read(),id=queued.outbox[0].command.operationId;
 assert.equal(a.view().pending,1);assert.equal(a.view().conflicts.length,0);assert.equal(a.state().wake['2026-10-06'],'07:20');
 // An unrelated failure during explicit retry must not silently enable automatic recovery.
 n.failure='OFFLINE';await a.refreshSession();assert.equal(a.view().automaticPaused,true);
 n.failure=null;await a.refreshSession({automatic:false});
 assert.equal(a.view().error,null);assert.equal(a.view().automaticPaused,false);assert.equal(a.view().retryAt,0);assert.equal(a.view().verified,true);
 assert.equal(a.view().pending,0);assert.equal(n.commands.at(-1).operationId,id);assert.equal(cloudStatus(a.view(),'cloud'),'Google Drive に保存済み');
 const recovered=n.paths.length;await a.refreshSession({automatic:true});assert(n.paths.length>recovered);a.destroy();
});

for(const failure of ['STORE_YIELD','WRITER_BUSY','WRITER_RECOVERY_PENDING'])test(`${failure} backs off exponentially with a fifteen-minute cap and allows manual retry`,async()=>{
 const f=fixture(),n=network(f);let now=100;const a=createCloudSync({storage:memory(),fetcher:n.fetcher,now:()=>now});await a.init();n.failure=failure;
 for(const delay of [60000,120000,240000,480000,900000,900000]){
  await a.refreshSession({automatic:true});assert.equal(a.view().automaticPaused,false);assert.equal(a.view().retryAt,now+delay);
  const at=n.paths.length;now+=delay-1;await a.refreshSession({automatic:true});assert.equal(n.paths.length,at);
  now++;
 }
 n.failure=null;await a.refreshSession();assert.equal(a.view().error,null);assert.equal(a.view().retryAt,0);a.destroy();
});

test('overlapping automatic events and explicit retry join one in-flight request without a second cold sync',async()=>{
 const f=fixture(),n=network(f),a=createCloudSync({storage:memory(),fetcher:n.fetcher});await a.init();n.actions=[];n.paths=[];
 let release,seen;const entered=new Promise(r=>seen=r),wait=new Promise(r=>release=r);n.hold=async action=>{if(action==='snapshot'){seen();await wait;}};
 const first=a.refreshSession({automatic:true});await entered;
 const again=[a.refreshSession({automatic:true}),a.refreshSession({automatic:true}),a.refreshSession({automatic:false}),a.sync()];
 assert.deepEqual(n.actions,['snapshot']);assert.equal(n.paths.filter(p=>p==='/api/auth/session').length,1);
 n.failure='STORE_YIELD';release();await Promise.all([first,...again]);
 assert.deepEqual(n.actions,['snapshot']);assert.equal(a.view().error,'STORE_YIELD');assert.equal(a.view().automaticPaused,false);assert(a.view().retryAt>0);
 n.hold=null;n.failure=null;await a.refreshSession();assert.equal(n.actions.filter(x=>x==='snapshot').length,2);assert.equal(a.view().automaticPaused,false);a.destroy();
});

test('a new durable edit during manual recovery is drained after its in-flight snapshot',async()=>{
 const f=fixture(),n=network(f),a=createCloudSync({storage:memory(),fetcher:n.fetcher});await a.init();n.failure='STORE_YIELD';await a.sync();n.failure=null;
 let inject=true;n.hold=async action=>{if(inject&&action==='snapshot'){inject=false;await a.commit(a.state(),{...a.state(),wake:{'2026-10-06':'06:45'}});}};
 await a.refreshSession();assert.equal(a.view().pending,0);assert.equal(a.view().automaticPaused,false);assert.equal(n.commands.at(-1).value,'06:45');a.destroy();
});

test('legacy 400 recovery replies never turn a pending command into a conflict',async()=>{
 for(const code of ['STORE_YIELD','WRITER_BUSY','WRITER_RECOVERY_PENDING','WRITER_RECOVERY_SETUP_REQUIRED','SYNC_V2_MIGRATION_REQUIRED','WRITER_FORMAT_FENCE_REQUIRED','WRITER_FRAME_INVALID']){
  const f=fixture(),n=network(f),storage=memory(),a=createCloudSync({storage,fetcher:n.fetcher});await a.init();n.failure=code;n.status=400;
  await a.commit(a.state(),{...a.state(),wake:{'2026-10-06':'06:55'}});await a.sync();
  assert.equal(a.view().pending,1);assert.equal(a.view().conflicts.length,0);assert.equal((await storage.read()).outbox[0].status,'pending');assert.equal(a.view().error,code);a.destroy();
 }
});

test('zero pending items, authentication, and cached state do not claim saved during recovery',async()=>{
 const f=fixture(),n=network(f),statuses=[],a=createCloudSync({storage:memory(),fetcher:n.fetcher,onChange:view=>statuses.push(cloudStatus(view,'cloud'))});
 n.failure='STORE_YIELD';await a.init();assert.equal(a.view().ready,false);assert.equal(a.view().pending,0);assert.equal(a.view().authenticated,true);
 assert.match(cloudStatus(a.view(),'cloud'),/Drive の記録をまだ確認できていません/);assert.match(cloudErrorText(a.view().error),/今すぐ同期/);assert.match(renderCloudPanel(a.view(),'cloud'),/data-action="cloud-sync"/);
 await a.refreshSession({automatic:true});await a.refreshSession();assert(statuses.every(text=>!text.includes('Google Drive に保存済み')));
 assert.doesNotMatch(cloudStatus({conflicts:[],pending:0,authenticated:true,ready:false,error:null},'cloud'),/保存済み/);
 a.destroy();
});

test('online listener respects pause and is removed on destroy',async t=>{
 const oldAdd=globalThis.addEventListener,oldRemove=globalThis.removeEventListener,listeners=new Map();
 globalThis.addEventListener=(type,fn)=>listeners.set(type,fn);globalThis.removeEventListener=(type,fn)=>{if(listeners.get(type)===fn)listeners.delete(type);};
 t.after(()=>{if(oldAdd)globalThis.addEventListener=oldAdd;else delete globalThis.addEventListener;if(oldRemove)globalThis.removeEventListener=oldRemove;else delete globalThis.removeEventListener;});
 const f=fixture(),n=network(f),a=createCloudSync({storage:memory(),fetcher:n.fetcher});n.failure='STORE_YIELD';await a.init();const at=n.paths.length;
 for(let i=0;i<3;i++)listeners.get('online')();await Promise.resolve();assert.equal(n.paths.length,at);a.destroy();assert.equal(listeners.size,0);
});
