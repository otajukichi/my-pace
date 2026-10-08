// Incremental application reads share the existing immutable writer transaction
// boundary. Signed continuations select a verified, frozen COW root, never a
// client-supplied raw Drive ID and never a freshly recovered mutable read view.
import {parseKey} from '../src/lib/entity-codec.js';
import {utf8ByteLength} from '../src/lib/domain.js';
import {APP_CHANGE_HEAD,appChangeHead,appChangeSlot} from './app-domain.mjs';
const fail=(code,retryable=false,resetReason=null)=>{const e=Error(code);e.code=code;if(retryable)e.retryable=true;if(resetReason)e.resetReason=resetReason;throw e;};
const reset=reason=>fail('RESET_REQUIRED',false,reason);
const requireFence=view=>{if(view.writerFence!==2){const e=Error('SYNC_V2_MIGRATION_REQUIRED');e.code=e.message;e.requiresOwnerAction=true;throw e;}};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.split(',').sort().join(',');
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const id=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(s);
const hash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const ref=r=>r===null||exact(r,'id,hash')&&id(r.id)&&hash(r.hash);
const APP_CURSOR_KIND='mypace-app-sync';
const MAX_CURSOR_BYTES=8192,MAX_PAGE_BYTES=262144,MAX_PAGE_UNITS=24,MAX_SNAPSHOT_UNITS=128;
const DELTA_CURSOR_TTL=15*60*1000,SNAPSHOT_CURSOR_TTL=24*60*60*1000;
const cursorTtl=mode=>mode==='snapshot'?SNAPSHOT_CURSOR_TTL:DELTA_CURSOR_TTL;
const snapshotPosition=p=>p===null||exact(p,'path,offset')&&typeof p.path==='string'&&/^[0-9a-f]{0,64}$/.test(p.path)&&integer(p.offset)&&p.offset<=512;
// This includes the maximum ASCII signed token, the small response envelope,
// and the signed-dispatcher wrapper. One 128 KiB writer value still fits.
const PAGE_HEADROOM=16384;
const budgetError=e=>['STORE_YIELD','OWNER_BUDGET_YIELD','IMPORT_YIELD','SYNC_BUDGET_YIELD'].includes(e?.code||e?.message);
function domainKey(key,code){try{parseKey(key);}catch(_){fail(code);}return key;}
function acknowledgement(a){return a===null||exact(a,'store,generation,revision,hash')&&id(a.store)&&id(a.generation)&&integer(a.revision)&&hash(a.hash);}
function checkpoint(c){return c===null||exact(c,'store,generation,seq')&&id(c.store)&&id(c.generation)&&integer(c.seq);}
function readView(v){return exact(v,'anchorId,anchorHash,storeId,datasetGeneration,revision,stateRoot,receiptRoot,acceptedEpochs,headId,headHash,writerScriptId,schemaVersion,writerFence')&&id(v.anchorId)&&hash(v.anchorHash)&&id(v.storeId)&&id(v.datasetGeneration)&&integer(v.revision)&&ref(v.stateRoot)&&ref(v.receiptRoot)&&id(v.headId)&&hash(v.headHash)&&id(v.writerScriptId)&&integer(v.schemaVersion)&&v.schemaVersion>0&&[0,2].includes(v.writerFence)&&Array.isArray(v.acceptedEpochs)&&v.acceptedEpochs.length>0&&v.acceptedEpochs.length<=4&&v.acceptedEpochs.every(id)&&new Set(v.acceptedEpochs).size===v.acceptedEpochs.length;}
function businessEntity(e,key,code){
 if(!e||e.key!=='app/data/'+key||!integer(e.version)||e.version===0||typeof e.deleted!=='boolean'||e.deleted&&e.value!==null)fail(code);
 return {key,version:e.version,deleted:e.deleted,value:e.value};
}
export function createAppSyncV2({writer,locked,sealCursor,openCursor,now=()=>Date.now(),canContinue=()=>true}){
 if(!writer||['captureReadView','readEntityAtRoot','scanEntitiesAtRoot','validateReadView','assertMinimumAtReadView','recoveryBarrier'].some(k=>typeof writer[k]!=='function')||[locked,sealCursor,openCursor,now,canContinue].some(f=>typeof f!=='function'))fail('SYNC_CONFIG');
 const read=(view,key)=>writer.readEntityAtRoot(view.stateRoot,key);
 function open(encoded,time){
  if(typeof encoded!=='string'||encoded.length===0||utf8ByteLength(encoded)>MAX_CURSOR_BYTES)fail('SYNC_CURSOR_INVALID');
  let c;try{c=openCursor(encoded);}catch(error){if((error.code||error.message)==='CURSOR_EXPIRED')reset('cursor-expired');fail('SYNC_CURSOR_INVALID');}
  if(!exact(c,'kind,protocol,mode,view,targetSeq,position,issuedAt,expiresAt')||c.kind!==APP_CURSOR_KIND||c.protocol!==2||!['snapshot','delta'].includes(c.mode)||!readView(c.view)||!integer(c.targetSeq)||!integer(c.issuedAt)||!integer(c.expiresAt)||c.expiresAt-c.issuedAt!==cursorTtl(c.mode)||c.issuedAt>time)fail('SYNC_CURSOR_INVALID');
  if(c.expiresAt<=time)reset('cursor-expired');
  if(c.view.anchorId!==writer.anchorId||c.view.storeId!==writer.storeId||c.view.writerScriptId!==writer.writerScriptId||c.view.schemaVersion!==writer.schemaVersion)reset('identity-changed');
  requireFence(c.view);
  if(c.mode==='delta'){if(!integer(c.position)||c.position>c.targetSeq)fail('SYNC_CURSOR_INVALID');}
  else if(c.position===null||!snapshotPosition(c.position))fail('SYNC_CURSOR_INVALID');
  return c;
 }
 function seal(c){
  const value=sealCursor(c);
  // The existing codec produces ASCII base64url + HMAC. Limiting the alphabet
  // also makes the pre-reserved JSON byte headroom a strict bound.
  if(typeof value!=='string'||!/^[-A-Za-z0-9_.]+$/.test(value)||value.length>MAX_CURSOR_BYTES)fail('SYNC_CURSOR_INVALID');
  return value;
 }
 function identity(view,bound){if(bound&&(bound.store!==view.storeId||bound.generation!==view.datasetGeneration))reset('identity-changed');}
 function minimum(view,ack){if(ack&&!writer.assertMinimumAtReadView(view,{revision:ack.revision,hash:ack.hash}))fail('SYNC_CUT_BEHIND',true);}
 function initial(p,time){
  // Establish identity before evaluating a client proof. A proof for a different
  // store/generation must request a safe rebootstrap, not deadlock recovery.
  writer.recoveryBarrier();
  const view=writer.captureReadView();if(!readView(view))fail('SYNC_READ_VIEW_INVALID');requireFence(view);
  identity(view,p.since);identity(view,p.minimumAcknowledged);minimum(view,p.minimumAcknowledged);
  const head=appChangeHead(read(view,APP_CHANGE_HEAD));
  if(p.since&&p.since.seq>head.seq)fail('SYNC_CHECKPOINT_AHEAD');
  if(p.since&&p.since.seq+1<head.floor)reset('retention-floor');
  const mode=p.since?'delta':'snapshot',position=p.since?.seq??null;
  return {kind:APP_CURSOR_KIND,protocol:2,mode,view,targetSeq:head.seq,position,issuedAt:time,expiresAt:time+cursorTtl(mode)};
 }
 return Object.freeze({pull(p){return locked(()=>{
  if(!exact(p,'cursor,since,minimumAcknowledged')||p.cursor!==null&&typeof p.cursor!=='string'||!checkpoint(p.since)||!acknowledgement(p.minimumAcknowledged)||p.cursor!==null&&p.since!==null)fail('SYNC_PAYLOAD_INVALID');
  const time=now();if(!integer(time)||!Number.isSafeInteger(time+SNAPSHOT_CURSOR_TTL))fail('SYNC_CLOCK_INVALID');
  const c=p.cursor===null?initial(p,time):open(p.cursor,time),v=c.view;
  if(p.cursor!==null){
   try{writer.validateReadView(v);}catch(error){if((error.code||error.message)==='WRITER_READ_VIEW_INVALID')reset('identity-changed');throw error;}
   identity(v,p.minimumAcknowledged);minimum(v,p.minimumAcknowledged);
  }
  const fromSeq=c.mode==='delta'?c.position:null,entries=new Map();let position=c.position,more=false;
  if(c.mode==='snapshot'){
   // Scan each immutable radix leaf once, rather than two key lookups for every
   // catalog record. A page may contain no app data while still advancing over
   // internal import/catalog/journal entries; that is valid bounded progress.
   const scan=writer.scanEntitiesAtRoot(v.stateRoot,{position,prefix:'app/data/',limit:MAX_SNAPSHOT_UNITS,maxBytes:229376,scanLimit:2048,canContinue});
   if(!scan||!Array.isArray(scan.entries)||scan.entries.length>MAX_SNAPSHOT_UNITS||typeof scan.done!=='boolean'||!snapshotPosition(scan.position)||scan.done!==(scan.position===null)||!integer(scan.scanned)||!integer(scan.bytes))fail('SYNC_SCAN_INVALID');
   const start=position??{path:'',offset:0};
   if(!scan.done&&scan.position.path===start.path&&scan.position.offset===start.offset)fail('SYNC_BUDGET_YIELD',true);
   for(const entity of scan.entries){
    if(typeof entity?.key!=='string'||!entity.key.startsWith('app/data/'))fail('SYNC_SCAN_INVALID');
    const key=domainKey(entity.key.slice(9),'SYNC_SCAN_INVALID');if(entries.has(key))fail('SYNC_SCAN_INVALID');
    entries.set(key,businessEntity(entity,key,'SYNC_SCAN_INVALID'));
   }
   position=scan.position;more=!scan.done;
  }else{
   let units=0,bytes=2;
   while(position<c.targetSeq&&units<MAX_PAGE_UNITS){
    if(!canContinue()){if(!units)fail('SYNC_BUDGET_YIELD',true);break;}
    let key,entry,next;
    try{
     next=position+1;const event=read(v,appChangeSlot(next));
     if(!event||event.deleted||!exact(event.value,'seq,key,version,deleted')||event.value.seq!==next||!integer(event.value.version)||event.value.version===0||typeof event.value.deleted!=='boolean')fail('APP_JOURNAL_GAP');
     key=domainKey(event.value.key,'APP_JOURNAL_CORRUPT');
     entry=entries.get(key)||businessEntity(read(v,'app/data/'+key),key,'APP_JOURNAL_CORRUPT');
     if(entry.version<event.value.version||entry.version===event.value.version&&entry.deleted!==event.value.deleted)fail('APP_JOURNAL_CORRUPT');
    }catch(error){if(!budgetError(error))throw error;if(!units)fail('SYNC_BUDGET_YIELD',true);break;}
    const additional=entries.has(key)?0:utf8ByteLength(JSON.stringify(entry))+(entries.size?1:0);
    if(bytes+additional>MAX_PAGE_BYTES-PAGE_HEADROOM){if(!units)fail('SYNC_ENTITY_TOO_LARGE');break;}
    // Advance only after a complete event was validated and byte-admitted.
    entries.set(key,entry);bytes+=additional;units++;position=next;
   }
   more=position<c.targetSeq;
  }
  const result={protocol:2,mode:c.mode,store:v.storeId,generation:v.datasetGeneration,epoch:v.acceptedEpochs[v.acceptedEpochs.length-1],revision:v.revision,headHash:v.headHash,fromSeq,targetSeq:c.targetSeq,throughSeq:c.mode==='delta'?position:more?null:c.targetSeq,entries:[...entries.values()],nextCursor:more?seal({...c,position}):null,checkpoint:more?null:{store:v.storeId,generation:v.datasetGeneration,seq:c.targetSeq}};
  if(utf8ByteLength(JSON.stringify(result))>MAX_PAGE_BYTES)fail('SYNC_PAGE_TOO_LARGE');
  return result;
 });}});
}
