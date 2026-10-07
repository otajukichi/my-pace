/**
 * Server-internal owner provisioning for the EXISTING authorized Apps Script.
 * Not an HTTP handler, public RPC, trigger installer or OAuth setup flow.
 * The caller supplies the owner from trusted code. The first explicit bootstrap
 * pins the actual existing script ID; an optional expectedScriptId adds a check.
 * Reusing its Cloud project in a different GAS project does not satisfy this.
 *
 * ScriptProperties contains one bounded fixed-configuration record only. An
 * explicit owner repair can add missing advisory pins, not replace identity.
 * It is written and read back before any folder/file create. No progress, job,
 * receipt or phase flag is stored there. A lost response resumes the SAME IDs.
 * No folder name search/adoption, update, sharing change, source write or delete.
 */
import {GasStoreIO} from './gas-store-io.mjs';
import {ReservedSlotWriter,writerDigest} from './reserved-writer.mjs';
import {createGasCheckpointHintCodec} from './checkpoint-hint.mjs';

export const OWNER_STORE_PROPERTY='mypace.production.store.v1';
export const OWNER_BOOTSTRAP_PROTOCOL='mypace-owner-store-v1';
// Owner may manually move the SAME pinned store root into this known folder.
// This is not a caller/configuration-selected parent or a request to move it.
const OWNER_STORE_MANUAL_DESTINATION='1kqtRzzNKZAq7-HE83XIN_JErtBn9YM_6';
const FOLDER='application/vnd.google-apps.folder';
const FIELDS='id,parents,appProperties,trashed,mimeType,ownedByMe,shared';
const KEYS='acceptedEpochs,anchorId,assetsParentId,datasetGeneration,firstIndexId,firstSlotId,metadataParentId,myDriveRootId,ownerEmail,protocol,rootParentId,storeId,writerScriptId';
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const folderId=x=>id(x)&&x.length<=100; // Drive app-property key+value limit.
const email=x=>typeof x==='string'&&x.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
const normalized=x=>typeof x==='string'?x.trim().toLowerCase():'';
const clone=x=>JSON.parse(JSON.stringify(x));
const fail=(code,retryable=false,status)=>{const e=Error(code);e.code=code;if(retryable)e.retryable=true;if(status!==undefined)e.status=status;throw e;};
const freezeConfig=c=>Object.freeze({...c,acceptedEpochs:Object.freeze(c.acceptedEpochs.slice())});
const validEpochs=x=>Array.isArray(x)&&x.length>=1&&x.length<=4&&x.every(id)&&new Set(x).size===x.length;

// Pure configuration validation for a SEPARATELY authenticated trusted server
// boundary. This does not authorize a caller, inspect Drive, or verify grants.
// writerScriptId must be the actual ScriptApp.getScriptId(), never request data.
export function parsePinnedOwnerStoreConfig(raw,{ownerEmail,writerScriptId,datasetGeneration,acceptedEpochs}={}){
 const owner=normalized(ownerEmail);
 if(!email(owner)||!id(writerScriptId)||(datasetGeneration!==undefined&&!id(datasetGeneration))||(acceptedEpochs!==undefined&&!validEpochs(acceptedEpochs)))fail('OWNER_BOOTSTRAP_CONFIG');
 if(raw===null)return null;
 if(typeof raw!=='string'||raw.length<1||raw.length>8192)fail('OWNER_BOOTSTRAP_CONFIG_INVALID');
 let c;try{c=JSON.parse(raw);}catch(_){fail('OWNER_BOOTSTRAP_CONFIG_INVALID');}
 if(!c||typeof c!=='object'||Array.isArray(c)||(Object.keys(c).some(k=>!KEYS.split(',').includes(k)&&!['checkpointHintId','checkpointHintAnchorHash','discoveryStateId'].includes(k))||KEYS.split(',').some(k=>!Object.prototype.hasOwnProperty.call(c,k)))||c.protocol!==OWNER_BOOTSTRAP_PROTOCOL||c.writerScriptId!==writerScriptId||c.ownerEmail!==owner||(datasetGeneration!==undefined&&c.datasetGeneration!==datasetGeneration)||(acceptedEpochs!==undefined&&JSON.stringify(c.acceptedEpochs)!==JSON.stringify(acceptedEpochs)))fail('OWNER_BOOTSTRAP_CONFIG_MISMATCH');
 const ids=['rootParentId','metadataParentId','assetsParentId','anchorId','firstSlotId','firstIndexId',...(Object.prototype.hasOwnProperty.call(c,'checkpointHintId')?['checkpointHintId']:[]),...(Object.prototype.hasOwnProperty.call(c,'discoveryStateId')?['discoveryStateId']:[])].map(k=>c[k]);
 if(ids.some(x=>!folderId(x))||new Set(ids).size!==ids.length||!id(c.myDriveRootId)||ids.includes(c.myDriveRootId)||c.storeId!==c.rootParentId||!id(c.datasetGeneration)||!validEpochs(c.acceptedEpochs))fail('OWNER_BOOTSTRAP_CONFIG_INVALID');
 if(Object.prototype.hasOwnProperty.call(c,'checkpointHintAnchorHash')&&(!c.checkpointHintId||typeof c.checkpointHintAnchorHash!=='string'||! /^[a-f0-9]{64}$/.test(c.checkpointHintAnchorHash)))fail('OWNER_BOOTSTRAP_CONFIG_INVALID');
 return freezeConfig(c);
}

