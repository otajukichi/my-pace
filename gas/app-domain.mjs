import {canonical,parseKey,validateEntity} from '../src/lib/entity-codec.js';
const fail=code=>{const e=Error(code);e.code=code;throw e;};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.split(',').sort().join(',');
const HEAD='app/catalog/head';const node=key=>'app/catalog/'+key;const data=key=>'app/data/'+key;
export function createAppDomain({writer,locked,digest}){
 if(!writer||typeof locked!=='function'||typeof digest!=='function')fail('DOMAIN_CONFIG');
 return {
 command(c){return locked(()=>{
  if(!exact(c,'operationId,epoch,generation,store,key,expectedVersion,deleted,value,recreate')||!/^[-a-zA-Z0-9_]{16,100}$/.test(c.operationId)||!/^[-a-zA-Z0-9_]{1,100}$/.test(c.epoch)||typeof c.store!=='string'||typeof c.generation!=='string'||!Number.isSafeInteger(c.expectedVersion)||c.expectedVersion<0||typeof c.deleted!=='boolean'||typeof c.recreate!=='boolean')fail('COMMAND_INVALID');
  const parsed=parseKey(c.key);writer.recoveryBarrier();const hash=digest(canonical(c));
  // Receipt replay MUST precede generation/version/domain-state checks.
  const prior=writer.getReceipt(c.operationId,c.epoch);if(prior){if(prior.digest!==hash)fail('OP_ID_REUSED');return prior;}
  const status=writer.status();if(c.store!==status.storeId)fail('STORE_ID_MISMATCH');if(c.generation!==status.datasetGeneration)fail('DATASET_GENERATION_MISMATCH');
  if(!status.acceptedEpochs.includes(c.epoch))fail('OPERATION_EPOCH_EXPIRED');
  const old=writer.getEntity(data(c.key));if((old?.version??0)!==c.expectedVersion)fail('ENTITY_VERSION_CONFLICT');
  if(c.deleted&&(c.value!==null||!old||old.deleted))fail('ENTITY_MISSING');
  if(c.deleted&&['settings','garden','habit'].includes(parsed.kind))fail('ENTITY_DELETE_FORBIDDEN'); // Archive habits; preserves historical log types.
  let value=null;
  if(!c.deleted){const habit=parsed.kind==='habitLog'?writer.getEntity(data('habit:'+parsed.id)):null;if(parsed.kind==='habitLog'&&(!habit||habit.deleted))fail('HABIT_MISSING');value=validateEntity(c.key,c.value,habit?.value);if(parsed.kind==='habit'&&old&&!old.deleted&&old.value.type!==value.type)fail('HABIT_TYPE_IMMUTABLE');}
  const changes=[{key:data(c.key),expectedVersion:c.expectedVersion,deleted:c.deleted,value,...(c.recreate?{recreate:true}:{})}];
  if(!old){const head=writer.getEntity(HEAD);changes.push({key:node(c.key),expectedVersion:0,value:{key:c.key,next:head?.value.first??null}},{key:HEAD,expectedVersion:head?.version??0,value:{first:c.key}});}
  return writer.transact({operationId:c.operationId,epoch:c.epoch,datasetGeneration:c.generation,digest:hash,changes,result:{key:c.key,version:c.expectedVersion+1,deleted:c.deleted}});
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
