/**
 * Portable, synchronous GAS V8 reserved-slot writer. No external state is
 * authoritative: the fixed Drive bootstrap, immutable frames, index links and
 * copy-on-write radix shards are the complete durable store.
 *
 * IO contract (all methods synchronous):
 * getScriptId(), assertLockHeld() === true, allocateIds(n) -> unique IDs;
 * readFile(id, maxBytes) -> bytes or null ONLY for positively identified 404;
 * createFile(id, bytes, role) -> immutable same-ID create, NEVER overwrite.
 * Optional readCheckpointHint()/writeCheckpointHint(bytes) address one fixed
 * separately pinned, non-authoritative mutable hint; they accept no caller ID.
 * IO must enforce private owned managed-parent metadata and byte bounds.
 * Caller owns the script lock. This module never acquires/releases another
 * invocation's lock. A fresh recoveryBarrier() is required each lock phase.
 *
 * This is a local implementation, not proof of Drive's complete-byte atomic
 * create/visibility semantics. Those remain live integration gates. No GC,
 * deployment, endpoint authentication or domain-specific authorization here.
 * An optional authenticated, separately pinned mutable hint accelerates cold
 * recovery; immutable index/manifest/publication verification remains mandatory.
 * The absolute index ordinal is authenticated, but is not a lifetime limit.
 * With authenticated recovery configured, maxIndexScanLinks bounds discovery
 * per call (also respecting a smaller maxIndexLinks); signed INDEX-prefix cursors
 * resume full-anchor scans. No state
 * is ready until discovery and current manifest/publication/tail verification
 * finish. Missing keys or unsupported legacy stores require owner setup at the
 * safe legacy admission limit. Receipts and revision proofs are never purged.
 * Referenced shards are verified on bounded traversal, not by a full-store scrub.
 */
import {CHECKPOINT_HINT_PROTOCOL,INDEX_SCAN_HINT_PROTOCOL} from './checkpoint-hint.mjs';
import {IncrementalSha256, encodeUtf8, decodeUtf8} from './codec.mjs';

export const WRITER_PROTOCOL = 'mypace-reserved-v1';
export const WRITER_ROLES = Object.freeze(['bootstrap','frame','index-node','checkpoint-manifest','checkpoint-index']);
const DEFAULT_LIMITS = Object.freeze({maxFileBytes:256*1024,maxValueBytes:128*1024,maxChanges:128,maxReferences:128,maxLeafEntries:512,maxCachedNodes:64,maxReplayFrames:256,maxIndexLinks:4096,maxIndexScanLinks:64,checkpointEvery:16,maxContention:4,maxCreateAttempts:2});
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const validId=s=>typeof s==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const digestOk=s=>typeof s==='string' && /^[0-9a-f]{64}$/.test(s);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
function fail(code,retryable=false) {const e=new Error(code);e.code=code;if(retryable)e.retryable=true;throw e;}
function canonical(value,depth=0) {
  if(depth>40)fail('WRITER_VALUE_DEPTH');
  if(value===null || typeof value==='string' || typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number' && Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value)) {
    for(let i=0;i<value.length;i++)if(!own(value,i))fail('WRITER_VALUE_INVALID');
    return '['+value.map(v=>canonical(v,depth+1)).join(',')+']';
  }
  if(value && typeof value==='object' && Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k],depth+1)).join(',')+'}';
  fail('WRITER_VALUE_INVALID');
}
export function writerDigest(value) {return new IncrementalSha256().update(encodeUtf8(canonical(value))).digestHex();}
function clone(v) {return JSON.parse(canonical(v));}
function equal(a,b) {return canonical(a)===canonical(b);}
function refOk(r) {return r===null || !!(r && validId(r.id) && digestOk(r.hash) && Object.keys(r).sort().join(',')==='hash,id');}
function receiptKey(epoch,id) {return JSON.stringify([epoch,id]);}
function pointer(file) {return {id:file.id,hash:file.hash};}

