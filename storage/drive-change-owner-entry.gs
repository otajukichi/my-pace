// Explicit owner-editor actions only. Nothing executes on source save or view.
// Set the nonsecret MYPACE_DRIVE_CHANGE_WEBHOOK Script Property once through
// owner project settings after separate activation approval. Source updates
// never overwrite it; this file never writes properties.
function myPaceDriveChangeOwner_(method) {
 var globals=myPaceOwnerGlobals_(),meter=MyPaceFolderImport.meteredGas(globals);
 var config=myPaceOwnerBootstrap_(meter).load();
 if(!config)throw new Error('OWNER_BOOTSTRAP_REQUIRED');
 config=myPaceOwnerRuntimeConfig_(meter.globals,config);config.sourceSubtree=true;
 var secret=globals.PropertiesService.getScriptProperties().getProperty('MYPACE_WRITER_SECRET');
 if(typeof secret!=='string'||secret.length<32)throw new Error('DRIVE_CHANGE_SECRET_REQUIRED');
 var runtime=MyPaceFolderImport.createGasImportRuntime(meter.globals,Object.assign({},config,{checkBudget:meter.checkBudget,deadlineMs:meter.deadlineMs}));
 var channelToken=function(id){return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(MyPaceFolderImport.driveChangeTokenInput(config.storeId,id),secret,Utilities.Charset.UTF_8)).replace(/=+$/,'');};
 var hints=MyPaceFolderImport.createGasDriveChangeHints(globals,{config:config,channelToken:channelToken});
 var discovery=MyPaceFolderImport.createDriveChangeDiscovery({runtime:runtime,Drive:meter.globals.Drive,config:config,canContinue:meter.checkBudget,randomId:function(){return Utilities.getUuid();},channelToken:channelToken,hints:hints});
 if(method==='activate'){
  var webhook=globals.PropertiesService.getScriptProperties().getProperty('MYPACE_DRIVE_CHANGE_WEBHOOK');
  if(webhook!=='https://my-pace-gules.vercel.app/api/drive-changes')throw new Error('DRIVE_CHANGE_WEBHOOK_CONFIG');
  return myPaceOwnerReport_(discovery.activate({webhookUrl:webhook}));
 }
 return myPaceOwnerReport_(discovery[method]());
}
function MyPaceDriveChangesActivate(){return myPaceDriveChangeOwner_('activate');}
function MyPaceDriveChangesPause(){return myPaceDriveChangeOwner_('pause');}
function MyPaceDriveChangesStatus(){return myPaceDriveChangeOwner_('status');}

function MyPaceDriveChangesResetExpiredCursor(){return myPaceDriveChangeOwner_('resetCursor');}
function MyPaceDriveChangesResolveExpiredWatch(){return myPaceDriveChangeOwner_('resolveExpiredWatch');}
