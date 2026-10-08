// Explicit owner-editor maintenance only. No web route or trigger installer.
// Repair pins optional configuration; Recover verifies existing immutable history.
function myPaceOwnerMaintenanceSetup_(error,meter) {
  var code=error&& (error.code||error.message);
  var actions={
    OWNER_BOOTSTRAP_REQUIRED:'No production store is configured. Use MyPaceImportBootstrap only for an explicitly requested first store; never clear an existing store configuration.',
    OWNER_RECOVERY_SECRET_REQUIRED:'Keep the existing owner-managed MYPACE_WRITER_SECRET. If it is absent or invalid, configure it privately in this same project, then run MyPaceRepairRecoveryConfiguration.',
    CHECKPOINT_HINT_AUTH_REQUIRED:'Check the existing owner-managed MYPACE_WRITER_SECRET and Apps Script Utilities support, then run MyPaceRepairRecoveryConfiguration. Do not replace the store or silently rotate an existing key.',
    OWNER_RECOVERY_CONFIGURATION_REQUIRED:'Run MyPaceRepairRecoveryConfiguration in this existing project, then run MyPaceRecoverStorage.',
    WRITER_RECOVERY_SETUP_REQUIRED:'Run MyPaceRepairRecoveryConfiguration with the existing owner-managed secret, then repeat MyPaceRecoverStorage. Preserve all original storage IDs and history.'
  };
  if(!Object.prototype.hasOwnProperty.call(actions,code))throw error;
  return myPaceOwnerReport_({status:'setup-needed',code:code,requiresOwnerAction:true,nextAction:actions[code],usage:meter.usage()});
}
function MyPaceRepairRecoveryConfiguration() {
  var meter=MyPaceFolderImport.meteredGas(myPaceOwnerGlobals_());
  try{
    var config=myPaceOwnerBootstrap_(meter).repairRecoveryConfiguration();
    return myPaceOwnerReport_({status:'recovery-configured',config:config,nextAction:'Run MyPaceRecoverStorage until it reports ready.',usage:meter.usage()});
  }catch(error){return myPaceOwnerMaintenanceSetup_(error,meter);}
}
function MyPaceRecoverStorage() {
  var meter=MyPaceFolderImport.meteredGas(myPaceOwnerGlobals_());
  try{
    var config=myPaceOwnerBootstrap_(meter).loadRecoveryConfiguration();
    if(!config)throw new Error('OWNER_BOOTSTRAP_REQUIRED');
    if(!config.checkpointHintId)throw new Error('OWNER_RECOVERY_CONFIGURATION_REQUIRED');
    var runtimeConfig=myPaceOwnerRuntimeConfig_(meter.globals,config);
    if(!runtimeConfig.checkpointHintCodec)throw new Error('OWNER_RECOVERY_SECRET_REQUIRED');
    var runtime=MyPaceFolderImport.createGasImportRuntime(meter.globals,Object.assign({},runtimeConfig,{checkBudget:meter.checkBudget,deadlineMs:meter.hardDeadlineMs,protocolReadCache:{mode:'lock-phase'}}));
    var state=runtime.locked(function(){return runtime.writer.recoveryBarrier();});
    return myPaceOwnerReport_({status:'ready',storage:state,usage:meter.usage()});
  }catch(error){
    var code=error&& (error.code||error.message);
    if(code==='WRITER_RECOVERY_PENDING')return myPaceOwnerReport_({status:'recovering',code:code,indexLinks:error.indexLinks,scannedLinks:error.scannedLinks,cursorPersisted:error.cursorPersisted===true,nextAction:'Run MyPaceRecoverStorage again to continue bounded recovery.',usage:meter.usage()});
    if(['OWNER_BOOTSTRAP_YIELD','OWNER_BUDGET_YIELD','STORE_YIELD','IMPORT_YIELD'].indexOf(code)>=0)return myPaceOwnerReport_({status:'recovering',code:code,nextAction:'This bounded slice reached its work budget. Run MyPaceRecoverStorage again; keep the existing store configuration.',usage:meter.usage()});
    return myPaceOwnerMaintenanceSetup_(error,meter);
  }
}

