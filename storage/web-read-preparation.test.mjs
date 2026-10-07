import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './scheduled-runtime-fixture.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {prepareWebRead} from './web-read-preparation.mjs';
import {writerDigest} from './reserved-writer.mjs';
import {createOwnerScheduler} from './owner-scheduler.mjs';
import {createImportReader} from './import-reader.mjs';
import {createAppDomain} from '../gas/app-domain.mjs';
const open=(f,extra={})=>createGasImportRuntime(f.globals,{...f.config,protocolReadCache:{mode:'lock-phase'},...extra});
const command=(n)=>({operationId:'op_'+n,digest:writerDigest(n),changes:[{key:'retained',expectedVersion:n,value:n}]});
function parsed(){const f=fixture({rows:130,latency:1000,checkpointHints:true}),r=open(f);r.locked(()=>r.store.registerJob({operationId:'register',jobId:'job',sourceIdentity:f.source}));assert.equal(r.runner.stepJob('job').status,'parsed');return f;}
const immutable=f=>[...f.files].filter(([,v])=>v.meta.appProperties?.['mypace.role']!=='checkpoint-hint').map(([id,v])=>[id,v.bytes?Buffer.from(v.bytes):null]);

test('130-row parsed job reproduces repeated 20s cold starvation, then one preparation removes it',()=>{
 const f=parsed(),source=Buffer.from(f.files.get('source').bytes),original=immutable(f);
 for(let attempt=0;attempt<2;attempt++){const start=f.state.now,r=open(f,{checkBudget:()=>f.state.now-start<20000});assert.throws(()=>r.locked(()=>r.writer.recoveryBarrier()),/STORE_YIELD/);assert.equal(f.state.now-start,20000);assert.deepEqual(immutable(f),original);}
 const start=f.state.now,result=prepareWebRead(open(f,{checkBudget:()=>f.state.now-start<120000}));assert.equal(result.sealed,true);assert.equal(result.storage.replayFrames,1);assert.equal(f.state.now-start,51000);assert.deepEqual(Buffer.from(f.files.get('source').bytes),source);
 for(const action of ['snapshot','imports','importStatus']){const probe=f.state.now,r=open(f,{checkBudget:()=>f.state.now-probe<20000}),reader=createImportReader({runtime:r,sealCursor:JSON.stringify,openCursor:JSON.parse}),domain=createAppDomain({writer:r.writer,locked:r.locked,digest:writerDigest});if(action==='snapshot')domain.snapshot({cursor:null,revision:null});else if(action==='imports')reader.listImportedRuns({cursor:null,revision:null});else reader.status();assert.equal(f.state.now-probe,17000);}
 const verified=open(f);verified.locked(()=>{verified.writer.recoveryBarrier();assert.equal(verified.store.getJob('job').status,'parsed');assert.equal(verified.store.getJob('job').progress.points,130);});
});

test('repeated preparation creates no new immutable history and retains exact operation receipts',()=>{
 const f=parsed(),first=prepareWebRead(open(f)),before=immutable(f),hint=f.files.get('hint').bytes;const again=prepareWebRead(open(f));assert.equal(again.sealed,false);assert.equal(again.storage.headHash,first.storage.headHash);assert.deepEqual(immutable(f),before);
 const r=open(f);r.locked(()=>{r.writer.recoveryBarrier();assert.equal(r.writer.getReceipt('register').revision,1);});
});

