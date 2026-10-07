// Local candidate only. This module does NOT supply the reserved-slot writer,
// allocate file IDs, persist pins, or authorize a deployment.
import {IncrementalSha256, encodeUtf8, decodeUtf8} from './codec.mjs';

export const MAX_OUTPUT_BYTES = 256 * 1024;
export const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 256 * 1024;
const ROLE_LIMITS = Object.freeze({output: MAX_OUTPUT_BYTES, checkpoint: MAX_CHECKPOINT_BYTES, 'manifest-page': MAX_MANIFEST_BYTES});
const FIELDS = 'id,parents,appProperties,size,trashed,mimeType,ownedByMe,shared';
const MIME = 'application/octet-stream';
const fail = code => { throw new Error(code); };
const safeAssetError = error => /^(?:ASSET_(?:(?:METADATA|CONTENT)_MISMATCH|BYTES_INVALID|TOO_LARGE|UNRESOLVED|MEDIA_[A-Z_]+)|IMPORT_YIELD)$/.test(error?.message || '');
const unresolvedAsset = stage => {const e=new Error('ASSET_UNRESOLVED');e.retryable=true;e.stage=stage;return e;};
const token = (value, max=100) => typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);

function asBytes(value, limit, code='ASSET_BYTES_INVALID') {
  if (!value || !Number.isSafeInteger(value.length) || value.length > limit) fail(value && value.length > limit ? 'ASSET_TOO_LARGE' : code);
  const out = new Uint8Array(value.length);
  for (let i=0; i<value.length; i++) {
    const n=value[i];
    // GAS Blob.getBytes() uses signed Java bytes; typed arrays use unsigned bytes.
    if (!Number.isInteger(n) || n < -128 || n > 255) fail(code);
    out[i]=n & 255;
  }
  return out;
}
export function hashAssetBytes(bytes) { return new IncrementalSha256().update(bytes).digestHex(); }

export function encodeBoundedJson(value, maxBytes=MAX_CHECKPOINT_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CHECKPOINT_BYTES) fail('JSON_BOUND_INVALID');
  let json;
  try { json=JSON.stringify(value); } catch (_) { fail('JSON_INVALID'); }
  if (typeof json !== 'string') fail('JSON_INVALID');
  // Early character check avoids encoding an already over-large string.
  if (json.length > maxBytes) fail('CHECKPOINT_TOO_LARGE');
  const bytes=encodeUtf8(json);
  if (bytes.length > maxBytes) fail('CHECKPOINT_TOO_LARGE');
  return bytes;
}

function validatedReservation(input, storeId) {
  if (!input || !token(input.fileId, 128) || !token(input.jobId) || !token(input.pinId) || input.storeId !== storeId || !Object.prototype.hasOwnProperty.call(ROLE_LIMITS,input.role)) fail('RESERVATION_INVALID');
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > ROLE_LIMITS[input.role]) fail('ASSET_TOO_LARGE');
  if (typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.sha256)) fail('RESERVATION_DIGEST_INVALID');
  return Object.freeze({fileId:input.fileId,storeId:input.storeId,jobId:input.jobId,pinId:input.pinId,role:input.role,byteLength:input.byteLength,sha256:input.sha256});
}
function markers(r) { return {'mypace.store':r.storeId,'mypace.job':r.jobId,'mypace.pin':r.pinId,'mypace.role':r.role,'mypace.sha256':r.sha256}; }

/**
 * Advanced Drive v3 immutable multipart creates with mandatory exact read-back.
 * assertReservation(r) must return true only for a reservation already persisted
 * in the EXISTING writer's live pinned job. A supplied object or appProperties
 * alone is not authorization. readAssetBytes(id, byteLength, maxBytes) must be a
 * bounded, authenticated media reader restricted to the supplied same fixed ID.
 * No dependency may silently perform alternate-ID creation or overwrite.
 */
