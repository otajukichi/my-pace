import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeFixture} from './runtime-fixture.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {createOwnerScheduler,OWNER_LIMITS} from './owner-scheduler.mjs';
import {ImportCheckpointCoordinator} from './immutable-assets.mjs';
import {decodeUtf8} from './codec.mjs';
import {writerDigest} from './reserved-writer.mjs';

function setup(){const f=runtimeFixture();const r=createGasImportRuntime(f.globals,f.config);r.locked(()=>r.writer.bootstrap());return f;}
function tick(f,method='resume',options={}){return createOwnerScheduler(f.globals,f.config,options)[method]();}
function inspect(f){const r=createGasImportRuntime(f.globals,f.config);return r.locked(()=>{r.store.recoveryBarrier();return {scheduler:r.writer.get('import/owner-scheduler')?.value,jobs:r.store.listJobsPage({limit:100}).jobs.map(j=>r.store.getJob(j.jobId))};});}
function finish(f,result,options={}){let n=0;while(result.status!=='complete'&&n++<30){assert.notEqual(result.status,'blocked',JSON.stringify(result));assert.notEqual(result.status,'budget-wait',JSON.stringify(result));result=tick(f,'resume',options);}assert.equal(result.status,'complete',JSON.stringify(result));return result;}

for(const throttle of [429,403])test(`review: exhausted temporary Drive ${throttle} throttle remains resumable with bounded backoff`,()=>{
 const f=setup();let clock=Date.now(),attempts=0;const list=f.globals.Drive.Files.list;
 f.globals.Drive.Files.list=()=>{attempts++;const e=Error('temporary');e.code=throttle;if(throttle===403)e.errors=[{reason:'rateLimitExceeded'}];throw e;};
 const out=tick(f,'start',{now:()=>clock});
 assert.equal(attempts,3);assert.equal(out.error,'RETRY_EXHAUSTED');
 assert.equal(out.status,'retry');assert.equal(out.errorPersisted,true);assert(out.retryAt>clock);
 f.globals.Drive.Files.list=list;clock=out.retryAt;
 finish(f,tick(f,'resume',{now:()=>clock}),{now:()=>clock});
});

test('review: caller-owned coordinator lock is neither reacquired nor released on success or throw',()=>{
 let acquired=0,released=0;const lock={hasLock:()=>true,tryLock:()=>{acquired++;return false;},releaseLock:()=>{released++;}};
 const writer={recoveryBarrier(){},getReceipt(){},validateImportBatch(){},commitImportBatch(){}};
 const coordinator=new ImportCheckpointCoordinator({writer,assets:{putOnce(){},verify(){}},getScriptLock:()=>lock,validateSourceCurrent:()=>true,checkBudget:()=>true});
 assert.equal(coordinator._locked(()=>17),17);
 assert.throws(()=>coordinator._locked(()=>{throw Error('test-fault');}),/test-fault/);
 assert.equal(acquired,0);assert.equal(released,0);assert.equal(lock.hasLock(),true);
});

test('review: lost scheduler recovery after durable job registration does not skip or duplicate scan entry',()=>{
 const f=setup();const create=f.globals.Drive.Files.create,fetch=f.globals.UrlFetchApp.fetch;let fail=false,tripped=false;
 f.globals.Drive.Files.create=(m,b,o)=>{const result=create(m,b,o);if(m.appProperties?.['mypace.role']==='frame'){
  const frame=JSON.parse(decodeUtf8(b.bytes));if(!tripped&&frame.payload.result?.status==='active'){fail=true;tripped=true;}
 }return result;};
 f.globals.UrlFetchApp.fetch=(...args)=>{if(fail)throw Error('terminated after registration');return fetch(...args);};
 const out=tick(f,'start');assert.equal(tripped,true);assert.equal(out.errorPersisted,false);
 fail=false;const state=inspect(f);assert.equal(state.jobs.length,1);assert.equal(state.jobs[0].status,'active');
 finish(f,tick(f));assert.equal(inspect(f).jobs.length,1);assert.equal(inspect(f).jobs[0].status,'completed');
});

test('review: owner source restart cancels only pending generation and permits a fresh scan',()=>{
 const f=setup(),options={limits:{...OWNER_LIMITS,steps:1}};
 let out=tick(f,'start',options);while(out.status==='scanning')out=tick(f,'resume',options);
 const old=inspect(f).jobs[0];f.source.version='2';out=tick(f);
 assert.equal(out.status,'blocked');assert.equal(out.error,'SOURCE_CHANGED');
 const before=Uint8Array.from(f.files.get('source').bytes);out=tick(f,'restartChangedSource');assert.equal(out.status,'idle');
 const cancelled=inspect(f).jobs.find(j=>j.jobId===old.jobId);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.pinActive,false);
 const nextWindow={now:()=>Date.now()+26*3600000};
 finish(f,tick(f,'start',nextWindow),nextWindow);const jobs=inspect(f).jobs;assert.equal(jobs.length,2);assert.equal(jobs.filter(j=>j.status==='completed').length,1);
 assert.equal(jobs.find(j=>j.status==='completed').sourceIdentity.version,'2');assert.deepEqual(f.files.get('source').bytes,before);
 assert.equal(f.calls.filter(c=>c[0]==='create'&&c[1]==='source').length,0);
});

test('review: ordinary permission 403 remains owner-blocked without retrying',()=>{
 const f=setup();let attempts=0;f.globals.Drive.Files.list=()=>{attempts++;const e=Error('forbidden');e.code=403;throw e;};
 const out=tick(f,'start');assert.equal(attempts,1);assert.equal(out.status,'blocked');assert.equal(out.error,'FORBIDDEN');assert.equal(out.retryAt,0);
});

test('review: status repairs only a pre-existing mandatory publication, without starting import',()=>{
 const f=setup(),r=createGasImportRuntime(f.globals,f.config);
 const indexId=r.locked(()=>r.writer.readBootstrap().firstIndexId),create=f.globals.Drive.Files.create;
 f.globals.Drive.Files.create=(m,b,o)=>{if(m.appProperties?.['mypace.role']==='checkpoint-index')throw Error('publication interrupted');return create(m,b,o);};
 assert.throws(()=>r.locked(()=>r.writer.checkpoint({operationId:'review_checkpoint',digest:writerDigest('review_checkpoint'),changes:[]})),/CREATE_UNRESOLVED/);
 assert.equal(f.files.has(indexId),false);f.globals.Drive.Files.create=create;
 const before=f.calls.filter(c=>c[0]==='create').length;assert.equal(tick(f,'status').status,'idle');
 assert.equal(f.files.has(indexId),true);assert.equal(f.calls.filter(c=>c[0]==='create').length,before+1);
 assert.equal(inspect(f).scheduler,undefined);assert.equal(inspect(f).jobs.length,0);
});
