import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runtimeFixture} from './runtime-fixture.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {ReservedSlotWriter,writerDigest} from './reserved-writer.mjs';
import {encodeUtf8,decodeUtf8} from './codec.mjs';
import {ImportRunner} from './import-runner.mjs';
import {importKeys} from './import-store.mjs';

const command=(id,changes=[])=>({operationId:id,digest:writerDigest(id),changes});
const put=(id,key,value,expectedVersion=0)=>command(id,[{key,value,expectedVersion}]);
function setup(cache={mode:'lock-phase'}){
 const f=runtimeFixture();f.config.protocolReadCache=cache;
 const r=createGasImportRuntime(f.globals,f.config);
 r.locked(()=>r.writer.bootstrap());return {f,r};
}
function sorted(v){if(Array.isArray(v))return v.map(sorted);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])]));return v;}
function reseal(entry,mutate){
 const object=JSON.parse(decodeUtf8(entry.bytes));mutate(object);const {hash,...body}=object;object.hash=writerDigest(body);
 entry.bytes=encodeUtf8(JSON.stringify(sorted(object)));entry.meta.size=String(entry.bytes.length);entry.meta.version=String(Number(entry.meta.version)+1);entry.meta.md5Checksum=createHash('md5').update(entry.bytes).digest('hex');
}
function stageTail(f,r,write){
 const before=r.locked(()=>r.writer.recoveryBarrier());
 const other=createGasImportRuntime(f.globals,f.config);other.locked(()=>write(other.writer));
 const frame=f.files.get(before.nextSlotId);assert(frame);f.files.delete(before.nextSlotId);
 const index=f.files.get(before.nextIndexId);if(index)f.files.delete(before.nextIndexId);
 return {before,frame,index};
}

test('a delayed conflicting frame is rejected rather than skipped by warm recovery',()=>{
 for(const corrupt of [o=>{o.payload.parent.hash='f'.repeat(64);},o=>{o.payload.revision++;},o=>{o.payload.changes[0].expectedVersion++;}]){
  const {f,r}=setup(),tail=stageTail(f,r,w=>w.transact(put('late','x',1)));
  reseal(tail.frame,corrupt);
  r.locked(()=>{r.writer.recoveryBarrier();f.files.set(tail.before.nextSlotId,tail.frame);assert.throws(()=>r.writer.recoveryBarrier(),/WRITER_FRAME_(INVALID|ENTITY_MISMATCH)/);assert.throws(()=>r.writer.status(),/WRITER_RECOVERY_REQUIRED/);});
 }
});

test('a late frame with missing mandatory state shard invalidates the warm prefix',()=>{
 const {f,r}=setup(),tail=stageTail(f,r,w=>w.transact(put('late','x',1)));
 const frame=JSON.parse(decodeUtf8(tail.frame.bytes));f.files.delete(frame.payload.stateRoot.id);
 r.locked(()=>{r.writer.recoveryBarrier();f.files.set(tail.before.nextSlotId,tail.frame);assert.throws(()=>r.writer.recoveryBarrier(),/WRITER_MISSING_REFERENCE/);assert.equal(r.writer._verifiedPhase,null);assert.throws(()=>r.writer.get('x'),/WRITER_RECOVERY_REQUIRED/);});
});

test('a late checkpoint with conflicting fixed index cannot authorize successor writes',()=>{
 const {f,r}=setup();r.locked(()=>r.writer.transact(put('first','x',1)));
 const tail=stageTail(f,r,w=>w.checkpoint(command('late_checkpoint')));assert(tail.index);
 reseal(tail.index,o=>{o.payload.nextIndexId='conflicting_next_index';});
 r.locked(()=>{r.writer.recoveryBarrier();f.files.set(tail.before.nextSlotId,tail.frame);f.files.set(tail.before.nextIndexId,tail.index);assert.throws(()=>r.writer.transact(put('next','x',2,1)),/WRITER_CHECKPOINT_BARRIER_INVALID/);assert.throws(()=>r.writer.status(),/WRITER_RECOVERY_REQUIRED/);});
 assert.equal([...f.files.values()].filter(x=>x.meta.appProperties?.['mypace.role']==='frame').length,2);
});

