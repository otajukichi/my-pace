import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createCloudSync,createIndexedDBStorage} from '../../src/lib/cloud-sync.js';
import {canonical} from '../../src/lib/entity-codec.js';
import {cloudStatus} from '../../src/lib/cloud-panel.js';
import {keyedIndexedDBDouble} from '../helpers/indexeddb-keyed-double.js';
const copy=x=>structuredClone(x);
// Synthetic transport fixture follows the real current writer receipt contract.
// Real producer compatibility and malformed fields are covered by strict-ack.test.mjs.
const digest=n=>createHash('sha256').update(String(n)).digest('hex');
const date=i=>new Date(Date.UTC(2000,0,1+i)).toISOString().slice(0,10);
const entry=(i,value='07:00',version=1)=>({key:'wake:'+date(i),version,deleted:false,value});
function server(initial=[]){
 const s={store:'store',generation:'generation',epoch:'epoch',entities:new Map(initial.map(x=>[x.key,copy(x)])),events:[],seq:0,revision:0,receipts:new Map(),cuts:new Map(),calls:[],commands:[],size:2,fail:null,hold:null,tamper:null,loseAck:false,unsupported:false,serial:0,floor:0,expire:false};
 s.change=(key,value,deleted=false)=>{const old=s.entities.get(key),e={key,version:(old?.version??0)+1,deleted,value:deleted?null:copy(value)};s.entities.set(key,e);s.seq++;s.revision++;s.events.push({seq:s.seq,key});return e;};
 s.fetcher=async(path,options)=>{
  if(path==='/api/auth/session')return Response.json({ok:true,authenticated:true,csrf:'test'});
  let {action,payload}=JSON.parse(options.body);s.calls.push({action,payload:copy(payload)});if(s.hold)await s.hold(action,payload);
  const error=typeof s.fail==='function'?s.fail(action,payload):s.fail;if(error)return Response.json({ok:false,error,retryable:true},{status:503});
  if(action==='recover'&&payload.pull){action='pull';payload=payload.pull;}
  let result;
  if(action==='command'){
   if(payload.store!==s.store||payload.generation!==s.generation)return Response.json({ok:false,error:'DATASET_GENERATION_MISMATCH'},{status:409});
   s.commands.push(copy(payload));result=s.receipts.get(payload.operationId);
   if(!result){const old=s.entities.get(payload.key);if((old?.version??0)!==payload.expectedVersion)return Response.json({ok:false,error:'ENTITY_VERSION_CONFLICT'},{status:409});const e=s.change(payload.key,payload.value,payload.deleted);result={operationId:payload.operationId,epoch:payload.epoch,digest:createHash('sha256').update(canonical(payload)).digest('hex'),revision:s.revision,frameId:'synthetic_frame_'+s.revision,frameHash:digest(s.revision),committedAt:'2026-10-08T00:00:00.000Z',result:{key:e.key,version:e.version,deleted:e.deleted,appSeq:s.seq},entityVersions:[{key:'app/data/'+e.key,version:e.version,deleted:e.deleted}]};s.receipts.set(payload.operationId,result);}
   if(s.loseAck){s.loseAck=false;throw Error('lost');}
  }else if(action==='pull'){
   if(s.unsupported)return Response.json({ok:false,error:'ACTION_INVALID'},{status:400});
   if([payload.since,payload.minimumAcknowledged].some(p=>p&&(p.store!==s.store||p.generation!==s.generation)))return Response.json({ok:false,error:'RESET_REQUIRED',resetReason:'identity-changed'},{status:409});
   if(s.expire&&payload.cursor){s.expire=false;return Response.json({ok:false,error:'SYNC_CURSOR_EXPIRED',retryable:true},{status:409});}
   let cut,position;
   if(payload.cursor){const token=s.cuts.get(payload.cursor);if(!token)return Response.json({ok:false,error:'RESET_REQUIRED'},{status:409});({cut,position}=token);}
   else{
    if(payload.since&&payload.since.seq<s.floor)return Response.json({ok:false,error:'RESET_REQUIRED',resetReason:'retention-floor'},{status:409});
    const mode=payload.since?'delta':'snapshot',fromSeq=payload.since?.seq??null;cut={store:s.store,generation:s.generation,epoch:s.epoch,mode,fromSeq,targetSeq:s.seq,revision:s.revision,headHash:digest(s.revision),entities:copy([...s.entities.values()]),events:copy(s.events.filter(e=>e.seq>(fromSeq??0)))};position=0;
   }
   if(payload.minimumAcknowledged&&payload.minimumAcknowledged.revision>cut.revision)return Response.json({ok:false,error:'SYNC_CUT_BEHIND',retryable:true},{status:409});
   const source=cut.mode==='snapshot'?cut.entities:cut.events,part=source.slice(position,position+s.size),last=position+part.length>=source.length;
   let nextCursor=null;if(!last){nextCursor='opaque-'+(++s.serial);s.cuts.set(nextCursor,{cut,position:position+part.length});}
   const fromSeq=cut.mode==='snapshot'?null:position?source[position-1].seq:cut.fromSeq;
   const entries=cut.mode==='snapshot'?part:[...new Set(part.map(e=>e.key))].map(key=>cut.entities.find(e=>e.key===key));
   result={protocol:2,mode:cut.mode,store:cut.store,generation:cut.generation,epoch:cut.epoch,revision:cut.revision,headHash:cut.headHash,fromSeq,targetSeq:cut.targetSeq,throughSeq:cut.mode==='snapshot'?(last?cut.targetSeq:null):part.at(-1)?.seq??fromSeq,entries,nextCursor,checkpoint:last?{store:cut.store,generation:cut.generation,seq:cut.targetSeq}:null};
   if(!payload.cursor)result.syncMeta={format:1,imports:{ok:true,result:{revision:cut.revision,runs:[],nextCursor:null}},importStatus:{ok:true,result:{status:'idle'}}};
   if(s.tamper)result=s.tamper(copy(result),payload);
  }else if(action==='recover'){result={protocol:2,ready:true,store:s.store,generation:s.generation,revision:s.revision,headHash:digest(s.revision),writerFence:2};}
  else if(action==='snapshot'){result={store:'store',generation:'generation',epoch:'epoch',revision:s.revision,entities:copy([...s.entities.values()]),cursor:null};}
  else if(action==='imports')result={revision:s.revision,runs:[],nextCursor:null};else result={status:'idle'};
  return Response.json({ok:true,result});
 };return s;
}
function client(s,idb=keyedIndexedDBDouble(),extra={}){const storage=createIndexedDBStorage(idb);const a=createCloudSync({storage,fetcher:s.fetcher,...extra});return {a,idb,storage};}
const saved=a=>cloudStatus(a.view(),'cloud').includes('Google Drive に保存済み');

