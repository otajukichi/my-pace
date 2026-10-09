// Explicit owner commands only. Saving/deploying does not enable a schedule.
// Backup excludes browser-local unsynced edits, raw source CSVs and credentials.
function myPaceBackupSchedule_(){return MyPaceFolderImport.createBackupSchedule(myPaceOwnerGlobals_(),{ownerEmail:MYPACE_IMPORT_OWNER});}
function myPaceBackupRun_(mode,event){
 var invocation=myPaceBackupInvocation_(myPaceOwnerGlobals_()),globals=invocation.globals,started=Date.now(),deadline=started+240000,restorePhase=null;
 var report=function(result){return myPaceOwnerReport_(Object.assign({},result,{usage:invocation.usage()}));};
 var budget=function(){return Date.now()<deadline-20000;};
 if(event)myPaceBackupSchedule_().authorizeEvent(event);
 else if(globals.Session.getActiveUser().getEmail().toLowerCase()!==MYPACE_IMPORT_OWNER||globals.Session.getEffectiveUser().getEmail().toLowerCase()!==MYPACE_IMPORT_OWNER)throw Error('BACKUP_OWNER_REQUIRED');
 var properties=globals.PropertiesService.getScriptProperties();
 var config=MyPaceFolderImport.parsePinnedOwnerStoreConfig(properties.getProperty(MyPaceFolderImport.OWNER_STORE_PROPERTY),{ownerEmail:MYPACE_IMPORT_OWNER,writerScriptId:globals.ScriptApp.getScriptId()});
 if(!config)throw Error('OWNER_BOOTSTRAP_REQUIRED');
 var lock=globals.LockService.getUserLock();if(!lock.tryLock(1000))return report({status:'backup-busy',nextAction:'Retry the same backup command later.'});
 try{
  var adapter=MyPaceFolderImport.createGasBackupAdapter(globals,config,{checkBudget:budget,deadlineMs:deadline});if(!adapter.ensure({create:mode==='backup'}))return report({status:'backup-not-configured'});var state=adapter.getState();
  if(mode==='status')return report({status:state.job?'backup-in-progress':state.latestManifest?'backup-complete':'backup-not-started',backupFolderId:adapter.getConfig().rootId,latestSnapshot:state.latestManifest?{revision:state.latestManifest.view.revision,createdAt:state.latestManifest.createdAt,objects:state.latestManifest.entries.length,hash:state.latestManifest.hash}:null,progress:state.job?{copied:state.job.copied,reused:state.job.reused,remaining:state.job.queue.length}:null,restoreProgress:myPaceBackupRestoreProgress_(state),lastRestore:state.lastRestore,lastFailure:state.lastFailure||null,lastCompletedAt:state.lastCompletedAt||null,schedule:myPaceBackupSchedule_().status()});
  if(mode==='history')return report(Object.assign({status:'backup-history',dateMeaning:'manifestCreatedAt is publication time; selected snapshot reports its actual cutoff'},adapter.listManifestPage(properties.getProperty('MYPACE_BACKUP_HISTORY_PAGE_TOKEN'))));
  if(mode==='restore'||mode==='restore-selected')return myPaceBackupRestore_(globals,config,adapter,budget,deadline,mode==='restore-selected',function(phase){restorePhase=phase;},report);
  if(mode==='export')return myPaceBackupExport_(globals,config,adapter,budget);
  var job=state.job;
  if(!job){
   var runtime=MyPaceFolderImport.createGasImportRuntime(globals,Object.assign({},myPaceOwnerRuntimeConfig_(globals,config),{checkBudget:budget,deadlineMs:deadline,protocolReadCache:{mode:'lock-phase'}}));
   var view=runtime.locked(function(){runtime.writer.recoveryBarrier();return runtime.writer.captureReadView();});
   job=MyPaceFolderImport.createBackupJob(view,state.latestManifest,new Date().toISOString());adapter.saveJob(job);
  }
  var result;do{result=MyPaceFolderImport.backupSlice(job,adapter,{maxFiles:4,canContinue:budget});job=result.job;}while(!result.manifest&&budget());
  if(result.manifest){
   // Publish immutable complete manifests before replacing the latest pointer.
   var manifestId=adapter.getState().pendingManifestId;if(!manifestId){manifestId=adapter.allocateId();adapter.saveState(Object.assign({},adapter.getState(),{pendingManifestId:manifestId}));}
   adapter.createBackup(manifestId,MyPaceFolderImport.encodeUtf8(JSON.stringify(result.manifest)),'complete-manifest');
   state=adapter.getState();adapter.saveState(Object.assign({},state,{job:null,pendingManifestId:null,latestManifest:result.manifest,latestManifestId:manifestId,lastFailure:null,lastCompletedAt:new Date().toISOString()}));
  }
  return report({status:result.manifest?'backup-complete':'backup-in-progress',backupFolderId:adapter.getConfig().rootId,elapsedMs:Date.now()-started,nextAction:result.manifest?'Run MyPaceBackupRestoreTest to verify an isolated restore.':'Run MyPaceBackupNow again to continue the same snapshot; previous completed backup is retained.'});
 }catch(error){var code=error.code||error.message;try{if(adapter&&adapter.getState())adapter.saveState(Object.assign({},adapter.getState(),{lastFailure:{code:code,at:new Date().toISOString()}}));}catch(ignore){}return report({status:code==='BACKUP_YIELD'?'backup-in-progress':'backup-failed',code:code,retryable:['BACKUP_YIELD','BACKUP_READ_UNRESOLVED','BACKUP_WRITE_UNCONFIRMED','BACKUP_STATE_WRITE_UNCONFIRMED','STORE_YIELD','WRITER_BUSY'].includes(code),elapsedMs:Date.now()-started,phase:restorePhase,restoreProgress:myPaceBackupAdapterRestoreProgress_(adapter),nextAction:'The production store was not replaced. Previous completed backup is retained. Retry the same command or report this code.'});}
 finally{lock.releaseLock();}
}
function MyPaceBackupNow(){return myPaceBackupRun_('backup');}
function MyPaceBackupStatus(){return myPaceBackupRun_('status');}
function MyPaceBackupHistory(){return myPaceBackupRun_('history');}
function MyPaceBackupRestoreSelected(){return myPaceBackupRun_('restore-selected');}
function MyPaceBackupExportRecovery(){return myPaceBackupRun_('export');}
function MyPaceBackupRestoreTest(){return myPaceBackupRun_('restore');}
function MyPaceBackupEnableDaily(){
 // A completed backup plus actual isolated restore is required before scheduling.
 var g=myPaceOwnerGlobals_();if(g.Session.getActiveUser().getEmail().toLowerCase()!==MYPACE_IMPORT_OWNER||g.Session.getEffectiveUser().getEmail().toLowerCase()!==MYPACE_IMPORT_OWNER)throw Error('BACKUP_OWNER_REQUIRED');
 var c=MyPaceFolderImport.parsePinnedOwnerStoreConfig(g.PropertiesService.getScriptProperties().getProperty(MyPaceFolderImport.OWNER_STORE_PROPERTY),{ownerEmail:MYPACE_IMPORT_OWNER,writerScriptId:g.ScriptApp.getScriptId()});if(!c)throw Error('OWNER_BOOTSTRAP_REQUIRED');
 var lock=g.LockService.getScriptLock();if(!lock.tryLock(1000))throw Error('BACKUP_BUSY');try{var a=MyPaceFolderImport.createGasBackupAdapter(g,c);if(!a.ensure({create:false}))throw Error('BACKUP_COMPLETE_REQUIRED');var s=a.getState();if(!s.latestManifest||!s.lastRestore||s.lastRestore.status!=='restore-verified'||s.lastRestore.manifestHash!==s.latestManifest.hash||s.lastRestore.manifestId!==s.latestManifestId)throw Error('BACKUP_RESTORE_TEST_REQUIRED');}finally{lock.releaseLock();}
 return myPaceOwnerReport_(myPaceBackupSchedule_().enable());
}
function myPaceBackupScheduled_(event){var r=myPaceBackupRun_('backup',event);var continuation=myPaceBackupSchedule_().continueAfter(event,r.status==='backup-in-progress'||r.status==='backup-busy'||r.retryable===true);var report=myPaceOwnerReport_(Object.assign({},r,continuation));if(r.status==='backup-failed'||continuation.continuationWindowExpired)throw Error(continuation.continuationWindowExpired?'BACKUP_CONTINUATION_WINDOW_EXPIRED':'BACKUP_SCHEDULED_FAILED');return report;}
function MyPaceBackupDailyTick(event){return myPaceBackupScheduled_(event);}
function MyPaceBackupContinueTick(event){return myPaceBackupScheduled_(event);}
function myPaceBackupRestore_(globals,source,adapter,budget,deadline,selected,reportPhase,report){
 report=report||myPaceOwnerReport_;
 reportPhase=reportPhase||function(){};reportPhase('select-snapshot');
 var state=adapter.getState(),selection=myPaceBackupSelection_(globals,source,adapter,selected),manifest=selection.manifest,manifestId=selection.manifestId;
 // Separate fixed property cannot replace mypace.production.store.v1.
 var existingJob=state.restoreManifestId===manifestId?state.restoreJob:null;
 var bootstrap=MyPaceFolderImport.createOwnerBootstrap(globals,{ownerEmail:MYPACE_IMPORT_OWNER,checkBudget:budget,propertyKey:'mypace.backup.restore.'+manifestId});
 // A durable job is written only after bootstrap and fence activation finish.
 // Reopening it validates the pinned folders and anchor without replaying history twice.
 reportPhase(existingJob?'reopen-target':'initialize-target');
 var target=existingJob?bootstrap.load():bootstrap.bootstrap();
 if(!target)throw Error('BACKUP_RESTORE_TARGET_MISSING');
 if(target.storeId===source.storeId||target.anchorId===source.anchorId)throw Error('BACKUP_RESTORE_PRODUCTION_FORBIDDEN');
 var runtime=MyPaceFolderImport.createGasImportRuntime(globals,Object.assign({},myPaceOwnerRuntimeConfig_(globals,target),{checkBudget:budget,deadlineMs:deadline,protocolReadCache:{mode:'lock-phase'}}));
 if(!existingJob){reportPhase('activate-isolated-target');MyPaceFolderImport.activateSyncV2(runtime);}
 var job=existingJob||MyPaceFolderImport.createRestoreJob(manifest,{storeId:target.storeId,anchorId:target.anchorId,writerScriptId:target.writerScriptId,datasetGeneration:target.datasetGeneration});
 reportPhase('persist-restore-job');
 var save=function(j){var current=adapter.getState();adapter.saveState(Object.assign({},current,{restoreJob:j,restoreManifestId:manifestId}));};save(job);
 var result={job:job,status:job.status};
 if(['restoring','pausing-imports'].includes(job.status))do{result=runtime.locked(function(){reportPhase(job.status==='pausing-imports'?'pause-restored-imports':'restore-records');return MyPaceFolderImport.restoreSlice(job,{manifest:manifest,readBackup:adapter.readBackup,writer:runtime.writer,saveJob:save},{maxEntities:8,canContinue:budget});});job=result.job;}while(['restoring','pausing-imports'].includes(result.status)&&budget());
 var makeReader=function(w,storeId,readAsset){return MyPaceFolderImport.createImportReader({runtime:{writer:w,store:new MyPaceFolderImport.ImportStoreBinding({writer:w,storeId:storeId,readAsset:readAsset,validateSourceCurrent:function(){return false;}}),locked:function(fn){return fn();}},sealCursor:JSON.stringify,openCursor:JSON.parse});};
 var verifyBudget=function(){return Date.now()<deadline-45000;};
 if(!['restoring','pausing-imports'].includes(job.status)&&verifyBudget())do{result=runtime.locked(function(){reportPhase(job.verification&&job.verification.scanDone&&!job.verification.pendingRoute?'write-restore-probe':'verify-restored-records');return MyPaceFolderImport.verifyRestoreSlice(job,{manifest:manifest,readBackup:adapter.readBackup,writer:runtime.writer,saveJob:save,makeImportReader:makeReader},{maxEntities:128,canContinue:verifyBudget});});job=result.job;}while(!['restore-probe-written','restore-verified'].includes(result.status)&&verifyBudget());

 state=adapter.getState();if(result.status==='restore-verified')adapter.saveState(Object.assign({},state,{restoreJob:result.job,lastRestore:{status:'restore-verified',manifestHash:manifest.hash,manifestId:manifestId,storeId:target.storeId,verifiedAt:new Date().toISOString()}}));
 return report({status:result.status,restoreProgress:myPaceBackupRestoreProgress_(adapter.getState()),testStoreId:target.storeId,manifestId:manifestId,capturedAt:manifest.createdAt,revision:manifest.view.revision,nextAction:result.status==='restore-verified'?(manifestId===state.latestManifestId?'Isolated test restore passed. Production configuration is unchanged. You may explicitly run MyPaceBackupEnableDaily.':'Selected older snapshot restored and verified in an isolated store. Production configuration and latest backup are unchanged.'):selected?'Run MyPaceBackupRestoreSelected again with the same manifest selection.':'Run MyPaceBackupRestoreTest again to resume the isolated restore.'});
}

