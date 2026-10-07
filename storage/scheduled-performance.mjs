// Synthetic cold-runtime evidence; every invocation reconstructs the runtime.
// No live Google requests, trigger, OAuth, source data, or Drive writes.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {importKeys} from './import-store.mjs';
import {fixture,SCHEDULED_MODEL_CADENCE_MS} from './scheduled-runtime-fixture.mjs';
import {OWNER_LIMITS} from './owner-scheduler.mjs';
export function measureScheduledImport({minimumBytes=1048576,latency=300,maxInvocations=250,checkpointHints=false,catchUp=true,futureSecondFile=false,discoveryState=checkpointHints,cache=true,onInvocation=()=>{}}={}){
 const header='# sensor:multi_record\ntime,gFx,gFy,gFz,ax,ay,az,wx,wy,wz,P(Pa),Bx(µT),By(µT),Bz(µT),latitude,longitude,altitude,speed,yaw,pitch,roll\n';
 const row='2026-01-01T00:00:00Z,'+Array.from({length:20},(_,i)=>i===9?'101325.123':i===13?'35.123456':i===14?'139.12345':i===15?'123.45678':i===16?'1.2345678':'0.123456').join(',')+'\n';
 const rows=Math.ceil((minimumBytes-header.length)/row.length),f=fixture({csvText:header+row.repeat(rows),latency,checkpointHints,discoveryState,cache});
 const indexCount=()=>[...f.files.values()].filter(file=>file.meta.appProperties?.['mypace.role']==='checkpoint-index').length;
 const results=[],completedSweeps=[],start=Date.now();let final,secondAdded=false;
 for(let n=0;n<maxInvocations;n++){
  let out;try{out=f.tick({catchUp});}catch(e){out={status:'thrown',error:e.code||e.message};}
  const result={invocation:n+1,sweep:secondAdded?2:1,processingMode:out.processingMode,allowanceMs:out.allowanceMs,status:out.status,error:out.error,calls:out.usage?.calls,elapsedMs:out.usage?.elapsedMs,errorPersisted:out.errorPersisted,offset:out.lastJob?.progress?.offset,jobStatus:out.lastJob?.status,reservedCalls:out.reservedCalls,reservedRuntimeMs:out.reservedRuntimeMs};results.push(result);onInvocation(result);final=out;
  if(out.status==='complete'){
   completedSweeps.push({sweep:secondAdded?2:1,invocation:n+1,at:f.state.now,checkpointIndexes:indexCount()});
   if(futureSecondFile&&!secondAdded){
    const bytes=new TextEncoder().encode(header+row.replace('2026-01-01','2026-01-02').repeat(rows));
    const source2={...structuredClone(f.source),id:'source_2',name:'later-synthetic.csv',size:String(bytes.length),md5Checksum:createHash('md5').update(bytes).digest('hex')};
    f.files.set('source_2',{meta:source2,bytes});const list=f.globals.Drive.Files.list;
    f.globals.Drive.Files.list=(...args)=>{list(...args);return {files:[structuredClone(f.source),structuredClone(source2)]};};
    secondAdded=true;f.state.now=Math.max(out.nextScanAt||0,f.state.now+SCHEDULED_MODEL_CADENCE_MS);continue;
   }
   break;
  }
  if(['blocked','thrown'].includes(out.status))break;
  f.advance(out);
 }
 const importFinishedAt=f.state.now;let idleCallsPerTick=null;
 if(final.status==='complete'){const before=f.state.serviceCalls,idle=f.tick({catchUp});assert.equal(idle.status,'complete');idleCallsPerTick=f.state.serviceCalls-before;}
 const jobs=f.inspect(),job=jobs[0];let verifiedPublication=false;
 if(final.status==='complete'){
  assert.equal(jobs.length,futureSecondFile?2:1);for(const completed of jobs){assert.equal(completed.status,'completed');assert.equal(completed.progress.points,rows);}
  // Independent final full-anchor recovery deliberately does not use hints.
  const cold=createGasImportRuntime(f.globals,{...f.config,checkpointHintCodec:undefined});
  cold.locked(()=>{cold.store.recoveryBarrier();for(const completed of jobs){const run=cold.writer.get(importKeys.run(completed.runId)).value;assert.equal(run.imported.sampleCount,rows);assert.equal(run.imported.sourceSha256,createHash('sha256').update(f.files.get(completed.sourceIdentity.id).bytes).digest('hex'));}});verifiedPublication=true;
 }
 assert.equal(f.state.writes,0);assert.equal(f.calls.filter(c=>['create','update'].includes(c[0])&&['source','source_2'].includes(c[1])).length,0);
 const filesByRole={};for(const file of f.files.values()){const role=file.meta.appProperties?.['mypace.role'];if(role)filesByRole[role]=(filesByRole[role]||0)+1;}
 return {filesByRole,cadenceMs:SCHEDULED_MODEL_CADENCE_MS,workCallLimit:OWNER_LIMITS.rollingCalls,checkpointIndexes:indexCount(),idleCallsPerTick,modeledIdleCallsPerDay:idleCallsPerTick===null?null:idleCallsPerTick*(86400000/SCHEDULED_MODEL_CADENCE_MS),sourceBytes:Number(f.source.size),rowBytes:new TextEncoder().encode(row).length,rows,latencyMs:latency,checkpointHints,discoveryState,cache,catchUp,futureSecondFile,status:final.status,error:final.error,requests:results.reduce((n,r)=>n+(r.calls||0),0),maximumModeledMs:Math.max(...results.map(r=>r.elapsedMs||0)),rollingWaits:results.filter(r=>r.status==='budget-wait').length,virtualElapsedMs:importFinishedAt,localWallMs:Date.now()-start,finalJobStatus:job?.status,completedSamples:job?.progress.points,verifiedPublication,publishedRuns:verifiedPublication?jobs.length:0,completedSweeps,invocations:results};
}
