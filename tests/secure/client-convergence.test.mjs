import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudEndpointFixture} from '../helpers/cloud-endpoint-fixture.mjs';
import {entitiesToState,clone} from '../../src/lib/entity-codec.js';
const projection=data=>{const values={};for(const [key,entry]of Object.entries(data.entities))if(!entry.deleted)values[key]=clone(entry.value);for(const q of data.outbox)if(q.command.deleted)delete values[q.command.key];else values[q.command.key]=clone(q.command.value);return entitiesToState(values);};
const day=n=>'2026-10-'+String(n+1).padStart(2,'0');
const steps=Number(process.env.MYPACE_CONVERGENCE_STEPS||100);assert(Number.isInteger(steps)&&steps>=100&&steps<=5000);
for(const initialSeed of [0x512abc,0x61def0,0xabc729])test(`three independent profiles converge across deterministic offline/restart/ACK-loss schedule ${initialSeed}`,{timeout:600000},async t=>{
 let seed=initialSeed;const random=max=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)%max;};
 const f=cloudEndpointFixture({activate:true}),accepted=new Map(),truth={},profiles=[],counters={edits:0,restarts:0,lostAcks:0,resolutions:0,offline:0},revision=new Map();let sequence=0;
 const make=idb=>{const c=f.profile(idb?{idb}:{});c.drop=false;c.hooks.after=(request,response)=>{
  if(request.action==='command'&&response.body.ok){
   const op=request.payload,receipt=response.body.result,prior=accepted.get(op.operationId);
   if(prior)assert.deepEqual(prior,{op,receipt},'replay must return the same original receipt');
   else{accepted.set(op.operationId,{op:structuredClone(op),receipt:structuredClone(receipt)});assert.equal(receipt.result.appSeq,++sequence);if(op.deleted)delete truth[op.key];else truth[op.key]=clone(op.value);}
   if(c.drop){c.drop=false;counters.lostAcks++;throw Error('synthetic response lost');}
  }
 };return c;};
 for(let i=0;i<3;i++){const c=make();profiles.push(c);await c.a.init();await c.a.maintenance();}
 const audit=(c,before,explicit=new Set())=>{
  const data=c.idb.read();assert.deepEqual(c.a.state(),projection(data));assert((data.revision??0)>=(revision.get(c.idb)??0),'accepted local revision regressed');revision.set(c.idb,data.revision??0);
  const ids=new Set(data.outbox.map(q=>q.command.operationId));assert.equal(ids.size,data.outbox.length);
  for(const item of before)if(!ids.has(item.command.operationId))assert(accepted.has(item.command.operationId)||explicit.has(item.command.operationId),'pending intent disappeared without receipt or explicit conflict resolution');
  for(const item of data.outbox){const prior=before.find(q=>q.command.operationId===item.command.operationId);if(prior)assert.deepEqual(item.command,prior.command,'an ambiguous operation was rewritten');}
 };
 for(let step=0;step<steps;step++){
  const index=random(3);let c=profiles[index];const before=structuredClone(c.idb.read().outbox),explicit=new Set(),action=random(10);
  if(action<5){
   const kind=random(2)?'wake':'diary',date=day(random(7)),state=c.a.state(),branch={...state[kind]};
   if(random(6)===0&&Object.hasOwn(branch,date))delete branch[date];else branch[date]=kind==='wake'?['06:00','07:30','08:45'][random(3)]:{text:'Profile '+index+' step '+step+' seed '+initialSeed,mood:null};
   c.drop=random(5)===0;await c.a.commit(state,{...state,[kind]:branch});await c.a.sync({automatic:true});counters.edits++;
  }else if(action===5){c.n.offline=!c.n.offline;counters.offline++;await c.a.sync();}
  else if(action===6){await c.a.maintenance();const idb=c.idb,offline=c.n.offline;c.a.destroy();c=make(idb);c.n.offline=offline;profiles[index]=c;await c.a.init();counters.restarts++;}
  else if(action===7&&c.a.view().conflicts.length){
   const conflict=c.a.view().conflicts[0];for(const q of before)if(q.command.key===conflict.key)explicit.add(q.command.operationId);
   try{await c.a.resolveConflict(conflict.key,random(2)?'local':'remote',conflict);}catch(e){assert(['CONFLICT_REFRESH_REQUIRED','CONFLICT_PREVIEW_CHANGED'].includes(e.message));}await c.a.sync({automatic:true});counters.resolutions++;
  }else await c.a.sync();
  audit(c,before,explicit);
 }
 // Connectivity returns. Every ambiguity replays its original operation first;
 // only explicit, snapshot-bound conflict choices may replace an operation.
 for(const c of profiles){c.n.offline=false;c.drop=false;await c.a.refreshSession();for(let guard=0;c.a.view().conflicts.length&&guard<100;guard++){
  const conflict=c.a.view().conflicts[0];try{await c.a.resolveConflict(conflict.key,'local',conflict);}catch(e){assert.equal(e.message,'CONFLICT_PREVIEW_CHANGED');}await c.a.sync();counters.resolutions++;
 }assert.equal(c.a.view().pending,0,JSON.stringify({view:c.a.view(),outbox:c.idb.read().outbox}));assert.equal(c.a.view().conflicts.length,0);assert.equal(c.a.view().error,null);}
 for(const c of profiles){await c.a.sync();assert.equal(c.a.view().verified,true);assert.deepEqual(c.a.state(),entitiesToState(truth));assert.equal(c.idb.read().syncCheckpoint.seq,sequence);c.a.destroy();}
 assert(counters.restarts>0&&counters.offline>0&&counters.lostAcks>0&&counters.resolutions>0);t.diagnostic(JSON.stringify({initialSeed,steps,...counters,distinctAcceptedOperations:accepted.size,applicationSequence:sequence,scope:'actual auth/API/generated GAS; protocol-double profiles and storage'}));
});