test('a late checkpoint missing its manifest cannot publish its fixed index',()=>{
 const {f,r}=setup(),tail=stageTail(f,r,w=>w.checkpoint(command('late_checkpoint')));
 const frame=JSON.parse(decodeUtf8(tail.frame.bytes));f.files.delete(frame.payload.checkpoint.manifestRef.id);
 r.locked(()=>{r.writer.recoveryBarrier();f.files.set(tail.before.nextSlotId,tail.frame);assert.throws(()=>r.writer.recoveryBarrier(),/WRITER_MISSING_REFERENCE/);assert.equal(f.files.has(tail.before.nextIndexId),false);});
});

test('a late checkpoint recreates its missing fixed index before accepting a successor',()=>{
 const {f,r}=setup(),tail=stageTail(f,r,w=>w.checkpoint(command('late_checkpoint')));
 r.locked(()=>{r.writer.recoveryBarrier();f.files.set(tail.before.nextSlotId,tail.frame);const before=f.calls.length;const receipt=r.writer.transact(put('successor','x',1));assert.equal(receipt.revision,2);const writes=f.calls.slice(before).filter(x=>x[0]==='create').map(x=>x[1]);assert.equal(writes[0],tail.before.nextIndexId);assert.deepEqual(f.files.get(tail.before.nextIndexId).bytes,tail.index.bytes);});
});

test('a newly visible index cannot hide its missing mandatory publication frame from warm recovery',()=>{
 const {f,r}=setup();r.locked(()=>r.writer.transact(put('first','x',1)));
 const tail=stageTail(f,r,w=>w.checkpoint(command('late_checkpoint')));
 r.locked(()=>{r.writer.recoveryBarrier();f.files.set(tail.before.nextIndexId,tail.index);assert.throws(()=>r.writer.recoveryBarrier(),/WRITER_MISSING_PUBLICATION_FRAME/);assert.throws(()=>r.writer.status(),/WRITER_RECOVERY_REQUIRED/);
  f.files.set(tail.before.nextSlotId,tail.frame);r.writer.recoveryBarrier();assert.equal(r.writer.getReceipt('late_checkpoint').revision,2);
 });
});

test('a newly visible malformed index is never treated as an empty checkpoint tail',()=>{
 const {f,r}=setup(),tail=stageTail(f,r,w=>w.checkpoint(command('late_checkpoint')));
 reseal(tail.index,o=>{o.payload.previousIndex={id:'unrelated',hash:'f'.repeat(64)};});
 r.locked(()=>{r.writer.recoveryBarrier();f.files.set(tail.before.nextIndexId,tail.index);assert.throws(()=>r.writer.recoveryBarrier(),/WRITER_CHECKPOINT_INDEX_INVALID/);assert.equal(r.writer._verifiedPhase,null);});
});

test('warm checkpoint limit is enforced before creating staged files or an unrecoverable frame',()=>{
 const {f,r}=setup();r.writer.limits.maxIndexLinks=1;
 let revision;
 r.locked(()=>{r.writer.checkpoint(command('only_checkpoint'));revision=r.writer.status().revision;const creates=f.calls.filter(c=>c[0]==='create').length;
  assert.throws(()=>r.writer.checkpoint(command('over_budget')),/WRITER_RECOVERY_SETUP_REQUIRED/);assert.equal(f.calls.filter(c=>c[0]==='create').length,creates);assert.equal(r.writer.recoveryBarrier().revision,revision);
 });
 const cold=new ReservedSlotWriter({io:r.writer.io,storeId:'store',writerScriptId:'writer',anchorId:'anchor',limits:{maxIndexLinks:1}});
 r.locked(()=>{assert.equal(cold.recoveryBarrier().revision,revision);assert.equal(cold.getReceipt('over_budget'),null);});
});

test('cold index count is retained when the same phase attempts another checkpoint',()=>{
 const {f,r}=setup();r.locked(()=>r.writer.checkpoint(command('first_checkpoint')));
 const cold=new ReservedSlotWriter({io:r.writer.io,storeId:'store',writerScriptId:'writer',anchorId:'anchor',limits:{maxIndexLinks:1}});
 r.locked(()=>{cold.recoveryBarrier();const creates=f.calls.filter(c=>c[0]==='create').length;assert.throws(()=>cold.checkpoint(command('over_budget')),/WRITER_RECOVERY_SETUP_REQUIRED/);assert.equal(f.calls.filter(c=>c[0]==='create').length,creates);});
});

