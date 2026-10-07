// Independent local fault review. Uses only the in-memory GAS/Drive fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeFixture} from './runtime-fixture.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {createOwnerScheduler,meteredGas,OWNER_LIMITS} from './owner-scheduler.mjs';
import {ReservedSlotWriter} from './reserved-writer.mjs';
import {ImportRunner} from './import-runner.mjs';
import {decodeUtf8} from './codec.mjs';
import {importKeys} from './import-store.mjs';
import {createHash} from 'node:crypto';

const KEY='import/owner-scheduler';
const OPTIONS={now:()=>10000};
function setup(){const f=runtimeFixture();const r=createGasImportRuntime(f.globals,f.config);r.locked(()=>r.writer.bootstrap());return f;}
function tick(f,method='resume',options=OPTIONS){return createOwnerScheduler(f.globals,f.config,options)[method]();}
function inspect(f){const r=createGasImportRuntime(f.globals,f.config);return r.locked(()=>{r.store.recoveryBarrier();const scheduler=r.writer.get(KEY);const jobs=r.store.listJobsPage({limit:100}).jobs.map(j=>r.store.getJob(j.jobId));return {scheduler,jobs,runs:jobs.filter(j=>j.runId).map(j=>r.writer.get(importKeys.run(j.runId))?.value)};});}
function frames(f){return [...f.files.values()].filter(v=>v.meta.appProperties?.['mypace.role']==='frame').map(v=>JSON.parse(decodeUtf8(v.bytes)));}
function schedulerFrames(f){return frames(f).filter(v=>v.payload.changes.some(c=>c.key===KEY));}
function schedulerChange(command){return command.changes?.find(c=>c.key===KEY);}
function patch(object,key,replacement){const original=object[key];object[key]=replacement(original);return ()=>{object[key]=original;};}
function finish(f,result){let clock=10000;for(let n=0;result.status!=='complete'&&n<40;n++){assert.notEqual(result.status,'blocked',JSON.stringify(result));assert.notEqual(result.status,'budget-wait',JSON.stringify(result));clock=Math.max(clock,result.retryAt||0);result=tick(f,'resume',{now:()=>clock});}assert.equal(result.status,'complete',JSON.stringify(result));return result;}
function networkGate(f){let stopped=false,calls=0;const restores=[];for(const [object,key] of [...['get','list','create','generateIds'].map(k=>[f.globals.Drive.Files,k]),[f.globals.UrlFetchApp,'fetch']]){restores.push(patch(object,key,original=>function(...args){calls++;if(stopped)throw Error('REVIEW_PROCESS_TERMINATED');return original.apply(this,args);}));}return {stop:()=>{stopped=true;},calls:()=>calls,restore:()=>restores.reverse().forEach(fn=>fn())};}

test('settlement review: limitRemaining is monotone, counts thrown calls, and cannot reopen a closed meter',()=>{
 const f=setup(),m=meteredGas(f.globals,{...OPTIONS,limits:{...OWNER_LIMITS,calls:10}});
 assert.throws(()=>m.globals.Drive.Files.get('absent'));assert.equal(m.usage().calls,1);
 assert.equal(m.limitRemaining(2),3);assert.equal(m.limitRemaining(9),3);
 for(const invalid of [-1,0.5,NaN,Infinity,'1'])assert.throws(()=>m.limitRemaining(invalid),/OWNER_BUDGET_INVALID/);
 m.globals.Drive.Files.get('source');m.globals.Drive.Files.get('source');
 assert.throws(()=>m.globals.Drive.Files.get('source'),/OWNER_BUDGET_YIELD/);
 assert.equal(m.limitRemaining(99),3);assert.equal(m.usage().calls,3);
 m.close();assert.equal(m.limitRemaining(0),3);assert.throws(()=>m.globals.Drive.Files.get('source'),/OWNER_BUDGET_YIELD/);
});

test('settlement review: successful 16-step invocation has exactly reserve and finish scheduler writes',()=>{
 const f=setup(),out=tick(f,'start'),state=inspect(f),writes=schedulerFrames(f);
 assert.equal(OWNER_LIMITS.steps,16);assert.equal(out.status,'complete');assert.equal(writes.length,2);
 assert.deepEqual(writes.map(v=>v.payload.changes.find(c=>c.key===KEY).entity.version),[1,2]);
 assert.equal(writes[0].payload.changes.find(c=>c.key===KEY).entity.value.buckets[0].calls,OWNER_LIMITS.calls);
 assert.equal(state.scheduler.value.buckets[0].calls,out.reservedCalls);
 assert.ok(out.reservedCalls>=out.usage.calls);assert.ok(out.reservedCalls<OWNER_LIMITS.calls);
 assert.equal(out.reservedRuntimeMs,OWNER_LIMITS.runtimeMs);
 assert.equal(state.jobs.length,1);assert.equal(state.jobs[0].status,'completed');assert.equal(state.runs.length,1);
});

