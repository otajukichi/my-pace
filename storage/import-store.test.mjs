import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ImportStoreBinding,importKeys,IMPORT_STORE_LIMITS} from './import-store.mjs';
import {ImportCheckpointCoordinator,hashAssetBytes} from './immutable-assets.mjs';
import {prepareRange,buildStagedPayloads} from './bounded-import.mjs';
import {encodeUtf8,decodeUtf8} from './codec.mjs';
import {SOURCE_FOLDER_ID} from './transport.mjs';
const clone=x=>JSON.parse(JSON.stringify(x));
const prefix='# sensor:multi_record\ntime,latitude,longitude,altitude,speed\n';
const line='2026-01-01T00:00:00.123456Z,1,2,3,-1\n';
const text=n=>encodeUtf8(prefix+line.repeat(n));
function source(bytes,id='source_1',version='1'){return {id,name:'synthetic.csv',mimeType:'text/csv',parents:[SOURCE_FOLDER_ID],trashed:false,size:String(bytes.length),version,md5Checksum:createHash('md5').update(bytes).digest('hex')};}
function fixture(){
 const entities=new Map(),receipts=new Map(),files=new Map();let revision=0,seq=0,sourceValid=true,failCommit=null;
 const writer={get:key=>entities.has(key)?clone(entities.get(key)):null,getReceipt:id=>receipts.get(id)||null,recoveryBarrier:()=>({revision}),transact(c){
  if(receipts.has(c.operationId)){const r=receipts.get(c.operationId);assert.equal(r.digest,c.digest);return r;}
  if(failCommit==='before'){failCommit=null;throw Error('CRASH_BEFORE');}
  for(const d of c.changes){assert.equal(d.expectedVersion,entities.get(d.key)?.version||0);assert.ok(encodeUtf8(JSON.stringify(d.value)).length<=131072);}
  revision++;for(const d of c.changes)entities.set(d.key,{key:d.key,version:(entities.get(d.key)?.version||0)+1,deleted:false,value:clone(d.value)});
  const r={operationId:c.operationId,digest:c.digest,revision,result:clone(c.result)};receipts.set(c.operationId,r);
  if(failCommit==='after'){failCommit=null;throw Error('CRASH_AFTER');}return r;
 }};
 const store=new ImportStoreBinding({writer,storeId:'store_1',readAsset(r){const b=files.get(r.fileId);if(!b)throw Error('ASSET_NOT_FOUND');return Uint8Array.from(b);},validateSourceCurrent:()=>sourceValid});
 const assets={putOnce({reservation:r,bytes}){assert.equal(store.assertReservation(r),true);if(files.has(r.fileId))assert.deepEqual(files.get(r.fileId),bytes);else files.set(r.fileId,Uint8Array.from(bytes));return {...r,verified:true};},verify({reservation:r,bytes}){assert.equal(store.assertReservation(r),true);assert.deepEqual(files.get(r.fileId),bytes);return {...r,verified:true};}};
 let locked=false;const lock={tryLock(){assert.equal(locked,false);locked=true;return true;},releaseLock(){assert.equal(locked,true);locked=false;}};
 const coordinator=new ImportCheckpointCoordinator({writer:store,assets,getScriptLock:()=>lock,validateSourceCurrent:()=>sourceValid,checkBudget:()=>true});
 const op=kind=>kind+'_'+(++seq);
 function register(bytes,jobId='job_1',identity=source(bytes)){store.registerJob({operationId:op('register'),jobId,sourceIdentity:identity});return jobId;}
 function prepare(jobId,bytes,length=262144){const {job,checkpoint}=store.resumeJob(jobId),p=prepareRange(checkpoint,bytes.slice(checkpoint.offset,checkpoint.offset+length)),pinId=op('pin'),payload=buildStagedPayloads(p,{outputIds:p.outputs.map(()=>op('out')),manifestId:op('manifest'),checkpointId:op('checkpoint')});const input={operationId:op('batch'),jobId,expectedCheckpointId:job.checkpoint?.fileId||null,sourceIdentity:checkpoint.source,completed:payload.checkpoint.complete,assets:payload.assets.map(a=>({reservation:{fileId:a.fileId,storeId:'store_1',jobId,pinId,role:a.role,sha256:a.sha256,byteLength:a.byteLength},bytes:a.bytes}))};const manifestPage=JSON.parse(decodeUtf8(input.assets.find(a=>a.reservation.role==='manifest-page').bytes));return {input,reserve:{operationId:op('reserve'),jobId,pinId,batchOperationId:input.operationId,expectedCheckpointId:input.expectedCheckpointId,assets:input.assets.map(a=>a.reservation),checkpoint:payload.checkpoint,manifestPage}};}
 function batch(jobId,bytes,length){const p=prepare(jobId,bytes,length);store.reserveBatch(p.reserve);coordinator.commitPreparedBatch(p.input);return p;}
 function parse(jobId,bytes,length){let n=0;while(!store.resumeJob(jobId).checkpoint.complete){batch(jobId,bytes,length);n++;}return n;}
 function verify(jobId){store.beginFinalization({operationId:op('finalize'),jobId});let job=store.resumeJob(jobId).job;while(job.status==='verifying'){store.verifyNextBatch({operationId:op('verify'),jobId,expectedCursor:job.finalization.cursor});job=store.resumeJob(jobId).job;}return job;}
 function publish(jobId){return store.publishCompletedJob({operationId:op('publish'),jobId});}
 function edit(key,fn){const e=writer.get(key);e.value=fn(e.value);writer.transact({operationId:op('edit'),digest:'owner',changes:[{key,expectedVersion:e.version,value:e.value}],result:{}});}
 return {store,writer,files,entities,receipts,coordinator,register,prepare,batch,parse,verify,publish,edit,op,setSourceValid:x=>sourceValid=x,fail:x=>failCommit=x};
}
function restage(p,role,value){const a=p.input.assets.find(x=>x.reservation.role===role),bytes=encodeUtf8(JSON.stringify(value));a.bytes=bytes;a.reservation.sha256=hashAssetBytes(bytes);a.reservation.byteLength=bytes.length;if(role==='checkpoint')p.reserve.checkpoint=value;else p.reserve.manifestPage=value;}

