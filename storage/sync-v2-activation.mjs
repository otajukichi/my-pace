/**
 * Internal explicit-owner migration, called only after the existing owner setup
 * has authenticated the editor and loaded the pinned store configuration.
 * There is no web route, bootstrap, ID/config replacement, or OAuth operation.
 * All record/receipt/history changes use the existing immutable writer and its
 * same-project lock. The head and irreversible format fence commit together.
 */
import {writerDigest} from './reserved-writer.mjs';
import {SYNC_APP_CHANGE_HEAD,SYNC_APP_CHANGE_CAPACITY,initialSyncAppChangeHead,validateSyncAppChangeHead} from './app-sync-protocol.mjs';
const validId=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const fail=(code,ownerAction=false)=>{const e=Error(code);e.code=code;if(ownerAction)e.requiresOwnerAction=true;throw e;};
export function activateSyncV2(runtime){
 const writer=runtime?.writer;
 if(typeof runtime?.locked!=='function'||!writer||['recoveryBarrier','status','getEntity','getReceipt','enableFormatFence'].some(k=>typeof writer[k]!=='function'))fail('SYNC_V2_ACTIVATION_CONFIG');
 return runtime.locked(()=>{
  // Recovery may preserve authenticated progress or complete an already
  // committed mandatory publication; it must never create an absent store.
  writer.recoveryBarrier({persistFrameProgress:true});const before=writer.status();
  if(!validId(before.storeId)||before.storeId!==writer.storeId||!validId(before.datasetGeneration)||!validId(writer.anchorId)||!validId(writer.writerScriptId)||!Number.isSafeInteger(writer.schemaVersion)||writer.schemaVersion<1||!Array.isArray(before.acceptedEpochs)||before.acceptedEpochs.length<1||!before.acceptedEpochs.every(validId))fail('SYNC_V2_ACTIVATION_CONFIG');
  const identity={kind:'mypace-enable-incremental-sync',protocol:2,storeId:before.storeId,datasetGeneration:before.datasetGeneration,writerScriptId:writer.writerScriptId,anchorId:writer.anchorId,schemaVersion:writer.schemaVersion,headKey:SYNC_APP_CHANGE_HEAD,capacity:SYNC_APP_CHANGE_CAPACITY};
  const digest=writerDigest(identity),operationId='sync_v2_enable_'+digest.slice(0,40),epoch=before.acceptedEpochs[before.acceptedEpochs.length-1];
  const receipt=writer.getReceipt(operationId,epoch);
  if(receipt&&receipt.digest!==digest)fail('OP_ID_REUSED');
  const head=writer.getEntity(SYNC_APP_CHANGE_HEAD);
  if(before.writerFence===2){
   validateSyncAppChangeHead(head);
   return {enabled:true,alreadyEnabled:true,...(receipt?{receipt}:{}),storage:writer.status()};
  }
  if(before.writerFence!==0)fail('SYNC_V2_FORMAT_UNSUPPORTED',true);
  if(receipt)fail('WRITER_FORMAT_FENCE_MISSING',true);
  // An earlier experimental or corrupt head must be investigated by the owner.
  // It is never overwritten, adopted, reset, or treated as an activation grant.
  if(head!==null&&head!==undefined)fail('SYNC_V2_UNFENCED_JOURNAL_PRESENT',true);
  const committed=writer.enableFormatFence({operationId,epoch,datasetGeneration:before.datasetGeneration,digest,changes:[{key:SYNC_APP_CHANGE_HEAD,expectedVersion:0,value:initialSyncAppChangeHead()}],result:{incrementalSyncEnabled:true,protocol:2}});
  const after=writer.status();if(after.writerFence!==2||after.storeId!==before.storeId||after.datasetGeneration!==before.datasetGeneration)fail('SYNC_V2_ACTIVATION_UNPROVEN');
  const journal=validateSyncAppChangeHead(writer.getEntity(SYNC_APP_CHANGE_HEAD));
  if(journal.seq!==0||committed.operationId!==operationId||committed.digest!==digest)fail('SYNC_V2_ACTIVATION_UNPROVEN');
  return {enabled:true,alreadyEnabled:false,receipt:committed,storage:after};
 });
}
