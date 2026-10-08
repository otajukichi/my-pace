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
import {CHECKPOINT_HINT_PROTOCOL,INDEX_SCAN_HINT_PROTOCOL,FRAME_SCAN_HINT_PROTOCOL,ATTESTED_FRAME_HINT_PROTOCOL} from './checkpoint-hint.mjs';
import {IncrementalSha256, encodeUtf8, decodeUtf8} from './codec.mjs';
import {PreparedWriter} from './prepared-writer.mjs';

export const WRITER_PROTOCOL = 'mypace-reserved-v1';
export const WRITER_ROLES = Object.freeze(['bootstrap','frame','index-node','checkpoint-manifest','checkpoint-index','preparation','preparation-work','transition-certificate']);
const DEFAULT_LIMITS = Object.freeze({maxFileBytes:256*1024,maxValueBytes:128*1024,maxChanges:128,maxReferences:128,maxLeafEntries:512,maxCachedNodes:64,maxReplayFrames:256,maxIndexLinks:4096,maxIndexScanLinks:64,checkpointEvery:16,maxContention:4,maxCreateAttempts:2});
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const validId=s=>typeof s==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const digestOk=s=>typeof s==='string' && /^[0-9a-f]{64}$/.test(s);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const FRAME_KEYS='acceptedEpochs,changes,checkpoint,committedAt,datasetGeneration,nextSlotId,operation,parent,receiptRoot,references,result,revision,stateRoot';
const frameShape=p=>{if(!p)return false;const keys=Object.keys(p).sort().join(',');return [FRAME_KEYS,FRAME_KEYS+',writerFence', (FRAME_KEYS+',nextPreparationId,writerFence').split(',').sort().join(','),(FRAME_KEYS+',nextPreparationId,preparation,certificate,writerFence').split(',').sort().join(',')].includes(keys)&&(!own(p,'writerFence')||p.writerFence===2)&&(!own(p,'nextPreparationId')||validId(p.nextPreparationId))&&(!own(p,'certificate')||(refOk(p.certificate)&&p.certificate&&refOk(p.preparation)&&p.preparation));};
const fenceOf=p=>own(p,'writerFence')?p.writerFence:0;
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
  constructor({io,anchorId,bootstrapId,storeId,writerScriptId,scriptId,schemaVersion=3,limits={},clock=()=>new Date().toISOString(),validateMutation,verifyReferences,checkpointHintId,checkpointHintAnchorHash,checkpointHintCodec,progressiveRecovery=false,canContinueRecovery=()=>true,preparationCodec,preparedAppAdapter,canContinuePreparation=()=>true}) {
    anchorId=anchorId||bootstrapId;writerScriptId=writerScriptId||scriptId;
    if(!io || ['getScriptId','assertLockHeld','allocateIds','readFile','createFile'].some(k=>typeof io[k]!=='function') || !validId(anchorId) || !validId(storeId) || !validId(writerScriptId) || !integer(schemaVersion) || schemaVersion<1 || typeof clock!=='function')fail('WRITER_CONFIG_INVALID');
    if(checkpointHintId!==undefined&&(!validId(checkpointHintId)||[anchorId,storeId,writerScriptId].includes(checkpointHintId)))fail('WRITER_HINT_CONFIG');
    if(checkpointHintAnchorHash!==undefined&&(!checkpointHintId||!digestOk(checkpointHintAnchorHash)))fail('WRITER_HINT_CONFIG');
    if(checkpointHintCodec!==undefined&&(!checkpointHintId||typeof checkpointHintCodec?.encode!=='function'||typeof checkpointHintCodec?.decode!=='function'||typeof io.readCheckpointHint!=='function'||typeof io.writeCheckpointHint!=='function'))fail('WRITER_HINT_CONFIG');
    if(typeof progressiveRecovery!=='boolean'||typeof canContinueRecovery!=='function')fail('WRITER_CONFIG_INVALID');
    this.progressiveRecovery=progressiveRecovery&&!!checkpointHintCodec;this.canContinueRecovery=canContinueRecovery;this._frameHintRef=null;this._checkpointProgress=null;this._indexProgress=null;
    this.checkpointHintId=checkpointHintId;this.checkpointHintAnchorHash=checkpointHintAnchorHash;this.checkpointHintCodec=checkpointHintCodec;this._hintRef=null;
    this.io=io;this.anchorId=anchorId;this.storeId=storeId;this.writerScriptId=writerScriptId;this.schemaVersion=schemaVersion;this.clock=clock;this.validateMutation=validateMutation;this.verifyReferences=verifyReferences;
    this.limits={...DEFAULT_LIMITS,...limits};
    if(Object.keys(limits).some(k=>!own(DEFAULT_LIMITS,k)) || Object.values(this.limits).some(v=>!Number.isSafeInteger(v)||v<1) || this.limits.maxValueBytes>this.limits.maxFileBytes || this.limits.checkpointEvery+2>=this.limits.maxReplayFrames)fail('WRITER_LIMITS_INVALID');
    this.preparationCodec=preparationCodec;this.preparedAppAdapter=preparedAppAdapter;if(!preparationCodec||!preparedAppAdapter)this.prepareAppCommand=undefined;this.canContinuePreparation=canContinuePreparation;this._prepared=new PreparedWriter(this,{digest:writerDigest,canonical,clone,equal,refOk,validId,fail});
    this._state=null;this._cache=new Map();this._nodeCachePhase=null;this._nodeCachePhaseRequired=typeof io.getVerifiedReadPhase==='function';this._ids=[];this._verifiedPhase=null;this._recovering=false;this._frozenReadPhase=null;this._frozenAnchor=null;
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
    const key=ref.id+':'+ref.hash;let cacheable=true;
    // IO implementations with phase evidence authorize node-cache reuse only
    // under that exact positive token. Bytes-only/no-cache modes provide none.
    if(this._nodeCachePhaseRequired){const phase=this.io.getVerifiedReadPhase();if(!phase||phase!==this._nodeCachePhase){this._cache.clear();cacheable=false;}}
    let f=cacheable?this._cache.get(key):null;if(!f){f=this._read(ref.id,'index-node',ref);if(cacheable){this._cache.set(key,f);if(this._cache.size>this.limits.maxCachedNodes)this._cache.delete(this._cache.keys().next().value);}}
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
  // Server-internal frozen-view readers. The public API may call these only
  // with a verified, domain-bound signed cut, never caller-selected raw roots.
  captureReadView() {this._assertReady();const s=this._state;return clone({storeId:this.storeId,writerScriptId:this.writerScriptId,schemaVersion:this.schemaVersion,anchorId:this.anchorId,anchorHash:s.anchorHash,writerFence:s.writerFence||0,datasetGeneration:s.datasetGeneration,revision:s.revision,stateRoot:s.stateRoot,receiptRoot:s.receiptRoot,acceptedEpochs:s.acceptedEpochs,headId:s.headId,headHash:s.headHash});}
  _guardFrozenRead() {
    this._guard();const phase=typeof this.io.getVerifiedReadPhase==='function'?this.io.getVerifiedReadPhase():null;
    this._nodeCachePhaseRequired=this._nodeCachePhaseRequired||!!phase;if(this._nodeCachePhase!==phase){this._cache.clear();this._nodeCachePhase=phase;}
    if(!phase||phase!==this._frozenReadPhase){if(!phase||phase!==this._verifiedPhase)this._cache.clear();this._frozenReadPhase=phase;this._frozenAnchor=null;}
    if(!this._frozenAnchor){const a=this._read(this.anchorId,'bootstrap');this._checkAnchor(a);this._frozenAnchor=a;}
    return this._frozenAnchor;
  }
  validateReadView(view) {
    const anchor=this._guardFrozenRead();
    if(!view||view.storeId!==this.storeId||view.writerScriptId!==this.writerScriptId||view.schemaVersion!==this.schemaVersion||view.anchorId!==this.anchorId||view.anchorHash!==anchor.hash||view.datasetGeneration!==anchor.payload.datasetGeneration||![0,2].includes(view.writerFence)||!integer(view.revision)||!validId(view.headId)||!digestOk(view.headHash)||!refOk(view.stateRoot)||!refOk(view.receiptRoot))fail('WRITER_READ_VIEW_INVALID');
    this._epochs(view.acceptedEpochs);return true;
  }
  readEntityAtRoot(root,key) {this._guardFrozenRead();if(!refOk(root))fail('WRITER_INDEX_REFERENCE_INVALID');this._key(key);return this._get(root,key);}
  // Stable, bounded DFS over one immutable COW root. Position contains only
  // radix digits/entry offset; the signed API cursor binds the root separately.
  // Nonmatching entries still advance position, preventing import-heavy roots
  // from trapping a snapshot on the same empty page.
  scanEntitiesAtRoot(root,{position=null,prefix='app/data/',limit=128,maxBytes=229376,scanLimit=2048,nodeLimit=128,canContinue=()=>true}={}) {
    this._guardFrozenRead();if(!refOk(root)||typeof prefix!=='string'||!prefix||!integer(limit)||limit<1||limit>512||!integer(maxBytes)||maxBytes<1||maxBytes>262144||!integer(scanLimit)||scanLimit<1||scanLimit>8192||!integer(nodeLimit)||nodeLimit<64||nodeLimit>512||typeof canContinue!=='function')fail('WRITER_SCAN_CONFIG');
    if(position!==null&&(!position||Object.keys(position).sort().join(',')!=='offset,path'||typeof position.path!=='string'||!/^[0-9a-f]{0,64}$/.test(position.path)||!integer(position.offset)||position.offset>this.limits.maxLeafEntries))fail('WRITER_SCAN_CURSOR_INVALID');
    if(root===null){if(position!==null)fail('WRITER_SCAN_CURSOR_INVALID');return {entries:[],position:null,done:true,scanned:0,bytes:2};}
    const start=position?clone(position):{path:'',offset:0};let current=clone(start),entries=[],scanned=0,nodes=0,bytes=2,done=false;
    const open=pos=>{
      let reference=root,depth=0,path='',stack=[];
      while(true){if(++nodes>nodeLimit)fail('SYNC_BUDGET_YIELD',true);const node=this._node(reference,'entities',depth);
        if(node.type==='leaf'){if(pos.path.length>depth||pos.offset>node.entries.length)fail('WRITER_SCAN_CURSOR_INVALID');return {node,path,stack,offset:pos.offset};}
        if(pos.path.length<=depth&&pos.offset!==0)fail('WRITER_SCAN_CURSOR_INVALID');
        const index=pos.path.length>depth?node.children.findIndex(c=>c.digit===pos.path[depth]):0;if(index<0)fail('WRITER_SCAN_CURSOR_INVALID');
        stack.push({node,index,path});const child=node.children[index];reference=child.ref;path+=child.digit;depth++;
      }
    };
    const nextPosition=leaf=>{for(let n=leaf.stack.length-1;n>=0;n--){const ancestor=leaf.stack[n],next=ancestor.node.children[ancestor.index+1];if(next)return {path:ancestor.path+next.digit,offset:0};}return null;};
    while(!done&&entries.length<limit&&scanned<scanLimit){
      if(!canContinue())break;
      let leaf;try{leaf=open(current);}catch(error){if(scanned&&error?.retryable===true)break;throw error;}
      let offset=leaf.offset;
      while(offset<leaf.node.entries.length&&entries.length<limit&&scanned<scanLimit){
        if(!canContinue())break;
        const raw=leaf.node.entries[offset];let entity=null,size=0;
        if(raw.key.startsWith(prefix)){entity=this._validateEntity(raw.value,raw.key);size=encodeUtf8(canonical({...entity,key:entity.key.slice(prefix.length)})).length+(entries.length?1:0);if(bytes+size>maxBytes){if(!entries.length&&scanned===0)fail('WRITER_SCAN_ENTRY_TOO_LARGE');break;}}
        offset++;scanned++;current={path:leaf.path,offset};
        if(entity){entries.push(clone(entity));bytes+=size;}
      }
      if(offset<leaf.node.entries.length)break;
      const next=nextPosition(leaf);if(next===null){done=true;current=null;break;}
      current=next;
    }
    const advanced=done||current.path!==start.path||current.offset!==start.offset;
    if(!done&&!advanced)fail('SYNC_BUDGET_YIELD',true);
    return {entries,position:current,done,scanned,nodes,bytes};
  }
  assertMinimumAtReadView(view,min) {
    this.validateReadView(view);
    if(!min||!integer(min.revision)||!digestOk(min.hash))fail('WRITER_ACKNOWLEDGEMENT_INVALID');
    if(min.revision>view.revision)return false;
    if(min.revision===0){if(min.hash!==view.anchorHash)fail('WRITER_ACKNOWLEDGEMENT_MISMATCH');return true;}
    if(min.revision===view.revision){if(min.hash!==view.headHash)fail('WRITER_ACKNOWLEDGEMENT_MISMATCH');return true;}
    const proof=this._lookup(view.receiptRoot,'receipts','@revision:'+min.revision);
    if(!proof||proof.revision!==min.revision||proof.hash!==min.hash)fail('WRITER_ACKNOWLEDGEMENT_UNPROVEN');return true;
  }

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
  _prefetchMutationPaths(payload,includeOperation=true){
    if(typeof this.io.prefetchFiles!=='function')return false;
    const s=this._state,entityKeys=payload.changes.map(c=>c?.key).filter(k=>typeof k==='string'),receiptKeys=includeOperation?[receiptKey(payload.operation.epoch,payload.operation.operationId)]:[];
    if(s.headReceipt)receiptKeys.push(receiptKey(s.headReceipt.epoch,s.headReceipt.operationId),'@revision:'+s.revision);
    let frontier=[];for(const [tree,roots,keys] of [['entities',[s.stateRoot,payload.stateRoot],entityKeys],['receipts',[s.receiptRoot,payload.receiptRoot],receiptKeys]])if(keys.length)for(const ref of roots)if(ref)frontier.push({ref,tree,depth:0,keys});
    let visited=0,complete=true;
    while(frontier.length&&visited<64){
      const merged=new Map();for(const task of frontier){const key=task.tree+':'+task.depth+':'+task.ref.id+':'+task.ref.hash,old=merged.get(key);if(old)old.keys=[...new Set([...old.keys,...task.keys])];else merged.set(key,{...task,keys:[...new Set(task.keys)]});}
      const tasks=[...merged.values()].slice(0,64-visited);if(tasks.length<merged.size)complete=false;frontier=[];
      for(let at=0;at<tasks.length;at+=16)this.io.prefetchFiles(tasks.slice(at,at+16).map(t=>t.ref.id),this.limits.maxFileBytes);
      for(const task of tasks){visited++;const node=this._node(task.ref,task.tree,task.depth);if(node.type!=='branch')continue;const groups=new Map();for(const key of task.keys){const digit=writerDigest(key)[task.depth];if(!groups.has(digit))groups.set(digit,[]);groups.get(digit).push(key);}for(const child of node.children)if(groups.has(child.digit))frontier.push({ref:child.ref,tree:task.tree,depth:task.depth+1,keys:groups.get(child.digit)});}
    }
    // This is bounded prefetch, not a proof. Full existing transition/receipt
    // checks below still cover untouched children, leaf splits and all values.
    return complete&&frontier.length===0;
  }
  _frame(f,phase,{verifiedOperation=false,verifiedTransition=false}={}) {
    const p=f.payload,s=this._state;
    if(!frameShape(p)||p.datasetGeneration!==s.datasetGeneration||p.revision!==s.revision+1||!equal(p.parent,{id:s.headId,hash:s.headHash})||f.id!==s.nextSlotId||!validId(p.nextSlotId)||p.nextSlotId===f.id||p.nextSlotId===s.headId||!refOk(p.stateRoot)||!refOk(p.receiptRoot)||typeof p.committedAt!=='string'||!Number.isFinite(Date.parse(p.committedAt)))fail('WRITER_FRAME_INVALID');
    if(fenceOf(p)<(s.writerFence||0)||s.nextPreparationId&&!p.nextPreparationId)fail('WRITER_FORMAT_FENCE_REQUIRED');
    if(p.nextPreparationId&&[f.id,p.nextSlotId,s.headId,s.nextPreparationId,this.anchorId,this.checkpointHintId].includes(p.nextPreparationId))fail('WRITER_PREPARATION_SLOT_INVALID');
    const certified=this._prepared.verifyFrame(f,{verifiedTransition}),op=p.operation;
    if(!op||Object.keys(op).sort().join(',')!=='digest,epoch,operationId'||!validId(op.operationId)||!validId(op.epoch)||!digestOk(op.digest)||!s.acceptedEpochs.includes(op.epoch))fail('WRITER_FRAME_OPERATION_INVALID');
    this._epochs(p.acceptedEpochs);
    if(!Array.isArray(p.changes)||p.changes.length>this.limits.maxChanges)fail('WRITER_FRAME_CHANGES_INVALID');
    if(!certified){this._prefetchMutationPaths(p,!verifiedOperation);if(!verifiedOperation&&this._receipt(op.operationId,op.epoch)!==null)fail('WRITER_FRAME_OPERATION_INVALID');}
    const keys=new Set();
    for(const c of p.changes){if(!c||Object.keys(c).sort().join(',')!=='entity,expectedVersion,key'||keys.has(c.key)||!integer(c.expectedVersion))fail('WRITER_FRAME_CHANGES_INVALID');this._key(c.key);keys.add(c.key);const entity=this._validateEntity(c.entity,c.key);if(entity.version!==c.expectedVersion+1)fail('WRITER_FRAME_ENTITY_MISMATCH');if(!certified){const prev=this._get(s.stateRoot,c.key);if((prev?prev.version:0)!==c.expectedVersion||!equal(this._get(p.stateRoot,c.key),entity))fail('WRITER_FRAME_ENTITY_MISMATCH');}}
    if(!certified)this._verifyTree(s.stateRoot,p.stateRoot,'entities',p.changes.map(c=>({key:c.key,value:c.entity})),f.id);
    // The prior head receipt is carried forward with its full verified hash.
    // The current receipt lives in THIS frame until the following commit.
    const receiptUpdates=s.headReceipt?[{key:receiptKey(s.headReceipt.epoch,s.headReceipt.operationId),value:s.headReceipt},{key:'@revision:'+s.revision,value:{revision:s.revision,hash:s.headHash}}]:[];
    if(!certified)this._verifyTree(s.receiptRoot,p.receiptRoot,'receipts',receiptUpdates,f.id);
    this._refs(p.references,phase,{id:f.id,revision:p.revision,changes:p.changes});
    if(p.checkpoint)this._publication(f);
    s.revision=p.revision;s.headId=f.id;s.headHash=f.hash;s.nextSlotId=p.nextSlotId;s.nextPreparationId=p.nextPreparationId||null;s.stateRoot=p.stateRoot;s.receiptRoot=p.receiptRoot;s.headReceipt=this._receiptFor(f);s.acceptedEpochs=p.acceptedEpochs.slice();s.replayFrames=p.checkpoint?1:s.replayFrames+1;s.writerFence=fenceOf(p);
    if(p.checkpoint&&phase==='readback')this._checkpointProgress={phase:'checkpoint',revision:p.revision,indexLinks:s.indexLinks,cursorPersisted:true,cursorAdvanced:true};
  }
  _checkCut(cut) {
    if(!cut||!['hash,id,nextSlotId,revision','hash,id,nextPreparationId,nextSlotId,revision'].includes(Object.keys(cut).sort().join(','))||!integer(cut.revision)||!validId(cut.id)||!digestOk(cut.hash)||!validId(cut.nextSlotId)||(own(cut,'nextPreparationId')&&!validId(cut.nextPreparationId)))fail('WRITER_CHECKPOINT_INVALID');
  }
  _indexPayload(p,id,previous,previousCut=-1) {
    if(!p||Object.keys(p).sort().join(',')!=='cut,manifestRef,nextIndexId,previousIndex,publishingFrame'||!refOk(p.manifestRef)||!p.manifestRef||!validId(p.nextIndexId)||p.nextIndexId===id||!refOk(p.previousIndex)||!equal(p.previousIndex,previous)||(p.previousIndex&&p.previousIndex.id===id)||!p.publishingFrame||Object.keys(p.publishingFrame).sort().join(',')!=='hash,id,revision'||!validId(p.publishingFrame.id)||!digestOk(p.publishingFrame.hash))fail('WRITER_CHECKPOINT_INDEX_INVALID');
    this._checkCut(p.cut);if(p.cut.revision<=previousCut||p.publishingFrame.revision!==p.cut.revision+1||p.publishingFrame.id!==p.cut.nextSlotId)fail('WRITER_CHECKPOINT_INDEX_INVALID');
  }
  _manifest(ref,cut) {
    const f=this._read(ref.id,'checkpoint-manifest',ref),p=f.payload;
    if(!p||!['acceptedEpochs,cut,datasetGeneration,receiptRoot,stateRoot','acceptedEpochs,cut,datasetGeneration,receiptRoot,stateRoot,writerFence'].includes(Object.keys(p).sort().join(','))||(own(p,'writerFence')&&p.writerFence!==2)||fenceOf(p)<(this._state.writerFence||0)||p.datasetGeneration!==this._state.datasetGeneration||!equal(p.cut,cut)||!refOk(p.stateRoot)||!refOk(p.receiptRoot))fail('WRITER_CHECKPOINT_INVALID');
    this._epochs(p.acceptedEpochs);return p;
  }
  _publication(f) {
    const c=f.payload.checkpoint,s=this._state;
    if(!c||Object.keys(c).sort().join(',')!=='cut,indexId,manifestRef,nextIndexId,previousIndex'||!validId(c.indexId)||!validId(c.nextIndexId)||!refOk(c.manifestRef)||!c.manifestRef||!refOk(c.previousIndex))fail('WRITER_CHECKPOINT_INVALID');
    this._checkCut(c.cut);
    if(!equal(c.cut,{id:s.headId,hash:s.headHash,revision:s.revision,nextSlotId:s.nextSlotId,...(s.nextPreparationId?{nextPreparationId:s.nextPreparationId}:{})}))fail('WRITER_CHECKPOINT_CUT_MISMATCH');
    const m=this._manifest(c.manifestRef,c.cut);
    if(fenceOf(m)!==(s.writerFence||0)||fenceOf(f.payload)!==(s.writerFence||0)||!equal(m.stateRoot,s.stateRoot)||!equal(m.receiptRoot,f.payload.receiptRoot)||!equal(m.acceptedEpochs,s.acceptedEpochs))fail('WRITER_CHECKPOINT_STATE_MISMATCH');
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
    this._recovering=true;this._persistFrameProgress=options.persistFrameProgress===true||this.progressiveRecovery;this._frameProgress=null;this._frameProgressStart=0;
    try{return this._recover(options);}catch(error){
      if(this._frameProgress&&['STORE_YIELD','OWNER_BUDGET_YIELD','IMPORT_YIELD'].includes(error.code||error.message))Object.assign(error,{recoveryPhase:'frames',recoveredRevision:this._frameProgress.revision,cursorPersisted:true,cursorAdvanced:this._frameProgress.revision>this._frameProgressStart});
      this._state=null;this._cache.clear();this._verifiedPhase=null;throw error;
    }finally{this._recovering=false;this._persistFrameProgress=false;}
  }
  _hintPayload(ref,indexLinks=this._state.indexLinks,protocol=CHECKPOINT_HINT_PROTOCOL){const s=this._state;return {protocol,anchorId:this.anchorId,anchorHash:s.anchorHash,hintFileId:this.checkpointHintId,storeId:this.storeId,writerScriptId:this.writerScriptId,schemaVersion:this.schemaVersion,datasetGeneration:s.datasetGeneration,indexRef:ref,indexLinks};}
  _writeCheckpointHint(ref){
    if(!this.checkpointHintCodec||equal(this._hintRef,ref))return;
    try{this.io.writeCheckpointHint(this.checkpointHintCodec.encode(this._hintPayload(ref)));this._hintRef=clone(ref);this._frameHintRef=null;}catch(_){/* Advisory only: the immutable commit and mandatory index already won. */}
  }
  _writeIndexScanHint(link,indexLinks){
    if(!this.checkpointHintCodec||!link)return false;
    try{this.io.writeCheckpointHint(this.checkpointHintCodec.encode(this._hintPayload(pointer(link),indexLinks,INDEX_SCAN_HINT_PROTOCOL)));this._hintRef=pointer(link);this._frameHintRef=null;this._indexProgress={phase:'index',indexLinks,revision:link.payload.publishingFrame.revision,cursorPersisted:true,cursorAdvanced:true};return true;}
    catch(_){/* Lost writes or delayed regressions can cost work, never records. */return false;}
  }
  _recoveryPending(link,indexLinks,scannedLinks){
    if(!this.checkpointHintCodec)this._recoverySetupRequired();
    const cursorPersisted=this._writeIndexScanHint(link,indexLinks);
    const error=new Error('WRITER_RECOVERY_PENDING');error.code=error.message;error.retryable=true;
    Object.assign(error,{indexLinks,scannedLinks,cursorPersisted});throw error;
  }
  _authenticatedHint(recoveryRead=undefined){
    if(!this.checkpointHintCodec)return null;
    let payload;
    try{const bytes=recoveryRead===undefined?this.io.readCheckpointHint():recoveryRead.hintBytes;if(bytes===null)return null;payload=this.checkpointHintCodec.decode(bytes)||this._prepared.decodeHint(bytes);}catch(error){if(error?.message==='STORE_YIELD'||error?.message==='STORE_LOCK_REQUIRED')throw error;return null;}
    const s=this._state,base='anchorHash,anchorId,datasetGeneration,hintFileId,indexLinks,indexRef,protocol,schemaVersion,storeId,writerScriptId';
    if(!payload||payload.anchorId!==this.anchorId||payload.anchorHash!==s.anchorHash||payload.hintFileId!==this.checkpointHintId||payload.storeId!==this.storeId||payload.writerScriptId!==this.writerScriptId||payload.schemaVersion!==this.schemaVersion||payload.datasetGeneration!==s.datasetGeneration||!refOk(payload.indexRef)||!integer(payload.indexLinks))return null;
    if([FRAME_SCAN_HINT_PROTOCOL,ATTESTED_FRAME_HINT_PROTOCOL].includes(payload.protocol)){
      const attested=payload.protocol===ATTESTED_FRAME_HINT_PROTOCOL;if(attested&&![0,2].includes(payload.writerFence))return null;
      if(Object.keys(payload).sort().join(',')!==(base+',frameRef,frameRevision,replayFrames'+(attested?',writerFence':'')).split(',').sort().join(',')||!refOk(payload.frameRef)||!payload.frameRef||!integer(payload.frameRevision)||payload.frameRevision<1||!integer(payload.replayFrames)||payload.replayFrames<1||payload.replayFrames>this.limits.maxReplayFrames||(payload.indexRef===null)!==(payload.indexLinks===0))return null;
    }else if(![CHECKPOINT_HINT_PROTOCOL,INDEX_SCAN_HINT_PROTOCOL].includes(payload.protocol)||Object.keys(payload).sort().join(',')!==base||!payload.indexRef||payload.indexLinks<1)return null;
    return payload;
  }
  _writeFrameScanHint(){
    const s=this._state;
    if((!this._persistFrameProgress&&!this.progressiveRecovery)||!this.checkpointHintCodec||s.revision<1||this._frameProgress?.revision===s.revision||equal(this._frameHintRef,{id:s.headId,hash:s.headHash}))return false;
    // A verified checkpoint publication already has a durable INDEX accelerator.
    // Avoid replacing it with a redundant frame cursor on every ordinary read.
    // Old-key semantic replay needs a current-key transition attestation even
    // at the publishing frame, or an INDEX-only hint would repeat that proof.
    if(this.progressiveRecovery&&s.indexHead&&s.replayFrames===1&&!equal(this._prepared.semanticFrame,{id:s.headId,hash:s.headHash}))return false;
    const payload={...this._hintPayload(s.indexHead,s.indexLinks,this._attestedPrefixReady?ATTESTED_FRAME_HINT_PROTOCOL:FRAME_SCAN_HINT_PROTOCOL),...(this._attestedPrefixReady?{writerFence:s.writerFence}:{}),frameRef:{id:s.headId,hash:s.headHash},frameRevision:s.revision,replayFrames:s.replayFrames};
    try{this.io.writeCheckpointHint(this.checkpointHintCodec.encode(payload));this._hintRef=null;this._frameHintRef={id:s.headId,hash:s.headHash};this._frameProgress={revision:s.revision};return true;}
    catch(_){return false;} // Only confirmed progress is reported; advice never acknowledges a write.
  }
  _restoreFramePrefix(hint,last){
    if(![FRAME_SCAN_HINT_PROTOCOL,ATTESTED_FRAME_HINT_PROTOCOL].includes(hint?.protocol)||!equal(hint.indexRef,last?pointer(last):null)||hint.indexLinks!==this._state.indexLinks)return false;
    const f=this._read(hint.frameRef.id,'frame',hint.frameRef),p=f.payload,s=this._state;
    // Verify the exact signed witness BEFORE using any fact it attests. A
    // matching current INDEX and descendant prefix attest that the publishing
    // operation's absence was already proven against this immutable cut.
    const signedCut=last?last.payload.cut.revision:0;
    if(!frameShape(p)||p.datasetGeneration!==s.datasetGeneration||p.revision!==hint.frameRevision||p.revision<=signedCut||hint.replayFrames!==p.revision-signedCut||!validId(p.nextSlotId)||p.nextSlotId===f.id||!refOk(p.stateRoot)||!refOk(p.receiptRoot))fail('WRITER_FRAME_HINT_INVALID');
    this._epochs(p.acceptedEpochs);if(fenceOf(p)<(s.writerFence||0))fail('WRITER_FORMAT_FENCE_REQUIRED');
    if(last){
      // Retain current manifest/publication/INDEX proof and privacy checks. Only
      // the redundant deep negative-receipt lookup is covered by the verified
      // prefix; never apply this shortcut to a new or unhinted successor.
      this._hintRef=pointer(last);
      const witness=last.payload.publishingFrame;
      if(hint.frameRevision<witness.revision)fail('WRITER_FRAME_HINT_INVALID');
      this._frame(this._read(witness.id,'frame',{id:witness.id,hash:witness.hash}),'recovery',{verifiedOperation:true,verifiedTransition:true});
    }
    // The owner signature attests that this exact immutable frame AND all of
    // its transitions/references were already verified. Re-read/hash/identity
    // validation is mandatory; a missing signed witness never falls back.
    const cut=last?last.payload.cut.revision:0;
    if(!frameShape(p)||p.datasetGeneration!==s.datasetGeneration||p.revision!==hint.frameRevision||p.revision<=cut||hint.replayFrames!==p.revision-cut||!validId(p.nextSlotId)||p.nextSlotId===f.id||!refOk(p.stateRoot)||!refOk(p.receiptRoot))fail('WRITER_FRAME_HINT_INVALID');
    this._epochs(p.acceptedEpochs);if(fenceOf(p)<(s.writerFence||0)||hint.protocol===ATTESTED_FRAME_HINT_PROTOCOL&&fenceOf(p)!==hint.writerFence)fail('WRITER_FORMAT_FENCE_REQUIRED');
    Object.assign(s,{writerFence:fenceOf(p),revision:p.revision,headId:f.id,headHash:f.hash,nextSlotId:p.nextSlotId,nextPreparationId:p.nextPreparationId||null,stateRoot:p.stateRoot,receiptRoot:p.receiptRoot,headReceipt:this._receiptFor(f),acceptedEpochs:p.acceptedEpochs.slice(),replayFrames:hint.replayFrames});
    this._frameProgress={revision:p.revision};this._frameProgressStart=p.revision;this._hintRef=null;this._frameHintRef=clone(hint.frameRef);return true;
  }
  _restoreAttestedFramePrefix(hint,last,next,indexLinks){
    // Managed immutable-store contract only. The current-key signature attests
    // the exact previously verified INDEX and descendant transition prefix.
    // Reopen these two current witnesses, not every historical proof object.
    // No absent/old-key/advisory assertion can enter this path.
    if(!this.io._trustManagedRecoveryPrefix||hint?.protocol!==ATTESTED_FRAME_HINT_PROTOCOL||!equal(hint.indexRef,last?pointer(last):null)||hint.indexLinks!==indexLinks)return false;
    const f=this._read(hint.frameRef.id,'frame',hint.frameRef),p=f.payload,s=this._state,cut=last?last.payload.cut.revision:0;
    if(!frameShape(p)||p.datasetGeneration!==s.datasetGeneration||p.revision!==hint.frameRevision||p.revision<=cut||hint.replayFrames!==p.revision-cut||last&&p.revision<last.payload.publishingFrame.revision||!validId(p.nextSlotId)||p.nextSlotId===f.id||!refOk(p.stateRoot)||!refOk(p.receiptRoot))fail('WRITER_FRAME_HINT_INVALID');
    this._epochs(p.acceptedEpochs);if(fenceOf(p)!==hint.writerFence||last?.payload.cut.nextPreparationId&&fenceOf(p)!==2||fenceOf(p)===2&&!p.nextPreparationId||fenceOf(p)<(s.writerFence||0))fail('WRITER_FORMAT_FENCE_REQUIRED');
    this._attestedPrefixReady=true;
    Object.assign(s,{writerFence:fenceOf(p),revision:p.revision,headId:f.id,headHash:f.hash,nextSlotId:p.nextSlotId,nextPreparationId:p.nextPreparationId||null,stateRoot:p.stateRoot,receiptRoot:p.receiptRoot,headReceipt:this._receiptFor(f),acceptedEpochs:p.acceptedEpochs.slice(),replayFrames:hint.replayFrames,indexHead:last?pointer(last):null,nextIndexId:next,indexLinks,checkpoint:last?{manifestRef:last.payload.manifestRef,cut:last.payload.cut,indexRef:pointer(last)}:null});
    this._frameProgress={revision:p.revision};this._frameProgressStart=p.revision;this._hintRef=null;this._frameHintRef=clone(hint.frameRef);return true;
  }
  _restoreIndex(link,next,indexLinks){
    const p=link.payload,m=this._manifest(p.manifestRef,p.cut);
    Object.assign(this._state,{writerFence:fenceOf(m),revision:p.cut.revision,headId:p.cut.id,headHash:p.cut.hash,nextSlotId:p.cut.nextSlotId,nextPreparationId:p.cut.nextPreparationId||null,stateRoot:m.stateRoot,receiptRoot:m.receiptRoot,headReceipt:null,acceptedEpochs:m.acceptedEpochs.slice(),indexHead:pointer(link),nextIndexId:next,checkpoint:{manifestRef:p.manifestRef,cut:p.cut,indexRef:pointer(link)},replayFrames:0,indexLinks});
  }
  _recover({minimumAcknowledged}={}) {
    this._guard();const phase=typeof this.io.getVerifiedReadPhase==='function'?this.io.getVerifiedReadPhase():null;
    this._nodeCachePhaseRequired=this._nodeCachePhaseRequired||!!phase;if(this._nodeCachePhase!==phase){this._cache.clear();this._nodeCachePhase=phase;}
    // Reuse only this continuously-held phase's already verified prefix. The
    // successor remains an uncached read, so delayed immutable creates are seen.
    if(phase&&this._state&&this._verifiedPhase===phase){
      const link=this._read(this._state.nextIndexId,'checkpoint-index',null,true);
      if(!link)return this._recoverTail(minimumAcknowledged);
    }
    this._attestedPrefixReady=false;this._verifiedPhase=null;this._state=null;this._cache.clear();this._hintRef=null;this._frameHintRef=null;this._indexProgress=null;this._checkpointProgress=null;
    const recoveryRead=typeof this.io.prefetchRecoveryRead==='function'?this.io.prefetchRecoveryRead(this.anchorId,this.limits.maxFileBytes):undefined;
    const anchor=this._read(this.anchorId,'bootstrap');this._checkAnchor(anchor);const a=anchor.payload;
    this._state={writerFence:0,anchorHash:anchor.hash,datasetGeneration:a.datasetGeneration,revision:0,headId:anchor.id,headHash:anchor.hash,nextSlotId:a.firstSlotId,nextPreparationId:null,stateRoot:null,receiptRoot:null,headReceipt:null,acceptedEpochs:a.acceptedEpochs.slice(),indexHead:null,nextIndexId:a.firstIndexId,checkpoint:null,replayFrames:0,indexLinks:0};
    let next=a.firstIndexId,previous=null,last=null,previousCut=-1,count=0,scanned=0;const seen=new Set();
    const hint=this._authenticatedHint(recoveryRead);
    if(typeof this.io.prefetchFiles==='function'&&hint){const ids=[hint.indexRef?.id,hint.frameRef?.id];const prep=this._prepared.hint;if(prep&&equal(prep.parent,{id:hint.frameRef?.id,hash:hint.frameRef?.hash,revision:hint.frameRevision}))ids.push(prep.preparation.id,prep.workPage.id);this.io.prefetchFiles(ids.filter(Boolean),this.limits.maxFileBytes);}
    if(hint?.indexRef){
      // INDEX-bearing hint protocols attest ONLY a verified immutable INDEX prefix. Do
      // not open its historical manifest/publication: those may be retired.
      // An authenticated referenced INDEX itself may never silently disappear.
      const link=this._read(hint.indexRef.id,'checkpoint-index',hint.indexRef),p=link.payload;
      this._indexPayload(p,link.id,p?.previousIndex);
      if((hint.indexLinks===1)!==(p.previousIndex===null)||(hint.indexLinks===1&&link.id!==a.firstIndexId)||hint.indexLinks>p.cut.revision+1)fail('WRITER_CHECKPOINT_INDEX_INVALID');
      this._hintRef=pointer(link);
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
    if(!this._restoreAttestedFramePrefix(hint,last,next,count)){
    if(last&&typeof this.io.prefetchFiles==='function'){const ids=[last.payload.manifestRef.id,last.payload.publishingFrame.id];if(hint?.frameRef?.id===last.payload.publishingFrame.id){const head=this._read(hint.frameRef.id,'frame',hint.frameRef);if(head.payload.certificate)ids.push(head.payload.certificate.id);}this.io.prefetchFiles(ids,this.limits.maxFileBytes);}
    if(last)this._restoreIndex(last,next,count);
    this._restoreFramePrefix(hint,last);
    }
    const result=this._recoverTail(minimumAcknowledged,last?last.payload.publishingFrame.revision:null);
    this._attestedPrefixReady=!!this.io._trustManagedRecoveryPrefix;this._verifiedPhase=phase;return result;
  }

  _recoverTail(minimumAcknowledged,requiredPublicationRevision=null,replayed=0) {
    const s=this._state;let minSeen=minimumAcknowledged?this._minimumAtState(minimumAcknowledged):true;
    const frameSeen=new Set();
    while(true){
      if(frameSeen.has(s.nextSlotId))fail('WRITER_FRAME_CYCLE');frameSeen.add(s.nextSlotId);
      const f=this._read(s.nextSlotId,'frame',null,true);if(!f)break;
      // Mandatory current publication proof retains the full hard budget. Only
      // optional further tail work yields early to leave room for signed advice.
      if(this.progressiveRecovery&&(requiredPublicationRevision===null||s.revision>=requiredPublicationRevision)&&!this.canContinueRecovery()){
        this._writeFrameScanHint();fail('STORE_YIELD',true);
      }
      if(replayed++>=this.limits.maxReplayFrames||s.replayFrames>=this.limits.maxReplayFrames)fail('WRITER_REPLAY_BUDGET');
      this._frame(f,'recovery');if(this.progressiveRecovery||replayed===1||replayed%4===0)this._writeFrameScanHint();
      if(minimumAcknowledged&&this._minimumAtState(minimumAcknowledged))minSeen=true;
    }
    if(requiredPublicationRevision!==null&&s.revision<requiredPublicationRevision)fail('WRITER_MISSING_PUBLICATION_FRAME');
    if(minimumAcknowledged&&!minSeen){const r=minimumAcknowledged;const known=this._lookup(s.receiptRoot,'receipts','@revision:'+r.revision);if(!known||known.revision!==r.revision||known.hash!==r.hash)fail('WRITER_ACKNOWLEDGEMENT_UNPROVEN');}
    this._writeFrameScanHint();
    return this._statusSnapshot();
  }
  _minimumAtState(min) {
    if(!min||!integer(min.revision)||!digestOk(min.hash))fail('WRITER_ACKNOWLEDGEMENT_INVALID');
    if(min.revision===0){if(min.hash!==this._state.anchorHash)fail('WRITER_ACKNOWLEDGEMENT_MISMATCH');return true;}
    if(min.revision===this._state.revision){if(min.hash!==this._state.headHash)fail('WRITER_ACKNOWLEDGEMENT_MISMATCH');return true;}return false;
  }
  // Diagnostic only: a signed verified prefix is not an available business state.
  recoveryProgress() {this._guard();return this._frameProgress?{recoveredRevision:this._frameProgress.revision,cursorPersisted:true,cursorAdvanced:this._frameProgress.revision>this._frameProgressStart}: {recoveredRevision:null,cursorPersisted:false,cursorAdvanced:false};}
  continuationProgress(){this._guard();if(this._prepared.progress)return clone(this._prepared.progress);const p=this.recoveryProgress();if(p.cursorAdvanced)return {phase:'frames',revision:p.recoveredRevision,cursorPersisted:true,cursorAdvanced:true};return this._checkpointProgress?clone(this._checkpointProgress):this._indexProgress?clone(this._indexProgress):null;}
  status() {this._assertReady();return this._statusSnapshot();}
  _statusSnapshot() {const s=this._state;return clone({storeId:this.storeId,writerFence:s.writerFence||0,datasetGeneration:s.datasetGeneration,revision:s.revision,headId:s.headId,headHash:s.headHash,nextSlotId:s.nextSlotId,nextPreparationId:s.nextPreparationId||null,checkpoint:s.checkpoint,stateRoot:s.stateRoot,receiptRoot:s.receiptRoot,headReceipt:s.headReceipt,acceptedEpochs:s.acceptedEpochs,indexHead:s.indexHead,nextIndexId:s.nextIndexId,indexLinks:s.indexLinks,replayFrames:s.replayFrames});}
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
  _append(c,checkpoint=false,nextEpochs=null,targetFence=null) {
    if(this._state.nextPreparationId)this._prepared.requireVacant();
    const s=this._state,writerFence=targetFence===null?(s.writerFence||0):targetFence;
    if(![0,2].includes(writerFence)||writerFence<(s.writerFence||0))fail('WRITER_FORMAT_FENCE_REQUIRED');if(!s.acceptedEpochs.includes(c.epoch))fail('OP_EXPIRED');
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
    if(checkpoint){if(changes.length)fail('WRITER_CHECKPOINT_CHANGES');const cut={id:s.headId,hash:s.headHash,revision:s.revision,nextSlotId:slotId,...(s.nextPreparationId?{nextPreparationId:s.nextPreparationId}:{})};const manifestRef=this._createExact(this._id(),'checkpoint-manifest',{datasetGeneration:s.datasetGeneration,cut,stateRoot,receiptRoot,acceptedEpochs:s.acceptedEpochs,...(writerFence?{writerFence}: {})});publication={indexId:s.nextIndexId,nextIndexId:this._id(),previousIndex:s.indexHead,manifestRef,cut};}
    const payload={datasetGeneration:s.datasetGeneration,revision:s.revision+1,parent:{id:s.headId,hash:s.headHash},nextSlotId:this._id(),...(writerFence===2?{nextPreparationId:this._id()}:{}),operation:{operationId:c.operationId,epoch:c.epoch,digest:c.digest},committedAt,changes,stateRoot,receiptRoot,result:c.result,references:c.references,checkpoint:publication,acceptedEpochs:nextEpochs?this._epochs(nextEpochs):s.acceptedEpochs.slice(),...(writerFence?{writerFence}: {})};
    const proposal=this._sealed('frame',payload),bytes=this._bytes(proposal);
    let winner=null;
    try {
    for(let attempt=0;attempt<this.limits.maxCreateAttempts;attempt++){try{this.io.createFile(slotId,bytes,'frame');}catch(_){}winner=this._read(slotId,'frame',null,true);if(winner)break;}
    if(!winner)fail('WRITER_COMMIT_UNRESOLVED',true);
    // A valid older, delayed proposal may win. Adopt its ORIGINAL receipt and
    // reserved successor, even when timestamps or generated IDs differ.
    this._frame(winner,'readback');
    const receipt=this._receipt(c.operationId,c.epoch);
    if(receipt){if(receipt.digest!==c.digest)fail('OP_ID_REUSED');this._writeFrameScanHint();return receipt;}
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
  prepareAppCommand(command,digest){return this._prepared.command(command,digest);}
  // Explicit owner migration only; no public command accepts targetFence.
  // A durable format2 frame fences old exact-shape readers/writers forever.
  enableFormatFence(command) {
    this.recoveryBarrier();const c=this._command(command);
    for(let i=0;i<this.limits.maxContention;i++){
      const prior=this._checkReplay(c);if(prior){if(this._state.writerFence!==2)fail('WRITER_FORMAT_FENCE_MISSING');return prior;}
      if(this._state.writerFence===2)fail('WRITER_FORMAT_FENCE_ALREADY_ENABLED');
      const receipt=this._append(c,false,null,2);if(receipt)return receipt;this.recoveryBarrier();
    }fail('WRITER_CONTENTION',true);
  }

  _automaticCheckpoint() {
    const s=this._state,c={operationId:'checkpoint_'+s.revision+'_'+s.headHash.slice(0,16),epoch:s.acceptedEpochs[0],digest:writerDigest({kind:'checkpoint',headId:s.headId,headHash:s.headHash}),changes:[],references:[],result:{checkpoint:true}};
    if(s.nextPreparationId&&this.preparationCodec){if(!this._prepared.checkpoint(c))this.recoveryBarrier();}
    else if(!this._append(c,true))this.recoveryBarrier();
  }
  checkpoint(command) {
    this.recoveryBarrier();const c=this._command({...command,changes:[],references:[]});
    for(let i=0;i<this.limits.maxContention;i++){const prior=this._checkReplay(c);if(prior)return prior;const receipt=this._state.nextPreparationId&&this.preparationCodec?this._prepared.checkpoint(c):this._append(c,true);if(receipt)return receipt;this.recoveryBarrier();}fail('WRITER_CONTENTION',true);
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