function myPaceBackupSelection_(globals,source,adapter,selected){
 var state=adapter.getState(),id=selected?globals.PropertiesService.getScriptProperties().getProperty('MYPACE_BACKUP_RESTORE_MANIFEST_ID'):state.latestManifestId;
 if(!id)throw Error(selected?'BACKUP_MANIFEST_SELECTION_REQUIRED':'BACKUP_COMPLETE_REQUIRED');
 var bytes=adapter.readManifest(id);if(!bytes)throw Error('BACKUP_MANIFEST_MISSING');var manifest=JSON.parse(MyPaceFolderImport.decodeUtf8(bytes));MyPaceFolderImport.validateBackupManifest(manifest);
 if(manifest.view.storeId!==source.storeId||manifest.view.writerScriptId!==source.writerScriptId||manifest.view.anchorId!==source.anchorId)throw Error('BACKUP_MANIFEST_SOURCE_MISMATCH');return {manifest:manifest,manifestId:id};
}
function myPaceBackupExport_(globals,source,adapter,budget){
 var selected=!!globals.PropertiesService.getScriptProperties().getProperty('MYPACE_BACKUP_RESTORE_MANIFEST_ID'),selection=myPaceBackupSelection_(globals,source,adapter,selected),manifest=selection.manifest,state=adapter.getState();
 var job=state.exportJob&&state.exportJob.manifestId===selection.manifestId?state.exportJob:{manifestId:selection.manifestId,manifestHash:manifest.hash,position:0,cursor:null,values:{},done:false,fileId:null};
 if(job.manifestHash!==manifest.hash)throw Error('BACKUP_EXPORT_MANIFEST_MISMATCH');
 while(!job.done&&budget()){
  var page=MyPaceFolderImport.readBackupEntities(manifest,adapter.readBackup,{position:job.position,cursor:job.cursor,limit:8,canContinue:budget});
  page.entries.forEach(function(e){if(!e.deleted&&e.key.indexOf('app/data/')===0)job.values[e.key.slice(9)]=e.value;});job.position=page.position;job.cursor=page.cursor;job.done=page.done;
  adapter.saveState(Object.assign({},adapter.getState(),{exportJob:job}));
 }
 if(!job.done)return myPaceOwnerReport_({status:'backup-export-in-progress',manifestId:selection.manifestId,nextAction:'Run MyPaceBackupExportRecovery again with the same selection.'});
 var bytes=MyPaceFolderImport.encodeUtf8(MyPaceSecureSync.exportRecoveryAppJSON(job.values));if(bytes.length>4194304)throw Error('BACKUP_EXPORT_CAPACITY');
 if(!job.fileId){job.fileId=adapter.allocateId();adapter.saveState(Object.assign({},adapter.getState(),{exportJob:job}));}
 adapter.createBackup(job.fileId,bytes,'app-recovery-export');return myPaceOwnerReport_({status:'backup-export-complete',fileId:job.fileId,manifestId:selection.manifestId,capturedAt:manifest.createdAt,revision:manifest.view.revision,scope:'App records JSON for the existing importer. Imported route bodies remain in the snapshot archive.',nextAction:'Download this JSON from the private backup folder. No production import or switch has been performed.'});
}

