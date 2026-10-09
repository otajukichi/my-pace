import {validateBackupManifest,createBackupDailyAssetReader,createBackupAssetReader} from './incremental-backup.mjs';
import {writerDigest} from './reserved-writer.mjs';
import {validateDailyHead} from './daily-reader.mjs';
import {encodeUtf8,decodeUtf8,IncrementalSha256} from './codec.mjs';
export const BACKUP_CONFIG_PROPERTY='mypace.backup.config.v1';
const FOLDER='application/vnd.google-apps.folder',MIME='application/octet-stream';
const FIELDS='id,parents,mimeType,trashed,ownedByMe,shared,size,appProperties';
const fail=code=>{throw Error(code);};
const validId=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const sha=b=>new IncrementalSha256().update(b).digestHex();
export function createGasBackupAdapter(globals,source,{checkBudget=()=>true,deadlineMs=Date.now()+240000,propertyKey=BACKUP_CONFIG_PROPERTY}={}){
 const {Drive,Utilities,UrlFetchApp,ScriptApp,PropertiesService}=globals;
 const properties=PropertiesService.getScriptProperties();let config=null,state=null,archiveHead=null,archiveReader=null;
 function budget(){if(checkBudget()!==true||Date.now()>deadlineMs-10000)fail('BACKUP_YIELD');}
 function metadata(id){budget();try{return Drive.Files.get(id,{fields:FIELDS});}catch(e){if(/(?:404|not found|File not found)/i.test(String(e.message)))return null;throw e;}}
 function privateMeta(m,parent,mime){if(!m||m.trashed!==false||m.ownedByMe!==true||m.shared!==false||m.mimeType!==mime||(parent&&(!Array.isArray(m.parents)||m.parents.length!==1||m.parents[0]!==parent)))fail('BACKUP_PRIVATE_METADATA_REQUIRED');return m;}
 function allocateId(){budget();const r=Drive.Files.generateIds({count:1,space:'drive',type:'files'});if(!r||!r.ids||r.ids.length!==1||!validId(r.ids[0]))fail('BACKUP_ID_INVALID');return r.ids[0];}
 function body(id,m,maxBytes=4194304){const size=Number(m.size);if(!Number.isSafeInteger(size)||size<1||size>maxBytes)fail('BACKUP_SIZE_INVALID');budget();const r=UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?alt=media',{method:'get',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},followRedirects:false,muteHttpExceptions:true,timeoutSeconds:Math.min(30,Math.max(1,Math.floor((deadlineMs-Date.now()-5000)/1000)))});if(r.getResponseCode()!==200)fail('BACKUP_READ_UNRESOLVED');const b=Uint8Array.from(r.getContent(),v=>v&255);if(b.length!==size)fail('BACKUP_SIZE_MISMATCH');return b;}
 function blob(bytes){return Utilities.newBlob(Array.from(bytes,v=>v>127?v-256:v),MIME);}
 function loadConfig(){const raw=properties.getProperty(propertyKey);if(!raw)return null;let c;try{c=JSON.parse(raw);}catch(_){fail('BACKUP_CONFIG_INVALID');}if(c.protocol!=='mypace-private-backup-v1'||c.sourceStoreId!==source.storeId||c.writerScriptId!==ScriptApp.getScriptId()||!validId(c.rootId)||!validId(c.stateId)||!validId(c.parentId)||c.parentId!==source.myDriveRootId&&source.myDriveRootId!==undefined||c.rootId===source.rootParentId||c.stateId===c.rootId)fail('BACKUP_CONFIG_INVALID');return c;}
 function ensure({create=true,loadState=true}={}){config=loadConfig();if(!config&&!create)return null;if(!config){const root=privateMeta(metadata('root'),null,FOLDER);config={protocol:'mypace-private-backup-v1',sourceStoreId:source.storeId,writerScriptId:ScriptApp.getScriptId(),rootId:allocateId(),stateId:allocateId(),parentId:root.id};const raw=JSON.stringify(config);properties.setProperty(propertyKey,raw);if(properties.getProperty(propertyKey)!==raw)fail('BACKUP_CONFIG_UNCONFIRMED');}
  let m=metadata(config.rootId);if(!m){if(!create)fail('BACKUP_FOLDER_MISSING');budget();Drive.Files.create({id:config.rootId,name:'MyPace Backups',mimeType:FOLDER,parents:[config.parentId],appProperties:{'mypace.backup':'v1','mypace.source':source.storeId}},null,{fields:'id',ignoreDefaultVisibility:true});m=metadata(config.rootId);}privateMeta(m,config.parentId,FOLDER);if(m.appProperties?.['mypace.backup']!=='v1'||m.appProperties?.['mypace.source']!==source.storeId)fail('BACKUP_FOLDER_MISMATCH');
  if(loadState)state=readState()||{protocol:'mypace-backup-state-v1',job:null,latestManifest:null,lastRestore:null};return config;
 }
 function requireRoot(){if(!config)fail('BACKUP_NOT_INITIALIZED');privateMeta(metadata(config.rootId),config.parentId,FOLDER);}
 function readBackup(id,maxBytes=4194304){if(!validId(id))fail('BACKUP_ID_INVALID');requireRoot();const m=metadata(id);if(!m)return null;privateMeta(m,config.rootId,MIME);if(m.appProperties?.['mypace.backup']!=='v1'||m.appProperties?.['mypace.source']!==source.storeId)fail('BACKUP_FILE_MISMATCH');return body(id,m,maxBytes);}
 function createBackup(id,bytes,role){if(!validId(id)||!(bytes instanceof Uint8Array)||bytes.length>4194304)fail('BACKUP_WRITE_INVALID');requireRoot();const existing=readBackup(id);if(existing){if(sha(existing)!==sha(bytes))fail('BACKUP_IMMUTABLE_COLLISION');return;}budget();Drive.Files.create({id,name:'mypace-backup-'+role+'-'+id+(role==='app-recovery-export'?'.json':''),mimeType:MIME,parents:[config.rootId],appProperties:{'mypace.backup':'v1','mypace.source':source.storeId,'mypace.role':String(role).slice(0,80)}},blob(bytes),{fields:'id',ignoreDefaultVisibility:true});const actual=readBackup(id);if(!actual||sha(actual)!==sha(bytes))fail('BACKUP_WRITE_UNCONFIRMED');}
 function readState(){const b=readBackup(config.stateId);if(!b)return null;let s;try{s=JSON.parse(decodeUtf8(b));}catch(_){fail('BACKUP_STATE_INVALID');}if(s.protocol!=='mypace-backup-state-v1')fail('BACKUP_STATE_INVALID');return s;}
 function saveState(next){const bytes=encodeUtf8(JSON.stringify(next));if(bytes.length>4194304)fail('BACKUP_STATE_CAPACITY');requireRoot();if(metadata(config.stateId)){budget();Drive.Files.update({},config.stateId,blob(bytes),{fields:'id'});}else createBackup(config.stateId,bytes,'state');const actual=readBackup(config.stateId);if(!actual||sha(actual)!==sha(bytes))fail('BACKUP_STATE_WRITE_UNCONFIRMED');state=next;}
 function saveJob(job){saveState({...state,job});}
 function readSource(ref){if(ref.kind==='asset'&&archiveHead){if(!archiveReader)archiveReader=createGasRestoredDailyAssetReader(globals,{config:source,head:archiveHead,checkBudget});if(archiveReader.hasImported(ref.id))return ref.reservation.storeId===source.storeId?archiveReader.readImported(ref.reservation):archiveReader(ref.reservation);}if(!validId(ref.id))fail('BACKUP_SOURCE_ID_INVALID');privateMeta(metadata(source.rootParentId),null,FOLDER);const parent=ref.kind==='asset'?source.assetsParentId:source.metadataParentId;privateMeta(metadata(parent),source.rootParentId,FOLDER);const m=privateMeta(metadata(ref.id),parent,MIME);if(m.appProperties?.['mypace.store']!==source.storeId)fail('BACKUP_SOURCE_STORE_MISMATCH');if(ref.kind==='asset'&&(m.appProperties?.['mypace.sha256']!==ref.hash||Number(m.size)!==ref.byteLength))fail('BACKUP_SOURCE_ASSET_MISMATCH');return body(ref.id,m,ref.kind==='asset'?4194304:4194304);}
 function listManifestPage(pageToken){requireRoot();if(pageToken!==undefined&&pageToken!==null&&(typeof pageToken!=='string'||pageToken.length>4096))fail('BACKUP_PAGE_TOKEN_INVALID');budget();const r=Drive.Files.list({q:"'"+config.rootId+"' in parents and trashed = false and appProperties has { key='mypace.role' and value='complete-manifest' }",pageSize:50,orderBy:'createdTime desc',fields:'nextPageToken,files('+FIELDS+',name,createdTime)',...(pageToken?{pageToken}:{})});if(!r||!Array.isArray(r.files)||r.files.length>50)fail('BACKUP_HISTORY_INVALID');return {manifests:r.files.map(m=>{privateMeta(m,config.rootId,MIME);if(m.appProperties?.['mypace.backup']!=='v1'||m.appProperties?.['mypace.source']!==source.storeId||m.appProperties?.['mypace.role']!=='complete-manifest'||!validId(m.id))fail('BACKUP_HISTORY_INVALID');return {manifestId:m.id,name:m.name,manifestCreatedAt:m.createdTime};}),nextPageToken:r.nextPageToken||null};}
 function readManifest(id){if(!validId(id))fail('BACKUP_ID_INVALID');const m=metadata(id);if(m?.appProperties?.['mypace.role']!=='complete-manifest')fail('BACKUP_MANIFEST_ROLE_INVALID');return readBackup(id,4194304);}
 return {bindArchive(head){archiveHead=head;archiveReader=null;},listManifestPage,readManifest,ensure,allocateId,readSource,readBackup,createBackup,saveJob,saveState,getState:()=>state,getConfig:()=>config};
}

// A restored fast read never attempts production asset IDs. The signed target
// head pins both the archive's immutable ID and hash; normal backup ownership
// and private-folder checks still apply. No writer replay or source read occurs.
export function createGasRestoredDailyAssetReader(globals,{config,head,checkBudget=()=>true}){
 if(head?.archiveOnly===true){if(head.schema!==1||head.storeId!==config.storeId||head.generation!==config.datasetGeneration||!validId(head.sourceStoreId))fail('BACKUP_DAILY_ARCHIVE_INVALID');}else validateDailyHead(head,{storeId:config.storeId,generation:config.datasetGeneration});
 if(!validId(head.archiveManifestId)||typeof head.archiveManifestHash!=='string'||head.sourceStoreId===config.storeId)fail('BACKUP_DAILY_ARCHIVE_INVALID');
 const archiveStoreId=head.archiveStoreId||head.sourceStoreId,scoped=BACKUP_CONFIG_PROPERTY+'_'+archiveStoreId,propertyKey=globals.PropertiesService.getScriptProperties().getProperty(scoped)?scoped:BACKUP_CONFIG_PROPERTY;
 const adapter=createGasBackupAdapter(globals,{storeId:archiveStoreId},{checkBudget,propertyKey});
 if(!adapter.ensure({create:false,loadState:false}))fail('BACKUP_DAILY_ARCHIVE_MISSING');
 const bytes=adapter.readManifest(head.archiveManifestId);if(!bytes)fail('BACKUP_DAILY_ARCHIVE_MISSING');
 let manifest;try{manifest=JSON.parse(decodeUtf8(bytes));}catch(_){fail('BACKUP_MANIFEST_INVALID');}
 validateBackupManifest(manifest);
 const original=manifest.daily?.head;
 if(manifest.hash!==head.archiveManifestHash||manifest.view.writerScriptId!==globals.ScriptApp.getScriptId()||manifest.view.storeId!==(head.archiveStoreId||head.sourceStoreId)||!head.archiveOnly&&(!original||original.sourceStoreId!==head.sourceStoreId||original.sourceGeneration!==head.sourceGeneration||original.publication!==(head.archivePublication||head.publication)||head.publication<original.publication||writerDigest(original.directory)!==writerDigest(head.directory)))fail('BACKUP_DAILY_ARCHIVE_MISMATCH');
 const daily=createBackupDailyAssetReader(manifest,adapter.readBackup,head),imported=createBackupAssetReader(manifest,adapter.readBackup);
 daily.hasImported=fileId=>manifest.entries.some(e=>e.ref.kind==='asset'&&e.ref.id===fileId);
 daily.readImported=reservation=>{const e=manifest.entries.find(e=>e.ref.kind==='asset'&&e.ref.id===reservation?.fileId);if(!e||reservation.storeId!==config.storeId||writerDigest({...reservation,storeId:e.ref.reservation.storeId})!==writerDigest(e.ref.reservation))fail('BACKUP_ASSET_MAP_MISSING');return imported(reservation);};
 return daily;
}