test('stable paged bootstrap is durable, then idle sync reads no baseline entities',async()=>{
 const s=server(Array.from({length:7},(_,i)=>entry(i))),{a,idb}=client(s);await a.init();assert.equal(Object.keys(a.state().wake).length,7);assert.equal(saved(a),true);assert.equal(idb.read().syncProtocol,2);assert.equal(idb.read().syncCheckpoint.seq,0);assert.equal(s.calls.filter(x=>x.action==='pull').length,4);
 idb.resetMetrics();s.calls=[];await a.sync();assert.equal(s.calls.length,1);assert.equal(s.calls[0].action,'pull');assert.equal(s.calls[0].payload.since.seq,0);assert.equal(idb.metrics.entities?.getAll??0,0);assert.equal(idb.metrics.entities?.rowsRead??0,0);assert.equal(idb.metrics.state?.put??0,0);a.destroy();
});

test('one changed entity among one thousand uses a bounded delta and keyed IO',async()=>{
 const s=server(Array.from({length:1000},(_,i)=>entry(i)));s.size=24;const {a,idb}=client(s);await a.init();s.change('wake:'+date(500),'05:50');idb.resetMetrics();s.calls=[];await a.sync();
 assert.equal(a.state().wake[date(500)],'05:50');assert.equal(s.calls.length,1);assert.equal(idb.metrics.entities.getAll,0);assert(idb.metrics.entities.rowsRead<10);assert.equal(idb.metrics.entities.rowsWritten,1);assert.equal(idb.read().syncCheckpoint.seq,1);a.destroy();
});

test('bootstrap remains at its frozen cut while concurrent writes appear on the next delta',async()=>{
 const s=server([entry(0),entry(1),entry(2)]);let changed=false;s.hold=async(action,payload)=>{if(action==='pull'&&payload.cursor&&!changed){changed=true;s.change('wake:'+date(2),'09:00');s.change('wake:'+date(3),'10:00');}};
 const {a}=client(s);await a.init();assert.equal(a.state().wake[date(2)],'07:00');assert.equal(a.state().wake[date(3)],undefined);await a.sync();assert.equal(a.state().wake[date(2)],'09:00');assert.equal(a.state().wake[date(3)],'10:00');a.destroy();
});

test('interrupted initial snapshot stages pages without exposing an incomplete baseline and resumes after reload',async()=>{
 const s=server([entry(0),entry(1),entry(2)]),idb=keyedIndexedDBDouble();s.fail=(action,payload)=>action==='pull'&&payload.cursor?'STORE_YIELD':null;
 const first=client(s,idb);await first.a.init();assert.equal(first.a.view().ready,false);assert.equal(saved(first.a),false);assert.equal(Object.keys(idb.read().entities).length,0);assert.equal(idb.read().snapshotStage.nextPage,1);const cursor=idb.read().snapshotStage.meta.cursor;first.a.destroy();
 s.fail=null;s.calls=[];const second=client(s,idb);await second.a.init();assert.equal(s.calls[0].payload.cursor,cursor);assert.equal(Object.keys(second.a.state().wake).length,3);assert.equal(idb.read().snapshotStage,null);second.a.destroy();
});

test('snapshot restart after expiry preserves the earlier active baseline',async()=>{
 const s=server([entry(0)]),{a,idb}=client(s);await a.init();s.change('wake:'+date(1),'08:00');s.change('wake:'+date(2),'09:00');s.floor=s.seq;s.expire=true;
 await a.sync();assert.equal(a.state().wake[date(2)],'09:00');assert.equal(idb.read().syncCheckpoint.seq,2);assert.equal(idb.read().outbox.length,0);assert.equal(saved(a),true);a.destroy();
});

test('delta data and cursor are atomic when a local transaction fails',async()=>{
 const s=server([entry(0)]),{a,idb}=client(s);await a.init();s.change('wake:'+date(0),'08:45');idb.fail();await a.sync();assert.equal(idb.read().entities['wake:'+date(0)].value,'07:00');assert.equal(idb.read().syncCheckpoint.seq,0);assert.equal(saved(a),true);assert.match(cloudStatus(a.view(),'cloud'),/最新の記録は確認待ち/);
 await a.sync();assert.equal(idb.read().entities['wake:'+date(0)].value,'08:45');assert.equal(idb.read().syncCheckpoint.seq,1);a.destroy();
});

test('raw parentless habit logs survive a partial delta and are visible when its parent arrives',async()=>{
 const s=server(),{a,idb}=client(s);await a.init();s.size=1;s.change('habitLog:reading:2026-10-07',true);s.change('habit:reading',{id:'reading',name:'読む',type:'check',unit:'',target:1,archived:false});s.fail=(action,payload)=>action==='pull'&&payload.cursor?'STORE_YIELD':null;
 await a.sync();assert.equal(idb.read().entities['habitLog:reading:2026-10-07'].value,true);assert.equal(idb.read().syncCheckpoint.seq,0);assert.equal(idb.read().syncContinuation.throughSeq,1);s.fail=null;await a.sync();assert.equal(a.state().habitLogs.reading['2026-10-07'],true);assert.equal(idb.read().syncCheckpoint.seq,2);a.destroy();
});

test('duplicate keys across snapshot pages never replace the existing baseline',async()=>{
 const s=server([entry(0),entry(1),entry(2)]),{a,idb}=client(s);s.tamper=(page,payload)=>payload.cursor?{...page,entries:[entry(0)]}:page;await a.init();assert.equal(a.view().ready,false);assert.equal(idb.read().syncCheckpoint,undefined);assert.match(a.view().error,/DUPLICATE/);assert.equal(saved(a),false);a.destroy();
});

