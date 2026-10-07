// Reduced-limit local models. No Google requests, original CSVs or deletion API.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {ReservedSlotWriter,writerDigest} from './reserved-writer.mjs';
import {createCheckpointHintCodec} from './checkpoint-hint.mjs';
import {decodeUtf8} from './codec.mjs';
import {runtimeFixture} from './runtime-fixture.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {createOwnerScheduler,OWNER_LIMITS} from './owner-scheduler.mjs';
import {importKeys} from './import-store.mjs';

const command=(operationId,changes=[],epoch='default')=>({operationId,epoch,digest:writerDigest({operationId,changes,epoch}),changes});
const put=(operationId,key,value,expectedVersion=0,epoch='default')=>command(operationId,[{key,expectedVersion,value}],epoch);
function fixture({limits={maxIndexLinks:2,checkpointEvery:3,maxReplayFrames:6},warm=false,hinted=false}={}){
 const files=new Map(),calls=[],faults={};let serial=0,hint=null;const phase={};
 const io={
  getScriptId:()=> 'writer',assertLockHeld:()=>true,
  ...(warm?{getVerifiedReadPhase:()=>phase}:{}),
  allocateIds:n=>Array.from({length:n},()=>`file_${++serial}`),
  readFile(id,max){calls.push(['read',id]);const bytes=files.get(id);if(!bytes)return null;assert(bytes.length<=max);return Uint8Array.from(bytes);},
  createFile(id,bytes,role){calls.push(['create',id,role]);faults.create?.(id,role);assert(!files.has(id),'immutable file must not be overwritten');files.set(id,Uint8Array.from(bytes));return {id};},
  readCheckpointHint:()=>hint&&Uint8Array.from(hint),writeCheckpointHint:bytes=>{hint=Uint8Array.from(bytes);}
 };
 const codec=createCheckpointHintCodec({hmacSha256:text=>createHmac('sha256','synthetic-maintenance-limit-test-key').update(text).digest('hex')});
 const config={io,anchorId:'anchor',storeId:'store',writerScriptId:'writer',limits,clock:()=> '2026-10-06T17:00:00.000Z',...(hinted?{checkpointHintId:'hint',checkpointHintCodec:codec}:{})};
 const fresh=(extra={})=>new ReservedSlotWriter({...config,...extra}),writer=fresh();writer.bootstrap();
 return {files,calls,faults,writer,fresh};
}
const objects=(f,kind)=>[...f.files].map(([id,bytes])=>({id,...JSON.parse(decodeUtf8(bytes))})).filter(x=>x.kind===kind);
const snapshot=f=>new Map([...f.files].map(([id,bytes])=>[id,Uint8Array.from(bytes)]));
function preserved(f,before){for(const [id,bytes] of before)assert.deepEqual(f.files.get(id),bytes,`retained immutable file ${id}`);}
function noWrites(f,fn){const before=snapshot(f),creates=f.calls.filter(c=>c[0]==='create').length;fn();assert.equal(f.calls.filter(c=>c[0]==='create').length,creates);assert.equal(f.files.size,before.size);preserved(f,before);}
function atCap(f){f.writer.checkpoint(command('checkpoint_1'));f.writer.checkpoint(command('checkpoint_2'));assert.equal(objects(f,'checkpoint-index').length,2);return f;}

// No-codec stores retain safe bounded admission until the owner configures recovery.
for(const mode of [{warm:false,hinted:false},{warm:true,hinted:false}]){
 test(`at index cap, cold/warm reads and acknowledged receipts remain available (${JSON.stringify(mode)})`,()=>{
  const f=fixture(mode),initial=put('original','app/day',{text:'retained'}),receipt=f.writer.transact(initial);atCap(f);
  const before=snapshot(f),w=f.fresh();
  noWrites(f,()=>{
   w.recoveryBarrier({minimumAcknowledged:{revision:receipt.revision,hash:receipt.frameHash}});
   assert.deepEqual(w.get('app/day').value,{text:'retained'});assert.deepEqual(w.getReceipt('original'),receipt);
   assert.deepEqual(w.transact(initial),receipt);assert.equal(w.checkpoint(command('checkpoint_2')).operationId,'checkpoint_2');
   assert.throws(()=>w.checkpoint(command('too_many_checkpoints')),/WRITER_RECOVERY_SETUP_REQUIRED/);
   assert.equal(w.getReceipt('too_many_checkpoints'),null);assert.equal(w.recoveryBarrier().replayFrames,1);
  });
  const anchorOnly=f.fresh({checkpointHintCodec:undefined});anchorOnly.recoveryBarrier();assert.deepEqual(anchorOnly.getReceipt('original'),receipt);preserved(f,before);
 });
}

