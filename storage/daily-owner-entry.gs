// Explicit editor actions only; deployment does not activate preparation.
function myPaceDailyOwner_(method){
 var globals=myPaceOwnerGlobals_(),meter=MyPaceFolderImport.meteredGas(globals);
 var config=myPaceOwnerBootstrap_(meter).load();if(!config)throw new Error('OWNER_BOOTSTRAP_REQUIRED');
 config=myPaceOwnerRuntimeConfig_(meter.globals,config);config.sourceSubtree=true;
 var runtime=MyPaceFolderImport.createGasImportRuntime(meter.globals,Object.assign({},config,{checkBudget:meter.checkBudget,deadlineMs:meter.deadlineMs}));
 var daily=MyPaceFolderImport.createGasDailyMaterializer(meter.globals,{runtime:runtime,config:config,checkBudget:meter.checkBudget});
 return myPaceOwnerReport_(daily[method]());
}
function MyPaceDailyRoutesActivate(){return myPaceDailyOwner_('activate');}
function MyPaceDailyRoutesPause(){return myPaceDailyOwner_('pause');}
function MyPaceDailyRoutesStatus(){return myPaceDailyOwner_('status');}
function MyPaceDailyRoutesResume(){return myPaceDailyOwner_('tick');}
