import {clone,canonical} from './entity-codec.js';
function patchList(list,puts=[],deletes=[],key){const result=list.filter(value=>!deletes.includes(key(value)));for(const value of puts){const index=result.findIndex(old=>key(old)===key(value));if(index<0)result.push(clone(value));else result[index]=clone(value);}return result;}
export function applyOwnerPatch(owner,patch){
 if(patch.meta)Object.assign(owner,clone(patch.meta));
 for(const key of patch.entitiesDelete||[])delete owner.entities[key];
 for(const entity of patch.entitiesPut||[])owner.entities[entity.key]=clone(entity);
 owner.outbox=patchList(owner.outbox,patch.outboxPut,patch.outboxDelete,x=>x.command.operationId);
 owner.conflicts=patchList(owner.conflicts,patch.conflictsPut,patch.conflictsDelete,x=>x.key);
 if(patch.snapshotDiscard&&owner.snapshotStage?.id===patch.snapshotDiscard){owner.snapshotStage=null;delete owner._snapshotEntities;delete owner._snapshotPages;}
 if(patch.snapshot){
  const s=patch.snapshot;
  if(!owner.snapshotStage){if(s.page!==0)throw Error('SNAPSHOT_STAGE_MISSING');owner.snapshotStage={id:s.id,nextPage:0,meta:null};owner._snapshotEntities={};owner._snapshotPages=[];}
  if(owner.snapshotStage.id!==s.id)throw Error('SNAPSHOT_STAGE_CHANGED');
  const signature=canonical(s);
  if(s.page<owner.snapshotStage.nextPage){if(owner._snapshotPages[s.page]!==signature)throw Error('SNAPSHOT_STAGE_PAGE_CHANGED');return;}
  if(s.page!==owner.snapshotStage.nextPage)throw Error('SNAPSHOT_STAGE_PAGE_ORDER');
  for(const entity of s.entities){if(Object.hasOwn(owner._snapshotEntities,entity.key))throw Error('SNAPSHOT_STAGE_DUPLICATE');owner._snapshotEntities[entity.key]=clone(entity);}
  owner._snapshotPages.push(signature);owner.snapshotStage={id:s.id,nextPage:s.page+1,meta:clone(s.meta??null)};
  if(s.complete){owner.entities=owner._snapshotEntities;delete owner._snapshotEntities;delete owner._snapshotPages;owner.snapshotStage=null;}
 }
}
// Test/embedding compatibility. The production implementation uses keyed IDB
// stores; legacy injected adapters keep their original atomic callback contract.
export function patchStorage(storage){
 if(typeof storage.apply==='function')return storage;
 return {async read(options){const data=await storage.read();data.localRevision??=0;return options?{kind:'full',localRevision:data.localRevision,data}:data;},async apply(patch){return storage.update(data=>{data.localRevision??=0;if(data.localRevision!==patch.expectedVersion)throw Error('LOCAL_STATE_CHANGED');applyOwnerPatch(data,patch);data.localRevision++;return {localRevision:data.localRevision};});},close(){storage.close?.();}};
}
export function applyReadDelta(data,delta){if(delta.kind==='full')return delta.data;applyOwnerPatch(data,delta);data.localRevision=delta.localRevision;return data;}