test('ordinary app writes have only checkpointEvery minus one tail slots after the final checkpoint',()=>{
 const f=atCap(fixture()),before=snapshot(f),one=put('one','app/one',1),two=put('two','app/two',2);
 const first=f.writer.transact(one),second=f.writer.transact(two);assert.equal(f.writer.status().replayFrames,3);
 noWrites(f,()=>{
  assert.throws(()=>f.writer.transact(put('blocked','app/blocked',3)),/WRITER_RECOVERY_SETUP_REQUIRED/);
  assert.throws(()=>f.writer.checkpoint(command('blocked_checkpoint')),/WRITER_RECOVERY_SETUP_REQUIRED/);
  assert.deepEqual(f.writer.transact(one),first);assert.deepEqual(f.writer.transact(two),second);
  assert.throws(()=>f.writer.transact({...one,digest:'f'.repeat(64)}),/OP_ID_REUSED/);
 });
 const cold=f.fresh();cold.recoveryBarrier();assert.equal(cold.get('app/two').value,2);assert.equal(cold.get('app/blocked'),null);assert.equal(cold.getReceipt('blocked'),null);assert.equal(objects(f,'checkpoint-index').length,2);preserved(f,before);
});

test('the automatic checkpoint that fills the index cap and its admitted mutation both recover',()=>{
 const f=fixture();f.writer.checkpoint(command('first'));f.writer.transact(put('a','a',1));f.writer.transact(put('b','b',2));
 const at=f.calls.length,last=f.writer.transact(put('c','c',3));assert.equal(objects(f,'checkpoint-index').length,2);assert.equal(f.writer.status().replayFrames,2);
 assert.equal(f.calls.slice(at).filter(c=>c[0]==='create'&&c[2]==='checkpoint-index').length,1);
 const cold=f.fresh();cold.recoveryBarrier({minimumAcknowledged:{revision:last.revision,hash:last.frameHash}});assert.deepEqual(cold.getReceipt('c'),last);assert.equal(cold.get('c').value,3);
 cold.transact(put('d','d',4));noWrites(f,()=>assert.throws(()=>cold.transact(put('e','e',5)),/WRITER_RECOVERY_SETUP_REQUIRED/));
 assert.doesNotThrow(()=>f.fresh().recoveryBarrier());
});

test('ordinary-only checkpoint capacity counts the publishing frame in each replay window',()=>{
 const f=fixture();
 // C + M*(C-1): three ordinary frames initially, then two per checkpoint.
 for(let i=0;i<7;i++)f.writer.transact(put('ordinary_'+i,'ordinary/'+i,i));
 assert.equal(objects(f,'checkpoint-index').length,2);assert.equal(objects(f,'frame').length,9);
 noWrites(f,()=>assert.throws(()=>f.writer.transact(put('ordinary_7','ordinary/7',7)),/WRITER_RECOVERY_SETUP_REQUIRED/));
 const cold=f.fresh();assert.equal(cold.recoveryBarrier().replayFrames,3);assert.equal(cold.get('ordinary/6').value,6);
});

test('an interrupted final checkpoint publishes its already reserved index and retains its original receipt',()=>{
 const f=fixture({limits:{maxIndexLinks:1,checkpointEvery:3,maxReplayFrames:6}}),c=command('last_checkpoint');
 f.faults.create=(id,role)=>{if(role==='checkpoint-index')throw Error('synthetic interrupted publication');};
 assert.throws(()=>f.writer.checkpoint(c),/WRITER_CREATE_UNRESOLVED/);assert.equal(objects(f,'frame').length,1);assert.equal(objects(f,'checkpoint-index').length,0);
 const retained=snapshot(f);delete f.faults.create;
 const cold=f.fresh(),receipt=cold.checkpoint(c);assert.equal(receipt.revision,1);assert.equal(objects(f,'frame').length,1);assert.equal(objects(f,'checkpoint-index').length,1);preserved(f,retained);
 noWrites(f,()=>{assert.deepEqual(cold.checkpoint(c),receipt);assert.throws(()=>cold.checkpoint(command('excess')),/WRITER_RECOVERY_SETUP_REQUIRED/);});
 assert.doesNotThrow(()=>f.fresh().recoveryBarrier());
});

for(const warm of [false,true])test(`epoch fences checkpoint or preflight-block before creating an unreadable tail (warm=${warm})`,()=>{
 const f=fixture({warm,limits:{maxIndexLinks:1,checkpointEvery:2,maxReplayFrames:5}}),receipts=[];
 for(let i=0;i<3;i++)receipts.push(f.writer.advanceEpochs(command('fence_'+i),['default']));
 assert.equal(objects(f,'checkpoint-index').length,1);assert.equal(f.writer.status().replayFrames,2);assert.equal(f.writer.status().revision,4);
 // Before the admission fix, every call below was acknowledged until a fresh
 // recovery exceeded maxReplayFrames. The operation now cannot stage even a shard.
 noWrites(f,()=>{for(let i=3;i<10;i++)assert.throws(()=>f.writer.advanceEpochs(command('fence_'+i),['default']),/WRITER_RECOVERY_SETUP_REQUIRED/);});
 const cold=f.fresh();assert.equal(cold.recoveryBarrier().replayFrames,2);
 noWrites(f,()=>{for(let i=0;i<3;i++)assert.deepEqual(cold.advanceEpochs(command('fence_'+i),['default']),receipts[i]);});
 assert.equal(cold.getReceipt('fence_3'),null);
});

