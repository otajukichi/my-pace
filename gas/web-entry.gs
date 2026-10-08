// Add to the SAME owner-authorized project and generated storage bundle.
// Secrets are ScriptProperties only, entered by the owner outside chat.
// This endpoint NEVER bootstraps, installs triggers, or returns OAuth tokens.
function doGet() { return ContentService.createTextOutput(JSON.stringify({ok:false,error:'POST_REQUIRED'})).setMimeType(ContentService.MimeType.JSON); }
function doPost(event) {
 var output;
 try {
  var props=PropertiesService.getScriptProperties();
  var secret=props.getProperty('MYPACE_WRITER_SECRET');
  var store=props.getProperty('MYPACE_STORE_ID');
  var owner='yakitorihanbagu0412@gmail.com';
  var hmac=function(text,key){return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text,key,Utilities.Charset.UTF_8)).replace(/=+$/,'');};
  var started=Date.now();
  var dispatch=MyPaceSecureSync.createSignedDispatcher({owner:owner,store:store,secret:secret,hmac:hmac,byteLength:function(text){return Utilities.newBlob(text).getBytes().length;},createServices:function(action){
   var globals=myPaceOwnerGlobals_();
   if(Session.getEffectiveUser().getEmail().trim().toLowerCase()!==owner)throw new Error('EFFECTIVE_OWNER_MISMATCH');
   var config=MyPaceFolderImport.parsePinnedOwnerStoreConfig(props.getProperty(MyPaceFolderImport.OWNER_STORE_PROPERTY),{ownerEmail:owner,writerScriptId:ScriptApp.getScriptId()});
   if(!config||config.storeId!==store)throw new Error('PINNED_STORE_MISMATCH');
   var deadline=started+(['command','commandV2','recover','maintain','pull','snapshot'].indexOf(action)>=0?45000:20000),checkBudget=function(){return Date.now()<deadline;};
   var rest=MyPaceFolderImport.createGasDriveRest(globals,{deadlineMs:deadline,checkBudget:checkBudget,advisoryMinMs:4000});
   var runtime=MyPaceFolderImport.createGasImportRuntime(globals,Object.assign({},config,{checkpointHintCodec:config.checkpointHintId?MyPaceFolderImport.createGasCheckpointHintCodec({Utilities:Utilities,secret:secret}):undefined,preparationCodec:config.checkpointHintId?MyPaceFolderImport.createGasPreparationCodec({Utilities:Utilities,secret:secret}):undefined,preparedAppAdapter:MyPaceSecureSync.createPreparedAppCommand,canContinuePreparation:function(reserve){return Date.now()<deadline-(reserve||8000);},protocolReadCache:{mode:'lock-phase'},managedWritePhase:true,trustManagedRecoveryPrefix:action!=='maintain',writerLimits:{maxIndexScanLinks:8,checkpointEvery:64},deadlineMs:deadline,checkBudget:checkBudget,restTransport:rest,progressiveRecovery:true,canContinueRecovery:function(){return Date.now()<deadline-7000;},canWriteHint:function(){return rest.canStartAdvisory();}}));
   var domain=MyPaceSecureSync.createAppDomain({writer:runtime.writer,locked:runtime.locked,digest:function(text){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');}});
   var cursorOptions={secret:secret,hmac:hmac,encode:function(text){return Utilities.base64EncodeWebSafe(text,Utilities.Charset.UTF_8).replace(/=+$/,'');},decode:function(text){return Utilities.newBlob(Utilities.base64DecodeWebSafe(text)).getDataAsString('UTF-8');}};
   var cursors=MyPaceSecureSync.createCursorCodec(cursorOptions);
   var appCursors=MyPaceSecureSync.createCursorCodec(Object.assign({},cursorOptions,{ttlMs:86400000,domain:'app-sync-v2'}));
   var reader=MyPaceFolderImport.createImportReader(Object.assign({runtime:runtime},cursors));
   var appSync=MyPaceSecureSync.createAppSyncV2(Object.assign({writer:runtime.writer,locked:runtime.locked,canContinue:function(){return Date.now()<deadline-3000;}},appCursors));
   return MyPaceSecureSync.createPublicServices({runtime:runtime,domain:domain,reader:reader,appSync:appSync,deadlineMs:deadline});
  }});
  output=dispatch(event&&event.postData&&event.postData.contents);
 }catch(e){output={ok:false,error:'SERVICE_NOT_CONFIGURED',retryable:false};}
 return ContentService.createTextOutput(JSON.stringify(output)).setMimeType(ContentService.MimeType.JSON);
}