test('delta gaps, changed cuts and early checkpoints cannot advance the durable checkpoint',async()=>{
 for(const tamper of [page=>({...page,fromSeq:page.fromSeq+1}),page=>({...page,headHash:digest(999)}),page=>({...page,checkpoint:{store:'store',generation:'generation',seq:page.targetSeq}})]){
  const s=server(),{a,idb}=client(s);await a.init();s.size=1;s.change('wake:'+date(0),'08:00');s.change('wake:'+date(1),'09:00');s.change('wake:'+date(2),'10:00');s.tamper=(page,payload)=>payload.cursor?tamper(page):page;await a.sync();assert.equal(idb.read().syncCheckpoint.seq,0);assert.equal(idb.read().syncContinuation.throughSeq,1);assert.equal(a.view().verified,false);a.destroy();
 }
});

test('repeated target-root values across delta pages are idempotent',async()=>{
 const s=server(),{a,idb}=client(s);await a.init();s.size=1;s.change('wake:'+date(0),'08:00');s.change('wake:'+date(0),'09:00');s.change('wake:'+date(0),'10:00');await a.sync();assert.equal(a.state().wake[date(0)],'10:00');assert.equal(idb.read().entities['wake:'+date(0)].version,3);assert.equal(idb.read().syncCheckpoint.seq,3);a.destroy();
});

test('a lost command acknowledgement replays the same operation before pulling deltas',async()=>{
 const s=server(),{a,idb}=client(s);await a.init();s.loseAck=true;await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'08:15'}});await a.sync({automatic:true});const queued=copy(idb.read().outbox[0]);assert.equal(saved(a),false);assert.equal(s.seq,1);
 a.destroy();s.calls=[];const {a:b}=client(s,idb);await b.init();assert.equal(s.calls[0].action,'command');assert.deepEqual(s.calls[0].payload,queued.command);assert.equal(s.seq,1);assert.equal(b.view().pending,0);assert.equal(idb.read().minimumAcknowledged.hash,digest(1));assert.equal(idb.read().syncCheckpoint.seq,1);b.destroy();
});

test('protocol v2 never silently downgrades after a rollout mismatch',async()=>{
 const s=server(),{a,idb}=client(s);await a.init();s.unsupported=true;s.calls=[];await a.sync();assert.equal(a.view().error,'SYNC_DEPLOYMENT_MISMATCH');assert.deepEqual(s.calls.map(x=>x.action),['pull']);assert.equal(idb.read().syncProtocol,2);a.destroy();
});

test('legacy fallback is only for explicit unsupported action, never malformed or forbidden replies',async()=>{
 for(const mode of ['unsupported','malformed','forbidden']){
  const s=server();if(mode==='unsupported')s.unsupported=true;if(mode==='malformed')s.tamper=()=>({status:'idle'});if(mode==='forbidden')s.fail='REQUEST_FORBIDDEN';const {a}=client(s);await a.init();assert.equal(s.calls.some(x=>x.action==='snapshot'),mode==='unsupported');assert.equal(a.view().verified,mode==='unsupported');a.destroy();
 }
});

test('identity reset changes proof domain only with explicit reason and preserves old pending edits as conflicts',async()=>{
 const s=server(),{a,idb}=client(s);await a.init();s.fail=(action)=>action==='command'?'WRITER_BUSY':null;await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'08:30'}});await a.sync({automatic:true});const pending=copy(idb.read().outbox[0].command);
 s.fail=null;s.generation='replacement';s.entities.clear();s.events=[];s.seq=0;s.revision=0;s.change('wake:'+date(1),'09:00');await a.sync();
 assert.equal(idb.read().generation,'replacement');assert.equal(idb.read().syncCheckpoint.generation,'replacement');assert.deepEqual(idb.read().outbox[0].command,pending);assert.equal(idb.read().outbox[0].status,'conflict');assert.equal(a.view().conflicts.length,1);assert.equal(saved(a),false);assert.equal(a.state().wake[date(0)],'08:30');assert.equal(a.state().wake[date(1)],'09:00');assert.equal(idb.read().minimumAcknowledged,null);a.destroy();
});

test('retention resets keep the same-identity confirmed minimum proof on bootstrap',async()=>{
 const s=server(),{a,idb}=client(s);await a.init();await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'08:00'}});await a.sync();s.change('wake:'+date(1),'09:00');s.floor=2;s.calls=[];await a.sync();
 const pulls=s.calls.filter(c=>c.action==='pull');assert.equal(pulls[0].payload.since.seq,1);assert.equal(pulls[1].payload.since,null);assert.deepEqual(pulls[1].payload.minimumAcknowledged,{store:'store',generation:'generation',revision:1,hash:digest(1)});assert.equal(idb.read().syncCheckpoint.seq,2);a.destroy();
});

test('a stale in-flight snapshot cannot overwrite another tab acknowledgement and newer applied cut',async()=>{
 const s=server([entry(0),entry(1),entry(2)]),idb=keyedIndexedDBDouble(),first=client(s,idb),second=client(s,idb);await first.a.init();await second.a.init();
 // Force a staged fresh snapshot and pause its continuation in the network.
 s.change('wake:'+date(3),'10:00');s.floor=1;let entered,release,once=true;const waiting=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 s.hold=async(action,payload)=>{if(action==='pull'&&payload.cursor&&once){once=false;entered();await gate;}};
 const oldPull=first.a.sync();await waiting;
 await second.a.commit(second.a.state(),{...second.a.state(),wake:{...second.a.state().wake,[date(0)]:'05:45'}});await second.a.sync();
 const newest=idb.read();assert.equal(newest.entities['wake:'+date(0)].value,'05:45');assert.equal(newest.minimumAcknowledged.revision,2);release();await oldPull;
 assert.equal(idb.read().entities['wake:'+date(0)].value,'05:45');assert.equal(idb.read().revision,2);assert.equal(idb.read().syncCheckpoint.seq,2);assert.equal(first.a.state().wake[date(0)],'05:45');assert.equal(idb.read().outbox.length,0);first.a.destroy();second.a.destroy();
});

