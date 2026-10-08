import test from 'node:test';
import assert from 'node:assert/strict';
import {entitiesToState,stateToEntities,parseKey} from '../../src/lib/entity-codec.js';
import {createInitialState,validateState,upsertHabitLog} from '../../src/lib/domain.js';
const forbidden=['__proto__','constructor','prototype'];
const names=Object.getOwnPropertyNames(Object.prototype).filter(id=>typeof Object.prototype[id]==='function'&&!forbidden.includes(id));
for(const id of names)for(const type of ['check','number','time'])test(`inherited-name habit ${id}/${type} preserves logs without touching shared methods`,()=>{
 const state=createInitialState();state.habits=[{id,name:'Habit',type,unit:type==='time'?'min':'',target:1,archived:false}];state.habitLogs={[id]:{'2026-10-07':type==='check'?true:5}};
 const valid=validateState(state),entities=stateToEntities(valid);assert.deepEqual(entitiesToState(entities),valid);assert.equal(Object.hasOwn(Object.prototype[id],'2026-10-07'),false);
 const fresh=createInitialState();fresh.habits=valid.habits;assert.deepEqual(upsertHabitLog(fresh,id,'2026-10-08',type==='check'?false:2).habitLogs[id],{'2026-10-08':type==='check'?false:2});
});
for(const id of forbidden)test(`unsafe identifier ${id} still rejected`,()=>{assert.throws(()=>parseKey('habit:'+id),/ENTITY_KEY_INVALID/);assert.throws(()=>parseKey('habitLog:'+id+':2026-10-07'),/ENTITY_KEY_INVALID/);});
for(const kind of ['habit','run','event'])test(`absent ${kind} ID fails but literal undefined ID remains valid`,()=>{assert.throws(()=>parseKey(kind),/ENTITY_KEY_INVALID/);assert.equal(parseKey(kind+':undefined').id,'undefined');});
test('orphan inherited-name log does not mutate shared methods',()=>{assert.deepEqual(entitiesToState({'habitLog:toString:2026-10-07':true}).habitLogs,{});assert.equal(Object.hasOwn(Object.prototype.toString,'2026-10-07'),false);});
