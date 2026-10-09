import {clone,canonical,diffEntities,entitiesToState,stateToEntities,parseKey} from './entity-codec.js';
import {createIndexedDBStorage} from './cloud-local-storage.js';
import {patchStorage,applyReadDelta} from './cloud-state-patches.js';
import {projectIncremental} from './cloud-projection.js';
import {validCheckpoint,newerMinimum,validatePullPage,continuationFor,mergePullEntries} from './cloud-pull.js';
export {createIndexedDBStorage};
// HTTP 400/409 alone is not evidence of a record conflict. Deployment,
// authentication and storage-integrity errors must retain the original pending
// operation so repair can replay it without inventing a replacement UUID.
const RECORD_CONFLICTS=new Set(['ENTITY_VERSION_CONFLICT','ENTITY_TOMBSTONED','ENTITY_MISSING','ENTITY_DELETE_FORBIDDEN','HABIT_MISSING','HABIT_TYPE_IMMUTABLE','DATASET_GENERATION_MISMATCH','OPERATION_EPOCH_EXPIRED','STORE_ID_MISMATCH','OP_ID_REUSED']);
// A receipt is a typed acknowledgement of this exact queued command. The
// authenticated server owns store/generation; those remain bound to the local
// command and are rechecked inside the eventual local transaction below.
async function commandDigest(command){
 if(typeof globalThis.crypto?.subtle?.digest!=='function')throw Error('RECEIPT_VERIFICATION_UNAVAILABLE');
 let bytes;try{bytes=new TextEncoder().encode(canonical(command));}catch{throw Error('RECEIPT_INVALID');}
 let result;try{result=await globalThis.crypto.subtle.digest('SHA-256',bytes);}catch{throw Error('RECEIPT_VERIFICATION_UNAVAILABLE');}
 if(!(result instanceof ArrayBuffer)||result.byteLength!==32)throw Error('RECEIPT_VERIFICATION_UNAVAILABLE');
 return [...new Uint8Array(result)].map(value=>value.toString(16).padStart(2,'0')).join('');
}
function validateCommandReceipt(receipt,command,expectedDigest){
 const own=(o,key)=>Object.prototype.hasOwnProperty.call(o,key),plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.getPrototypeOf(o)===Object.prototype;
 const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value),positive=value=>Number.isSafeInteger(value)&&value>=1;
 const fields=['operationId','epoch','digest','revision','frameId','frameHash','committedAt','result','entityVersions'];
 if(!plain(receipt)||!fields.every(key=>own(receipt,key))||receipt.operationId!==command.operationId||receipt.epoch!==command.epoch||!hash(receipt.digest)||receipt.digest!==expectedDigest||!positive(receipt.revision)||!id(receipt.frameId)||!hash(receipt.frameHash)||typeof receipt.committedAt!=='string'||receipt.committedAt.length>128||!Number.isFinite(Date.parse(receipt.committedAt)))throw Error('RECEIPT_INVALID');
 const result=receipt.result;
 if(!plain(result)||!['key','version','deleted'].every(key=>own(result,key))||result.key!==command.key||result.version!==command.expectedVersion+1||result.deleted!==command.deleted||own(result,'preparationError')||own(result,'appSeq')&&!positive(result.appSeq))throw Error('RECEIPT_INVALID');
 const versions=receipt.entityVersions;
 if(!Array.isArray(versions)||versions.length<1||versions.length>128||versions.some(value=>!plain(value)||!['key','version','deleted'].every(key=>own(value,key))||typeof value.key!=='string'||!value.key||value.key.length>512||!positive(value.version)||typeof value.deleted!=='boolean')||new Set(versions.map(value=>value.key)).size!==versions.length)throw Error('RECEIPT_INVALID');
 const business=versions.find(value=>value.key==='app/data/'+command.key);
 if(!business||business.version!==result.version||business.deleted!==result.deleted)throw Error('RECEIPT_INVALID');
 return receipt;
}
const blank=()=>({format:1,localRevision:0,store:null,generation:null,epoch:null,revision:null,entities:{},outbox:[],conflicts:[],importedRuns:[],importStatus:null,recordConfirmation:null});
const confirmation=(data,kind)=>({kind,store:data.store,generation:data.generation,epoch:data.epoch,revision:data.revision});
function recordsConfirmed(data){const c=data.recordConfirmation;return !!c&&['receipt','snapshot'].includes(c.kind)&&typeof c.store==='string'&&typeof c.generation==='string'&&typeof c.epoch==='string'&&Number.isSafeInteger(c.revision)&&c.revision>=0&&c.store===data.store&&c.generation===data.generation&&c.epoch===data.epoch&&c.revision===data.revision;}
function projected(data){const values={};for(const [k,e]of Object.entries(data.entities))if(!e.deleted)values[k]=clone(e.value);for(const item of data.outbox){if(item.command.deleted)delete values[item.command.key];else values[item.command.key]=clone(item.command.value);}return entitiesToState(values);}
function nextVersion(data,key){let v=data.entities[key]?.version??0;for(const q of data.outbox)if(q.command.key===key)v=q.command.expectedVersion+1;return v;}
function queue(data,change,uuid){if(!data.generation||!data.epoch)throw Error('CLOUD_NOT_READY');const key=change.key;parseKey(key);if(new TextEncoder().encode(canonical(change.value)).length>120000)throw Error('RECORD_TOO_LARGE_USE_FOLDER_IMPORT');const old=data.outbox.filter(q=>q.command.key===key).at(-1)?.command??data.entities[key];data.outbox.push({command:{operationId:uuid(),epoch:data.epoch,generation:data.generation,store:data.store,key,expectedVersion:nextVersion(data,key),deleted:change.deleted,value:clone(change.value),recreate:!!old?.deleted&&!change.deleted},status:'pending'});}
export function createCloudSync({onChange=()=>{},onRemoteState=()=>{},storage=createIndexedDBStorage(),fetcher=globalThis.fetch?.bind(globalThis),uuid=()=>crypto.randomUUID(),now=()=>Date.now(),random=()=>Math.random(),requestTimeoutMs=null,schedule=(callback,ms)=>setTimeout(callback,ms),cancelSchedule=timer=>clearTimeout(timer),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 storage=patchStorage(storage);
 const activeRequests=new Set(),recoveryWatermarks=new Map();
 let cleaning=null,continuationTimer=null,continuation=null;
 let pullSupport=null,recoveryUsed=false,recoverSupport=null,hydrated=false,projectionRevision=0,projectedRevision=-1,notifiedRevision=-1,projectedCache=null,projectionFull=true,lastPublishedState=null;
 const projectionKeys=new Set();
 let data=blank(),auth={authenticated:false},busy=false,error=null,errorPhase=null,phase=null,started=false,syncing=null,syncAgain=false,locked=false,authGeneration=0,refreshing=null,automaticPaused=false,retryAt=0,retryCount=0,verified=false;
 let importErrors={},importRetryAt=0,importRetryCount=0,importAutomaticPaused=false,idlePollCount=0,nextPollAt=0;
 let dailyOwner=0,dailySession=null;
 let lastFeedback=null,feedbackError=null,maintenanceError=null,maintenanceRetryAt=0,maintenanceRetryCount=0,maintenancePaused=false,maintenanceSupport=null;
 function emit(){
  const feedback=[projectionRevision,auth.authenticated,auth.configured,data.generation,data.outbox.length,data.conflicts.length,busy,phase,error,errorPhase,automaticPaused,retryAt,continuation,verified,recordsConfirmed(data),data.recordConfirmation?.kind,nextPollAt,JSON.stringify(importErrors),importRetryAt,importAutomaticPaused,maintenanceError,maintenanceRetryAt,maintenancePaused,data.importedRuns,data.importStatus];
  if(lastFeedback&&feedback.every((value,index)=>value===lastFeedback[index]))return;
  // Feedback is advisory. A rendering exception must not strand busy before
  // the durable sync try/finally begins or prevent receipt/outbox progress.
  try{onChange({...view(),feedbackError:null});lastFeedback=feedback;feedbackError=null;}catch(e){lastFeedback=null;feedbackError=e?.message||'DISPLAY_FAILED';}
 }
 function currentState(){
  if(!data.generation)return null;
  if(projectedRevision!==projectionRevision){
   try{projectedCache=(!projectionFull&&projectedCache?projectIncremental(projectedCache,data.entities,data.outbox,projectionKeys):null)??projected(data);}
   catch(cause){const failure=Error('CLOUD_STATE_UNDISPLAYABLE');failure.cause=cause;throw failure;}
   projectedRevision=projectionRevision;projectionFull=false;projectionKeys.clear();
  }
  return projectedCache;
 }
 function publishState(){if(!locked&&data.generation&&notifiedRevision!==projectionRevision){const state=currentState();if(state!==lastPublishedState){onRemoteState(state);lastPublishedState=state;}notifiedRevision=projectionRevision;}}
 const automaticBlocked=()=>automaticPaused||now()<retryAt;
 function resetPoll(){idlePollCount=0;nextPollAt=0;}
 function pacePoll(unchanged){idlePollCount=unchanged?Math.min(idlePollCount+1,2):0;const interval=[60000,120000,300000][idlePollCount];nextPollAt=now()+Math.round(interval*(0.9+Math.max(0,Math.min(1,random()))*0.2));}
 function pollBlocked(){if(error)return automaticBlocked();const due=Object.keys(importErrors).length&&!importAutomaticPaused?Math.min(nextPollAt,importRetryAt):nextPollAt;return now()<due;}
 function cancelContinuation(){if(continuationTimer!==null)cancelSchedule(continuationTimer);continuationTimer=null;}
 function clearRetry(){cancelContinuation();continuation=null;automaticPaused=false;retryAt=0;retryCount=0;}
 function scheduleContinuation(){
  cancelContinuation();if(!continuation||locked||!auth.authenticated||automaticPaused)return;
  const generation=authGeneration;
  continuationTimer=schedule(()=>{continuationTimer=null;if(generation===authGeneration&&!locked&&auth.authenticated)void sync({automatic:true});},Math.max(0,retryAt-now()));
  continuationTimer?.unref?.();
 }
 function syncFailed(e,failedPhase){
  verified=false;
  if(e.continuationDelayMs&&!automaticPaused){
   error=null;errorPhase=null;continuation={phase:e.recovery.phase,amount:e.recovery.amount};retryAt=now()+e.continuationDelayMs;return;
  }
  cancelContinuation();continuation=null;error=e.message;errorPhase=failedPhase;retryCount=Math.min(retryCount+1,5);automaticPaused=automaticPaused||e.requiresOwnerAction===true||['WRITER_RECOVERY_SETUP_REQUIRED','SYNC_V2_MIGRATION_REQUIRED','WRITER_FORMAT_FENCE_REQUIRED','WRITER_FORMAT_FENCE_MISSING','INDEXEDDB_VERSION_CHANGED_RELOAD_REQUIRED','INDEXEDDB_BLOCKED_CLOSE_OTHER_TABS'].includes(error);retryAt=automaticPaused?0:now()+Math.min(60000*2**(retryCount-1),900000);}
 const migrationToken=d=>canonical({store:d.store,generation:d.generation,epoch:d.epoch,revision:d.revision,entities:d.entities,outbox:d.outbox,conflicts:d.conflicts});
 const conflictView=(d,c)=>({...clone(c),remote:clone(d.entities[c.key]??null),local:clone(d.outbox.filter(q=>q.command.key===c.key).at(-1)?.command??null),token:canonical({store:d.store,generation:d.generation,epoch:d.epoch,remote:d.entities[c.key]??null,related:d.outbox.filter(q=>q.command.key===c.key),conflict:c})});
 function view(){if(auth.csrf!==dailySession){dailySession=auth.csrf;dailyOwner++;}return {dailyIdentity:auth.authenticated?{owner:auth.cacheScope||dailyOwner,persistent:typeof auth.cacheScope==='string'&&!!auth.cacheScope,store:data.store,generation:data.generation}:null,ready:!!data.generation,authenticated:auth.authenticated,configured:auth.configured!==false,pending:data.outbox.length,conflicts:data.conflicts.map(c=>conflictView(data,c)),busy,phase,error,errorPhase,feedbackError,nextPollAt,automaticPaused,retryAt,continuation,verified,recordsConfirmed:recordsConfirmed(data),confirmationKind:recordsConfirmed(data)?data.recordConfirmation.kind:null,maintenanceError,maintenanceRetryAt,maintenancePaused,revision:data.revision,importErrors:clone(importErrors),importRetryAt,importAutomaticPaused,importedRuns:clone(data.importedRuns),importStatus:clone(data.importStatus)};}
 async function reload({notify=true}={}){
  const wasHydrated=hydrated,sinceVersion=data.localRevision,result=await storage.read(wasHydrated?{sinceVersion}:undefined),read=wasHydrated?result:{kind:'full',data:result,localRevision:result.localRevision};
  // Reads from another callback may finish after a newer transaction has
  // already refreshed this instance. Never move the local view backwards.
  const readVersion=read.localRevision??read.data?.localRevision??0;
  if(hydrated&&readVersion<=data.localRevision){if(notify)publishState();emit();return;}
  const reset=read.kind==='full'||read.meta?.generation!==undefined&&read.meta.generation!==data.generation||read.meta?.store!==undefined&&read.meta.store!==data.store;
  const changed=reset||(read.entitiesPut?.length||read.entitiesDelete?.length||read.outboxPut?.length||read.outboxDelete?.length)>0;
  if(reset){projectionFull=true;projectionKeys.clear();}
  else if(changed&&!projectionFull){
   for(const entity of read.entitiesPut||[])projectionKeys.add(entity.key);
   for(const key of read.entitiesDelete||[])projectionKeys.add(key);
   for(const item of read.outboxPut||[])projectionKeys.add(item.command.key);
   const removed=new Set(read.outboxDelete||[]);for(const item of data.outbox)if(removed.has(item.command.operationId))projectionKeys.add(item.command.key);
  }
  data=applyReadDelta(data,read);data.localRevision=readVersion;hydrated=true;if(changed)projectionRevision++;
  if(notify)publishState();emit();
 }
 async function write(build,generation=null){
  for(let attempt=0;attempt<4;attempt++){
   await reload({notify:false});
   if(generation!==null&&(generation!==authGeneration||locked||!auth.authenticated))throw Error('SESSION_CHANGED');
   const patch=build(data);if(!patch)return;
   try{await storage.apply({...patch,expectedVersion:data.localRevision});await reload({notify:false});return;}
   catch(e){if(e.message!=='LOCAL_STATE_CHANGED'||attempt===3)throw e;}
  }
 }
 function queuePatch(d,changes){const staged={...d,outbox:d.outbox.slice()};for(const change of changes)queue(staged,change,uuid);return {outboxPut:staged.outbox.slice(d.outbox.length)};}
 async function request(path,body,csrf=auth.csrf){
  const generation=authGeneration,controller=new AbortController();activeRequests.add(controller);let timeout;
  try{
   const {response,r}=await Promise.race([
    (async()=>{
     let response;try{response=await fetcher(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',signal:controller.signal,headers:body===undefined?{}:{'Content-Type':'application/json',...(csrf?{'X-MyPace-CSRF':csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}catch{throw Error(generation!==authGeneration?'SESSION_CHANGED':'OFFLINE');}
     let r;try{r=await response.json();}catch{throw Error(generation!==authGeneration?'SESSION_CHANGED':'SERVER_UNAVAILABLE');}return {response,r};
    })(),
    new Promise((_,reject)=>{timeout=setTimeout(()=>{controller.abort();reject(Error('REQUEST_TIMEOUT'));},requestTimeoutMs??(['command','recover','maintain','pull','snapshot'].includes(body?.action)?65000:45000));})
   ]);
   if(generation!==authGeneration)throw Error('SESSION_CHANGED');
   if(!response.ok||r.ok===false){
    const e=Error(r.error||'SERVER_UNAVAILABLE');e.status=response.status;e.retryable=r.retryable===true;e.requiresOwnerAction=r.requiresOwnerAction===true;
    if(['identity-changed','retention-floor','cursor-expired'].includes(r.resetReason))e.resetReason=r.resetReason;
    const progress=r.recovery;
    if(progress?.cursorPersisted===true&&progress.cursorAdvanced===true&&['frames','index','checkpoint','preparation'].includes(progress.phase)){
     const amount=progress.phase==='preparation'?progress.ordinal:progress.phase==='index'?progress.indexLinks:progress.revision;
     if(Number.isSafeInteger(amount)&&amount>0)e.recovery={phase:progress.phase,amount};
    }
    if(response.status===401)auth={authenticated:false};throw e;
   }
   return r;
  }finally{clearTimeout(timeout);activeRequests.delete(controller);}
 }
 async function api(action,payload,generation=authGeneration){
  // Retain high-water marks across retry windows for this exact authenticated
  // request. A repeated phase/ordinal cannot keep resetting failure backoff.
  const scopeKey=canonical([generation,action,payload]);
  let scope=recoveryWatermarks.get(scopeKey);
  if(!scope){scope={amounts:new Map(),rootRevision:0,windowStarted:now(),requests:0};recoveryWatermarks.set(scopeKey,scope);while(recoveryWatermarks.size>8)recoveryWatermarks.delete(recoveryWatermarks.keys().next().value);}
  const startedAt=now();
  for(let attempt=0;;attempt++){
   if(locked||!auth.authenticated||generation!==authGeneration)throw Error('AUTH_REQUIRED');
   if(now()-scope.windowStarted>=600000){scope.windowStarted=now();scope.requests=0;}
   if(scope.requests>=64&&scope.lastProgress){
    const e=Object.assign(Error('WRITER_RECOVERY_PENDING'),{recovery:scope.lastProgress,continuationDelayMs:Math.max(2000,600000-(now()-scope.windowStarted))});throw e;
   }
   const requestStarted=now();scope.requests++;
   try{const result=(await request('/api/sync',{action,payload})).result;recoveryWatermarks.delete(scopeKey);return result;}
   catch(e){
    if(e.message!=='WRITER_RECOVERY_PENDING'||e.requiresOwnerAction||!e.retryable||!e.recovery||[401,403,429].includes(e.status))throw e;
    const {phase:progressPhase,amount}=e.recovery,previous=scope.amounts.get(progressPhase)??0,rootPhase=['frames','checkpoint'].includes(progressPhase),advanced=amount>previous&&(!rootPhase||amount>scope.rootRevision);
    if(advanced){
     scope.amounts.set(progressPhase,amount);scope.lastProgress={phase:progressPhase,amount};
     // Preparation ordinal spaces may restart only after a genuinely newer
     // verified root revision. Phase switching or the same checkpoint cannot
     // erase an earlier high-water mark and manufacture fresh progress.
     if(rootPhase&&amount>scope.rootRevision){scope.rootRevision=amount;scope.amounts.delete('preparation');}
    }
    // Only this response's strictly advancing, persisted marker qualifies.
    // Earlier progress cannot disguise a subsequent stall or quota response.
    if(advanced){continuation={phase:progressPhase,amount};error=null;errorPhase=null;}
    if(progressPhase==='preparation'&&action==='command'){phase='preparation';verified=false;emit();}
    // Bound each burst to eight requests / about one minute. Proven work
    // continues on its own short timer, rather than failure backoff or the
    // UI's minute poll. A sustained fast stream gets a quota-friendly pause.
    const elapsed=Math.max(0,now()-startedAt),requestMs=Math.max(0,now()-requestStarted);
    if(!advanced)throw e;
    if(attempt>=7||elapsed+1000+requestMs>60000||scope.requests>=64){
     const cooling=scope.requests>=64;
     e.continuationDelayMs=cooling?Math.max(2000,600000-(now()-scope.windowStarted)):2000;
     throw e;
    }
    await sleep(1000);
   }
  }
 }
 function compactLocal(){
  if(cleaning||typeof storage.compact!=='function'||locked||!auth.authenticated)return;
  const generation=authGeneration;
  cleaning=(async()=>{
   try{for(;;){
    await sleep(0);if(locked||generation!==authGeneration)return;
    const result=await storage.compact({limit:64});
    if(!result.hasMore||!result.removed&&!result.stagesRemoved)return;
   }}catch{/* Retired-cache cleanup cannot change record/outbox confirmation. */}
  })().finally(()=>{cleaning=null;});
 }
 async function readWithRecovery(action,payload,generation=authGeneration){
  try{return await api(action,payload,generation);}
  catch(original){
   const readDeadline=action==='pull'&&['STORE_READ_UNRESOLVED','STORE_METADATA_UNRESOLVED'].includes(original.message)&&original.retryable===true&&!original.requiresOwnerAction&&![401,403,429].includes(original.status);
   const recoverable=original.message==='STORE_YIELD'||action==='pull'&&original.message==='SYNC_BUDGET_YIELD'||readDeadline;
   if(!recoverable||payload.cursor!==null||recoveryUsed||recoverSupport===false)throw original;
   recoveryUsed=true;phase='recovery';emit();let recovered;
   // The wider bounded request must return the requested page itself. A bare
   // readiness check followed by another cold pull repeats the same work and
   // can starve indefinitely even after recovery reported success.
   try{recovered=await api('recover',action==='pull'?{pull:payload}:{},generation);recoverSupport=true;}
   catch(e){if(['ACTION_INVALID','UNSUPPORTED_ACTION'].includes(e.message)){recoverSupport=false;phase='snapshot';throw original;}throw e;}
   if(action==='pull'){phase='snapshot';emit();return recovered;}
   if(!recovered||recovered.protocol!==2||recovered.ready!==true||typeof recovered.store!=='string'||typeof recovered.generation!=='string'||!Number.isSafeInteger(recovered.revision)||recovered.revision<0||!/^[a-f0-9]{64}$/.test(recovered.headHash)||![0,2].includes(recovered.writerFence))throw Error('RECOVERY_RESPONSE_INVALID');
   await reload({notify:false});checkCut(data,recovered);
   phase='snapshot';emit();return api(action,payload,generation);
  }
 }
 async function init({resume=true}={}){
  if(!resume)lock();else{locked=false;started=true;}
  try{await reload();}catch(e){if(e.message!=='CLOUD_STATE_UNDISPLAYABLE')throw e;error=e.message;errorPhase='local';verified=false;}
  // A retained but undisplayable cache must not prevent a fresh authenticated
  // pull from recovering a corrected cloud state. Never truncate the raw cache.
  if(resume)await refreshSession({automatic:true});
  return {state:currentState(),...view()};
 }
 async function commit(before,candidate){
  if(locked)throw Error('SESSION_LOCKED');const changes=diffEntities(before,candidate);
  if(changes.some(c=>new TextEncoder().encode(canonical(c.value)).length>120000))throw Error('RECORD_TOO_LARGE_USE_FOLDER_IMPORT');
  if(!changes.length)return {ok:true,state:candidate};
  await write(d=>{if(!d.generation)throw Error('CLOUD_NOT_READY');if(canonical(projected(d))!==canonical(before))throw Error('LOCAL_STATE_CHANGED');return queuePatch(d,changes);});
  resetPoll();void sync({automatic:true,changed:true});return {ok:true,state:currentState()};
 }
 async function snapshots(generationScope){let cursor=null,revision=null,generation,epoch,store,syncMeta;const entities={},seen=new Set();for(let page=0;page<20000;page++){const r=await readWithRecovery('snapshot',{cursor,revision},generationScope);if(page===0)syncMeta=r?.syncMeta;if(!r||!Array.isArray(r.entities)||r.entities.length>24||!Number.isSafeInteger(r.revision)||typeof r.store!=='string'||typeof r.generation!=='string'||typeof r.epoch!=='string')throw Error('SNAPSHOT_INVALID');if(revision!==null&&(r.revision!==revision||r.generation!==generation||r.epoch!==epoch||r.store!==store))throw Error('SNAPSHOT_CHANGED');revision=r.revision;generation=r.generation;epoch=r.epoch;store=r.store;for(const e of r.entities){parseKey(e.key);if(Object.hasOwn(entities,e.key)||!Number.isSafeInteger(e.version)||e.version<1||typeof e.deleted!=='boolean')throw Error('SNAPSHOT_INVALID');entities[e.key]=e;}cursor=r.cursor;if(cursor===null)return {entities,revision,generation,epoch,store,syncMeta};if(typeof cursor!=='string'||seen.has(cursor))throw Error('SNAPSHOT_INVALID');seen.add(cursor);}throw Error('SNAPSHOT_TOO_LARGE');}
 function identityConflicts(d,remote){
  if(!d.generation||d.generation===remote.generation&&d.store===remote.store)return {};
  return {outboxPut:d.outbox.map(q=>({...q,status:'conflict'})),conflictsPut:d.outbox.filter(q=>!d.conflicts.some(c=>c.key===q.command.key)).map(q=>({key:q.command.key,error:'DATASET_GENERATION_MISMATCH',operationId:q.command.operationId})).filter((c,i,a)=>a.findIndex(x=>x.key===c.key)===i)};
 }
 function checkCut(d,remote){
  if(d.store===remote.store&&d.generation===remote.generation){
   if((d.revision??0)>remote.revision)throw Error('SYNC_CUT_BEHIND');
   const minimum=newerMinimum(d.minimumAcknowledged,d.minimumObserved);
   if(minimum&&remote.revision<minimum.revision)throw Error('SYNC_CUT_BEHIND');
   if(minimum&&remote.revision===minimum.revision&&remote.headHash&&remote.headHash!==minimum.hash)throw Error('SYNC_PROOF_MISMATCH');
  }
 }
 async function abandonPull({reset=false,identityChanged=false}={},generation){await write(d=>({meta:{syncContinuation:null,...(reset?{syncCheckpoint:null}:{}),...(identityChanged?{identityReset:true}:{})},...(d.snapshotStage?{snapshotDiscard:d.snapshotStage.id}:{})}),generation);}
 async function legacyRecords(generation){
  const {syncMeta,...remote}=await snapshots(generation);
  await write(d=>{checkCut(d,remote);return {...identityConflicts(d,remote),snapshot:{id:uuid(),page:0,entities:Object.values(remote.entities),meta:{},complete:true},meta:{store:remote.store,generation:remote.generation,epoch:remote.epoch,revision:remote.revision,recordConfirmation:confirmation(remote,'snapshot')}};},generation);
  return {syncMeta,unchanged:false};
 }
 async function pullRecords(generation){
  if(pullSupport===false&&data.syncProtocol!==2)return legacyRecords(generation);
  const initialSeq=data.syncCheckpoint?.seq;let resets=0,totalEntries=0;
  for(let pageNumber=0;pageNumber<20000;pageNumber++){
   await reload({notify:false});
   const stage=data.snapshotStage,continuation=stage?.meta??data.syncContinuation??null;
   const minimum=newerMinimum(data.minimumAcknowledged,data.minimumObserved);
   if(continuation&&(minimum?.revision>continuation.revision||(data.revision??0)>continuation.revision)){
    await abandonPull({},generation);if(++resets>2)throw Error('SYNC_CUT_BEHIND');continue;
   }
   const since=continuation?null:validCheckpoint(data.syncCheckpoint)?data.syncCheckpoint:null;
   const requestMinimum=continuation?continuation.minimumAcknowledged??null:data.identityReset?null:minimum?{store:data.store,generation:data.generation,...minimum}:null;
   const payload={cursor:continuation?.cursor??null,since,minimumAcknowledged:requestMinimum};let raw;
   try{raw=await readWithRecovery('pull',payload,generation);}
   catch(e){
    if(['ACTION_INVALID','UNSUPPORTED_ACTION'].includes(e.message)){
     if(data.syncProtocol===2)throw Error('SYNC_DEPLOYMENT_MISMATCH');
     pullSupport=false;return legacyRecords(generation);
    }
    if(['RESET_REQUIRED','SYNC_CUT_BEHIND','SYNC_CURSOR_EXPIRED','CURSOR_EXPIRED'].includes(e.message)&&resets++<2){await abandonPull({reset:e.message==='RESET_REQUIRED'&&e.resetReason!=='cursor-expired',identityChanged:e.message==='RESET_REQUIRED'&&e.resetReason==='identity-changed'},generation);continue;}
    throw e;
   }
   const page=validatePullPage(raw,{since,continuation,minimumAcknowledged:requestMinimum});pullSupport=true;totalEntries+=page.entries.length;
   const syncMeta=continuation?.syncMeta??page.syncMeta??null;
   const next={...continuationFor(page),minimumAcknowledged:requestMinimum,syncMeta};
   const complete=page.nextCursor===null;
   await write(d=>{
    // The final guard is against the latest durable local state, including a
    // receipt or a newer cut applied by another tab while this request ran.
    checkCut(d,page);
    if(continuation){
     const current=d.snapshotStage?.meta??d.syncContinuation;
     if(!current||canonical(current)!==canonical(continuation))throw Error('LOCAL_STATE_CHANGED');
    }else if(d.snapshotStage||d.syncContinuation)throw Error('LOCAL_STATE_CHANGED');
    const meta={syncProtocol:2};
    if(page.mode==='snapshot'){
     if(complete)Object.assign(meta,{store:page.store,generation:page.generation,epoch:page.epoch,revision:page.revision,syncCheckpoint:page.checkpoint,syncContinuation:null,identityReset:false,minimumAcknowledged:d.store===page.store&&d.generation===page.generation?d.minimumAcknowledged??null:null,minimumObserved:newerMinimum(d.store===page.store&&d.generation===page.generation?d.minimumObserved:null,{revision:page.revision,hash:page.headHash}),recordConfirmation:confirmation(page,'snapshot')});
     return {...(complete?identityConflicts(d,page):{}),snapshot:{id:stage?.id??uuid(),page:stage?.nextPage??0,entities:page.entries,meta:next,complete},meta};
    }
    if(d.store!==page.store||d.generation!==page.generation)throw Error('PULL_IDENTITY_CHANGED');
    Object.assign(meta,{epoch:page.epoch,revision:page.revision,syncContinuation:complete?null:next,minimumObserved:newerMinimum(d.minimumObserved,{revision:page.revision,hash:page.headHash}),...(complete?{syncCheckpoint:page.checkpoint,recordConfirmation:confirmation(page,'snapshot')}:{recordConfirmation:null})});
    return {entitiesPut:mergePullEntries(d.entities,page.entries),meta};
   },generation);
   if(complete)return {syncMeta,unchanged:page.mode==='delta'&&page.targetSeq===initialSeq&&totalEntries===0};
  }
  throw Error('PULL_TOO_LARGE');
 }
 async function refreshImports(firstPage,generation){let cursor=null,revision=null;const runs=[],seen=new Set();for(let page=0;page<10000;page++){const r=page===0&&firstPage!==undefined?firstPage:await api('imports',{cursor,revision},generation);if(!r||!Array.isArray(r.runs)||!Number.isSafeInteger(r.revision))throw Error('IMPORT_SNAPSHOT_INVALID');if(revision!==null&&revision!==r.revision)throw Error('CURSOR_REVISION_CHANGED');revision=r.revision;for(const run of r.runs)if(!runs.some(x=>x.id===run.id))runs.push(run);cursor=r.nextCursor;if(cursor===null){await write(()=>({meta:{importedRuns:runs}}),generation);return;}if(typeof cursor!=='string'||seen.has(cursor))throw Error('IMPORT_SNAPSHOT_INVALID');seen.add(cursor);}throw Error('IMPORT_SNAPSHOT_TOO_LARGE');}
 // CSV reads have a separate failure/retry lane. A busy import must not hide a
 // valid records snapshot or prevent later diary edits from being sent.
 async function refreshImportDetails(syncMeta,{automatic,generation}){
  const bundled=syncMeta?.format===1?syncMeta:null;
  if(!bundled&&automatic&&(importAutomaticPaused||now()<importRetryAt))return;
  let failed=false;
  for(const action of ['imports','importStatus']){
   if(generation!==authGeneration||locked||!auth.authenticated)return;
   phase=action;emit();
   try{
    const part=bundled?.[action];let result;
    if(part!==undefined){
     if(!part||typeof part.ok!=='boolean')throw Error('IMPORT_SNAPSHOT_INVALID');
     if(!part.ok){const e=Error(part.error||'SERVER_UNAVAILABLE');e.retryable=part.retryable===true;e.requiresOwnerAction=part.requiresOwnerAction===true;throw e;}
     result=part.result;if(result===undefined)throw Error('IMPORT_SNAPSHOT_INVALID');
    }else if(automatic&&(importAutomaticPaused||now()<importRetryAt))continue;
    else if(action==='importStatus')result=await api(action,{},generation);
    if(action==='imports')await refreshImports(result,generation);
    else{if(!result||typeof result.status!=='string')throw Error('IMPORT_STATUS_INVALID');await write(()=>({meta:{importStatus:result}}),generation);}
    if(generation===authGeneration)delete importErrors[action];
   }catch(e){
    if(generation!==authGeneration)return;
    importErrors[action]=e.message;failed=true;
    importAutomaticPaused=importAutomaticPaused||e.requiresOwnerAction===true||e.message==='WRITER_RECOVERY_SETUP_REQUIRED';
   }
  }
  if(generation!==authGeneration)return;
  if(failed){importRetryCount=Math.min(importRetryCount+1,5);importRetryAt=importAutomaticPaused?0:now()+Math.min(60000*2**(importRetryCount-1),900000);}
  else if(!Object.keys(importErrors).length){importRetryAt=0;importRetryCount=0;importAutomaticPaused=false;}
 }
 // Checkpoint compaction is auxiliary work. One bounded slice only, after
 // confirmed reads and an empty outbox. It never grants a record confirmation.
 async function idleMaintenance(syncMeta,generation,{automatic}){
  const hint=syncMeta?.storageMaintenance;
  if(hint?.due!==true||maintenanceSupport===false||automatic&&(maintenancePaused||now()<maintenanceRetryAt))return;
  await reload({notify:false});
  if(generation!==authGeneration||locked||!auth.authenticated||data.outbox.length||data.conflicts.length||!verified)return;
  phase='maintenance';emit();
  try{
   const r=(await request('/api/sync',{action:'maintain',payload:{}})).result;
   if(!r||r.protocol!==2||r.ready!==true||typeof r.store!=='string'||typeof r.generation!=='string'||!Number.isSafeInteger(r.revision)||r.revision<0||!/^[a-f0-9]{64}$/.test(r.headHash)||![0,2].includes(r.writerFence)||typeof r.maintenance?.due!=='boolean'||!Number.isSafeInteger(r.maintenance.replayFrames)||r.maintenance.replayFrames<0||r.maintenance.softLimit!==16||r.maintenance.hardLimit!==64||r.maintenance.due!==(r.maintenance.replayFrames>=16))throw Error('MAINTENANCE_RESPONSE_INVALID');
   await reload({notify:false});if(generation!==authGeneration||locked)return;if(r.store!==data.store||r.generation!==data.generation)throw Error('MAINTENANCE_IDENTITY_CHANGED');checkCut(data,r);
   maintenanceSupport=true;maintenanceError=null;maintenancePaused=false;maintenanceRetryCount=0;maintenanceRetryAt=r.maintenance.due?now()+60000:0;
  }catch(e){
   if(generation!==authGeneration)return;
   if(['ACTION_INVALID','UNSUPPORTED_ACTION'].includes(e.message)){maintenanceSupport=false;return;}
   maintenanceError=e.message;maintenancePaused=e.requiresOwnerAction===true;
   maintenanceRetryCount=Math.min(maintenanceRetryCount+1,5);
   maintenanceRetryAt=maintenancePaused?0:now()+Math.min(60000*2**(maintenanceRetryCount-1),900000);
  }
 }
 function sync({automatic=false,changed=false}={}){if(syncing){if(changed)syncAgain=true;return syncing;}if(automatic&&automaticBlocked())return Promise.resolve();syncing=(async()=>{do{syncAgain=false;await runSync({automatic});}while(syncAgain&&!locked&&auth.authenticated&&!error&&!continuation);})().finally(()=>{syncing=null;});return syncing;}
 async function runSync({automatic=false}={}){
  if(busy||locked||!auth.authenticated)return;cancelContinuation();const generation=authGeneration;busy=true;recoveryUsed=false;phase='command';emit();let sentCommands=false;
  try{
   for(;;){
    await reload({notify:false});const item=data.outbox.find(q=>q.status==='pending'&&!data.conflicts.some(c=>c.key===q.command.key));if(!item)break;
    try{
     const expectedDigest=await commandDigest(item.command);
     // Hashing yields. Re-read durable intent before transmitting so another
     // tab's retirement/conflict cannot leave this preflight using stale work.
     await reload({notify:false});
     if(locked||!auth.authenticated||generation!==authGeneration)throw Error('SESSION_CHANGED');
     const ready=data.outbox.find(q=>q.command.operationId===item.command.operationId);
     if(!ready||ready.status!=='pending'||data.conflicts.some(c=>c.key===item.command.key))continue;
     if(data.store!==item.command.store||data.generation!==item.command.generation)throw Error('RECEIPT_IDENTITY_CHANGED');
     if(canonical(ready.command)!==canonical(item.command))throw Error('LOCAL_STATE_CHANGED');
     sentCommands=true;const receipt=validateCommandReceipt(await api('command',item.command,generation),item.command,expectedDigest);
     await write(d=>{
      const pending=d.outbox.find(q=>q.command.operationId===item.command.operationId);if(!pending)return null;
      if(d.store!==item.command.store||d.generation!==item.command.generation)throw Error('RECEIPT_IDENTITY_CHANGED');
      if(canonical(pending.command)!==canonical(item.command))throw Error('RECEIPT_INVALID');
      const entity={key:item.command.key,version:receipt.result.version,deleted:item.command.deleted,value:clone(item.command.value)};
      const revision=Math.max(d.revision??0,receipt.revision),minimumAcknowledged=newerMinimum(d.minimumAcknowledged,receipt.frameHash?{revision:receipt.revision,hash:receipt.frameHash}:null);
      return {entitiesPut:mergePullEntries(d.entities,[entity]),outboxDelete:[item.command.operationId],meta:{revision,minimumAcknowledged,recordConfirmation:confirmation({...d,revision},'receipt')}};
     },generation);
    }catch(e){
     if((e.status===409||e.status===400)&&!e.retryable&&!e.requiresOwnerAction&&RECORD_CONFLICTS.has(e.message)){
      await write(d=>{const q=d.outbox.find(q=>q.command.operationId===item.command.operationId);if(!q)return null;return {outboxPut:[{...q,status:'conflict'}],conflictsPut:d.conflicts.some(c=>c.key===item.command.key)?[]:[{key:item.command.key,error:e.message,operationId:item.command.operationId}]};},generation);continue;
     }
     throw e;
    }
   }
   phase='snapshot';emit();const {syncMeta,unchanged}=await pullRecords(generation);
   if(generation===authGeneration){error=null;errorPhase=null;verified=true;clearRetry();}
   if(generation===authGeneration)publishState();emit();
   await refreshImportDetails(syncMeta,{automatic,generation});
   await idleMaintenance(syncMeta,generation,{automatic});
   if(generation===authGeneration){pacePoll(unchanged&&!sentCommands);if(syncMeta?.storageMaintenance?.due&&!maintenancePaused&&maintenanceSupport!==false)nextPollAt=Math.min(nextPollAt,maintenanceRetryAt||now()+60000);}
  }catch(e){if(generation===authGeneration)syncFailed(e,phase);}
  finally{busy=false;phase=null;try{await reload();}catch(e){if(generation===authGeneration){syncFailed(e,'local');emit();}}if(generation===authGeneration){compactLocal();scheduleContinuation();}}
 }
 async function login(){const challenge=await request('/api/auth/challenge',{},null);return challenge;}
 async function completeLogin(credential,csrf,{isCurrent=()=>true}={}){if(!isCurrent())throw Error('SESSION_CHANGED');const generation=authGeneration;const r=await request('/api/auth/login',{credential},csrf);if(generation!==authGeneration||!isCurrent())throw Error('SESSION_CHANGED');if(r.authenticated){locked=false;started=true;auth=r;await sync({changed:true});}if(generation!==authGeneration||!isCurrent())throw Error('SESSION_CHANGED');emit();return r;}
 function lock(){++authGeneration;recoveryWatermarks.clear();for(const request of activeRequests)request.abort();locked=true;started=false;auth={authenticated:false};syncAgain=false;error=null;errorPhase=null;verified=false;importErrors={};importRetryAt=0;importRetryCount=0;importAutomaticPaused=false;maintenanceError=null;maintenanceRetryAt=0;maintenanceRetryCount=0;maintenancePaused=false;resetPoll();clearRetry();emit();}
 async function logout(){const csrf=auth.csrf;lock();await request('/api/auth/logout',{},csrf);}
 function migrationPreview(local){if(!data.generation)throw Error('CLOUD_NOT_READY');const existing=stateToEntities(projected(data)),incoming=stateToEntities(local),add=[],conflicts=[];for(const [key,value]of Object.entries(incoming)){if(!Object.hasOwn(existing,key))add.push({key,value});else if(canonical(existing[key])!==canonical(value))conflicts.push({key,local:clone(value),cloud:clone(existing[key])});}return {add,conflicts,revision:data.revision,token:migrationToken(data)};}
 async function migrate(local,{overwriteKeys=[],expectedPreview}={}){
  if(locked)throw Error('SESSION_LOCKED');const preview=migrationPreview(local),approved=new Set(overwriteKeys);
  if(overwriteKeys.length&&!expectedPreview)throw Error('MIGRATION_APPROVAL_REQUIRED');
  if(expectedPreview&&canonical(expectedPreview)!==canonical(preview))throw Error('MIGRATION_PREVIEW_CHANGED');
  if(overwriteKeys.some(k=>!preview.conflicts.some(x=>x.key===k)))throw Error('MIGRATION_APPROVAL_INVALID');
  await write(d=>{if(migrationToken(d)!==preview.token)throw Error('MIGRATION_PREVIEW_CHANGED');return queuePatch(d,[...preview.add,...preview.conflicts.filter(x=>approved.has(x.key)).map(x=>({key:x.key,value:x.local}))].map(x=>({...x,deleted:false})));});
  publishState();resetPoll();void sync({automatic:true,changed:true});return preview;
 }
 async function resolveConflict(key,choice,expectedConflict){
  if(locked)throw Error('SESSION_LOCKED');if(!['local','remote'].includes(choice))throw Error('RESOLUTION_INVALID');if(!expectedConflict)throw Error('CONFLICT_APPROVAL_REQUIRED');
  const generation=authGeneration;
  if(choice==='local'&&expectedConflict.local?.deleted&&(!expectedConflict.remote||expectedConflict.remote.deleted)){
   // Cached absence (even an old tombstone) is not proof that the conflicting
   // remote value is absent now. Finish old work, abandon any frozen old cut,
   // and obtain a complete fresh cut before retiring a deletion as a no-op.
   if(syncing)await syncing;
   if(generation!==authGeneration||locked)throw Error('SESSION_CHANGED');
   if(!auth.authenticated)throw Error('CONFLICT_REFRESH_REQUIRED');
   await abandonPull({},generation);await sync({changed:true});
   if(generation!==authGeneration||locked)throw Error('SESSION_CHANGED');
   if(!verified||error)throw Error('CONFLICT_REFRESH_REQUIRED');
  }
  await write(d=>{
   const conflict=d.conflicts.find(c=>c.key===key);if(!conflict)throw Error('CONFLICT_MISSING');if(canonical(conflictView(d,conflict))!==canonical(expectedConflict))throw Error('CONFLICT_PREVIEW_CHANGED');
   const related=d.outbox.filter(q=>q.command.key===key),last=related.at(-1),kept=d.outbox.filter(q=>q.command.key!==key);
   // This is an explicit, preview-bound user choice. If both sides already
   // deleted the record, a replacement delete can only fail ENTITY_MISSING.
   // Keep the confirmed tombstone and retire the approved local intent instead.
   const alreadyDeleted=last?.command.deleted&&(!d.entities[key]||d.entities[key].deleted);
   return {...(choice==='local'&&last&&!alreadyDeleted?queuePatch({...d,outbox:kept},[last.command]):{}),outboxDelete:related.map(q=>q.command.operationId),conflictsDelete:[key]};
  });
  publishState();resetPoll();void sync({automatic:true,changed:true});
 }
 async function dailyRun(date,knownHash=null){if(locked||!auth.authenticated)throw Error('AUTH_REQUIRED');return (await request('/api/sync',{action:'dailyRun',payload:{date,knownHash}})).result;}
 function refreshSession({automatic=false,poll=false}={}){
  if(locked||automatic&&(automaticBlocked()||poll&&pollBlocked()))return Promise.resolve();
  if(refreshing)return refreshing;
  if(syncing)return syncing;
  // Visibility, online and timer events share one session check and one sync.
  refreshing=(async()=>{const generation=authGeneration;try{const session=await request('/api/auth/session');if(generation!==authGeneration)return;auth=session;emit();if(auth.authenticated)await sync({automatic});else{verified=false;emit();}}catch(e){if(generation===authGeneration){syncFailed(e,'session');emit();}}})().finally(()=>{refreshing=null;});
  return refreshing;
 }
 const onOnline=()=>{if(started)void refreshSession({automatic:true});};globalThis.addEventListener?.('online',onOnline);
 return {init,commit,sync,refreshSession,login,completeLogin,logout,lock,view,state:currentState,migrationPreview,migrate,resolveConflict,dailyRun,maintenance:()=>cleaning??Promise.resolve(),destroy(){lock();globalThis.removeEventListener?.('online',onOnline);storage.close?.();}};
}