test('settlement review: failure before final transaction commits persists one conservative refund in error state',()=>{
 const f=setup();let tripped=false,proposed;
 const restore=patch(ReservedSlotWriter.prototype,'transact',original=>function(command){const change=schedulerChange(command);if(change?.expectedVersion===1&&!tripped){tripped=true;proposed=structuredClone(change.value);const e=Error('DRIVE_REQUEST_FAILED');e.retryable=true;throw e;}return original.call(this,command);});
 let out;try{out=tick(f,'start');}finally{restore();}
 assert.equal(tripped,true);assert.equal(out.status,'retry');assert.equal(out.errorPersisted,true);
 const persisted=inspect(f).scheduler;assert.equal(persisted.version,2);assert.equal(persisted.value.status,'retry');
 assert.equal(persisted.value.buckets[0].calls,proposed.buckets[0].calls);assert.ok(out.reservedCalls>=out.usage.calls);
 assert.equal(out.reservedRuntimeMs,OWNER_LIMITS.runtimeMs);finish(f,out);assert.equal(inspect(f).runs.length,1);
});

test('settlement review: lost response after final commit retains committed refund and cold status resolves ambiguity',()=>{
 const f=setup();let tripped=false,committed;
 const restore=patch(ReservedSlotWriter.prototype,'transact',original=>function(command){const change=schedulerChange(command),result=original.call(this,command);if(change?.expectedVersion===1&&!tripped){tripped=true;committed=structuredClone(change.value);const e=Error('DRIVE_REQUEST_FAILED');e.retryable=true;throw e;}return result;});
 let out;try{out=tick(f,'start');}finally{restore();}
 assert.equal(tripped,true);assert.equal(out.errorPersisted,false);
 const persisted=inspect(f).scheduler;assert.equal(persisted.version,2);assert.equal(persisted.value.status,'complete');
 assert.equal(persisted.value.buckets[0].calls,committed.buckets[0].calls);assert.ok(persisted.value.buckets[0].calls>=out.usage.calls);
 assert.equal(tick(f).status,'complete');assert.equal(schedulerFrames(f).length,2);assert.equal(inspect(f).runs.length,1);
});

for(const commitFirst of [false,true])test(`settlement review: exhausting final 256-call ceiling ${commitFirst?'after':'before'} commit never spends beyond durable reservation`,()=>{
 const f=setup();let tripped=false,proposed;
 const restore=patch(ReservedSlotWriter.prototype,'transact',original=>function(command){const change=schedulerChange(command);if(change?.expectedVersion===1&&!tripped){tripped=true;proposed=structuredClone(change.value);if(commitFirst)original.call(this,command);while(true)this.io.Drive.Files.get('source');}return original.call(this,command);});
 let out;try{out=tick(f,'start');}finally{restore();}
 assert.equal(tripped,true);assert.equal(out.error,'OWNER_BUDGET_YIELD');assert.equal(out.errorPersisted,false);
 const state=inspect(f);assert.equal(out.usage.calls,proposed.buckets[0].calls);
 assert.equal(state.scheduler.version,commitFirst?2:1);
 assert.equal(state.scheduler.value.buckets[0].calls,commitFirst?proposed.buckets[0].calls:OWNER_LIMITS.calls);
 assert.ok(state.scheduler.value.buckets[0].calls>=out.usage.calls);assert.equal(state.scheduler.value.buckets[0].ms,OWNER_LIMITS.runtimeMs);
 finish(f,tick(f));assert.equal(inspect(f).runs.length,1);
});

for(const commitFirst of [false,true])test(`settlement review: final frame create interruption ${commitFirst?'after':'before'} storage preserves safe cold recovery`,()=>{
 const f=setup(),gate=networkGate(f);let tripped=false,proposal;
 const restore=patch(f.globals.Drive.Files,'create',original=>function(meta,blob,...rest){
  if(meta.appProperties?.['mypace.role']==='frame'){
   const frame=JSON.parse(decodeUtf8(blob.bytes)),change=frame.payload.changes.find(c=>c.key===KEY);
   if(change?.expectedVersion===1&&!tripped){tripped=true;proposal=change.entity.value;if(commitFirst)original.call(this,meta,blob,...rest);gate.stop();throw Error('REVIEW_LOST_COMMIT_RESPONSE');}
  }
  return original.call(this,meta,blob,...rest);
 });
 let out;try{out=tick(f,'start');}finally{restore();gate.restore();}
 assert.equal(tripped,true);assert.equal(out.errorPersisted,false);
 const state=inspect(f);assert.equal(state.scheduler.version,commitFirst?2:1);
 assert.equal(state.scheduler.value.buckets[0].calls,commitFirst?proposal.buckets[0].calls:OWNER_LIMITS.calls);
 assert.ok(state.scheduler.value.buckets[0].calls>=out.usage.calls);
 finish(f,tick(f));assert.equal(inspect(f).runs.length,1);
});

