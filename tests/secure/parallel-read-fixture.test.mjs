import test from 'node:test';
import assert from 'node:assert/strict';
import {gasWebFixture} from '../helpers/gas-web-fixture.mjs';
import {createGasDriveRest} from '../../storage/gas-drive-rest.mjs';
import {GasStoreIO} from '../../storage/gas-store-io.mjs';
import {createGasImportRuntime} from '../../storage/gas-import-runtime.mjs';
import {createGasCheckpointHintCodec} from '../../storage/checkpoint-hint.mjs';
import {writerDigest} from '../../storage/reserved-writer.mjs';


test('HTTP fixture distinguishes two parallel read subrequests from one service-delay wall window',()=>{
 const f=gasWebFixture({readMs:1000,writeMs:1000}),rest=createGasDriveRest(f.globals,{deadlineMs:f.now+20000,now:()=>f.now}),reads=[{id:f.config.anchorId,suffix:'?fields=id'},{id:f.config.metadataParentId,suffix:'?fields=id'}],start=f.now,before=f.restCalls.length;
 assert.equal(rest.readMany(reads).length,2);assert.equal(f.now-start,1000);assert.equal(f.restCalls.length-before,2);assert.equal(f.restBatches.length,1);assert.equal(f.restBatches[0].subrequests,2);assert.equal(f.restBatches[0].elapsedMs,1000);assert(f.restCalls.slice(before).every(call=>call.batchId===1));
 const sequential=createGasDriveRest({...f.globals,UrlFetchApp:{...f.globals.UrlFetchApp,fetchAll:undefined}},{deadlineMs:f.now+20000,now:()=>f.now}),at=f.now;assert.equal(sequential.readMany(reads).length,2);assert.equal(f.now-at,2000);assert.equal(f.restBatches.length,1);
});

test('actual REST prefetch uses one private parent proof plus metadata/media batches and counts all five RPCs',()=>{
 const f=gasWebFixture({readMs:1000,writeMs:1000,activate:true}),rest=createGasDriveRest(f.globals,{deadlineMs:f.now+20000,now:()=>f.now}),io=new GasStoreIO({...f.globals,lock:f.lock,storeId:f.config.storeId,managedParentId:f.config.metadataParentId,checkBudget:()=>true,protocolReadCache:{mode:'lock-phase'},restTransport:rest});
 f.lock.tryLock();io.beginReadPhase();const start=f.now,before=f.restCalls.length,ids=[f.config.anchorId,f.config.firstSlotId];assert.equal(io.prefetchFiles(ids),2);assert.equal(f.now-start,3000);assert.equal(f.restCalls.length-before,5);assert.equal(f.restBatches.length,2);
 const at=f.now,calls=f.restCalls.length;for(const id of ids)assert(io.readFile(id).length>0);assert.equal(f.now,at);assert.equal(f.restCalls.length,calls);io.endReadPhase();f.lock.releaseLock();
});

test('batch timeout is unresolved with every launched RPC counted and no serialized retry',()=>{
 const f=gasWebFixture({readMs:9000}),rest=createGasDriveRest(f.globals,{deadlineMs:f.now+20000,now:()=>f.now}),start=f.now;
 assert.throws(()=>rest.readMany([{id:f.config.anchorId,suffix:'?fields=id'},{id:f.config.metadataParentId,suffix:'?fields=id'}]),e=>e.code==='STORE_REQUEST_UNRESOLVED'&&e.retryable);assert.equal(f.now-start,8000);assert.equal(f.restCalls.length,2);assert.equal(f.restBatches.length,1);
});

function writeIO(f){const rest=createGasDriveRest(f.globals,{deadlineMs:f.now+30000,now:()=>f.now}),io=new GasStoreIO({...f.globals,lock:f.lock,storeId:f.config.storeId,managedParentId:f.config.metadataParentId,checkBudget:()=>true,protocolReadCache:{mode:'lock-phase'},restTransport:rest});f.lock.tryLock();io.beginReadPhase();return io;}
const output=id=>({id,role:'index-node',bytes:Uint8Array.of(10,20,30)});

test('actual immutable create batch counts each fresh parent GET and stable-ID POST separately from wall time',()=>{
 const f=gasWebFixture({readMs:1000,writeMs:1000}),io=writeIO(f),files=[output('stable_node_a'),output('stable_node_b')],start=f.now,before=f.restCalls.length;
 assert.deepEqual(io.createMany(files),files.map(f=>({id:f.id})));assert.equal(f.now-start,2000);assert.equal(f.restCalls.length-before,4);assert.equal(f.restBatches.length,2);assert.deepEqual(f.restBatches.map(b=>b.subrequests),[2,2]);assert.equal(io._readCache.size,0,'create responses alone never populate verified byte cache');
 assert.equal(io.prefetchFiles(files.map(f=>f.id)),2);for(const file of files)assert.deepEqual(io.readFile(file.id),file.bytes);io.endReadPhase();f.lock.releaseLock();
});

test('actual partially lost create batch recovers exact same IDs by independent readback with no replacement or overwrite',()=>{
 let creates=0;const f=gasWebFixture({readMs:1000,writeMs:1000,aroundRequest:(call,perform)=>{const result=perform();if(call.kind==='create'&&++creates===2)throw Error('synthetic response loss after durable create');return result;}}),io=writeIO(f),files=[output('reserved_node_a'),output('reserved_node_b')];
 assert.throws(()=>io.createMany(files),e=>e.message==='STORE_CREATE_UNRESOLVED'&&e.retryable);assert.equal(creates,2);assert(files.every(file=>f.files.has(file.id)));assert.equal(io._readCache.size,0);assert.equal(io.prefetchFiles(files.map(f=>f.id)),2);for(const file of files)assert.deepEqual(io.readFile(file.id),file.bytes);assert.equal(creates,2,'readback never re-creates successful nodes');assert.equal(f.restCalls.filter(c=>c.kind==='ids').length,0);io.endReadPhase();f.lock.releaseLock();
});

