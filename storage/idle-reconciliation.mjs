// Read-only completion reconciliation. CacheService holds a short-lived throttle,
// never jobs, pagination progress, app data, source snapshots, or authority.
import {encodeUtf8} from './codec.mjs';
import {hashAssetBytes} from './immutable-assets.mjs';
import {mappingHash} from './bounded-import.mjs';
import {PARSER_VERSION,sourceKey} from './import-core.mjs';
import {importKeys} from './import-store.mjs';
import {validateSourceIdentity} from './transport.mjs';
const hash=x=>hashAssetBytes(encodeUtf8(JSON.stringify(x)));
const terminal=s=>['completed','duplicate','cancelled'].includes(s);
export const RECONCILIATION_LIMITS=Object.freeze({pages:4,sources:128,jobs:32,additionalCalls:48,maxThrottleMs:3600000});
function value(writer,key){const e=writer.get(key);if(e?.deleted)throw Error('IMPORT_TOMBSTONE');return e?.value;}
export function importDirectoryVersion(writer){const e=writer.get(importKeys.directory());if(e?.deleted)throw Error('IMPORT_TOMBSTONE');return e?.version||0;}
// Every lookup uses the current committed roots under the one script lock.
// Historical identity records alone cannot suppress an A -> B -> A replacement.
export function sourceIsCurrentlySettled(writer,input){
 const source=validateSourceIdentity(input),key=sourceKey(source,mappingHash());
 const si=value(writer,importKeys.source(source.id));
 if(!si||si.sourceId!==source.id||si.mappingHash!==mappingHash()||!si.activeJobId)return false;
 const job=value(writer,importKeys.job(si.activeJobId));
 if(!job||job.sourceKey!==key||job.parserVersion!==PARSER_VERSION||job.mappingHash!==mappingHash())return false;
 if(job.status==='completed'){
  const imported=value(writer,importKeys.run(si.runId))?.imported;
  return si.publishedSourceKey===key&&imported?.sourceKey===key&&imported?.jobId===job.jobId&&imported?.parserVersion===PARSER_VERSION&&imported?.mappingHash===mappingHash();
 }
 if(job.status==='duplicate'&&job.duplicateRunId){
  const imported=value(writer,importKeys.run(job.duplicateRunId))?.imported;
  return !!(imported&&job.publishedContentKey&&job.publishedContentKey===JSON.stringify([imported.sourceSha256,imported.sourceIdentity?.size,PARSER_VERSION,mappingHash()])&&imported.parserVersion===PARSER_VERSION&&imported.mappingHash===mappingHash());
 }
 return false;
}
export function completedQueueIsSettled({writer,store,state,canContinue=()=>true}){
 const version=importDirectoryVersion(writer);
 if(Number.isSafeInteger(state.completedDirectoryVersion)&&state.completedDirectoryVersion===version)return true;
 // Older completed scheduler records have no completion certificate. Verify a
 // bounded queue; a longer/unfinished queue goes through durable orchestration.
 let cursor=null,checked=0;
 do{if(!canContinue())return false;const page=store.listJobsPage({cursor,limit:1});if(page.jobs.some(job=>!terminal(job.status)))return false;checked+=page.jobs.length;cursor=page.nextCursor;}while(cursor&&checked<RECONCILIATION_LIMITS.jobs);
 return cursor===null;
}
export function reconcileCompletedSources({writer,source,deadlineMs,canContinue=()=>true,cursor=null,now=()=>Date.now()}){
 let state=cursor?.phase==='scan'?{...cursor}:{phase:'scan',pageToken:null,index:0,pageHash:null,checkedAt:0},checked=0;
 for(let n=0;n<RECONCILIATION_LIMITS.pages;n++){
  if(!canContinue())return {unchanged:false,reason:'continue',cursor:state,checked};
  let page;
  try{page=source.listPage({pageToken:state.pageToken,deadlineMs});}
  catch(error){if(error?.code==='PAGE_TOKEN_REJECTED')return {unchanged:false,reason:'continue',cursor:{phase:'scan',pageToken:null,index:0,pageHash:null,checkedAt:0},checked};throw error;}
  const pageHash=hash([page.files,page.nextPageToken]);
  // A resumed page may have changed ordering/membership. Never skip its prefix
  // unless the exact bounded page fingerprint still matches.
  if(state.pageHash!==pageHash)state.index=0;
  state.pageHash=pageHash;
  for(let i=state.index;i<page.files.length;i++){
   if(checked>=RECONCILIATION_LIMITS.sources||!canContinue())return {unchanged:false,reason:'continue',cursor:state,checked};
   checked++;if(!sourceIsCurrentlySettled(writer,page.files[i]))return {unchanged:false,reason:'source-work',checked};
   state.index=i+1;
  }
  if(page.nextPageToken===null)return {unchanged:true,checked,cursor:{phase:'complete',pageToken:null,index:0,pageHash:null,checkedAt:now()}};
  state={phase:'scan',pageToken:page.nextPageToken,index:0,pageHash:null,checkedAt:0};
 }
 return {unchanged:false,reason:'continue',cursor:state,checked};
}
export function createIdleScanThrottle(globals,config,{now,intervalMs}){
 // Actual server/script and pinned store identifiers only. No event input, URL,
 // source identity, filename, row, OAuth material, or arbitrary cache key.
 const scope=['mypace-idle-scan-v1',globals.ScriptApp.getScriptId(),config.writerScriptId,config.storeId,config.anchorId,config.datasetGeneration||'1'];
 const key='mypace-idle-'+hash(scope),duration=Math.min(intervalMs,RECONCILIATION_LIMITS.maxThrottleMs);
 const access=()=>{try{const c=globals.CacheService?.getScriptCache?.();return c&&['get','put','remove'].every(k=>typeof c[k]==='function')?c:null;}catch(_){return null;}};
 const clear=()=>{try{access()?.remove(key);}catch(_){/* Advisory eviction may fail. Current durable head still fences it. */}};
 const get=head=>{
  if(duration<1)return null;
  try{const raw=access()?.get(key);if(typeof raw!=='string'||raw.length>512)return null;const c=JSON.parse(raw),t=now();
   if(Object.keys(c).sort().join(',')!=='checkedAt,headHash,revision,schema'||c.schema!==1||c.headHash!==head.headHash||c.revision!==head.revision||!Number.isSafeInteger(c.checkedAt)||c.checkedAt<0||c.checkedAt>t||t-c.checkedAt>=duration)return null;
   return c.checkedAt+duration;
  }catch(_){return null;}
 };
 const remember=(head,checkedAt=now())=>{if(duration<1)return;try{access()?.put(key,JSON.stringify({schema:1,headHash:head.headHash,revision:head.revision,checkedAt}),Math.max(1,Math.ceil(duration/1000)));}catch(_){/* A miss repeats bounded authoritative reads. */}};
 return Object.freeze({get,remember,clear});
}