function myPaceBackupRestoreProgress_(state){var j=state&&state.restoreJob;if(!j)return null;var v=j.verification;return {phase:j.status,position:j.position,restored:j.restored,pendingEntities:j.pendingRestore?j.pendingRestore.entries.length:0,verifiedRecords:v?v.records:0,verifiedRoutePages:v?v.routePages:0,scanDone:v?!!v.scanDone:false};}

function myPaceBackupAdapterRestoreProgress_(adapter){try{return adapter?myPaceBackupRestoreProgress_(adapter.getState()):null;}catch(ignore){return null;}}

// One short owner invocation: do not persist credentials or cache across runs.
// Counts are local increments only; they add no diagnostic Drive requests.
function myPaceBackupInvocation_(original){
 var started=Date.now(),counts={metadataReads:0,remoteRequests:0,writes:0,idAllocations:0,tokenRequests:0},token=null,files=Object.assign({},original.Drive&&original.Drive.Files);
 ['get','list','create','update','generateIds'].forEach(function(name){if(typeof original.Drive?.Files?.[name]!=='function')return;var fn=original.Drive.Files[name];files[name]=function(){counts[name==='get'||name==='list'?'metadataReads':name==='generateIds'?'idAllocations':'writes']++;return fn.apply(original.Drive.Files,arguments);};});
 var gasFetch=original.UrlFetchApp&&original.UrlFetchApp.fetch;
 var globals=Object.assign({},original,{Drive:Object.assign({},original.Drive,{Files:files}),UrlFetchApp:Object.assign({},original.UrlFetchApp,{fetch:function(){counts.remoteRequests++;return gasFetch.apply(original.UrlFetchApp,arguments);}}),ScriptApp:Object.assign({},original.ScriptApp,{getScriptId:function(){return original.ScriptApp.getScriptId();},getOAuthToken:function(){if(token===null){counts.tokenRequests++;token=original.ScriptApp.getOAuthToken();if(typeof token!=='string'||!token)throw Error('BACKUP_AUTH_UNRESOLVED');}return token;}})});
 if(typeof original.UrlFetchApp?.fetchAll==='function')globals.UrlFetchApp.fetchAll=function(requests){counts.remoteRequests+=Array.isArray(requests)?requests.length:1;return original.UrlFetchApp.fetchAll(requests);};
 return {globals:globals,usage:function(){return Object.assign({},counts,{elapsedMs:Date.now()-started});}};
}
