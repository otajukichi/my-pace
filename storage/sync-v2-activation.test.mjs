import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {ReservedSlotWriter,writerDigest} from './reserved-writer.mjs';
import {activateSyncV2} from './sync-v2-activation.mjs';
import {SYNC_APP_CHANGE_HEAD,SYNC_APP_CHANGE_CAPACITY,initialSyncAppChangeHead,validateSyncAppChangeHead} from './app-sync-protocol.mjs';
import {createAppDomain} from '../gas/app-domain.mjs';
import {decodeUtf8} from './codec.mjs';
const digest=s=>createHash('sha256').update(s).digest('hex');
function fixture({bootstrap=true,generation='1',storeId='store',schemaVersion=3}={}){
 const files=new Map(),calls=[],faults={};let i=0,held=true;
 const io={getScriptId:()=> 'script',assertLockHeld:()=>held,allocateIds:n=>{calls.push(['allocate',n]);return Array.from({length:n},()=> 'id_'+(++i));},readFile:(id,max)=>{calls.push(['read',id]);const read=()=>{const b=files.get(id);if(b&&b.length>max)throw Error('TOO_LARGE');return b?Uint8Array.from(b):null;};return faults.read?faults.read(id,max,read):read();},createFile:(id,bytes,role)=>{calls.push(['create',id,role]);const create=()=>{if(files.has(id))throw Error('409');files.set(id,Uint8Array.from(bytes));return {id};};return faults.create?faults.create(id,bytes,role,create):create();}};
 const cfg={io,anchorId:'anchor',storeId,writerScriptId:'script',schemaVersion,clock:()=> '2026-10-07T17:00:00.000Z'},writer=new ReservedSlotWriter(cfg);if(bootstrap)writer.bootstrap({datasetGeneration:generation});held=false;
 const runtime=w=>({writer:w,locked(fn){const was=held;held=true;try{return fn();}finally{held=was;}}});
 const r=runtime(writer),domain=w=>createAppDomain({writer:w,locked:runtime(w).locked,digest});
 return {files,calls,faults,writer,runtime:r,fresh:()=>runtime(new ReservedSlotWriter(cfg)),domain:domain(writer),domainFor:domain,locked:r.locked,status:()=>r.locked(()=>writer.status()),get:key=>r.locked(()=>writer.getEntity(key)),receipt:(id,epoch='default')=>r.locked(()=>writer.getReceipt(id,epoch))};
}
const command=(key,value,version=0)=>({operationId:randomUUID(),epoch:'default',generation:'1',store:'store',key,expectedVersion:version,deleted:false,value,recreate:false});
const originalFiles=f=>new Map([...f.files].map(([id,b])=>[id,Uint8Array.from(b)]));
function preserved(f,before){for(const [id,b]of before)assert.deepEqual(f.files.get(id),b,'historical bytes changed for '+id);}
const countFrames=f=>[...f.files.values()].map(b=>JSON.parse(decodeUtf8(b))).filter(x=>x.kind==='frame').length;

