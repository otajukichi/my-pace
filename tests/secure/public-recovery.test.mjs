import test from 'node:test';
import assert from 'node:assert/strict';
import {gasWebFixture} from '../helpers/gas-web-fixture.mjs';
import {writerDigest} from '../../storage/reserved-writer.mjs';
const pull={cursor:null,since:null,minimumAcknowledged:null};
const seed=tail=>rt=>{rt.writer.checkpoint({operationId:'prepared',digest:writerDigest('prepared')});for(let n=0;n<tail;n++)rt.writer.transact({operationId:'tail_'+n,digest:writerDigest(n),changes:[{key:'internal-record',expectedVersion:n,value:n}]});};
for(const latency of [750,1000])for(const tail of [1,2,5,20])test(`generated recovery returns the first pull page without another cold cycle (${latency}ms, ${tail} tails)`,()=>{
 const f=gasWebFixture({readMs:latency,writeMs:latency,seed:seed(tail),activate:true});let page=null,recoveries=0;const progress=new Map(),outcomes=[];
 for(let attempt=0;attempt<12;attempt++){
  let action='pull',result=f.invoke(action,pull);outcomes.push({action,...f.last,error:result.error??null,recovery:result.recovery??null,hasResult:result.result!==undefined});
  assert(f.last.elapsedMs<45000);
  if(['STORE_YIELD','SYNC_BUDGET_YIELD'].includes(result.error)){action='recover';result=f.invoke(action,{pull});recoveries++;outcomes.push({action,...f.last,error:result.error??null,recovery:result.recovery??null,hasResult:result.result!==undefined});assert(f.last.elapsedMs<45000);}
  if(result.ok){page=result.result;break;}
  assert.equal(result.result,undefined,'uncommitted recovery progress must not expose a page');assert.equal(result.error,'WRITER_RECOVERY_PENDING',JSON.stringify({result,last:f.last}));assert.equal(result.retryable,true);assert.equal(result.recovery.cursorPersisted,true);assert.equal(result.recovery.cursorAdvanced,true);
  const p=result.recovery,key=p.phase,marker=p.revision??p.indexLinks;if(progress.has(key))assert(marker>progress.get(key),'durable recovery must advance');progress.set(key,marker);
 }
 assert(page,'no complete first page');assert.equal(outcomes.filter(o=>o.error===null).length,1,'only one successful complete page is returned');assert.equal(outcomes.at(-1).error,null,'no read follows the first successful page');if(recoveries===0){assert(outcomes.every(o=>o.action==='pull'&&o.elapsedMs<45000));assert(outcomes.slice(0,-1).every(o=>o.error==='WRITER_RECOVERY_PENDING'&&!o.hasResult&&o.recovery?.cursorPersisted===true&&o.recovery.cursorAdvanced===true));}assert.equal(page.protocol,2);assert.equal(page.mode,'snapshot');assert.equal(page.targetSeq,0);assert.equal(page.checkpoint.seq,0);assert.equal(page.nextCursor,null);assert.deepEqual(page.entries,[]);assert.equal(page.ready,undefined);
 console.log(JSON.stringify({model:'public-recovery',latency,tail,recoveries,outcomes}));
});

test('slow combined recovery never reports ready or publishes a partial page without a cursor',()=>{
 const f=gasWebFixture({readMs:5000,writeMs:5000,seed:seed(1),activate:true});for(let attempt=0;attempt<3;attempt++){const r=f.invoke('recover',{pull});assert.equal(r.ok,false);assert.equal(r.retryable,true);assert(['STORE_YIELD','SYNC_BUDGET_YIELD','WRITER_RECOVERY_PENDING','STORE_READ_UNRESOLVED'].includes(r.error));assert.equal(r.result,undefined);assert.equal(r.requiresOwnerAction,undefined);assert(f.last.elapsedMs<45000);}
});

test('recover accepts diagnostic empty payload but rejects unknown, nested and continuation actions before Drive IO',()=>{
 const f=gasWebFixture({activate:true});for(const bad of [{action:'pull',payload:pull},{pull:{...pull,cursor:'opaque'}},{pull:{...pull,fileId:'unknown'}},{pull,other:true},{pull:null}]){const before=f.restCalls.length,r=f.invoke('recover',bad);assert.equal(r.ok,false);assert.equal(r.error,'PAYLOAD_INVALID');assert.equal(f.restCalls.length,before);}
 const diagnostic=f.invoke('recover',{});assert.equal(diagnostic.ok,true);assert.equal(diagnostic.result.ready,true);assert.equal(diagnostic.result.entries,undefined);
});

test('combined pull retains exact identity and minimum-acknowledgement validation',()=>{
 const f=gasWebFixture({activate:true}),baseline=f.invoke('recover',{pull});assert.equal(baseline.ok,true);const p=baseline.result;
 const foreign=f.invoke('recover',{pull:{...pull,since:{store:'other',generation:p.generation,seq:0}}});assert.equal(foreign.error,'RESET_REQUIRED');assert.equal(foreign.resetReason,'identity-changed');
 const wrong=f.invoke('recover',{pull:{...pull,minimumAcknowledged:{store:p.store,generation:p.generation,revision:p.revision,hash:'0'.repeat(64)}}});assert.equal(wrong.error,'WRITER_ACKNOWLEDGEMENT_MISMATCH');
 const exact=f.invoke('recover',{pull:{...pull,minimumAcknowledged:{store:p.store,generation:p.generation,revision:p.revision,hash:p.headHash}}});assert.equal(exact.ok,true);assert.equal(exact.result.headHash,p.headHash);
});

test('ordinary record pull has the full bounded recovery budget, without a throwaway short prefix',()=>{
 const f=gasWebFixture({readMs:1500,writeMs:1500,seed:seed(1),activate:true});
 const ordinary=f.invoke('pull',pull);assert.equal(ordinary.ok,true,JSON.stringify({ordinary,last:f.last}));assert.equal(ordinary.result.protocol,2);assert.equal(ordinary.result.mode,'snapshot');assert.equal(ordinary.result.checkpoint.seq,0);assert.equal(ordinary.result.nextCursor,null);assert.deepEqual(ordinary.result.entries,[]);assert.equal(ordinary.result.ready,undefined);assert(f.last.elapsedMs<45000);
 const recovered=f.invoke('recover',{pull});assert.equal(recovered.ok,true);assert.equal(recovered.result.headHash,ordinary.result.headHash);
});
