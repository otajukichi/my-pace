// Bounded server-internal orchestration. The caller provides one script-lock
// helper shared by writer, reservations and coordinator. No timer is installed.
import {prepareRange,buildStagedPayloads,LIMITS} from './bounded-import.mjs';
import {decodeUtf8,encodeUtf8} from './codec.mjs';
import {hashAssetBytes} from './immutable-assets.mjs';
const fail=code=>{throw Error(code);};
const operation=(jobId,stage,marker)=>'imp_'+hashAssetBytes(encodeUtf8(JSON.stringify([jobId,stage,marker])));
export class ImportRunner {
 constructor({store,coordinator,source,allocateIds,locked,checkBudget,rangeBytes=LIMITS.range,finalizationBatchLimit=4,maxFreshOutputs=64}){
  if(!store||!coordinator||typeof source?.readRange!=='function'||typeof allocateIds!=='function'||typeof locked!=='function'||typeof checkBudget!=='function')fail('RUNNER_CONFIG');
  if(!Number.isSafeInteger(rangeBytes)||rangeBytes<1||rangeBytes>LIMITS.range)fail('RUNNER_RANGE_CONFIG');
  if(!Number.isSafeInteger(finalizationBatchLimit)||finalizationBatchLimit<1||finalizationBatchLimit>4)fail('RUNNER_FINALIZATION_CONFIG');
  if(!Number.isSafeInteger(maxFreshOutputs)||maxFreshOutputs<1||maxFreshOutputs>64)fail('RUNNER_OUTPUT_CONFIG');
  Object.assign(this,{store,coordinator,source,allocateIds,locked,checkBudget,rangeBytes,finalizationBatchLimit,maxFreshOutputs});
 }
 _budget(){if(this.checkBudget('import-runner')!==true){const e=Error('IMPORT_YIELD');e.retryable=true;throw e;}}
 // One bounded source range and one durable checkpoint per invocation. No full
 // source or full route array is materialized. Retry identities derive from the
 // committed checkpoint, and pending IDs survive termination in Drive state.
 stepJob(jobId,{deadlineMs}={}){
  this._budget();const resumed=this.locked(()=>{const current=this.store.getJob(jobId);if(current&&['completed','duplicate','cancelled'].includes(current.status))return {terminal:current};return this.store.resumeJob(jobId);});
  if(resumed.terminal)return {jobId,status:resumed.terminal.status};
  const cp=resumed.checkpoint,job=resumed.job;
  if(!cp||!job)fail('RUNNER_JOB_INVALID');
  if(cp.complete)return {status:'parsed',jobId,checkpoint:cp.previousManifest};
  const expectedCheckpointId=resumed.pending?.expectedCheckpointId ?? job.checkpoint?.fileId ?? null;
  // A resumed reservation fixes its original range even if a later trusted
  // scheduler chooses smaller cooperative chunks for fresh work.
  const length=resumed.pending?resumed.pending.transition.progress.offset-cp.offset:Math.min(this.rangeBytes,Number(cp.source.size)-cp.offset);
  if(!Number.isSafeInteger(length)||length<1||length>LIMITS.range||length>Number(cp.source.size)-cp.offset)fail('RUNNER_PENDING_RANGE');
  let bytes=this.source.readRange(cp.source,cp.offset,length,{deadlineMs});
  this._budget();let prepared=prepareRange(cp,bytes);
  // Only fresh work may shrink its committed prefix. Preparation is pure and
  // always restarts from the original checkpoint; the downloaded suffix is
  // re-read next time. A pending reservation fixes every original byte/ID.
  if(!resumed.pending)while(prepared.outputs.length>this.maxFreshOutputs){
   this._budget();if(bytes.length<=1)fail('RUNNER_OUTPUT_BOUNDS');
   bytes=bytes.slice(0,Math.floor(bytes.length/2));prepared=prepareRange(cp,bytes);
  }
  let pending=resumed.pending,ids;
  if(pending){
   const outputIds=pending.assets.filter(a=>a.role==='output').map(a=>a.fileId);
   const manifest=pending.assets.find(a=>a.role==='manifest-page');const checkpoint=pending.assets.find(a=>a.role==='checkpoint');
   if(!manifest||!checkpoint||outputIds.length!==prepared.outputs.length)fail('RUNNER_PENDING_MISMATCH');
   ids={outputIds,manifestId:manifest.fileId,checkpointId:checkpoint.fileId};
  }else{
   ids=this.locked(()=>{const all=this.allocateIds(prepared.outputs.length+2);return {outputIds:all.slice(0,-2),manifestId:all[all.length-2],checkpointId:all[all.length-1]};});
  }
  const payload=buildStagedPayloads(prepared,ids);
  const marker=expectedCheckpointId||'initial';
  const batchOperationId=pending?.batchOperationId||operation(jobId,'batch',marker);
  const pinId=pending?.pinId||operation(jobId,'pin',marker);
  const assets=payload.assets.map(a=>({reservation:{fileId:a.fileId,role:a.role,sha256:a.sha256,byteLength:a.byteLength,storeId:this.store.storeId,jobId,pinId},bytes:a.bytes}));
  if(!pending){
   const manifestPage=JSON.parse(decodeUtf8(payload.assets.find(a=>a.role==='manifest-page').bytes));
   this.locked(()=>this.store.reserveBatch({operationId:operation(jobId,'reserve',marker),jobId,pinId,batchOperationId,expectedCheckpointId,assets:assets.map(a=>a.reservation),checkpoint:payload.checkpoint,manifestPage}));
  }
  this._budget();const receipt=this.coordinator.commitPreparedBatch({operationId:batchOperationId,jobId,expectedCheckpointId,sourceIdentity:cp.source,completed:payload.checkpoint.complete,assets,reuseExisting:!!resumed.pending});
  return {status:payload.checkpoint.complete?'parsed':'checkpointed',jobId,offset:payload.checkpoint.offset,size:Number(cp.source.size),receipt};
 }
 // A separate bounded finalization step verifies up to four pinned batches.
 // A parsed checkpoint alone never makes a run visible.
 finalizeJobStep(jobId){
  this._budget();return this.locked(()=>{
   const job=this.store.getJob(jobId);
   if(['completed','duplicate','cancelled'].includes(job.status))return {jobId,status:job.status};
   if(job.status==='parsed')return this.store.beginFinalization({operationId:operation(jobId,'finalize',job.lastPin),jobId});
   if(job.status==='verifying')return this.store.verifyNextBatches({operationId:operation(jobId,'verify-bounded',[job.finalization.cursor,this.finalizationBatchLimit]),jobId,expectedCursor:job.finalization.cursor,maxBatches:this.finalizationBatchLimit});
   if(job.status==='verified')return this.store.publishCompletedJob({operationId:operation(jobId,'publish',job.lastPin),jobId});
   return {jobId,status:job.status};
  });
 }
 stepScan(scanId,{deadlineMs}={}){
  this._budget();const state=this.locked(()=>{this.store.recoveryBarrier();return this.store.getScan(scanId);});
  if(state.done)return {scanId,status:'complete'};
  if(state.pendingPage!==null){
   return this.locked(()=>{
    this.store.recoveryBarrier();const entry=this.store.nextScanEntry(scanId);
    if(!entry)return {scanId,status:this.store.getScan(scanId).done?'complete':'progressed'};
    const marker=[entry.page,entry.index];
    const jobId=operation(scanId,'job',marker);
    this.store.registerJob({operationId:operation(scanId,'register',marker),jobId,sourceIdentity:entry.sourceIdentity});
    return this.store.acknowledgeScanEntry({operationId:operation(scanId,'ack',marker),scanId,expectedPage:entry.page,expectedIndex:entry.index});
   });
  }
  let page;
  try{page=this.source.listPage({pageToken:state.pageToken,deadlineMs});}
  catch(e){if(e.code==='PAGE_TOKEN_REJECTED')return this.locked(()=>this.store.restartScan({operationId:operation(scanId,'restart',state.restarts),scanId,expectedPageToken:state.pageToken,expectedPage:state.nextPage}));throw e;}
  this._budget();return this.locked(()=>this.store.recordScanPage({operationId:operation(scanId,'page',state.nextPage),scanId,expectedPageToken:state.pageToken,expectedPage:state.nextPage,files:page.files,nextPageToken:page.nextPageToken}));
 }

}
