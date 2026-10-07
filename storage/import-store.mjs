// GAS V8-compatible import domain binding. Drive persistence is supplied only by
// the reserved-slot writer. Every public method must run under its ONE script lock;
// ImportCheckpointCoordinator supplies that lock for its two bounded phases.
// No original source is mutated, no job list/snapshot grows in a single entity.
import {encodeUtf8, decodeUtf8, IncrementalSha256} from './codec.mjs';
import {initialCheckpoint, checkpointBytes, checkpointPointLimit, mappingHash, LIMITS} from './bounded-import.mjs';
import {PARSER_VERSION, sourceKey} from './import-core.mjs';
import {validateSourceIdentity, SOURCE_FOLDER_ID} from './transport.mjs';
import {hashAssetBytes} from './immutable-assets.mjs';

export const IMPORT_STORE_LIMITS=Object.freeze({entityBytes:65536,scanPageBytes:65536,scanFiles:100,assets:66});
const fail=code=>{throw Error(code);};
const check=(ok,code)=>{if(!ok)fail(code);};
const token=(s,max=128)=>typeof s==='string'&&s.length>0&&s.length<=max&&/^[A-Za-z0-9_-]+$/.test(s);
const clone=x=>JSON.parse(JSON.stringify(x));
const canonical=(x,depth=0)=>{
 check(depth<=40,'IMPORT_VALUE_DEPTH');
 if(x===null||typeof x==='string'||typeof x==='boolean')return JSON.stringify(x);
 if(typeof x==='number'&&Number.isFinite(x))return JSON.stringify(x);
 if(Array.isArray(x))return '['+x.map(v=>canonical(v,depth+1)).join(',')+']';
 check(x&&Object.getPrototypeOf(x)===Object.prototype,'IMPORT_VALUE_INVALID');
 return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k],depth+1)).join(',')+'}';
};
const same=(a,b)=>canonical(a)===canonical(b);
const digest=x=>hashAssetBytes(encodeUtf8(canonical(x)));
const roleLimit=role=>role==='checkpoint'?LIMITS.checkpoint:['output','manifest-page'].includes(role)?LIMITS.output:0;
const scalar=(x,min=0)=>Number.isSafeInteger(x)&&x>=min;
// A failed storage read is not evidence that a reservation is unauthorized.
// Preserve transient/recovery control flow so the caller can retry safely.
const reservationLookupFailure=error=>{
 const code=error?.code||error?.message||'';
 if(error?.retryable===true||error?.requiresOwnerAction===true||typeof code==='string'&&(code.endsWith('_YIELD')||code.startsWith('WRITER_RECOVERY_')||['WRITER_REPLAY_BUDGET','WRITER_LOCK_REQUIRED','STORE_LOCK_REQUIRED','WRITER_BUSY'].includes(code)))throw error;
 return false;
};
const timeOrder=(a,b)=>{const seconds=a.slice(0,19).localeCompare(b.slice(0,19));if(seconds)return seconds;const fa=a.slice(19,-1).replace(/^\./,''),fb=b.slice(19,-1).replace(/^\./,''),n=Math.max(fa.length,fb.length);return fa.padEnd(n,'0').localeCompare(fb.padEnd(n,'0'));};
const validTime=t=>typeof t==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(t)&&Number.isFinite(Date.parse(t))&&new Date(Date.parse(t)).toISOString().slice(0,19)===t.slice(0,19);
const outputPoint=line=>{let p;try{p=JSON.parse(line);}catch(_){fail('OUTPUT_POINT_INVALID');}
 check(p&&Object.getPrototypeOf(p)===Object.prototype&&Object.keys(p).every(k=>['time','lat','lon','altitude','speed'].includes(k))&&validTime(p.time)&&typeof p.lat==='number'&&Number.isFinite(p.lat)&&p.lat>=-90&&p.lat<=90&&typeof p.lon==='number'&&Number.isFinite(p.lon)&&p.lon>=-180&&p.lon<=180,'OUTPUT_POINT_INVALID');
 if('altitude' in p)check(typeof p.altitude==='number'&&Number.isFinite(p.altitude)&&p.altitude>=-20000&&p.altitude<=100000,'OUTPUT_POINT_INVALID');
 if('speed' in p)check(p.speed===null||typeof p.speed==='number'&&Number.isFinite(p.speed)&&p.speed>=0&&p.speed<=10000,'OUTPUT_POINT_INVALID');return p;
};
const ref=r=>r?{fileId:r.fileId,sha256:r.sha256,byteLength:r.byteLength}:null;
const safeSource=s=>clone(validateSourceIdentity(s));
const SIMPLE_HEADER=['time','latitude','longitude','altitude','speed'];
const SENSOR_HEADER=['time','gFx','gFy','gFz','ax','ay','az','wx','wy','wz','P(Pa)','Bx(µT)','By(µT)','Bz(µT)','latitude','longitude','altitude','speed','yaw','pitch','roll'];
const cpCounters=cp=>({offset:cp.offset,batch:cp.batch,points:cp.points,normalizedBytes:cp.normalizedBytes,rows:cp.rows,comments:cp.comments,nonIncreasingTimes:cp.nonIncreasingTimes,firstTime:cp.firstTime,lastTime:cp.lastTime,complete:cp.complete});
export const importKeys=Object.freeze({
 job:id=>'import/job/'+id,
 pin:id=>'import/pin/'+id,
 asset:id=>'import/asset/'+digest(id),
 directory:()=> 'import/jobs',
 source:id=>'import/source/'+digest(id),
 identity:key=>'import/identity/'+digest(key),
 content:key=>'import/content/'+digest(key),
 scan:id=>'import/scan/'+id,
 scanPage:(id,n)=>'import/scan-page/'+id+'/'+n,
 run:id=>'run/'+id
});