export class ImmutableAssetAdapter {
  constructor({Drive,Utilities,readAssetBytes,managedParentId,storeId,assertReservation}) {
    if (!Drive?.Files || typeof Drive.Files.create!=='function' || typeof Drive.Files.get!=='function' || typeof Utilities?.newBlob!=='function' || typeof readAssetBytes!=='function' || typeof assertReservation!=='function' || !token(managedParentId,128) || !token(storeId)) fail('ASSET_ADAPTER_CONFIG_INVALID');
    this.Drive=Drive; this.Utilities=Utilities; this.readAssetBytes=readAssetBytes;
    this.managedParentId=managedParentId; this.storeId=storeId; this.assertReservation=assertReservation;
  }
  _proposal({reservation,bytes}) {
    const r=validatedReservation(reservation,this.storeId);
    // Never let a caller-created descriptor stand in for durable writer evidence.
    if (this.assertReservation(r)!==true) fail('RESERVATION_NOT_DURABLE');
    const body=asBytes(bytes,ROLE_LIMITS[r.role]);
    if (body.length!==r.byteLength || hashAssetBytes(body)!==r.sha256) fail('ASSET_PROPOSAL_MISMATCH');
    return {r,body};
  }
  _privateParent() {
    let parent;
    try { parent=this.Drive.Files.get(this.managedParentId,{fields:'id,mimeType,trashed,ownedByMe,shared'}); }
    catch (_) { const e=new Error('MANAGED_PARENT_UNRESOLVED');e.retryable=true;throw e; }
    if (!parent || parent.id!==this.managedParentId || parent.mimeType!=='application/vnd.google-apps.folder' || parent.trashed!==false || parent.ownedByMe!==true || parent.shared!==false) fail('MANAGED_PARENT_NOT_PRIVATE');
  }
  _verify(r,expected) {
    let meta;
    try { meta=this.Drive.Files.get(r.fileId,{fields:FIELDS}); }
    catch (_) {throw unresolvedAsset('metadata');}
    const props=markers(r);
    if (!meta || meta.id!==r.fileId || meta.trashed!==false || meta.ownedByMe!==true || meta.shared!==false || meta.mimeType!==MIME || !Array.isArray(meta.parents) || meta.parents.length!==1 || meta.parents[0]!==this.managedParentId || String(meta.size)!==String(r.byteLength) || Object.keys(props).some(k=>meta.appProperties?.[k]!==props[k])) fail('ASSET_METADATA_MISMATCH');
    // Metadata is checked before media retrieval, with a fixed per-role bound.
    let read;
    try { read=this.readAssetBytes(r.fileId,r.byteLength,ROLE_LIMITS[r.role]); }
    catch(error) {if(safeAssetError(error))throw error;throw unresolvedAsset('media');}
    const actual=asBytes(read,ROLE_LIMITS[r.role]);
    if (actual.length!==expected.length || hashAssetBytes(actual)!==r.sha256) fail('ASSET_CONTENT_MISMATCH');
    for (let i=0; i<actual.length; i++) if(actual[i]!==expected[i]) fail('ASSET_CONTENT_MISMATCH');
    return Object.freeze({...r,verified:true});
  }
  verify(proposal) {
    const {r,body}=this._proposal(proposal);
    return this._verify(r,body);
  }
  putOnce(proposal) {
    const {r,body}=this._proposal(proposal);
    this._privateParent();
    // A resumed reservation may already have uploaded this exact immutable ID.
    // Verify it before issuing another guaranteed-conflicting create. Fresh
    // batches retain create-first behavior; no byte/privacy check is skipped.
    if(proposal.reuseExisting===true){
      try{return this._verify(r,body);}catch(error){
        // Only an unresolved metadata lookup can mean this reserved slot still
        // needs its first create. Existing wrong metadata/content or a failed
        // media read never permits a write/replacement fallback.
        if(error?.message!=='ASSET_UNRESOLVED'||error.stage!=='metadata')throw error;
      }
    }
    const metadata={id:r.fileId,name:`mypace-${r.role}-${r.fileId}`,mimeType:MIME,parents:[this.managedParentId],appProperties:markers(r)};
    const signed=Array.from(body,n=>n>127?n-256:n);
    const blob=this.Utilities.newBlob(signed,MIME,metadata.name);
    let createError;
    try {
      const result=this.Drive.Files.create(metadata,blob,{fields:'id',ignoreDefaultVisibility:true});
      if (!result || result.id!==r.fileId) fail('ASSET_CREATE_ID_MISMATCH');
    } catch(error) {
      if (error?.message==='ASSET_CREATE_ID_MISMATCH') throw error;
      createError=error;
      // Including timeout/409: inspect THIS ID. Never search/create another ID.
    }
    try { return this._verify(r,body); }
    catch(error) {
      // Content/identity corruption is terminal. Other read failures remain
      // unresolved; a caller may retry the same committed descriptor later.
      if (safeAssetError(error)) throw error;
      const unresolved=new Error('ASSET_UNRESOLVED');
      unresolved.retryable=true;
      unresolved.fileId=r.fileId;
      unresolved.stage=createError?'create-or-readback':'readback';
      throw unresolved;
    }
  }
}

