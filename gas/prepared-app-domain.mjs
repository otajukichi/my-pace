/**
 * Resumable application-command expansion over an engine-verified immutable
 * parent. The engine owns authentication, receipt-first replay, parent/root
 * validation, durable cursor publication and the final reserved-slot commit.
 *
 * Each advance performs at most one derived-key entity lookup. Cursor state is
 * compact metadata only: the original command is retained once by the engine,
 * and large ordinary values are normalized again locally when expansion ends.
 */
import {canonical,parseKey,validateEntity} from '../src/lib/entity-codec.js';
import {utf8ByteLength} from '../src/lib/domain.js';
import {SYNC_APP_CHANGE_HEAD,SYNC_APP_CHANGE_CAPACITY,syncAppChangeSlot,validateSyncAppChangeHead} from '../storage/app-sync-protocol.mjs';

const HEAD='app/catalog/head',KIND='mypace-prepared-app-command',VERSION=1;
const PHASES=['validate','business','parent','catalog-node','catalog-head','journal-head','journal-slot','ready'];
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===keys.split(',').sort().join(',');
const integer=value=>Number.isSafeInteger(value)&&value>=0;
// The writer authenticates the digest against the exact descriptor command.
// A cursor never carries or re-hashes a duplicate large application value.
const identity=value=>typeof value==='string'&&/^[-A-Za-z0-9_]{1,128}$/.test(value);
const fail=code=>{const error=Error(code);error.code=code;throw error;};
const rejected=error=>({kind:'rejected',error});
const valueError=error=>/^[A-Z][A-Z0-9_]{1,80}$/.test(error?.code||error?.message)?error.code||error.message:'VALIDATION_FAILED';
const copy=value=>JSON.parse(canonical(value));

function checkedEntity(entity,key,code){
 if(entity===null||entity===undefined)return null;
 if(!exact(entity,'key,version,deleted,value')||entity.key!==key||!Number.isSafeInteger(entity.version)||entity.version<1||typeof entity.deleted!=='boolean'||entity.deleted&&entity.value!==null)fail(code);
 return entity;
}
function checkedDomainKey(key,code){try{parseKey(key);}catch{fail(code);}return key;}

