import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {createScheduledImportRuntime,SCHEDULED_OWNER_EMAIL,SCHEDULED_DEFAULTS} from './scheduled-runtime.mjs';
import {runtimeFixture} from './runtime-fixture.mjs';import {createGasImportRuntime} from './gas-import-runtime.mjs';import {createOwnerScheduler,OWNER_LIMITS,meteredGas} from './owner-scheduler.mjs';import {OWNER_STORE_PROPERTY,OWNER_BOOTSTRAP_PROTOCOL} from './owner-bootstrap.mjs';import {importKeys} from './import-store.mjs';
import {execFileSync} from 'node:child_process';
import {ownerBootstrapFixture} from './owner-bootstrap-fixture.mjs';
import {fixture,finish,clockEvent,csv} from './scheduled-runtime-fixture.mjs';
test('scheduled boundary is inert on construction and accepts absent active identity for a verified owner clock event',()=>{const f=fixture(),before=f.state.serviceCalls;createScheduledImportRuntime(f.globals);assert.equal(f.state.serviceCalls,before);assert.equal(f.state.reads,0);const out=f.tick();assert.equal(out.scanId,'owner_scan_1');assert.equal(f.state.writes,0);});
test('missing, wrong-kind and malformed clock events fail before properties or Drive',()=>{for(const event of [undefined,null,{}, {triggerUid:'1',authMode:'FULL'}, {...clockEvent(),authMode:'LIMITED'}, {...clockEvent(),triggerUid:'bad'}, {...clockEvent(),year:'2026'}, {...clockEvent(),postData:{}}, {...clockEvent(),parameter:{}}]){const f=fixture();assert.throws(()=>createScheduledImportRuntime(f.globals,{now:()=>f.state.now}).tick(event),/SCHEDULED_EVENT_REQUIRED/);assert.equal(f.state.serviceCalls,0);assert.equal(f.state.reads,0);}});
test('forged event does not authenticate missing/wrong effective owner or conflicting active owner',()=>{for(const state of [{effective:''},{effective:'attacker@example.com'},{active:'attacker@example.com'}]){const f=fixture();Object.assign(f.state,state);assert.throws(()=>f.tick(),/SCHEDULED_OWNER_UNVERIFIED/);assert.equal(f.state.serviceCalls,0);assert.equal(f.state.reads,0);}});
test('wrong script, owner pin, missing/invalid config and wrong dataset fail before Drive',()=>{for(const mutation of [f=>f.state.script='wrong_script',f=>f.properties.delete(OWNER_STORE_PROPERTY),f=>f.properties.set(OWNER_STORE_PROPERTY,'invalid'),f=>f.properties.set(OWNER_STORE_PROPERTY,JSON.stringify({...f.config,ownerEmail:'other@example.com'})),f=>f.properties.set(OWNER_STORE_PROPERTY,JSON.stringify({...f.config,datasetGeneration:'2'})),f=>f.properties.set(OWNER_STORE_PROPERTY,JSON.stringify({...f.config,storeId:'other'}))]){const f=fixture();mutation(f);assert.throws(()=>f.tick(),/OWNER_BOOTSTRAP_/);assert.equal(f.state.serviceCalls,0);}});
test('configuration limits cannot be supplied through event fields or exceed reviewed bounds',()=>{const f=fixture();for(const options of [{sliceMs:29999},{sliceMs:60001},{calls:1001},{rangeBytes:1048577},{steps:5},{scanIntervalMs:1},{ownerEmail:'other@example.com'},{catchUp:'yes'}])assert.throws(()=>createScheduledImportRuntime(f.globals,options),/SCHEDULED_CONFIG_INVALID/);const out=f.tick({}, {...clockEvent(),sliceMs:900000,storeId:'attack',method:'restartChangedSource'});assert.equal(out.scanId,'owner_scan_1');assert.equal(out.reservedRuntimeMs,SCHEDULED_DEFAULTS.sliceMs);});
test('completed sweep waits without writes; due unchanged reconciliation keeps the completed generation',()=>{const f=fixture();const results=finish(f),done=results.at(-1);assert.equal(done.scanId,'owner_scan_1');const files=f.files.size;const idle=f.tick();assert.equal(idle.status,'complete');assert.equal(idle.scanId,done.scanId);assert.equal(f.files.size,files);assert.equal(idle.nextScanAt,idle.completedAt+3600000);f.state.now=idle.nextScanAt;const unchanged=f.tick();assert.equal(unchanged.scanId,done.scanId);assert.equal(unchanged.reconciliation,'unchanged');assert.equal(f.state.writes,0);});
for(const latency of [100,300])test(`real composed cold scheduler makes bounded progress and publishes dense256KiB at${latency}ms/service call`,()=>{const rows=10500,f=fixture({rows,latency});const results=finish(f,{catchUp:false});assert(results.some(x=>(x.lastJob?.progress?.offset||0)>0));assert(results.every(x=>x.usage.elapsedMs<=60000&&x.usage.calls<=750),JSON.stringify(results));assert.equal(f.inspect()[0].status,'completed');assert.equal(f.inspect()[0].progress.points,rows);assert.equal(f.state.writes,0);assert.equal(f.calls.filter(c=>c[0]==='create'&&c[1]==='source').length,0);console.log(JSON.stringify({model:'scheduled-dense256KiB',latency,invocations:results.length,calls:results.reduce((n,r)=>n+r.usage.calls,0),maximumMs:Math.max(...results.map(r=>r.usage.elapsedMs))}));});
test('30s slice supports bounded progress at100ms/service call',()=>{const f=fixture({rows:1500,latency:100});const results=finish(f,{sliceMs:30000,rangeBytes:16384,catchUp:false});assert(results.every(r=>r.usage.elapsedMs<=30000));assert.equal(f.inspect()[0].progress.points,1500);});
function reserveManual(f){
 let out;do{out=createOwnerScheduler(f.globals,f.config,{now:()=>f.state.now,limits:{...OWNER_LIMITS,steps:1}}).tick();f.advance(out);}while(out.status==='scanning');
 let budget=true;const r=createGasImportRuntime(f.globals,{...f.config,checkBudget:()=>budget});
 r.locked(()=>{r.store.recoveryBarrier();const job=r.store.listJobsPage().jobs[0],reserve=r.store.reserveBatch.bind(r.store);r.store.reserveBatch=(...a)=>{const v=reserve(...a);budget=false;return v;};assert.throws(()=>r.runner.stepJob(job.jobId),/IMPORT_YIELD/);});
 return f.inspect()[0];
}
for(const latency of [100,300])test(`hint-enabled dense1MiB manual reservation completes at${latency}ms with exact pins/range`,()=>{
 const f=fixture({rows:41942,checkpointHints:true});const before=reserveManual(f),pinned=before.pending;assert(pinned);
 for(const method of ['get','list','create','generateIds']){const fn=f.globals.Drive.Files[method];f.globals.Drive.Files[method]=(...a)=>{f.state.now+=latency;return fn(...a);};}
 const fetch=f.globals.UrlFetchApp.fetch;f.globals.UrlFetchApp.fetch=(...a)=>{f.state.now+=latency;return fetch(...a);};
 const results=[];for(let i=0;i<40;i++){const out=f.tick();results.push(out);if(['complete','blocked'].includes(out.status))break;f.advance(out);}
 const final=results.at(-1),job=f.inspect()[0];assert(results.every(r=>r.usage.elapsedMs<=120000));
 assert.equal(final.status,'complete');
 if(final.status==='complete'){assert.equal(job.status,'completed');assert.equal(job.progress.points,41942);assert.equal(job.firstPin,pinned);}
 else{assert.equal(final.status,'blocked');assert.equal(final.error,'SCHEDULED_NO_PROGRESS');assert.equal(final.requiresOwnerAction,true);assert.equal(job.pending,pinned);assert.equal(job.pinActive,true);const size=f.files.size;assert.equal(f.tick().status,'blocked');assert.equal(f.files.size,size);}
 assert.equal(f.state.writes,0);console.log(JSON.stringify({model:'manual1MiB-to-scheduled',latency,status:final.status,invocations:results.length,maximumMs:Math.max(...results.map(r=>r.usage.elapsedMs))}));
});
test('three unchanged fallback attempts stop with actionable status and unchanged pins',()=>{const f=fixture({rows:41942});const before=reserveManual(f);const sourceRead=f.globals.UrlFetchApp.fetch;f.globals.UrlFetchApp.fetch=(url,options)=>{if(url.includes('/source?')&&url.includes('alt=media'))return {getResponseCode:()=>429,getContentText:()=>'{}',getContent:()=>new Uint8Array(),getAllHeaders:()=>({'Retry-After':'1'})};return sourceRead(url,options);};for(let i=0;i<3;i++){const out=f.tick();assert.equal(out.status,'retry',JSON.stringify(out));assert.equal(out.scheduledFallback.attempts,i+1);f.advance(out);}const size=f.files.size;const out=f.tick();assert.equal(out.status,'blocked');assert.equal(out.error,'SCHEDULED_NO_PROGRESS');assert.equal(out.requiresOwnerAction,true);assert(f.files.size>size);assert.equal(f.inspect()[0].pending,before.pending);assert.equal(f.state.writes,0);});
test('runtime allowance selection cannot exceed original absolute deadline or expand closing budget',()=>{const f=fixture();const m=meteredGas(f.globals,{now:()=>f.state.now,deadlineMs:90000,reserveMs:15000});m.setRuntimeMs(60000);assert.equal(m.hardDeadlineMs,60000);m.setRuntimeMs(120000);assert.equal(m.hardDeadlineMs,90000);assert.throws(()=>m.setRuntimeMs(120001),/OWNER_BUDGET_INVALID/);m.limitRemaining(1);assert.throws(()=>m.setRuntimeMs(60000),/OWNER_BUDGET_INVALID/);});
test('scheduled entry is a single closed fixed dispatch with no installer or web route',()=>{const code=fs.readFileSync(new URL('scheduled-entry.gs',import.meta.url),'utf8');assert(!/newTrigger|getProjectTriggers|deleteTrigger|doGet\s*\(|doPost\s*\(/.test(code));const calls=[];const context={MyPaceFolderImport:{createScheduledImportRuntime:(globals,options)=>({tick:event=>{calls.push({globals,options,event});return {status:'complete'};}})},myPaceOwnerGlobals_:()=>({safe:true}),myPaceOwnerReport_:x=>x};vm.createContext(context);vm.runInContext(code,context);assert.equal(calls.length,0);const event=clockEvent();assert.equal(context.MyPaceImportScheduledTick(event).status,'complete');assert.equal(calls.length,1);assert.equal(calls[0].event,event);assert(!JSON.parse(fs.readFileSync(new URL('gas/appsscript.json',import.meta.url))).oauthScopes.some(x=>x.endsWith('/script.scriptapp')));});

test('fresh high-density ranges adapt to eight outputs without skipping the downloaded suffix',()=>{
 const f=fixture({rows:41942}),r=createGasImportRuntime(f.globals,{...f.config,maxFreshOutputs:8,finalizationBatchLimit:1,protocolReadCache:{mode:'lock-phase'}});let first;
 r.locked(()=>{r.store.registerJob({operationId:'adaptive-register',jobId:'adaptive',sourceIdentity:f.source});first=r.runner.stepJob('adaptive');const job=r.store.getJob('adaptive');const pin=r.writer.get(importKeys.pin(job.lastPin)).value;assert(pin.assets.filter(a=>a.role==='output').length<=8);assert(first.offset>0&&first.offset<1048576);});
 let out=first;while(out.status!=='parsed')out=r.runner.stepJob('adaptive');
 const job=r.locked(()=>r.store.getJob('adaptive'));assert.equal(job.progress.offset,Number(f.source.size));assert.equal(job.progress.points,41942);
});
test('new core bounds reject invalid finalization, fresh-output and scheduler policies',()=>{
 const f=fixture();for(const v of [0,5,1.5])assert.throws(()=>createGasImportRuntime(f.globals,{...f.config,finalizationBatchLimit:v}),/RUNNER_FINALIZATION_CONFIG/);
 for(const v of [0,65,1.5])assert.throws(()=>createGasImportRuntime(f.globals,{...f.config,maxFreshOutputs:v}),/RUNNER_OUTPUT_CONFIG/);
 for(const v of [0,257,1.5])assert.throws(()=>createOwnerScheduler(f.globals,f.config,{settleCalls:v}),/OWNER_SETTLE_CALLS_INVALID/);
 for(const v of [{sliceMs:29999,rangeBytes:1048576,maxFreshOutputs:8,maxStalls:3},{sliceMs:60000,rangeBytes:1048576,maxFreshOutputs:0,maxStalls:3},{sliceMs:60000,rangeBytes:1048576,maxFreshOutputs:8,maxStalls:4}])assert.throws(()=>createOwnerScheduler(f.globals,f.config,{scheduledPolicy:v}),/OWNER_SCHEDULED_POLICY_INVALID/);
});
test('scheduled retry backoff and rolling allowance prevent new reservations, retaining source pins',()=>{
 const f=fixture({rows:41942});reserveManual(f);const sourceRead=f.globals.UrlFetchApp.fetch;f.globals.UrlFetchApp.fetch=(url,options)=>url.includes('/source?')&&url.includes('alt=media')?{getResponseCode:()=>429,getContentText:()=>'{}',getContent:()=>new Uint8Array(),getAllHeaders:()=>({'Retry-After':'1'})}:sourceRead(url,options);
 const failed=f.tick();assert.equal(failed.status,'retry');const before=f.files.size,calls=failed.reservedCalls,pin=f.inspect()[0].pending;const deferred=f.tick();assert.equal(deferred.status,'retry');assert.equal(deferred.reservedCalls,calls);assert.equal(f.files.size,before);assert.equal(f.inspect()[0].pending,pin);
 f.globals.UrlFetchApp.fetch=sourceRead;f.advance(failed);const r=createGasImportRuntime(f.globals,f.config);r.locked(()=>{r.store.recoveryBarrier();const entry=r.writer.get('import/owner-scheduler'),value=entry.value;value.buckets=[{hour:Math.floor(f.state.now/3600000),calls:15999,ms:0}];r.writer.transact({operationId:'test-budget',epoch:'default',digest:'a'.repeat(64),changes:[{key:'import/owner-scheduler',expectedVersion:entry.version,value}],result:{}});});
 const waiting=f.tick();assert.equal(waiting.status,'budget-wait');assert.equal(waiting.reservedCalls,15999);assert.equal(f.inspect()[0].pending,pin);
});
test('complete generated owner kit includes guarded clock entry and performs no IO on load',()=>{
 execFileSync(process.execPath,['build-gas.mjs'],{cwd:new URL('.',import.meta.url)});
 const f=ownerBootstrapFixture({active:SCHEDULED_OWNER_EMAIL,effective:SCHEDULED_OWNER_EMAIL}),source=runtimeFixture();f.files.set('source',source.files.get('source'));
 f.globals.ScriptApp.AuthMode={FULL:'FULL'};f.globals.Drive.Files.list=()=>({files:[structuredClone(source.source)]});
 f.globals.Drive.Files.get=id=>{const file=f.files.get(id);if(!file){const e=Error();e.code=404;throw e;}return structuredClone(file.meta);};
 const context={...f.globals,console:{log:()=>{}}};vm.createContext(context);vm.runInContext(fs.readFileSync(new URL('gas/OwnerImportKit.gs',import.meta.url),'utf8'),context);assert.equal(f.events.length,0);
 context.MyPaceImportBootstrap();const writes=f.events.filter(e=>e[0]==='property-write').length;f.state.active='';let out;
 for(let n=0;n<10;n++){out=context.MyPaceImportScheduledTick(clockEvent());if(out.status==='complete')break;}
 assert.equal(out.status,'complete',JSON.stringify(out));assert.equal(out.lastJob.progress.points,1);assert.equal(f.events.filter(e=>e[0]==='property-write').length,writes);assert.equal(context.doGet,undefined);assert.equal(context.doPost,undefined);
 f.state.effective='attacker@example.com';const count=f.events.length;assert.throws(()=>context.MyPaceImportScheduledTick(clockEvent()),/SCHEDULED_OWNER_UNVERIFIED/);assert.equal(f.events.length,count);
});
test('mutable hint updates are counted and stop at the same live request ceiling',()=>{const f=fixture();let updates=0;f.globals.Drive.Files.update=()=>{updates++;return {id:'hint'};};const meter=meteredGas(f.globals,{limits:{...OWNER_LIMITS,calls:1}});meter.globals.Drive.Files.update({},'hint',{});assert.equal(updates,1);assert.equal(meter.usage().calls,1);assert.throws(()=>meter.globals.Drive.Files.update({},'hint',{}),/OWNER_BUDGET_YIELD/);assert.equal(updates,1);});
test('pinned checkpoint hint uses only owner-managed secret and falls back when it is missing',()=>{
 const f=fixture({checkpointHints:true});const secret=f.properties.get('MYPACE_WRITER_SECRET');const done=finish(f).at(-1);assert.equal(done.status,'complete');assert(!JSON.stringify(done).includes(secret));assert(f.files.has('hint'));
 const noSecret=fixture({checkpointHints:true});noSecret.properties.delete('MYPACE_WRITER_SECRET');assert.doesNotThrow(()=>noSecret.tick());
 const invalid=fixture({checkpointHints:true});invalid.properties.set('MYPACE_WRITER_SECRET','short');assert.throws(()=>invalid.tick(),/CHECKPOINT_HINT_AUTH_REQUIRED/);assert.equal(invalid.state.serviceCalls,0);
 const denied=fixture({checkpointHints:true});denied.state.effective='attacker@example.com';assert.throws(()=>denied.tick(),/SCHEDULED_OWNER_UNVERIFIED/);assert.equal(denied.state.reads,0);
});
test('scheduled ticks seal a fresh quiescent cut so cold readers replay at most two frames',()=>{
 const f=fixture({rows:17000,checkpointHints:true});let result;
 for(let n=0;n<20;n++){
  result=f.tick();assert.notEqual(result.status,'blocked');
  if(result.errorPersisted!==false){const cold=createGasImportRuntime(f.globals,f.config);const status=cold.locked(()=>{cold.store.recoveryBarrier();return cold.writer.status();});assert(status.replayFrames<=2,JSON.stringify(status));}
  if(result.status==='complete')break;f.advance(result);
 }
 assert.equal(result.status,'complete');assert.equal(result.error,null);
});
test('scheduled work reserves closing calls before the hard call cap',()=>{
 const f=fixture(),meter=meteredGas(f.globals,{limits:{...OWNER_LIMITS,calls:3},reserveCalls:1});
 meter.globals.Drive.Files.get('source');meter.globals.Drive.Files.get('source');assert.throws(()=>meter.globals.Drive.Files.get('source'),/OWNER_BUDGET_YIELD/);
 assert.equal(meter.limitRemaining(1),3);meter.globals.Drive.Files.get('source');assert.equal(meter.usage().calls,3);assert.throws(()=>meter.globals.Drive.Files.get('source'),/OWNER_BUDGET_YIELD/);
});
