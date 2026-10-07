import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeFixture} from './runtime-fixture.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {writerDigest} from './reserved-writer.mjs';
const command=(id,key='x',version=0)=>({operationId:id,digest:writerDigest(id),changes:[{key,expectedVersion:version,value:id}]});
function setup(mode='lock-phase'){const f=runtimeFixture();f.config.protocolReadCache={mode};const r=createGasImportRuntime(f.globals,f.config);r.locked(()=>r.writer.bootstrap());return {f,r};}

test('warm recovery reuses verified prefix but freshly polls missing successor every time',()=>{
 const {f,r}=setup();r.locked(()=>{r.writer.recoveryBarrier();const state=r.writer.status(),next=state.nextSlotId,index=state.nextIndexId;const before=f.calls.length;r.writer.recoveryBarrier();r.writer.recoveryBarrier();assert.deepEqual(f.calls.slice(before),[['fetch',index],['fetch',next],['fetch',index],['fetch',next]]);});
});
test('strict metadata mode does not authorize verified-prefix reuse',()=>{
 const {r}=setup('bytes');r.locked(()=>{r.writer.recoveryBarrier();const io=r.writer.io,read=io.readFile.bind(io),ids=[];io.readFile=(id,max)=>{ids.push(id);return read(id,max);};r.writer.recoveryBarrier();assert(ids.includes('anchor'));assert.equal(io.getVerifiedReadPhase(),null);});
});
test('delayed same-ID immutable frame visibility is discovered by warm successor polling',()=>{
 const {f,r}=setup(),create=f.globals.Drive.Files.create;let delayed;
 f.globals.Drive.Files.create=(meta,blob,options)=>{if(meta.appProperties['mypace.role']==='frame'){delayed={meta:structuredClone(meta),blob:structuredClone(blob),options};throw Error('response pending before visibility');}return create(meta,blob,options);};
 assert.throws(()=>r.locked(()=>r.writer.transact(command('delayed'))),/WRITER_COMMIT_UNRESOLVED/);f.globals.Drive.Files.create=create;
 r.locked(()=>{r.writer.recoveryBarrier();assert.equal(r.writer.get('x'),null);create(delayed.meta,delayed.blob,delayed.options);r.writer.recoveryBarrier();assert.equal(r.writer.get('x').value,'delayed');assert.equal(r.writer.getReceipt('delayed').revision,1);});
});
test('new lock phase sees another runtime commit instead of trusting the old prefix',()=>{
 const {f,r}=setup();r.locked(()=>r.writer.transact(command('first')));const other=createGasImportRuntime(f.globals,f.config);other.locked(()=>other.writer.transact(command('second','x',1)));r.locked(()=>{r.writer.recoveryBarrier();assert.equal(r.writer.get('x').value,'second');assert.equal(r.writer.status().revision,2);});
});
test('failed warm tail read invalidates state and forces full prefix recovery on retry',()=>{
 const {f,r}=setup();r.locked(()=>{r.writer.transact(command('first'));const next=r.writer.status().nextSlotId,fetch=f.globals.UrlFetchApp.fetch;f.globals.UrlFetchApp.fetch=(url,o)=>{if(new URL(url).pathname.endsWith('/'+next))throw Error('outage');return fetch(url,o);};assert.throws(()=>r.writer.recoveryBarrier(),/STORE_READ_UNRESOLVED/);assert.throws(()=>r.writer.status(),/WRITER_RECOVERY_REQUIRED/);assert.equal(r.writer._verifiedPhase,null);f.globals.UrlFetchApp.fetch=fetch;const io=r.writer.io,read=io.readFile.bind(io),ids=[];io.readFile=(id,max)=>{ids.push(id);return read(id,max);};r.writer.recoveryBarrier();assert(ids.includes('anchor'));assert.equal(r.writer.get('x').value,'first');});
});
test('warm checkpoint publication failure blocks state until mandatory fixed index is repaired',()=>{
 const {f,r}=setup(),create=f.globals.Drive.Files.create;r.locked(()=>{r.writer.transact(command('first'));const index=r.writer.status().nextIndexId;f.globals.Drive.Files.create=(m,b,o)=>{if(m.appProperties['mypace.role']==='checkpoint-index')throw Error('index unavailable');return create(m,b,o);};assert.throws(()=>r.writer.checkpoint({operationId:'cp',digest:writerDigest('cp'),changes:[]}),/WRITER_CREATE_UNRESOLVED/);assert.throws(()=>r.writer.get('x'),/WRITER_RECOVERY_REQUIRED/);f.globals.Drive.Files.create=create;r.writer.recoveryBarrier();assert(f.files.has(index));assert.equal(r.writer.status().replayFrames,1);assert.equal(r.writer.getReceipt('cp').revision,2);r.writer.transact(command('second','x',1));assert.equal(r.writer.status().replayFrames,2);});
});
test('warm automatic checkpoints reset replay budget to the verified publishing frame',()=>{
 const {f,r}=setup();r.writer.limits.checkpointEvery=4;r.locked(()=>{for(let i=0;i<12;i++)r.writer.transact(command('op'+i,'x',i));assert.equal(r.writer.status().revision,15);assert.equal(r.writer.status().replayFrames,3);const checkpoints=[...f.files.values()].filter(v=>v.meta.appProperties?.['mypace.role']==='checkpoint-index');assert.equal(checkpoints.length,3);});const cold=createGasImportRuntime(f.globals,f.config);cold.locked(()=>{cold.writer.recoveryBarrier();assert.equal(cold.writer.get('x').version,12);assert.equal(cold.writer.status().replayFrames,3);});
});
test('minimum acknowledgements remain checked against warm head and durable revision proofs',()=>{
 const {r}=setup();r.locked(()=>{const first=r.writer.transact(command('first'));r.writer.transact(command('second','x',1));r.writer.recoveryBarrier({minimumAcknowledged:{revision:first.revision,hash:first.frameHash}});const head=r.writer.status();r.writer.recoveryBarrier({minimumAcknowledged:{revision:head.revision,hash:head.headHash}});assert.throws(()=>r.writer.recoveryBarrier({minimumAcknowledged:{revision:first.revision,hash:'f'.repeat(64)}}),/WRITER_ACKNOWLEDGEMENT_UNPROVEN/);assert.throws(()=>r.writer.status(),/WRITER_RECOVERY_REQUIRED/);});
});
