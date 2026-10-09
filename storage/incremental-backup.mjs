// /** Owner-only, resumable immutable snapshot archive. Never follows mutable
//  * successor slots: one captureReadView fixes the cutoff. Copies are not a
//  * directly swappable Drive folder. No source mutation or retention deletion. */
import {writerDigest,WRITER_PROTOCOL,ReservedSlotWriter} from './reserved-writer.mjs';
import {encodeUtf8,decodeUtf8,IncrementalSha256} from './codec.mjs';
const fail=c=>{throw Error(c);};
const clone=x=>JSON.parse(JSON.stringify(x));
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const digest=b=>new IncrementalSha256().update(b).digestHex();
const equal=(a,b)=>writerDigest(a)===writerDigest(b);
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
const MAX_FILE=2*1024*1024,MAX_JOB=4*1024*1024;
const pausedImport=()=>({schema:1,status:'blocked',retryAt:0,error:'RESTORED_IMPORTS_PAUSED',lastJob:null,processingMode:'paused',allowanceMs:null});
const scope={records:'all captured entity values and tombstones',receipts:'captured receipt tree archive',assets:'ready CSV pin assets',excluded:['browser-only unsynced records','raw running_data CSV sources','account failure','in-progress reserved asset bodies','historical predecessor frame chain'],restore:'new independent store; entity versions and receipts reset; imported routes use archived asset map; CSV jobs paused'};
function ref(r){if(!r||!id(r.id)||!hash(r.hash)||!['bootstrap','frame','index-node','asset'].includes(r.kind))fail('BACKUP_REFERENCE_INVALID');if(r.kind==='asset'&&(!Number.isSafeInteger(r.byteLength)||r.byteLength<1||r.byteLength>MAX_FILE))fail('BACKUP_ASSET_BOUND');return r;}
function validateView(v){if(!v||!id(v.storeId)||!id(v.writerScriptId)||!id(v.anchorId)||!hash(v.anchorHash)||!id(v.headId)||!hash(v.headHash)||v.writerFence!==2||!Number.isSafeInteger(v.revision)||v.revision<1||!Number.isSafeInteger(v.schemaVersion)||v.schemaVersion<1)fail('BACKUP_CAPTURE_INVALID');for(const root of [v.stateRoot,v.receiptRoot])if(root!==null&&(!id(root?.id)||!hash(root?.hash)))fail('BACKUP_CAPTURE_INVALID');}
function roots(v){return [{id:v.anchorId,hash:v.anchorHash,kind:'bootstrap'},{id:v.headId,hash:v.headHash,kind:'frame'},...[v.stateRoot,v.receiptRoot].filter(Boolean).map(r=>({...r,kind:'index-node'}))];}
function verify(bytes,r,v){ref(r);if(!bytes||!Number.isSafeInteger(bytes.length)||bytes.length<1||bytes.length>MAX_FILE)fail('BACKUP_BYTES_INVALID');if(r.kind==='asset'){if(bytes.length!==r.byteLength||digest(bytes)!==r.hash)fail('BACKUP_ASSET_CORRUPT');return null;}
 let f;try{f=JSON.parse(decodeUtf8(bytes));}catch(_){fail('BACKUP_PROTOCOL_INVALID');}const {hash:h,...body}=f;
 if(decodeUtf8(bytes)!==canonical(f)||Object.keys(f).sort().join(',')!=='hash,kind,payload,protocol,schemaVersion,storeId,writerScriptId'||h!==r.hash||writerDigest(body)!==h||f.protocol!==WRITER_PROTOCOL||f.kind!==r.kind||f.storeId!==v.storeId||f.writerScriptId!==v.writerScriptId||f.schemaVersion!==v.schemaVersion)fail('BACKUP_PROTOCOL_CORRUPT');
 if(r.kind==='frame'&&(!equal(f.payload.stateRoot,v.stateRoot)||!equal(f.payload.receiptRoot,v.receiptRoot)||f.payload.revision!==v.revision||f.payload.datasetGeneration!==v.datasetGeneration||f.payload.writerFence!==2))fail('BACKUP_CUTOFF_MISMATCH');return f;
}
function dependencies(f){if(!f||f.kind!=='index-node')return [];const p=f.payload;if(p.type==='branch'){if(!Array.isArray(p.children))fail('BACKUP_NODE_INVALID');return p.children.map(c=>({...c.ref,kind:'index-node'}));}if(p.type!=='leaf'||!Array.isArray(p.entries))fail('BACKUP_NODE_INVALID');const out=[];
 if(p.tree==='entities')for(const e of p.entries){if(e.key.startsWith('import/pin/')&&!e.value.deleted&&e.value.value?.state==='ready'){const pin=e.value.value;if(!Array.isArray(pin.assets))fail('BACKUP_PIN_INVALID');for(const a of pin.assets)out.push({id:a.fileId,hash:a.sha256,byteLength:a.byteLength,kind:'asset',reservation:clone(a)});}}
 return out;
}
function checkedManifest(m){if(!m||m.protocol!=='mypace-backup-v1'||m.status!=='complete'||!Array.isArray(m.entries))fail('BACKUP_MANIFEST_INVALID');const {hash:h,...body}=m;if(!hash(h)||writerDigest(body)!==h)fail('BACKUP_MANIFEST_CORRUPT');validateView(m.view);const seen=new Set();for(const e of m.entries){ref(e.ref);if(!id(e.copyId)||seen.has(e.ref.id))fail('BACKUP_MANIFEST_INVALID');seen.add(e.ref.id);}for(const r of roots(m.view)){const e=m.entries.find(x=>x.ref.id===r.id);if(!e||!equal(e.ref,r))fail('BACKUP_MAP_MISSING');}return m;}
export function validateBackupManifest(m){checkedManifest(m);return true;}
export function createBackupJob(view,previousManifest=null,createdAt=new Date().toISOString()){
 validateView(view);if(!Number.isFinite(Date.parse(createdAt)))fail('BACKUP_DATE_INVALID');let previous=[];
 if(previousManifest){checkedManifest(previousManifest);if(previousManifest.view.storeId!==view.storeId||previousManifest.view.anchorId!==view.anchorId||previousManifest.view.writerScriptId!==view.writerScriptId)fail('BACKUP_PREVIOUS_IDENTITY');previous=previousManifest.entries;}
 return {protocol:'mypace-backup-job-v1',view:clone(view),createdAt,queue:roots(view),entries:[],previous:clone(previous),pending:null,status:'copying',copied:0,reused:0};
}
function persist(job,io){if(encodeUtf8(JSON.stringify(job)).length>MAX_JOB)fail('BACKUP_JOB_CAPACITY');io.saveJob(clone(job));}
export function backupSlice(job,io,{maxFiles=4,canContinue=()=>true}={}){
 if(job?.protocol!=='mypace-backup-job-v1'||!Array.isArray(job.queue)||!Array.isArray(job.entries)||!Array.isArray(job.previous)||!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>64)fail('BACKUP_JOB_INVALID');validateView(job.view);
 for(const n of ['allocateId','readSource','readBackup','createBackup','saveJob'])if(typeof io?.[n]!=='function')fail('BACKUP_IO_INVALID');
 let n=0;
 while(job.queue.length&&n<maxFiles&&canContinue()){
  const r=ref(job.queue[0]),existing=job.entries.find(e=>e.ref.id===r.id);
  if(existing){if(!equal(existing.ref,r))fail('BACKUP_REFERENCE_CONFLICT');job.queue.shift();persist(job,io);continue;}
  let entry=job.previous.find(e=>e.ref.id===r.id),bytes,f;
  if(entry){if(!equal(entry.ref,r))fail('BACKUP_REFERENCE_CONFLICT');bytes=io.readBackup(entry.copyId,MAX_FILE);f=verify(bytes,r,job.view);job.reused++;}
  else {
   if(job.pending&&(!equal(job.pending.ref,r)||!id(job.pending.copyId)))fail('BACKUP_PENDING_INVALID');
   if(!job.pending){const copyId=io.allocateId();if(!id(copyId)||copyId===r.id)fail('BACKUP_COPY_ID_INVALID');job.pending={ref:clone(r),copyId};persist(job,io);}
   entry=clone(job.pending);bytes=io.readBackup(entry.copyId,MAX_FILE);
   if(bytes===null){bytes=io.readSource(r);verify(bytes,r,job.view);try{io.createBackup(entry.copyId,bytes,r.kind==='asset'?r.reservation.role:r.kind);}catch(error){const found=io.readBackup(entry.copyId,MAX_FILE);if(found===null)throw error;bytes=found;}const found=io.readBackup(entry.copyId,MAX_FILE);if(found===null)fail('BACKUP_COPY_UNRESOLVED');bytes=found;}
   f=verify(bytes,r,job.view);job.copied++;
  }
  job.entries.push(clone(entry));job.queue.shift();for(const d of dependencies(f)){ref(d);job.queue.push(d);}job.pending=null;n++;persist(job,io);
 }
 let manifest=null;if(!job.queue.length){const body={protocol:'mypace-backup-v1',status:'complete',createdAt:job.createdAt,view:job.view,entries:job.entries,scope};manifest={...clone(body),hash:writerDigest(body)};job.status='complete';persist(job,io);}
 return {job,status:job.status,manifest,copied:job.copied,reused:job.reused};
}
// /** No fallback to production IO, even for a missing copy. */
export function createBackupReadIO(manifest,readBackup){checkedManifest(manifest);if(typeof readBackup!=='function')fail('BACKUP_IO_INVALID');return {getScriptId:()=>manifest.view.writerScriptId,assertLockHeld:()=>true,allocateIds:()=>fail('BACKUP_READ_ONLY'),createFile:()=>fail('BACKUP_READ_ONLY'),readFile(originalId,maxBytes){const e=manifest.entries.find(x=>x.ref.id===originalId);if(!e)fail('BACKUP_MAP_MISSING');const b=readBackup(e.copyId,maxBytes);const f=verify(b,e.ref,manifest.view);for(const r of dependencies(f)){const found=manifest.entries.find(x=>x.ref.id===r.id);if(!found||!equal(found.ref,r))fail('BACKUP_MAP_MISSING');}return b;}};}
export function createBackupAssetReader(manifest,readBackup){const io=createBackupReadIO(manifest,readBackup);return reservation=>{const e=manifest.entries.find(x=>x.ref.id===reservation.fileId);if(!e||e.ref.kind!=='asset'||e.ref.hash!==reservation.sha256||e.ref.byteLength!==reservation.byteLength)fail('BACKUP_ASSET_MAP_MISSING');return io.readFile(e.ref.id,MAX_FILE);};}
export function openBackupSnapshot(manifest,readBackup){const io=createBackupReadIO(manifest,readBackup),v=manifest.view;const writer=new ReservedSlotWriter({io,anchorId:v.anchorId,storeId:v.storeId,writerScriptId:v.writerScriptId,schemaVersion:v.schemaVersion});writer.validateReadView(v);io.readFile(v.headId,MAX_FILE);return {writer,view:clone(v),readAsset:createBackupAssetReader(manifest,readBackup)};}
// /** Bounded DFS cursor also includes non-app entity namespaces. */
export function readBackupEntities(manifest,readBackup,{position=0,cursor=null,limit=32,maxNodes=16,canContinue=()=>true}={}){
 checkedManifest(manifest);if(!Number.isSafeInteger(position)||position<0||!Number.isSafeInteger(limit)||limit<1||limit>128)fail('BACKUP_SCAN_INVALID');
 if(cursor===null&&position!==0)fail('BACKUP_SCAN_CURSOR_REQUIRED');
 let c=cursor?clone(cursor):{index:0,offset:0};if(!Number.isSafeInteger(c.index)||c.index<0||c.index>manifest.entries.length||!Number.isSafeInteger(c.offset)||c.offset<0)fail('BACKUP_SCAN_INVALID');
 const io=createBackupReadIO(manifest,readBackup),out=[],steps=[];let nodes=0;
 while(c.index<manifest.entries.length&&out.length<limit&&nodes<maxNodes&&canContinue()){
  const e=manifest.entries[c.index];if(e.ref.kind!=='index-node'){if(c.offset)fail('BACKUP_SCAN_INVALID');c={index:c.index+1,offset:0};continue;}
  const f=JSON.parse(decodeUtf8(io.readFile(e.ref.id,MAX_FILE)));nodes++;
  if(f.payload.tree!=='entities'||f.payload.type!=='leaf'){if(c.offset)fail('BACKUP_SCAN_INVALID');c={index:c.index+1,offset:0};continue;}
  if(c.offset>f.payload.entries.length)fail('BACKUP_SCAN_INVALID');
  while(c.offset<f.payload.entries.length&&out.length<limit){const x=f.payload.entries[c.offset];if(!x.value||x.key!==x.value.key||typeof x.value.deleted!=='boolean'||!Number.isSafeInteger(x.value.version))fail('BACKUP_ENTITY_INVALID');out.push(clone(x.value));c.offset++;if(c.offset===f.payload.entries.length)c={index:c.index+1,offset:0};steps.push(clone(c));if(c.offset===0)break;}
  if(f.payload.entries.length===0)c={index:c.index+1,offset:0};
 }
 return {entries:out,steps,cursor:c,position:position+out.length,done:c.index===manifest.entries.length};
}
export function createRestoreJob(manifest,targetIdentity){checkedManifest(manifest);if(!targetIdentity||!id(targetIdentity.storeId)||!id(targetIdentity.anchorId)||targetIdentity.storeId===manifest.view.storeId||targetIdentity.anchorId===manifest.view.anchorId)fail('RESTORE_TARGET_NOT_ISOLATED');return {protocol:'mypace-restore-job-v1',manifestHash:manifest.hash,target:clone(targetIdentity),position:0,cursor:null,status:'restoring',restored:0};}
function rebind(value,from,to){if(Array.isArray(value))return value.map(x=>rebind(x,from,to));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='storeId'&&v===from?to:rebind(v,from,to)]));return value;}
function restoredValue(e,manifest,writer){if(e.deleted)return null;if(e.key==='import/owner-scheduler')return pausedImport();return e.key.startsWith('import/job/')||e.key.startsWith('import/pin/')?rebind(e.value,manifest.view.storeId,writer.storeId):clone(e.value);}
export function restoreSlice(job,{manifest,readBackup,writer,saveJob},{maxEntities=8,canContinue=()=>true}={}){
 checkedManifest(manifest);if(job?.protocol!=='mypace-restore-job-v1'||job.manifestHash!==manifest.hash||writer.storeId!==job.target.storeId||writer.anchorId!==job.target.anchorId||writer.storeId===manifest.view.storeId||typeof saveJob!=='function'||!Number.isSafeInteger(maxEntities)||maxEntities<1||maxEntities>32)fail('RESTORE_TARGET_NOT_ISOLATED');
 if(!canContinue())return {job,status:job.status};
 writer.recoveryBarrier();const status=writer.status(),epoch=status.acceptedEpochs[status.acceptedEpochs.length-1];if(status.writerFence!==2)fail('RESTORE_TARGET_FENCE_REQUIRED');
 if(job.status==='pausing-imports')return pauseRestoredImports(job,{manifest,writer,saveJob},epoch);
 if(job.status!=='restoring')fail('RESTORE_PHASE_INVALID');
 // Older releases persisted an end cursor before pausing. Upgrade that exact
 // completed scan without rereading and saving an empty restore batch.
 if(!job.pendingRestore&&job.cursor?.index===manifest.entries.length&&job.cursor.offset===0){job.status='pausing-imports';saveJob(clone(job));return {job,status:job.status,restored:job.restored};}
 if(!job.pendingRestore){
  const page=readBackupEntities(manifest,readBackup,{position:job.position,cursor:job.cursor,limit:maxEntities,canContinue}),selected=[];let bytes=0;
  for(const e of page.entries){const size=encodeUtf8(JSON.stringify(e)).length;if(selected.length&&bytes+size>32768)break;selected.push(e);bytes+=size;}
  const all=selected.length===page.entries.length,cursor=all?page.cursor:page.steps[selected.length-1];
  job.pendingRestore={entries:selected,cursor,position:job.position+selected.length,done:all&&page.done};saveJob(clone(job));
 }
 const pending=job.pendingRestore,entries=pending.entries.filter(e=>e.key!=='app/change-head'&&!e.key.startsWith('app/change-slot/'));
 if(entries.length){
  const changes=entries.map(e=>({key:e.key,expectedVersion:0,value:restoredValue(e,manifest,writer)})),identity={manifest:manifest.hash,target:job.target,position:job.position,changes},d=writerDigest(identity),operationId='restore_batch_'+d.slice(0,40),prior=writer.getReceipt(operationId,epoch);
  if(!prior){for(const c of changes)if(writer.get(c.key))fail('RESTORE_TARGET_NOT_EMPTY');writer.transact({operationId,epoch,digest:d,changes});}else if(prior.digest!==d)fail('RESTORE_RECEIPT_MISMATCH');
  const deletions=entries.filter(e=>e.deleted).map(e=>({key:e.key,expectedVersion:1,deleted:true}));if(deletions.length){const dd=writerDigest({identity,deletions}),deleteId='restore_delete_'+dd.slice(0,40);if(!writer.getReceipt(deleteId,epoch))writer.transact({operationId:deleteId,epoch,digest:dd,changes:deletions});}
 }
 job.restored+=entries.length;job.cursor=pending.cursor;job.position=pending.position;const done=pending.done;job.pendingRestore=null;if(done)job.status='pausing-imports';saveJob(clone(job));

 return {job,status:job.status,restored:job.restored,imports:'pause-pending; completed routes use the immutable backup asset map',entityVersions:'reset in independent store'};
}