// Run once after updating this same project to repair slow app cold reads.
// It verifies existing history, saves authenticated recovery progress, and only
// then appends a no-business-change checkpoint. Never starts/resets CSV import.
function MyPacePrepareWebSync() {
  var meter=MyPaceFolderImport.meteredGas(myPaceOwnerGlobals_());
  try {
    var config=myPaceOwnerBootstrap_(meter).loadRecoveryConfiguration();
    if(!config)throw new Error('OWNER_BOOTSTRAP_REQUIRED');
    if(!config.checkpointHintId)throw new Error('OWNER_RECOVERY_CONFIGURATION_REQUIRED');
    var runtimeConfig=myPaceOwnerRuntimeConfig_(meter.globals,config);
    if(!runtimeConfig.checkpointHintCodec)throw new Error('OWNER_RECOVERY_SECRET_REQUIRED');
    var common=Object.assign({},runtimeConfig,{checkBudget:meter.checkBudget,deadlineMs:meter.hardDeadlineMs,protocolReadCache:{mode:'lock-phase'}});
    var result=MyPaceFolderImport.prepareWebRead(MyPaceFolderImport.createGasImportRuntime(meter.globals,common));
    if(meter.hardDeadlineMs-Date.now()<20000)return myPaceOwnerReport_({status:'prepared',sealed:result.sealed,revision:result.storage.revision,replayFrames:result.storage.replayFrames,webProbe:'not-run',nextAction:'The existing history is verified and its recovery tail is prepared. Try one app sync; report its result if it is still blocked.',usage:meter.usage()});
    var probeStarted=Date.now(),before=meter.usage(),cold=MyPaceFolderImport.createGasImportRuntime(meter.globals,Object.assign({},common,{writerLimits:{maxIndexScanLinks:8},deadlineMs:probeStarted+20000,checkBudget:function(){return meter.checkBudget()&&Date.now()-probeStarted<20000;}}));
    try {
      var state=cold.locked(function(){cold.writer.recoveryBarrier();return cold.writer.status();});
      return myPaceOwnerReport_({status:'ready',sealed:result.sealed,revision:state.revision,replayFrames:state.replayFrames,webProbe:{scope:'cold-storage-recovery',ok:true,calls:meter.usage().calls-before.calls,elapsedMs:Date.now()-probeStarted},nextAction:'Return to the app and run sync once. CSV import remains at its saved position.',usage:meter.usage()});
    } catch(probeError) {
      var probeCode=probeError.code||probeError.message;
      if(['STORE_YIELD','OWNER_BUDGET_YIELD','IMPORT_YIELD','WRITER_RECOVERY_PENDING'].indexOf(probeCode)<0)throw probeError;
      return myPaceOwnerReport_({status:'web-budget-blocked',sealed:result.sealed,revision:result.storage.revision,replayFrames:result.storage.replayFrames,code:probeCode,webProbe:{scope:'cold-storage-recovery',ok:false,calls:meter.usage().calls-before.calls,elapsedMs:Date.now()-probeStarted},nextAction:'History is verified, but the cold web budget is still insufficient. Report this result; do not repeatedly sync or recreate the store.',usage:meter.usage()});
    }
  } catch(error) {
    var code=error.code||error.message;
    if(code==='WRITER_RECOVERY_PENDING')return myPaceOwnerReport_({status:'recovering',code:code,indexLinks:error.indexLinks,scannedLinks:error.scannedLinks,cursorPersisted:error.cursorPersisted===true,nextAction:'A bounded INDEX slice was checked. Continue only if its persisted cursor is advancing.',usage:meter.usage()});
    if(['OWNER_BOOTSTRAP_YIELD','OWNER_BUDGET_YIELD','STORE_YIELD','IMPORT_YIELD'].indexOf(code)>=0)return myPaceOwnerReport_({status:error.cursorAdvanced===true?'recovering':'recovery-budget-blocked',code:code,recoveredRevision:error.recoveredRevision||null,cursorPersisted:error.cursorPersisted===true,cursorAdvanced:error.cursorAdvanced===true,nextAction:error.cursorAdvanced===true?'Verified frame progress was saved. Run MyPacePrepareWebSync again to continue.':'No new recovery cursor was confirmed. Report this result rather than repeating the same work.',usage:meter.usage()});
    return myPaceOwnerMaintenanceSetup_(error,meter);
  }
}

// Explicit, irreversible format migration. Run from the existing owner's editor
// only AFTER the owner accepts that older storage bundles will fail closed.
// This does not create a store, change IDs/generation, rotate a key, or delete
// records. Repeat this same function after an ambiguous response; its migration
// operation identity is deterministic and the original receipt is reused.
function MyPaceEnableIncrementalSync() {
  var meter=MyPaceFolderImport.meteredGas(myPaceOwnerGlobals_());
  try {
    var config=myPaceOwnerBootstrap_(meter).loadRecoveryConfiguration();
    if(!config)throw new Error('OWNER_BOOTSTRAP_REQUIRED');
    if(!config.checkpointHintId)throw new Error('OWNER_RECOVERY_CONFIGURATION_REQUIRED');
    var runtimeConfig=myPaceOwnerRuntimeConfig_(meter.globals,config);
    if(!runtimeConfig.checkpointHintCodec)throw new Error('OWNER_RECOVERY_SECRET_REQUIRED');
    var rest=MyPaceFolderImport.createGasDriveRest(meter.globals,{deadlineMs:meter.hardDeadlineMs,checkBudget:meter.checkBudget});
    var runtime=MyPaceFolderImport.createGasImportRuntime(meter.globals,Object.assign({},runtimeConfig,{checkBudget:meter.checkBudget,deadlineMs:meter.hardDeadlineMs,protocolReadCache:{mode:'lock-phase'},restTransport:rest,progressiveRecovery:true,canContinueRecovery:function(){return Date.now()<meter.hardDeadlineMs-7000;},canWriteHint:function(){return rest.canStartAdvisory();}}));
    var result=MyPaceFolderImport.activateSyncV2(runtime);
    return myPaceOwnerReport_({status:'incremental-sync-enabled',alreadyEnabled:result.alreadyEnabled,storeId:result.storage.storeId,datasetGeneration:result.storage.datasetGeneration,revision:result.storage.revision,writerFence:result.storage.writerFence,compatibility:'Older storage bundles must not be restored. Use only a fence-aware writer for fixes or rollback.',usage:meter.usage()});
  } catch(error) {
    var code=error&& (error.code||error.message);
    if(['WRITER_RECOVERY_PENDING','OWNER_BOOTSTRAP_YIELD','OWNER_BUDGET_YIELD','STORE_YIELD','IMPORT_YIELD','WRITER_COMMIT_UNRESOLVED','STORE_REQUEST_UNRESOLVED'].indexOf(code)>=0)return myPaceOwnerReport_({status:'activation-pending',code:code,requiresOwnerAction:true,nextAction:'The result is not confirmed. Keep the existing project, store, IDs and secret; run MyPaceEnableIncrementalSync again to recover its original operation.',usage:meter.usage()});
    return myPaceOwnerMaintenanceSetup_(error,meter);
  }
}