test('unchanged app checkpoints pace idle polling while edits, focus, manual sync and retry stay prompt',async()=>{
 let now=0;const s=server(),{a}=client(s,undefined,{now:()=>now,random:()=>0.5});await a.init();assert.equal(a.view().nextPollAt,60000);s.calls=[];
 now=59999;await a.refreshSession({automatic:true,poll:true});assert.equal(s.calls.length,0);
 now=60000;await a.refreshSession({automatic:true,poll:true});assert.equal(a.view().nextPollAt,180000);
 now=180000;await a.refreshSession({automatic:true,poll:true});assert.equal(a.view().nextPollAt,480000);
 // Unrelated writer maintenance is not an application change.
 s.revision++;now=480000;await a.refreshSession({automatic:true,poll:true});assert.equal(a.view().nextPollAt,780000);
 const at=s.calls.length;now++;await a.refreshSession({automatic:true});assert(s.calls.length>at,'focus/reconnect does not wait for idle polling');
 await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'07:30'}});await a.sync();assert.equal(a.view().pending,0);assert.equal(a.view().nextPollAt,now+60000);
 // Core retry deadlines remain independent from a previously long idle delay.
 now+=60000;await a.refreshSession({automatic:true,poll:true});now+=120000;await a.refreshSession({automatic:true,poll:true});assert.equal(a.view().nextPollAt,now+300000);
 s.fail='STORE_YIELD';await a.sync();const due=a.view().retryAt;assert.equal(due,now+60000);s.fail=null;now=due;const before=s.calls.length;await a.refreshSession({automatic:true,poll:true});assert(s.calls.length>before);assert.equal(a.view().error,null);a.destroy();
});

test('a command response timeout preserves its operation id even after the remote command committed',async()=>{
 const s=server(),idb=keyedIndexedDBDouble(),storage=createIndexedDBStorage(idb);let hold=false,release;
 const fetcher=async(path,options)=>{const response=await s.fetcher(path,options);if(hold&&path==='/api/sync'&&JSON.parse(options.body).action==='command'){hold=false;await new Promise(r=>release=r);}return response;};
 const a=createCloudSync({storage,fetcher,requestTimeoutMs:20});await a.init();hold=true;await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'08:20'}});await a.sync({automatic:true});
 assert.equal(a.view().error,'REQUEST_TIMEOUT');assert.equal(a.view().pending,1);assert.equal(s.seq,1);const id=idb.read().outbox[0].command.operationId;release();await a.sync();assert.equal(a.view().pending,0);assert.equal(s.seq,1);assert(s.commands.every(c=>c.operationId===id));a.destroy();
});

test('a stalled response body also times out without advancing the checkpoint',async()=>{
 const s=server(),idb=keyedIndexedDBDouble();let stall=false;const fetcher=async(path,opts)=>{const response=await s.fetcher(path,opts);if(stall&&path==='/api/sync'&&JSON.parse(opts.body).action==='pull')return {ok:true,status:200,json:()=>new Promise(()=>{})};return response;};
 const a=createCloudSync({storage:createIndexedDBStorage(idb),fetcher,requestTimeoutMs:20});await a.init();s.change('wake:'+date(0),'09:20');stall=true;await a.sync();assert.equal(a.view().error,'REQUEST_TIMEOUT');assert.equal(idb.read().syncCheckpoint.seq,0);assert.equal(idb.read().entities['wake:'+date(0)],undefined);a.destroy();
});

test('proven persisted recovery gets one identical retry; repeated or unproven recovery uses backoff',async()=>{
 for(const advanced of [true,false]){
  const s=server(),idb=keyedIndexedDBDouble();let recovery=false,count=0;const sent=[],waits=[];
  const fetcher=async(path,opts)=>{if(recovery&&path==='/api/sync'&&JSON.parse(opts.body).action==='command'){sent.push(JSON.parse(opts.body).payload);count++;return Response.json({ok:false,error:'WRITER_RECOVERY_PENDING',retryable:true,recovery:{phase:'frames',revision:3,cursorPersisted:true,cursorAdvanced:advanced}},{status:503});}return s.fetcher(path,opts);};
  const a=createCloudSync({storage:createIndexedDBStorage(idb),fetcher,sleep:async ms=>waits.push(ms)});await a.init();recovery=true;await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'08:00'}});await a.sync({automatic:true});
  assert.equal(count,advanced?2:1);assert.equal(waits.filter(ms=>ms===1000).length,advanced?1:0);assert.equal(a.view().pending,1);assert(a.view().retryAt>0);assert(sent.every(c=>JSON.stringify(c)===JSON.stringify(sent[0])));assert.equal(idb.read().outbox[0].command.operationId,sent[0].operationId);a.destroy();
 }
});

test('client cleanup removes only retired snapshot copies and stops on lock',async()=>{
 const s=server([entry(0),entry(1),entry(2)]),{a,idb}=client(s);await a.init();await a.maintenance();assert.equal(idb.rows('staging').length,1);
 for(let i=0;i<3;i++){s.change('wake:'+date(i),'08:00');s.floor=s.seq;await a.sync();await a.maintenance();assert.equal(idb.rows('entities').length,3);assert.equal(idb.rows('staging').length,1);assert.equal(idb.read().entities['wake:'+date(i)].value,'08:00');}
 const before=copy(idb.read());a.lock();await a.maintenance();assert.deepEqual(idb.read(),before);assert.equal(a.view().authenticated,false);a.destroy();
});

test('owner-required activation is never automatic fallback or activation and retains queued edits',async()=>{
 let now=0;const s=server(),{a,idb}=client(s,undefined,{now:()=>now});await a.init();s.fail='SYNC_V2_MIGRATION_REQUIRED';await a.sync();assert.equal(a.view().automaticPaused,true);const before=s.calls.length;
 await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'09:00'}});assert.equal(a.view().pending,1);const queued=copy(idb.read().outbox[0].command);now+=86400000;await a.refreshSession({automatic:true,poll:true});assert.equal(s.calls.length,before);assert.equal(s.calls.some(c=>/activate|enable/i.test(c.action)),false);
 s.fail=null;await a.refreshSession();assert.equal(a.view().pending,0);assert.equal(a.view().automaticPaused,false);assert.deepEqual(s.commands.at(-1),queued);a.destroy();
});

test('invalid remote values are rejected before any baseline or checkpoint mutation',async()=>{
 const s=server([entry(0)]),{a,idb}=client(s);await a.init();s.change('wake:'+date(0),'09:00');s.tamper=page=>({...page,entries:[{...page.entries[0],value:'99:99'}]});await a.sync();assert.equal(a.view().error,'PULL_ENTITY_INVALID');assert.equal(idb.read().entities['wake:'+date(0)].value,'07:00');assert.equal(idb.read().syncCheckpoint.seq,0);a.destroy();
});