test('bounded owner preparations retain verified frame progress across fresh invocations',()=>{
 const f=fixture({latency:1000,checkpointHints:true}),config={writerLimits:{checkpointEvery:64}},r=open(f,config);r.locked(()=>{for(let i=0;i<20;i++)r.writer.transact(command(i));});
 const source=Buffer.from(f.files.get('source').bytes);let prior=0,finished=false,attempts=0;
 for(;attempts<10;attempts++){const start=f.state.now,rt=open(f,{...config,checkBudget:()=>f.state.now-start<120000});try{const result=prepareWebRead(rt);assert.equal(result.storage.replayFrames,1);finished=true;break;}catch(e){assert.equal(e.message,'STORE_YIELD');assert.equal(e.cursorPersisted,true);assert.equal(e.cursorAdvanced,true);assert(e.recoveredRevision>prior);prior=e.recoveredRevision;assert.throws(()=>rt.locked(()=>rt.writer.status()),/RECOVERY_REQUIRED/);}}
 assert(finished);assert(attempts>=1);assert.deepEqual(Buffer.from(f.files.get('source').bytes),source);const cold=open(f);cold.locked(()=>{cold.writer.recoveryBarrier();assert.equal(cold.writer.get('retained').value,19);for(let i=0;i<20;i++)assert(cold.writer.getReceipt('op_'+i));});
});

test('ambiguous checkpoint commit is recovered at the same reserved slot without duplicate sealing',()=>{
 const f=parsed(),create=f.globals.Drive.Files.create;let fault=true;
 f.globals.Drive.Files.create=(meta,blob,options)=>{const r=create(meta,blob,options);if(fault&&meta.appProperties?.['mypace.role']==='checkpoint-index'){fault=false;throw Error('lost response');}return r;};
 const result=prepareWebRead(open(f));assert.equal(result.storage.replayFrames,1);const before=immutable(f);assert.equal(prepareWebRead(open(f)).sealed,false);assert.deepEqual(immutable(f),before);
});

test('manual yielded import seals final saved status inside 120s at slow service latency',()=>{
 for(const latency of [300,750]){const f=fixture({rows:130,latency,checkpointHints:true}),out=createOwnerScheduler(f.globals,f.config,{now:()=>f.state.now}).start();assert.equal(out.status,latency===300?'complete':'retry');if(out.status==='retry')assert.equal(out.errorPersisted,true);assert.equal(out.checkpointReady,true);assert(out.usage.elapsedMs<=120000);assert(out.reservedCalls>=out.usage.calls);const r=open(f);r.locked(()=>{r.writer.recoveryBarrier();assert.equal(r.writer.status().replayFrames,1);const s=r.writer.get('import/owner-scheduler').value;assert.equal(s.status,out.status);assert.equal(s.error,out.error);});}
});

test('post-status sealing failure does not reclassify or lose committed manual result',()=>{
 const f=fixture({rows:130,checkpointHints:true}),create=f.globals.Drive.Files.create;
 f.globals.Drive.Files.create=(m,b,o)=>{if(m.appProperties?.['mypace.role']==='checkpoint-manifest')throw Error('checkpoint unavailable');return create(m,b,o);};
 const out=createOwnerScheduler(f.globals,f.config,{now:()=>f.state.now}).start();assert.equal(out.status,'complete');assert.equal(out.checkpointReady,false);assert.equal(out.requiresOwnerAction,true);assert.equal(out.checkpointError,'WRITER_CREATE_UNRESOLVED');
 f.globals.Drive.Files.create=create;const rt=open(f);rt.locked(()=>{rt.writer.recoveryBarrier();assert.equal(rt.writer.get('import/owner-scheduler').value.status,'complete');assert.equal(rt.store.listJobsPage().jobs[0].status,'completed');});
});


test('manual130-row import remains live at750ms per service call and seals each saved slice',()=>{
 const f=fixture({rows:130,latency:750,checkpointHints:true});let out;
 for(let n=0;n<6;n++){out=createOwnerScheduler(f.globals,f.config,{now:()=>f.state.now})[n===0?'start':'resume']();assert.equal(out.checkpointReady,true);assert(out.usage.elapsedMs<=120000);if(out.status==='complete')break;f.state.now=Math.max(f.state.now+100000,out.retryAt||0);}
 assert.equal(out.status,'complete');assert.equal(out.lastJob.progress.points,130);
});