function pauseRestoredImports(job,{manifest,writer,saveJob},epoch){
  const key='import/owner-scheduler',value=pausedImport(),d=writerDigest({manifest:manifest.hash,target:job.target,pause:true}),operationId='restore_pause_'+d.slice(0,40);
  if(!writer.getReceipt(operationId,epoch)){const old=writer.get(key);writer.transact({operationId,epoch,digest:d,changes:[{key,expectedVersion:old?old.version:0,value,...(old?.deleted?{recreate:true}:{})}]});}
  job.status='restored-needs-verification';saveJob(clone(job));
 return {job,status:job.status,restored:job.restored,imports:'paused'};
}

// Verification is separately resumable and never reads production files. It
// compares reconstructed values, traverses completed route pages via the actual
// application reader, and requires a later invocation to observe a write probe.
export function verifyRestoreSlice(job,{manifest,readBackup,writer,saveJob,makeImportReader},{maxEntities=4,canContinue=()=>true}={}){
 checkedManifest(manifest);if(job?.manifestHash!==manifest.hash||writer.storeId!==job.target?.storeId||writer.anchorId!==job.target?.anchorId||writer.storeId===manifest.view.storeId||typeof makeImportReader!=='function')fail('RESTORE_VERIFY_CONFIG');
 if(!Number.isSafeInteger(maxEntities)||maxEntities<1||maxEntities>128)fail('RESTORE_VERIFY_BOUND');
 if(!['restored-needs-verification','verifying','restore-probe-written','restore-verified'].includes(job.status))fail('RESTORE_NOT_RECONSTRUCTED');
 writer.recoveryBarrier();
 if(writer.status().writerFence!==2)fail('RESTORE_TARGET_FENCE_REQUIRED');
 if(job.status==='restore-verified')return {job,status:job.status};
 if(job.status==='restore-probe-written'){
  const probe=writer.get(job.verification.probeKey);if(!probe||probe.deleted||!equal(probe.value,{manifest:manifest.hash,target:job.target}))fail('RESTORE_WRITE_PROBE_MISSING');
  job.status='restore-verified';job.verifiedAt=new Date().toISOString();saveJob(clone(job));return {job,status:job.status,records:job.verification.records,routePages:job.verification.routePages,imports:'paused'};
 }
 if(!job.verification)job.verification={cursor:null,position:0,records:0,routePages:0,pendingRoute:null,scanDone:false};job.status='verifying';const v=job.verification;
 const targetView=writer.captureReadView();
 if(v.targetView&&!equal(v.targetView,targetView)){
  // A probe may have committed just before a lost reply/budget yield. Accept
  // only that exact single successor, never unrelated target edits.
  const d=writerDigest({manifest:manifest.hash,target:job.target}),key='recovery/verified-write/'+d,value={manifest:manifest.hash,target:job.target};
  const receipt=writer.getReceipt('restore_probe_'+d.slice(0,40),targetView.acceptedEpochs[targetView.acceptedEpochs.length-1]);
  const actual=writer.get(key);
  if(!v.scanDone||v.pendingRoute||targetView.revision!==v.targetView.revision+1||!receipt||receipt.digest!==writerDigest(value)||receipt.revision!==targetView.revision||receipt.frameId!==targetView.headId||receipt.frameHash!==targetView.headHash||!actual||actual.deleted||!equal(actual.value,value)||!equal(receipt.entityVersions,[{key,version:1,deleted:false}]))fail('RESTORE_VERIFY_TARGET_CHANGED');
  v.probeKey=key;job.status='restore-probe-written';saveJob(clone(job));return {job,status:job.status,records:v.records,routePages:v.routePages};
 }
 v.targetView=targetView;
 // A durable completed verification scan needs only the final write probe.
 // Do not reopen archived roots or re-read completed routes on every retry.
 if(v.scanDone&&!v.pendingRoute)return writeRestoreProbe(job,{manifest,writer,saveJob},canContinue);
 // This cache is private to this verification call, never reused across locks or
 // invocations. Every returned body still passes its manifest hash/identity check.
 const rawRead=readBackup,cache=new Map();let cachedBytes=0;
 readBackup=(id,max)=>{let bytes=cache.get(id);if(!bytes){bytes=rawRead(id,max);if(bytes&&bytes.length<=4194304){while(cache.size&&(cache.size>=64||cachedBytes+bytes.length>4194304)){const first=cache.keys().next().value;cachedBytes-=cache.get(first).length;cache.delete(first);}cache.set(id,Uint8Array.from(bytes));cachedBytes+=bytes.length;}}if(bytes&&bytes.length>max)fail('BACKUP_SIZE_INVALID');return bytes?Uint8Array.from(bytes):bytes;};
 const targetReaderWriter={get:k=>writer.readEntityAtRoot(targetView.stateRoot,k),status:()=>({revision:targetView.revision}),recoveryBarrier:()=>true,transact:()=>fail('BACKUP_READ_ONLY'),getReceipt:()=>null};
 const frozen=openBackupSnapshot(manifest,readBackup),oldWriter={get:k=>frozen.writer.readEntityAtRoot(manifest.view.stateRoot,k),status:()=>({revision:manifest.view.revision}),recoveryBarrier:()=>true,transact:()=>fail('BACKUP_READ_ONLY'),getReceipt:()=>null};
 const originalReader=makeImportReader(oldWriter,manifest.view.storeId,frozen.readAsset),restoredReader=makeImportReader(targetReaderWriter,writer.storeId,createBackupAssetReader(manifest,readBackup));
 let count=0,uncheckpointed=0,lastCheckpoint=Date.now();
 const checkpoint=(force=false)=>{if(uncheckpointed&&(force||uncheckpointed>=8||Date.now()-lastCheckpoint>=15000)){saveJob(clone(job));uncheckpointed=0;lastCheckpoint=Date.now();}};
 while(count<maxEntities&&canContinue()){
  if(v.pendingRoute){const p=v.pendingRoute,a=originalReader.readRoutePage({runId:p.runId,cursor:p.originalCursor}),b=restoredReader.readRoutePage({runId:p.runId,cursor:p.restoredCursor});if(!equal(a.points,b.points)||!!a.nextCursor!==!!b.nextCursor)fail('RESTORE_ROUTE_MISMATCH');v.routePages++;p.originalCursor=a.nextCursor;p.restoredCursor=b.nextCursor;if(!a.nextCursor)v.pendingRoute=null;count++;uncheckpointed++;checkpoint();continue;}
  if(v.scanDone)break;
  const page=readBackupEntities(manifest,readBackup,{position:v.position,cursor:v.cursor,limit:1,canContinue});
  if(page.entries.length){const e=page.entries[0];if(e.key!=='app/change-head'&&!e.key.startsWith('app/change-slot/')){const actual=targetReaderWriter.get(e.key);let expected=e.deleted?null:e.key.startsWith('import/job/')||e.key.startsWith('import/pin/')?rebind(e.value,manifest.view.storeId,writer.storeId):e.value;if(e.key==='import/owner-scheduler')expected=pausedImport();if(!actual||actual.deleted!==(e.key==='import/owner-scheduler'?false:e.deleted)||!equal(actual.value,expected))fail('RESTORE_ENTITY_MISMATCH');v.records++;if(!e.deleted&&e.key.startsWith('run/')&&e.value?.imported?.jobId){const jobEntity=oldWriter.get('import/job/'+e.value.imported.jobId);if(jobEntity?.value?.status==='completed')v.pendingRoute={runId:e.key.slice(4),originalCursor:null,restoredCursor:null};}}}
  v.cursor=page.cursor;v.position=page.position;v.scanDone=page.done;count++;uncheckpointed++;checkpoint();
 }
 checkpoint(true);
 if(v.scanDone&&!v.pendingRoute)return writeRestoreProbe(job,{manifest,writer,saveJob},canContinue);
 return {job,status:job.status,records:v.records,routePages:v.routePages};
}

function writeRestoreProbe(job,{manifest,writer,saveJob},canContinue){
 const v=job.verification;
 if(v.scanDone&&!v.pendingRoute&&canContinue()){
  const paused=writer.get('import/owner-scheduler');if(!paused||paused.deleted||!equal(paused.value,pausedImport()))fail('RESTORE_IMPORT_PAUSE_MISSING');
  const d=writerDigest({manifest:manifest.hash,target:job.target}),key='recovery/verified-write/'+d,operationId='restore_probe_'+d.slice(0,40),value={manifest:manifest.hash,target:job.target};
  const status=writer.status();if(!writer.getReceipt(operationId,status.acceptedEpochs[status.acceptedEpochs.length-1]))writer.transact({operationId,epoch:status.acceptedEpochs[status.acceptedEpochs.length-1],digest:writerDigest(value),changes:[{key,expectedVersion:0,value}]});v.probeKey=key;job.status='restore-probe-written';saveJob(clone(job));
 }
 return {job,status:job.status,records:v.records,routePages:v.routePages};
}
