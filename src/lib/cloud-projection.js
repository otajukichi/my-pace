import {createInitialState,LIMITS,STATE_VERSION} from './domain.js';
import {clone,parseKey,validateEntity} from './entity-codec.js';

const stateKeys=Object.keys(createInitialState());
const plain=value=>value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype;
const shape=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

// This is a shape/version guard, not a replacement for validateState. The caller
// must supply its last successfully validated, canonical projection and every
// key affected since that projection. Full reads/resets must use the full codec.
function knownState(state){
 return shape(state,stateKeys)&&state.version===STATE_VERSION&&
  shape(state.settings,['wakeTarget'])&&shape(state.garden,['plant','theme'])&&
  plain(state.wake)&&plain(state.diary)&&plain(state.habitLogs)&&
  Array.isArray(state.runs)&&Array.isArray(state.habits)&&Array.isArray(state.events);
}

function sameValue(kind,before,after){
 if(kind==='diary')return shape(before,['text','mood'])&&before.text===after.text&&before.mood===after.mood;
 if(kind==='garden')return before.plant===after.plant&&before.theme===after.theme;
 return before===after;
}

/**
 * Project known sparse changes over an already validated state without cloning
 * unrelated records. Only independent wake/diary/settings/garden entities are
 * supported. null requests authoritative entitiesToState/validateState fallback.
 * Inputs are never mutated; unchanged projections retain their exact identity.
 * A changed dictionary is shallow-copied once, so its existing record values
 * remain shared. No hidden cache, trusted-count metadata, or schema bypass is used.
 */
export function projectIncremental(previousState,entities,outbox,changedKeys){
 try{
  if(!knownState(previousState)||!plain(entities)||!Array.isArray(outbox)||
    !(Array.isArray(changedKeys)||changedKeys instanceof Set))return null;
  const changed=new Map();
  for(const key of changedKeys){
   const parsed=parseKey(key);
   if(!['wake','diary','settings','garden'].includes(parsed.kind))return null;
   changed.set(key,parsed);
  }
  if(!changed.size)return previousState;

  // Mirror baseline -> ordered outbox application, including JSON normalization
  // of overwritten values. Only the final visible value needs domain validation.
  const values=new Map();
  for(const key of changed.keys()){
   if(!Object.hasOwn(entities,key))continue;
   const entity=entities[key];
   if(!plain(entity)||typeof entity.deleted!=='boolean')return null;
   if(!entity.deleted)values.set(key,clone(entity.value));
  }
  for(const item of outbox){
   const command=item?.command;
   if(!plain(command)||typeof command.key!=='string'||typeof command.deleted!=='boolean')return null;
   if(!changed.has(command.key))continue;
   if(command.deleted)values.delete(command.key);
   else values.set(command.key,clone(command.value));
  }

  const defaults=createInitialState(),edits=[],countDelta={wake:0,diary:0};
  for(const [key,{kind,id}] of changed){
   let present=values.has(key),value;
   if(present)value=validateEntity(key,values.get(key));
   else if(kind==='settings'){present=true;value=defaults.settings.wakeTarget;}
   else if(kind==='garden'){present=true;value=defaults.garden;}
   const dictionary=kind==='wake'||kind==='diary';
   const before=dictionary?previousState[kind][id]:kind==='settings'?previousState.settings.wakeTarget:previousState.garden;
   const wasPresent=dictionary?Object.hasOwn(previousState[kind],id):true;
   if(wasPresent===present&&(!present||sameValue(kind,before,value)))continue;
   if(dictionary)countDelta[kind]+=Number(present)-Number(wasPresent);
   edits.push({kind,id,present,value});
  }
  // Unchanged/removed entries cannot increase a known-valid aggregate. For new
  // entries, count the touched dictionary, never records in unrelated branches.
  for(const kind of ['wake','diary'])if(countDelta[kind]>0&&
   Object.keys(previousState[kind]).length+countDelta[kind]>LIMITS[kind+'Days'])return null;
  if(!edits.length)return previousState;
  const next={...previousState},copied=new Set();
  for(const {kind,id,present,value} of edits){
   if(kind==='garden'){next.garden=value;continue;}
   if(!copied.has(kind)){next[kind]={...previousState[kind]};copied.add(kind);}
   if(present)next[kind][kind==='settings'?'wakeTarget':id]=value;
   else delete next[kind][id];
  }
  return next;
 }catch{
  // Unknown/malformed data must still take the existing full validation path,
  // which owns the error message and fail-closed behavior.
  return null;
 }
}