test('explicit activation atomically creates seq0 head and fence while retaining all legacy bytes/receipts',()=>{
 const f=fixture(),a=command('wake:2026-10-07','07:00'),b=command('diary:2026-10-07',{text:'消さない記録',mood:null}),ar=f.domain.command(a),br=f.domain.command(b),before=originalFiles(f),entities=[f.get('app/data/'+a.key),f.get('app/data/'+b.key)],status=f.status();
 const result=activateSyncV2(f.runtime);assert.equal(result.enabled,true);assert.equal(result.alreadyEnabled,false);assert.equal(result.storage.writerFence,2);assert.equal(result.storage.datasetGeneration,status.datasetGeneration);assert.equal(result.storage.storeId,status.storeId);assert.equal(result.storage.revision,status.revision+1);
 assert.deepEqual(f.get(SYNC_APP_CHANGE_HEAD).value,initialSyncAppChangeHead());assert.equal(result.receipt.entityVersions.length,1);assert.equal(result.receipt.entityVersions[0].key,SYNC_APP_CHANGE_HEAD);preserved(f,before);
 assert.deepEqual([f.get('app/data/'+a.key),f.get('app/data/'+b.key)],entities);assert.deepEqual(f.domain.command(a),ar);assert.deepEqual(f.domain.command(b),br);assert.equal(f.get(SYNC_APP_CHANGE_HEAD).value.seq,0);
 const frame=JSON.parse(decodeUtf8(f.files.get(result.receipt.frameId)));assert.equal(frame.payload.writerFence,2);assert.equal(frame.payload.changes.length,1);assert.equal(frame.payload.changes[0].key,SYNC_APP_CHANGE_HEAD);
});
test('already enabled activation is idempotent after real app changes and preserves original activation receipt',()=>{
 const f=fixture(),first=activateSyncV2(f.runtime);f.domain.command(command('wake:2026-10-07','07:00'));const before=originalFiles(f),revision=f.status().revision,head=f.get(SYNC_APP_CHANGE_HEAD);
 const again=activateSyncV2(f.fresh());assert.equal(again.enabled,true);assert.equal(again.alreadyEnabled,true);assert.deepEqual(again.receipt,first.receipt);assert.equal(again.storage.revision,revision);assert.deepEqual(f.get(SYNC_APP_CHANGE_HEAD),head);assert.equal(head.value.seq,1);assert.equal(f.files.size,before.size);preserved(f,before);
});
test('lost activation acknowledgement resumes the same fence with no duplicate commit',()=>{
 const f=fixture(),original=f.writer.enableFormatFence.bind(f.writer);let captured;
 f.writer.enableFormatFence=c=>{captured=original(c);throw Error('TEST_LOST_ACK');};assert.throws(()=>activateSyncV2(f.runtime),/TEST_LOST_ACK/);const frames=countFrames(f),before=originalFiles(f);
 const result=activateSyncV2(f.fresh());assert.equal(result.alreadyEnabled,true);assert.deepEqual(result.receipt,captured);assert.equal(countFrames(f),frames);assert.equal(f.files.size,before.size);preserved(f,before);
});
test('response loss before create followed by delayed old proposal preserves same operation identity',()=>{
 const f=fixture();let captured,proposed;
 const original=f.writer.enableFormatFence.bind(f.writer);f.writer.enableFormatFence=c=>{proposed=c;return original(c);};
 f.faults.create=(id,bytes,role,next)=>{if(role==='frame'){captured={id,bytes:Uint8Array.from(bytes)};throw Error('TEST_UNRESOLVED_CREATE');}return next();};
 assert.throws(()=>activateSyncV2(f.runtime),/WRITER_COMMIT_UNRESOLVED/);assert.equal(countFrames(f),0);const old=originalFiles(f);
 let once=true;f.faults.create=(id,bytes,role,next)=>{if(role==='frame'&&once){once=false;assert.equal(id,captured.id);f.files.set(id,captured.bytes);throw Error('409 delayed first proposal won');}return next();};
 const fresh=f.fresh(),originalFresh=fresh.writer.enableFormatFence.bind(fresh.writer);let retry;
 fresh.writer.enableFormatFence=c=>{retry=c;return originalFresh(c);};const result=activateSyncV2(fresh);
 assert.equal(retry.operationId,proposed.operationId);assert.equal(retry.digest,proposed.digest);assert.equal(result.receipt.operationId,proposed.operationId);assert.equal(result.storage.writerFence,2);assert.equal(countFrames(f),1);preserved(f,old);
});
test('committed fence followed by readback failure is recovered without reinitializing head',()=>{
 const f=fixture();let fenceId;
 f.faults.create=(id,bytes,role,next)=>{const result=next();if(role==='frame'&&JSON.parse(decodeUtf8(bytes)).payload.writerFence===2)fenceId=id;return result;};
 f.faults.read=(id,max,next)=>{if(id===fenceId)throw Error('TEST_READBACK_INTERRUPTED');return next();};
 assert.throws(()=>activateSyncV2(f.runtime),/TEST_READBACK_INTERRUPTED/);assert.equal(countFrames(f),1);delete f.faults.create;delete f.faults.read;
 const result=activateSyncV2(f.fresh());assert.equal(result.alreadyEnabled,true);assert.equal(result.receipt.frameId,fenceId);assert.equal(countFrames(f),1);assert.equal(result.storage.writerFence,2);
});
test('an unresolved older legacy command can win before activation without losing data',()=>{
 const f=fixture(),legacy=command('wake:2026-10-07','07:00');let pending,mode='capture';
 f.faults.create=(id,bytes,role,next)=>{if(role==='frame'&&mode==='capture'){pending={id,bytes:Uint8Array.from(bytes)};throw Error('TEST_OLD_PENDING');}if(role==='frame'&&mode==='publish'){mode='normal';f.files.set(pending.id,pending.bytes);throw Error('409 older legacy writer won');}return next();};
 assert.throws(()=>f.domain.command(legacy),/WRITER_COMMIT_UNRESOLVED/);mode='publish';const result=activateSyncV2(f.fresh());assert.equal(result.storage.writerFence,2);assert.equal(result.storage.revision,2);
 const fresh=f.fresh();fresh.locked(()=>{fresh.writer.recoveryBarrier();assert.equal(fresh.writer.getEntity('app/data/'+legacy.key).value,'07:00');assert.equal(fresh.writer.getEntity(SYNC_APP_CHANGE_HEAD).value.seq,0);assert.equal(fresh.writer.getReceipt(legacy.operationId).result.appSeq,undefined);});
});
test('unfenced existing journal is blocked, never adopted or reset',()=>{
 const f=fixture();f.locked(()=>f.writer.transact({operationId:randomUUID(),epoch:'default',digest:writerDigest('existing experimental head'),changes:[{key:SYNC_APP_CHANGE_HEAD,expectedVersion:0,value:initialSyncAppChangeHead()}]}));const before=originalFiles(f),revision=f.status().revision;
 assert.throws(()=>activateSyncV2(f.runtime),e=>e.code==='SYNC_V2_UNFENCED_JOURNAL_PRESENT'&&e.requiresOwnerAction);assert.equal(f.status().revision,revision);assert.equal(f.status().writerFence,0);assert.equal(f.files.size,before.size);preserved(f,before);
});
test('missing or corrupt head behind an existing fence fails closed',()=>{
 for(const value of [null,{protocol:2,seq:0,floor:0,capacity:SYNC_APP_CHANGE_CAPACITY}]){
  const f=fixture();f.locked(()=>f.writer.enableFormatFence({operationId:randomUUID(),epoch:'default',digest:writerDigest({fixture:value}),changes:value?[{key:SYNC_APP_CHANGE_HEAD,expectedVersion:0,value}]:[]}));const before=originalFiles(f);
  assert.throws(()=>activateSyncV2(f.runtime),/APP_JOURNAL_CORRUPT/);assert.equal(f.files.size,before.size);preserved(f,before);
 }
});
test('absent original store is never bootstrapped or configured by activation',()=>{
 const f=fixture({bootstrap:false});assert.throws(()=>activateSyncV2(f.runtime),/WRITER_MISSING_REFERENCE/);assert.equal(f.files.size,0);assert.equal(f.calls.some(c=>c[0]==='create'||c[0]==='allocate'),false);
});
test('stable activation identity binds store, generation and schema',()=>{
 const results=[];for(const opts of [{},{storeId:'different'},{generation:'2'},{schemaVersion:4}])results.push(activateSyncV2(fixture(opts).runtime).receipt);assert.equal(new Set(results.map(r=>r.operationId)).size,4);assert.equal(new Set(results.map(r=>r.digest)).size,4);
});
test('recovery progress is requested under runtime lock before examining activation state',()=>{
 const f=fixture(),original=f.writer.recoveryBarrier.bind(f.writer),seen=[];
 f.writer.recoveryBarrier=options=>{seen.push(options);return original(options);};activateSyncV2(f.runtime);assert.deepEqual(seen[0],{persistFrameProgress:true});
 assert.throws(()=>activateSyncV2({writer:f.writer}),/SYNC_V2_ACTIVATION_CONFIG/);
});
test('shared protocol accepts initial head and rejects malformed floor/capacity/sequence',()=>{
 assert.deepEqual(validateSyncAppChangeHead({value:initialSyncAppChangeHead(),deleted:false}),initialSyncAppChangeHead());
 for(const value of [{...initialSyncAppChangeHead(),seq:-1},{...initialSyncAppChangeHead(),capacity:2048},{...initialSyncAppChangeHead(),floor:0},{...initialSyncAppChangeHead(),extra:1}])assert.throws(()=>validateSyncAppChangeHead({value,deleted:false}),/APP_JOURNAL_CORRUPT/);
 assert.throws(()=>validateSyncAppChangeHead(null),/APP_JOURNAL_CORRUPT/);
});
