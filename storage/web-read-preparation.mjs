// Explicit owner repair only. It never imports CSV, changes store identity,
// deletes history or changes application entities. Repeated completed calls are
// no-ops; ambiguous checkpoint commits are resolved through existing recovery.
import {writerDigest} from './reserved-writer.mjs';
export function prepareWebRead(runtime){
 if(!runtime?.writer||typeof runtime.locked!=='function')throw Error('WEB_PREPARATION_CONFIG');
 return runtime.locked(()=>{
  const writer=runtime.writer;writer.recoveryBarrier({persistFrameProgress:true});
  const before=writer.status(),progress=writer.recoveryProgress();let sealed=false;
  if(before.replayFrames>1){
   const identity={kind:'web-read-quiescent',storeId:before.storeId,generation:before.datasetGeneration,headId:before.headId,headHash:before.headHash,revision:before.revision};
   try{writer.checkpoint({operationId:'web_ready_'+before.revision+'_'+before.headHash.slice(0,24),epoch:before.acceptedEpochs[before.acceptedEpochs.length-1],digest:writerDigest(identity),result:{webReadPrepared:true,cutRevision:before.revision}});}
   catch(error){if(['STORE_YIELD','OWNER_BUDGET_YIELD','IMPORT_YIELD'].includes(error.code||error.message)&&progress.cursorPersisted)Object.assign(error,progress,{recoveryPhase:'seal'});throw error;}
   sealed=true;
  }
  return {sealed,storage:writer.status()};
 });
}
