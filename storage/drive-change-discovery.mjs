// Classic notifications are hints. Classified source queue+cursor progress is
// atomic in the writer. Hints/replay and irrelevant-only cursor progress live
// outside watched Drive, avoiding self-notification feedback.
import {encodeUtf8} from './codec.mjs';
import {hashAssetBytes} from './immutable-assets.mjs';
import {SOURCE_FOLDER_ID,SOURCE_FIELDS} from './transport.mjs';
import {importKeys} from './import-store.mjs';
import {createDriveFolderScope} from './drive-folder-scope.mjs';
export const DRIVE_CHANGE_KEY='import/drive-change-discovery';
export const DRIVE_CHANGE_LIMITS=Object.freeze({pageSize:32,queue:128,folders:128,intervalMs:900000,coalesceMs:60000,channelMs:604800000,renewBeforeMs:86400000});
const hash=x=>hashAssetBytes(encodeUtf8(JSON.stringify(x)));
const clone=x=>JSON.parse(JSON.stringify(x));
const fail=c=>{throw Error(c);};
const validId=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(x);
const token=x=>typeof x==='string'&&x.length>0&&x.length<=4096&&!/[\0\r\n]/.test(x);
const csv=f=>f&&f.trashed===false&&typeof f.name==='string'&&/\.csv$/i.test(f.name)&&typeof f.mimeType==='string'&&!f.mimeType.startsWith('application/vnd.google-apps.');
const folder=f=>f?.mimeType==='application/vnd.google-apps.folder';
const newer=(a,b)=>a.length>b.length||a.length===b.length&&a>b;
export function driveChangeTokenInput(storeId,channelId){return 'mypace-drive-change-v1:'+storeId+':'+channelId;}
export function createDriveChangeDiscovery({runtime,Drive,config,now=()=>Date.now(),canContinue=()=>true,channelToken,randomId,hints}){
 if(!runtime?.writer||typeof runtime.locked!=='function'||!Drive?.Files||!Drive?.Changes||!config?.storeId||typeof channelToken!=='function'||!hints)fail('DRIVE_CHANGE_CONFIG');
 const {writer,store,locked}=runtime,excludedIds=[config.rootParentId,config.metadataParentId,config.assetsParentId].filter(Boolean);
 const contains=createDriveFolderScope({Drive,rootId:SOURCE_FOLDER_ID,excludedIds,canContinue});
 const read=()=>{store.recoveryBarrier();return writer.get(DRIVE_CHANGE_KEY);};
 const save=(entry,s,label)=>{
  if(encodeUtf8(JSON.stringify(s)).length>60000)fail('DRIVE_CHANGE_STATE_CAPACITY');
  const version=entry?.version||0,digest=hash(s);
  writer.transact({operationId:'drive_change_'+hash([version,label,digest]),epoch:'default',digest,changes:[{key:DRIVE_CHANGE_KEY,expectedVersion:version,value:s}],result:{status:s.enabled?'enabled':'paused'}});
  return {version:version+1,value:clone(s)};
 };
 const view=s=>s?{enabled:s.enabled,queued:s.queue.length,folders:s.folders.length,pending:s.pending,lastReconciledAt:s.lastReconciledAt,coverage:s.coverage&&!s.queue.length&&!s.folders.length&&!s.pending,channels:s.channels.length,watchPending:!!s.watchPending,sourceWarnings:(s.warnings||[]).length,sourceWarningOverflow:s.warningOverflow===true,error:s.error||null}: {enabled:false,coverage:false};
 const opts=s=>s.driveId?{driveId:s.driveId,supportsAllDrives:true,includeItemsFromAllDrives:true}:{supportsAllDrives:true,includeItemsFromAllDrives:true};
 function queue(s,id,removed=false){
  if(!validId(id))fail('DRIVE_CHANGE_ID_INVALID');
  const prior=s.queue.find(x=>x.id===id);if(prior){prior.removed=removed;return;}
  if(s.queue.length>=DRIVE_CHANGE_LIMITS.queue)fail('DRIVE_CHANGE_QUEUE_CAPACITY');
  s.queue.push({id,removed,serial:++s.serial});
 }
 function warn(s,id,reason){s.warnings=s.warnings||[];if(s.warnings.some(w=>w.id===id))return;if(s.warnings.length>=32){s.warningOverflow=true;return;}s.warnings.push({id,reason});}
 function addFolder(s,id){s.seenFolders=s.seenFolders||[];if(!s.seenFolders.includes(id)){if(s.seenFolders.length>=128)fail('DRIVE_CHANGE_FOLDER_CAPACITY');s.seenFolders.push(id);}if(!s.folders.some(x=>x.id===id)){if(s.folders.length>=DRIVE_CHANGE_LIMITS.folders)fail('DRIVE_CHANGE_FOLDER_CAPACITY');s.folders.push({id,pageToken:null});}}
 function activate({webhookUrl,driveId=null}={}){return locked(()=>{
  if(typeof webhookUrl!=='string'||!/^https:\/\/[a-zA-Z0-9.-]+\/api\/drive-changes$/.test(webhookUrl)||driveId!==null&&!validId(driveId))fail('DRIVE_CHANGE_ACTIVATION_INVALID');
  const e=read();if(e?.value?.enabled){hints.registry(true,e.value.channels);return view(e.value);}
  if(e){const s=clone(e.value);if(s.webhookUrl!==webhookUrl||s.driveId!==driveId)fail('DRIVE_CHANGE_SCOPE_CHANGED');s.enabled=true;s.pending=true;save(e,s,'resume');hints.registry(true,s.channels);return view(s);}
  if(!canContinue())fail('OWNER_BUDGET_YIELD');
  const start=Drive.Changes.getStartPageToken(driveId?{driveId,supportsAllDrives:true}:{supportsAllDrives:true});
  if(!token(start?.startPageToken))fail('DRIVE_CHANGE_CURSOR_INVALID');
  // Capture cursor BEFORE initial metadata crawl, then drain it to close races.
  const s={schema:1,enabled:true,webhookUrl,driveId,cursor:start.startPageToken,queue:[],folders:[{id:SOURCE_FOLDER_ID,pageToken:null}],serial:0,pending:true,lastHintAt:0,lastReconciledAt:0,coverage:false,channels:[],watchPending:null,error:null,seenFolders:[SOURCE_FOLDER_ID],warnings:[],warningOverflow:false};
  save(null,s,'activate');hints.registry(true,s.channels);return view(s);
 });}
 function hint(payload){return locked(()=>hints.hint(payload));}
 function renew(entry,s){
  s.channels=s.channels.filter(c=>c.expiresAt>now());
  if(s.channels.some(c=>c.expiresAt-now()>DRIVE_CHANGE_LIMITS.renewBeforeMs))return null;
  if(s.watchPending)return { ...view(s),error:'DRIVE_CHANGE_WATCH_UNRESOLVED',requiresOwnerAction:true};
  if(typeof randomId!=='function')fail('DRIVE_CHANGE_RANDOM_REQUIRED');
  const id=randomId();if(!validId(id)||s.channels.some(c=>c.id===id))fail('DRIVE_CHANGE_CHANNEL_INVALID');
  const expiresAt=now()+DRIVE_CHANGE_LIMITS.channelMs;
  s.watchPending={id,requestedAt:now(),expiresAt};entry=save(entry,s,'reserve-watch');
  // Never retry an ambiguous registration automatically. Cursor fallback keeps
  // working while owner resolves a lost response. Existing channel overlaps.
  try{const response=Drive.Changes.watch({id,type:'web_hook',address:s.webhookUrl,token:channelToken(id),expiration:String(expiresAt)},s.cursor,opts(s));
  if(response?.id!==id||!token(response.resourceId)||response.resourceId.length>256||!/^\d{1,16}$/.test(String(response.expiration)))fail('DRIVE_CHANGE_WATCH_RESPONSE');
  const expiry=Number(response.expiration);if(expiry<=now()||expiry>expiresAt)fail('DRIVE_CHANGE_WATCH_EXPIRY');
  s.channels.push({id,resourceId:response.resourceId,expiresAt:expiry,lastMessage:'0'});s.watchPending=null;save(entry,s,'watch-ready');hints.registry(true,s.channels);return view(s);
  }catch(_){return {...view(entry.value),error:'DRIVE_CHANGE_WATCH_UNRESOLVED',requiresOwnerAction:true};}
 }
 function tick({hintsOnly=false}={}){return locked(()=>{
  let e=read();if(!e?.value?.enabled)return view(e?.value);const s=clone(e.value);
  if(!canContinue())return {...view(s),yielded:true};
  const advisory=hints.read();
  if(!advisory.enabled)return {...view(s),enabled:false,error:'DRIVE_CHANGE_ACTIVATION_INCOMPLETE',requiresOwnerAction:true};
  if(JSON.stringify(advisory.channels)!==JSON.stringify(s.channels.map(c=>({id:c.id,resourceId:c.resourceId,expiresAt:c.expiresAt}))))hints.registry(true,s.channels);
  const advisoryCursor=advisory.cursor?.baseCursor===s.cursor?advisory.cursor:null;
  if(hintsOnly&&(s.queue.length||s.folders.length))return {...view(s),classified:true};
  if(['DRIVE_CHANGE_CURSOR_EXPIRED','DRIVE_CHANGE_ROOT_UNAVAILABLE'].includes(s.error))return {...view(s),requiresOwnerAction:true};
  // Renewal precedes periodic reconciliation so a five-minute tick cannot
  // starve renewal forever. Ambiguous watch setup never stops delta fallback.
  if(!hintsOnly&&!s.watchPending&&!s.channels.some(c=>c.expiresAt-now()>DRIVE_CHANGE_LIMITS.renewBeforeMs)){const renewed=renew(e,s);if(renewed)return renewed;}
  // Drain before fetching another page: bounded queue supplies backpressure.
  if(s.queue.length){
   const q=s.queue[0];
   if(q.removed&&(writer.get(importKeys.source(q.id))?.value||(s.seenFolders||[]).includes(q.id)))warn(s,q.id,'source-missing');
   if(!q.removed){
    let f;try{f=Drive.Files.get(q.id,{fields:SOURCE_FIELDS,supportsAllDrives:true});}catch(error){if(error?.code!==404&&error?.details?.code!==404)throw error;}
    if(f&&contains(f)){
     if(folder(f))addFolder(s,f.id);
     else if(csv(f)&&Number(f.size)>0){
      s.warnings=(s.warnings||[]).filter(w=>w.id!==q.id);
      const marker=hash([q.id,q.serial,f.version,f.md5Checksum,f.size]);
      try{store.registerJob({operationId:'delta_reg_'+marker,jobId:'delta_job_'+marker,sourceIdentity:f});}
      catch(error){if((error?.code||error?.message)==='SOURCE_JOB_ACTIVE'){
       // A rewrite waits behind the current generation; do not lose the ID.
       s.queue.push(s.queue.shift());save(e,s,'wait-source');return {...view(s),waitingSource:true};
      }throw error;}
     }
    }else if(writer.get(importKeys.source(q.id))?.value||(s.seenFolders||[]).includes(q.id))warn(s,q.id,'source-moved-or-missing');
   }
   s.queue.shift();save(e,s,'drain');return view(s);
  }
  if(s.folders.length){
   const f=s.folders[0];
   let metadata;try{metadata=Drive.Files.get(f.id,{fields:'id,parents,mimeType,trashed',supportsAllDrives:true});}catch(error){if(error?.code!==404&&error?.details?.code!==404)throw error;}
   if(!contains(metadata)){if(f.id===SOURCE_FOLDER_ID){s.error='DRIVE_CHANGE_ROOT_UNAVAILABLE';s.coverage=false;save(e,s,'root-unavailable');return {...view(s),requiresOwnerAction:true};}warn(s,f.id,'folder-moved-or-missing');s.folders.shift();save(e,s,'folder-moved');return view(s);}
   const p=Drive.Files.list({q:"'"+f.id+"' in parents and trashed = false",fields:'nextPageToken,files('+SOURCE_FIELDS+')',pageSize:DRIVE_CHANGE_LIMITS.pageSize,pageToken:f.pageToken||undefined,supportsAllDrives:true,includeItemsFromAllDrives:true});
   if(!p||!Array.isArray(p.files)||p.files.length>DRIVE_CHANGE_LIMITS.pageSize||p.nextPageToken&&!token(p.nextPageToken))fail('DRIVE_CHANGE_PAGE_INVALID');
   for(const child of p.files)if(!excludedIds.includes(child.id)&&(folder(child)||csv(child)))queue(s,child.id);
   if(p.nextPageToken){if(p.nextPageToken===f.pageToken)fail('DRIVE_CHANGE_PAGE_STALLED');f.pageToken=p.nextPageToken;}else s.folders.shift();
   save(e,s,'folder-page');return view(s);
  }
  if(s.pending||advisory.pending||now()-(advisoryCursor?.checkedAt||s.lastReconciledAt)>=DRIVE_CHANGE_LIMITS.intervalMs){
   let p;try{p=Drive.Changes.list(advisoryCursor?.cursor||s.cursor,{...opts(s),pageSize:DRIVE_CHANGE_LIMITS.pageSize,includeRemoved:true,fields:'nextPageToken,newStartPageToken,changes(fileId,removed,file('+SOURCE_FIELDS+'))'});}
   catch(error){if(error?.code===410||error?.details?.code===410){s.coverage=false;s.error='DRIVE_CHANGE_CURSOR_EXPIRED';save(e,s,'cursor-expired');return {...view(s),requiresOwnerAction:true};}throw error;}
   if(!p||!Array.isArray(p.changes)||p.changes.length>DRIVE_CHANGE_LIMITS.pageSize)fail('DRIVE_CHANGE_PAGE_INVALID');
   const next=p.nextPageToken||p.newStartPageToken;if(!token(next)||p.nextPageToken===(advisoryCursor?.cursor||s.cursor))fail('DRIVE_CHANGE_CURSOR_INVALID');
   for(const c of p.changes){
    if(excludedIds.includes(c.fileId))continue;
    const knownFolder=(s.seenFolders||[]).includes(c.fileId);
    if(c.removed){if(knownFolder||writer.get(importKeys.source(c.fileId))?.value)queue(s,c.fileId,true);}
    else if(folder(c.file)||csv(c.file)){
     // A generic notification or an unrelated account CSV is not evidence of
     // additional running data. Classify the actual subtree before publishing
     // any Drive-backed queue/pending state.
     if(contains(c.file)||knownFolder||writer.get(importKeys.source(c.fileId))?.value)queue(s,c.fileId,false);
    }
   }
   // An irrelevant-only page never writes to Drive. Its authenticated cursor
   // is a safe optimization because it skipped no source work. Lost advisory
   // progress only replays metadata from the older authoritative cursor.
   if(!s.queue.length&&!s.folders.length&&s.coverage&&!s.pending){hints.cursor(s.cursor,next,now(),!!p.nextPageToken);return {...view(s),hintPending:!!p.nextPageToken,classified:false};}
   s.cursor=next;s.pending=!!p.nextPageToken;
   if(!s.pending){s.lastReconciledAt=now();s.coverage=true;s.error=null;}
   // This commit advances the cursor AND retains every discovered ID. A crash
   // cannot acknowledge a page whose durable queue insertion did not happen.
   save(e,s,'changes-page');hints.cursor(s.cursor,s.cursor,now(),!!p.nextPageToken);return {...view(s),classified:true};
  }
  if(hintsOnly)return {...view(s),classified:false};
  const renewed=renew(e,s);return renewed||view(s);
 });}
 function resetCursor(){return locked(()=>{const e=read();if(!e?.value)fail('DRIVE_CHANGE_DISABLED');const s=clone(e.value);const p=Drive.Changes.getStartPageToken(s.driveId?{driveId:s.driveId,supportsAllDrives:true}:{supportsAllDrives:true});if(!token(p?.startPageToken))fail('DRIVE_CHANGE_CURSOR_INVALID');s.cursor=p.startPageToken;s.folders=[{id:SOURCE_FOLDER_ID,pageToken:null}];s.pending=true;s.coverage=false;s.error=null;save(e,s,'owner-reset-cursor');return view(s);});}
 function resolveExpiredWatch(){return locked(()=>{const e=read();if(!e?.value)fail('DRIVE_CHANGE_DISABLED');const s=clone(e.value);if(s.watchPending&&s.watchPending.expiresAt>now())fail('DRIVE_CHANGE_WATCH_NOT_EXPIRED');s.watchPending=null;save(e,s,'owner-resolve-watch');return view(s);});}
 function pause(){return locked(()=>{const e=read();if(!e)return view(null);const s=clone(e.value);hints.registry(false,s.channels);s.enabled=false;save(e,s,'pause');return view(s);});}
 return Object.freeze({activate,pause,resetCursor,resolveExpiredWatch,hint,tick,status:()=>locked(()=>view(read()?.value))});
}
