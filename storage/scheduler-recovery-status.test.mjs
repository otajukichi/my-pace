import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,finish} from './scheduled-runtime-fixture.mjs';
import {createOwnerScheduler} from './owner-scheduler.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
const immutableCounts=f=>Object.fromEntries(['frame','checkpoint-index','checkpoint-manifest','index-node'].map(role=>[role,[...f.files.values()].filter(x=>x.meta.appProperties?.['mypace.role']===role).length]));
function history(n=11){
 const f=fixture({checkpointHints:true});finish(f);const runtime=createGasImportRuntime(f.globals,{...f.config,protocolReadCache:{mode:'lock-phase'}});
 runtime.locked(()=>{runtime.store.recoveryBarrier();for(let i=0;i<n;i++)runtime.writer.checkpoint({operationId:'history_'+i,epoch:'default',digest:'a'.repeat(64),result:{}});});
 f.files.delete('hint');return f;
}
const scheduler=(f,extra={})=>createOwnerScheduler(f.globals,{...f.config,writerLimits:{maxIndexScanLinks:2},...extra},{now:()=>f.state.now,scanIntervalMs:3600000});
for(const method of ['start','resume','tick','status'])test(`${method} reports pending authenticated index recovery without exposing empty business state`,()=>{
 const f=history(),before=immutableCounts(f),out=scheduler(f)[method]();
 assert.equal(out.status,'recovering');assert.equal(out.processingMode,'recovery');assert.equal(out.retryable,true);assert.equal(out.error,'WRITER_RECOVERY_PENDING');assert.equal(out.indexLinks,2);assert.equal(out.scannedLinks,2);assert.equal(out.cursorPersisted,true);assert(out.usage.calls>0);assert(!('scanId' in out));assert(!('lastJob' in out));assert(!('reservedCalls' in out));assert.deepEqual(immutableCounts(f),before);
});
test('cold scheduled ticks resume bounded index recovery automatically then return the real completed state',()=>{
 const f=history(),before=immutableCounts(f),progress=[];let out;
 for(let i=0;i<30;i++){out=scheduler(f).tick();assert.deepEqual(immutableCounts(f),before);if(out.status!=='recovering')break;progress.push(out.indexLinks);assert.equal(out.scannedLinks,2);}
 assert(progress.length>1);assert(progress.every((n,i)=>i===0||n===progress[i-1]+2));assert.equal(out.status,'complete');assert.equal(out.scanId,'owner_scan_1');assert.equal(out.lastJob.progress.points,1);assert.equal(out.lastJob.progress.offset,71);
});
test('status never returns idle or complete while one-link discovery remains pending',()=>{
 const f=history(6),before=immutableCounts(f);let completed=false,previous=0;
 for(let i=0;i<30;i++){
  const out=scheduler(f,{writerLimits:{maxIndexScanLinks:1}}).status();assert.deepEqual(immutableCounts(f),before);
  if(out.status==='recovering'){assert.equal(out.indexLinks,previous+1);previous=out.indexLinks;assert.equal(out.cursorPersisted,true);assert.equal(f.config.checkpointHintCodec.decode(f.files.get('hint').bytes).indexLinks,previous);}
  else{assert.equal(out.status,'complete');assert.equal(out.lastJob.progress.points,1);completed=true;break;}
 }
 assert(previous>1);assert(completed);
});
for(const method of ['start','resume','tick','status'])test(`${method} exposes owner recovery setup requirement without business writes`,()=>{
 const f=history(5),before=immutableCounts(f);const out=scheduler(f,{checkpointHintCodec:undefined,writerLimits:{maxIndexLinks:2,maxIndexScanLinks:2}})[method]();assert.equal(out.status,'blocked');assert.equal(out.processingMode,'paused');assert.equal(out.requiresOwnerAction,true);assert.equal(out.retryable,false);assert.equal(out.error,'WRITER_RECOVERY_SETUP_REQUIRED');assert(out.usage.calls>0);assert(!('scanId' in out));assert.deepEqual(immutableCounts(f),before);
});
test('recovery integrity corruption remains an error rather than idle, blocked setup or retry',()=>{
 const f=history(3),before=immutableCounts(f);f.files.get('anchor').bytes[20]^=1;
 for(const method of ['start','resume','tick','status'])assert.throws(()=>scheduler(f)[method](),/WRITER_(FILE_INVALID|IDENTITY_INVALID|HASH_MISMATCH)/);
 assert.deepEqual(immutableCounts(f),before);
});