/**
 * Server-internal same-ID media reader for the adapter above. This is not a
 * client API accepting arbitrary Drive IDs. assertReadableAsset must validate
 * the caller's current committed managed reservation before ANY request; the
 * adapter also checks ownership/privacy/markers before invoking this function.
 * GAS fetch buffers its response and offers no request streaming/body ceiling:
 * the requested range is bounded, but a misbehaving server may allocate a larger
 * response before rejection. Never fall back to a full-file 200 download.
 */
export function createGasAssetMediaReader({UrlFetchApp,ScriptApp,assertReadableAsset,checkBudget}) {
  if (typeof UrlFetchApp?.fetch!=='function' || typeof ScriptApp?.getOAuthToken!=='function' || typeof assertReadableAsset!=='function' || typeof checkBudget!=='function') fail('ASSET_MEDIA_CONFIG_INVALID');
  return function readAssetBytes(fileId,expectedLength,maxBytes) {
    if (!token(fileId,128) || !Number.isSafeInteger(expectedLength) || expectedLength<1 || !Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>MAX_CHECKPOINT_BYTES || expectedLength>maxBytes) fail('ASSET_MEDIA_BOUNDS_INVALID');
    if (assertReadableAsset(fileId,expectedLength,maxBytes)!==true) fail('ASSET_MEDIA_NOT_RESERVED');
    if (checkBudget('asset-media')!==true) {const e=new Error('IMPORT_YIELD');e.retryable=true;throw e;}
    let response;
    try {
      const oauth=ScriptApp.getOAuthToken();
      if (typeof oauth!=='string' || !oauth) fail('ASSET_AUTH_UNAVAILABLE');
      response=UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(fileId)+'?alt=media',{
        method:'get',headers:{Authorization:'Bearer '+oauth,Range:'bytes=0-'+(expectedLength-1),'Accept-Encoding':'identity'},
        muteHttpExceptions:true,followRedirects:false
      });
    } catch (_) {const e=new Error('ASSET_MEDIA_PENDING');e.retryable=true;throw e;}
    if (!response || typeof response.getResponseCode!=='function' || typeof response.getAllHeaders!=='function' || typeof response.getContent!=='function') fail('ASSET_MEDIA_RESPONSE_INVALID');
    const status=response.getResponseCode();
    if (status!==206) {
      const e=new Error('ASSET_MEDIA_STATUS');e.status=status;
      e.retryable=[401,403,404,408,429,500,502,503,504].includes(status);throw e;
    }
    const all=response.getAllHeaders();
    if (!all || typeof all!=='object' || Array.isArray(all)) fail('ASSET_MEDIA_HEADERS_INVALID');
    const header=name=>{
      const keys=Object.keys(all).filter(k=>k.toLowerCase()===name);
      if (!keys.length) return null;
      if (keys.length!==1 || !['string','number'].includes(typeof all[keys[0]])) fail('ASSET_MEDIA_HEADERS_INVALID');
      return String(all[keys[0]]).trim();
    };
    if (header('content-range')!=='bytes 0-'+(expectedLength-1)+'/'+expectedLength) fail('ASSET_MEDIA_RANGE_MISMATCH');
    const length=header('content-length'),encoding=header('content-encoding');
    if ((length!==null && length!==String(expectedLength)) || (encoding!==null && encoding.toLowerCase()!=='identity')) fail('ASSET_MEDIA_HEADERS_INVALID');
    const body=asBytes(response.getContent(),maxBytes);
    if (body.length!==expectedLength) fail('ASSET_CONTENT_MISMATCH');
    return body;
  };
}

export const MAX_BATCH_OUTPUT_ASSETS = 64;
export const MAX_BATCH_OUTPUT_BYTES = 8 * 1024 * 1024;

// Restricted canonical JSON keeps a command stable across retries even if object
// insertion order differs. The digest binds checkpoints as well as route output.
function canonical(value, depth=0) {
  if (depth>32) fail('COMMAND_TOO_DEEP');
  if (value===null || typeof value==='string' || typeof value==='boolean') return JSON.stringify(value);
  if (typeof value==='number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '['+value.map(v=>canonical(v,depth+1)).join(',')+']';
  if (typeof value==='object' && value && Object.getPrototypeOf(value)===Object.prototype) return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k],depth+1)).join(',')+'}';
  fail('COMMAND_VALUE_INVALID');
}
function receiptFor(receipt, command) {
  if (!receipt || receipt.operationId!==command.operationId || receipt.digest!==command.digest) fail('OP_ID_REUSED');
  return receipt;
}

