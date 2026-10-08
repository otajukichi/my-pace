import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,LIMITS} from '../../src/lib/domain.js';
import {clone,entitiesToState,stateToEntities} from '../../src/lib/entity-codec.js';
import {projectIncremental} from '../../src/lib/cloud-projection.js';

const entity=(key,value,deleted=false)=>({key,value,deleted,version:1});
const queued=(key,value,deleted=false,status='pending')=>({command:{...entity(key,value,deleted),operationId:crypto.randomUUID()},status});
const full=(entities,outbox=[])=>{
 const values={};
 for(const [key,entry] of Object.entries(entities))if(!entry.deleted)values[key]=clone(entry.value);
 for(const item of outbox){if(item.command.deleted)delete values[item.command.key];else values[item.command.key]=clone(item.command.value);}
 return entitiesToState(values);
};
const baseline=state=>Object.fromEntries(Object.entries(stateToEntities(state)).map(([key,value])=>[key,entity(key,value)]));
const sample=()=>{
 const state=createInitialState();
 state.wake={'2026-10-06':'07:00','2026-10-07':'07:15'};
 state.diary={'2026-10-06':{text:'Yesterday',mood:'calm'},'2026-10-07':{text:'Today',mood:null}};
 state.settings.wakeTarget='07:30';state.garden={plant:'sunflower',theme:'dusk'};
 state.habits=[{id:'walk',name:'Walk',type:'check',unit:'',target:1,archived:false}];
 state.habitLogs={walk:{'2026-10-07':true}};
 state.runs=[{id:'r',date:'2026-10-07',distanceKm:2,durationSec:700,note:'',points:[{lat:35,lon:139,segment:0}]}];
 state.events=[{id:'e',date:'2026-10-07',time:null,title:'Event',note:''}];
 return state;
};
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}
function expectProjection(previous,entities,outbox,keys){
 const next=projectIncremental(previous,entities,outbox,keys);
 assert.notEqual(next,null);assert.deepEqual(next,full(entities,outbox));return next;
}

test('sparse edits match full projection and copy only changed branches/records',()=>{
 const entities=baseline(sample()),previous=full(entities);
 const outbox=[queued('diary:2026-10-07',{text:'Edited'}),queued('wake:2026-10-06','06:45')];
 freeze(previous);freeze(entities);freeze(outbox);
 const next=expectProjection(previous,entities,outbox,new Set(['diary:2026-10-07','wake:2026-10-06']));
 assert.notEqual(next,previous);assert.notEqual(next.wake,previous.wake);assert.notEqual(next.diary,previous.diary);
 assert.equal(next.diary['2026-10-06'],previous.diary['2026-10-06']);
 assert.notEqual(next.diary['2026-10-07'],outbox[0].command.value);
 for(const key of ['settings','garden','habits','habitLogs','runs','events'])assert.equal(next[key],previous[key]);
 assert.deepEqual(next.diary['2026-10-07'],{text:'Edited',mood:null});
});

test('empty dirty keys, duplicate keys and normalized equivalent edits retain identity',()=>{
 const entities=baseline(sample()),previous=full(entities);
 assert.equal(projectIncremental(previous,entities,[],[]),previous);
 const outbox=[queued('diary:2026-10-07',{text:'Today'}),queued('garden:preferences',{theme:'dusk',plant:'sunflower'})];
 assert.equal(expectProjection(previous,entities,outbox,['diary:2026-10-07','garden:preferences','diary:2026-10-07']),previous);
});

test('last outbox command wins over baseline regardless of queue status',()=>{
 const entities=baseline(sample()),previous=full(entities),key='diary:2026-10-07';
 const outbox=[queued(key,{text:'First',mood:'bright'}),queued(key,null,true),queued(key,{text:'Recreated'},false,'conflict')];
 const next=expectProjection(previous,entities,outbox,[key]);
 assert.deepEqual(next.diary['2026-10-07'],{text:'Recreated',mood:null});
 const finalDelete=[...outbox,queued(key,{unvalidated:'ignored tombstone'},true)];
 assert.equal(Object.hasOwn(expectProjection(next,entities,finalDelete,[key]).diary,'2026-10-07'),false);
});

test('domain-invalid overwritten values are ignored just like full projection',()=>{
 const entities=baseline(sample()),previous=full(entities),key='wake:2026-10-07';
 entities[key]=entity(key,'invalid baseline');
 const outbox=[queued(key,'invalid intermediate'),queued(key,'07:15')];
 assert.equal(expectProjection(previous,entities,outbox,[key]),previous);
});