test('initial read yield gets the exact requested page through one bounded recovery action',async()=>{
 const s=server([entry(0)]);let recovered=false;s.fail=action=>action==='pull'&&!recovered?'STORE_YIELD':null;s.hold=async action=>{if(action==='recover')recovered=true;};
 const {a,idb}=client(s);await a.init();assert.deepEqual(s.calls.map(c=>c.action),['pull','recover']);assert.deepEqual(s.calls[0].payload,s.calls[1].payload.pull);assert.equal(a.view().error,null);assert.equal(idb.read().outbox.length,0);assert.equal(a.state().wake[date(0)],'07:00');a.destroy();
});

test('recovery is at most once per sync and never retries an already acknowledged command',async()=>{
 const s=server(),{a,idb}=client(s);await a.init();s.fail=action=>['pull','recover'].includes(action)?'STORE_YIELD':null;s.calls=[];await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'08:00'}});await a.sync({automatic:true});
 assert.deepEqual(s.calls.map(c=>c.action),['command','pull','recover']);assert.equal(s.commands.length,1);assert.equal(idb.read().outbox.length,0);assert.equal(a.view().error,'STORE_YIELD');assert(a.view().retryAt>0);assert.match(cloudStatus(a.view(),'cloud'),/保存済み.*最新の記録は確認待ち/);a.destroy();
});

test('frozen continuation budget/yield failures do not trigger unrelated head recovery',async()=>{
 for(const error of ['STORE_YIELD','SYNC_BUDGET_YIELD']){
  const s=server([entry(0),entry(1),entry(2)]);s.fail=(action,payload)=>action==='pull'&&payload.cursor?error:null;const {a,idb}=client(s);await a.init();assert.equal(s.calls.some(c=>c.action==='recover'),false);assert.equal(idb.read().snapshotStage.nextPage,1);assert.equal(a.view().ready,false);assert.equal(a.view().error,error);a.destroy();
 }
});

test('snapshot pages accept 128 records while delta pages stay capped at 24',async()=>{
 const s=server(Array.from({length:129},(_,i)=>entry(i)));s.size=128;const {a,idb}=client(s);await a.init();assert.equal(Object.keys(a.state().wake).length,129);assert.equal(s.calls.filter(c=>c.action==='pull').length,2);
 s.size=25;for(let i=0;i<25;i++)s.change('wake:'+date(i),'09:00');await a.sync();assert.equal(a.view().error,'PULL_INVALID');assert.equal(idb.read().syncCheckpoint.seq,0);s.size=24;await a.sync();assert.equal(idb.read().syncCheckpoint.seq,25);assert.equal(a.state().wake[date(24)],'09:00');a.destroy();
});

test('an empty advancing snapshot page is durably staged and continued rather than treated as completion',async()=>{
 const s=server([entry(0),entry(1),entry(2)]);s.tamper=(page,payload)=>payload.cursor?{...page,entries:[entry(0),entry(1),entry(2)]}:{...page,entries:[]};s.fail=(action,payload)=>action==='pull'&&payload.cursor?'STORE_YIELD':null;const idb=keyedIndexedDBDouble(),{a}=client(s,idb);await a.init();assert.equal(a.view().ready,false);assert.equal(idb.read().snapshotStage.nextPage,1);assert.equal(Object.keys(idb.read().entities).length,0);const cursor=idb.read().snapshotStage.meta.cursor;a.destroy();
 s.fail=null;s.calls=[];const {a:b}=client(s,idb);await b.init();assert.equal(s.calls[0].payload.cursor,cursor);assert.equal(Object.keys(b.state().wake).length,3);assert.equal(idb.read().snapshotStage,null);b.destroy();
});

test('an aggregate projection failure never turns a later idle response into a verified display',async()=>{
 const habits=Array.from({length:101},(_,i)=>({key:'habit:h'+i,version:1,deleted:false,value:{id:'h'+i,name:'Habit '+i,type:'check',unit:'',target:1,archived:false}})),s=server(habits);s.size=128;const {a,idb}=client(s);
 await assert.rejects(a.init(),/CLOUD_STATE_UNDISPLAYABLE/);assert.equal(Object.keys(idb.read().entities).length,101,'raw remote records are retained, never dropped to fit UI limits');assert.equal(a.view().verified,false);
 await a.sync();assert.equal(a.view().verified,false);assert(a.view().error);assert.equal(Object.keys(idb.read().entities).length,101);assert.throws(()=>a.state(),/CLOUD_STATE_UNDISPLAYABLE/);a.destroy();
});

test('a failed state-delivery callback is retried instead of being marked as already published',async()=>{
 const s=server([entry(0)]);let rejectDelivery=true,deliveries=0;const {a}=client(s,undefined,{onRemoteState(){deliveries++;if(rejectDelivery)throw Error('DISPLAY_NOT_READY');}});
 await a.init();assert.equal(a.view().verified,false);const attempted=deliveries;assert(attempted>0);await a.sync();assert.equal(a.view().verified,false);assert(deliveries>attempted);rejectDelivery=false;await a.sync();assert.equal(a.view().verified,true);assert.equal(a.view().error,null);a.destroy();
});

test('strictly advancing durable preparation gets a bounded same-command burst and only the final receipt saves',async()=>{
 const s=server(),idb=keyedIndexedDBDouble(),sent=[],waits=[],views=[];let preparing=false,ordinal=0,a;
 const fetcher=async(path,opts)=>{
  if(preparing&&path==='/api/sync'&&JSON.parse(opts.body).action==='command'){
   const payload=JSON.parse(opts.body).payload;sent.push(copy(payload));assert.equal(idb.read().outbox[0].command.operationId,payload.operationId);assert.equal(saved(a),false);assert.equal(a.view().pending,1);
   if(++ordinal<=3)return Response.json({ok:false,error:'WRITER_RECOVERY_PENDING',retryable:true,recovery:{phase:'preparation',ordinal,cursorPersisted:true,cursorAdvanced:true}},{status:503});
  }
  return s.fetcher(path,opts);
 };
 a=createCloudSync({storage:createIndexedDBStorage(idb),fetcher,sleep:async ms=>waits.push(ms),onChange:view=>views.push(copy(view))});await a.init();preparing=true;await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'08:30'}});await a.sync({automatic:true});
 assert.equal(sent.length,4);assert(sent.every(c=>canonicalCommand(c)===canonicalCommand(sent[0])));assert.equal(waits.filter(ms=>ms===1000).length,3);assert.equal(s.seq,1);assert.equal(s.commands.length,1);assert.equal(a.view().pending,0);assert.equal(saved(a),true);assert(views.some(v=>v.phase==='preparation'&&v.pending===1&&!v.verified));assert.match(cloudStatus(views.find(v=>v.phase==='preparation'),'cloud'),/端末に保存済み.*準備中.*未送信/);a.destroy();
});
function canonicalCommand(value){return JSON.stringify(value);}