/**
 * Two bounded lock phases around immutable staging. All durable state and
 * authoritative commit/recovery remain in the injected EXISTING reserved-slot
 * writer; this is deliberately not another database or a fake production writer.
 *
 * Required synchronous writer methods, called with the script lock held:
 *   recoveryBarrier(): finish/check all mandatory publication barriers or throw.
 *   getReceipt(operationId): return committed original receipt or null.
 *   validateImportBatch(command,{checkpoint,manifestPage}): return true only after checking store/writer
 *     identity, expected job checkpoint, every persisted reservation and active
 *     durable pin; their lengths/hashes/roles must exactly match command.assets. Verify the
 *     decoded checkpoint schema/expected previousManifest and exact output
 *     descriptors and links in the manifest page. Role counts are not enough.
 *   commitImportBatch(command,{verifiedAssets}): use the existing reserved-slot
 *     protocol and ordered version-checked job/ready/reference transition; return
 *     {operationId,digest,...}. Unpinning must have no reference-protection gap.
 *
 * validateSourceCurrent(sourceIdentity) must re-read source metadata and compare
 * ID, observed version, checksum, size, direct parent and candidate restrictions.
 * It runs under the final lock, immediately before commit. A writer must still
 * verify every ready descriptor/pin in the same authoritative frame transition.
 * The writer must not trust command fields or verified:true as authorization.
 * completed means parsing finished in this staged checkpoint ONLY. This module
 * never publishes a completed run or contributes totals/rewards. Full manifest,
 * source hash/count/stability and domain checks still gate that separate action.
 * Required checkBudget(stage) in an invocation: true only while enough time/quota
 * remains, INCLUDING an early checkpoint/recovery reserve. False yields with
 * existing checkpoint/pins intact. A GAS API call cannot be interrupted once
 * started; there is no per-call timeout guarantee. The callback must
 * conservatively reserve the ENTIRE final verify/source/commit/recovery phase
 * before final-lock, using observed call latency and bounded batch size.
 */
