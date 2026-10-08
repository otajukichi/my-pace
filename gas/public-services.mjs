// Authenticated service composition. Record snapshots are independent of the
// optional CSV overview, which shares the same verified lock phase when cheap.
const codeOf=e=>typeof e?.code==='string'?e.code:typeof e?.message==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(e.message)?e.message:'SERVICE_UNAVAILABLE';
export function safeRecoveryProgress(progress){
 if(!progress||!['frames','index','checkpoint','preparation'].includes(progress.phase)||progress.cursorPersisted!==true||progress.cursorAdvanced!==true)return null;
 const field={frames:'revision',index:'indexLinks',checkpoint:'revision',preparation:'ordinal'}[progress.phase];
 if(!field||!Number.isSafeInteger(progress[field])||progress[field]<1)return null;
 return {phase:progress.phase,...(progress.phase==='preparation'?{ordinal:progress.ordinal}:{...(Number.isSafeInteger(progress.revision)&&progress.revision>=0?{revision:progress.revision}:{}),...(Number.isSafeInteger(progress.indexLinks)&&progress.indexLinks>=0?{indexLinks:progress.indexLinks}:{})}),cursorPersisted:true,cursorAdvanced:true};
}
export function createPublicServices({runtime,domain,reader,appSync,deadlineMs,now=()=>Date.now()}){
 if(!runtime?.writer||typeof runtime.locked!=='function'||!domain||!reader||!appSync||!Number.isSafeInteger(deadlineMs)||typeof now!=='function')throw Error('PUBLIC_SERVICES_CONFIG');
 const maintenanceView=()=>{const s=runtime.writer.status();return {due:s.replayFrames>=16,replayFrames:s.replayFrames,softLimit:16,hardLimit:64};};
 const ready=()=>{const s=runtime.writer.status();return {protocol:2,ready:true,store:s.storeId,generation:s.datasetGeneration,revision:s.revision,headHash:s.headHash,writerFence:s.writerFence,maintenance:maintenanceView()};};
 const optionalTime=()=>deadlineMs-now()>=8000;
 const ancillaryError=e=>({ok:false,error:codeOf(e),retryable:e?.retryable===true||['STORE_YIELD','WRITER_BUSY','IMPORT_STATUS_DEFERRED'].includes(codeOf(e))});
 function metadata(result,first){
  if(!first)return result;
  const deferred=()=>({ok:false,error:'IMPORT_STATUS_DEFERRED',retryable:true});
  let imports=deferred(),importStatus=deferred();
  if(optionalTime())try{imports={ok:true,result:reader.listImportedRuns({cursor:null,revision:result.revision})};}catch(e){imports=ancillaryError(e);}
  // Do not run another cold recovery after the preceding advisory failure.
  if(imports.ok&&optionalTime())try{importStatus={ok:true,result:reader.status({revision:result.revision})};}catch(e){importStatus=ancillaryError(e);}
  return {...result,syncMeta:{format:1,imports,importStatus,storageMaintenance:maintenanceView()}};
 }
 function guarded(action){return runtime.locked(()=>{try{return action();}catch(error){
  let progress=safeRecoveryProgress(error?.recovery);
  if(!progress&&error?.phase==='preparation')progress=safeRecoveryProgress(error);
  if(!progress&&error?.cursorPersisted===true&&Number.isSafeInteger(error.indexLinks)&&error.scannedLinks>0)progress={phase:'index',indexLinks:error.indexLinks,cursorPersisted:true,cursorAdvanced:true};
  else if(!progress&&error?.cursorPersisted===true&&error.cursorAdvanced===true&&Number.isSafeInteger(error.recoveredRevision))progress={phase:'frames',revision:error.recoveredRevision,cursorPersisted:true,cursorAdvanced:true};
  else if(!progress&&error?.retryable===true)try{progress=runtime.writer.continuationProgress();}catch(_){}
  progress=safeRecoveryProgress(progress);
  if(progress&&error?.retryable===true){error.code='WRITER_RECOVERY_PENDING';error.message=error.code;error.recovery=progress;}
  throw error;
 }});}
 const command=payload=>guarded(()=>domain.command(payload));
 return {
  command,commandV2:command,
  maintain:payload=>guarded(()=>{
   if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length)throw Error('STATUS_INVALID');
   runtime.writer.recoveryBarrier({persistFrameProgress:true});
   // Optional maintenance owns no record edits, identities or permissions. A
   // prepared checkpoint uses the existing immutable same-ID recovery path.
   if(runtime.writer.status().replayFrames>=16){runtime.writer._automaticCheckpoint();runtime.writer.recoveryBarrier({persistFrameProgress:true});}
   return ready();
  }),
  recover:payload=>guarded(()=>{
   if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('STATUS_INVALID');
   if(Object.keys(payload).join(',')==='pull'){
    const p=payload.pull;
    if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).sort().join(',')!=='cursor,minimumAcknowledged,since'||p.cursor!==null)throw Error('STATUS_INVALID');
    // Return one complete bounded protocol page, never a "ready" signal that
    // forces a second cold recovery. appSync enforces the identical proof,
    // identity, payload, byte and stable-cut rules used by an ordinary pull.
    return metadata(appSync.pull(p),true);
   }
   if(Object.keys(payload).length)throw Error('STATUS_INVALID');
   runtime.writer.recoveryBarrier({persistFrameProgress:true});const s=runtime.writer.status();return {protocol:2,ready:true,store:s.storeId,generation:s.datasetGeneration,revision:s.revision,headHash:s.headHash,writerFence:s.writerFence};
  }),
  snapshot:payload=>guarded(()=>metadata(domain.snapshot(payload),payload?.cursor===null)),
  pull:payload=>guarded(()=>metadata(appSync.pull(payload),payload?.cursor===null)),
  imports:payload=>guarded(()=>reader.listImportedRuns(payload)),
  route:payload=>guarded(()=>reader.readRoutePage(payload)),
  importStatus:payload=>guarded(()=>{if(!payload||Object.keys(payload).length)throw Error('STATUS_INVALID');return reader.status();})
 };
}
