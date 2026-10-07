// Authenticated dispatcher read adapter. Cursors must be authenticated by the
// trusted caller; no Drive file ID or checkpoint reference is accepted from UI.
import {importKeys} from './import-store.mjs';
import {decodeUtf8,encodeUtf8} from './codec.mjs';
import {LIMITS} from './bounded-import.mjs';
const ROUTE_POINTS=1024,ROUTE_BYTES=262144,ROUTE_HEADROOM=32768;
import {deriveImportBudgetWait,OWNER_LIMITS} from './owner-scheduler.mjs';
const fail=c=>{throw Error(c);};
const token=(x,max=100)=>typeof x==='string'&&x.length>0&&x.length<=max&&/^[A-Za-z0-9_-]+$/.test(x);
const scalar=(x,min=0)=>Number.isSafeInteger(x)&&x>=min;
const validTime=t=>typeof t==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(t)&&Number.isFinite(Date.parse(t))&&new Date(Date.parse(t)).toISOString().slice(0,19)===t.slice(0,19);
const record=x=>x&&Object.getPrototypeOf(x)===Object.prototype;
function point(line){let p;try{p=JSON.parse(line);}catch(_){fail('IMPORT_ROUTE_INVALID');}
 if(!record(p)||!Object.keys(p).every(k=>['time','lat','lon','altitude','speed'].includes(k))||!validTime(p.time)||typeof p.lat!=='number'||!Number.isFinite(p.lat)||p.lat< -90||p.lat>90||typeof p.lon!=='number'||!Number.isFinite(p.lon)||p.lon< -180||p.lon>180)fail('IMPORT_ROUTE_INVALID');
 if('altitude' in p&&(typeof p.altitude!=='number'||!Number.isFinite(p.altitude)||p.altitude< -20000||p.altitude>100000))fail('IMPORT_ROUTE_INVALID');
 if('speed' in p&&p.speed!==null&&(typeof p.speed!=='number'||!Number.isFinite(p.speed)||p.speed<0||p.speed>10000))fail('IMPORT_ROUTE_INVALID');return p;
}
export function createImportReader({runtime,sealCursor,openCursor,now=()=>Date.now()}){
 if(!runtime?.writer||!runtime?.store||typeof runtime.locked!=='function'||typeof sealCursor!=='function'||typeof openCursor!=='function'||typeof now!=='function')fail('IMPORT_READER_CONFIG');
 const {writer,store,locked}=runtime;
 const entity=key=>{const e=writer.get(key);if(!e||e.deleted)fail('IMPORT_READ_NOT_FOUND');return e.value;};
 function revision(expected){store.recoveryBarrier();const r=writer.status().revision;if(!scalar(r))fail('IMPORT_REVISION_INVALID');if(expected!==undefined&&expected!==null&&expected!==r)fail('CURSOR_REVISION_CHANGED');return r;}
 function cursor(value,kind,r){if(value===null)return null;if(typeof value!=='string'||value.length===0||value.length>4096)fail('IMPORT_CURSOR_INVALID');let c;try{c=openCursor(value);}catch(_){fail('IMPORT_CURSOR_INVALID');}if(!record(c)||c.kind!==kind)fail('IMPORT_CURSOR_INVALID');if(c.revision!==r)fail('CURSOR_REVISION_CHANGED');return c;}
 function published(runId,i,job){
  if(!record(i)||!token(i.jobId)||!token(i.assetsRoot)||!record(job)||job.storeId!==store.storeId||job.jobId!==i.jobId||job.status!=='completed'||job.pinActive!==false||job.runId!==runId||job.firstPin!==i.assetsRoot||!token(job.lastPin)||!scalar(job.batchCount,1))fail('IMPORT_RUN_NOT_PUBLISHED');
 }
 function status({revision:expected}={}){return locked(()=>{
  const r=revision(expected),entry=writer.get('import/owner-scheduler');
  if(!entry||entry.deleted)return {revision:r,status:'idle',retryAt:0,error:null,lastJob:null,processingMode:'idle',allowanceMs:null,requiresOwnerAction:false};
  const s=entry.value;if(!record(s)||s.schema!==1||!['idle','scanning','importing','retry','blocked','complete'].includes(s.status)||!scalar(s.retryAt)||s.error!==null&&!(typeof s.error==='string'&&/^[A-Z0-9_]{1,80}$/.test(s.error)))fail('IMPORT_STATUS_INVALID');
  let lastJob=null;if(s.lastJob!==null&&s.lastJob!==undefined){
   const j=s.lastJob,p=j?.progress;if(!record(j)||!['active','parsed','verifying','verified','duplicate','completed','cancelled'].includes(j.status)||!record(p))fail('IMPORT_STATUS_INVALID');
   const progress={};for(const k of ['offset','batch','points','normalizedBytes','rows','comments','nonIncreasingTimes']){if(!scalar(p[k]))fail('IMPORT_STATUS_INVALID');progress[k]=p[k];}
   for(const k of ['firstTime','lastTime']){if(p[k]!==null&&!validTime(p[k]))fail('IMPORT_STATUS_INVALID');progress[k]=p[k];}
   if(typeof p.complete!=='boolean')fail('IMPORT_STATUS_INVALID');progress.complete=p.complete;lastJob={status:j.status,progress};
  }
  const mode=s.status==='blocked'?'paused':['idle','complete'].includes(s.status)?'idle':s.processingMode??'check';
  if(!['check','catch-up','oversized-resume','recovery','paused','idle'].includes(mode)||s.allowanceMs!==undefined&&s.allowanceMs!==null&&(!scalar(s.allowanceMs,1)||s.allowanceMs>120000))fail('IMPORT_STATUS_INVALID');
  let budgetWait=null;
  if(['scanning','importing','retry'].includes(s.status)&&s.buckets!==undefined){
   const profile=s.budgetProfile??{calls:s.processingMode?750:OWNER_LIMITS.calls,checkMs:s.processingMode?60000:OWNER_LIMITS.runtimeMs,catchUp:!!s.processingMode,catchUpMs:OWNER_LIMITS.runtimeMs};
   if(!record(profile)||typeof profile.catchUp!=='boolean'||!scalar(profile.checkMs,1)||profile.checkMs>120000||!scalar(profile.catchUpMs,1)||profile.catchUpMs>120000)fail('IMPORT_STATUS_INVALID');
   let allowance=profile.checkMs;
   if(profile.catchUp&&(s.status==='importing'||s.resumeStatus==='importing')){
    const next=store.listJobsPage({cursor:s.cursor??null,limit:1}).jobs[0];
    if(next&&!['completed','duplicate','cancelled'].includes(next.status))allowance=profile.catchUpMs;
   }else if(s.processingMode==='oversized-resume'||s.processingMode==='recovery')allowance=s.allowanceMs??profile.catchUpMs;
   try{budgetWait=deriveImportBudgetWait(s.buckets,{nowMs:now(),calls:profile.calls,runtimeMs:allowance});}catch(_){fail('IMPORT_STATUS_INVALID');}
  }
  return {revision:r,status:budgetWait?'budget-wait':s.status,retryAt:budgetWait?Math.max(s.retryAt,budgetWait.retryAt):s.retryAt,error:s.error,lastJob,processingMode:mode,allowanceMs:s.allowanceMs??null,requiresOwnerAction:s.status==='blocked'};
 });}
 function listImportedRuns({cursor:encoded=null,revision:expected}={}){return locked(()=>{
  const r=revision(expected),c=cursor(encoded,'imports',r);if(c&&!token(c.jobId))fail('IMPORT_CURSOR_INVALID');
  const page=store.listJobsPage({cursor:c?.jobId||null,limit:16}),runs=[];
  for(const item of page.jobs){if(item.status!=='completed')continue;const job=entity(importKeys.job(item.jobId)),run=entity(importKeys.run(job.runId)),i=run.imported;
   if(i?.jobId!==job.jobId)continue;published(job.runId,i,job);
   if(!token(job.runId)||!scalar(i.sampleCount,1)||!validTime(i.firstTime)||!validTime(i.lastTime)||typeof i.normalizedSha256!=='string'||!/^[a-f0-9]{64}$/.test(i.normalizedSha256))fail('IMPORT_RUN_INVALID');
   runs.push({id:job.runId,kind:'imported-run',sampleCount:i.sampleCount,firstTime:i.firstTime,lastTime:i.lastTime,normalizedSha256:i.normalizedSha256,statistics:'samples-only-no-distance',routeAvailable:true});
  }
  return {revision:r,runs,nextCursor:page.nextCursor?sealCursor({kind:'imports',revision:r,jobId:page.nextCursor}):null};
 });}
 function readRoutePage({runId,cursor:encoded=null,revision:expected}={}){return locked(()=>{
  if(!token(runId))fail('IMPORT_RUN_INVALID');const r=revision(expected),run=entity(importKeys.run(runId)),i=run.imported;
  if(!i||!token(i.jobId)||!token(i.assetsRoot))fail('IMPORT_READ_NOT_FOUND');
  const job=entity(importKeys.job(i.jobId));published(runId,i,job);
  const c=cursor(encoded,'route',r);if(c&&(c.runId!==runId||c.jobId!==i.jobId||!token(c.pinId)||!scalar(c.output)||c.output>63||(c.pointOffset!==undefined&&(!scalar(c.pointOffset)||c.pointOffset>=LIMITS.points))||!scalar(c.pinIndex)||c.pinIndex>=job.batchCount||!(c.previousPin===null||token(c.previousPin))))fail('IMPORT_CURSOR_INVALID');
  const pinId=c?.pinId||i.assetsRoot,pinIndex=c?.pinIndex||0,pin=entity(importKeys.pin(pinId));
  if(pin.state!=='ready'||pin.pinId!==pinId||pin.jobId!==i.jobId||pin.storeId!==store.storeId||pin.previousPin!==(c?c.previousPin:null)||!Array.isArray(pin.assets)||pin.assets.length<2||pin.assets.length>66||pin.nextPin!==null&&!token(pin.nextPin)||pinIndex===0&&pinId!==i.assetsRoot||pinIndex===job.batchCount-1&&(pin.nextPin!==null||pinId!==job.lastPin)||pinIndex<job.batchCount-1&&(pin.nextPin===null||pin.nextPin===pinId))fail('IMPORT_ROUTE_PIN_INVALID');
  if(pin.assets.some(a=>!record(a)||!['output','checkpoint','manifest-page'].includes(a.role))||pin.assets.filter(a=>a.role==='checkpoint').length!==1||pin.assets.filter(a=>a.role==='manifest-page').length!==1)fail('IMPORT_ROUTE_PIN_INVALID');
  const outputs=pin.assets.filter(a=>a.role==='output'),index=c?.output||0;
  if(outputs.length>64||new Set(outputs.map(a=>a.fileId)).size!==outputs.length||outputs.some(a=>!token(a.fileId,128)||a.jobId!==i.jobId||a.pinId!==pinId||a.storeId!==store.storeId||!scalar(a.byteLength,1)||a.byteLength>262144||typeof a.sha256!=='string'||!/^[a-f0-9]{64}$/.test(a.sha256)))fail('IMPORT_ROUTE_PIN_INVALID');
  if(index>=outputs.length&&!(outputs.length===0&&index===0))fail('IMPORT_CURSOR_INVALID');
  const offset=c?.pointOffset??0;let points=[],withinOutput=false,nextOffset=0;
  if(outputs.length){
   const bytes=store._read(outputs[index]);if(bytes.length>LIMITS.output)fail('IMPORT_ROUTE_BOUND');
   const text=decodeUtf8(bytes);if(!text.endsWith('\n'))fail('IMPORT_ROUTE_INVALID');
   const lines=text.slice(0,-1).split('\n');if(lines.length>LIMITS.points)fail('IMPORT_ROUTE_BOUND');
   if(offset>=lines.length)fail('IMPORT_CURSOR_INVALID');
   // Validate the whole bounded immutable asset, while returning one small page.
   // The signed offset is meaningful only inside this revision/run/pin/output.
   const all=lines.map(point);let pageBytes=2;
   for(let n=offset;n<all.length&&points.length<ROUTE_POINTS;n++){
    const size=encodeUtf8(JSON.stringify(all[n])).length+(points.length?1:0);
    if(pageBytes+size>ROUTE_BYTES-ROUTE_HEADROOM)break;
    points.push(all[n]);pageBytes+=size;
   }
   if(!points.length)fail('IMPORT_ROUTE_BOUND');
   nextOffset=offset+points.length;withinOutput=nextOffset<all.length;
  }else if(offset!==0)fail('IMPORT_CURSOR_INVALID');
  const more=withinOutput||index+1<outputs.length,nextPin=more?pin.pinId:pin.nextPin;
  if(nextPin!==null&&!token(nextPin))fail('IMPORT_ROUTE_PIN_INVALID');
  const nextCursor=nextPin?sealCursor({kind:'route',revision:r,runId,jobId:i.jobId,pinId:nextPin,output:withinOutput?index:more?index+1:0,pointOffset:withinOutput?nextOffset:0,pinIndex:more?pinIndex:pinIndex+1,previousPin:more?pin.previousPin:pinId}):null;
  // 32 KiB also covers worst-case JSON escaping of a 4,096-character cursor.
  if(nextCursor!==null&&(typeof nextCursor!=='string'||!nextCursor.length||nextCursor.length>4096))fail('IMPORT_CURSOR_INVALID');
  const result={revision:r,runId,points,nextCursor};
  if(encodeUtf8(JSON.stringify(result)).length>ROUTE_BYTES)fail('IMPORT_ROUTE_BOUND');
  return result;
 });}
 return Object.freeze({status,listImportedRuns,readRoutePage});
}
