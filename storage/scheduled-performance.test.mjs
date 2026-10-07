import test from 'node:test';import assert from 'node:assert/strict';import {measureScheduledImport} from './scheduled-performance.mjs';
for(const latency of [100,300])test(`hint-enabled scheduled1MiB sensor runtime completes cold at${latency}ms/request`,()=>{
 const result=measureScheduledImport({minimumBytes:1048576,latency,checkpointHints:true});
 assert.equal(result.rowBytes,207);assert.equal(result.status,'complete',JSON.stringify(result));assert.equal(result.completedSamples,result.rows);assert(result.maximumModeledMs<=120000);assert.equal(result.rollingWaits,0);assert(result.requests<=1800,JSON.stringify(result));
});
test('queued work selects120s catch-up, then later new files are scanned and published with the same ledger',()=>{
 const result=measureScheduledImport({minimumBytes:3*1048576,latency:300,checkpointHints:true,futureSecondFile:true});
 assert.equal(result.status,'complete',JSON.stringify(result));assert.equal(result.publishedRuns,2);assert.equal(result.completedSweeps.length,2);assert(result.invocations.some(r=>r.processingMode==='catch-up'));assert(result.invocations.some(r=>r.sweep===2&&r.processingMode==='catch-up'));
 assert(result.invocations.filter(r=>r.processingMode==='check').every(r=>r.elapsedMs<=60000));assert(result.maximumModeledMs<=120000);assert.equal(result.verifiedPublication,true);
 const second=result.invocations.find(r=>r.sweep===2);assert(second.reservedRuntimeMs>120000,'second file must retain previous Drive budget reservations');
});
test('quota-safe defaults leave explicit idle headroom without claiming account-wide metering',async()=>{
 const {OWNER_LIMITS}=await import('./owner-scheduler.mjs');
 const {SCHEDULED_MODEL_CADENCE_MS}=await import('./scheduled-runtime-fixture.mjs');
 assert.equal(OWNER_LIMITS.rollingCalls,12000);assert.equal(SCHEDULED_MODEL_CADENCE_MS,900000);
 const result=measureScheduledImport({minimumBytes:1024,latency:100,checkpointHints:true});
 assert.equal(result.cadenceMs,900000);assert.equal(result.workCallLimit,12000);
 assert(result.idleCallsPerTick>0);assert.equal(result.modeledIdleCallsPerDay,result.idleCallsPerTick*96);
 assert(12000+result.modeledIdleCallsPerDay<20000,'small fixture leaves additional headroom, not a global guarantee');
 assert(result.checkpointIndexes>0);
});