test('retired-epoch receipt retry precedes admission; an unknown expired fence cannot consume a checkpoint',()=>{
 const f=atCap(fixture()),fence=command('retire_default'),receipt=f.writer.advanceEpochs(fence,['next']);
 f.writer.transact(put('new_epoch','app/new',1,0,'next'));assert.equal(f.writer.status().replayFrames,3);
 noWrites(f,()=>{
  assert.deepEqual(f.writer.advanceEpochs(fence,['next']),receipt);
  assert.throws(()=>f.writer.advanceEpochs(command('old_unknown'),['next']),/OP_EXPIRED/);
  assert.throws(()=>f.writer.advanceEpochs(command('next_unknown',[],'next'),['next']),/WRITER_RECOVERY_SETUP_REQUIRED/);
 });
 const cold=f.fresh();cold.recoveryBarrier();assert.deepEqual(cold.getReceipt('retire_default'),receipt);assert.deepEqual(cold.status().acceptedEpochs,['next']);
});

test('import mutations share the cap; known import receipts retry without changing source or store files',()=>{
 const f=runtimeFixture(),config={...f.config,writerLimits:{maxIndexLinks:1,checkpointEvery:2,maxReplayFrames:5}},r=createGasImportRuntime(f.globals,config),source=structuredClone(f.files.get('source'));
 r.locked(()=>{
  r.writer.bootstrap();r.writer.checkpoint(command('last_checkpoint'));
  const input={operationId:'begin_scan',scanId:'scan_1'},receipt=r.store.beginScan(input);assert.equal(r.writer.status().replayFrames,2);
  const creates=f.calls.filter(c=>c[0]==='create').length,files=structuredClone(f.files);
  assert.deepEqual(r.store.beginScan(input),receipt);assert.throws(()=>r.store.beginScan({operationId:'blocked_scan',scanId:'scan_2'}),/WRITER_RECOVERY_SETUP_REQUIRED/);
  assert.equal(f.calls.filter(c=>c[0]==='create').length,creates);assert.deepEqual(f.files,files);
  assert.equal(r.store.getScan('scan_1').scanId,'scan_1');assert.equal(r.writer.getReceipt('blocked_scan'),null);
 });
 const cold=createGasImportRuntime(f.globals,config);cold.locked(()=>{cold.store.recoveryBarrier();assert.equal(cold.store.getScan('scan_1').scanId,'scan_1');});assert.deepEqual(f.files.get('source'),source);
});

test('legacy scheduled checkpoint limit reports setup required and preserves published data',()=>{
 const f=runtimeFixture(),config={...f.config,writerLimits:{maxIndexLinks:1,checkpointEvery:16}},r=createGasImportRuntime(f.globals,config),source=structuredClone(f.files.get('source'));
 r.locked(()=>{r.writer.bootstrap();r.writer.checkpoint(command('last_checkpoint'));});const retained=structuredClone(f.files);
 const options={now:()=>0,limits:{...OWNER_LIMITS,calls:750},settleCalls:128,scheduledPolicy:{sliceMs:60000,rangeBytes:1048576,maxFreshOutputs:8,maxStalls:3,catchUp:true}};
 for(let i=0;i<18;i++){const result=createOwnerScheduler(f.globals,config,options).tick();assert.equal(result.status,'blocked');assert.equal(result.error,'WRITER_RECOVERY_SETUP_REQUIRED');assert.equal(result.requiresOwnerAction,true);}
 const files=structuredClone(f.files);assert.equal(createOwnerScheduler(f.globals,config,options).tick().error,'WRITER_RECOVERY_SETUP_REQUIRED');assert.deepEqual(f.files,files);
 const cold=createGasImportRuntime(f.globals,config);cold.locked(()=>{cold.store.recoveryBarrier();const item=cold.store.listJobsPage({cursor:null,limit:1}).jobs[0],job=cold.store.getJob(item.jobId);assert.equal(job.status,'completed');assert.equal(cold.writer.get(importKeys.run(job.runId)).value.imported.sampleCount,1);});
 for(const [id,file] of retained)assert.deepEqual(f.files.get(id),file,`original file ${id} retained`);assert.deepEqual(f.files.get('source'),source);
 assert.equal([...f.files.values()].filter(x=>x.meta?.appProperties?.['mypace.role']==='checkpoint-index').length,1);
});
