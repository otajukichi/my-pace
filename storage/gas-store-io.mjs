import {CHECKPOINT_HINT_MAX_BYTES} from './checkpoint-hint.mjs';
// Server-internal Drive IO. No exported web handler or arbitrary-ID client route.
// Configuration contains fixed IDs only; all authoritative state is in Drive.
const fail=code=>{throw Error(code);};
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const MAX=2*1024*1024;
const FIELDS='id,parents,appProperties,size,trashed,mimeType,ownedByMe,shared';
const MIME='application/octet-stream';
const CACHE_DEFAULTS=Object.freeze({mode:'bytes',maxEntries:512,maxBytes:8*1024*1024});
const retry=(code,status)=>{const e=Error(code);e.retryable=true;if(status)e.status=status;throw e;};
export class GasStoreIO {
 constructor({Drive,Utilities,UrlFetchApp,ScriptApp,lock,storeId,managedParentId,checkBudget,protocolReadCache=false,checkpointHintId}) {
  if(!Drive?.Files||typeof Drive.Files.create!=='function'||typeof Drive.Files.generateIds!=='function'||typeof Utilities?.newBlob!=='function'||typeof UrlFetchApp?.fetch!=='function'||typeof ScriptApp?.getOAuthToken!=='function'||typeof ScriptApp?.getScriptId!=='function'||typeof lock?.hasLock!=='function'||!id(storeId)||!id(managedParentId)||typeof checkBudget!=='function')fail('STORE_IO_CONFIG');
  if(checkpointHintId!==undefined&&(!id(checkpointHintId)||checkpointHintId===managedParentId||checkpointHintId===storeId))fail('STORE_HINT_CONFIG');
  Object.assign(this,{Drive,Utilities,UrlFetchApp,ScriptApp,lock,storeId,managedParentId,checkBudget,checkpointHintId});
  if(protocolReadCache!==false&&protocolReadCache!==true&&(!protocolReadCache||typeof protocolReadCache!=='object'||Array.isArray(protocolReadCache)))fail('STORE_CACHE_CONFIG');
  this._readCacheLimits=protocolReadCache===false?null:{...CACHE_DEFAULTS,...(protocolReadCache===true?{}:protocolReadCache)};
  const c=this._readCacheLimits;
  if(c&&(Object.keys(c).some(k=>!Object.prototype.hasOwnProperty.call(CACHE_DEFAULTS,k))||!['bytes','lock-phase'].includes(c.mode)||!Number.isSafeInteger(c.maxEntries)||c.maxEntries<1||c.maxEntries>1024||!Number.isSafeInteger(c.maxBytes)||c.maxBytes<1||c.maxBytes>8*1024*1024))fail('STORE_CACHE_CONFIG');
  this._readCache=new Map();this._readCacheBytes=0;this._readCacheActive=false;this._readPhaseToken=null;
 }
 // Only runtime-owned, continuously-held lock phases may enable this cache.
 // Immutable protocol bytes are still hash/schema-verified by the writer on
 // every read. Missing slots, parents, original sources and assets are excluded.
 // 'bytes' mode freshly validates metadata on every read. Explicit 'lock-phase'
 // mode trusts previously verified positive metadata only until lock release.
 beginReadPhase(){this.endReadPhase();if(this._readCacheLimits){this.assertLockHeld();this._readCacheActive=true;this._readPhaseToken={};}}
 endReadPhase(){this._readCache.clear();this._readCacheBytes=0;this._readCacheActive=false;this._readPhaseToken=null;}
 // An opaque token authorizes verified-prefix reuse only in full positive mode.
 getVerifiedReadPhase(){if(!this._readCacheActive||this._readCacheLimits.mode!=='lock-phase')return null;this.assertLockHeld();this._budget();return this._readPhaseToken;}
 _forget(fileId){const old=this._readCache.get(fileId);if(old){this._readCacheBytes-=old.bytes.length;this._readCache.delete(fileId);}}
 _cached(fileId,maxBytes){
  if(!this._readCacheActive)return null;
  this.assertLockHeld();this._budget();
  const hit=this._readCache.get(fileId);if(!hit)return null;
  if(hit.bytes.length>maxBytes)fail('STORE_SIZE_INVALID');
  this._readCache.delete(fileId);this._readCache.set(fileId,hit);return hit;
 }
 _remember(fileId,bytes,metadata){
  if(!this._readCacheActive||bytes.length>this._readCacheLimits.maxBytes)return;
  // Missing revision evidence must never compare equal as undefined/undefined.
  if(this._readCacheLimits.mode==='bytes'&&(typeof metadata.version!=='string'||!/^[1-9]\d{0,19}$/.test(metadata.version)||typeof metadata.md5Checksum!=='string'||!/^[0-9a-f]{32}$/.test(metadata.md5Checksum)))return;
  this._forget(fileId);
  while(this._readCache.size>=this._readCacheLimits.maxEntries||this._readCacheBytes+bytes.length>this._readCacheLimits.maxBytes)this._forget(this._readCache.keys().next().value);
  this.assertLockHeld();
  this._readCache.set(fileId,{bytes:Uint8Array.from(bytes),...(this._readCacheLimits.mode==='bytes'?{version:metadata.version,md5Checksum:metadata.md5Checksum}:{})});this._readCacheBytes+=bytes.length;
 }
 getScriptId(){return this.ScriptApp.getScriptId();}
 assertLockHeld(){if(this.lock.hasLock()!==true){this.endReadPhase();fail('STORE_LOCK_REQUIRED');}return true;}
 _budget(){if(this.checkBudget('store-io')!==true)retry('STORE_YIELD');}
 _fetch(fileId,suffix,headers={}) {
  this.assertLockHeld();this._budget();if(!id(fileId))fail('STORE_ID_INVALID');
  let r;try{const token=this.ScriptApp.getOAuthToken();if(typeof token!=='string'||!token)fail('STORE_AUTH');r=this.UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(fileId)+suffix,{method:'get',headers:{Authorization:'Bearer '+token,...headers},muteHttpExceptions:true,followRedirects:false});}catch(e){retry('STORE_READ_UNRESOLVED');}
  if(!r||typeof r.getResponseCode!=='function')fail('STORE_RESPONSE_INVALID');return r;
 }
 _metadata(fileId){const r=this._fetch(fileId,'?fields='+encodeURIComponent(FIELDS+(this._readCacheLimits?.mode==='bytes'?',version,md5Checksum':'')));const status=r.getResponseCode();if(status===404)return null;if(status!==200)retry('STORE_METADATA_UNRESOLVED',status);let m;try{const t=r.getContentText();if(typeof t!=='string'||t.length>16384)fail('STORE_METADATA_INVALID');m=JSON.parse(t);if(!m||typeof m!=='object'||Array.isArray(m))fail('STORE_METADATA_INVALID');}catch(e){fail('STORE_METADATA_INVALID');}return m;}
 _parent(){const m=this._metadata(this.managedParentId);if(!m||m.id!==this.managedParentId||m.mimeType!=='application/vnd.google-apps.folder'||m.trashed!==false||m.ownedByMe!==true||m.shared!==false)fail('STORE_PARENT_NOT_PRIVATE');}
 allocateIds(n){this.assertLockHeld();this._budget();if(!Number.isSafeInteger(n)||n<1||n>1000)fail('STORE_ID_COUNT');let r;try{r=this.Drive.Files.generateIds({count:n,space:'drive',type:'files'});}catch(e){retry('STORE_IDS_UNRESOLVED');}if(!r||!Array.isArray(r.ids)||r.ids.length!==n||r.ids.some(x=>!id(x))||new Set(r.ids).size!==n)fail('STORE_IDS_INVALID');return r.ids;}
 readFile(fileId,maxBytes=MAX){
  if(fileId===this.checkpointHintId)fail('STORE_HINT_ROLE_REQUIRED');
  return this._readFile(fileId,maxBytes);
 }
 _readFile(fileId,maxBytes=MAX,hint=false){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX)fail('STORE_READ_BOUND');
  const hit=hint?null:this._cached(fileId,maxBytes);if(hit&&this._readCacheLimits.mode==='lock-phase')return Uint8Array.from(hit.bytes);
  const m=this._metadata(fileId);if(m===null){this._forget(fileId);return null;}
  if(m.id!==fileId||m.trashed!==false||m.ownedByMe!==true||m.shared!==false||m.mimeType!==MIME||!Array.isArray(m.parents)||m.parents.length!==1||m.parents[0]!==this.managedParentId||m.appProperties?.['mypace.store']!==this.storeId)fail('STORE_METADATA_MISMATCH');
  if(hint&&m.appProperties?.['mypace.role']!=='checkpoint-hint')fail('STORE_HINT_ROLE_MISMATCH');
  if(!/^\d+$/.test(String(m.size)))fail('STORE_SIZE_INVALID');const n=Number(m.size);if(!Number.isSafeInteger(n)||n<1||n>maxBytes)fail('STORE_SIZE_INVALID');
  if(hit&&hit.bytes.length===n&&hit.version===m.version&&hit.md5Checksum===m.md5Checksum)return Uint8Array.from(hit.bytes);
  this._forget(fileId);
  const r=this._fetch(fileId,'?alt=media',{Range:'bytes=0-'+(n-1),'Accept-Encoding':'identity'});if(r.getResponseCode()!==206)retry('STORE_RANGE_STATUS',r.getResponseCode());
  const h=r.getAllHeaders();if(!h||typeof h!=='object'||Array.isArray(h))fail('STORE_HEADERS_INVALID');
  const header=name=>{const keys=Object.keys(h).filter(k=>k.toLowerCase()===name);if(!keys.length)return null;if(keys.length!==1||!['string','number'].includes(typeof h[keys[0]]))fail('STORE_HEADERS_INVALID');return String(h[keys[0]]).trim();};
  if(header('content-range')!==`bytes 0-${n-1}/${n}`)fail('STORE_RANGE_INVALID');const length=header('content-length'),encoding=header('content-encoding');if((length!==null&&length!==String(n))||(encoding!==null&&encoding.toLowerCase()!=='identity'))fail('STORE_HEADERS_INVALID');
  const raw=r.getContent();if(!raw||raw.length!==n)fail('STORE_BYTES_INVALID');const b=new Uint8Array(n);for(let i=0;i<n;i++){if(!Number.isInteger(raw[i])||raw[i]<-128||raw[i]>255)fail('STORE_BYTES_INVALID');b[i]=raw[i]&255;}if(!hint)this._remember(fileId,b,m);return b;
 }
 // The only mutable IO surface has NO ID argument. It is bound to an optional
 // bootstrap pin, never accepts metadata/parent/role from callers, and is never
 // cached as immutable protocol data. Failure is safe: recovery uses the anchor.
 readCheckpointHint(){
  this.assertLockHeld();if(!this.checkpointHintId)return null;this._parent();
  return this._readFile(this.checkpointHintId,CHECKPOINT_HINT_MAX_BYTES,true);
 }
 writeCheckpointHint(bytes){
  this.assertLockHeld();this._budget();
  if(!this.checkpointHintId||!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>CHECKPOINT_HINT_MAX_BYTES)fail('STORE_HINT_WRITE_INVALID');
  this._parent();const fileId=this.checkpointHintId,m=this._metadata(fileId);
  if(m&&(m.id!==fileId||m.trashed!==false||m.ownedByMe!==true||m.shared!==false||m.mimeType!==MIME||!Array.isArray(m.parents)||m.parents.length!==1||m.parents[0]!==this.managedParentId||m.appProperties?.['mypace.store']!==this.storeId||m.appProperties?.['mypace.role']!=='checkpoint-hint'))fail('STORE_HINT_METADATA_MISMATCH');
  const name='mypace-checkpoint-hint-'+fileId,blob=this.Utilities.newBlob(Array.from(bytes,n=>n>127?n-256:n),MIME,name);
  this.assertLockHeld();this._budget();
  // One attempt only. Response loss never allocates a new ID or retries a stale
  // payload; a late update may regress this hint and successors repair recovery.
  let result;
  if(m){if(typeof this.Drive.Files.update!=='function')fail('STORE_HINT_UPDATE_UNAVAILABLE');result=this.Drive.Files.update({},fileId,blob,{fields:'id'});}
  else result=this.Drive.Files.create({id:fileId,name,mimeType:MIME,parents:[this.managedParentId],appProperties:{'mypace.store':this.storeId,'mypace.role':'checkpoint-hint'}},blob,{fields:'id',ignoreDefaultVisibility:true});
  if(!result||result.id!==fileId)fail('STORE_HINT_WRITE_UNRESOLVED');
  return true;
 }
 createFile(fileId,bytes,role){
  this.assertLockHeld();this._budget();if(fileId===this.checkpointHintId||role==='checkpoint-hint')fail('STORE_HINT_ROLE_REQUIRED');if(!id(fileId)||typeof role!=='string'||! /^[a-z][a-z0-9-]{0,63}$/.test(role)||!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>MAX)fail('STORE_CREATE_INVALID');
  this._forget(fileId);this._parent();const metadata={id:fileId,name:'mypace-'+role+'-'+fileId,mimeType:MIME,parents:[this.managedParentId],appProperties:{'mypace.store':this.storeId,'mypace.role':role}};
  const blob=this.Utilities.newBlob(Array.from(bytes,n=>n>127?n-256:n),MIME,metadata.name);
  // Caller MUST read this same ID after any result, including timeout or 409.
  // No new-ID fallback or authoritative object updates exist in this adapter.
  this.assertLockHeld();this._budget();const result=this.Drive.Files.create(metadata,blob,{fields:'id',ignoreDefaultVisibility:true});if(!result||result.id!==fileId)fail('STORE_CREATE_ID_MISMATCH');return result;
 }
}