test('warm acknowledgement checks reject wrong head, future and malformed proofs',()=>{
 for(const proof of ['wrong-head','future','invalid','wrong-old']){
  const {r}=setup();r.locked(()=>{const first=r.writer.transact(put('one','x',1)),head=r.writer.transact(put('two','x',2,1));let min;
   if(proof==='wrong-head')min={revision:head.revision,hash:'f'.repeat(64)};
   if(proof==='future')min={revision:head.revision+1,hash:head.frameHash};
   if(proof==='invalid')min={revision:-1,hash:head.frameHash};
   if(proof==='wrong-old')min={revision:first.revision,hash:'f'.repeat(64)};
   assert.throws(()=>r.writer.recoveryBarrier({minimumAcknowledged:min}),/WRITER_ACKNOWLEDGEMENT_(MISMATCH|UNPROVEN|INVALID)/);assert.throws(()=>r.writer.status(),/WRITER_RECOVERY_REQUIRED/);
  });
 }
});

test('evicted protocol bytes do not extend verified-prefix trust across phase rotation',()=>{
 const {f,r}=setup({mode:'lock-phase',maxEntries:1,maxBytes:4096});
 let original;
 r.locked(()=>{r.writer.transact(put('one','x',1));original=Uint8Array.from(f.files.get('anchor').bytes);f.files.get('anchor').bytes[0]=0;r.writer.recoveryBarrier();assert.equal(r.writer.get('x').value,1);});
 assert.throws(()=>r.locked(()=>r.writer.recoveryBarrier()),/WRITER_FILE_INVALID/);
 f.files.get('anchor').bytes=original;r.locked(()=>{r.writer.recoveryBarrier();assert.equal(r.writer.get('x').value,1);});
});

test('lock loss invalidates token and requires cold validation even on the same writer',()=>{
 const {f,r}=setup();r.locked(()=>{r.writer.recoveryBarrier();const token=r.writer.io.getVerifiedReadPhase();f.lock.releaseLock();assert.throws(()=>r.writer.recoveryBarrier(),/STORE_LOCK_REQUIRED/);assert.equal(r.writer._verifiedPhase,null);assert.equal(r.writer.io.getVerifiedReadPhase(),null);assert.equal(f.lock.tryLock(),true);assert.equal(r.writer.io.getVerifiedReadPhase(),null);r.writer.io.beginReadPhase();assert.notEqual(r.writer.io.getVerifiedReadPhase(),token);f.files.get('anchor').bytes[0]=0;assert.throws(()=>r.writer.recoveryBarrier(),/WRITER_FILE_INVALID/);});
});

function finalizationSetup(){
 const f=runtimeFixture('# sensor:multi_record\ntime,latitude,longitude\n'+'2026-01-01T00:00:00Z,1,2\n'.repeat(22));
 f.config.protocolReadCache={mode:'lock-phase'};const r=createGasImportRuntime(f.globals,f.config);
 r.locked(()=>{r.writer.bootstrap();r.store.registerJob({operationId:'register',jobId:'job',sourceIdentity:f.source});});
 const runner=new ImportRunner({store:r.store,coordinator:r.coordinator,source:{...r.source,readRange:(s,o,n,args)=>r.source.readRange(s,o,Math.min(n,100),args)},allocateIds:n=>r.writer.io.allocateIds(n),locked:r.locked,checkBudget:()=>true});
 let out;do{out=runner.stepJob('job');}while(out.status!=='parsed');runner.finalizeJobStep('job');return {f,r,runner};
}