test('preparation stalls back off while advancing burst exhaustion schedules continuation',async()=>{
 for(const ordinals of [[5,5],[5,4],Array.from({length:12},(_,i)=>i+1)]){
  const s=server(),idb=keyedIndexedDBDouble(),sent=[],waits=[];let preparing=false,index=0;
  const fetcher=async(path,opts)=>{if(preparing&&path==='/api/sync'&&JSON.parse(opts.body).action==='command'){sent.push(copy(JSON.parse(opts.body).payload));return Response.json({ok:false,error:'WRITER_RECOVERY_PENDING',retryable:true,recovery:{phase:'preparation',ordinal:ordinals[index++],cursorPersisted:true,cursorAdvanced:true}},{status:503});}return s.fetcher(path,opts);};
  const a=createCloudSync({storage:createIndexedDBStorage(idb),fetcher,sleep:async ms=>waits.push(ms)});await a.init();preparing=true;await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'08:45'}});await a.sync({automatic:true});
  assert.equal(sent.length,ordinals.length===12?8:2);assert.equal(waits.filter(ms=>ms===1000).length,sent.length-1);assert.equal(a.view().pending,1);assert.equal(a.view().conflicts.length,0);assert.equal(a.view().error,ordinals.length===12?null:'WRITER_RECOVERY_PENDING');assert(a.view().retryAt>0);assert.equal(saved(a),false);assert.equal(s.seq,0);assert(sent.every(c=>canonicalCommand(c)===canonicalCommand(sent[0])));assert.deepEqual(idb.read().outbox[0].command,sent[0]);a.destroy();
 }
});

test('unproven or malformed preparation progress never earns a short continuation',async()=>{
 for(const patch of [{ordinal:0},{ordinal:-1},{ordinal:1.5},{ordinal:'1'},{ordinal:Number.MAX_SAFE_INTEGER+1},{ordinal:null},{cursorPersisted:false},{cursorAdvanced:false},{phase:'caller-pointer',ordinal:1}]){
  const s=server(),idb=keyedIndexedDBDouble();let preparing=false,count=0;
  const fetcher=async(path,opts)=>{if(preparing&&path==='/api/sync'&&JSON.parse(opts.body).action==='command'){count++;return Response.json({ok:false,error:'WRITER_RECOVERY_PENDING',retryable:true,recovery:{phase:'preparation',ordinal:1,cursorPersisted:true,cursorAdvanced:true,...patch}},{status:503});}return s.fetcher(path,opts);};
  const a=createCloudSync({storage:createIndexedDBStorage(idb),fetcher,sleep:async()=>{}});await a.init();preparing=true;await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'09:00'}});await a.sync({automatic:true});assert.equal(count,1,JSON.stringify(patch));assert.equal(a.view().pending,1);assert.equal(saved(a),false);a.destroy();
 }
});

test('preparation cannot continue when the server requires owner action or denies retry',async()=>{
 for(const patch of [{requiresOwnerAction:true},{retryable:false}]){
  const s=server(),idb=keyedIndexedDBDouble();let preparing=false,count=0;
  const fetcher=async(path,opts)=>{if(preparing&&path==='/api/sync'&&JSON.parse(opts.body).action==='command'){count++;return Response.json({ok:false,error:'WRITER_RECOVERY_PENDING',retryable:true,...patch,recovery:{phase:'preparation',ordinal:1,cursorPersisted:true,cursorAdvanced:true}},{status:503});}return s.fetcher(path,opts);};
  const a=createCloudSync({storage:createIndexedDBStorage(idb),fetcher,sleep:async()=>{}});await a.init();preparing=true;await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'09:00'}});await a.sync({automatic:true});assert.equal(count,1);assert.equal(a.view().pending,1);assert.equal(a.view().automaticPaused,patch.requiresOwnerAction===true);a.destroy();
 }
});

test('reload resumes an incomplete preparation with the original exact command',async()=>{
 const s=server(),idb=keyedIndexedDBDouble();let preparing=false;const sent=[];
 const fetcher=async(path,opts)=>{if(preparing&&path==='/api/sync'&&JSON.parse(opts.body).action==='command'){sent.push(copy(JSON.parse(opts.body).payload));return Response.json({ok:false,error:'WRITER_RECOVERY_PENDING',retryable:true,recovery:{phase:'preparation',ordinal:4,cursorPersisted:true,cursorAdvanced:true}},{status:503});}return s.fetcher(path,opts);};
 const a=createCloudSync({storage:createIndexedDBStorage(idb),fetcher,sleep:async()=>{}});await a.init();preparing=true;await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'09:30'}});await a.sync({automatic:true});const original=copy(idb.read().outbox[0].command);a.destroy();preparing=false;
 const b=createCloudSync({storage:createIndexedDBStorage(idb),fetcher,sleep:async()=>{}});await b.init();assert.deepEqual(s.commands[0],original);assert.equal(s.seq,1);assert.equal(b.view().pending,0);assert.equal(saved(b),true);b.destroy();
});

test('logout during a preparation continuation stops the burst without changing its durable outbox',async()=>{
 const s=server(),idb=keyedIndexedDBDouble();let preparing=false,count=0,a;
 const fetcher=async(path,opts)=>{if(preparing&&path==='/api/sync'&&JSON.parse(opts.body).action==='command'){count++;return Response.json({ok:false,error:'WRITER_RECOVERY_PENDING',retryable:true,recovery:{phase:'preparation',ordinal:count,cursorPersisted:true,cursorAdvanced:true}},{status:503});}return s.fetcher(path,opts);};
 a=createCloudSync({storage:createIndexedDBStorage(idb),fetcher,sleep:async ms=>{if(ms===1000)a.lock();}});await a.init();preparing=true;await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'09:45'}});await a.sync({automatic:true});assert.equal(count,1);assert.equal(idb.read().outbox.length,1);assert.equal(a.view().authenticated,false);assert.equal(saved(a),false);assert.equal(s.seq,0);a.destroy();
});