for(const point of ['scan-registration','parsed-checkpoint','published-job'])test(`settlement review: hard stop after ${point} leaves full reservation and safely replays stale scheduler cursor`,()=>{
 const f=setup(),gate=networkGate(f);let tripped=false;
 const method=point==='scan-registration'?'stepScan':point==='parsed-checkpoint'?'stepJob':'finalizeJobStep';
 const restore=patch(ImportRunner.prototype,method,original=>function(...args){const result=original.apply(this,args);const hit=point==='scan-registration'?this.store.listJobsPage().jobs.length>0:point==='parsed-checkpoint'?result.status==='parsed':this.store.getJob(args[0]).status==='completed';if(hit&&!tripped){tripped=true;gate.stop();}return result;});
 let out;try{out=tick(f,'start');}finally{restore();gate.restore();}
 assert.equal(tripped,true);assert.equal(out.errorPersisted,false);
 const before=inspect(f);assert.equal(before.scheduler.version,1);assert.equal(before.scheduler.value.status,'scanning');assert.equal(before.scheduler.value.cursor,null);
 assert.equal(before.scheduler.value.buckets[0].calls,OWNER_LIMITS.calls);assert.equal(before.scheduler.value.buckets[0].ms,OWNER_LIMITS.runtimeMs);
 assert.equal(before.jobs.length,1);assert.equal(before.jobs[0].status,point==='scan-registration'?'active':point==='parsed-checkpoint'?'parsed':'completed');
 const existingAssets=[...f.files.values()].filter(v=>['output','checkpoint','manifest-page'].includes(v.meta.appProperties?.['mypace.role'])).map(v=>v.meta.id).sort();
 finish(f,tick(f));const after=inspect(f);assert.equal(after.jobs.length,1);assert.equal(after.jobs[0].status,'completed');assert.equal(after.runs.length,1);assert.equal(after.runs[0].imported.sampleCount,1);
 if(point!=='scan-registration')assert.deepEqual([...f.files.values()].filter(v=>['output','checkpoint','manifest-page'].includes(v.meta.appProperties?.['mypace.role'])).map(v=>v.meta.id).sort(),existingAssets);
});

test('settlement review: non-null multi-job cursor replay neither skips the interrupted job nor republishes an earlier checkpoint',()=>{
 const f=setup(),originalSource=f.files.get('source');
 const bytes=new TextEncoder().encode(decodeUtf8(originalSource.bytes).replace(',1,2',',3,4'));
 const second={meta:{...structuredClone(f.source),id:'source_second',name:'fixture-second.csv',size:String(bytes.length),md5Checksum:createHash('md5').update(bytes).digest('hex')},bytes};
 f.files.set(second.meta.id,second);f.globals.Drive.Files.list=()=>({files:[structuredClone(f.source),structuredClone(second.meta)]});
 const options={...OPTIONS,limits:{...OWNER_LIMITS,steps:1}};
 let out=tick(f,'start',options);
 for(let n=0;out.status==='scanning'&&n<10;n++)out=tick(f,'resume',options);
 assert.equal(out.status,'importing');out=tick(f,'resume',options);
 assert.equal(out.status,'importing');assert.ok(out.nextJob);
 const replayCursor=out.nextJob,before=inspect(f);assert.equal(before.jobs.length,2);
 assert.equal(before.jobs.filter(j=>j.status==='parsed').length,1);
 const gate=networkGate(f);let tripped=false;
 const restore=patch(ImportRunner.prototype,'stepJob',original=>function(jobId,...args){const result=original.call(this,jobId,...args);assert.equal(jobId,replayCursor);assert.equal(result.status,'parsed');tripped=true;gate.stop();return result;});
 try{out=tick(f);}finally{restore();gate.restore();}
 assert.equal(tripped,true);assert.equal(out.errorPersisted,false);
 const interrupted=inspect(f);assert.equal(interrupted.scheduler.value.cursor,replayCursor);
 assert.equal(interrupted.jobs.filter(j=>j.status==='parsed').length,2);
 const checkpoints=[...f.files.values()].filter(v=>v.meta.appProperties?.['mypace.role']==='checkpoint').map(v=>v.meta.id).sort();
 finish(f,tick(f));const completed=inspect(f);
 assert.equal(completed.jobs.length,2);assert.equal(completed.jobs.filter(j=>j.status==='completed').length,2);
 assert.equal(completed.runs.length,2);assert.equal(new Set(completed.jobs.map(j=>j.runId)).size,2);
 assert.deepEqual([...f.files.values()].filter(v=>v.meta.appProperties?.['mypace.role']==='checkpoint').map(v=>v.meta.id).sort(),checkpoints);
});