test('a warmed read-phase parent proof never authorizes a later create after privacy changes',()=>{
 const f=gasWebFixture({readMs:1000,writeMs:1000}),io=writeIO(f);assert.equal(io.prefetchFiles([f.config.anchorId]),1);f.files.get(f.config.metadataParentId).meta.shared=true;const before=f.restCalls.length;assert.throws(()=>io.createMany([output('denied_node_a'),output('denied_node_b')]),/STORE_PARENT_NOT_PRIVATE/);assert.equal(f.restCalls.slice(before).filter(c=>c.kind==='create').length,0);assert.equal(f.files.has('denied_node_a'),false);io.endReadPhase();f.lock.releaseLock();
});

test('actual recovery prefetch keeps five quota reads in three wall-delay windows and never caches the hint',()=>{
 const f=gasWebFixture({readMs:1000,writeMs:1000,activate:true}),rest=createGasDriveRest(f.globals,{deadlineMs:f.now+20000,now:()=>f.now}),io=new GasStoreIO({...f.globals,lock:f.lock,storeId:f.config.storeId,managedParentId:f.config.metadataParentId,checkpointHintId:f.config.checkpointHintId,checkBudget:()=>true,protocolReadCache:{mode:'lock-phase'},restTransport:rest});
 f.lock.tryLock();io.beginReadPhase();io.writeCheckpointHint(Uint8Array.of(123,125));const before=f.restCalls.length,start=f.now,r=io.prefetchRecoveryRead(f.config.anchorId);assert(r.hintBytes instanceof Uint8Array);assert.equal(f.now-start,3000);assert.equal(f.restCalls.length-before,5);assert.equal(io._readCache.has(f.config.checkpointHintId),false);assert(io._readCache.has(f.config.anchorId));
 const original=Uint8Array.from(r.hintBytes);r.hintBytes[0]^=255;assert.deepEqual(io.readCheckpointHint(),original);io.endReadPhase();f.lock.releaseLock();
});

test('actual denied advisory hint is skipped after its metadata denial without media or alternate hint reads',()=>{
 let deniedId,denials=0;const f=gasWebFixture({readMs:1000,writeMs:1000,activate:true,aroundRequest:(call,perform)=>{if(deniedId&&call.kind==='metadata'&&call.path.endsWith('/'+deniedId)){denials++;return {getResponseCode:()=>403,getContent:()=>Array.from(Buffer.from('{}')),getContentText:()=>'{}',getAllHeaders:()=>({'Content-Length':'2'})};}return perform();}});deniedId=f.config.checkpointHintId;
 const rest=createGasDriveRest(f.globals,{deadlineMs:f.now+20000,now:()=>f.now}),io=new GasStoreIO({...f.globals,lock:f.lock,storeId:f.config.storeId,managedParentId:f.config.metadataParentId,checkpointHintId:deniedId,checkBudget:()=>true,protocolReadCache:{mode:'lock-phase'},restTransport:rest});f.lock.tryLock();io.beginReadPhase();assert.deepEqual(io.prefetchRecoveryRead(f.config.anchorId),{hintBytes:null});assert.equal(denials,1);assert.equal(f.restCalls.filter(c=>c.path.endsWith('/'+deniedId)&&c.kind==='media').length,0);assert(io.readFile(f.config.anchorId).length>0);assert.equal(denials,1);io.endReadPhase();f.lock.releaseLock();
});

test('persistent hint-side fetchAll failure still permits cold immutable recovery through one anchor-only fallback',()=>{
 let hintId,failures=0;const f=gasWebFixture({readMs:500,writeMs:500,activate:true,seed:rt=>rt.writer.transact({operationId:'preserve_without_hint',digest:writerDigest('preserve_without_hint'),changes:[{key:'retained-record',expectedVersion:0,value:'keep'}]}),aroundRequest:(call,perform)=>{if(hintId&&call.batchId&&call.path.endsWith('/'+hintId)){failures++;throw Error('persistent advisory transport failure');}return perform();}});hintId=f.config.checkpointHintId;
 for(let attempt=0;attempt<2;attempt++){
  const rest=createGasDriveRest(f.globals,{deadlineMs:f.now+35000,now:()=>f.now}),rt=createGasImportRuntime(f.globals,{...f.config,checkBudget:()=>true,restTransport:rest,protocolReadCache:{mode:'lock-phase'},checkpointHintCodec:createGasCheckpointHintCodec({Utilities:f.globals.Utilities,secret:f.properties.get('MYPACE_WRITER_SECRET')})}),before=f.restCalls.length;
  const result=rt.locked(()=>{rt.writer.recoveryBarrier();return {data:rt.writer.getEntity('retained-record'),receipt:rt.writer.getReceipt('preserve_without_hint','default')};});assert.equal(result.data.value,'keep');assert.equal(result.receipt.operationId,'preserve_without_hint');
  const hintCalls=f.restCalls.slice(before).filter(c=>c.path.endsWith('/'+hintId));assert.equal(hintCalls.length,1);assert(hintCalls[0].batchId,'no alternate serial hint route after failure');assert.equal(rt.writer.io._readCache.has(hintId),false);
 }
 assert.equal(failures,2);
});
