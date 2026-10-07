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