/**
 * readAsset(reservation) is a server-internal bounded managed asset reader. It
 * must verify private parent/ownership/markers before returning immutable bytes.
 * This binding independently checks byte length and SHA-256. Never pass a public
 * arbitrary-ID media endpoint. validateSourceCurrent must re-read Drive metadata.
 * GC must treat active job.pinActive + linked pin records as roots; a completed
 * run.imported.assetsRoot is the same linked root transferred atomically. Pin
 * entities remain immutable-reference history until coordinated GC retires them.
 */
export class ImportStoreBinding {
 constructor({writer,storeId,readAsset,validateSourceCurrent}) {
  check(writer&&['get','transact','getReceipt','recoveryBarrier'].every(k=>typeof writer[k]==='function')&&token(storeId,100)&&typeof readAsset==='function'&&typeof validateSourceCurrent==='function','IMPORT_STORE_CONFIG');
  this.writer=writer;this.storeId=storeId;this.readAsset=readAsset;this.validateSourceCurrent=validateSourceCurrent;
 }
 recoveryBarrier(){return this.writer.recoveryBarrier();}
 getReceipt(id){return this.writer.getReceipt(id);}
 _entity(key){const e=this.writer.get(key);check(!e?.deleted,'IMPORT_TOMBSTONE');return e;}
 _required(key){const e=this._entity(key);check(e,'IMPORT_ENTITY_MISSING');return e;}
 _change(key,value){check(encodeUtf8(canonical(value)).length<=IMPORT_STORE_LIMITS.entityBytes,'IMPORT_ENTITY_TOO_LARGE');return {key,expectedVersion:this._entity(key)?.version||0,value:clone(value)};}
 _job(id){check(token(id,100),'JOB_ID_INVALID');const e=this._required(importKeys.job(id));check(e.value.storeId===this.storeId&&e.value.jobId===id,'JOB_STORE_MISMATCH');return e;}
 _intent(kind,input){check(token(input?.operationId),'OPERATION_ID_INVALID');const clean=clone(input);return {operationId:input.operationId,epoch:'default',digest:digest({protocol:'mypace-import-domain-v1',storeId:this.storeId,kind,input:clean})};}
 _prior(intent){this.recoveryBarrier();const r=this.getReceipt(intent.operationId);if(r)check(r.digest===intent.digest,'OP_ID_REUSED');return r;}
 _commit(intent,changes,result){const r=this.writer.transact({...intent,changes,result});this.recoveryBarrier();return r;}
 _read(r){
  check(r&&roleLimit(r.role)&&r.storeId===this.storeId,'ASSET_DESCRIPTOR_INVALID');
  const raw=this.readAsset(clone(r));check(raw instanceof Uint8Array&&raw.length===r.byteLength&&raw.length<=roleLimit(r.role)&&hashAssetBytes(raw)===r.sha256,'ASSET_CONTENT_MISMATCH');return raw;
 }
 _json(r){const bytes=this._read(r);let v;try{v=JSON.parse(decodeUtf8(bytes));}catch(_){fail('IMPORT_ASSET_JSON');}return v;}
 _assets(assets,jobId,pinId){
  check(Array.isArray(assets)&&assets.length>=2&&assets.length<=IMPORT_STORE_LIMITS.assets,'IMPORT_BATCH_BOUNDS');
  const ids=new Set();let outputs=0,bytes=0,cps=0,manifests=0;
  const out=assets.map(a=>{
   check(a&&token(a.fileId)&&a.storeId===this.storeId&&a.jobId===jobId&&a.pinId===pinId&&roleLimit(a.role)&&scalar(a.byteLength,1)&&a.byteLength<=roleLimit(a.role)&&/^[a-f0-9]{64}$/.test(a.sha256)&&!ids.has(a.fileId),'RESERVATION_INVALID');
   ids.add(a.fileId);if(a.role==='output'){outputs++;bytes+=a.byteLength;}if(a.role==='checkpoint')cps++;if(a.role==='manifest-page')manifests++;
   return {fileId:a.fileId,storeId:a.storeId,jobId:a.jobId,pinId:a.pinId,role:a.role,byteLength:a.byteLength,sha256:a.sha256};
  });
  check(cps===1&&manifests===1&&outputs<=LIMITS.outputs&&bytes<=LIMITS.totalOutput,'IMPORT_BATCH_BOUNDS');return out;
 }
 _checkpoint(job){
  const cp=job.checkpoint?this._json(job.checkpoint):initialCheckpoint(job.sourceIdentity,{packingVersion:job.packingVersion??0});
  this._checkpointShape(cp,job);
  check(same(cpCounters(cp),job.progress)&&same(cp.previousManifest,ref(job.manifest)),'CHECKPOINT_STATE_MISMATCH');return cp;
 }
 _checkpointShape(cp,job){
  checkpointBytes(cp);
  check(job.packingVersion===undefined||job.packingVersion===1,'CHECKPOINT_PACKING');
  check(cp&&typeof cp==='object'&&!Array.isArray(cp),'CHECKPOINT_SOURCE_MISMATCH');
  checkpointPointLimit(cp);
  check((cp.packingVersion??0)===(job.packingVersion??0),'CHECKPOINT_PACKING_CHANGED');
  check(cp&&cp.schema===1&&cp.parserVersion===PARSER_VERSION&&cp.mappingHash===mappingHash()&&same(cp.source,job.sourceIdentity)&&cp.sourceKey===job.sourceKey,'CHECKPOINT_SOURCE_MISMATCH');
  for(const k of ['offset','batch','points','normalizedBytes','rows','comments','nonIncreasingTimes'])check(scalar(cp[k]),'CHECKPOINT_COUNTER');
  check(typeof cp.complete==='boolean'&&cp.offset<=Number(job.sourceIdentity.size)&&cp.sourceHash?.totalBytes===cp.offset&&cp.normalizedHash?.totalBytes===cp.normalizedBytes,'CHECKPOINT_HASH_OFFSET');
  // Constructor validates SHA compression state and bounded remainder.
  const sh=new IncrementalSha256(cp.sourceHash),nh=new IncrementalSha256(cp.normalizedHash);
  check(cp.offset===0||cp.parser!==null,'PARSER_STATE_REQUIRED');
  if(cp.parser){const p=cp.parser;check(['start','plain','quoted','closed'].includes(p.mode)&&Array.isArray(p.field)&&p.field.length<=65536&&p.field.every(b=>Number.isInteger(b)&&b>=0&&b<=255)&&Array.isArray(p.row)&&p.row.length<=128&&p.row.every(v=>typeof v==='string'&&encodeUtf8(v).length<=65536)&&scalar(p.bytes)&&p.bytes<=262144&&scalar(p.offset)&&typeof p.cr==='boolean'&&typeof p.first==='boolean'&&(p.prefix===null||Array.isArray(p.prefix)&&p.prefix.length<3&&p.prefix.every((b,i)=>b===[239,187,191][i]))&&p.offset+(p.prefix?.length||0)===cp.offset,'PARSER_STATE_INVALID');}
  check(cp.header===null||Array.isArray(cp.header)&&cp.header.length<=128&&cp.header.every(x=>typeof x==='string'&&x.length<=128)&&new Set(cp.header).size===cp.header.length&&['time','latitude','longitude'].every(x=>cp.header.includes(x))&&(cp.header.every(x=>SIMPLE_HEADER.includes(x))||cp.header.length===SENSOR_HEADER.length&&SENSOR_HEADER.every(x=>cp.header.includes(x))),'CHECKPOINT_HEADER');
  check(typeof cp.sawPreamble==='boolean'&&cp.sawPreamble===(cp.comments>0)&&(cp.header===null||cp.sawPreamble)&&cp.rows===cp.points+cp.comments+(cp.header===null?0:1)&&cp.nonIncreasingTimes<=Math.max(0,cp.points-1),'CHECKPOINT_ROW_INVARIANTS');
  check(cp.points===0?cp.firstTime===null&&cp.lastTime===null&&cp.normalizedBytes===0:validTime(cp.firstTime)&&validTime(cp.lastTime),'CHECKPOINT_TIMES');
  if(cp.complete)check(cp.header!==null&&cp.sawPreamble&&cp.parser?.mode==='start'&&cp.parser.field.length===0&&cp.parser.row.length===0&&cp.parser.bytes===0&&cp.offset===Number(job.sourceIdentity.size)&&cp.points>0&&cp.sourceSha256===sh.digestHex()&&cp.normalizedSha256===nh.digestHex(),'CHECKPOINT_COMPLETION');
  else check(cp.offset<Number(job.sourceIdentity.size),'CHECKPOINT_COMPLETION');
 }
 _transition(job,assets,cp,manifest){
  this._checkpointShape(cp,job);
  const old=this._checkpoint(job),c=assets.find(a=>a.role==='checkpoint'),m=assets.find(a=>a.role==='manifest-page'),outs=assets.filter(a=>a.role==='output');
  check(checkpointBytes(cp).length===c.byteLength&&hashAssetBytes(checkpointBytes(cp))===c.sha256,'CHECKPOINT_DESCRIPTOR_MISMATCH');
  const mb=encodeUtf8(JSON.stringify(manifest));check(mb.length===m.byteLength&&hashAssetBytes(mb)===m.sha256,'MANIFEST_DESCRIPTOR_MISMATCH');
  check(manifest&&manifest.schema===1&&manifest.kind==='import-manifest-page'&&manifest.sourceKey===job.sourceKey&&manifest.throughOffset===cp.offset&&same(manifest.previous,ref(job.manifest))&&same(cp.previousManifest,ref(m)),'MANIFEST_LINK_MISMATCH');
  check(cp.offset>old.offset&&cp.offset-old.offset<=LIMITS.range&&!old.complete,'CHECKPOINT_NOT_NEXT');
  check((old.header===null||same(old.header,cp.header)&&cp.comments===old.comments)&&(!old.sawPreamble||cp.sawPreamble),'CHECKPOINT_MAPPING_CHANGED');
  check(Array.isArray(manifest.outputs)&&manifest.outputs.length===outs.length,'MANIFEST_OUTPUTS_MISMATCH');
  let points=0,bytes=0;
  manifest.outputs.forEach((o,i)=>{const a=outs[i];check(o&&o.fileId===a.fileId&&o.sha256===a.sha256&&o.byteLength===a.byteLength&&o.index===old.batch+i&&scalar(o.pointCount,1)&&o.pointCount<=checkpointPointLimit(cp)&&same(Object.keys(o).sort(),['byteLength','fileId','index','pointCount','sha256'].sort()),'MANIFEST_OUTPUTS_MISMATCH');points+=o.pointCount;bytes+=o.byteLength;});
  check(cp.batch===old.batch+outs.length&&cp.points===old.points+points&&cp.normalizedBytes===old.normalizedBytes+bytes&&cp.rows>=old.rows&&cp.comments>=old.comments&&cp.nonIncreasingTimes>=old.nonIncreasingTimes&&(old.firstTime===null||cp.firstTime===old.firstTime),'CHECKPOINT_DELTA_MISMATCH');
  if(!outs.length)check(same(cp.normalizedHash,old.normalizedHash)&&cp.lastTime===old.lastTime,'CHECKPOINT_EMPTY_OUTPUT');
  return {checkpoint:c,manifest:m,progress:cpCounters(cp)};
 }
 registerJob(input){
  const intent=this._intent('register-job',input),prior=this._prior(intent);if(prior)return prior;
  const {jobId}=input;check(token(jobId,100),'JOB_ID_INVALID');const source=safeSource(input.sourceIdentity);check(Number(source.size)>0,'SOURCE_EMPTY');
  const key=sourceKey(source,mappingHash()),ik=importKeys.identity(key),existing=this._entity(ik),sk=importKeys.source(source.id),si=this._entity(sk)?.value;
  if(existing){const priorJob=this._job(existing.value.jobId).value;
   // Every known identity must still be this source's active generation. A
   // historical completed OR duplicate A must not suppress A -> B -> A.
   const current=si?.activeJobId===priorJob.jobId;
   let known=current&&!['cancelled','completed','duplicate'].includes(priorJob.status);
   if(current&&priorJob.status==='completed'){
    const imported=this._entity(importKeys.run(si.runId))?.value.imported;
    known=si.publishedSourceKey===key&&imported?.jobId===priorJob.jobId&&imported?.sourceKey===key;
   }
   if(current&&priorJob.status==='duplicate'&&priorJob.publishedContentKey&&priorJob.duplicateRunId){
    const target=this._entity(importKeys.run(priorJob.duplicateRunId))?.value.imported;
    known=!!(target&&target.parserVersion===PARSER_VERSION&&target.mappingHash===mappingHash()&&priorJob.publishedContentKey===JSON.stringify([target.sourceSha256,target.sourceIdentity?.size,PARSER_VERSION,mappingHash()]));
   }
   // Missing legacy duplicate evidence is re-parsed/reverified through the
   // normal content claim before any new run can become visible.
   if(known)return this._commit(intent,[],{jobId:existing.value.jobId,status:'known'});
  }
  check(!this._entity(importKeys.job(jobId)),'JOB_ID_REUSED');
  if(si?.activeJobId){const active=this._job(si.activeJobId).value;check(['completed','cancelled','duplicate'].includes(active.status),'SOURCE_JOB_ACTIVE');}
  if(si)check(si.mappingHash===mappingHash(),'REPROCESS_REQUIRES_APPROVAL');
  const runId=si?.runId||'drive_'+digest(source.id).slice(0,32),run=this._entity(importKeys.run(runId));
  const cp=initialCheckpoint(source);
  const directory=this._entity(importKeys.directory())?.value||{head:null,count:0};
  const job={schema:1,queueNext:directory.head,storeId:this.storeId,jobId,sourceIdentity:source,sourceKey:key,packingVersion:cp.packingVersion,parserVersion:PARSER_VERSION,mappingHash:mappingHash(),status:'active',pinActive:true,runId,baseImportedDigest:run?digest(run.value.imported??null):null,checkpoint:null,manifest:null,progress:cpCounters(cp),pending:null,firstPin:null,lastPin:null,batchCount:0,finalization:null};
  const changes=[this._change(importKeys.job(jobId),job),this._change(ik,{jobId}),this._change(sk,{sourceId:source.id,mappingHash:mappingHash(),runId,activeJobId:jobId,publishedSourceKey:si?.publishedSourceKey||null}),this._change(importKeys.directory(),{head:jobId,count:directory.count+1})];
  return this._commit(intent,changes,{jobId,status:'active'});
 }
 reserveBatch(input){
  const intent=this._intent('reserve-batch',input),prior=this._prior(intent);if(prior)return prior;
  const {jobId,pinId,batchOperationId,expectedCheckpointId,checkpoint,manifestPage}=input;
  check(token(pinId,100)&&token(batchOperationId),'RESERVATION_INVALID');const job=clone(this._job(jobId).value);
  check(job.status==='active'&&job.pinActive&&!job.pending,'JOB_NOT_RESERVABLE');check((job.checkpoint?.fileId||null)===expectedCheckpointId,'CHECKPOINT_CONFLICT');
  check(!this._entity(importKeys.pin(pinId)),'PIN_ID_REUSED');const assets=this._assets(input.assets,jobId,pinId),transition=this._transition(job,assets,checkpoint,manifestPage);
  const pending={schema:1,storeId:this.storeId,jobId,pinId,batchOperationId,expectedCheckpointId,assets,state:'reserved',previousPin:job.lastPin,nextPin:null,transition};
  job.pending=pinId;
  const changes=[this._change(importKeys.job(jobId),job),this._change(importKeys.pin(pinId),pending)];
  for(const a of assets){check(!this._entity(importKeys.asset(a.fileId)),'ASSET_ID_REUSED');changes.push(this._change(importKeys.asset(a.fileId),{jobId,pinId,fileId:a.fileId}));}
  return this._commit(intent,changes,{jobId,pinId,batchOperationId});
 }
 assertReservation(r){
  try{const job=this._job(r.jobId).value,pin=this._required(importKeys.pin(r.pinId)).value;return job.pinActive===true&&pin.storeId===this.storeId&&pin.jobId===job.jobId&&['reserved','ready'].includes(pin.state)&&pin.assets.some(a=>same(a,r));}catch(error){return reservationLookupFailure(error);}
 }
 assertReadableAsset(fileId,expectedLength,maxBytes){
  try{const index=this._required(importKeys.asset(fileId)).value,pin=this._required(importKeys.pin(index.pinId)).value,job=this._job(index.jobId).value;
   const r=pin.assets.find(a=>a.fileId===fileId);if(!r||r.byteLength!==expectedLength||expectedLength>maxBytes||pin.jobId!==job.jobId||pin.storeId!==this.storeId)return false;
   if(job.pinActive)return ['reserved','ready'].includes(pin.state);
   return job.status==='completed'&&pin.state==='ready'&&this._entity(importKeys.run(job.runId))?.value.imported?.jobId===job.jobId;
  }catch(error){return reservationLookupFailure(error);}
 }
 listJobsPage({cursor=null,limit=16}={}){
  check(cursor===null||token(cursor,100),'JOB_CURSOR_INVALID');check(scalar(limit,1)&&limit<=100,'JOB_PAGE_BOUNDS');
  let id=cursor||this._entity(importKeys.directory())?.value.head||null;const jobs=[];
  while(id&&jobs.length<limit){const job=this._job(id).value;jobs.push({jobId:id,status:job.status,pinActive:job.pinActive,progress:clone(job.progress)});id=job.queueNext;}
  return {jobs,nextCursor:id};
 }
 getJob(jobId){this.recoveryBarrier();return clone(this._job(jobId).value);}
 resumeJob(jobId){
  this.recoveryBarrier();const job=clone(this._job(jobId).value);return {job,checkpoint:this._checkpoint(job),pending:job.pending?clone(this._required(importKeys.pin(job.pending)).value):null};
 }
 validateImportBatch(command,{checkpoint,manifestPage}){
  check(command?.protocol==='mypace-import-batch-v1'&&command.storeId===this.storeId&&token(command.operationId),'IMPORT_COMMAND_INVALID');
  const {digest:given,...base}=command;check(given===digest(base),'IMPORT_COMMAND_DIGEST');
  const job=this._job(command.jobId).value;check(job.pinActive&&job.status==='active'&&job.pending,'JOB_NOT_ACTIVE');
  const pin=this._required(importKeys.pin(job.pending)).value;
  check(pin.state==='reserved'&&pin.batchOperationId===command.operationId&&pin.jobId===job.jobId&&pin.storeId===this.storeId&&same(command.sourceIdentity,job.sourceIdentity)&&(job.checkpoint?.fileId||null)===command.expectedCheckpointId&&pin.expectedCheckpointId===command.expectedCheckpointId,'JOB_RESERVATION_OR_VERSION_INVALID');
  const assets=this._assets(command.assets,job.jobId,pin.pinId);check(same(assets,pin.assets)&&assets.every(a=>this.assertReservation(a)),'JOB_RESERVATION_OR_VERSION_INVALID');
  const transition=this._transition(job,assets,checkpoint,manifestPage);check(same(transition,pin.transition)&&command.completed===checkpoint.complete,'JOB_RESERVATION_OR_VERSION_INVALID');return true;
 }
 commitImportBatch(command,{verifiedAssets}){
  this.recoveryBarrier();const prior=this.getReceipt(command.operationId);if(prior){check(prior.digest===command.digest,'OP_ID_REUSED');return prior;}
  const job=clone(this._job(command.jobId).value),pin=clone(this._required(importKeys.pin(job.pending)).value);
  check(Array.isArray(verifiedAssets)&&verifiedAssets.length===pin.assets.length&&verifiedAssets.every((v,i)=>v.verified===true&&same(Object.fromEntries(Object.entries(v).filter(([k])=>k!=='verified')),pin.assets[i])),'ASSETS_NOT_VERIFIED');
  // A caller-created verified:true cannot authorize commit: managed readback is
  // rechecked here and the actual checkpoint/manifest are revalidated under lock.
  const contents={};for(const a of pin.assets){const bytes=this._read(a);if(a.role!=='output')contents[a.role==='checkpoint'?'checkpoint':'manifestPage']=JSON.parse(decodeUtf8(bytes));}
  this.validateImportBatch(command,contents);check(this.validateSourceCurrent(job.sourceIdentity)===true,'SOURCE_CHANGED');
  pin.state='ready';job.checkpoint=pin.transition.checkpoint;job.manifest=pin.transition.manifest;job.progress=pin.transition.progress;job.pending=null;job.firstPin=job.firstPin||pin.pinId;job.lastPin=pin.pinId;job.batchCount++;if(command.completed)job.status='parsed';
  const changes=[this._change(importKeys.pin(pin.pinId),pin),this._change(importKeys.job(job.jobId),job)];
  if(pin.previousPin){const prev=clone(this._required(importKeys.pin(pin.previousPin)).value);check(prev.state==='ready'&&prev.nextPin===null&&prev.jobId===job.jobId,'PIN_CHAIN_CONFLICT');prev.nextPin=pin.pinId;changes.push(this._change(importKeys.pin(prev.pinId),prev));}
  return this._commit({operationId:command.operationId,epoch:'default',digest:command.digest},changes,{jobId:job.jobId,checkpointId:job.checkpoint.fileId,completed:command.completed});
 }
 beginFinalization(input){
  const intent=this._intent('begin-finalization',input),prior=this._prior(intent);if(prior)return prior;
  const job=clone(this._job(input.jobId).value);check(job.status==='parsed'&&job.pinActive&&!job.pending&&job.firstPin,'JOB_NOT_PARSED');this._checkpoint(job);
  job.status='verifying';job.finalization={cursor:job.firstPin,previousPin:null,previousManifest:null,visited:0,nextOutputIndex:0,points:0,bytes:0,throughOffset:0,firstTime:null,lastTime:null,nonIncreasingTimes:0,hash:new IncrementalSha256().snapshot()};
  return this._commit(intent,[this._change(importKeys.job(job.jobId),job)],{jobId:job.jobId,cursor:job.firstPin});
 }
 verifyNextBatch(input){
  const intent=this._intent('verify-next-batch',input),prior=this._prior(intent);if(prior)return prior;
  const job=clone(this._job(input.jobId).value),f=job.finalization;
  check(job.status==='verifying'&&job.pinActive&&f&&f.cursor===input.expectedCursor&&f.cursor!==null&&f.visited<job.batchCount,'FINALIZATION_CURSOR_CONFLICT');
  this._verifyOneFinalizationBatch(job);
  return this._commit(intent,[this._change(importKeys.job(job.jobId),job)],{jobId:job.jobId,cursor:f.cursor,verified:job.status==='verified'});
 }
 _verifyOneFinalizationBatch(job){
  const f=job.finalization;
  const pin=this._required(importKeys.pin(f.cursor)).value;
  check(pin.state==='ready'&&pin.jobId===job.jobId&&pin.previousPin===f.previousPin,'PIN_CHAIN_CONFLICT');
  const manifest=this._json(pin.transition.manifest),cp=this._json(pin.transition.checkpoint);this._checkpointShape(cp,job);
  check(manifest.schema===1&&manifest.kind==='import-manifest-page'&&manifest.sourceKey===job.sourceKey&&same(manifest.previous,f.previousManifest)&&manifest.throughOffset===cp.offset&&cp.offset>f.throughOffset&&cp.offset-f.throughOffset<=LIMITS.range&&same(cp.previousManifest,ref(pin.transition.manifest)),'MANIFEST_LINK_MISMATCH');
  const outs=pin.assets.filter(a=>a.role==='output');check(manifest.outputs.length===outs.length,'MANIFEST_OUTPUTS_MISMATCH');
  const hash=new IncrementalSha256(f.hash);
  manifest.outputs.forEach((o,i)=>{const a=outs[i];check(o.fileId===a.fileId&&o.sha256===a.sha256&&o.byteLength===a.byteLength&&o.index===f.nextOutputIndex&&scalar(o.pointCount,1)&&o.pointCount<=checkpointPointLimit(cp),'MANIFEST_OUTPUTS_MISMATCH');const bytes=this._read(a),text=decodeUtf8(bytes),lines=text.split('\n');check(text.endsWith('\n')&&lines.length-1===o.pointCount,'OUTPUT_POINT_COUNT');lines.pop();for(const line of lines){const point=outputPoint(line);if(f.firstTime===null)f.firstTime=point.time;if(f.lastTime!==null&&timeOrder(point.time,f.lastTime)<=0)f.nonIncreasingTimes++;f.lastTime=point.time;}hash.update(bytes);f.points+=o.pointCount;f.bytes+=bytes.length;f.nextOutputIndex++;});
  check(f.firstTime===cp.firstTime&&f.lastTime===cp.lastTime&&f.nonIncreasingTimes===cp.nonIncreasingTimes,'FINALIZATION_SUMMARY_MISMATCH');
  check(f.points===cp.points&&f.bytes===cp.normalizedBytes&&f.nextOutputIndex===cp.batch&&hash.digestHex()===new IncrementalSha256(cp.normalizedHash).digestHex(),'FINALIZATION_HASH_OR_COUNT');
  f.hash=hash.snapshot();f.previousPin=pin.pinId;f.previousManifest=ref(pin.transition.manifest);f.throughOffset=cp.offset;f.cursor=pin.nextPin;f.visited++;
  if(f.cursor===null){const final=this._checkpoint(job);check(f.visited===job.batchCount&&pin.pinId===job.lastPin&&same(f.previousManifest,ref(job.manifest))&&f.throughOffset===Number(job.sourceIdentity.size)&&f.points===final.points&&f.bytes===final.normalizedBytes&&hash.digestHex()===final.normalizedSha256,'FINALIZATION_INCOMPLETE');job.status='verified';}
 }
 // Reverify at most four pinned source ranges after a crash. No intermediate
 // run is published, and each asset remains bounded and independently checked.
 verifyNextBatches(input){
  const maxBatches=input.maxBatches??4;check(Number.isSafeInteger(maxBatches)&&maxBatches>=1&&maxBatches<=4,'FINALIZATION_BATCH_LIMIT');
  const intent=this._intent('verify-next-batches',input),prior=this._prior(intent);if(prior)return prior;
  const job=clone(this._job(input.jobId).value),f=job.finalization;
  check(job.status==='verifying'&&job.pinActive&&f&&f.cursor===input.expectedCursor&&f.cursor!==null&&f.visited<job.batchCount,'FINALIZATION_CURSOR_CONFLICT');
  let checked=0;while(job.status==='verifying'&&checked<maxBatches){this._verifyOneFinalizationBatch(job);checked++;}
  return this._commit(intent,[this._change(importKeys.job(job.jobId),job)],{jobId:job.jobId,cursor:f.cursor,verified:job.status==='verified',checked});
 }
 publishCompletedJob(input){
  const intent=this._intent('publish-job',input),prior=this._prior(intent);if(prior)return prior;
  const job=clone(this._job(input.jobId).value);check(['verified','duplicate'].includes(job.status)&&job.pinActive&&!job.pending&&job.finalization?.cursor===null,'JOB_NOT_VERIFIED');
  const cp=this._checkpoint(job);check(this.validateSourceCurrent(job.sourceIdentity)===true,'SOURCE_CHANGED');
  const contentKey=JSON.stringify([cp.sourceSha256,job.sourceIdentity.size,PARSER_VERSION,mappingHash()]),ck=importKeys.content(contentKey),existing=this._entity(ck)?.value;
  const claimedRun=existing?this.writer.get(importKeys.run(existing.runId)):null,claimed=claimedRun&&!claimedRun.deleted?claimedRun.value.imported:null;
  const liveDuplicate=claimed&&claimed.sourceSha256===cp.sourceSha256&&claimed.sourceIdentity?.size===job.sourceIdentity.size&&claimed.parserVersion===PARSER_VERSION&&claimed.mappingHash===mappingHash();
  if(existing&&existing.runId!==job.runId&&liveDuplicate){job.status='duplicate';job.duplicateRunId=existing.runId;job.publishedContentKey=contentKey;return this._commit(intent,[this._change(importKeys.job(job.jobId),job)],{jobId:job.jobId,status:'duplicate',duplicateRunId:existing.runId});}
  const rk=importKeys.run(job.runId),run=this._entity(rk);check((run?digest(run.value.imported??null):null)===job.baseImportedDigest,'OWNER_IMPORT_CONFLICT');
  const sk=importKeys.source(job.sourceIdentity.id),source=this._required(sk).value;check(source.activeJobId===job.jobId,'SOURCE_JOB_CONFLICT');
  const imported={schema:1,jobId:job.jobId,sourceKey:job.sourceKey,sourceIdentity:job.sourceIdentity,originalManaged:false,parserVersion:PARSER_VERSION,mappingHash:mappingHash(),sourceSha256:cp.sourceSha256,normalizedSha256:cp.normalizedSha256,sampleCount:cp.points,normalizedBytes:cp.normalizedBytes,firstTime:cp.firstTime,lastTime:cp.lastTime,nonIncreasingTimes:cp.nonIncreasingTimes,manifest:ref(job.manifest),assetsRoot:job.firstPin,checkpoint:ref(job.checkpoint),statistics:'samples-only-no-distance'};
  const value=run?{...clone(run.value),imported}:{id:job.runId,source:'drive-import',imported,owner:{}};
  job.status='completed';job.pinActive=false;job.publishedContentKey=contentKey;delete job.duplicateRunId;
  const changes=[this._change(rk,value),this._change(importKeys.job(job.jobId),job),this._change(ck,{runId:job.runId,jobId:job.jobId,sourceSha256:cp.sourceSha256}),this._change(sk,{...source,publishedSourceKey:job.sourceKey})];
  // Transfer the same linked asset root to the run in this exact frame. No
  // intermediate unpin exists, and owner-only fields are copied from latest run.
  return this._commit(intent,changes,{jobId:job.jobId,status:'completed',runId:job.runId});
 }
 cancelJob(input){
  const intent=this._intent('cancel-job',input),prior=this._prior(intent);if(prior)return prior;
  const job=clone(this._job(input.jobId).value);check(job.pinActive&&job.status!=='completed','JOB_NOT_CANCELLABLE');
  // The ordered writer frame fences every earlier command before unpin. GC still
  // needs its own retained-root/quarantine protocol; cancellation does not delete.
  job.status='cancelled';job.pinActive=false;return this._commit(intent,[this._change(importKeys.job(job.jobId),job)],{jobId:job.jobId,status:'cancelled'});
 }
 beginScan(input){
  const intent=this._intent('begin-scan',input),prior=this._prior(intent);if(prior)return prior;check(token(input.scanId,100),'SCAN_ID_INVALID');const key=importKeys.scan(input.scanId);check(!this._entity(key),'SCAN_ID_REUSED');
  const state={schema:1,scanId:input.scanId,folderId:SOURCE_FOLDER_ID,pageToken:null,nextPage:0,pendingPage:null,pendingIndex:0,done:false,restarts:0};
  return this._commit(intent,[this._change(key,state)],state);
 }
 getScan(scanId){check(token(scanId,100),'SCAN_ID_INVALID');return clone(this._required(importKeys.scan(scanId)).value);}
 recordScanPage(input){
  const intent=this._intent('record-scan-page',input),prior=this._prior(intent);if(prior)return prior;
  const state=this.getScan(input.scanId);check(!state.done&&state.pendingPage===null&&state.pageToken===input.expectedPageToken&&state.nextPage===input.expectedPage,'SCAN_CURSOR_CONFLICT');
  check(Array.isArray(input.files)&&input.files.length<=IMPORT_STORE_LIMITS.scanFiles,'SCAN_PAGE_BOUNDS');
  const validToken=t=>t===null||typeof t==='string'&&t.length>0&&t.length<=4096&&!/[\0\r\n]/.test(t);
  check(validToken(input.nextPageToken)&&(input.nextPageToken===null||input.nextPageToken!==state.pageToken),'SCAN_TOKEN_INVALID');
  const page={schema:1,scanId:input.scanId,page:state.nextPage,files:input.files.map(safeSource),nextPageToken:input.nextPageToken};
  check(encodeUtf8(canonical(page)).length<=IMPORT_STORE_LIMITS.scanPageBytes,'SCAN_PAGE_BOUNDS');
  state.pendingPage=state.nextPage++;state.pendingIndex=0;state.pageToken=input.nextPageToken;
  if(page.files.length===0){state.pendingPage=null;state.done=input.nextPageToken===null;}
  return this._commit(intent,[this._change(importKeys.scanPage(input.scanId,page.page),page),this._change(importKeys.scan(input.scanId),state)],{scanId:input.scanId,page:page.page,done:state.done});
 }
 nextScanEntry(scanId){const state=this.getScan(scanId);if(state.pendingPage===null)return null;const page=this._required(importKeys.scanPage(scanId,state.pendingPage)).value;return {page:state.pendingPage,index:state.pendingIndex,sourceIdentity:clone(page.files[state.pendingIndex])};}
 acknowledgeScanEntry(input){
  const intent=this._intent('acknowledge-scan-entry',input),prior=this._prior(intent);if(prior)return prior;
  const state=this.getScan(input.scanId);check(state.pendingPage===input.expectedPage&&state.pendingIndex===input.expectedIndex,'SCAN_CURSOR_CONFLICT');
  const page=this._required(importKeys.scanPage(input.scanId,state.pendingPage)).value,source=page.files[state.pendingIndex];
  // A page position can advance only once its exact content identity has a
  // durable job. A crash between registration and acknowledgement is deduped.
  check(this._entity(importKeys.identity(sourceKey(source,mappingHash()))),'SCAN_JOB_NOT_DURABLE');
  state.pendingIndex++;if(state.pendingIndex===page.files.length){state.pendingPage=null;state.pendingIndex=0;state.done=state.pageToken===null;}
  return this._commit(intent,[this._change(importKeys.scan(input.scanId),state)],{scanId:input.scanId,done:state.done});
 }
 restartScan(input){
  const intent=this._intent('restart-scan',input),prior=this._prior(intent);if(prior)return prior;const state=this.getScan(input.scanId);check(state.pendingPage===null&&!state.done&&state.pageToken===input.expectedPageToken&&state.nextPage===input.expectedPage,'SCAN_CURSOR_CONFLICT');state.pageToken=null;state.restarts++;
  return this._commit(intent,[this._change(importKeys.scan(input.scanId),state)],{scanId:input.scanId,page:state.nextPage});
 }
}
