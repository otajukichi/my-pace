// Owner-editor only. No web handler, timer, trigger installer, or ambient work.
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {createDriveChangeDiscovery,DRIVE_CHANGE_KEY,DRIVE_CHANGE_LIMITS,driveChangeTokenInput} from './drive-change-discovery.mjs';
import {createGasDriveChangeHints} from './drive-change-hints.mjs';
import {createGasDailyMaterializer} from './daily-gas-runtime.mjs';
import {DAILY_ALGORITHM} from './daily-calculator.mjs';
import {encodeUtf8} from './codec.mjs';
import {hashAssetBytes} from './immutable-assets.mjs';
import {importKeys} from './import-store.mjs';
import {createDiscoveryStateIO} from './discovery-state.mjs';
import {RECONCILIATION_LIMITS,importDirectoryVersion,completedQueueIsSettled,reconcileCompletedSources,createIdleScanThrottle} from './idle-reconciliation.mjs';
const KEY='import/owner-scheduler';
const hash=x=>hashAssetBytes(encodeUtf8(JSON.stringify(x)));
const fail=c=>{throw Error(c);};
export const OWNER_LIMITS=Object.freeze({runtimeMs:120000,calls:2000,steps:16,rollingRuntimeMs:3600000,rollingCalls:12000});
// Read-only estimate from durable work reservations. This is not an account-wide
// quota meter. Choose the first expiry that can admit the specified profile.
export function deriveImportBudgetWait(buckets,{nowMs,calls,runtimeMs,limits=OWNER_LIMITS}={}){
 if(!Number.isSafeInteger(nowMs)||nowMs<0||!Number.isSafeInteger(calls)||calls<1||calls>limits.calls||!Number.isSafeInteger(runtimeMs)||runtimeMs<1||runtimeMs>limits.runtimeMs||!Array.isArray(buckets)||buckets.length>32)fail('OWNER_BUDGET_STATE_INVALID');
 const hour=Math.floor(nowMs/3600000),active=[];let previous=-1;
 for(const b of buckets){if(!b||!Number.isSafeInteger(b.hour)||b.hour<0||b.hour<=previous||b.hour>hour||!Number.isSafeInteger(b.calls)||b.calls<0||!Number.isSafeInteger(b.ms)||b.ms<0)fail('OWNER_BUDGET_STATE_INVALID');previous=b.hour;if(b.hour>=hour-24)active.push(b);}
 let reservedCalls=active.reduce((n,b)=>n+b.calls,0),reservedMs=active.reduce((n,b)=>n+b.ms,0);
 if(!Number.isSafeInteger(reservedCalls)||!Number.isSafeInteger(reservedMs))fail('OWNER_BUDGET_STATE_INVALID');
 const fits=()=>reservedCalls+calls<=limits.rollingCalls&&reservedMs+runtimeMs<=limits.rollingRuntimeMs;
 if(fits())return null;
 for(const b of active){reservedCalls-=b.calls;reservedMs-=b.ms;if(fits())return {retryAt:(b.hour+25)*3600000};}
 fail('OWNER_BUDGET_STATE_INVALID');
}
// Counts actual external requests, including transport retries. Budget checks
// cannot interrupt an already running service call or bound its buffered body.
export function meteredGas(globals,{now=()=>Date.now(),limits=OWNER_LIMITS,reserveMs=0,reserveCalls=0,deadlineMs}={}){
 const start=now();const absoluteCeiling=Math.min(start+limits.runtimeMs,deadlineMs??Infinity);let hardDeadline=absoluteCeiling;
 if(!Number.isSafeInteger(hardDeadline)||!Number.isSafeInteger(reserveMs)||reserveMs<0||reserveMs>=limits.runtimeMs||!Number.isSafeInteger(reserveCalls)||reserveCalls<0||reserveCalls>=limits.calls)fail('OWNER_BUDGET_INVALID');
 let calls=0,closed=false,closing=false,ceiling=limits.calls;
 const allowed=()=>{const t=now();return !closed&&Number.isSafeInteger(t)&&t>=start&&calls<(closing?ceiling:ceiling-reserveCalls)&&t<(closing?hardDeadline:hardDeadline-reserveMs);};
 const call=fn=>function(...args){if(!allowed())fail('OWNER_BUDGET_YIELD');calls++;return fn(...args);};
 const Files={};for(const key of ['get','list','create','generateIds','update'])Files[key]=call((...a)=>globals.Drive.Files[key](...a));
 const Changes={};for(const key of ['getStartPageToken','list','watch'])if(typeof globals.Drive.Changes?.[key]==='function')Changes[key]=call((...a)=>globals.Drive.Changes[key](...a));
 const fetchAll=typeof globals.UrlFetchApp.fetchAll==='function'?requests=>{if(!Array.isArray(requests)||!requests.length||!allowed()||calls+requests.length>(closing?ceiling:ceiling-reserveCalls))fail('OWNER_BUDGET_YIELD');calls+=requests.length;return globals.UrlFetchApp.fetchAll(requests);}:globals.UrlFetchApp.fetchAll;
 return {globals:{...globals,Drive:{...globals.Drive,Files,...(globals.Drive.Changes?{Changes}:{})},UrlFetchApp:{...globals.UrlFetchApp,fetch:call((...a)=>globals.UrlFetchApp.fetch(...a)),...(fetchAll===undefined?{}:{fetchAll})},now},checkBudget:allowed,get deadlineMs(){return hardDeadline-reserveMs;},get hardDeadlineMs(){return hardDeadline;},setRuntimeMs:(ms,headroomMs=reserveMs)=>{if(!Number.isSafeInteger(ms)||!Number.isSafeInteger(headroomMs)||headroomMs<0||ms<=headroomMs||ms>limits.runtimeMs||closing)fail('OWNER_BUDGET_INVALID');reserveMs=headroomMs;hardDeadline=Math.min(start+ms,absoluteCeiling);},usage:()=>({calls,elapsedMs:Math.max(0,now()-start)}),limitRemaining:n=>{if(!Number.isSafeInteger(n)||n<0)fail('OWNER_BUDGET_INVALID');ceiling=Math.min(ceiling,calls+n);closing=true;return ceiling;},close:()=>{closed=true;}};
}
export function createOwnerScheduler(globals,config,{now=()=>Date.now(),limits=OWNER_LIMITS,deadlineMs,scanIntervalMs=0,reserveMs,scheduledPolicy,settleCalls=256}={}){
 if(!Number.isSafeInteger(settleCalls)||settleCalls<16||settleCalls>256)fail('OWNER_SETTLE_CALLS_INVALID');
 if(!Number.isSafeInteger(scanIntervalMs)||scanIntervalMs<0||scanIntervalMs>86400000)fail('OWNER_SCAN_INTERVAL_INVALID');
 for(const k of Object.keys(OWNER_LIMITS))if(!Number.isSafeInteger(limits[k])||limits[k]<1||limits[k]>OWNER_LIMITS[k])fail('OWNER_LIMITS_INVALID');
 // Manual work also needs enough closing time for the final durable status
 // and a quiescent checkpoint, even when a service call is slow.
 reserveMs=reserveMs??(scheduledPolicy?Math.min(15000,Math.floor(limits.runtimeMs/8)):Math.min(30000,Math.floor(limits.runtimeMs/4))); 
 if(!Number.isSafeInteger(reserveMs)||reserveMs<0||reserveMs>limits.runtimeMs/2)fail('OWNER_RESERVE_INVALID');
 if(scheduledPolicy&&(!Number.isSafeInteger(scheduledPolicy.sliceMs)||scheduledPolicy.sliceMs<30000||scheduledPolicy.sliceMs>60000||!Number.isSafeInteger(scheduledPolicy.rangeBytes)||scheduledPolicy.rangeBytes<1||scheduledPolicy.rangeBytes>1048576||(!Number.isSafeInteger(scheduledPolicy.maxFreshOutputs)||scheduledPolicy.maxFreshOutputs<1||scheduledPolicy.maxFreshOutputs>64)||scheduledPolicy.maxStalls!==3||(scheduledPolicy.catchUp!==undefined&&typeof scheduledPolicy.catchUp!=='boolean')||limits.runtimeMs!==OWNER_LIMITS.runtimeMs||reserveMs>=scheduledPolicy.sliceMs))fail('OWNER_SCHEDULED_POLICY_INVALID');
 const meter=meteredGas(globals,{now,limits,deadlineMs,reserveMs,reserveCalls:Math.min(settleCalls,Math.floor(limits.calls/2))});
 if(scheduledPolicy&&!scheduledPolicy.catchUp)meter.setRuntimeMs(scheduledPolicy.sliceMs);
 const runtime=createGasImportRuntime(meter.globals,{...config,sourceSubtree:true,checkBudget:meter.checkBudget,deadlineMs:scheduledPolicy?undefined:meter.deadlineMs,protocolReadCache:{mode:'lock-phase'}});
 const {writer,store,runner,source,locked}=runtime;
 const idleThrottle=createIdleScanThrottle(globals,config,{now,intervalMs:scanIntervalMs});
 const discovery=createDiscoveryStateIO(meter.globals,config,{checkBudget:meter.checkBudget,now});
 const read=()=>{store.recoveryBarrier();return writer.get(KEY);};
 const write=(entry,value,label)=>{
  const version=entry?.version||0;const digest=hash(value);
  writer.transact({operationId:'sched_'+hash([version,label,digest]),epoch:'default',digest,changes:[{key:KEY,expectedVersion:version,value}],result:{status:value.status}});
  return {version:version+1,value};
 };
 const initial=()=>({schema:1,generation:0,status:'idle',scanId:null,cursor:null,queueStarted:false,cycleActive:false,attempt:0,retryAt:0,error:null,lastJob:null,completedAt:null,buckets:[]});
 const view=s=>({status:s.status,scanId:s.scanId,nextJob:s.cursor,retryAt:s.retryAt,error:s.error,lastJob:s.lastJob||null,completedAt:s.completedAt??null,discovery:s.discovery||null,daily:s.daily||null,nextScanAt:s.status==='complete'&&Number.isSafeInteger(s.completedAt)?s.completedAt+scanIntervalMs:null,reservedCalls:s.buckets.reduce((n,b)=>n+b.calls,0),reservedRuntimeMs:s.buckets.reduce((n,b)=>n+b.ms,0),usage:meter.usage(),...(scheduledPolicy?{scheduledFallback:s.scheduledFallback||null,requiresOwnerAction:s.status==='blocked',processingMode:s.status==='blocked'?'paused':['idle','complete'].includes(s.status)?'idle':s.processingMode||'check',allowanceMs:s.allowanceMs??null}:{} )});
 function status(){return locked(()=>{const e=read();return view(e?.value||initial());});}
 function blockDiscovery(entry,s,code){
  idleThrottle.clear();s.resumeStatus='complete';s.status='blocked';s.error=code;s.retryAt=0;s.processingMode='paused';write(entry,s,'discovery-blocked');
  return {...view(s),requiresOwnerAction:true,reconciliation:'blocked',discoveryError:code,errorPersisted:true};
 }
 function run(startNew){return locked(()=>{
  let entry=read(),s=entry?.value||initial();
  if(s.schema!==1)fail('OWNER_STATE_SCHEMA');
  if(startNew!=='tick')idleThrottle.clear();
  const automatic=startNew==='tick',dailyState=automatic?writer.get('daily/owner-scheduler')?.value:null,dailyEnabled=dailyState?.enabled===true;
  let deltaState=automatic?writer.get(DRIVE_CHANGE_KEY)?.value:null,deltaEnabled=deltaState?.enabled===true,delta=null,hints=null,hintState=null;
  if(deltaEnabled){
   const secret=globals.PropertiesService.getScriptProperties().getProperty('MYPACE_WRITER_SECRET');
   if(typeof secret!=='string'||secret.length<32)fail('DRIVE_CHANGE_SECRET_REQUIRED');
   const channelToken=id=>globals.Utilities.base64EncodeWebSafe(globals.Utilities.computeHmacSha256Signature(driveChangeTokenInput(config.storeId,id),secret,globals.Utilities.Charset.UTF_8)).replace(/=+$/,'');
   hints=createGasDriveChangeHints(globals,{config,channelToken,now});hintState=hints.read();
   if(!hintState.enabled)return {...view(s),status:'paused',processingMode:'paused',requiresOwnerAction:true,error:'DRIVE_CHANGE_ACTIVATION_INCOMPLETE'};
   delta=createDriveChangeDiscovery({runtime,Drive:meter.globals.Drive,config,now,canContinue:meter.checkBudget,randomId:()=>globals.Utilities.getUuid(),channelToken,hints});
   const checkedAt=hintState.cursor?.baseCursor===deltaState.cursor?hintState.cursor.checkedAt:deltaState.lastReconciledAt;
   if(s.status==='complete'&&!deltaState.queue.length&&!deltaState.folders.length&&(hintState.pending||deltaState.pending||now()-checkedAt>=DRIVE_CHANGE_LIMITS.intervalMs)){
    // Classify before any Drive-backed reservation. Irrelevant/self changes
    // advance only authenticated ScriptProperties and cannot notify Drive.
    const before=meter.usage(),reservation=hints.reserve(s.buckets,{calls:limits.calls,ms:limits.runtimeMs,limits});
    if(!reservation)return {...view(s),status:'budget-wait',retryAt:now()+3600000};
    try{for(let page=0;page<16&&meter.checkBudget()&&meter.usage().calls-before.calls<96&&meter.usage().elapsedMs-before.elapsedMs<15000;page++){const classified=delta.tick({hintsOnly:true});if(classified.classified||classified.requiresOwnerAction||!classified.hintPending)break;}}finally{const after=meter.usage();hints.settle(reservation,{calls:after.calls-before.calls,ms:after.elapsedMs-before.elapsedMs});}
    deltaState=writer.get(DRIVE_CHANGE_KEY)?.value;hintState=hints.read();
   }
  }
  if(deltaEnabled&&deltaState.error&&s.status==='complete'&&s.discovery?.error===deltaState.error)return {...view(s),status:'blocked',requiresOwnerAction:true,error:deltaState.error};
  const lastDeltaCheck=hintState?.cursor&&hintState.cursor.baseCursor===deltaState?.cursor?hintState.cursor.checkedAt:deltaState?.lastReconciledAt;

  // Read-only idle ticks do not reserve/write a new job just to discover that
  // the fifteen-minute fallback is not due. Notifications persist pending=true.
  if(deltaEnabled&&s.status==='complete'&&!deltaState.pending&&!deltaState.queue.length&&!deltaState.folders.length&&now()<lastDeltaCheck+DRIVE_CHANGE_LIMITS.intervalMs&&(deltaState.watchPending||deltaState.channels.some(c=>c.expiresAt-now()>DRIVE_CHANGE_LIMITS.renewBeforeMs))&&(!dailyEnabled||dailyState.status==='complete'&&dailyState.algorithm===DAILY_ALGORITHM&&s.dailySourceRevision===(writer.get('daily/source-revision')?.version||0))&&s.completedDiscoveryVersion===(writer.get(DRIVE_CHANGE_KEY)?.version||0)&&s.completedDirectoryVersion===importDirectoryVersion(writer))return {...view(s),nextScanAt:lastDeltaCheck+DRIVE_CHANGE_LIMITS.intervalMs};
  const enhanced=deltaEnabled||dailyEnabled;
  if(enhanced){
   // Discovery and preparation share this scheduler's durable quota reservation.
   // An enabled delta cursor replaces full-folder periodic rescans.
   if(['idle','complete'].includes(s.status)){
    startNew=!deltaEnabled&&(s.status==='idle'||!Number.isSafeInteger(s.completedAt)||now()>=s.completedAt+scanIntervalMs);
    if(!startNew){s.status='importing';s.cursor=null;s.queueStarted=false;s.cycleActive=false;}
   }else startNew=false;
  }
  if(startNew==='tick'){
   if(scheduledPolicy&&s.status==='complete'){
    const before=meter.usage(),canReconcile=()=>meter.checkBudget()&&meter.usage().calls-before.calls<RECONCILIATION_LIMITS.additionalCalls&&meter.usage().elapsedMs-before.elapsedMs<Math.floor(scheduledPolicy.sliceMs/4);
    if(!completedQueueIsSettled({writer,store,state:s,canContinue:canReconcile})){
     // A newly queued/manual unfinished job cannot be hidden by a completed
     // timestamp or CacheService. Resume the authoritative queue immediately.
     idleThrottle.clear();s.status='importing';s.cursor=null;s.queueStarted=false;s.cycleActive=false;startNew=false;
    }else{
     const head=writer.status(),cachedNextScanAt=idleThrottle.get(head);
     if(cachedNextScanAt!==null)return {...view(s),nextScanAt:cachedNextScanAt,reconciliation:'cached-idle'};
     if(Number.isSafeInteger(s.completedAt)&&now()<s.completedAt+scanIntervalMs)return view(s);
     let reconciled,cursor=null;
     if(discovery){
      try{cursor=discovery.read(head);}catch(error){
       const rawCode=error?.code||error?.message,code=/^[A-Z0-9_]{1,80}$/.test(rawCode)?rawCode:'DISCOVERY_STATE_READ_UNRESOLVED';
       if(['WRITER_RECOVERY_PENDING','WRITER_RECOVERY_SETUP_REQUIRED'].includes(code))throw error;
       if(error?.retryable===true||['OWNER_BUDGET_YIELD','STORE_YIELD'].includes(code))return {...view(s),reconciliation:'deferred',discoveryError:code,retryable:true,retryAt:now()+900000};
       // A permission/identity/ownership failure is new actionable state. Save
       // exactly one blocked status so the app cannot keep reporting a healthy
       // completed import forever. Further ticks read it without more writes.
       return blockDiscovery(entry,s,code);
      }
      if(cursor?.phase==='complete'&&now()<cursor.checkedAt+scanIntervalMs){idleThrottle.remember(head,cursor.checkedAt);return {...view(s),nextScanAt:cursor.checkedAt+scanIntervalMs,reconciliation:'recorded-idle'};}
     }
     try{reconciled=reconcileCompletedSources({writer,source,deadlineMs:meter.deadlineMs,canContinue:canReconcile,cursor,now});}
     catch(error){
      // A rejected/expired listing token or inconclusive read is not a proof of
      // completion. The durable bounded scanner retains the normal retry path.
      const code=error?.code||error?.message;
      if(['PAGE_TOKEN_REJECTED','PAGE_TOKEN_STALLED','TRANSPORT_YIELD','OWNER_BUDGET_YIELD','STORE_YIELD'].includes(code))reconciled={unchanged:false,reason:'continue',cursor:cursor?.phase==='scan'?cursor:{phase:'scan',pageToken:null,index:0,pageHash:null,checkedAt:0}};
      else reconciled={unchanged:false,reason:'source-work'};
     }
     if(reconciled.unchanged||reconciled.reason==='continue'&&discovery){
      let discoverySaved=false;
      if(discovery)try{discovery.write(head,reconciled.cursor);discoverySaved=true;}catch(error){
       // A lost successful response is resolved using one bounded authenticated
       // read of this exact fixed ID, head and cursor, never a replacement ID.
       try{const observed=discovery.read(head);discoverySaved=!!observed&&Object.keys(reconciled.cursor).every(key=>observed[key]===reconciled.cursor[key]);}catch(_){/* No proof of saved progress. */}
       if(!discoverySaved){const rawCode=error?.code||error?.message,code=/^DISCOVERY_STATE_[A-Z0-9_]{1,60}$/.test(rawCode)?rawCode:'DISCOVERY_STATE_WRITE_UNRESOLVED';return blockDiscovery(entry,s,code);}
      }
      if(reconciled.unchanged)idleThrottle.remember(head);
      return {...view(s),nextScanAt:reconciled.unchanged?now()+scanIntervalMs:now(),reconciliation:reconciled.unchanged?'unchanged':'scanning',checkedSources:reconciled.checked||0,...(discovery?{discoverySaved}:{})};
     }
     // New/changed source work enters the existing durable pipeline. Legacy
     // stores without an authenticated discovery pin retain bounded scans;
     // only an explicit owner setup can add that fixed mutable advisory file.
     idleThrottle.clear();startNew=true;
    }
   }else{
    if(s.status==='complete'&&Number.isSafeInteger(s.completedAt)&&now()<s.completedAt+scanIntervalMs)return view(s);
    startNew=['idle','complete'].includes(s.status);
   }
  }
  if(startNew&&['scanning','importing','retry','blocked'].includes(s.status))return view(s);
  if(!startNew&&['idle','complete','blocked'].includes(s.status))return view(s);
  if(!startNew&&now()<s.retryAt)return view(s);
  // A durable queued job may select the owner-approved catch-up profile. Idle
  // and new-scan checks stay short. Existing oversized reservations keep their
  // exact bytes/IDs and one finishing step. The selected full allowance and
  // no-progress attempt are both reserved in Drive BEFORE any import work.
  let runtimeAllowance=scheduledPolicy?scheduledPolicy.sliceMs:limits.runtimeMs,stepAllowance=limits.steps,fallback=null;
  if(scheduledPolicy)s.processingMode='check';
  if(scheduledPolicy&&!startNew&&(s.status==='importing'||s.resumeStatus==='importing')){
   const head=store.listJobsPage({cursor:s.cursor,limit:1}).jobs[0];
   const job=head?writer.get(importKeys.job(head.jobId))?.value:null;
   const pending=job?.pending?writer.get(importKeys.pin(job.pending))?.value:null;
   if(job&&!['completed','duplicate','cancelled'].includes(job.status)){
    const marker=hash([job.jobId,job.status,job.pending,job.progress.offset,job.finalization?.cursor||null]);
    const attempts=s.scheduledStall?.marker===marker?s.scheduledStall.attempts:0;
    if(attempts>=scheduledPolicy.maxStalls){s.resumeStatus=s.status==='retry'?s.resumeStatus:s.status;s.status='blocked';s.error='SCHEDULED_NO_PROGRESS';s.retryAt=0;s.processingMode='paused';write(entry,s,'scheduled-stalled');return view(s);}
    s.scheduledStall={marker,attempts:attempts+1};
    if(scheduledPolicy.catchUp){
     runtimeAllowance=limits.runtimeMs;stepAllowance=OWNER_LIMITS.steps;
     meter.setRuntimeMs(runtimeAllowance,15000);runner.finalizationBatchLimit=4;
     writer.limits.checkpointEvery=16;s.processingMode='catch-up';
    }
   }else s.scheduledStall=null;
   if(pending&&(pending.transition.progress.offset-job.progress.offset>scheduledPolicy.rangeBytes||pending.assets.filter(a=>a.role==='output').length>scheduledPolicy.maxFreshOutputs))fallback={jobId:job.jobId,pinId:pending.pinId,stage:'stage'};
   else if(job?.status==='verifying'&&job.finalization?.cursor){
    const pin=writer.get(importKeys.pin(job.finalization.cursor))?.value;
    if(pin?.assets?.filter(a=>a.role==='output').length>scheduledPolicy.maxFreshOutputs)fallback={jobId:job.jobId,pinId:job.finalization.cursor,stage:'verify'};
   }
   if(fallback){
    s.scheduledFallback={...fallback,attempts:s.scheduledStall.attempts};runtimeAllowance=limits.runtimeMs;meter.setRuntimeMs(runtimeAllowance,5000);runner.finalizationBatchLimit=1;writer.limits.checkpointEvery=4;s.processingMode='oversized-resume';
   }else s.scheduledFallback=null;
  }
  if(scheduledPolicy&&scheduledPolicy.catchUp&&runtimeAllowance===scheduledPolicy.sliceMs){
   // State must be authenticated/recovered before selecting a workload. The
   // bounded cold-recovery phase can need the existing 120s cap on retained
   // history. A rare slow recovery admits only one repair/new-scan step rather
   // than repeatedly starving before it can inspect durable queued work.
   if(meter.usage().elapsedMs+reserveMs>=scheduledPolicy.sliceMs){runtimeAllowance=limits.runtimeMs;stepAllowance=1;s.processingMode='recovery';meter.setRuntimeMs(runtimeAllowance,15000);}
   else meter.setRuntimeMs(runtimeAllowance,reserveMs);
  }
  if(scheduledPolicy)s.allowanceMs=runtimeAllowance;
  s.budgetProfile={calls:limits.calls,checkMs:scheduledPolicy?scheduledPolicy.sliceMs:limits.runtimeMs,catchUp:!!scheduledPolicy?.catchUp,catchUpMs:limits.runtimeMs};
  const hour=Math.floor(now()/3600000);s.buckets=s.buckets.filter(b=>b.hour>=hour-24);
  if(s.buckets.some(b=>b.hour>hour))fail('OWNER_CLOCK_REGRESSED');
  const extraBuckets=(hints?.read().buckets||[]).filter(b=>b.hour>=hour-24);
  const calls=[...s.buckets,...extraBuckets].reduce((n,b)=>n+b.calls,0),ms=[...s.buckets,...extraBuckets].reduce((n,b)=>n+b.ms,0);
  if(calls+limits.calls>limits.rollingCalls||ms+runtimeAllowance>limits.rollingRuntimeMs)return {...view(s),status:'budget-wait',retryAt:(Math.min(...[...s.buckets,...extraBuckets].map(b=>b.hour))+25)*3600000};
  let b=s.buckets.find(b=>b.hour===hour);if(!b){b={hour,calls:0,ms:0};s.buckets.push(b);}b.calls+=limits.calls;b.ms+=runtimeAllowance;
  if(startNew){s.generation++;s.scanId='owner_scan_'+s.generation;s.status='scanning';s.cursor=null;s.queueStarted=false;s.cycleActive=false;s.error=null;s.lastJob=null;s.completedAt=null;}
  else if(s.status==='retry')s.status=s.resumeStatus;
  s.retryAt=0;entry=write(entry,s,'reserve'); // Conservative full reservation survives a hard kill.
  let settled=false;
  const settle=()=>{if(settled)return;settled=true;const ceiling=meter.limitRemaining(settleCalls);b.calls-=limits.calls-ceiling;};
  // Each reservation gets its own quiescent cut. Reusing a scan-only operation
  // ID would replay an old receipt instead of sealing later progress. The cut
  // is authoritative Drive state; the optional hint only accelerates finding it.
  const reservationVersion=entry.version;
  const seal=()=>writer.checkpoint({operationId:'owner_slice_'+hash([s.scanId,reservationVersion]),epoch:'default',digest:hash(['scheduled-quiescent',s.scanId,reservationVersion]),result:{scanId:s.scanId,reservationVersion}});
  const manualSealedView=()=>{
   try{seal();return {...view(s),checkpointReady:true};}
   catch(error){return {...view(s),checkpointReady:false,checkpointError:/^[A-Z0-9_]{1,80}$/.test(error.code||error.message)?error.code||error.message:'CHECKPOINT_PENDING',requiresOwnerAction:true};}
  }; 
  try{
   let discoveryStatus=null,dailyStatus=null;
   if(deltaEnabled){
    const before=meter.usage(),canDiscover=()=>meter.checkBudget()&&meter.usage().calls-before.calls<96&&meter.usage().elapsedMs-before.elapsedMs<15000;
    for(let i=0;i<16&&canDiscover();i++){discoveryStatus=delta.tick();if(discoveryStatus.requiresOwnerAction||discoveryStatus.waitingSource||discoveryStatus.yielded||!discoveryStatus.queued&&!discoveryStatus.folders&&!discoveryStatus.pending)break;}
   }
   if(startNew)store.beginScan({operationId:'owner_begin_'+s.generation,scanId:s.scanId});
   // Repair an interruption after scheduler reservation but before scan creation.
   else if(s.status==='scanning')store.beginScan({operationId:'owner_begin_'+s.generation,scanId:s.scanId});
   for(let n=0;n<(fallback?1:stepAllowance);n++){
    if(!meter.checkBudget())fail('OWNER_BUDGET_YIELD');
    if(s.status==='scanning'){
     runner.stepScan(s.scanId,{deadlineMs:meter.deadlineMs});
     if(store.getScan(s.scanId).done){s.status='importing';s.cursor=null;s.queueStarted=false;s.cycleActive=false;}
    }else{
     store.recoveryBarrier();const page=store.listJobsPage({cursor:s.cursor,limit:1});
     if(!page.jobs.length){s.status='complete';break;}
     const job=page.jobs[0];s.queueStarted=true;
     if(!['completed','duplicate','cancelled'].includes(job.status)){
      s.cycleActive=true;
      if(job.status==='active')runner.stepJob(job.jobId,{deadlineMs:meter.deadlineMs});else runner.finalizeJobStep(job.jobId);
      const observed=store.getJob(job.jobId);s.lastJob={jobId:observed.jobId,status:observed.status,progress:observed.progress};
     }
     s.cursor=page.nextCursor;
     if(s.cursor===null){if(!s.cycleActive){s.status='complete';break;}s.cycleActive=false;s.queueStarted=false;}
    }
    // Runner steps have their own durable/idempotent checkpoints. Persist the
    // scheduler cursor once at the end; a kill replays safe terminal/scan reads.
    s.attempt=0;s.error=null;if(scheduledPolicy)s.scheduledStall=null;if(fallback)s.scheduledFallback=null;
    if(s.status==='complete')break;
   }
   if(dailyEnabled&&meter.checkBudget()){
    const daily=createGasDailyMaterializer(meter.globals,{runtime,config,checkBudget:meter.checkBudget,workBudget:()=>meter.checkBudget()&&now()<meter.deadlineMs-10000,now});
    for(let i=0;i<16&&meter.checkBudget();i++){dailyStatus=daily.tick();if(['complete','blocked','failed','paused'].includes(dailyStatus.status))break;}
   }
   if(enhanced){s.completedDiscoveryVersion=writer.get(DRIVE_CHANGE_KEY)?.version||0;s.dailySourceRevision=writer.get('daily/source-revision')?.version||0;s.discovery=discoveryStatus;s.daily=dailyStatus?{status:dailyStatus.status,error:dailyStatus.error||null}:null;}
   // Seal a quiescent import cut before the final scheduler frame. Cold app
   // reads then replay only the checkpoint publication plus this finish frame.
   if(s.status==='complete'){s.completedDirectoryVersion=importDirectoryVersion(writer);s.completedAt=now();s.error=null;s.attempt=0;s.retryAt=0;if(scheduledPolicy)s.processingMode='idle';}
   settle();if(scheduledPolicy)seal();entry=write(entry,s,'finish');return scheduledPolicy?view(s):manualSealedView();
  }catch(e){
   // Retain the exact scan/job cursor and all pins. Changed/missing sources,
   // unsupported identities and structural faults require owner review.
   const code=e.code||e.message||'OWNER_OPERATION_FAILED';
   if(['WRITER_RECOVERY_PENDING','WRITER_RECOVERY_SETUP_REQUIRED'].includes(code))throw e;
   const retry=e.retryable===true||(code==='RETRY_EXHAUSTED'&&[403,429,500,502,503,504].includes(e.status))||['IMPORT_YIELD','TRANSPORT_YIELD','STORE_YIELD','OWNER_BUDGET_YIELD','RATE_LIMITED','DRIVE_REQUEST_FAILED','WRITER_BUSY'].includes(code);
   s.resumeStatus=s.status;s.status=retry?'retry':'blocked';s.attempt=Math.min(10,s.attempt+1);s.retryAt=retry?now()+Math.min(3600000,1000*2**s.attempt):0;
   s.error=/^[A-Z0-9_]{1,80}$/.test(code)?code:'OWNER_OPERATION_FAILED';
   settle();try{if(scheduledPolicy)seal();entry=write(entry,s,'error');}catch(_){return {...view(s),errorPersisted:false};}
   return {...(scheduledPolicy?view(s):manualSealedView()),errorPersisted:true};
  }
 });}
 // Review acknowledgement retries the same source/cursor. It never discards or
 // cancels a pending generation, adopts a new checksum, or overwrites history.
 function retryBlocked(){return locked(()=>{idleThrottle.clear();let e=read();if(!e||e.value.status!=='blocked')return view(e?.value||initial());const s=e.value;s.status=s.resumeStatus;s.error=null;s.retryAt=0;s.scheduledStall=null;s.scheduledFallback=null;write(e,s,'owner-retry');return view(s);});}
 function restartChangedSource(){return locked(()=>{
  idleThrottle.clear();const e=read();if(!e||e.value.status!=='blocked'||!['SOURCE_CHANGED','SOURCE_NOT_FOUND','SOURCE_JOB_ACTIVE'].includes(e.value.error))fail('OWNER_SOURCE_REVIEW_REQUIRED');
  const s=e.value;let jobId;
  if(s.resumeStatus==='scanning'){
   const next=store.nextScanEntry(s.scanId);if(!next)fail('OWNER_SOURCE_REVIEW_REQUIRED');
   jobId=writer.get(importKeys.source(next.sourceIdentity.id))?.value?.activeJobId;
  }else jobId=store.listJobsPage({cursor:s.cursor,limit:1}).jobs[0]?.jobId;
  if(!jobId)fail('OWNER_SOURCE_REVIEW_REQUIRED');
  const job=store.getJob(jobId);
  if(job.status!=='cancelled')store.cancelJob({operationId:'owner_cancel_'+hash([s.generation,jobId]),jobId});
  s.status='idle';s.error=null;s.retryAt=0;s.cursor=null;
  write(e,s,'owner-cancel-source');return view(s);
 });}
 // Recovery has not established an authoritative app/scheduler snapshot yet.
 // Expose only bounded recovery progress; never synthesize idle/complete state
 // or append a business error frame while this barrier is still pending.
 function recoveryResult(action){
  try{return action();}catch(error){
   const code=error?.code||error?.message;
   if(code==='WRITER_RECOVERY_PENDING')return {status:'recovering',processingMode:'recovery',retryable:true,requiresOwnerAction:false,error:code,indexLinks:error.indexLinks,scannedLinks:error.scannedLinks,cursorPersisted:error.cursorPersisted===true,usage:meter.usage()};
   if(code==='WRITER_RECOVERY_SETUP_REQUIRED')return {status:'blocked',processingMode:'paused',retryable:false,requiresOwnerAction:true,error:code,usage:meter.usage()};
   throw error; // Integrity corruption is not a retry or an empty store.
  }
 }
 return Object.freeze({start:()=>recoveryResult(()=>run(true)),resume:()=>recoveryResult(()=>run(false)),tick:()=>recoveryResult(()=>run('tick')),status:()=>recoveryResult(status),retryBlocked,restartChangedSource});
}