test('acknowledgment and removing the last queue item recover the exact baseline value',()=>{
 const entities=baseline(sample()),key='diary:2026-10-07',outbox=[queued(key,{text:'Pending'})];
 const before=full(entities,outbox);
 entities[key]=entity(key,{text:'Pending',mood:null});entities[key].version=2;
 assert.equal(expectProjection(before,entities,[],[key]),before);
 entities[key]=entity(key,{text:'Remote',mood:'bright'});
 const next=expectProjection(before,entities,[],[key]);
 assert.deepEqual(next.diary['2026-10-07'],{text:'Remote',mood:'bright'});
});

test('baseline tombstones, absent baseline and pending deletes remove supported keys',()=>{
 for(const key of ['wake:2026-10-07','diary:2026-10-07']){
  for(const mode of ['tombstone','missing','pending']){
   const entities=baseline(sample()),previous=full(entities),outbox=[];
   if(mode==='tombstone')entities[key]=entity(key,null,true);
   if(mode==='missing')delete entities[key];
   if(mode==='pending')outbox.push(queued(key,null,true));
   const next=expectProjection(previous,entities,outbox,[key]),kind=key.split(':')[0];
   assert.equal(Object.hasOwn(next[kind],'2026-10-07'),false);
   assert.equal(expectProjection(next,entities,outbox,[key]),next);
  }
 }
});

test('settings and garden deletion/absence restore the full codec defaults',()=>{
 for(const key of ['settings:wakeTarget','garden:preferences']){
  for(const mode of ['tombstone','missing','pending']){
   const entities=baseline(sample()),previous=full(entities),outbox=[];
   if(mode==='tombstone')entities[key]=entity(key,null,true);
   if(mode==='missing')delete entities[key];
   if(mode==='pending')outbox.push(queued(key,null,true));
   const next=expectProjection(previous,entities,outbox,[key]),kind=key.split(':')[0];
   assert.deepEqual(next[kind],createInitialState()[kind]);
   assert.equal(expectProjection(next,entities,outbox,[key]),next);
  }
 }
});

test('settings and garden changes preserve untouched paths and detach changed values',()=>{
 const entities=baseline(sample()),previous=full(entities);
 const outbox=[queued('settings:wakeTarget',null),queued('garden:preferences',{plant:'hydrangea',theme:'night'})];
 const next=expectProjection(previous,entities,outbox,['settings:wakeTarget','garden:preferences']);
 assert.notEqual(next.settings,previous.settings);assert.notEqual(next.garden,previous.garden);
 assert.notEqual(next.garden,outbox[1].command.value);
 assert.equal(next.wake,previous.wake);assert.equal(next.diary,previous.diary);
});

test('JSON normalization exactly matches the full projection before value validation',()=>{
 const entities=baseline(sample()),previous=full(entities),key='diary:2026-10-07';
 const outbox=[queued(key,{text:'Changed',mood:NaN,discarded:undefined})];
 assert.deepEqual(expectProjection(previous,entities,outbox,[key]).diary['2026-10-07'],{text:'Changed',mood:null});
});

test('complex dirty entity kinds always request full fallback, even for no-op deletes',()=>{
 const entities=baseline(sample()),previous=full(entities);
 for(const key of ['habit:walk','habitLog:walk:2026-10-07','run:r','event:e']){
  assert.equal(projectIncremental(previous,entities,[],[key]),null);
  assert.equal(projectIncremental(previous,entities,[queued(key,null,true)],[key]),null);
 }
});

test('invalid changed values and keys request authoritative validation without mutation',()=>{
 const entities=baseline(sample()),previous=freeze(full(entities));
 const invalid=[['wake:2026-10-07','25:00'],['diary:2026-10-07',{text:'x',mood:'unknown'}],
  ['diary:2026-10-07',{text:'x',extra:true}],['settings:wakeTarget','7:00'],
  ['garden:preferences',{plant:'cosmos',theme:'invalid'}],['wake:2026-02-30','07:00'],
  ['__proto__:polluted','x'],['diary:2026-10-07',{text:'x'.repeat(LIMITS.diaryText+1)}]];
 for(const [key,value] of invalid){
  const outbox=[queued(key,value)];assert.equal(projectIncremental(previous,entities,outbox,[key]),null);
  assert.throws(()=>full(entities,outbox));
 }
});

test('unserializable touched overwritten input falls back rather than concealing full-codec errors',()=>{
 const entities=baseline(sample()),previous=full(entities),key='diary:2026-10-07';
 entities[key]=entity(key,undefined);
 const outbox=[queued(key,{text:'Valid final'})];
 assert.equal(projectIncremental(previous,entities,outbox,[key]),null);assert.throws(()=>full(entities,outbox));
});

