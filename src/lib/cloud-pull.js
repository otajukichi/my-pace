import {canonical,parseKey,validateEntity} from './entity-codec.js';
const fail=code=>{throw Error(code);};
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export function validCheckpoint(value){return !!value&&typeof value.store==='string'&&typeof value.generation==='string'&&integer(value.seq);}
export function validMinimum(value){return !!value&&integer(value.revision)&&hash(value.hash);}
export function newerMinimum(...values){let result=null;for(const value of values){if(value==null)continue;if(!validMinimum(value))fail('SYNC_PROOF_INVALID');if(result?.revision===value.revision&&result.hash!==value.hash)fail('SYNC_PROOF_MISMATCH');if(!result||value.revision>result.revision)result={revision:value.revision,hash:value.hash};}return result;}
export function validatePullPage(page,{since=null,continuation=null,minimumAcknowledged=null}={}){
 if(!page||page.protocol!==2||!['snapshot','delta'].includes(page.mode)||typeof page.store!=='string'||typeof page.generation!=='string'||typeof page.epoch!=='string'||!integer(page.revision)||!hash(page.headHash)||!integer(page.targetSeq)||!(page.throughSeq===null||integer(page.throughSeq))||page.throughSeq>page.targetSeq||!Array.isArray(page.entries)||page.entries.length>(page.mode==='snapshot'?128:24)||!(page.nextCursor===null||typeof page.nextCursor==='string'&&page.nextCursor.length>0)||!(page.fromSeq===null||integer(page.fromSeq)))fail('PULL_INVALID');
 if(page.mode==='snapshot'&&(page.fromSeq!==null||page.nextCursor!==null&&page.throughSeq!==null)||page.mode==='delta'&&(page.fromSeq===null||page.throughSeq===null))fail('PULL_INVALID');
 if(page.mode==='delta'&&(page.throughSeq<page.fromSeq||page.targetSeq<page.fromSeq))fail('PULL_INVALID');
 if(!continuation){
  if(since){if(!validCheckpoint(since)||page.mode!=='delta'||page.store!==since.store||page.generation!==since.generation||page.fromSeq!==since.seq)fail('PULL_IDENTITY_CHANGED');}
  else if(page.mode!=='snapshot')fail('PULL_INVALID');
 }else{
  for(const key of ['mode','store','generation','epoch','revision','headHash','targetSeq'])if(page[key]!==continuation[key])fail('PULL_CUT_CHANGED');
  if(page.mode==='delta'&&page.fromSeq!==continuation.throughSeq)fail('PULL_SEQUENCE_GAP');
  if(page.mode==='delta'&&page.throughSeq<continuation.throughSeq)fail('PULL_CURSOR_REGRESSED');
  if(page.nextCursor===continuation.cursor)fail('PULL_CURSOR_STALLED');
  if(page.mode==='delta'&&page.nextCursor!==null&&page.throughSeq<=continuation.throughSeq)fail('PULL_CURSOR_STALLED');
 }
 if(minimumAcknowledged&&(minimumAcknowledged.store!==page.store||minimumAcknowledged.generation!==page.generation))fail('PULL_IDENTITY_CHANGED');
 if(minimumAcknowledged&&page.revision<minimumAcknowledged.revision)fail('SYNC_BELOW_CONFIRMED');
 if(minimumAcknowledged&&page.revision===minimumAcknowledged.revision&&page.headHash!==minimumAcknowledged.hash)fail('SYNC_PROOF_MISMATCH');
 if(page.nextCursor===null){if(!validCheckpoint(page.checkpoint)||page.checkpoint.store!==page.store||page.checkpoint.generation!==page.generation||page.checkpoint.seq!==page.targetSeq||page.throughSeq!==page.targetSeq)fail('PULL_CHECKPOINT_INVALID');}
 else if(page.checkpoint!==null)fail('PULL_CHECKPOINT_EARLY');
 const entries=new Map();for(const item of page.entries){
  if(!item||!Number.isSafeInteger(item.version)||item.version<1||typeof item.deleted!=='boolean'||!Object.hasOwn(item,'value')||item.deleted&&item.value!==null)fail('PULL_ENTITY_INVALID');const parsed=parseKey(item.key);
  if(!item.deleted){try{if(parsed.kind==='habitLog'){if(typeof item.value!=='boolean'&&!(typeof item.value==='number'&&Number.isFinite(item.value)&&item.value>=0&&item.value<=1000000))fail('PULL_ENTITY_INVALID');}else validateEntity(item.key,item.value);}catch{fail('PULL_ENTITY_INVALID');}}
  const existing=entries.get(item.key);if(existing&&(page.mode==='snapshot'||canonical(existing)!==canonical(item)))fail('PULL_ENTITY_DUPLICATE');entries.set(item.key,item);
 }
 return {...page,entries:[...entries.values()]};
}
export function continuationFor(page,cursor=page.nextCursor){return {cursor,mode:page.mode,store:page.store,generation:page.generation,epoch:page.epoch,revision:page.revision,headHash:page.headHash,fromSeq:page.fromSeq,targetSeq:page.targetSeq,throughSeq:page.throughSeq};}
// Keep raw tombstones and parent/child records. Projection is a separate step;
// normalization must never silently erase an unapplied remote entity.
export function mergePullEntries(current,entries){const puts=[];for(const entity of entries){const old=current[entity.key];if(old&&old.version>entity.version)continue;if(old?.version===entity.version){if(canonical(old)!==canonical(entity))fail('PULL_ENTITY_MISMATCH');continue;}puts.push(entity);}return puts;}
