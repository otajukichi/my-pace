import {IncrementalSha256} from './codec.mjs';
import {CHECKPOINT_HINT_MAX_BYTES} from './checkpoint-hint.mjs';
// Server-internal Drive IO. No exported web handler or arbitrary-ID client route.
// Configuration contains fixed IDs only; all authoritative state is in Drive.
const fail=code=>{throw Error(code);};
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const MAX=2*1024*1024;
const FIELDS='id,parents,appProperties,size,trashed,mimeType,ownedByMe,shared';
const CREATE_FIELDS=FIELDS+',version,sha256Checksum';
const MIME='application/octet-stream';
const PREFETCH_ROLES=new Set(['bootstrap','frame','index-node','checkpoint-manifest','checkpoint-index','preparation','preparation-work','transition-certificate']);
const CACHE_DEFAULTS=Object.freeze({mode:'bytes',maxEntries:512,maxBytes:8*1024*1024});
const retry=(code,status)=>{const e=Error(code);e.retryable=true;if(status)e.status=status;throw e;};
export class GasStoreIO {
 constructor({Drive,Utilities,UrlFetchApp,ScriptApp,lock,storeId,managedParentId,checkBudget,protocolReadCache=false,checkpointHintId,restTransport=null,canWriteHint=()=>true,managedWritePhase=false,trustManagedRecoveryPrefix=false}) {
  if(!Drive?.Files||typeof Drive.Files.create!=='function'||typeof Drive.Files.generateIds!=='function'||typeof Utilities?.newBlob!=='function'||typeof UrlFetchApp?.fetch!=='function'||typeof ScriptApp?.getOAuthToken!=='function'||typeof ScriptApp?.getScriptId!=='function'||typeof lock?.hasLock!=='function'||!id(storeId)||!id(managedParentId)||typeof checkBudget!=='function')fail('STORE_IO_CONFIG');
  if(checkpointHintId!==undefined&&(!id(checkpointHintId)||checkpointHintId===managedParentId||checkpointHintId===storeId))fail('STORE_HINT_CONFIG');
  if(restTransport!==null&&['read','generateIds','create','update','advisory','canStartAdvisory'].some(k=>typeof restTransport[k]!=='function')||restTransport!==null&&restTransport.readMany!==undefined&&typeof restTransport.readMany!=='function'||restTransport!==null&&restTransport.createMany!==undefined&&typeof restTransport.createMany!=='function'||typeof canWriteHint!=='function')fail('STORE_IO_CONFIG');
  Object.assign(this,{Drive,Utilities,UrlFetchApp,ScriptApp,lock,storeId,managedParentId,checkBudget,checkpointHintId,restTransport,canWriteHint});
  if(protocolReadCache!==false&&protocolReadCache!==true&&(!protocolReadCache||typeof protocolReadCache!=='object'||Array.isArray(protocolReadCache)))fail('STORE_CACHE_CONFIG');
  this._readCacheLimits=protocolReadCache===false?null:{...CACHE_DEFAULTS,...(protocolReadCache===true?{}:protocolReadCache)};
  const c=this._readCacheLimits;
  if(c&&(Object.keys(c).some(k=>!Object.prototype.hasOwnProperty.call(CACHE_DEFAULTS,k))||!['bytes','lock-phase'].includes(c.mode)||!Number.isSafeInteger(c.maxEntries)||c.maxEntries<1||c.maxEntries>1024||!Number.isSafeInteger(c.maxBytes)||c.maxBytes<1||c.maxBytes>8*1024*1024))fail('STORE_CACHE_CONFIG');
  if(typeof trustManagedRecoveryPrefix!=='boolean'||trustManagedRecoveryPrefix&&!managedWritePhase)fail('STORE_IO_CONFIG');this._trustManagedRecoveryPrefix=trustManagedRecoveryPrefix;
  if(typeof managedWritePhase!=='boolean')fail('STORE_IO_CONFIG');this._managedWritePhase=managedWritePhase;
  this._readCache=new Map();this._readCacheBytes=0;this._readCacheActive=false;this._readPhaseToken=null;this._readParentValidated=false;this._hintParentProofUsed=false;
 }
 // Only runtime-owned, continuously-held lock phases may enable this cache.
 // Immutable protocol bytes are still hash/schema-verified by the writer on
 // every read. Missing slots, parents, original sources and assets are excluded.
 // 'bytes' mode freshly validates metadata on every read. Explicit 'lock-phase'
 // mode trusts previously verified positive metadata only until lock release.
 beginReadPhase(){this.endReadPhase();if(this._readCacheLimits){this.assertLockHeld();this._readCacheActive=true;this._readPhaseToken={};}}
 endReadPhase(){this._readCache.clear();this._readCacheBytes=0;this._readCacheActive=false;this._readPhaseToken=null;this._readParentValidated=false;this._hintParentProofUsed=false;}
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
 // Explicit app-managed immutable-store policy. Authority lasts only for this
 // continuously held lock; CSV/source IO never uses this proof.
 _writeParent(){if(this._managedWritePhase&&this.getVerifiedReadPhase()&&this._readParentValidated)return;this._parent();if(this._managedWritePhase&&this.getVerifiedReadPhase())this._readParentValidated=true;}
 _acceptCreate(fileId,bytes,role,result){
  if(!this._managedWritePhase||!this.getVerifiedReadPhase())return false;
  // Missing optional fields/checksum safely retain the ordinary exact-ID read.
  // A complete response must bind server SHA-256 to the exact uploaded bytes.
  try{if(!result||result.appProperties?.['mypace.role']!==role||typeof result.version!=='string'||!/^[1-9]\d{0,19}$/.test(result.version)||typeof result.sha256Checksum!=='string'||!/^[a-f0-9]{64}$/.test(result.sha256Checksum)||this._checkedMetadata(result,fileId,bytes.length)!==bytes.length||new IncrementalSha256().update(bytes).digestHex()!==result.sha256Checksum)return false;}catch(_){return false;}
  this._remember(fileId,bytes,result);return true;
 }
 getScriptId(){return this.ScriptApp.getScriptId();}
 assertLockHeld(){if(this.lock.hasLock()!==true){this.endReadPhase();fail('STORE_LOCK_REQUIRED');}return true;}
 _budget(){if(this.checkBudget('store-io')!==true)retry('STORE_YIELD');}
 _fetch(fileId,suffix,headers={}) {
  this.assertLockHeld();this._budget();if(!id(fileId))fail('STORE_ID_INVALID');
  let r;try{if(this.restTransport)r=this.restTransport.read(fileId,suffix,headers);else{const token=this.ScriptApp.getOAuthToken();if(typeof token!=='string'||!token)fail('STORE_AUTH');r=this.UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(fileId)+suffix,{method:'get',headers:{Authorization:'Bearer '+token,...headers},muteHttpExceptions:true,followRedirects:false});}}catch(e){if(e.message==='STORE_YIELD')throw e;retry('STORE_READ_UNRESOLVED',e.status);}
  if(!r||typeof r.getResponseCode!=='function')fail('STORE_RESPONSE_INVALID');return r;
 }
 _metadataResult(r){if(!r||typeof r.getResponseCode!=='function')fail('STORE_RESPONSE_INVALID');const status=r.getResponseCode();if(status===404)return null;if(status!==200)retry('STORE_METADATA_UNRESOLVED',status);let m;try{const t=r.getContentText();if(typeof t!=='string'||t.length>16384)fail('STORE_METADATA_INVALID');m=JSON.parse(t);if(!m||typeof m!=='object'||Array.isArray(m))fail('STORE_METADATA_INVALID');}catch(e){fail('STORE_METADATA_INVALID');}return m;}
 _metadata(fileId){return this._metadataResult(this._fetch(fileId,'?fields='+encodeURIComponent(FIELDS+(this._readCacheLimits?.mode==='bytes'?',version,md5Checksum':''))));}
 _checkedMetadata(m,fileId,maxBytes,hint=false){
  if(m.id!==fileId||m.trashed!==false||m.ownedByMe!==true||m.shared!==false||m.mimeType!==MIME||!Array.isArray(m.parents)||m.parents.length!==1||m.parents[0]!==this.managedParentId||m.appProperties?.['mypace.store']!==this.storeId)fail('STORE_METADATA_MISMATCH');
  if(hint&&m.appProperties?.['mypace.role']!=='checkpoint-hint')fail('STORE_HINT_ROLE_MISMATCH');
  if(!/^\d+$/.test(String(m.size)))fail('STORE_SIZE_INVALID');const n=Number(m.size);if(!Number.isSafeInteger(n)||n<1||n>maxBytes)fail('STORE_SIZE_INVALID');return n;
 }
 _mediaResult(r,n){
  if(!r||typeof r.getResponseCode!=='function')fail('STORE_RESPONSE_INVALID');if(r.getResponseCode()!==206)retry('STORE_RANGE_STATUS',r.getResponseCode());
  const h=r.getAllHeaders();if(!h||typeof h!=='object'||Array.isArray(h))fail('STORE_HEADERS_INVALID');
  const header=name=>{const keys=Object.keys(h).filter(k=>k.toLowerCase()===name);if(!keys.length)return null;if(keys.length!==1||!['string','number'].includes(typeof h[keys[0]]))fail('STORE_HEADERS_INVALID');return String(h[keys[0]]).trim();};
  if(header('content-range')!==`bytes 0-${n-1}/${n}`)fail('STORE_RANGE_INVALID');const length=header('content-length'),encoding=header('content-encoding');if((length!==null&&length!==String(n))||(encoding!==null&&encoding.toLowerCase()!=='identity'))fail('STORE_HEADERS_INVALID');
  const raw=r.getContent();if(!raw||raw.length!==n)fail('STORE_BYTES_INVALID');const b=new Uint8Array(n);for(let i=0;i<n;i++){if(!Number.isInteger(raw[i])||raw[i]<-128||raw[i]>255)fail('STORE_BYTES_INVALID');b[i]=raw[i]&255;}return b;
 }
 _fetchMany(requests){
  this.assertLockHeld();this._budget();
  if(!this.restTransport||this.restTransport.readMany===undefined)return requests.map(r=>this._fetch(r.id,r.suffix,r.headers||{}));
  let responses;try{responses=this.restTransport.readMany(requests);}catch(e){if((e.code||e.message)==='STORE_YIELD')throw e;retry('STORE_READ_UNRESOLVED',e.status);}
  if(!Array.isArray(responses)||responses.length!==requests.length)fail('STORE_RESPONSE_INVALID');return responses;
 }
 prefetchRecoveryRead(anchorId,maxBytes=MAX){
  if(!id(anchorId)||anchorId===this.checkpointHintId||anchorId===this.managedParentId)fail('STORE_ID_INVALID');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX)fail('STORE_READ_BOUND');
  this.assertLockHeld();this._budget();
  if(!this.checkpointHintId||!this._readCacheActive||this._readCacheLimits.mode!=='lock-phase')return undefined;
  const phase=this._readPhaseToken,check=()=>{this.assertLockHeld();this._budget();if(!this._readCacheActive||this._readPhaseToken!==phase)fail('STORE_READ_PHASE_CHANGED');};
  const batch=reads=>{try{return this._fetchMany(reads);}catch(error){
   if(error?.message!=='STORE_READ_UNRESOLVED'||error.retryable!==true)throw error;
   check();this._forget(anchorId);this._hintParentProofUsed=true;return null;
  }};
  try{
   this._parent();check();this._readParentValidated=true;
   const metadata=batch([anchorId,this.checkpointHintId].map(id=>({id,suffix:'?fields='+encodeURIComponent(FIELDS)})));if(metadata===null)return {hintBytes:null};check();
   const anchor=this._metadataResult(metadata[0]);if(anchor===null)return undefined;
   const size=this._checkedMetadata(anchor,anchorId,maxBytes);if(anchor.appProperties['mypace.role']!=='bootstrap')fail('STORE_RECOVERY_ANCHOR_INVALID');
   let hint=null,hintSize=0;
   try{hint=this._metadataResult(metadata[1]);if(hint)hintSize=this._checkedMetadata(hint,this.checkpointHintId,CHECKPOINT_HINT_MAX_BYTES,true);}catch(_){hint=null;hintSize=0;}
   // A denied, corrupt, foreign or oversized advisory hint has no authority.
   // Skip its media entirely; never retry it through another read route.
   const reads=[{id:anchorId,suffix:'?alt=media',headers:{Range:'bytes=0-'+(size-1),'Accept-Encoding':'identity'}}];
   if(hint)reads.push({id:this.checkpointHintId,suffix:'?alt=media',headers:{Range:'bytes=0-'+(hintSize-1),'Accept-Encoding':'identity'}});
   check();const media=batch(reads);if(media===null)return {hintBytes:null};check();
   const bytes=this._mediaResult(media[0],size);let hintBytes=null;
   if(hint)try{hintBytes=this._mediaResult(media[1],hintSize);}catch(_){/* Bad advisory media cannot invalidate a strictly verified anchor. */}
   check();
   // Publish only after the complete admitted batch validates. The hint is
   // returned for one immediate use and is never put in any immutable cache.
   this._remember(anchorId,bytes,anchor);this._hintParentProofUsed=true;
   return {hintBytes};
  }catch(error){this.endReadPhase();throw error;}
 }
 prefetchFiles(fileIds,maxBytes=MAX){
  if(!Array.isArray(fileIds)||fileIds.length>16)fail('STORE_PREFETCH_BOUND');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX)fail('STORE_READ_BOUND');
  if(fileIds.some(fileId=>!id(fileId)))fail('STORE_ID_INVALID');
  if(fileIds.includes(this.checkpointHintId))fail('STORE_HINT_ROLE_REQUIRED');
  this.assertLockHeld();this._budget();
  // Prefetch is useful only while a runtime-owned uninterrupted lock can keep
  // positive metadata/bytes valid. Other cache modes use ordinary reads.
  if(!this._readCacheActive||this._readCacheLimits.mode!=='lock-phase')return 0;
  const phase=this._readPhaseToken,check=()=>{this.assertLockHeld();this._budget();if(!this._readCacheActive||this._readPhaseToken!==phase)fail('STORE_READ_PHASE_CHANGED');};
  const wanted=[...new Set(fileIds)].filter(fileId=>!this._cached(fileId,maxBytes));if(!wanted.length)return 0;
  try{
   if(!this._readParentValidated){this._parent();check();this._readParentValidated=true;}
   const metadata=this._fetchMany(wanted.map(id=>({id,suffix:'?fields='+encodeURIComponent(FIELDS)})));check();
   const present=[];for(let i=0;i<wanted.length;i++){const m=this._metadataResult(metadata[i]);if(m===null)continue;const n=this._checkedMetadata(m,wanted[i],maxBytes);if(!PREFETCH_ROLES.has(m.appProperties['mypace.role']))fail('STORE_PREFETCH_ROLE_INVALID');present.push({id:wanted[i],m,n});}
   if(!present.length)return 0;check();
   const media=this._fetchMany(present.map(item=>({id:item.id,suffix:'?alt=media',headers:{Range:'bytes=0-'+(item.n-1),'Accept-Encoding':'identity'}})));check();
   const bytes=media.map((r,i)=>this._mediaResult(r,present[i].n));check();
   // Publish no partial batch on validation failure, and never cache absence.
   for(let i=0;i<present.length;i++)this._remember(present[i].id,bytes[i],present[i].m);
   return present.length;
  }catch(error){this.endReadPhase();throw error;}
 }

 _parent(){const m=this._metadata(this.managedParentId);if(!m||m.id!==this.managedParentId||m.mimeType!=='application/vnd.google-apps.folder'||m.trashed!==false||m.ownedByMe!==true||m.shared!==false)fail('STORE_PARENT_NOT_PRIVATE');}
 allocateIds(n){this.assertLockHeld();this._budget();if(!Number.isSafeInteger(n)||n<1||n>1000)fail('STORE_ID_COUNT');let r;try{r=this.restTransport?this.restTransport.generateIds(n):this.Drive.Files.generateIds({count:n,space:'drive',type:'files'});}catch(e){retry('STORE_IDS_UNRESOLVED');}if(!r||!Array.isArray(r.ids)||r.ids.length!==n||r.ids.some(x=>!id(x))||new Set(r.ids).size!==n)fail('STORE_IDS_INVALID');return r.ids;}
 readFile(fileId,maxBytes=MAX){
  if(fileId===this.checkpointHintId)fail('STORE_HINT_ROLE_REQUIRED');
  return this._readFile(fileId,maxBytes);
 }
 _readFile(fileId,maxBytes=MAX,hint=false){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX)fail('STORE_READ_BOUND');
  if(!id(fileId))fail('STORE_ID_INVALID');
  // A frozen-cut continuation starts a fresh lock phase too. Folder privacy
  // must be re-established before serving even an immutable child file.
  if(!this._readParentValidated){this._parent();if(this._readCacheActive)this._readParentValidated=true;}
  const hit=hint?null:this._cached(fileId,maxBytes);if(hit&&this._readCacheLimits.mode==='lock-phase')return Uint8Array.from(hit.bytes);
  const m=this._metadata(fileId);if(m===null){this._forget(fileId);return null;}
  const n=this._checkedMetadata(m,fileId,maxBytes,hint);
  if(hit&&hit.bytes.length===n&&hit.version===m.version&&hit.md5Checksum===m.md5Checksum)return Uint8Array.from(hit.bytes);
  this._forget(fileId);
  const r=this._fetch(fileId,'?alt=media',{Range:'bytes=0-'+(n-1),'Accept-Encoding':'identity'}),b=this._mediaResult(r,n);if(!hint)this._remember(fileId,b,m);return b;
 }
 // The only mutable IO surface has NO ID argument. It is bound to an optional
 // bootstrap pin, never accepts metadata/parent/role from callers, and is never
 // cached as immutable protocol data. Failure is safe: recovery uses the anchor.
 readCheckpointHint(){
  this.assertLockHeld();if(!this.checkpointHintId)return null;
  // The first hint read shares the parent's fresh proof established by the
  // anchor in this lock phase. A second hint read still rechecks parent privacy
  // so revisiting mutable advisory state cannot silently reuse an older proof.
  if(this._readCacheActive&&this._hintParentProofUsed)this._parent();
  const bytes=this._readFile(this.checkpointHintId,CHECKPOINT_HINT_MAX_BYTES,true);
  if(this._readCacheActive)this._hintParentProofUsed=true;return bytes;
 }
 writeCheckpointHint(bytes){
  this.assertLockHeld();this._budget();if(this.canWriteHint()!==true)retry('STORE_YIELD');
  return this.restTransport?this.restTransport.advisory(()=>this._writeCheckpointHintNow(bytes)):this._writeCheckpointHintNow(bytes);
 }
 _writeCheckpointHintNow(bytes){
  this.assertLockHeld();this._budget();
  if(!this.checkpointHintId||!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>CHECKPOINT_HINT_MAX_BYTES)fail('STORE_HINT_WRITE_INVALID');
  this._writeParent();const fileId=this.checkpointHintId,m=this._metadata(fileId);
  if(m&&(m.id!==fileId||m.trashed!==false||m.ownedByMe!==true||m.shared!==false||m.mimeType!==MIME||!Array.isArray(m.parents)||m.parents.length!==1||m.parents[0]!==this.managedParentId||m.appProperties?.['mypace.store']!==this.storeId||m.appProperties?.['mypace.role']!=='checkpoint-hint'))fail('STORE_HINT_METADATA_MISMATCH');
  const name='mypace-checkpoint-hint-'+fileId,blob=this.restTransport?null:this.Utilities.newBlob(Array.from(bytes,n=>n>127?n-256:n),MIME,name);
  this.assertLockHeld();this._budget();
  // One attempt only. Response loss never allocates a new ID or retries a stale
  // payload; a late update may regress this hint and successors repair recovery.
  let result;
  if(m){if(this.restTransport)result=this.restTransport.update(fileId,bytes);else{if(typeof this.Drive.Files.update!=='function')fail('STORE_HINT_UPDATE_UNAVAILABLE');result=this.Drive.Files.update({},fileId,blob,{fields:'id'});}}
  else {const metadata={id:fileId,name,mimeType:MIME,parents:[this.managedParentId],appProperties:{'mypace.store':this.storeId,'mypace.role':'checkpoint-hint'}};result=this.restTransport?this.restTransport.create(metadata,bytes):this.Drive.Files.create(metadata,blob,{fields:this._managedWritePhase?CREATE_FIELDS:'id',ignoreDefaultVisibility:true});}
  if(!result||result.id!==fileId)fail('STORE_HINT_WRITE_UNRESOLVED');
  return true;
 }
 createMany(files){
  if(!Array.isArray(files)||files.length>4)fail('STORE_CREATE_BATCH_INVALID');
  const ids=new Set();let total=0;
  const admitted=files.map(file=>{
   if(!file||typeof file!=='object'||Array.isArray(file)||Object.keys(file).sort().join(',')!=='bytes,id,role'||!id(file.id)||file.id===this.checkpointHintId||file.id===this.managedParentId||ids.has(file.id)||file.role!=='index-node'||!(file.bytes instanceof Uint8Array)||file.bytes.length<1||file.bytes.length>MAX)fail('STORE_CREATE_BATCH_INVALID');
   ids.add(file.id);total+=file.bytes.length;if(total>1048576)fail('STORE_CREATE_BATCH_BOUND');return {id:file.id,role:file.role,bytes:Uint8Array.from(file.bytes)};
  });
  if(!admitted.length)return [];
  this.assertLockHeld();this._budget();for(const file of admitted)this._forget(file.id);
  // One bounded lock-phase parent proof for app-managed immutable outputs.
  // Legacy/maintenance callers retain the previous per-output policy.
  if(this._managedWritePhase)this._writeParent();else{
   const parents=this._fetchMany(admitted.map(()=>({id:this.managedParentId,suffix:'?fields='+encodeURIComponent(FIELDS)})));
   this.assertLockHeld();this._budget();
   for(const response of parents){const m=this._metadataResult(response);if(!m||m.id!==this.managedParentId||m.mimeType!=='application/vnd.google-apps.folder'||m.trashed!==false||m.ownedByMe!==true||m.shared!==false)fail('STORE_PARENT_NOT_PRIVATE');}
  }
  const proposals=admitted.map(file=>({metadata:{id:file.id,name:'mypace-index-node-'+file.id,mimeType:MIME,parents:[this.managedParentId],appProperties:{'mypace.store':this.storeId,'mypace.role':'index-node'}},bytes:file.bytes}));
  this.assertLockHeld();this._budget();
  const ambiguous=status=>{const error=Error('STORE_CREATE_UNRESOLVED');error.code=error.message;error.retryable=true;error.mayHaveCreated=true;if(Number.isInteger(status))error.status=status;throw error;};
  const attempted=create=>{try{return create();}catch(error){
   const code=error?.code||error?.message;if(['STORE_YIELD','OWNER_BUDGET_YIELD','STORE_LOCK_REQUIRED'].includes(code))throw error;
   // The immutable IDs were admitted and pinned before this call. A raw
   // Advanced Drive timeout/409 is ambiguous too; only same-ID readback can
   // establish its result. Never convert earlier privacy/lock validation.
   ambiguous(Number.isInteger(error?.status)?error.status:Number.isInteger(error?.code)?error.code:undefined);
  }};
  const result=this.restTransport?.createMany?attempted(()=>this.restTransport.createMany(proposals)):proposals.map(proposal=>{
   this.assertLockHeld();this._budget();this._writeParent();
   const blob=this.restTransport?null:this.Utilities.newBlob(Array.from(proposal.bytes,n=>n>127?n-256:n),MIME,proposal.metadata.name);
   this.assertLockHeld();this._budget();
   return attempted(()=>this.restTransport?this.restTransport.create(proposal.metadata,proposal.bytes):this.Drive.Files.create(proposal.metadata,blob,{fields:this._managedWritePhase?CREATE_FIELDS:'id',ignoreDefaultVisibility:true}));
  });
  this.assertLockHeld();
  if(!Array.isArray(result)||result.length!==admitted.length||result.some((r,i)=>!r||r.id!==admitted[i].id))ambiguous();
  for(let i=0;i<admitted.length;i++)this._acceptCreate(admitted[i].id,admitted[i].bytes,admitted[i].role,result[i]);
  return result;
 }
 createFile(fileId,bytes,role){
  this.assertLockHeld();this._budget();if(fileId===this.checkpointHintId||role==='checkpoint-hint')fail('STORE_HINT_ROLE_REQUIRED');if(!id(fileId)||typeof role!=='string'||! /^[a-z][a-z0-9-]{0,63}$/.test(role)||!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>MAX)fail('STORE_CREATE_INVALID');
  this._forget(fileId);this._writeParent();const metadata={id:fileId,name:'mypace-'+role+'-'+fileId,mimeType:MIME,parents:[this.managedParentId],appProperties:{'mypace.store':this.storeId,'mypace.role':role}};
  const blob=this.restTransport?null:this.Utilities.newBlob(Array.from(bytes,n=>n>127?n-256:n),MIME,metadata.name);
  // Caller MUST read this same ID after any result, including timeout or 409.
  // No new-ID fallback or authoritative object updates exist in this adapter.
  this.assertLockHeld();this._budget();const result=this.restTransport?this.restTransport.create(metadata,bytes):this.Drive.Files.create(metadata,blob,{fields:this._managedWritePhase?CREATE_FIELDS:'id',ignoreDefaultVisibility:true});if(!result||result.id!==fileId)fail('STORE_CREATE_ID_MISMATCH');this._acceptCreate(fileId,bytes,role,result);return result;
 }
}