test('a preparation-shaped success without a valid receipt cannot retire the pending command',async()=>{
 const s=server(),idb=keyedIndexedDBDouble();let preparing=false;
 const fetcher=async(path,opts)=>{if(preparing&&path==='/api/sync'&&JSON.parse(opts.body).action==='command')return Response.json({ok:true,result:{phase:'preparation',ordinal:3,cursorPersisted:true,cursorAdvanced:true}});return s.fetcher(path,opts);};
 const a=createCloudSync({storage:createIndexedDBStorage(idb),fetcher});await a.init();preparing=true;await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'10:00'}});await a.sync({automatic:true});assert.equal(a.view().pending,1);assert.equal(a.view().error,'RECEIPT_INVALID');assert.equal(saved(a),false);assert.equal(s.seq,0);a.destroy();
});

test('a receipt with the wrong deletion flag or mixed preparation rejection never acknowledges a write',async()=>{
 for(const patch of [{deleted:true},{deleted:null},{preparationError:'ENTITY_VERSION_CONFLICT'}]){
  const s=server(),idb=keyedIndexedDBDouble();let tamper=false;
  const fetcher=async(path,opts)=>{const response=await s.fetcher(path,opts);if(tamper&&path==='/api/sync'&&JSON.parse(opts.body).action==='command'){const json=await response.json();return Response.json({...json,result:{...json.result,result:{...json.result.result,...patch}}});}return response;};
  const a=createCloudSync({storage:createIndexedDBStorage(idb),fetcher});await a.init();tamper=true;await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'10:15'}});await a.sync({automatic:true});const original=copy(idb.read().outbox[0].command);assert.equal(a.view().pending,1);assert.equal(a.view().error,'RECEIPT_INVALID');assert.equal(saved(a),false);assert.equal(s.seq,1);
  tamper=false;await a.sync();assert.equal(a.view().pending,0);assert.equal(s.seq,1);assert(s.commands.every(c=>c.operationId===original.operationId));a.destroy();
 }
});

function pacingReply(phase,amount,patch={}){return {phase,[phase==='preparation'?'ordinal':phase==='index'?'indexLinks':'revision']:amount,cursorPersisted:true,cursorAdvanced:true,...patch};}
async function pacingFixture(next,{requestMs=0,status=503}={}){
 const s=server(),idb=keyedIndexedDBDouble(),sent=[],waits=[];let preparing=false,clock=0;
 const fetcher=async(path,options)=>{
  if(preparing&&path==='/api/sync'&&JSON.parse(options.body).action==='command'){
   sent.push(copy(JSON.parse(options.body).payload));clock+=requestMs;
   return Response.json({ok:false,error:'WRITER_RECOVERY_PENDING',retryable:true,recovery:next(sent.length)},{status});
  }return s.fetcher(path,options);
 };
 const a=createCloudSync({storage:createIndexedDBStorage(idb),fetcher,now:()=>clock,sleep:async ms=>{waits.push(ms);clock+=ms;}});await a.init();
 const start=async()=>{preparing=true;await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'10:30'}});await a.sync({automatic:true});};
 const due=async()=>{clock=a.view().retryAt;await a.refreshSession({automatic:true});};
 return {a,idb,s,sent,waits,start,due,get now(){return clock;}};
}
for(const phase of ['frames','index','checkpoint','preparation'])test(`strictly advancing ${phase} progress stays bounded and schedules short non-error continuation`,async()=>{
 const f=await pacingFixture(n=>pacingReply(phase,n));await f.start();
 for(let window=1;window<=4;window++){
  assert.equal(f.sent.length,window*8);assert.equal(f.a.view().retryAt-f.now,2000);assert.equal(f.a.view().error,null);assert.equal(f.a.view().continuation.phase,phase);assert.equal(f.a.view().pending,1);assert.equal(f.a.view().conflicts.length,0);assert.equal(saved(f.a),false);assert.equal(f.s.seq,0);
  assert(f.sent.every(c=>canonicalCommand(c)===canonicalCommand(f.sent[0])));assert.deepEqual(f.idb.read().outbox[0].command,f.sent[0]);if(window<4)await f.due();
 }f.a.destroy();
});
for(const regression of [false,true])test(`${regression?'regressed':'repeated'} progress across retry windows cannot reset exponential failure delay`,async()=>{
 let steady=false;const f=await pacingFixture(n=>pacingReply('preparation',steady?(regression?7:8):n));await f.start();steady=true;
 for(const delay of [60000,120000,240000,480000,900000]){const before=f.sent.length;await f.due();assert.equal(f.sent.length,before+1);assert.equal(f.a.view().retryAt-f.now,delay);assert.equal(f.a.view().pending,1);}
 f.a.destroy();
});
test('phase switching and an equal or older root revision cannot manufacture progress or reset a descriptor',async()=>{
 const replies=[pacingReply('preparation',5),pacingReply('checkpoint',100),pacingReply('preparation',1),pacingReply('frames',100),pacingReply('preparation',1),pacingReply('checkpoint',100),pacingReply('frames',99),pacingReply('preparation',1)];
 const f=await pacingFixture(n=>replies[n-1]??pacingReply('preparation',1));await f.start();assert.equal(f.sent.length,4);assert.equal(f.a.view().retryAt-f.now,60000);
 for(const delay of [120000,240000,480000,900000]){const before=f.sent.length;await f.due();assert.equal(f.sent.length,before+1);assert.equal(f.a.view().retryAt-f.now,delay);}f.a.destroy();
});
test('a strictly newer verified checkpoint permits the next descriptor ordinal space once',async()=>{
 const replies=[pacingReply('preparation',8),pacingReply('checkpoint',100),pacingReply('preparation',1),pacingReply('preparation',2),pacingReply('checkpoint',101),pacingReply('preparation',1),pacingReply('preparation',2),pacingReply('preparation',3)];
 const f=await pacingFixture(n=>replies[n-1]??pacingReply('preparation',3));await f.start();assert.equal(f.sent.length,8);assert.equal(f.a.view().retryAt-f.now,2000);await f.due();assert.equal(f.sent.length,9);assert.equal(f.a.view().retryAt-f.now,60000);assert.equal(f.a.view().pending,1);f.a.destroy();
});
for(const status of [403,429])test(`HTTP ${status} cannot borrow fast recovery or reset backoff from typed progress`,async()=>{
 const f=await pacingFixture(n=>pacingReply('preparation',n),{status});await f.start();assert.equal(f.sent.length,1);assert.equal(f.a.view().retryAt-f.now,60000);
 for(const delay of [120000,240000,480000]){const before=f.sent.length;await f.due();assert.equal(f.sent.length,before+1);assert.equal(f.a.view().retryAt-f.now,delay);}f.a.destroy();
});
for(const [requestMs,calls]of [[1000,8],[10000,5],[33000,1]])test(`progress burst yields before another ${requestMs}ms request would exceed the one-minute active estimate`,async()=>{
 const f=await pacingFixture(n=>pacingReply('preparation',n),{requestMs});await f.start();assert.equal(f.sent.length,calls);assert(f.now<=60000);assert.equal(f.a.view().retryAt-f.now,2000);assert.equal(f.a.view().pending,1);assert.equal(saved(f.a),false);f.a.destroy();
});


