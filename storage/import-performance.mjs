// Local synthetic performance evidence. No network or real source data.
import assert from 'node:assert/strict';
import {runtimeFixture} from './runtime-fixture.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {createOwnerScheduler,OWNER_LIMITS} from './owner-scheduler.mjs';
import {LIMITS} from './bounded-import.mjs';
import {importKeys} from './import-store.mjs';

export function measureColdOwnerImport({minimumBytes=0,rows=1,sensor=false,allowRollingWait=false,onInvocation=()=>{},writerLimits,serviceLatencyMs=0}={}){
 const header=sensor?'# sensor:multi_record\ntime,gFx,gFy,gFz,ax,ay,az,wx,wy,wz,P(Pa),Bx(µT),By(µT),Bz(µT),latitude,longitude,altitude,speed,yaw,pitch,roll\n':'# sensor:multi_record\ntime,latitude,longitude\n',row=sensor?'2026-01-01T00:00:00Z,'+Array.from({length:20},(_,i)=>i===9?'101325.123':i===13?'35.123456':i===14?'139.12345':i===15?'123.45678':i===16?'1.2345678':'0.123456').join(',')+'\n':'2026-01-01T00:00:00Z,1,2\n';
 rows=Math.max(rows,Math.ceil((minimumBytes-header.length)/row.length));
 const f=runtimeFixture(header+row.repeat(rows));if(writerLimits)f.config.writerLimits=writerLimits;const setup=createGasImportRuntime(f.globals,f.config);
 setup.locked(()=>setup.writer.bootstrap());
 let now=0,result;const invocations=[];
 assert(Number.isSafeInteger(serviceLatencyMs)&&serviceLatencyMs>=0);
 if(serviceLatencyMs){const cost=fn=>(...args)=>{now+=serviceLatencyMs;return fn(...args);};for(const method of ['get','list','create','generateIds'])f.globals.Drive.Files[method]=cost(f.globals.Drive.Files[method]);f.globals.UrlFetchApp.fetch=cost(f.globals.UrlFetchApp.fetch);}
 // One newly constructed scheduler/runtime per invocation; durable simulated
 // Drive is the only shared state. Clock has zero network latency by design.
 for(let n=0;n<(allowRollingWait?1000:12);n++){
  const scheduler=createOwnerScheduler(f.globals,f.config,{now:()=>now});const invocationStart=Date.now();
  result=scheduler[n===0?'start':'resume']();
  invocations.push({status:result.status,calls:result.usage.calls,error:result.error,errorPersisted:result.errorPersisted??null,reservedCalls:result.reservedCalls,modeledElapsedMs:result.usage.elapsedMs,localWallMs:Date.now()-invocationStart,offset:result.lastJob?.progress?.offset??0});
  onInvocation(invocations.at(-1));
  if(!allowRollingWait){assert.equal(result.error,null,JSON.stringify(result));assert.notEqual(result.status,'budget-wait','Representative import exceeds conservative rolling reservation');assert(result.usage.calls<OWNER_LIMITS.calls,'Representative invocation hit call cap');}
  else {assert.notEqual(result.status,'blocked',JSON.stringify(result));assert(result.usage.calls<=OWNER_LIMITS.calls);}
  if(result.status==='complete')break;
  now=result.status==='budget-wait'?result.retryAt:Math.max(now+100000,result.retryAt||0);
 }
 assert.equal(result.status,'complete','Representative import did not finish in bounded invocation count');
 const importFinishedAt=now;
 const cold=createGasImportRuntime(f.globals,f.config);let coldRecovery;
 const verificationStart=Date.now(),verificationLogStart=f.calls.length;
 const run=cold.locked(()=>{
  const start=Date.now(),logStart=f.calls.length;cold.writer.recoveryBarrier();
  coldRecovery={requests:f.calls.length-logStart,localWallMs:Date.now()-start,cacheMode:'disabled',revision:cold.writer.status().revision,replayFrames:cold.writer.status().replayFrames};
  const jobs=cold.store.listJobsPage().jobs;assert.equal(jobs.length,1);assert.equal(jobs[0].status,'completed');
  const job=cold.writer.get(importKeys.job(jobs[0].jobId)).value;return cold.writer.get(importKeys.run(job.runId)).value;
 });
 const finalVerification={requests:f.calls.length-verificationLogStart,localWallMs:Date.now()-verificationStart};
 assert.equal(run.imported.sampleCount,rows);
 assert.equal(f.calls.filter(c=>c[0]==='create'&&c[1]==='source').length,0);
 const filesByRole={};for(const {meta} of f.files.values()){const role=meta.appProperties?.['mypace.role'];if(role)filesByRole[role]=(filesByRole[role]||0)+1;}
 return {sourceBytes:Number(f.source.size),rows,protocol:{maxLeafEntries:setup.writer.limits.maxLeafEntries,checkpointEvery:setup.writer.limits.checkpointEvery,sourceRangeBytes:LIMITS.range},latencyModel:{serviceCallMs:serviceLatencyMs,cpuIncluded:false},coldRecovery,finalVerification,rowBytes:new TextEncoder().encode(row).length,virtualElapsedMs:importFinishedAt,rollingWaits:invocations.filter(v=>v.status==='budget-wait').length,invocations,requests:invocations.reduce((sum,v)=>sum+v.calls,0),filesByRole,completedSampleCount:run.imported.sampleCount};
}