test('unfamiliar state/container/command shapes fall back without changing input',()=>{
 const entities=baseline(sample()),previous=full(entities),key='wake:2026-10-07';
 for(const state of [null,{...previous,version:1},{...previous,extra:true},{...previous,settings:{}},
  {...previous,garden:{...previous.garden,rewards:10}},{...previous,wake:[]}])assert.equal(projectIncremental(state,entities,[],[key]),null);
 for(const keys of [null,{},'wake:2026-10-07',[null]])assert.equal(projectIncremental(previous,entities,[],keys),null);
 for(const outbox of [null,{},[{}],[{command:{key,deleted:'false',value:'07:00'}}]])assert.equal(projectIncremental(previous,entities,outbox,[key]),null);
 assert.equal(projectIncremental(previous,{...entities,[key]:{value:'07:00'}},[],[key]),null);
});

const dateAt=index=>new Date(Date.UTC(1900,0,1+index)).toISOString().slice(0,10);
test('aggregate wake/diary limits reject growth but allow replacement, removal and balanced edits',()=>{
 for(const kind of ['wake','diary']){
  const state=createInitialState(),value=kind==='wake'?'07:00':{text:'x',mood:null};
  for(let i=0;i<LIMITS[kind+'Days'];i++)state[kind][dateAt(i)]=value;
  const entities=baseline(state),previous=full(entities),added=kind+':'+dateAt(LIMITS[kind+'Days']);
  const outbox=[queued(added,value)];
  assert.equal(projectIncremental(previous,entities,outbox,[added]),null);assert.throws(()=>full(entities,outbox),/件数/);
  const removed=kind+':'+dateAt(0),balanced=[...outbox,queued(removed,null,true)];
  const next=expectProjection(previous,entities,balanced,[added,removed]);
  assert.equal(Object.keys(next[kind]).length,LIMITS[kind+'Days']);
  const reduced=expectProjection(next,entities,[queued(removed,null,true)],[added]);
  assert.equal(Object.keys(reduced[kind]).length,LIMITS[kind+'Days']-1);
 }
});

test('50,000 valid records: a sparse update never enumerates baseline entities or clones unrelated records',()=>{
 const state=createInitialState();
 for(let i=0;i<25000;i++){const date=dateAt(i);state.wake[date]='07:00';state.diary[date]={text:'Entry '+i,mood:null};}
 const entities=baseline(state),previous=full(entities),key='wake:'+dateAt(123);
 entities[key]=entity(key,'06:30');
 let reads=0;
 const keyedOnly=new Proxy(entities,{ownKeys(){throw Error('Unexpected whole-baseline scan');},get(target,name){reads++;return Reflect.get(target,name);}});
 const next=projectIncremental(previous,keyedOnly,[],[key]);
 assert.notEqual(next,null);assert.deepEqual(next,full(entities));
 assert.equal(reads,1);assert.equal(next.diary,previous.diary);assert.equal(next.runs,previous.runs);
 assert.equal(next.wake[dateAt(123)],'06:30');
});

test('deterministic randomized baseline/queue deletes, recreates and acknowledgments match full projection',()=>{
 let seed=0x512aec;
 const random=max=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max;};
 const keys=['settings:wakeTarget','garden:preferences',...Array.from({length:10},(_,i)=>'wake:'+dateAt(i)),...Array.from({length:10},(_,i)=>'diary:'+dateAt(i))];
 const value=key=>key.startsWith('wake:')||key.startsWith('settings:')?['06:00','07:15','08:30'][random(3)]:
  key.startsWith('diary:')?{text:'Text '+random(7),...(random(2)?{mood:['bright','calm','tired','low',null][random(5)]}:{})}:
  {plant:['cosmos','sunflower','hydrangea'][random(3)],theme:['day','dusk','night'][random(3)]};
 const entities={},outbox=[];let previous=full(entities);
 for(let step=0;step<600;step++){
  const dirty=new Set();
  for(let operation=0,count=1+random(4);operation<count;operation++){
   const key=keys[random(keys.length)],mode=random(5);dirty.add(key);
   if(mode===0)entities[key]=entity(key,value(key),random(4)===0);
   else if(mode===1)delete entities[key];
   else if(mode===2||!outbox.length)outbox.push(queued(key,value(key),random(4)===0,random(3)?'pending':'conflict'));
   else{
    const index=random(outbox.length),[removed]=outbox.splice(index,1);dirty.add(removed.command.key);
    if(mode===3)entities[removed.command.key]=entity(removed.command.key,removed.command.value,removed.command.deleted);
   }
  }
  const before=JSON.stringify(previous),next=expectProjection(previous,entities,outbox,dirty);
  assert.equal(JSON.stringify(previous),before,'previous state changed at step '+step);
  if(JSON.stringify(next)===before)assert.equal(next,previous);
  previous=next;
 }
});