export function createOwnerBootstrap(globals,options){
 const {Drive,Utilities,UrlFetchApp,ScriptApp,LockService,PropertiesService,Session}=globals||{};
 const {expectedScriptId:requestedScriptId,ownerEmail,checkBudget,propertyKey=OWNER_STORE_PROPERTY,datasetGeneration='1',acceptedEpochs=['default']}=options||{};
 const expectedScriptId=requestedScriptId===undefined&&typeof ScriptApp?.getScriptId==='function'?ScriptApp.getScriptId():requestedScriptId;
 const owner=normalized(ownerEmail);
 if(!id(expectedScriptId)||!email(owner)||typeof checkBudget!=='function'||typeof propertyKey!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(propertyKey)||!id(datasetGeneration)||!validEpochs(acceptedEpochs)||typeof Drive?.Files?.generateIds!=='function'||typeof Drive?.Files?.create!=='function'||typeof Utilities?.newBlob!=='function'||typeof UrlFetchApp?.fetch!=='function'||typeof ScriptApp?.getScriptId!=='function'||typeof ScriptApp?.getOAuthToken!=='function'||typeof LockService?.getScriptLock!=='function'||typeof PropertiesService?.getScriptProperties!=='function'||typeof Session?.getActiveUser!=='function'||typeof Session?.getEffectiveUser!=='function')fail('OWNER_BOOTSTRAP_CONFIG');
 // Do not obtain a token, inspect properties, acquire a lock or call Drive merely
 // by constructing this API. All public methods perform the guards afresh.
 const epochs=acceptedEpochs.slice();
 const budget=()=>{if(checkBudget('owner-bootstrap')!==true)fail('OWNER_BOOTSTRAP_YIELD',true);};
 function guard(){
  if(ScriptApp.getScriptId()!==expectedScriptId)fail('OWNER_BOOTSTRAP_SCRIPT_MISMATCH');
  let active,effective;
  try{active=normalized(Session.getActiveUser().getEmail());effective=normalized(Session.getEffectiveUser().getEmail());}catch(_){fail('OWNER_BOOTSTRAP_OWNER_UNVERIFIED');}
  // Effective user alone is unsafe for execute-as-owner web apps and triggers.
  if(active!==owner||effective!==owner)fail('OWNER_BOOTSTRAP_OWNER_UNVERIFIED');
 }
 function locked(action){
  guard();budget();const lock=LockService.getScriptLock();
  if(!lock||['hasLock','tryLock','releaseLock'].some(k=>typeof lock[k]!=='function'))fail('OWNER_BOOTSTRAP_LOCK_INVALID');
  let acquired=false;
  try{if(lock.hasLock()!==true){acquired=lock.tryLock(1000)===true;if(!acquired)fail('OWNER_BOOTSTRAP_BUSY',true);}return action(lock);}finally{if(acquired)lock.releaseLock();}
 }
 function assertHeld(lock){guard();if(lock.hasLock()!==true)fail('OWNER_BOOTSTRAP_LOCK_REQUIRED');budget();}
 function properties(lock){assertHeld(lock);const p=PropertiesService.getScriptProperties();if(!p||typeof p.getProperty!=='function'||typeof p.setProperty!=='function')fail('OWNER_BOOTSTRAP_PROPERTIES_INVALID');return p;}
 function readProperty(p){budget();try{return p.getProperty(propertyKey);}catch(_){fail('OWNER_BOOTSTRAP_CONFIG_UNRESOLVED',true);}}
 function parse(raw){return parsePinnedOwnerStoreConfig(raw,{ownerEmail:owner,writerScriptId:expectedScriptId,datasetGeneration,acceptedEpochs:epochs});}
 function parseRecovery(raw){return parsePinnedOwnerStoreConfig(raw,{ownerEmail:owner,writerScriptId:expectedScriptId});}
 function metadata(lock,fileId){
  assertHeld(lock);if(fileId!=='root'&&!id(fileId))fail('OWNER_BOOTSTRAP_ID_INVALID');
  let r;
  try{const token=ScriptApp.getOAuthToken();if(typeof token!=='string'||!token)fail('OWNER_BOOTSTRAP_AUTH');r=UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(fileId)+'?fields='+encodeURIComponent(FIELDS),{method:'get',headers:{Authorization:'Bearer '+token},muteHttpExceptions:true,followRedirects:false});}catch(_){fail('OWNER_BOOTSTRAP_READ_UNRESOLVED',true);}
  if(!r||typeof r.getResponseCode!=='function'||typeof r.getContentText!=='function')fail('OWNER_BOOTSTRAP_RESPONSE_INVALID');
  const status=r.getResponseCode();if(status===404)return null;if(status!==200)fail('OWNER_BOOTSTRAP_READ_UNRESOLVED',true,status);
  let m;try{const text=r.getContentText();if(typeof text!=='string'||text.length>16384)fail('OWNER_BOOTSTRAP_METADATA_INVALID');m=JSON.parse(text);}catch(_){fail('OWNER_BOOTSTRAP_METADATA_INVALID');}
  if(!m||typeof m!=='object'||Array.isArray(m))fail('OWNER_BOOTSTRAP_METADATA_INVALID');return m;
 }
 function privateFolder(m){return !!(m&&id(m.id)&&m.mimeType===FOLDER&&m.trashed===false&&m.ownedByMe===true&&m.shared===false);}
 function driveRoot(lock,c){const m=metadata(lock,'root');if(!privateFolder(m)||(c&&m.id!==c.myDriveRootId))fail('OWNER_BOOTSTRAP_DRIVE_ROOT_INVALID');return m.id;}
 function folderSpec(c,role){
  const keys={root:'rootParentId',metadata:'metadataParentId',assets:'assetsParentId'};
  return {id:c[keys[role]],name:role==='root'?'MyPace Private Store':'MyPace '+role,mimeType:FOLDER,parents:[role==='root'?c.myDriveRootId:c.rootParentId],appProperties:{'mypace.bootstrap':OWNER_BOOTSTRAP_PROTOCOL,'mypace.store':c.storeId,'mypace.script':writerDigest(c.writerScriptId),'mypace.role':'store-'+role}};
 }
 function verifyFolder(m,spec){
  if(!privateFolder(m)||m.id!==spec.id||!Array.isArray(m.parents)||m.parents.length!==1||m.parents[0]!==spec.parents[0]||!m.appProperties||Object.keys(spec.appProperties).some(k=>m.appProperties[k]!==spec.appProperties[k]))fail('OWNER_BOOTSTRAP_FOLDER_MISMATCH');
  // Display names are not identity. A user rename remains harmless.
  return m;
 }
 function verifyRootFolder(lock,c,m){
  const spec=folderSpec(c,'root');
  if(Array.isArray(m?.parents)&&m.parents.length===1&&m.parents[0]===OWNER_STORE_MANUAL_DESTINATION){
   // Keep exact identity/privacy/marker validation on the root itself. Only
   // this one root role may have the one explicitly known alternate parent.
   verifyFolder(m,{...spec,parents:[OWNER_STORE_MANUAL_DESTINATION]});
   const destination=metadata(lock,OWNER_STORE_MANUAL_DESTINATION);
   if(!privateFolder(destination)||destination.id!==OWNER_STORE_MANUAL_DESTINATION)fail('OWNER_BOOTSTRAP_PLACEMENT_INVALID');
   return m;
  }
  return verifyFolder(m,spec);
 }
 function folder(lock,c,role,allowCreate){
  const spec=folderSpec(c,role);
  const verify=m=>role==='root'?verifyRootFolder(lock,c,m):verifyFolder(m,spec);
  const parent=()=>{driveRoot(lock,c);if(role!=='root')verifyRootFolder(lock,c,metadata(lock,c.rootParentId));};
  parent();const m=metadata(lock,spec.id);if(m)return verify(m);
  if(!allowCreate)fail('OWNER_BOOTSTRAP_FOLDER_MISSING');
  for(let attempt=0;attempt<2;attempt++){
   parent();assertHeld(lock);
   try{Drive.Files.create(clone(spec),null,{fields:'id',ignoreDefaultVisibility:true});}catch(_){/* Read THIS ID even after 409, timeout, malformed reply or permission error. */}
   const observed=metadata(lock,spec.id);if(observed)return verify(observed);
  }
  fail('OWNER_BOOTSTRAP_CREATE_UNRESOLVED',true);
 }
 function writer(lock,c){const io=new GasStoreIO({Drive,Utilities,UrlFetchApp,ScriptApp,lock,storeId:c.storeId,managedParentId:c.metadataParentId,checkBudget,checkpointHintId:c.checkpointHintId});return new ReservedSlotWriter({io,storeId:c.storeId,writerScriptId:c.writerScriptId,anchorId:c.anchorId,checkpointHintId:c.checkpointHintId,checkpointHintAnchorHash:c.checkpointHintAnchorHash});}
 function configure(lock,p){
  const myDriveRootId=driveRoot(lock);assertHeld(lock);let r;
  try{r=Drive.Files.generateIds({count:8,space:'drive',type:'files'});}catch(_){fail('OWNER_BOOTSTRAP_IDS_UNRESOLVED',true);}
  if(!r||!Array.isArray(r.ids)||r.ids.length!==8||r.ids.some(x=>!folderId(x))||new Set(r.ids).size!==8||r.ids.includes(myDriveRootId))fail('OWNER_BOOTSTRAP_IDS_INVALID');
  const [rootParentId,metadataParentId,assetsParentId,anchorId,firstSlotId,firstIndexId,checkpointHintId,discoveryStateId]=r.ids;
  const c=parse(JSON.stringify({protocol:OWNER_BOOTSTRAP_PROTOCOL,ownerEmail:owner,writerScriptId:expectedScriptId,myDriveRootId,storeId:rootParentId,rootParentId,metadataParentId,assetsParentId,anchorId,firstSlotId,firstIndexId,checkpointHintId,discoveryStateId,datasetGeneration,acceptedEpochs:epochs}));
  // A second guard/read prevents an accidental overwrite if trusted code changed
  // properties while reserving. All supported callers share this script lock.
  assertHeld(lock);if(readProperty(p)!==null)fail('OWNER_BOOTSTRAP_CONFIG_CHANGED');
  const raw=JSON.stringify(c);if(raw.length>8192)fail('OWNER_BOOTSTRAP_CONFIG_INVALID');
  try{p.setProperty(propertyKey,raw);}catch(_){/* An ambiguous config write is resolved by exact readback. */}
  const observed=readProperty(p);if(observed!==raw)fail('OWNER_BOOTSTRAP_CONFIG_WRITE_UNRESOLVED',true);
  return parse(observed);
 }
 function inspect(lock,c,allowCreate){
  for(const role of ['root','metadata','assets'])folder(lock,c,role,allowCreate);
  const w=writer(lock,c);
  if(allowCreate)w.bootstrap({datasetGeneration:c.datasetGeneration,acceptedEpochs:c.acceptedEpochs,firstSlotId:c.firstSlotId,firstIndexId:c.firstIndexId});
  else {
   // bootstrap() creates a missing anchor; recoveryBarrier() may publish missing
   // checkpoint index links. Neither is appropriate for read-only configuration.
   const a=w.readBootstrap();
   if((!c.checkpointHintAnchorHash&&a.checkpointHintId!==c.checkpointHintId)||a.firstSlotId!==c.firstSlotId||a.firstIndexId!==c.firstIndexId||a.datasetGeneration!==c.datasetGeneration||JSON.stringify(a.acceptedEpochs)!==JSON.stringify(c.acceptedEpochs))fail('OWNER_BOOTSTRAP_ANCHOR_MISMATCH');
  }
  return freezeConfig(c);
 }
 function repairRecoveryConfiguration(lock){
  const p=properties(lock),before=readProperty(p),c=parseRecovery(before);
  if(!c)fail('OWNER_BOOTSTRAP_REQUIRED');
  // Use the already configured server secret. Never generate, replace, return,
  // log or persist a key here, and never reset configuration to bypass one.
  let secret;
  try{secret=p.getProperty('MYPACE_WRITER_SECRET');}catch(_){fail('OWNER_RECOVERY_SECRET_UNRESOLVED',true);}
  try{createGasCheckpointHintCodec({Utilities,secret}).encode({protocol:'mypace-owner-repair-check-v1'});}catch(_){
   const error=Error('OWNER_RECOVERY_SECRET_REQUIRED');error.code=error.message;error.requiresOwnerAction=true;
   error.setup='Configure the existing owner-managed MYPACE_WRITER_SECRET in this same Apps Script project, then run MyPaceRepairRecoveryConfiguration. Keep any existing key and all original storage IDs; never reset the store.';
   throw error;
  }
  // These checks are strictly read-only and precede even ID reservation. They
  // verify the old authority, not an empty replacement store or name adoption.
  inspect(lock,c,false);
  const anchor=writer(lock,c).readBootstrapInfo();
  const missing=['checkpointHintId','discoveryStateId'].filter(k=>c[k]===undefined);
  if(!missing.length)return freezeConfig(c);
  assertHeld(lock);let generated;
  try{generated=Drive.Files.generateIds({count:missing.length,space:'drive',type:'files'});}catch(_){fail('OWNER_BOOTSTRAP_IDS_UNRESOLVED',true);}
  if(!generated||!Array.isArray(generated.ids)||generated.ids.length!==missing.length||generated.ids.some(x=>!folderId(x))||new Set(generated.ids).size!==missing.length)fail('OWNER_BOOTSTRAP_IDS_INVALID');
  const updated={...c};for(let i=0;i<missing.length;i++)updated[missing[i]]=generated.ids[i];
  // A legacy anchor contains no hint field. Bind its exact existing immutable
  // bytes instead of rewriting that anchor or changing initial chain slots.
  if(missing.includes('checkpointHintId'))updated.checkpointHintAnchorHash=anchor.hash;
  const candidate=parseRecovery(JSON.stringify(updated)),raw=JSON.stringify(candidate);
  assertHeld(lock);if(readProperty(p)!==before)fail('OWNER_BOOTSTRAP_CONFIG_CHANGED');
  try{p.setProperty(propertyKey,raw);}catch(_){/* A lost response is decided by exact readback. */}
  const observed=readProperty(p);if(observed!==raw)fail('OWNER_BOOTSTRAP_CONFIG_WRITE_UNRESOLVED',true);
  // No advice is initialized here. Recovery creates/updates only the fixed
  // pinned hint ID. In particular, a valid authenticated witness to missing
  // immutable authority must remain untouched rather than being overwritten.
  return parseRecovery(observed);
 }
 return Object.freeze({
  bootstrap:()=>locked(lock=>{const p=properties(lock),c=parse(readProperty(p))||configure(lock,p);return inspect(lock,c,true);}),
  load:()=>locked(lock=>{const c=parse(readProperty(properties(lock)));return c?inspect(lock,c,false):null;}),
  // Maintenance may inspect older valid generations/epochs without changing
  // the ordinary import runtime's explicit compatibility contract/defaults.
  loadRecoveryConfiguration:()=>locked(lock=>{const c=parseRecovery(readProperty(properties(lock)));return c?inspect(lock,c,false):null;}),
  repairRecoveryConfiguration:()=>locked(repairRecoveryConfiguration)
 });
}