test('sustained persisted progress is limited to 64 requests per ten-minute window',async()=>{
 const f=await pacingFixture(n=>pacingReply('preparation',n));await f.start();
 for(let burst=1;burst<8;burst++)await f.due();
 assert.equal(f.sent.length,64);assert.equal(f.a.view().retryAt,600000);assert.equal(f.a.view().error,null);
 const before=f.sent.length;await f.a.refreshSession({automatic:true});assert.equal(f.sent.length,before);
 await f.due();assert.equal(f.sent.length,72);assert.equal(f.a.view().retryAt-f.now,2000);f.a.destroy();
});

test('scheduled continuation wakes without a minute poll and lock cancels it',async()=>{
 const s=server(),idb=keyedIndexedDBDouble(),timers=new Map();let clock=0,preparing=false,count=0,serial=0;
 const fetcher=async(path,opts)=>{if(preparing&&path==='/api/sync'&&JSON.parse(opts.body).action==='command'){count++;return Response.json({ok:false,error:'WRITER_RECOVERY_PENDING',retryable:true,recovery:pacingReply('preparation',count)},{status:503});}return s.fetcher(path,opts);};
 const a=createCloudSync({storage:createIndexedDBStorage(idb),fetcher,now:()=>clock,sleep:async ms=>{clock+=ms;},schedule:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;},cancelSchedule:id=>timers.delete(id)});
 await a.init();preparing=true;await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'10:45'}});await a.sync({automatic:true});
 assert.equal(count,8);assert.equal(timers.size,1);const first=[...timers.values()][0];assert.equal(first.ms,2000);
 timers.clear();clock+=first.ms;first.fn();await a.sync({automatic:true});assert.equal(count,16);assert.equal(timers.size,1);
 const stale=[...timers.values()][0];a.lock();assert.equal(timers.size,0);stale.fn();await a.sync({automatic:true});assert.equal(count,16);assert.equal(idb.read().outbox.length,1);a.destroy();
});

test('edits made while a progress burst yields do not bypass its scheduled cooldown',async()=>{
 const s=server(),idb=keyedIndexedDBDouble(),timers=new Map();let clock=0,preparing=false,count=0,a;
 const fetcher=async(path,opts)=>{
  if(preparing&&path==='/api/sync'&&JSON.parse(opts.body).action==='command'){
   count++;
   if(count===8)await a.commit(a.state(),{...a.state(),wake:{...a.state().wake,[date(1)]:'11:15'}});
   return Response.json({ok:false,error:'WRITER_RECOVERY_PENDING',retryable:true,recovery:pacingReply('preparation',count)},{status:503});
  }return s.fetcher(path,opts);
 };
 a=createCloudSync({storage:createIndexedDBStorage(idb),fetcher,now:()=>clock,sleep:async ms=>{clock+=ms;},schedule:(fn,ms)=>{timers.set(fn,ms);return fn;},cancelSchedule:fn=>timers.delete(fn)});
 await a.init();preparing=true;await a.commit(a.state(),{...a.state(),wake:{[date(0)]:'11:00'}});await a.sync({automatic:true});
 assert.equal(count,8);assert.equal(timers.size,1);assert.equal(a.view().retryAt-clock,2000);assert.equal(a.view().pending,2);assert.equal(a.state().wake[date(1)],'11:15');a.destroy();
});

test('manual retry cannot bypass the sustained-progress request cap',async()=>{
 const f=await pacingFixture(n=>pacingReply('preparation',n));await f.start();for(let burst=1;burst<8;burst++)await f.due();
 const before=f.sent.length,due=f.a.view().retryAt;await f.a.sync();assert.equal(f.sent.length,before);assert.equal(f.a.view().retryAt,due);assert.equal(f.a.view().error,null);f.a.destroy();
});


for(const code of ['STORE_READ_UNRESOLVED','STORE_METADATA_UNRESOLVED'])test(`retryable ${code} on initial pull gets one wider exact-payload recovery`,async()=>{
 const s=server([entry(0)]);let recovered=false;s.fail=action=>action==='pull'&&!recovered?code:null;s.hold=async action=>{if(action==='recover')recovered=true;};
 const {a}=client(s);await a.init();assert.deepEqual(s.calls.map(c=>c.action),['pull','recover']);assert.deepEqual(s.calls[0].payload,s.calls[1].payload.pull);assert.equal(a.view().verified,true);a.destroy();
});
for(const patch of [{retryable:false},{requiresOwnerAction:true},{status:429},{status:403}])test(`unresolved reads do not widen on refusal ${JSON.stringify(patch)}`,async()=>{
 const s=server();let pulls=0,recovers=0;const fetcher=async(path,opts)=>{if(path==='/api/sync'){const {action}=JSON.parse(opts.body);if(action==='pull'){pulls++;return Response.json({ok:false,error:'STORE_READ_UNRESOLVED',retryable:true,...patch},{status:patch.status??503});}if(action==='recover')recovers++;}return s.fetcher(path,opts);};
 const a=createCloudSync({storage:createIndexedDBStorage(keyedIndexedDBDouble()),fetcher});await a.init();assert.equal(pulls,1);assert.equal(recovers,0);assert.equal(a.view().verified,false);a.destroy();
});