export class ReservedSlotWriter {
  constructor({io,anchorId,bootstrapId,storeId,writerScriptId,scriptId,schemaVersion=3,limits={},clock=()=>new Date().toISOString(),validateMutation,verifyReferences,checkpointHintId,checkpointHintAnchorHash,checkpointHintCodec}) {
    anchorId=anchorId||bootstrapId;writerScriptId=writerScriptId||scriptId;
    if(!io || ['getScriptId','assertLockHeld','allocateIds','readFile','createFile'].some(k=>typeof io[k]!=='function') || !validId(anchorId) || !validId(storeId) || !validId(writerScriptId) || !integer(schemaVersion) || schemaVersion<1 || typeof clock!=='function')fail('WRITER_CONFIG_INVALID');
    if(checkpointHintId!==undefined&&(!validId(checkpointHintId)||[anchorId,storeId,writerScriptId].includes(checkpointHintId)))fail('WRITER_HINT_CONFIG');
    if(checkpointHintAnchorHash!==undefined&&(!checkpointHintId||!digestOk(checkpointHintAnchorHash)))fail('WRITER_HINT_CONFIG');
    if(checkpointHintCodec!==undefined&&(!checkpointHintId||typeof checkpointHintCodec?.encode!=='function'||typeof checkpointHintCodec?.decode!=='function'||typeof io.readCheckpointHint!=='function'||typeof io.writeCheckpointHint!=='function'))fail('WRITER_HINT_CONFIG');
    this.checkpointHintId=checkpointHintId;this.checkpointHintAnchorHash=checkpointHintAnchorHash;this.checkpointHintCodec=checkpointHintCodec;this._hintRef=null;
    this.io=io;this.anchorId=anchorId;this.storeId=storeId;this.writerScriptId=writerScriptId;this.schemaVersion=schemaVersion;this.clock=clock;this.validateMutation=validateMutation;this.verifyReferences=verifyReferences;
    this.limits={...DEFAULT_LIMITS,...limits};
    if(Object.keys(limits).some(k=>!own(DEFAULT_LIMITS,k)) || Object.values(this.limits).some(v=>!Number.isSafeInteger(v)||v<1) || this.limits.maxValueBytes>this.limits.maxFileBytes || this.limits.checkpointEvery+2>=this.limits.maxReplayFrames)fail('WRITER_LIMITS_INVALID');
    this._state=null;this._cache=new Map();this._ids=[];this._verifiedPhase=null;this._recovering=false;
  }
  _guard() {
    if(this.io.getScriptId()!==this.writerScriptId)fail('WRITER_SCRIPT_MISMATCH');
    if(this.io.assertLockHeld()!==true)fail('WRITER_LOCK_REQUIRED');
  }
  _id() {
    if(!this._ids.length) {
      const ids=this.io.allocateIds(16);
      if(!Array.isArray(ids)||ids.length!==16||ids.some(x=>!validId(x))||new Set(ids).size!==ids.length)fail('WRITER_ID_ALLOCATION_INVALID');
      this._ids=ids.slice();
    }
    return this._ids.shift();
  }
  _sealed(kind,payload) {
    const body={protocol:WRITER_PROTOCOL,kind,storeId:this.storeId,writerScriptId:this.writerScriptId,schemaVersion:this.schemaVersion,payload};
    return {...body,hash:writerDigest(body)};
  }
  _bytes(file) {
    const s=canonical(file);
    if(s.length>this.limits.maxFileBytes)fail('WRITER_FILE_TOO_LARGE');
    const bytes=encodeUtf8(s);if(bytes.length>this.limits.maxFileBytes)fail('WRITER_FILE_TOO_LARGE');return bytes;
  }
  _read(id,kind,ref=null,optional=false) {
    if(!validId(id))fail('WRITER_REFERENCE_INVALID');
    // A throw is never absence. IO owns HTTP status and metadata classification.
    const bytes=this.io.readFile(id,this.limits.maxFileBytes);
    if(bytes===null){if(optional)return null;fail('WRITER_MISSING_REFERENCE');}
    if(!bytes || !integer(bytes.length) || bytes.length<1 || bytes.length>this.limits.maxFileBytes)fail('WRITER_FILE_INVALID');
    let file;try{file=JSON.parse(decodeUtf8(bytes));}catch(_){fail('WRITER_FILE_INVALID');}
    if(!file || Object.keys(file).sort().join(',')!=='hash,kind,payload,protocol,schemaVersion,storeId,writerScriptId' || file.protocol!==WRITER_PROTOCOL || file.kind!==kind || file.storeId!==this.storeId || file.writerScriptId!==this.writerScriptId || file.schemaVersion!==this.schemaVersion || !digestOk(file.hash))fail('WRITER_IDENTITY_INVALID');
    const {hash,...body}=file;
    if(writerDigest(body)!==hash || (ref && (ref.id!==id||ref.hash!==hash)))fail('WRITER_HASH_MISMATCH');
    if(canonical(file)!==decodeUtf8(bytes))fail('WRITER_NONCANONICAL_FILE');
    return {...file,id};
  }
  _createExact(id,kind,payload) {
    const file=this._sealed(kind,payload),bytes=this._bytes(file);
    let observed;
    for(let n=0;n<this.limits.maxCreateAttempts;n++) {
      try{this.io.createFile(id,bytes,kind);}catch(_){/* Same ID read decides; errors are never unconditional success. */}
      observed=this._read(id,kind,null,true);
      if(observed){if(observed.hash!==file.hash)fail('WRITER_IMMUTABLE_CONFLICT');if(kind==='index-node'){this._cache.set(observed.id+':'+observed.hash,observed);if(this._cache.size>this.limits.maxCachedNodes)this._cache.delete(this._cache.keys().next().value);}return pointer(observed);}
    }
    fail('WRITER_CREATE_UNRESOLVED',true);
  }
  _epochs(epochs) {
    if(!Array.isArray(epochs)||epochs.length<1||epochs.length>4||epochs.some(x=>!validId(x))||new Set(epochs).size!==epochs.length)fail('WRITER_EPOCHS_INVALID');return epochs.slice();
  }
  readBootstrap() {return this.readBootstrapInfo().payload;}
  readBootstrapInfo() {
    // Strictly read-only identity inspection for guarded owner repair/config.
    // recoveryBarrier() is not read-only: it may finish mandatory index links.
    this._guard();const anchor=this._read(this.anchorId,'bootstrap');this._checkAnchor(anchor);return {payload:clone(anchor.payload),hash:anchor.hash};
  }
  bootstrap({datasetGeneration='1',acceptedEpochs=['default'],firstSlotId,firstIndexId}={}) {
    this._guard();if(!validId(datasetGeneration))fail('WRITER_GENERATION_INVALID');this._epochs(acceptedEpochs);
    // Owner provisioning can pin the initial successors before ANY Drive create.
    // Supplying either ID requires the pair; retries never allocate replacements.
    const pinned=firstSlotId!==undefined||firstIndexId!==undefined;
    if(pinned&&(!validId(firstSlotId)||!validId(firstIndexId)||firstSlotId===firstIndexId||[firstSlotId,firstIndexId].some(x=>x===this.anchorId||x===this.checkpointHintId)))fail('WRITER_BOOTSTRAP_SLOTS_INVALID');
    let anchor=this._read(this.anchorId,'bootstrap',null,true);
    if(!anchor) {
      // An owner repair binds a pre-existing anchor, never authorizes replacing
      // its missing bytes with a newly shaped bootstrap or a fresh store.
      if(this.checkpointHintAnchorHash!==undefined)fail('WRITER_MISSING_REFERENCE');
      const payload={datasetGeneration,acceptedEpochs:this._epochs(acceptedEpochs),firstSlotId:pinned?firstSlotId:this._id(),firstIndexId:pinned?firstIndexId:this._id(),...(this.checkpointHintId?{checkpointHintId:this.checkpointHintId}:{})};
      // A concurrent same-store initialization may win with different generated
      // slots. Adopt its fixed anchor only after validating the requested identity.
      try{this.io.createFile(this.anchorId,this._bytes(this._sealed('bootstrap',payload)),'bootstrap');}catch(_){}
      anchor=this._read(this.anchorId,'bootstrap',null,true);if(!anchor)fail('WRITER_BOOTSTRAP_UNRESOLVED',true);
    }
    this._checkAnchor(anchor);
    if(anchor.payload.datasetGeneration!==datasetGeneration || !equal(anchor.payload.acceptedEpochs,acceptedEpochs)||(pinned&&(anchor.payload.firstSlotId!==firstSlotId||anchor.payload.firstIndexId!==firstIndexId)))fail('WRITER_BOOTSTRAP_MISMATCH');
    return this.recoveryBarrier();
  }
  _checkAnchor(a) {
    const p=a.payload;
    if(!p || !['acceptedEpochs,datasetGeneration,firstIndexId,firstSlotId','acceptedEpochs,checkpointHintId,datasetGeneration,firstIndexId,firstSlotId'].includes(Object.keys(p).sort().join(',')) || !validId(p.datasetGeneration)||!validId(p.firstSlotId)||!validId(p.firstIndexId)||p.firstSlotId===p.firstIndexId||[p.firstSlotId,p.firstIndexId].includes(this.anchorId))fail('WRITER_BOOTSTRAP_INVALID');
    if(own(p,'checkpointHintId')&&(!validId(p.checkpointHintId)||[this.anchorId,p.firstSlotId,p.firstIndexId,this.storeId,this.writerScriptId].includes(p.checkpointHintId)))fail('WRITER_BOOTSTRAP_INVALID');
    // Explicit guarded owner repair may bind a replacement advisory file to
    // these exact immutable anchor bytes. Without that binding the original
    // embedded pin remains mandatory. These are trusted server-config fields.
    if(this.checkpointHintAnchorHash!==undefined&&a.hash!==this.checkpointHintAnchorHash)fail('WRITER_BOOTSTRAP_MISMATCH');
    if(this.checkpointHintId!==undefined&&((this.checkpointHintAnchorHash===undefined&&p.checkpointHintId!==this.checkpointHintId)||[p.firstSlotId,p.firstIndexId].includes(this.checkpointHintId)))fail('WRITER_BOOTSTRAP_MISMATCH');
    this._epochs(p.acceptedEpochs);
  }
  _node(ref,tree,depth) {
    if(!refOk(ref)||!ref)fail('WRITER_INDEX_REFERENCE_INVALID');
    const key=ref.id+':'+ref.hash;
    let f=this._cache.get(key);if(!f){f=this._read(ref.id,'index-node',ref);this._cache.set(key,f);if(this._cache.size>this.limits.maxCachedNodes)this._cache.delete(this._cache.keys().next().value);}
    const p=f.payload;
    if(!p||p.tree!==tree||p.depth!==depth||!validId(p.slotId)||!['leaf','branch'].includes(p.type))fail('WRITER_INDEX_INVALID');
    if(p.type==='leaf') {
      if(Object.keys(p).sort().join(',')!=='depth,entries,slotId,tree,type'||!Array.isArray(p.entries)||p.entries.length<1||p.entries.length>this.limits.maxLeafEntries)fail('WRITER_INDEX_INVALID');
      let prev=null;for(const e of p.entries){if(!e||Object.keys(e).sort().join(',')!=='key,value'||typeof e.key!=='string'||(prev!==null&&e.key<=prev))fail('WRITER_INDEX_INVALID');prev=e.key;}
    } else {
      if(Object.keys(p).sort().join(',')!=='children,depth,slotId,tree,type'||!Array.isArray(p.children)||p.children.length<1||p.children.length>16||depth>=64)fail('WRITER_INDEX_INVALID');
      let prev='';for(const c of p.children){if(!c||Object.keys(c).sort().join(',')!=='digit,ref'||!/^[0-9a-f]$/.test(c.digit)||c.digit<=prev||!refOk(c.ref)||!c.ref)fail('WRITER_INDEX_INVALID');prev=c.digit;}
    }
    return p;
  }
  _lookup(root,tree,key) {
    let ref=root,depth=0;const h=writerDigest(key);
    while(ref){const p=this._node(ref,tree,depth);if(p.type==='leaf'){const found=p.entries.find(e=>e.key===key);return found?clone(found.value):null;}const digit=h[depth++],child=p.children.find(c=>c.digit===digit);ref=child?child.ref:null;}
    return null;
  }
  _put(root,tree,key,value,slotId,depth=0) {return this._putMany(root,tree,[{key,value}],slotId,depth);}
  // Build the final immutable copy-on-write subtree once for the whole frame.
  // Sequential _put calls leave intermediate roots unreachable; grouping keeps
  // the same transition verifier and durable frame boundary without that IO.
  _putMany(root,tree,updates,slotId,depth=0) {
    if(!updates.length)return root;
    if(depth>64)fail('WRITER_INDEX_DEPTH');
    const p=root?this._node(root,tree,depth):null;
    if(!p||p.type==='leaf') {
      const entries=new Map((p?p.entries:[]).map(e=>[e.key,clone(e)]));
      for(const {key,value} of updates)entries.set(key,{key,value});
      return this._writeEntries([...entries.values()].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0),tree,slotId,depth);
    }
    const children=new Map(p.children.map(c=>[c.digit,clone(c)])),groups=new Map();
    for(const update of updates){const digit=writerDigest(update.key)[depth];if(!groups.has(digit))groups.set(digit,[]);groups.get(digit).push(update);}
    for(const [digit,group] of groups)children.set(digit,{digit,ref:this._putMany(children.get(digit)?.ref||null,tree,group,slotId,depth+1)});
    return this._createExact(this._id(),'index-node',{tree,depth,type:'branch',children:[...children.values()].sort((a,b)=>a.digit<b.digit?-1:1),slotId});
  }
  _writeEntries(entries,tree,slotId,depth) {
    const payload={tree,depth,type:'leaf',entries,slotId};
    let fit=entries.length<=this.limits.maxLeafEntries;
    if(fit){try{this._bytes(this._sealed('index-node',payload));}catch(e){if(e.code!=='WRITER_FILE_TOO_LARGE')throw e;fit=false;}}
    if(fit)return this._createExact(this._id(),'index-node',payload);
    if(depth>=64)fail('WRITER_INDEX_COLLISION_LIMIT');
    const groups={};for(const entry of entries){const d=writerDigest(entry.key)[depth];if(!groups[d])groups[d]=[];groups[d].push(entry);}
    const children=Object.keys(groups).sort().map(digit=>({digit,ref:this._writeEntries(groups[digit],tree,slotId,depth+1)}));
    return this._createExact(this._id(),'index-node',{tree,depth,type:'branch',children,slotId});
  }
  // Verify copy-on-write transition without walking untouched subtrees. This
  // prevents a well-formed competing frame from dropping unrelated entities or
  // older receipts while still passing checks for its own changed keys.
  _verifyTree(oldRef,newRef,tree,updates,slotId,depth=0) {
    if(!updates.length){if(!equal(oldRef,newRef))fail('WRITER_INDEX_TRANSITION_INVALID');return;}
    if(!newRef)fail('WRITER_INDEX_TRANSITION_INVALID');
    const old=oldRef?this._node(oldRef,tree,depth):null,next=this._node(newRef,tree,depth);
    if(next.slotId!==slotId)fail('WRITER_INDEX_SLOT_INVALID');
    if(!old||old.type==='leaf') {
      const entries=old?old.entries.map(clone):[];
      for(const update of updates){const at=entries.findIndex(e=>e.key===update.key);if(at<0)entries.push(update);else entries[at]=update;}
      entries.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
      this._verifyEntries(newRef,tree,entries,slotId,depth);return;
    }
    if(next.type!=='branch')fail('WRITER_INDEX_TRANSITION_INVALID');
    const digits=new Set([...old.children.map(c=>c.digit),...next.children.map(c=>c.digit),...updates.map(e=>writerDigest(e.key)[depth])]);
    for(const digit of digits){const before=old.children.find(c=>c.digit===digit),after=next.children.find(c=>c.digit===digit);this._verifyTree(before?before.ref:null,after?after.ref:null,tree,updates.filter(e=>writerDigest(e.key)[depth]===digit),slotId,depth+1);}
  }
  _verifyEntries(ref,tree,entries,slotId,depth) {
    const p=this._node(ref,tree,depth);if(p.slotId!==slotId)fail('WRITER_INDEX_SLOT_INVALID');
    if(p.type==='leaf'){if(!equal(p.entries,entries))fail('WRITER_INDEX_TRANSITION_INVALID');return;}
    const groups={};for(const entry of entries){const digit=writerDigest(entry.key)[depth];if(!groups[digit])groups[digit]=[];groups[digit].push(entry);}
    if(!equal(Object.keys(groups).sort(),p.children.map(c=>c.digit)))fail('WRITER_INDEX_TRANSITION_INVALID');
    for(const child of p.children)this._verifyEntries(child.ref,tree,groups[child.digit],slotId,depth+1);
  }
  _validateEntity(entity,key) {
    if(!entity||Object.keys(entity).sort().join(',')!=='deleted,key,value,version'||entity.key!==key||!integer(entity.version)||entity.version<1||typeof entity.deleted!=='boolean'||(entity.deleted&&entity.value!==null))fail('WRITER_ENTITY_INVALID');
    return entity;
  }
  _get(root,key) {const entity=this._lookup(root,'entities',key);return entity===null?null:this._validateEntity(entity,key);}
  _assertReady(){this._guard();if(!this._state||this._recovering)fail('WRITER_RECOVERY_REQUIRED');}
  getEntity(key) {this._assertReady();this._key(key);return this._get(this._state.stateRoot,key);}
  get(key) {return this.getEntity(key);}
  _key(key) {if(typeof key!=='string'||key.length<1||encodeUtf8(key).length>512)fail('WRITER_KEY_INVALID');}
  _receipt(op,epoch) {
    const s=this._state,key=receiptKey(epoch,op);
    if(s.headReceipt && s.headReceipt.operationId===op&&s.headReceipt.epoch===epoch)return clone(s.headReceipt);
    return this._lookup(s.receiptRoot,'receipts',key);
  }
  getReceipt(operationId,epoch='default') {this._assertReady();if(!validId(operationId)||!validId(epoch))fail('WRITER_OPERATION_INVALID');return this._receipt(operationId,epoch);}
  _receiptFor(f) {
    const p=f.payload;
    return {operationId:p.operation.operationId,epoch:p.operation.epoch,digest:p.operation.digest,revision:p.revision,frameId:f.id,frameHash:f.hash,committedAt:p.committedAt,result:clone(p.result),entityVersions:p.changes.map(c=>({key:c.key,version:c.entity.version,deleted:c.entity.deleted}))};
  }
  _refs(refs,phase,frame) {
    if(!Array.isArray(refs)||refs.length>this.limits.maxReferences)fail('WRITER_REFERENCES_INVALID');
    if(refs.length && (typeof this.verifyReferences!=='function'||this.verifyReferences(clone(refs),{phase,slotId:frame.id,revision:frame.revision,changes:clone(frame.changes),getEntity:key=>this._get(this._state.stateRoot,key)})!==true))fail('WRITER_REFERENCES_UNVERIFIED');
  }
  _frame(f,phase) {
    const p=f.payload,s=this._state;
    if(!p||Object.keys(p).sort().join(',')!=='acceptedEpochs,changes,checkpoint,committedAt,datasetGeneration,nextSlotId,operation,parent,receiptRoot,references,result,revision,stateRoot'||p.datasetGeneration!==s.datasetGeneration||p.revision!==s.revision+1||!equal(p.parent,{id:s.headId,hash:s.headHash})||f.id!==s.nextSlotId||!validId(p.nextSlotId)||p.nextSlotId===f.id||p.nextSlotId===s.headId||!refOk(p.stateRoot)||!refOk(p.receiptRoot)||typeof p.committedAt!=='string'||!Number.isFinite(Date.parse(p.committedAt)))fail('WRITER_FRAME_INVALID');
    const op=p.operation;
    if(!op||Object.keys(op).sort().join(',')!=='digest,epoch,operationId'||!validId(op.operationId)||!validId(op.epoch)||!digestOk(op.digest)||!s.acceptedEpochs.includes(op.epoch)||this._receipt(op.operationId,op.epoch)!==null)fail('WRITER_FRAME_OPERATION_INVALID');
    this._epochs(p.acceptedEpochs);
    if(!Array.isArray(p.changes)||p.changes.length>this.limits.maxChanges)fail('WRITER_FRAME_CHANGES_INVALID');
    const keys=new Set();
    for(const c of p.changes){if(!c||Object.keys(c).sort().join(',')!=='entity,expectedVersion,key'||keys.has(c.key)||!integer(c.expectedVersion))fail('WRITER_FRAME_CHANGES_INVALID');this._key(c.key);keys.add(c.key);const prev=this._get(s.stateRoot,c.key),entity=this._validateEntity(c.entity,c.key);if((prev?prev.version:0)!==c.expectedVersion||entity.version!==c.expectedVersion+1||!equal(this._get(p.stateRoot,c.key),entity))fail('WRITER_FRAME_ENTITY_MISMATCH');}
    this._verifyTree(s.stateRoot,p.stateRoot,'entities',p.changes.map(c=>({key:c.key,value:c.entity})),f.id);
    // The prior head receipt is carried forward with its full verified hash.
    // The current receipt lives in THIS frame until the following commit.
    const receiptUpdates=s.headReceipt?[{key:receiptKey(s.headReceipt.epoch,s.headReceipt.operationId),value:s.headReceipt},{key:'@revision:'+s.revision,value:{revision:s.revision,hash:s.headHash}}]:[];
    this._verifyTree(s.receiptRoot,p.receiptRoot,'receipts',receiptUpdates,f.id);
    this._refs(p.references,phase,{id:f.id,revision:p.revision,changes:p.changes});
    if(p.checkpoint)this._publication(f);
    s.revision=p.revision;s.headId=f.id;s.headHash=f.hash;s.nextSlotId=p.nextSlotId;s.stateRoot=p.stateRoot;s.receiptRoot=p.receiptRoot;s.headReceipt=this._receiptFor(f);s.acceptedEpochs=p.acceptedEpochs.slice();s.replayFrames=p.checkpoint?1:s.replayFrames+1;
  }
  _checkCut(cut) {
    if(!cut||Object.keys(cut).sort().join(',')!=='hash,id,nextSlotId,revision'||!integer(cut.revision)||!validId(cut.id)||!digestOk(cut.hash)||!validId(cut.nextSlotId))fail('WRITER_CHECKPOINT_INVALID');
  }
  _indexPayload(p,id,previous,previousCut=-1) {
    if(!p||Object.keys(p).sort().join(',')!=='cut,manifestRef,nextIndexId,previousIndex,publishingFrame'||!refOk(p.manifestRef)||!p.manifestRef||!validId(p.nextIndexId)||p.nextIndexId===id||!refOk(p.previousIndex)||!equal(p.previousIndex,previous)||(p.previousIndex&&p.previousIndex.id===id)||!p.publishingFrame||Object.keys(p.publishingFrame).sort().join(',')!=='hash,id,revision'||!validId(p.publishingFrame.id)||!digestOk(p.publishingFrame.hash))fail('WRITER_CHECKPOINT_INDEX_INVALID');
    this._checkCut(p.cut);if(p.cut.revision<=previousCut||p.publishingFrame.revision!==p.cut.revision+1||p.publishingFrame.id!==p.cut.nextSlotId)fail('WRITER_CHECKPOINT_INDEX_INVALID');
  }
  _manifest(ref,cut) {
    const f=this._read(ref.id,'checkpoint-manifest',ref),p=f.payload;
    if(!p||Object.keys(p).sort().join(',')!=='acceptedEpochs,cut,datasetGeneration,receiptRoot,stateRoot'||p.datasetGeneration!==this._state.datasetGeneration||!equal(p.cut,cut)||!refOk(p.stateRoot)||!refOk(p.receiptRoot))fail('WRITER_CHECKPOINT_INVALID');
    this._epochs(p.acceptedEpochs);return p;
  }
  _publication(f) {
    const c=f.payload.checkpoint,s=this._state;
    if(!c||Object.keys(c).sort().join(',')!=='cut,indexId,manifestRef,nextIndexId,previousIndex'||!validId(c.indexId)||!validId(c.nextIndexId)||!refOk(c.manifestRef)||!c.manifestRef||!refOk(c.previousIndex))fail('WRITER_CHECKPOINT_INVALID');
    this._checkCut(c.cut);
    if(!equal(c.cut,{id:s.headId,hash:s.headHash,revision:s.revision,nextSlotId:s.nextSlotId}))fail('WRITER_CHECKPOINT_CUT_MISMATCH');
    const m=this._manifest(c.manifestRef,c.cut);
    if(!equal(m.stateRoot,s.stateRoot)||!equal(m.receiptRoot,f.payload.receiptRoot)||!equal(m.acceptedEpochs,s.acceptedEpochs))fail('WRITER_CHECKPOINT_STATE_MISMATCH');
    const link={previousIndex:c.previousIndex,nextIndexId:c.nextIndexId,manifestRef:c.manifestRef,cut:c.cut,publishingFrame:{id:f.id,hash:f.hash,revision:f.payload.revision}};
    this._indexPayload(link,c.indexId,c.previousIndex);
    if(s.indexHead?.id!==c.indexId)this._indexAdmission(s.indexLinks);
    const expected=this._sealed('checkpoint-index',link);
    // This is mandatory before applying any successor mutation or permitting GC.
    const existing=this._read(c.indexId,'checkpoint-index',null,true);
    if(existing&&existing.hash!==expected.hash)fail('WRITER_CHECKPOINT_BARRIER_INVALID');
    const ref=existing?pointer(existing):this._createExact(c.indexId,'checkpoint-index',link);
    if(ref.hash!==expected.hash)fail('WRITER_CHECKPOINT_BARRIER_INVALID');
    if(s.indexHead && s.indexHead.id===c.indexId){if(s.indexHead.hash!==ref.hash)fail('WRITER_CHECKPOINT_BARRIER_INVALID');}
    else {
      if(c.indexId!==s.nextIndexId||!equal(c.previousIndex,s.indexHead))fail('WRITER_CHECKPOINT_ORDER_INVALID');
      s.indexHead=ref;s.nextIndexId=c.nextIndexId;s.indexLinks++;
    }
    s.checkpoint={manifestRef:c.manifestRef,cut:c.cut,indexRef:ref};
    this._writeCheckpointHint(ref);
  }
  _indexAdmission(indexLinks) {
    if(!integer(indexLinks+1))fail('WRITER_INDEX_ORDINAL_OVERFLOW');
    if(!this.checkpointHintCodec&&indexLinks>=this.limits.maxIndexLinks)this._recoverySetupRequired();
  }
  _recoverySetupRequired() {
    const error=new Error('WRITER_RECOVERY_SETUP_REQUIRED');error.code=error.message;
    error.requiresOwnerAction=true;
    error.setup='Configure the owner HMAC signing key and a supported fixed-ID recovery hint. Keep the existing anchor, immutable INDEX chain, records and receipts; never reset the store or raise the history bound.';
    throw error;
  }
  recoveryBarrier(options={}) {
    if(this._recovering)fail('WRITER_RECOVERY_REENTRANT');
    this._recovering=true;
    try{return this._recover(options);}catch(error){this._state=null;this._cache.clear();this._verifiedPhase=null;throw error;}
    finally{this._recovering=false;}
  }
  _hintPayload(ref,indexLinks=this._state.indexLinks,protocol=CHECKPOINT_HINT_PROTOCOL){const s=this._state;return {protocol,anchorId:this.anchorId,anchorHash:s.anchorHash,hintFileId:this.checkpointHintId,storeId:this.storeId,writerScriptId:this.writerScriptId,schemaVersion:this.schemaVersion,datasetGeneration:s.datasetGeneration,indexRef:ref,indexLinks};}
  _writeCheckpointHint(ref){
    if(!this.checkpointHintCodec||equal(this._hintRef,ref))return;
    try{this.io.writeCheckpointHint(this.checkpointHintCodec.encode(this._hintPayload(ref)));this._hintRef=clone(ref);}catch(_){/* Advisory only: the immutable commit and mandatory index already won. */}
  }
  _writeIndexScanHint(link,indexLinks){
    if(!this.checkpointHintCodec||!link)return false;
    try{this.io.writeCheckpointHint(this.checkpointHintCodec.encode(this._hintPayload(pointer(link),indexLinks,INDEX_SCAN_HINT_PROTOCOL)));this._hintRef=null;return true;}
    catch(_){/* Lost writes or delayed regressions can cost work, never records. */return false;}
  }
  _recoveryPending(link,indexLinks,scannedLinks){
    if(!this.checkpointHintCodec)this._recoverySetupRequired();
    const cursorPersisted=this._writeIndexScanHint(link,indexLinks);
    const error=new Error('WRITER_RECOVERY_PENDING');error.code=error.message;error.retryable=true;
    Object.assign(error,{indexLinks,scannedLinks,cursorPersisted});throw error;
  }
  _authenticatedHint(){
    if(!this.checkpointHintCodec)return null;
    let payload;
    try{const bytes=this.io.readCheckpointHint();if(bytes===null)return null;payload=this.checkpointHintCodec.decode(bytes);}catch(error){if(error?.message==='STORE_YIELD'||error?.message==='STORE_LOCK_REQUIRED')throw error;return null;}
    const s=this._state;
    if(!payload||Object.keys(payload).sort().join(',')!=='anchorHash,anchorId,datasetGeneration,hintFileId,indexLinks,indexRef,protocol,schemaVersion,storeId,writerScriptId'||![CHECKPOINT_HINT_PROTOCOL,INDEX_SCAN_HINT_PROTOCOL].includes(payload.protocol)||payload.anchorId!==this.anchorId||payload.anchorHash!==s.anchorHash||payload.hintFileId!==this.checkpointHintId||payload.storeId!==this.storeId||payload.writerScriptId!==this.writerScriptId||payload.schemaVersion!==this.schemaVersion||payload.datasetGeneration!==s.datasetGeneration||!refOk(payload.indexRef)||!payload.indexRef||!integer(payload.indexLinks)||payload.indexLinks<1)return null;
    return payload;
  }
  _restoreIndex(link,next,indexLinks){
    const p=link.payload,m=this._manifest(p.manifestRef,p.cut);
    Object.assign(this._state,{revision:p.cut.revision,headId:p.cut.id,headHash:p.cut.hash,nextSlotId:p.cut.nextSlotId,stateRoot:m.stateRoot,receiptRoot:m.receiptRoot,headReceipt:null,acceptedEpochs:m.acceptedEpochs.slice(),indexHead:pointer(link),nextIndexId:next,checkpoint:{manifestRef:p.manifestRef,cut:p.cut,indexRef:pointer(link)},replayFrames:0,indexLinks});
  }
  _recover({minimumAcknowledged}={}) {
    this._guard();const phase=typeof this.io.getVerifiedReadPhase==='function'?this.io.getVerifiedReadPhase():null;
    // Reuse only this continuously-held phase's already verified prefix. The
    // successor remains an uncached read, so delayed immutable creates are seen.
    if(phase&&this._state&&this._verifiedPhase===phase){
      const link=this._read(this._state.nextIndexId,'checkpoint-index',null,true);
      if(!link)return this._recoverTail(minimumAcknowledged);
    }
    this._verifiedPhase=null;this._state=null;this._cache.clear();this._hintRef=null;
    const anchor=this._read(this.anchorId,'bootstrap');this._checkAnchor(anchor);const a=anchor.payload;
    this._state={anchorHash:anchor.hash,datasetGeneration:a.datasetGeneration,revision:0,headId:anchor.id,headHash:anchor.hash,nextSlotId:a.firstSlotId,stateRoot:null,receiptRoot:null,headReceipt:null,acceptedEpochs:a.acceptedEpochs.slice(),indexHead:null,nextIndexId:a.firstIndexId,checkpoint:null,replayFrames:0,indexLinks:0};
    let next=a.firstIndexId,previous=null,last=null,previousCut=-1,count=0,scanned=0;const seen=new Set();
    const hint=this._authenticatedHint();
    if(hint){
      // Both hint protocols attest ONLY a verified immutable INDEX prefix. Do
      // not open its historical manifest/publication: those may be retired.
      // An authenticated referenced INDEX itself may never silently disappear.
      const link=this._read(hint.indexRef.id,'checkpoint-index',hint.indexRef),p=link.payload;
      this._indexPayload(p,link.id,p?.previousIndex);
      if((hint.indexLinks===1)!==(p.previousIndex===null)||(hint.indexLinks===1&&link.id!==a.firstIndexId)||hint.indexLinks>p.cut.revision+1)fail('WRITER_CHECKPOINT_INDEX_INVALID');
      if(hint.protocol===CHECKPOINT_HINT_PROTOCOL)this._hintRef=pointer(link);
      last=link;next=p.nextIndexId;previous=pointer(link);previousCut=p.cut.revision;count=hint.indexLinks;seen.add(link.id);
    }
    const scanLimit=this.checkpointHintCodec?Math.min(this.limits.maxIndexLinks,this.limits.maxIndexScanLinks):this.limits.maxIndexLinks;
    while(true){
      if(seen.has(next))fail('WRITER_INDEX_CYCLE');
      // scanLimit bounds new link discovery, with one final absent/present
      // boundary probe. The authenticated seed is one additional bounded read.
      // Publication verification rechecks the selected current INDEX separately.
      let link;
      try{link=this._read(next,'checkpoint-index',null,true);}
      catch(error){if(last&&scanned)this._writeIndexScanHint(last,count);throw error;}
      if(!link)break;
      if(scanned>=scanLimit)this._recoveryPending(last,count,scanned);
      seen.add(next);this._indexPayload(link.payload,next,previous,previousCut);
      if(!integer(count+1))fail('WRITER_INDEX_ORDINAL_OVERFLOW');
      count++;scanned++;last=link;previous=pointer(link);previousCut=link.payload.cut.revision;next=link.payload.nextIndexId;
      // Save the first link before a short/slow service budget can repeatedly
      // starve a whole 16-link interval; then checkpoint progress periodically.
      // The fixed file and constant-sized payload keep recovery memory bounded.
      if(scanned===1||scanned%16===0)this._writeIndexScanHint(last,count);
    }
    this._state.indexLinks=count;
    if(last)this._restoreIndex(last,next,count);
    const result=this._recoverTail(minimumAcknowledged,last?last.payload.publishingFrame.revision:null);
    this._verifiedPhase=phase;return result;
  }

  _recoverTail(minimumAcknowledged,requiredPublicationRevision=null,replayed=0) {
    const s=this._state;let minSeen=minimumAcknowledged?this._minimumAtState(minimumAcknowledged):true;
    const frameSeen=new Set();
    while(true){if(frameSeen.has(s.nextSlotId))fail('WRITER_FRAME_CYCLE');frameSeen.add(s.nextSlotId);const f=this._read(s.nextSlotId,'frame',null,true);if(!f)break;if(replayed++>=this.limits.maxReplayFrames||s.replayFrames>=this.limits.maxReplayFrames)fail('WRITER_REPLAY_BUDGET');this._frame(f,'recovery');if(minimumAcknowledged&&this._minimumAtState(minimumAcknowledged))minSeen=true;}
    if(requiredPublicationRevision!==null&&s.revision<requiredPublicationRevision)fail('WRITER_MISSING_PUBLICATION_FRAME');
    if(minimumAcknowledged&&!minSeen){const r=minimumAcknowledged;const known=this._lookup(s.receiptRoot,'receipts','@revision:'+r.revision);if(!known||known.revision!==r.revision||known.hash!==r.hash)fail('WRITER_ACKNOWLEDGEMENT_UNPROVEN');}
    return this._statusSnapshot();
  }
  _minimumAtState(min) {
    if(!min||!integer(min.revision)||!digestOk(min.hash))fail('WRITER_ACKNOWLEDGEMENT_INVALID');
    if(min.revision===this._state.revision){if(min.hash!==this._state.headHash)fail('WRITER_ACKNOWLEDGEMENT_MISMATCH');return true;}return false;
  }
  status() {this._assertReady();return this._statusSnapshot();}
  _statusSnapshot() {const s=this._state;return clone({storeId:this.storeId,datasetGeneration:s.datasetGeneration,revision:s.revision,headId:s.headId,headHash:s.headHash,nextSlotId:s.nextSlotId,checkpoint:s.checkpoint,stateRoot:s.stateRoot,receiptRoot:s.receiptRoot,headReceipt:s.headReceipt,acceptedEpochs:s.acceptedEpochs,indexHead:s.indexHead,nextIndexId:s.nextIndexId,indexLinks:s.indexLinks,replayFrames:s.replayFrames});}
  _command(command) {
    if(!command||!validId(command.operationId)||!validId(command.epoch||'default')||!digestOk(command.digest)||!Array.isArray(command.changes)||command.changes.length>this.limits.maxChanges)fail('WRITER_COMMAND_INVALID');
    const c=clone({...command,epoch:command.epoch||'default',result:command.result===undefined?null:command.result,references:command.references||[]});
    if(c.datasetGeneration!==undefined&&c.datasetGeneration!==this._state.datasetGeneration)fail('WRITER_GENERATION_MISMATCH');
    if(!Array.isArray(c.references)||c.references.length>this.limits.maxReferences)fail('WRITER_REFERENCES_INVALID');return c;
  }
  _checkReplay(c) {const prior=this._receipt(c.operationId,c.epoch);if(prior){if(prior.digest!==c.digest)fail('OP_ID_REUSED');return prior;}return null;}
  _changes(c) {
    const changes=[],keys=new Set();
    for(const change of c.changes){this._key(change.key);if(keys.has(change.key)||!integer(change.expectedVersion)||change.expectedVersion>=Number.MAX_SAFE_INTEGER||Object.keys(change).some(k=>!['key','expectedVersion','value','deleted','recreate'].includes(k)))fail('WRITER_CHANGE_INVALID');keys.add(change.key);
      const old=this._get(this._state.stateRoot,change.key);
      if((old?old.version:0)!==change.expectedVersion)fail('ENTITY_VERSION_CONFLICT');
      if(change.deleted!==undefined&&typeof change.deleted!=='boolean')fail('WRITER_CHANGE_INVALID');
      if(change.deleted&&(!old||old.deleted))fail('ENTITY_MISSING');
      if(!change.deleted&&old?.deleted&&change.recreate!==true)fail('ENTITY_TOMBSTONED');
      if(change.recreate!==undefined&&change.recreate!==true)fail('WRITER_CHANGE_INVALID');
      if(!change.deleted&&!own(change,'value'))fail('WRITER_CHANGE_INVALID');
      const value=change.deleted?null:clone(change.value);if(encodeUtf8(canonical(value)).length>this.limits.maxValueBytes)fail('WRITER_VALUE_TOO_LARGE');
      changes.push({key:change.key,expectedVersion:change.expectedVersion,entity:{key:change.key,version:change.expectedVersion+1,deleted:!!change.deleted,value}});
    }return changes;
  }
  _carryReceipts(slotId) {const s=this._state;if(!s.headReceipt)return s.receiptRoot;return this._putMany(s.receiptRoot,'receipts',[{key:receiptKey(s.headReceipt.epoch,s.headReceipt.operationId),value:s.headReceipt},{key:'@revision:'+s.revision,value:{revision:s.revision,hash:s.headHash}}],slotId);}
  _append(c,checkpoint=false,nextEpochs=null) {
    const s=this._state;if(!s.acceptedEpochs.includes(c.epoch))fail('OP_EXPIRED');
    if(checkpoint)this._indexAdmission(s.indexLinks);
    if(typeof this.validateMutation==='function'&&this.validateMutation(clone(c),{getEntity:key=>this._get(s.stateRoot,key),revision:s.revision,slotId:s.nextSlotId})!==true)fail('WRITER_DOMAIN_INVALID');
    const committedAt=this.clock();if(typeof committedAt!=='string'||!Number.isFinite(Date.parse(committedAt)))fail('WRITER_CLOCK_INVALID');
    const changes=this._changes(c),slotId=s.nextSlotId;
    // Reserve enough envelope space before creating any staged index nodes.
    if(encodeUtf8(canonical({changes,result:c.result,references:c.references})).length>this.limits.maxFileBytes-4096)fail('WRITER_FILE_TOO_LARGE');
    this._refs(c.references,'proposal',{id:slotId,revision:s.revision+1,changes});
    const stateRoot=this._putMany(s.stateRoot,'entities',changes.map(change=>({key:change.key,value:change.entity})),slotId);
    const receiptRoot=this._carryReceipts(slotId);
    let publication=null;
    if(checkpoint){if(changes.length)fail('WRITER_CHECKPOINT_CHANGES');const cut={id:s.headId,hash:s.headHash,revision:s.revision,nextSlotId:slotId};const manifestRef=this._createExact(this._id(),'checkpoint-manifest',{datasetGeneration:s.datasetGeneration,cut,stateRoot,receiptRoot,acceptedEpochs:s.acceptedEpochs});publication={indexId:s.nextIndexId,nextIndexId:this._id(),previousIndex:s.indexHead,manifestRef,cut};}
    const payload={datasetGeneration:s.datasetGeneration,revision:s.revision+1,parent:{id:s.headId,hash:s.headHash},nextSlotId:this._id(),operation:{operationId:c.operationId,epoch:c.epoch,digest:c.digest},committedAt,changes,stateRoot,receiptRoot,result:c.result,references:c.references,checkpoint:publication,acceptedEpochs:nextEpochs?this._epochs(nextEpochs):s.acceptedEpochs.slice()};
    const proposal=this._sealed('frame',payload),bytes=this._bytes(proposal);
    let winner=null;
    try {
    for(let attempt=0;attempt<this.limits.maxCreateAttempts;attempt++){try{this.io.createFile(slotId,bytes,'frame');}catch(_){}winner=this._read(slotId,'frame',null,true);if(winner)break;}
    if(!winner)fail('WRITER_COMMIT_UNRESOLVED',true);
    // A valid older, delayed proposal may win. Adopt its ORIGINAL receipt and
    // reserved successor, even when timestamps or generated IDs differ.
    this._frame(winner,'readback');
    const receipt=this._receipt(c.operationId,c.epoch);
    if(receipt){if(receipt.digest!==c.digest)fail('OP_ID_REUSED');return receipt;}
    return null;
    }catch(error){this._state=null;this._cache.clear();this._verifiedPhase=null;throw error;}
  }
  transact(command) {
    this.recoveryBarrier(command?.minimumAcknowledged?{minimumAcknowledged:command.minimumAcknowledged}:{});
    const c=this._command(command);
    for(let attempt=0;attempt<this.limits.maxContention;attempt++) {
      const prior=this._checkReplay(c);if(prior)return prior;
      if(!this._state.acceptedEpochs.includes(c.epoch))fail('OP_EXPIRED');
      if(this._state.replayFrames>=this.limits.checkpointEvery)this._automaticCheckpoint();
      const result=this._append(c);if(result)return result;
      // Winning competing operation has changed versions; reevaluate from the
      // immutable durable chain, never move our frozen proposal blindly forward.
      this.recoveryBarrier();
    }fail('WRITER_CONTENTION',true);
  }
  commit(command) {return this.transact(command);}
  _automaticCheckpoint() {
    const s=this._state,c={operationId:'checkpoint_'+s.revision+'_'+s.headHash.slice(0,16),epoch:s.acceptedEpochs[0],digest:writerDigest({kind:'checkpoint',headId:s.headId,headHash:s.headHash}),changes:[],references:[],result:{checkpoint:true}};
    if(!this._append(c,true))this.recoveryBarrier();
  }
  checkpoint(command) {
    this.recoveryBarrier();const c=this._command({...command,changes:[],references:[]});
    for(let i=0;i<this.limits.maxContention;i++){const prior=this._checkReplay(c);if(prior)return prior;const receipt=this._append(c,true);if(receipt)return receipt;this.recoveryBarrier();}fail('WRITER_CONTENTION',true);
  }
  /** Ordered epoch fence. No receipt deletion is implemented. A late old create
   * may win the current slot first; it is recovered before this fence retries.
   * Fences consume replay frames too, so they use the same checkpoint admission
   * as ordinary transactions rather than extending an unrecoverable tail. */
  advanceEpochs(command,acceptedEpochs) {
    this._epochs(acceptedEpochs);this.recoveryBarrier();const c=this._command({...command,changes:[],references:[]});
    for(let i=0;i<this.limits.maxContention;i++){
      const prior=this._checkReplay(c);if(prior)return prior;
      if(!this._state.acceptedEpochs.includes(c.epoch))fail('OP_EXPIRED');
      if(this._state.replayFrames>=this.limits.checkpointEvery)this._automaticCheckpoint();
      const receipt=this._append(c,false,acceptedEpochs);if(receipt)return receipt;this.recoveryBarrier();
    }fail('WRITER_CONTENTION',true);
  }
}