test('fourth-batch asset corruption rolls back the entire group and a cold runtime re-verifies it',()=>{
 const {f,r,runner}=finalizationSetup();let before,asset;
 r.locked(()=>{before=r.store.getJob('job');let pin=before.firstPin;for(let i=0;i<3;i++)pin=r.writer.get(importKeys.pin(pin)).value.nextPin;asset=r.writer.get(importKeys.pin(pin)).value.assets.find(a=>a.role==='output');});
 const entry=f.files.get(asset.fileId),original=Uint8Array.from(entry.bytes);entry.bytes[0]^=1;
 assert.throws(()=>runner.finalizeJobStep('job'),/ASSET_CONTENT_MISMATCH/);
 assert.deepEqual(r.locked(()=>r.store.getJob('job')).finalization,before.finalization);
 entry.bytes=original;const cold=createGasImportRuntime(f.globals,f.config);const at=f.calls.length;cold.runner.finalizeJobStep('job');
 assert.equal(cold.locked(()=>cold.store.getJob('job')).finalization.visited,4);
 const reads=f.calls.slice(at).filter(c=>c[0]==='get').map(c=>c[1]);assert(reads.includes(asset.fileId));
});

test('bounded finalization retries cannot replay a group under a different cursor or reused operation',()=>{
 const {r}=finalizationSetup();r.locked(()=>{const job=r.store.getJob('job'),input={operationId:'group',jobId:'job',expectedCursor:job.finalization.cursor};r.store.verifyNextBatches(input);
  assert.throws(()=>r.store.verifyNextBatches({...input,operationId:'stale_group'}),/FINALIZATION_CURSOR_CONFLICT/);
  const current=r.store.getJob('job');assert.equal(current.finalization.visited,4);
  assert.throws(()=>r.store.verifyNextBatches({...input,expectedCursor:current.finalization.cursor}),/OP_ID_REUSED/);
  assert.equal(r.store.getJob('job').finalization.visited,4);
 });
});

test('budget exhaustion in a later batch preserves the original group cursor for retry',()=>{
 const {f,r,runner}=finalizationSetup(),before=r.locked(()=>r.store.getJob('job'));
 let checkpoints=0,exhausted=false;const get=f.globals.Drive.Files.get;
 f.globals.Drive.Files.get=(id,args)=>{const m=get(id,args);if(m.appProperties?.['mypace.role']==='checkpoint'&&++checkpoints===3)exhausted=true;return m;};
 f.config.checkBudget=()=>!exhausted;r.writer.io.checkBudget=f.config.checkBudget;
 assert.throws(()=>runner.finalizeJobStep('job'),/IMPORT_YIELD/);
 f.globals.Drive.Files.get=get;exhausted=false;
 const cold=createGasImportRuntime(f.globals,f.config);assert.deepEqual(cold.locked(()=>cold.store.getJob('job')).finalization,before.finalization);
 cold.runner.finalizeJobStep('job');assert.equal(cold.locked(()=>cold.store.getJob('job')).finalization.visited,4);
});

test('lost readback after a durable grouped-finalization frame replays its receipt exactly once',()=>{
 const {f,r}=finalizationSetup(),job=r.locked(()=>r.store.getJob('job'));
 const input={operationId:'lost_group',jobId:'job',expectedCursor:job.finalization.cursor};
 const create=f.globals.Drive.Files.create,fetch=f.globals.UrlFetchApp.fetch;let committedFrame=null;
 f.globals.Drive.Files.create=(m,b,o)=>{const result=create(m,b,o);if(m.appProperties?.['mypace.role']==='frame')committedFrame=m.id;return result;};
 f.globals.UrlFetchApp.fetch=(url,o)=>{if(committedFrame&&new URL(url).pathname.endsWith('/'+committedFrame))throw Error('lost readback');return fetch(url,o);};
 assert.throws(()=>r.locked(()=>r.store.verifyNextBatches(input)),/STORE_READ_UNRESOLVED/);
 f.globals.Drive.Files.create=create;f.globals.UrlFetchApp.fetch=fetch;assert(committedFrame);
 const cold=createGasImportRuntime(f.globals,f.config);const receipt=cold.locked(()=>cold.store.verifyNextBatches(input));
 assert.equal(receipt.frameId,committedFrame);assert.equal(receipt.result.checked,4);assert.equal(cold.locked(()=>cold.store.getJob('job')).finalization.visited,4);
 assert.deepEqual(cold.locked(()=>cold.store.verifyNextBatches(input)),receipt);
});
