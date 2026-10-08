import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {createCloudSync,createIndexedDBStorage} from '../../src/lib/cloud-sync.js';
import {createAppSyncV2} from '../../gas/app-sync-v2.mjs';
import {APP_CHANGE_HEAD,APP_CHANGE_CAPACITY} from '../../gas/app-domain.mjs';
import {createCursorCodec} from '../../gas/signed-dispatcher.mjs';
import {fixture} from './fixture.mjs';
import {keyedIndexedDBDouble} from '../helpers/indexeddb-keyed-double.js';
const day=i=>new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10);
function harness(){
 const f=fixture(),codec=createCursorCodec({secret:'x'.repeat(32),hmac:(s,k)=>createHmac('sha256',k).update(s).digest('base64url'),encode:s=>Buffer.from(s).toString('base64url'),decode:s=>Buffer.from(s,'base64url').toString()});
 f.writer.enableFormatFence({operationId:randomUUID(),epoch:'default',datasetGeneration:'1',digest:createHash('sha256').update('explicit test-only v2 activation').digest('hex'),changes:[{key:APP_CHANGE_HEAD,expectedVersion:0,value:{protocol:2,seq:0,floor:1,capacity:APP_CHANGE_CAPACITY}}],result:{incrementalSyncEnabled:true}});
 const pull=createAppSyncV2({writer:f.writer,locked:fn=>fn(),...codec});
 const n={calls:[],commands:[],loseAck:false,block:null};n.fetcher=async(path,opts)=>{
  if(path==='/api/auth/session')return Response.json({ok:true,authenticated:true,csrf:'test'});
  const {action,payload}=JSON.parse(opts.body);n.calls.push({action,payload:structuredClone(payload)});
  if(n.block?.(action,payload))return Response.json({ok:false,error:'STORE_YIELD',retryable:true},{status:503});
  try{let result;
   if(action==='command'){n.commands.push(structuredClone(payload));result=f.api.command(payload);if(n.loseAck){n.loseAck=false;throw Error('LOST_ACK');}}
   else if(action==='pull')result=pull.pull(payload);
   else if(action==='snapshot')result=f.api.snapshot(payload);
   else if(action==='imports')result={revision:f.writer.status().revision,runs:[],nextCursor:null};else result={status:'idle'};
   return Response.json({ok:true,result});
  }catch(e){if(e.message==='LOST_ACK')throw e;return Response.json({ok:false,error:e.code||e.message,retryable:!!e.retryable,...(e.resetReason?{resetReason:e.resetReason}:{})},{status:e.retryable?503:/CONFLICT|MISMATCH|RESET|EXPIRED/.test(e.message)?409:400});}
 };
 const make=(idb=keyedIndexedDBDouble())=>({idb,a:createCloudSync({storage:createIndexedDBStorage(idb),fetcher:n.fetcher,random:()=>0.5})});
 const write=(i,value,version=0)=>f.api.command({operationId:randomUUID(),epoch:'default',generation:'1',store:'store',key:'wake:'+day(i),expectedVersion:version,deleted:false,value,recreate:false});
 return {...f,n,make,write};
}

test('actual v2 writer/domain and keyed client complete stable bootstrap, delta, and unchanged pull',async()=>{
 const f=harness();for(let i=0;i<30;i++)f.write(i,'07:00');const {a,idb}=f.make();await a.init();assert.equal(a.view().error,null);assert.equal(Object.keys(a.state().wake).length,30);assert.equal(idb.read().syncCheckpoint.seq,30);assert(f.n.calls.filter(x=>x.action==='pull').length>=1);
 f.write(4,'06:30',1);f.n.calls=[];await a.sync();assert.equal(a.state().wake[day(4)],'06:30');assert.equal(idb.read().syncCheckpoint.seq,31);assert.equal(f.n.calls.filter(x=>x.action==='pull').length,1);
 idb.resetMetrics();await a.sync();assert.equal(idb.metrics.entities?.getAll??0,0);assert.equal(idb.metrics.entities?.rowsRead??0,0);assert.equal(a.view().verified,true);a.destroy();
});

test('actual receipt loss retries the original command and app sequence only advances once',async()=>{
 const f=harness(),{a,idb}=f.make();await a.init();f.n.loseAck=true;await a.commit(a.state(),{...a.state(),wake:{[day(0)]:'08:10'}});await a.sync({automatic:true});const q=idb.read().outbox[0];assert.equal(a.view().pending,1);a.destroy();
 const {a:b}=f.make(idb);await b.init();assert.equal(b.view().pending,0);assert.equal(b.state().wake[day(0)],'08:10');assert.deepEqual(f.n.commands[0],q.command);assert.deepEqual(f.n.commands[1],q.command);assert.equal(idb.read().syncCheckpoint.seq,1);assert.equal(f.api.snapshot({cursor:null,revision:null}).entities[0].version,1);b.destroy();
});

test('two isolated client profiles retain a real conflict then converge on explicit resolution',async()=>{
 const f=harness(),left=f.make(),right=f.make();await left.a.init();await right.a.init();await left.a.commit(left.a.state(),{...left.a.state(),wake:{[day(0)]:'07:00'}});await left.a.sync();await right.a.commit(right.a.state(),{...right.a.state(),wake:{[day(0)]:'09:00'}});await right.a.sync();
 assert.equal(right.a.view().conflicts.length,1);assert.equal(right.a.state().wake[day(0)],'09:00');assert.equal(right.a.view().pending,1);const pending=right.idb.read().outbox[0].command;
 await right.a.resolveConflict('wake:'+day(0),'local',right.a.view().conflicts[0]);await right.a.sync();assert.equal(right.a.view().pending,0);assert.notEqual(f.n.commands.at(-1).operationId,pending.operationId);await left.a.sync();assert.equal(left.a.state().wake[day(0)],'09:00');assert.equal(left.idb.read().syncCheckpoint.seq,right.idb.read().syncCheckpoint.seq);left.a.destroy();right.a.destroy();
});

test('actual opaque snapshot continuation survives a client restart without full page replay',async()=>{
 const f=harness();for(let i=0;i<130;i++)f.write(i,'07:00');f.n.block=(action,payload)=>action==='pull'&&payload.cursor;const {a,idb}=f.make();await a.init();assert.equal(a.view().ready,false);const cursor=idb.read().snapshotStage.meta.cursor;assert.equal(typeof cursor,'string');assert.equal(idb.read().snapshotStage.nextPage,1);a.destroy();
 f.n.block=null;f.n.calls=[];const {a:b}=f.make(idb);await b.init();assert.equal(f.n.calls[0].payload.cursor,cursor);assert.equal(b.view().error,null);assert.equal(Object.keys(b.state().wake).length,130);b.destroy();
});

test('actual tombstone and recreate deltas preserve monotonically increasing versions',async()=>{
 const f=harness(),{a,idb}=f.make();await a.init();await a.commit(a.state(),{...a.state(),wake:{[day(0)]:'07:00'}});await a.sync();await a.commit(a.state(),{...a.state(),wake:{}});await a.sync();assert.equal(idb.read().entities['wake:'+day(0)].deleted,true);assert.equal(idb.read().entities['wake:'+day(0)].version,2);
 await a.commit(a.state(),{...a.state(),wake:{[day(0)]:'08:00'}});await a.sync();assert.equal(f.n.commands.at(-1).recreate,true);assert.equal(idb.read().entities['wake:'+day(0)].version,3);assert.equal(idb.read().syncCheckpoint.seq,3);a.destroy();
});
