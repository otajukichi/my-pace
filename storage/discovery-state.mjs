// Fixed-size, owner-private advisory source-discovery cursor. This is not an
// app/job checkpoint. Loss or invalid authentication restarts source discovery;
// only the immutable import protocol may register, resume or publish a job.
import {encodeUtf8,decodeUtf8} from './codec.mjs';
import {SOURCE_FOLDER_ID,normalizeGasBytes} from './transport.mjs';
export const DISCOVERY_STATE_PROTOCOL='mypace-source-discovery-v1';
export const DISCOVERY_STATE_MAX_BYTES=8192;
const DOMAIN='MyPace/Drive/source-discovery/HMAC-SHA256/v1\n';
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const token=x=>x===null||typeof x==='string'&&x.length>=1&&x.length<=4096&&!/[\0\r\n]/.test(x);
const fail=code=>{const e=Error(code);e.code=code;throw e;};
const retry=code=>{const e=Error(code);e.code=code;e.retryable=true;throw e;};
const canonical=x=>{if(x===null||typeof x==='string'||Number.isSafeInteger(x))return JSON.stringify(x);if(x&&Object.getPrototypeOf(x)===Object.prototype)return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';fail('DISCOVERY_STATE_FORMAT');};
const sameMac=(a,b)=>{if(!hex(a)||!hex(b))return false;let n=0;for(let i=0;i<64;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;};
export function createDiscoveryStateCodec({hmacSha256}={}){
 if(typeof hmacSha256!=='function')fail('DISCOVERY_STATE_AUTH_REQUIRED');
 const sign=p=>{const text=canonical(p);if(encodeUtf8(text).length>DISCOVERY_STATE_MAX_BYTES-128)fail('DISCOVERY_STATE_BOUND');const mac=hmacSha256(DOMAIN+text);if(!hex(mac))fail('DISCOVERY_STATE_AUTH_INVALID');return mac;};
 return Object.freeze({encode:payload=>{const bytes=encodeUtf8(canonical({payload,mac:sign(payload)}));if(bytes.length>DISCOVERY_STATE_MAX_BYTES)fail('DISCOVERY_STATE_BOUND');return bytes;},decode:bytes=>{try{if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>DISCOVERY_STATE_MAX_BYTES)return null;const text=decodeUtf8(bytes),e=JSON.parse(text);if(!e||Object.keys(e).sort().join(',')!=='mac,payload'||canonical(e)!==text||!sameMac(e.mac,sign(e.payload)))return null;return e.payload;}catch(_){return null;}}});
}
export function createGasDiscoveryStateCodec({Utilities,secret}={}){
 if(typeof secret!=='string'||encodeUtf8(secret).length<32||encodeUtf8(secret).length>4096||typeof Utilities?.computeHmacSha256Signature!=='function'||Utilities?.Charset?.UTF_8===undefined)fail('DISCOVERY_STATE_AUTH_REQUIRED');
 return createDiscoveryStateCodec({hmacSha256:text=>{const bytes=Utilities.computeHmacSha256Signature(text,secret,Utilities.Charset.UTF_8);if(!bytes||bytes.length!==32)fail('DISCOVERY_STATE_AUTH_INVALID');return Array.from(bytes,n=>{if(!Number.isInteger(n)||n< -128||n>255)fail('DISCOVERY_STATE_AUTH_INVALID');return (n&255).toString(16).padStart(2,'0');}).join('');}});
}
export function createDiscoveryStateIO(globals,config,{checkBudget=()=>true,now=()=>Date.now()}={}){
 const codec=config.discoveryStateCodec,fileId=config.discoveryStateId;
 if(!fileId||!codec)return null;
 if(!id(fileId)||[config.storeId,config.anchorId,config.metadataParentId,config.assetsParentId,config.checkpointHintId].includes(fileId)||typeof codec.encode!=='function'||typeof codec.decode!=='function')fail('DISCOVERY_STATE_CONFIG');
 const {Drive,UrlFetchApp,ScriptApp,Utilities,LockService}=globals;
 const scope={protocol:DISCOVERY_STATE_PROTOCOL,fileId,storeId:config.storeId,writerScriptId:config.writerScriptId,anchorId:config.anchorId,folderId:SOURCE_FOLDER_ID,datasetGeneration:config.datasetGeneration||'1'};
 const guard=()=>{if(ScriptApp.getScriptId()!==scope.writerScriptId||LockService.getScriptLock().hasLock()!==true)fail('DISCOVERY_STATE_LOCK_REQUIRED');if(checkBudget()!==true)fail('OWNER_BUDGET_YIELD');};
 const getMeta=id=>{
  guard();let response;try{response=UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?fields='+encodeURIComponent('id,parents,appProperties,size,trashed,mimeType,ownedByMe,shared'),{method:'get',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true,followRedirects:false});}catch(error){if(error?.message==='OWNER_BUDGET_YIELD')throw error;retry('DISCOVERY_STATE_READ_UNRESOLVED');}
  const status=response.getResponseCode();if(status===404)return null;if(status===401)fail('DISCOVERY_STATE_AUTH_REQUIRED');if(status===403)fail('DISCOVERY_STATE_PERMISSION_DENIED');if(status===429||status>=500)retry('DISCOVERY_STATE_READ_UNRESOLVED');if(status!==200)fail('DISCOVERY_STATE_READ_REJECTED');
  const text=response.getContentText();if(typeof text!=='string'||text.length>16384)fail('DISCOVERY_STATE_METADATA_INVALID');let metadata;try{metadata=JSON.parse(text);}catch(_){fail('DISCOVERY_STATE_METADATA_INVALID');}if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))fail('DISCOVERY_STATE_METADATA_INVALID');return metadata;
 };
 const parent=()=>{const m=getMeta(config.metadataParentId);if(!m||m.id!==config.metadataParentId||m.trashed!==false||m.ownedByMe!==true||m.shared!==false||m.mimeType!=='application/vnd.google-apps.folder')fail('DISCOVERY_STATE_PARENT_INVALID');};
 const metadata=()=>{parent();const m=getMeta(fileId);if(m&&(m.id!==fileId||m.trashed!==false||m.ownedByMe!==true||m.shared!==false||m.mimeType!=='application/octet-stream'||!Array.isArray(m.parents)||m.parents.length!==1||m.parents[0]!==config.metadataParentId||m.appProperties?.['mypace.store']!==config.storeId||m.appProperties?.['mypace.role']!=='source-discovery'))fail('DISCOVERY_STATE_METADATA_MISMATCH');return m;};
 const stateValid=s=>s&&Object.keys(s).sort().join(',')==='checkedAt,index,pageHash,pageToken,phase'&&['scan','complete'].includes(s.phase)&&token(s.pageToken)&&Number.isSafeInteger(s.index)&&s.index>=0&&s.index<=32&&(s.pageHash===null||hex(s.pageHash))&&Number.isSafeInteger(s.checkedAt)&&s.checkedAt>=0&&s.checkedAt<=now()&&(s.phase!=='complete'||s.pageToken===null&&s.index===0&&s.pageHash===null);
 const read=head=>{
  const m=metadata();if(!m)return null;
  if(!/^\d+$/.test(String(m.size))||Number(m.size)<1||Number(m.size)>DISCOVERY_STATE_MAX_BYTES)return null;
  const size=Number(m.size);guard();const response=UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(fileId)+'?alt=media',{method:'get',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken(),Range:'bytes=0-'+(size-1),'Accept-Encoding':'identity'},muteHttpExceptions:true,followRedirects:false});
  const status=response.getResponseCode();if(status===404)return null;if(status===401)fail('DISCOVERY_STATE_AUTH_REQUIRED');if(status===403)fail('DISCOVERY_STATE_PERMISSION_DENIED');if(status===429||status>=500)retry('DISCOVERY_STATE_READ_UNRESOLVED');if(status!==206)fail('DISCOVERY_STATE_RANGE_INVALID');
  const headers=response.getAllHeaders(),header=name=>{const keys=Object.keys(headers||{}).filter(k=>k.toLowerCase()===name);return keys.length===1?String(headers[keys[0]]):null;};
  if(header('content-range')!==`bytes 0-${size-1}/${size}`||header('content-length')!==null&&header('content-length')!==String(size)||header('content-encoding')!==null&&header('content-encoding').toLowerCase()!=='identity')return null;
  let p;try{p=codec.decode(normalizeGasBytes(response.getContent(),size));}catch(_){return null;}
  if(!p||Object.keys(p).sort().join(',')!==[...Object.keys(scope),'headHash','revision','state'].sort().join(',')||Object.entries(scope).some(([k,v])=>p[k]!==v)||p.headHash!==head.headHash||p.revision!==head.revision||!stateValid(p.state))return null;
  return p.state;
 };
 const write=(head,state)=>{
  if(!stateValid(state))fail('DISCOVERY_STATE_INVALID');
  const bytes=codec.encode({...scope,headHash:head.headHash,revision:head.revision,state});
  if(!(bytes instanceof Uint8Array)||bytes.length>DISCOVERY_STATE_MAX_BYTES)fail('DISCOVERY_STATE_BOUND');
  const m=metadata(),blob=Utilities.newBlob(Array.from(bytes,n=>n>127?n-256:n),'application/octet-stream','mypace-source-discovery-'+fileId);guard();
  // Never retry an ambiguous overwrite or allocate a replacement ID. Old/absent
  // cursor only repeats discovery; committed source work remains in Drive.
  const result=m?Drive.Files.update({},fileId,blob,{fields:'id'}):Drive.Files.create({id:fileId,name:'mypace-source-discovery-'+fileId,mimeType:'application/octet-stream',parents:[config.metadataParentId],appProperties:{'mypace.store':config.storeId,'mypace.role':'source-discovery'}},blob,{fields:'id',ignoreDefaultVisibility:true});
  if(!result||result.id!==fileId)fail('DISCOVERY_STATE_WRITE_UNRESOLVED');
 };
 return Object.freeze({read,write});
}
