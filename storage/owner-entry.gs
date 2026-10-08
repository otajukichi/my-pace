// Paste this complete kit only into the existing owner-authorized Apps Script
// project. Run functions from its editor; do not deploy this as a web app.
var MYPACE_IMPORT_OWNER = 'yakitorihanbagu0412@gmail.com';
function myPaceOwnerGlobals_() {
  return {Drive:Drive, Utilities:Utilities, UrlFetchApp:UrlFetchApp,
    ScriptApp:ScriptApp, LockService:LockService, Session:Session,
    PropertiesService:PropertiesService, CacheService:typeof CacheService==='undefined'?undefined:CacheService};
}
function myPaceOwnerBootstrap_(meter) {
  return MyPaceFolderImport.createOwnerBootstrap(meter.globals, {
    ownerEmail:MYPACE_IMPORT_OWNER, checkBudget:meter.checkBudget
  });
}
function myPaceOwnerRuntimeConfig_(globals,config) {
  if(!config.checkpointHintId&&!config.discoveryStateId) return config;
  var secret=globals.PropertiesService.getScriptProperties().getProperty('MYPACE_WRITER_SECRET');
  if(secret===null||secret===undefined||secret==='') return config;
  return Object.assign({},config,config.checkpointHintId?{checkpointHintCodec:MyPaceFolderImport.createGasCheckpointHintCodec({Utilities:globals.Utilities,secret:secret}),preparationCodec:MyPaceFolderImport.createGasPreparationCodec({Utilities:globals.Utilities,secret:secret})}:{},config.discoveryStateId?{discoveryStateCodec:MyPaceFolderImport.createGasDiscoveryStateCodec({Utilities:globals.Utilities,secret:secret})}:{});
}
function myPaceOwnerReport_(result) { console.log(JSON.stringify(result)); return result; }
function myPaceOwnerRun_(method) {
  var meter=MyPaceFolderImport.meteredGas(myPaceOwnerGlobals_());
  var config=myPaceOwnerBootstrap_(meter).load();
  if(!config) throw new Error('OWNER_BOOTSTRAP_REQUIRED');
  var result=MyPaceFolderImport.createOwnerScheduler(meter.globals,myPaceOwnerRuntimeConfig_(meter.globals,config),{deadlineMs:meter.hardDeadlineMs})[method]();
  result.usage=meter.usage();
  return myPaceOwnerReport_(result);
}
// Explicit first-write action: reserves and pins a new private app store.
// Repeat calls resume/verify the SAME IDs; never reset its property or folders.
function MyPaceImportBootstrap() { var meter=MyPaceFolderImport.meteredGas(myPaceOwnerGlobals_()); var config=myPaceOwnerBootstrap_(meter).bootstrap(); return myPaceOwnerReport_({config:config,usage:meter.usage()}); }
// Start a new scan only when idle/complete; a repeated click does not reset work.
function MyPaceImportStart() { return myPaceOwnerRun_('start'); }
function MyPaceImportResume() { return myPaceOwnerRun_('resume'); }
function MyPaceImportStatus() { return myPaceOwnerRun_('status'); }
// Explicitly retry a blocked cursor after fixing/reviewing its cause.
function MyPaceImportRetryBlocked() { return myPaceOwnerRun_('retryBlocked'); }
// Explicitly abandon a changed/missing unfinished source generation. Preserves
// the last published run and original CSV, releases its staging pin without
// deleting files, and returns idle. Run Start to enumerate the current folder.
function MyPaceImportRestartChangedSource() { return myPaceOwnerRun_('restartChangedSource'); }