export class ImportCheckpointCoordinator {
  constructor({writer,assets,getScriptLock,validateSourceCurrent,lockTimeoutMs=1000,checkBudget}) {
    if (!writer || ['recoveryBarrier','getReceipt','validateImportBatch','commitImportBatch'].some(k=>typeof writer[k]!=='function') || !assets || typeof assets.putOnce!=='function' || typeof assets.verify!=='function' || typeof getScriptLock!=='function' || typeof validateSourceCurrent!=='function' || typeof checkBudget!=='function' || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs<0 || lockTimeoutMs>5000) fail('COORDINATOR_CONFIG_INVALID');
    this.writer=writer; this.assets=assets; this.getScriptLock=getScriptLock;
    this.validateSourceCurrent=validateSourceCurrent; this.lockTimeoutMs=lockTimeoutMs; this.checkBudget=checkBudget;
  }
  _budget(stage) {
    if (this.checkBudget(stage)!==true) {const e=new Error('IMPORT_YIELD');e.retryable=true;throw e;}
  }
  _locked(fn) {
    const lock=this.getScriptLock();
    if (!lock || typeof lock.tryLock!=='function' || typeof lock.releaseLock!=='function') fail('LOCK_INVALID');
    // Owner-editor orchestration may already hold this exact project lock.
    // Never release a lock acquired by the caller.
    if (typeof lock.hasLock==='function' && lock.hasLock()===true) return fn();
    let acquired=false;
    try {
      acquired=lock.tryLock(this.lockTimeoutMs)===true;
      if (!acquired) { const e=new Error('WRITER_BUSY');e.retryable=true;throw e; }
      return fn();
    } finally { if (acquired) lock.releaseLock(); }
  }
  _validate(command, content) {
    if (this.writer.validateImportBatch(command,content)!==true) fail('JOB_RESERVATION_OR_VERSION_INVALID');
  }
  commitPreparedBatch(input) {
    if (!input || !token(input.operationId,128) || !token(input.jobId) || !(input.expectedCheckpointId===null || token(input.expectedCheckpointId,128)) || typeof input.completed!=='boolean' || !input.sourceIdentity || !Array.isArray(input.assets) || input.assets.length<2 || input.assets.length>MAX_BATCH_OUTPUT_ASSETS+2) fail('IMPORT_COMMAND_INVALID');
    const seen=new Set();
    const staged=[]; let outputCount=0, outputBytes=0, checkpointCount=0, manifestCount=0;
    for (const a of input.assets) {
      const r=validatedReservation(a?.reservation,a?.reservation?.storeId);
      if (r.jobId!==input.jobId || seen.has(r.fileId)) fail('IMPORT_ASSET_IDENTITY_INVALID');
      seen.add(r.fileId);
      const bytes=asBytes(a.bytes,ROLE_LIMITS[r.role]);
      if (bytes.length!==r.byteLength || hashAssetBytes(bytes)!==r.sha256) fail('ASSET_PROPOSAL_MISMATCH');
      if (r.role==='output') {outputCount++;outputBytes+=r.byteLength;}
      if (r.role==='checkpoint') checkpointCount++;
      if (r.role==='manifest-page') manifestCount++;
      staged.push({reservation:r,bytes});
    }
    if (checkpointCount!==1 || manifestCount!==1 || outputCount>MAX_BATCH_OUTPUT_ASSETS || outputBytes>MAX_BATCH_OUTPUT_BYTES) fail('IMPORT_BATCH_BOUNDS_INVALID');
    const storeId=staged[0].reservation.storeId;
    if (!token(storeId) || staged.some(a=>a.reservation.storeId!==storeId)) fail('IMPORT_STORE_MISMATCH');
    // Clone and cap source identity rather than retaining caller-mutable state.
    const sourceJson=canonical(input.sourceIdentity);
    if (encodeUtf8(sourceJson).length>16*1024) fail('SOURCE_IDENTITY_TOO_LARGE');
    const base={protocol:'mypace-import-batch-v1',storeId,operationId:input.operationId,jobId:input.jobId,expectedCheckpointId:input.expectedCheckpointId,sourceIdentity:JSON.parse(sourceJson),completed:input.completed,assets:staged.map(a=>a.reservation)};
    const digest=hashAssetBytes(encodeUtf8(canonical(base)));
    // Recursive freeze prevents callbacks changing the command after hashing.
    const freeze=(v,depth=0)=>{if(depth>32)fail('COMMAND_TOO_DEEP');if(v && typeof v==='object'){Object.values(v).forEach(x=>freeze(x,depth+1));Object.freeze(v);}return v;};
    const command=freeze({...base,digest});
    const parsed={};
    for (const a of staged) if(a.reservation.role!=='output') {
      let value;
      try { value=JSON.parse(decodeUtf8(a.bytes)); } catch (_) { fail('IMPORT_CHECKPOINT_JSON_INVALID'); }
      if (!value || typeof value!=='object' || Array.isArray(value)) fail('IMPORT_CHECKPOINT_JSON_INVALID');
      parsed[a.reservation.role==='checkpoint'?'checkpoint':'manifestPage']=value;
    }
    const content=freeze(parsed);
    const prior=this._locked(()=>{
      this.writer.recoveryBarrier();
      const receipt=this.writer.getReceipt(command.operationId);
      if (receipt) return receiptFor(receipt,command);
      this._validate(command,content);
      return null;
    });
    if (prior) return prior;
    // IDs and live pins have already been committed and checked above.
    // Normal runner uploads release the phase lock here. An owner-editor
    // invocation may deliberately hold the outer lock for its bounded step.
    for (const a of staged) { this._budget('stage'); this.assets.putOnce(input.reuseExisting===true?{...a,reuseExisting:true}:a); }
    this._budget('final-lock');
    return this._locked(()=>{
      this.writer.recoveryBarrier();
      const receipt=this.writer.getReceipt(command.operationId);
      if (receipt) return receiptFor(receipt,command);
      this._validate(command,content);
      const verifiedAssets=staged.map(a=>{this._budget('verify');return this.assets.verify(a);});
      this._budget('source');
      if (this.validateSourceCurrent(command.sourceIdentity)!==true) fail('SOURCE_CHANGED');
      this._budget('commit');
      const committed=receiptFor(this.writer.commitImportBatch(command,{verifiedAssets}),command);
      // Mandatory checkpoint-index publication recovery precedes success as well
      // as the next mutation. No hint write can substitute for this barrier.
      this.writer.recoveryBarrier();
      return committed;
    });
  }
}
