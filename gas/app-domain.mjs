import {canonical,parseKey,validateEntity} from '../src/lib/entity-codec.js';
import {SYNC_APP_CHANGE_HEAD,SYNC_APP_CHANGE_CAPACITY,syncAppChangeSlot,validateSyncAppChangeHead} from '../storage/app-sync-protocol.mjs';
const fail=(code,retryable=false)=>{const e=Error(code);e.code=code;if(retryable)e.retryable=true;throw e;};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.split(',').sort().join(',');
function appReceipt(receipt){
 if(receipt?.result&&Object.prototype.hasOwnProperty.call(receipt.result,'preparationError')){
  if(!exact(receipt.result,'preparationError')||typeof receipt.result.preparationError!=='string'||!/^[A-Z][A-Z0-9_]{1,80}$/.test(receipt.result.preparationError))fail('APP_RECEIPT_INVALID');
  fail(receipt.result.preparationError);
 }
 return receipt;
}
const HEAD='app/catalog/head';const node=key=>'app/catalog/'+key;const data=key=>'app/data/'+key;
export const APP_CHANGE_HEAD=SYNC_APP_CHANGE_HEAD;
export const APP_CHANGE_CAPACITY=SYNC_APP_CHANGE_CAPACITY;
export const appChangeSlot=syncAppChangeSlot;
// Only explicit owner activation initializes the shared head with the fence.
export function appChangeHead(entity){return validateSyncAppChangeHead(entity);}
export function createAppDomain({writer,locked,digest}){
 if(!writer||typeof locked!=='function'||typeof digest!=='function')fail('DOMAIN_CONFIG');
 return {
 command(c){return locked(()=>{
  if(!exact(c,'operationId,epoch,generation,store,key,expectedVersion,deleted,value,recreate')||typeof c.operationId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(c.operationId)||typeof c.epoch!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(c.epoch)||typeof c.store!=='string'||typeof c.generation!=='string'||!Number.isSafeInteger(c.expectedVersion)||c.expectedVersion<0||typeof c.deleted!=='boolean'||typeof c.recreate!=='boolean')fail('COMMAND_INVALID');
  const parsed=parseKey(c.key),hash=digest(canonical(c));
  // Keep the original client-command digest. Server-generated catalog/journal
  // metadata is rebuilt only after a verified unrelated reserved-slot winner.
  for(let attempt=0;attempt<=4;attempt++){
   writer.recoveryBarrier();
   const status=writer.status();
   // The prepared engine owns receipt-first replay and exact-parent pending
   // descriptor evidence. Do not repeat its deep negative receipt lookup here.
   if(typeof writer.prepareAppCommand==='function'&&status.nextPreparationId)return appReceipt(writer.prepareAppCommand(c,hash));
   // Legacy receipts replay before generation/version/domain-state checks.
   // Receipts without appSeq are returned byte-for-byte as originally recorded.
   const prior=writer.getReceipt(c.operationId,c.epoch);if(prior){if(prior.digest!==hash)fail('OP_ID_REUSED');return appReceipt(prior);}
   if(c.store!==status.storeId)fail('STORE_ID_MISMATCH');if(c.generation!==status.datasetGeneration)fail('DATASET_GENERATION_MISMATCH');
   if(!status.acceptedEpochs.includes(c.epoch))fail('OPERATION_EPOCH_EXPIRED');
   const old=writer.getEntity(data(c.key));if((old?.version??0)!==c.expectedVersion)fail('ENTITY_VERSION_CONFLICT');
   if(c.deleted&&(c.value!==null||!old||old.deleted))fail('ENTITY_MISSING');
   if(c.deleted&&['settings','garden','habit'].includes(parsed.kind))fail('ENTITY_DELETE_FORBIDDEN'); // Archive habits; preserves historical log types.
   let value=null;
   if(!c.deleted){const habit=parsed.kind==='habitLog'?writer.getEntity(data('habit:'+parsed.id)):null;if(parsed.kind==='habitLog'&&(!habit||habit.deleted))fail('HABIT_MISSING');value=validateEntity(c.key,c.value,habit?.value);if(parsed.kind==='habit'&&old&&!old.deleted&&old.value.type!==value.type)fail('HABIT_TYPE_IMMUTABLE');}
   // At exhaustion still recover/replay and verify the actual business version
   // above. Never label metadata-only contention as a conflict in the user's data.
   if(attempt===4)fail('DOMAIN_CONTENTION',true);
   const changes=[{key:data(c.key),expectedVersion:c.expectedVersion,deleted:c.deleted,value,...(c.recreate?{recreate:true}:{})}];
   if(!old){const head=writer.getEntity(HEAD);if(head&&(head.deleted||!exact(head.value,'first')))fail('CATALOG_CORRUPT');changes.push({key:node(c.key),expectedVersion:0,value:{key:c.key,next:head?.value.first??null}},{key:HEAD,expectedVersion:head?.version??0,value:{first:c.key}});}
   const result={key:c.key,version:c.expectedVersion+1,deleted:c.deleted};
   // Unfenced stores retain the legacy mutation/result contract. Login, pull,
   // and ordinary commands cannot authorize the irreversible format fence.
   if(status.writerFence===2){
    const head=writer.getEntity(APP_CHANGE_HEAD),journal=appChangeHead(head),seq=journal.seq+1;
    if(!Number.isSafeInteger(seq))fail('APP_SEQUENCE_EXHAUSTED');
    const slot=writer.getEntity(appChangeSlot(seq));
    if(seq>APP_CHANGE_CAPACITY&&!slot||slot&&(slot.deleted||!exact(slot.value,'seq,key,version,deleted')||slot.value.seq!==seq-APP_CHANGE_CAPACITY||!Number.isSafeInteger(slot.value.version)||slot.value.version<1||typeof slot.value.deleted!=='boolean'))fail('APP_JOURNAL_CORRUPT');
    changes.push({key:appChangeSlot(seq),expectedVersion:slot?.version??0,value:{seq,key:c.key,version:c.expectedVersion+1,deleted:c.deleted}},{key:APP_CHANGE_HEAD,expectedVersion:head.version,value:{protocol:2,seq,floor:Math.max(1,seq-APP_CHANGE_CAPACITY+1),capacity:APP_CHANGE_CAPACITY}});
    result.appSeq=seq;
   }
   try{return writer.transact({operationId:c.operationId,epoch:c.epoch,datasetGeneration:c.generation,digest:hash,changes,result});}
   catch(error){if((error.code||error.message)!=='ENTITY_VERSION_CONFLICT')throw error;}
  }
 });},
 snapshot(p){return locked(()=>{
  if(!exact(p,'cursor,revision')||(p.cursor!==null&&typeof p.cursor!=='string')||(p.revision!==null&&!Number.isSafeInteger(p.revision)))fail('SNAPSHOT_INVALID');
  writer.recoveryBarrier();const s=writer.status();if(p.revision!==null&&p.revision!==s.revision)fail('SNAPSHOT_CHANGED');
  if(p.cursor!==null){parseKey(p.cursor);if(p.revision===null)fail('SNAPSHOT_INVALID');}
  let key=p.cursor??writer.getEntity(HEAD)?.value.first??null;const entities=[],seen=new Set();let bytes=0;
  while(key!==null&&entities.length<24&&bytes<131072){if(seen.has(key))fail('CATALOG_CORRUPT');seen.add(key);const n=writer.getEntity(node(key)),e=writer.getEntity(data(key));if(!n||n.deleted||n.value.key!==key||!e)fail('CATALOG_CORRUPT');parseKey(key);entities.push({key,version:e.version,deleted:e.deleted,value:e.value});bytes+=canonical(e).length;key=n.value.next;if(key!==null)parseKey(key);}
  return {store:s.storeId,generation:s.datasetGeneration,revision:s.revision,epoch:s.acceptedEpochs[s.acceptedEpochs.length-1],entities,cursor:key};
 });}
 };
}