test('durable registration dedupes renamed unchanged source and keeps a bounded cold job directory',()=>{
 const f=fixture(),bytes=text(3);f.register(bytes);const renamed={...source(bytes),name:'renamed.csv',version:'2'};
 const r=f.store.registerJob({operationId:'register_again',jobId:'job_2',sourceIdentity:renamed});assert.equal(r.result.jobId,'job_1');assert.equal(r.result.status,'known');
 assert.deepEqual(f.store.listJobsPage().jobs.map(j=>j.jobId),['job_1']);assert.equal(f.writer.get(importKeys.job('job_2')),null);
});
test('immutable batch advances exact checkpoint then completion transfers pin to run atomically',()=>{
 const f=fixture(),bytes=text(6);f.register(bytes);const batches=f.parse('job_1',bytes,70);assert.ok(batches>2);const before=f.store.resumeJob('job_1');assert.equal(before.job.status,'parsed');assert.equal(f.writer.get(importKeys.run(before.job.runId)),null);
 f.verify('job_1');const r=f.publish('job_1'),job=f.writer.get(importKeys.job('job_1')).value,run=f.writer.get(importKeys.run(job.runId)).value;
 assert.equal(r.result.status,'completed');assert.equal(job.pinActive,false);assert.equal(run.imported.sampleCount,6);assert.equal(run.imported.sourceSha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(run.imported.assetsRoot,job.firstPin);assert.equal(run.imported.statistics,'samples-only-no-distance');assert.equal(run.distance,undefined);
 const first=f.writer.get(importKeys.pin(job.firstPin)).value.assets[0];assert.equal(f.store.assertReservation(first),false);assert.equal(f.store.assertReadableAsset(first.fileId,first.byteLength,2097152),true);
});
test('pending upload descriptors and operation identity survive reconstructed binding',()=>{
 const f=fixture(),bytes=text(2);f.register(bytes);const p=f.prepare('job_1',bytes,80);f.store.reserveBatch(p.reserve);
 const restored=new ImportStoreBinding({writer:f.writer,storeId:'store_1',readAsset:r=>f.files.get(r.fileId),validateSourceCurrent:()=>true});const resumed=restored.resumeJob('job_1');
 assert.equal(resumed.checkpoint.offset,0);assert.equal(resumed.pending.batchOperationId,p.input.operationId);assert.deepEqual(resumed.pending.assets,p.reserve.assets);f.coordinator.commitPreparedBatch(p.input);assert.ok(restored.resumeJob('job_1').checkpoint.offset>0);
});
test('lost successful reservation response replays receipt with fixed IDs',()=>{
 const f=fixture(),bytes=text(2);f.register(bytes);const p=f.prepare('job_1',bytes);f.fail('after');assert.throws(()=>f.store.reserveBatch(p.reserve),/CRASH_AFTER/);const count=f.entities.size;
 const r=f.store.reserveBatch(p.reserve);assert.equal(r.result.pinId,p.reserve.pinId);assert.equal(f.entities.size,count);assert.deepEqual(f.store.resumeJob('job_1').pending.assets,p.reserve.assets);
});
test('batch commit lost response resumes original receipt before stale checkpoint validation',()=>{
 const f=fixture(),bytes=text(2);f.register(bytes);const p=f.prepare('job_1',bytes);f.store.reserveBatch(p.reserve);f.fail('after');assert.throws(()=>f.coordinator.commitPreparedBatch(p.input),/CRASH_AFTER/);f.setSourceValid(false);const r=f.coordinator.commitPreparedBatch(p.input);assert.equal(r.result.completed,true);assert.equal(f.store.resumeJob('job_1').job.batchCount,1);
});
test('same operation with mutated reservation is rejected without replacing durable state',()=>{
 const f=fixture(),bytes=text(2);f.register(bytes);const p=f.prepare('job_1',bytes);f.store.reserveBatch(p.reserve);p.reserve.batchOperationId='changed';assert.throws(()=>f.store.reserveBatch(p.reserve),/OP_ID_REUSED/);
});
test('asset IDs cannot be reused in a later batch or another job',()=>{
 const f=fixture(),bytes=text(4);f.register(bytes);const first=f.batch('job_1',bytes,70),next=f.prepare('job_1',bytes,70);next.reserve.assets.find(a=>a.role==='output').fileId=first.reserve.assets.find(a=>a.role==='manifest-page').fileId;
 // Update the exact manifest so rejection specifically reaches persistent ID index.
 next.reserve.manifestPage.outputs[0].fileId=next.reserve.assets.find(a=>a.role==='output').fileId;restage(next,'manifest-page',next.reserve.manifestPage);next.reserve.checkpoint.previousManifest={fileId:next.reserve.assets.find(a=>a.role==='manifest-page').fileId,sha256:next.reserve.assets.find(a=>a.role==='manifest-page').sha256,byteLength:next.reserve.assets.find(a=>a.role==='manifest-page').byteLength};restage(next,'checkpoint',next.reserve.checkpoint);
 assert.throws(()=>f.store.reserveBatch(next.reserve),/ASSET_ID_REUSED/);
});
for(const [name,mutate,error] of [
 ['foreign source',p=>{p.reserve.checkpoint.source.id='other';restage(p,'checkpoint',p.reserve.checkpoint);},/CHECKPOINT_SOURCE/],
 ['forged manifest previous',p=>{p.reserve.manifestPage.previous={fileId:'old',sha256:'a'.repeat(64),byteLength:1};restage(p,'manifest-page',p.reserve.manifestPage);},/MANIFEST_LINK/],
 ['swapped output descriptor',p=>{p.reserve.manifestPage.outputs[0].fileId='other';restage(p,'manifest-page',p.reserve.manifestPage);},/MANIFEST_LINK|MANIFEST_OUTPUTS/],
 ['skipped output index',p=>{p.reserve.manifestPage.outputs[0].index=1;restage(p,'manifest-page',p.reserve.manifestPage);},/MANIFEST_LINK|MANIFEST_OUTPUTS/],
 ['checkpoint count mismatch',p=>{p.reserve.checkpoint.points++;restage(p,'checkpoint',p.reserve.checkpoint);},/CHECKPOINT_DELTA|CHECKPOINT_ROW_INVARIANTS/],
 ['reset source hash',p=>{p.reserve.checkpoint.sourceHash.totalBytes=0;restage(p,'checkpoint',p.reserve.checkpoint);},/CHECKPOINT_HASH_OFFSET/],
 ['false final digest',p=>{p.reserve.checkpoint.sourceSha256='f'.repeat(64);restage(p,'checkpoint',p.reserve.checkpoint);},/CHECKPOINT_COMPLETION/]
])test('reservation rejects '+name,()=>{const f=fixture(),bytes=text(2);f.register(bytes);const p=f.prepare('job_1',bytes);mutate(p);assert.throws(()=>f.store.reserveBatch(p.reserve),error);assert.equal(f.store.resumeJob('job_1').pending,null);});
test('stale expected checkpoint and foreign pin fail before staging',()=>{
 const f=fixture(),bytes=text(3);f.register(bytes);const p=f.prepare('job_1',bytes,80);p.reserve.expectedCheckpointId='stale';assert.throws(()=>f.store.reserveBatch(p.reserve),/CHECKPOINT_CONFLICT/);p.reserve.expectedCheckpointId=null;p.reserve.assets[0].pinId='foreign';assert.throws(()=>f.store.reserveBatch(p.reserve),/RESERVATION_INVALID/);
});
test('cancellation is ordered, durable and revokes asset staging without deleting original or run',()=>{
 const f=fixture(),bytes=text(2);f.register(bytes);const p=f.prepare('job_1',bytes);f.store.reserveBatch(p.reserve);assert.equal(f.store.assertReservation(p.reserve.assets[0]),true);f.store.cancelJob({operationId:'cancel',jobId:'job_1'});
 assert.equal(f.store.assertReservation(p.reserve.assets[0]),false);assert.equal(f.store.assertReadableAsset(p.reserve.assets[0].fileId,p.reserve.assets[0].byteLength,2097152),false);assert.throws(()=>f.coordinator.commitPreparedBatch(p.input),/JOB_NOT_ACTIVE/);assert.equal(f.files.size,0);
});
test('source changed after staging prevents checkpoint and completed run publication',()=>{
 const f=fixture(),bytes=text(2);f.register(bytes);const p=f.prepare('job_1',bytes);f.store.reserveBatch(p.reserve);f.setSourceValid(false);assert.throws(()=>f.coordinator.commitPreparedBatch(p.input),/SOURCE_CHANGED/);assert.equal(f.store.resumeJob('job_1').checkpoint.offset,0);assert.equal(f.store.resumeJob('job_1').pending.pinId,p.reserve.pinId);
 f.setSourceValid(true);f.coordinator.commitPreparedBatch(p.input);f.verify('job_1');f.setSourceValid(false);assert.throws(()=>f.publish('job_1'),/SOURCE_CHANGED/);assert.equal(f.writer.get(importKeys.run(f.store.resumeJob('job_1').job.runId)),null);
});
test('resume independently verifies saved checkpoint content hash',()=>{
 const f=fixture(),bytes=text(3);f.register(bytes);f.batch('job_1',bytes,80);const id=f.store.resumeJob('job_1').job.checkpoint.fileId;f.files.get(id)[2]^=1;assert.throws(()=>f.store.resumeJob('job_1'),/ASSET_CONTENT_MISMATCH/);
});
test('finalization independently verifies every output and leaves pin live on failure',()=>{
 const f=fixture(),bytes=text(3);f.register(bytes);f.parse('job_1',bytes);const job=f.store.resumeJob('job_1').job,pin=f.writer.get(importKeys.pin(job.firstPin)).value;f.files.get(pin.assets.find(a=>a.role==='output').fileId)[1]^=1;
 f.store.beginFinalization({operationId:'begin_final',jobId:'job_1'});assert.throws(()=>f.store.verifyNextBatch({operationId:'verify',jobId:'job_1',expectedCursor:job.firstPin}),/ASSET_CONTENT_MISMATCH/);assert.equal(f.store.resumeJob('job_1').job.pinActive,true);
});
test('finalization progress is bounded, resumable, and cursor-versioned',()=>{
 const f=fixture(),bytes=text(10);f.register(bytes);f.parse('job_1',bytes,65);f.store.beginFinalization({operationId:'begin_final',jobId:'job_1'});const cursor=f.store.resumeJob('job_1').job.finalization.cursor;
 const input={operationId:'verify1',jobId:'job_1',expectedCursor:cursor};f.store.verifyNextBatch(input);assert.equal(f.store.verifyNextBatch(input).operationId,'verify1');assert.throws(()=>f.store.verifyNextBatch({...input,operationId:'verify2'}),/FINALIZATION_CURSOR_CONFLICT/);
 let job=f.store.resumeJob('job_1').job;while(job.status==='verifying'){f.store.verifyNextBatch({operationId:f.op('v'),jobId:'job_1',expectedCursor:job.finalization.cursor});job=f.store.resumeJob('job_1').job;}assert.equal(job.status,'verified');assert.ok(JSON.stringify(job.finalization).length<2000);f.publish('job_1');
});
test('duplicate content under a different source ID never contributes a second counted run',()=>{
 const f=fixture(),bytes=text(3);f.register(bytes);f.parse('job_1',bytes);f.verify('job_1');f.publish('job_1');f.register(bytes,'job_2',source(bytes,'other_source'));f.parse('job_2',bytes);f.verify('job_2');const result=f.publish('job_2');
 assert.equal(result.result.status,'duplicate');const j=f.store.resumeJob('job_2').job;assert.equal(j.status,'duplicate');assert.equal(j.pinActive,true);assert.equal(f.writer.get(importKeys.run(j.runId)),null);
});
test('same-source replacement preserves latest owner edits and unrelated entities',()=>{
 const f=fixture(),bytes=text(2);f.register(bytes);f.parse('job_1',bytes);f.verify('job_1');f.publish('job_1');const job=f.writer.get(importKeys.job('job_1')).value,rk=importKeys.run(job.runId);
 const changed=text(4);f.register(changed,'replacement',source(changed,'source_1','2'));f.edit(rk,v=>({...v,owner:{note:'owner text',distance:8},title:'owner title'}));f.writer.transact({operationId:'unrelated',digest:'ok',changes:[{key:'diary/day',expectedVersion:0,value:{text:'private'}}],result:{}});
 f.parse('replacement',changed);f.verify('replacement');f.publish('replacement');const run=f.writer.get(rk).value;assert.equal(run.imported.sampleCount,4);assert.deepEqual(run.owner,{note:'owner text',distance:8});assert.equal(run.title,'owner title');assert.equal(f.writer.get('diary/day').value.text,'private');
});
test('replacement refuses overwriting owner edits to imported branch',()=>{
 const f=fixture(),bytes=text(2);f.register(bytes);f.parse('job_1',bytes);f.verify('job_1');f.publish('job_1');const job=f.writer.get(importKeys.job('job_1')).value,rk=importKeys.run(job.runId),changed=text(4);f.register(changed,'replacement',source(changed,'source_1','2'));
 f.edit(rk,v=>({...v,imported:{...v.imported,sampleCount:42}}));f.parse('replacement',changed);f.verify('replacement');assert.throws(()=>f.publish('replacement'),/OWNER_IMPORT_CONFLICT/);assert.equal(f.writer.get(rk).value.imported.sampleCount,42);assert.equal(f.store.resumeJob('replacement').job.pinActive,true);
});
test('missing checksum and out-of-folder source cannot create job',()=>{
 const f=fixture(),bytes=text(2);let s=source(bytes);delete s.md5Checksum;assert.throws(()=>f.register(bytes,'job_1',s),/SOURCE_IDENTITY_REQUIRED/);s=source(bytes);s.parents=['other'];assert.throws(()=>f.register(bytes,'job_1',s),/SOURCE_OUT_OF_SCOPE/);assert.equal(f.entities.size,0);
});
test('scan page is durable before cursor advance, interrupted candidate replay dedupes',()=>{
 const f=fixture(),bytes=text(2);f.store.beginScan({operationId:'scan_begin',scanId:'scan_1'});f.store.recordScanPage({operationId:'page',scanId:'scan_1',expectedPage:0,expectedPageToken:null,files:[source(bytes),source(bytes,'other')],nextPageToken:'next'});
 assert.throws(()=>f.store.recordScanPage({operationId:'page2',scanId:'scan_1',expectedPage:1,expectedPageToken:'next',files:[],nextPageToken:null}),/SCAN_CURSOR_CONFLICT/);assert.throws(()=>f.store.acknowledgeScanEntry({operationId:'ack',scanId:'scan_1',expectedPage:0,expectedIndex:0}),/SCAN_JOB_NOT_DURABLE/);
 let e=f.store.nextScanEntry('scan_1');f.register(bytes,'job_1',e.sourceIdentity);f.store.registerJob({operationId:'retry_known',jobId:'unused',sourceIdentity:e.sourceIdentity});f.store.acknowledgeScanEntry({operationId:'ack',scanId:'scan_1',expectedPage:0,expectedIndex:0});e=f.store.nextScanEntry('scan_1');assert.equal(e.sourceIdentity.id,'other');f.register(bytes,'job_2',e.sourceIdentity);f.store.acknowledgeScanEntry({operationId:'ack2',scanId:'scan_1',expectedPage:0,expectedIndex:1});
 f.store.recordScanPage({operationId:'page2',scanId:'scan_1',expectedPage:1,expectedPageToken:'next',files:[],nextPageToken:null});assert.equal(f.store.getScan('scan_1').done,true);
});
test('expired scan token restarts at null without discarding durable pages or job identities',()=>{
 const f=fixture();f.store.beginScan({operationId:'scan_begin',scanId:'scan_1'});f.store.recordScanPage({operationId:'p0',scanId:'scan_1',expectedPage:0,expectedPageToken:null,files:[],nextPageToken:'expired'});f.store.restartScan({operationId:'restart',scanId:'scan_1',expectedPage:1,expectedPageToken:'expired'});const s=f.store.getScan('scan_1');assert.equal(s.pageToken,null);assert.equal(s.nextPage,1);assert.equal(s.restarts,1);assert.ok(f.writer.get(importKeys.scanPage('scan_1',0)));
});
test('all scan/job/index buckets stay bounded and directory pagination needs no listing search',()=>{
 const f=fixture(),bytes=text(1);for(let i=0;i<70;i++)f.register(bytes,'job_'+i,source(bytes,'source_'+i));let cursor=null,seen=[];do{const page=f.store.listJobsPage({cursor,limit:7});seen.push(...page.jobs.map(j=>j.jobId));cursor=page.nextCursor;}while(cursor);assert.equal(new Set(seen).size,70);assert.ok(JSON.stringify(f.writer.get(importKeys.directory()).value).length<100);
 for(const e of f.entities.values())assert.ok(encodeUtf8(JSON.stringify(e.value)).length<=IMPORT_STORE_LIMITS.entityBytes);
});
test('source content A to B to A creates a replacement generation instead of historical dedup suppression',()=>{
 const f=fixture(),a=text(2),b=text(4);f.register(a);f.parse('job_1',a);f.verify('job_1');f.publish('job_1');f.register(b,'job_b',source(b,'source_1','2'));f.parse('job_b',b);f.verify('job_b');f.publish('job_b');
 const r=f.store.registerJob({operationId:'revert',jobId:'job_a_again',sourceIdentity:source(a,'source_1','3')});assert.equal(r.result.status,'active');f.parse('job_a_again',a);f.verify('job_a_again');f.publish('job_a_again');const job=f.writer.get(importKeys.job('job_a_again')).value;assert.equal(f.writer.get(importKeys.run(job.runId)).value.imported.sampleCount,2);
});
test('stale content claim does not point duplicate resolution to a replaced run generation',()=>{
 const f=fixture(),a=text(2),b=text(4);f.register(a);f.parse('job_1',a);f.verify('job_1');f.publish('job_1');f.register(b,'job_b',source(b,'source_1','2'));f.parse('job_b',b);f.verify('job_b');f.publish('job_b');
 f.register(a,'other_a',source(a,'other_source'));f.parse('other_a',a);f.verify('other_a');assert.equal(f.publish('other_a').result.status,'completed');
});
test('a held duplicate can be explicitly rechecked after the other live run is replaced',()=>{
 const f=fixture(),a=text(2),b=text(4);f.register(a);f.parse('job_1',a);f.verify('job_1');f.publish('job_1');f.register(a,'held',source(a,'other_source'));f.parse('held',a);f.verify('held');assert.equal(f.publish('held').result.status,'duplicate');
 f.register(b,'replacement',source(b,'source_1','2'));f.parse('replacement',b);f.verify('replacement');f.publish('replacement');assert.equal(f.store.publishCompletedJob({operationId:'recheck_held',jobId:'held'}).result.status,'completed');assert.equal(f.store.getJob('held').duplicateRunId,undefined);
});
test('metadata and runtime yield failures propagate from checkpoint reads without corruption relabeling',()=>{
 const f=fixture(),bytes=text(2);f.register(bytes);f.parse('job_1',bytes);const expected=Error('IMPORT_YIELD');expected.retryable=true;const binding=new ImportStoreBinding({writer:f.writer,storeId:'store_1',readAsset(){throw expected;},validateSourceCurrent:()=>true});assert.throws(()=>binding.resumeJob('job_1'),e=>e===expected);assert.equal(binding.getJob('job_1').status,'parsed');
});
for(const [name,mutate] of [
 ['header/preamble',cp=>{cp.header=null;cp.sawPreamble=false;}],
 ['row count',cp=>cp.rows=0],
 ['impossible time-order count',cp=>cp.nonIncreasingTimes=999999]
])test('checkpoint rejects forged '+name+' before reservation',()=>{const f=fixture(),bytes=text(2);f.register(bytes);const p=f.prepare('job_1',bytes);mutate(p.reserve.checkpoint);restage(p,'checkpoint',p.reserve.checkpoint);assert.throws(()=>f.store.reserveBatch(p.reserve),/CHECKPOINT_ROW_INVARIANTS|CHECKPOINT_COMPLETION/);});
for(const [name,mutate] of [
 ['first time',cp=>cp.firstTime='2099-01-01T00:00:00Z'],
 ['last time',cp=>cp.lastTime='1900-01-01T00:00:00Z'],
 ['time-order count',cp=>cp.nonIncreasingTimes=0]
])test('finalization derives '+name+' from exact normalized points',()=>{const f=fixture(),bytes=text(2);f.register(bytes);const p=f.prepare('job_1',bytes);mutate(p.reserve.checkpoint);restage(p,'checkpoint',p.reserve.checkpoint);f.store.reserveBatch(p.reserve);f.coordinator.commitPreparedBatch(p.input);assert.throws(()=>f.verify('job_1'),/FINALIZATION_SUMMARY_MISMATCH/);const job=f.store.getJob('job_1');assert.equal(job.pinActive,true);assert.equal(f.writer.get(importKeys.run(job.runId)),null);});
test('established column mapping cannot change at a checkpoint boundary',()=>{
 const f=fixture(),bytes=text(3);f.register(bytes);f.batch('job_1',bytes,prefix.length+line.length);const p=f.prepare('job_1',bytes,line.length);[p.reserve.checkpoint.header[1],p.reserve.checkpoint.header[2]]=[p.reserve.checkpoint.header[2],p.reserve.checkpoint.header[1]];restage(p,'checkpoint',p.reserve.checkpoint);assert.throws(()=>f.store.reserveBatch(p.reserve),/CHECKPOINT_MAPPING_CHANGED/);
});

test('A duplicate then B published then A again re-verifies the active source generation',()=>{
 const f=fixture(),a=text(2),b=text(4);f.register(a,'target',source(a,'target_source'));f.parse('target',a);f.verify('target');f.publish('target');
 f.register(a,'duplicate_a',source(a,'other_source'));f.parse('duplicate_a',a);f.verify('duplicate_a');assert.equal(f.publish('duplicate_a').result.status,'duplicate');
 assert(f.store.getJob('duplicate_a').publishedContentKey);
 f.register(b,'published_b',source(b,'other_source','2'));f.parse('published_b',b);f.verify('published_b');assert.equal(f.publish('published_b').result.status,'completed');
 const reverted=f.store.registerJob({operationId:'reverted_duplicate',jobId:'a_again',sourceIdentity:source(a,'other_source','3')});assert.equal(reverted.result.status,'active');f.parse('a_again',a);f.verify('a_again');assert.equal(f.publish('a_again').result.status,'duplicate');assert.equal(f.writer.get(importKeys.source('other_source')).value.activeJobId,'a_again');
});
test('changed duplicate target cannot suppress rediscovery of an unchanged copied source',()=>{
 const f=fixture(),a=text(2),b=text(4);f.register(a,'target',source(a,'target_source'));f.parse('target',a);f.verify('target');f.publish('target');f.register(a,'duplicate_a',source(a,'other_source'));f.parse('duplicate_a',a);f.verify('duplicate_a');f.publish('duplicate_a');
 assert.equal(f.store.registerJob({operationId:'known_duplicate',jobId:'not_created',sourceIdentity:source(a,'other_source')}).result.status,'known');
 f.register(b,'new_target',source(b,'target_source','2'));f.parse('new_target',b);f.verify('new_target');f.publish('new_target');
 assert.equal(f.store.registerJob({operationId:'changed_target_recheck',jobId:'reverified',sourceIdentity:source(a,'other_source')}).result.status,'active');f.parse('reverified',a);f.verify('reverified');assert.equal(f.publish('reverified').result.status,'completed');
});
test('legacy duplicate without content evidence is reverified before any publication',()=>{
 const f=fixture(),a=text(2);f.register(a,'target',source(a,'target_source'));f.parse('target',a);f.verify('target');f.publish('target');f.register(a,'duplicate_a',source(a,'other_source'));f.parse('duplicate_a',a);f.verify('duplicate_a');f.publish('duplicate_a');f.edit(importKeys.job('duplicate_a'),job=>{delete job.publishedContentKey;return job;});
 assert.equal(f.store.registerJob({operationId:'legacy_recheck',jobId:'reverified',sourceIdentity:source(a,'other_source')}).result.status,'active');assert.equal(f.writer.get(importKeys.run(f.store.getJob('reverified').runId)),null);f.parse('reverified',a);f.verify('reverified');assert.equal(f.publish('reverified').result.status,'duplicate');
});