export function createPreparedAppCommand({command,digest,base}={}){
 if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest)||!exact(base,'storeId,datasetGeneration,acceptedEpochs,writerFence')||!identity(base.storeId)||!identity(base.datasetGeneration)||!Array.isArray(base.acceptedEpochs)||base.acceptedEpochs.length<1||base.acceptedEpochs.length>4||!base.acceptedEpochs.every(identity)||new Set(base.acceptedEpochs).size!==base.acceptedEpochs.length||![0,2].includes(base.writerFence))fail('APP_PREPARATION_CONFIG_INVALID');
 const boundBase=copy(base),binding=canonical(boundBase);let c,commandError,parsed;
 try{c=copy(command);}catch(error){commandError=valueError(error);}
 if(!commandError){
  if(!exact(c,'operationId,epoch,generation,store,key,expectedVersion,deleted,value,recreate')||typeof c.operationId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(c.operationId)||typeof c.epoch!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(c.epoch)||typeof c.store!=='string'||typeof c.generation!=='string'||!integer(c.expectedVersion)||typeof c.deleted!=='boolean'||typeof c.recreate!=='boolean')commandError='COMMAND_INVALID';
  else try{parsed=parseKey(c.key);}catch(error){commandError=valueError(error);}
 }
 const initialState=()=>({kind:KIND,version:VERSION,digest,binding,phase:'validate',business:null,catalog:null,journal:null,logValue:null});
 function checkState(state){
  if(!exact(state,'kind,version,digest,binding,phase,business,catalog,journal,logValue')||state.kind!==KIND||state.version!==VERSION||state.digest!==digest||state.binding!==binding||!PHASES.includes(state.phase))fail('APP_PREPARATION_STATE_INVALID');
  if(commandError&&state.phase!=='validate')fail('APP_PREPARATION_STATE_INVALID');
  const business=state.business,catalog=state.catalog,journal=state.journal;
  if(business!==null&&(!exact(business,'exists,version')||typeof business.exists!=='boolean'||!integer(business.version)||business.exists!==(business.version>0)||business.version!==c.expectedVersion))fail('APP_PREPARATION_STATE_INVALID');
  if(['validate','business'].includes(state.phase)?business!==null:business===null)fail('APP_PREPARATION_STATE_INVALID');
  if(catalog!==null&&(!exact(catalog,'nodeChecked,headVersion,first')||catalog.nodeChecked!==true||!(catalog.headVersion===null||integer(catalog.headVersion))||!(catalog.first===null||typeof catalog.first==='string')))fail('APP_PREPARATION_STATE_INVALID');
  if(catalog?.first!==null&&catalog?.first!==undefined)checkedDomainKey(catalog.first,'APP_PREPARATION_STATE_INVALID');
  if(catalog!==null&&business?.exists!==false)fail('APP_PREPARATION_STATE_INVALID');
  if(journal!==null&&(!exact(journal,'headVersion,seq,slotVersion')||!Number.isSafeInteger(journal.headVersion)||journal.headVersion<1||!Number.isSafeInteger(journal.seq)||journal.seq<1||!(journal.slotVersion===null||integer(journal.slotVersion))))fail('APP_PREPARATION_STATE_INVALID');
  if(journal!==null&&boundBase.writerFence!==2)fail('APP_PREPARATION_STATE_INVALID');
  const scalar=typeof state.logValue==='boolean'||typeof state.logValue==='number'&&Number.isFinite(state.logValue)&&state.logValue>=0&&state.logValue<=1000000;
  if(state.logValue!==null&&(!scalar||parsed?.kind!=='habitLog'||c.deleted||state.logValue!==c.value))fail('APP_PREPARATION_STATE_INVALID');
  if(['validate','business','parent'].includes(state.phase)&&state.logValue!==null)fail('APP_PREPARATION_STATE_INVALID');
  if(!['validate','business','parent'].includes(state.phase)&&parsed?.kind==='habitLog'&&!c.deleted&&!scalar)fail('APP_PREPARATION_STATE_INVALID');
  if(['validate','business','parent','catalog-node'].includes(state.phase)&&catalog!==null)fail('APP_PREPARATION_STATE_INVALID');
  if(['validate','business','parent','catalog-node','catalog-head','journal-head'].includes(state.phase)&&journal!==null)fail('APP_PREPARATION_STATE_INVALID');
  if(state.phase==='parent'&&(parsed?.kind!=='habitLog'||c.deleted)||['catalog-node','catalog-head'].includes(state.phase)&&business?.exists!==false)fail('APP_PREPARATION_STATE_INVALID');
  if(state.phase==='catalog-head'&&(!catalog||catalog.headVersion!==null||catalog.first!==null))fail('APP_PREPARATION_STATE_INVALID');
  if(['journal-head','journal-slot','ready'].includes(state.phase)&&business?.exists===false&&(!catalog||!integer(catalog.headVersion)))fail('APP_PREPARATION_STATE_INVALID');
  if(state.phase==='journal-head'&&journal!==null||state.phase==='journal-slot'&&(!journal||journal.slotVersion!==null))fail('APP_PREPARATION_STATE_INVALID');
  if(['journal-head','journal-slot'].includes(state.phase)&&boundBase.writerFence!==2)fail('APP_PREPARATION_STATE_INVALID');
  if(catalog&&catalog.first===c?.key)fail('APP_PREPARATION_STATE_INVALID');
  if(state.phase==='ready'&&boundBase.writerFence===2&&(!journal||!integer(journal.slotVersion)))fail('APP_PREPARATION_STATE_INVALID');
  return copy(state);
 }
 const progress=(state,phase,patch={})=>({kind:'progress',state:{...state,...patch,phase}});
 const afterValue=state=>state.business.exists?(boundBase.writerFence===2?'journal-head':'ready'):'catalog-node';
 const afterCatalog=()=>boundBase.writerFence===2?'journal-head':'ready';
 function normalize(habit){try{const value=validateEntity(c.key,c.value,habit);if(utf8ByteLength(canonical(value))>128*1024)return {error:'WRITER_VALUE_TOO_LARGE'};return {value};}catch(error){return {error:valueError(error)};}}
 function ready(state){
  let value=null;
  if(!c.deleted){if(parsed.kind==='habitLog')value=state.logValue;else{const normalized=normalize();if(normalized.error)return rejected(normalized.error);value=normalized.value;}}
  const changes=[{key:'app/data/'+c.key,expectedVersion:c.expectedVersion,deleted:c.deleted,value,...(c.recreate?{recreate:true}:{})}];
  if(!state.business.exists){changes.push({key:'app/catalog/'+c.key,expectedVersion:0,value:{key:c.key,next:state.catalog.first}},{key:HEAD,expectedVersion:state.catalog.headVersion,value:{first:c.key}});}
  const result={key:c.key,version:c.expectedVersion+1,deleted:c.deleted};
  if(boundBase.writerFence===2){const seq=state.journal.seq;changes.push({key:syncAppChangeSlot(seq),expectedVersion:state.journal.slotVersion,value:{seq,key:c.key,version:c.expectedVersion+1,deleted:c.deleted}},{key:SYNC_APP_CHANGE_HEAD,expectedVersion:state.journal.headVersion,value:{protocol:2,seq,floor:Math.max(1,seq-SYNC_APP_CHANGE_CAPACITY+1),capacity:SYNC_APP_CHANGE_CAPACITY}});result.appSeq=seq;}
  return {kind:'ready',changes,result};
 }
 function advance(input,readEntity){
  if(typeof readEntity!=='function')fail('APP_PREPARATION_CONFIG_INVALID');
  const state=checkState(input);
  if(state.phase==='validate'){
   if(commandError)return rejected(commandError);
   if(c.store!==boundBase.storeId)return rejected('STORE_ID_MISMATCH');
   if(c.generation!==boundBase.datasetGeneration)return rejected('DATASET_GENERATION_MISMATCH');
   if(!boundBase.acceptedEpochs.includes(c.epoch))return rejected('OPERATION_EPOCH_EXPIRED');
   return progress(state,'business');
  }
  if(state.phase==='business'){
   const old=checkedEntity(readEntity('app/data/'+c.key),'app/data/'+c.key,'APP_ENTITY_CORRUPT');
   if((old?.version??0)!==c.expectedVersion)return rejected('ENTITY_VERSION_CONFLICT');
   if(c.expectedVersion===Number.MAX_SAFE_INTEGER)fail('APP_ENTITY_VERSION_EXHAUSTED');
   if(c.deleted&&(c.value!==null||!old||old.deleted))return rejected('ENTITY_MISSING');
   if(c.deleted&&['settings','garden','habit'].includes(parsed.kind))return rejected('ENTITY_DELETE_FORBIDDEN');
   if(!c.deleted&&old?.deleted&&!c.recreate)return rejected('ENTITY_TOMBSTONED');
   const business={exists:!!old,version:old?.version??0},next={...state,business};
   if(!c.deleted&&parsed.kind==='habitLog')return progress(next,'parent');
   if(!c.deleted){const normalized=normalize();if(normalized.error)return rejected(normalized.error);if(parsed.kind==='habit'&&old&&!old.deleted){if(!old.value||!['check','number','time'].includes(old.value.type))fail('APP_ENTITY_CORRUPT');if(old.value.type!==normalized.value.type)return rejected('HABIT_TYPE_IMMUTABLE');}}
   return progress(next,afterValue(next));
  }
  if(state.phase==='parent'){
   const key='app/data/habit:'+parsed.id,habit=checkedEntity(readEntity(key),key,'APP_ENTITY_CORRUPT');
   if(!habit||habit.deleted)return rejected('HABIT_MISSING');
   let definition;try{definition=validateEntity('habit:'+parsed.id,habit.value);}catch{fail('APP_ENTITY_CORRUPT');}
   const normalized=normalize(definition);if(normalized.error)return rejected(normalized.error);
   return progress(state,afterValue(state),{logValue:normalized.value});
  }
  if(state.phase==='catalog-node'){
   const key='app/catalog/'+c.key,node=checkedEntity(readEntity(key),key,'CATALOG_CORRUPT');
   if(node!==null)fail('CATALOG_CORRUPT');
   return progress(state,'catalog-head',{catalog:{nodeChecked:true,headVersion:null,first:null}});
  }
  if(state.phase==='catalog-head'){
   const head=checkedEntity(readEntity(HEAD),HEAD,'CATALOG_CORRUPT');
   if(head&&(head.deleted||!exact(head.value,'first')||head.value.first!==null&&typeof head.value.first!=='string'))fail('CATALOG_CORRUPT');
   const first=head?.value.first??null;if(first!==null)checkedDomainKey(first,'CATALOG_CORRUPT');if(first===c.key)fail('CATALOG_CORRUPT');
   if(head?.version===Number.MAX_SAFE_INTEGER)fail('APP_CATALOG_VERSION_EXHAUSTED');
   return progress(state,afterCatalog(),{catalog:{nodeChecked:true,headVersion:head?.version??0,first}});
  }
  if(state.phase==='journal-head'){
   const entity=checkedEntity(readEntity(SYNC_APP_CHANGE_HEAD),SYNC_APP_CHANGE_HEAD,'APP_JOURNAL_CORRUPT'),head=validateSyncAppChangeHead(entity),seq=head.seq+1;
   if(!Number.isSafeInteger(seq))fail('APP_SEQUENCE_EXHAUSTED');
   return progress(state,'journal-slot',{journal:{headVersion:entity.version,seq,slotVersion:null}});
  }
  if(state.phase==='journal-slot'){
   const seq=state.journal.seq,key=syncAppChangeSlot(seq),slot=checkedEntity(readEntity(key),key,'APP_JOURNAL_CORRUPT');
   if(seq>SYNC_APP_CHANGE_CAPACITY&&!slot||slot&&(slot.deleted||!exact(slot.value,'seq,key,version,deleted')||slot.value.seq!==seq-SYNC_APP_CHANGE_CAPACITY||!Number.isSafeInteger(slot.value.version)||slot.value.version<1||typeof slot.value.deleted!=='boolean'))fail('APP_JOURNAL_CORRUPT');
   if(slot)checkedDomainKey(slot.value.key,'APP_JOURNAL_CORRUPT');
   if(slot?.version===Number.MAX_SAFE_INTEGER)fail('APP_JOURNAL_VERSION_EXHAUSTED');
   return progress(state,'ready',{journal:{...state.journal,slotVersion:slot?.version??0}});
  }
  if(state.phase==='ready')return ready(state);
  fail('APP_PREPARATION_STATE_INVALID');
 }
 return Object.freeze({initialState,advance});
}
