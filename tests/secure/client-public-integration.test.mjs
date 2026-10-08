import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cloudEndpointFixture} from '../helpers/cloud-endpoint-fixture.mjs';
import {createAppDomain} from '../../gas/app-domain.mjs';
import {writerDigest} from '../../storage/reserved-writer.mjs';
import {createIndexedDBStorage} from '../../src/lib/cloud-sync.js';
import {keyedIndexedDBDouble} from '../helpers/indexeddb-keyed-double.js';
const date='2026-10-07',edit=(a,text)=>({...a.state(),diary:{...a.state().diary,[date]:{text,mood:null}}});

test('client + real auth/API + generated GAS: isolated profiles converge across offline edits and explicit conflicts',async()=>{
 const f=cloudEndpointFixture({activate:true}),one=f.profile({authenticated:false}),two=f.profile({authenticated:false});
 await one.a.init();await two.a.init();assert.equal(one.a.view().authenticated,false);await one.login();await two.login();assert.equal(one.a.view().verified,true);
 one.n.offline=true;await one.a.commit(one.a.state(),edit(one.a,'offline first browser'));await one.a.sync({automatic:true});const operation=structuredClone(one.idb.read().outbox[0].command);
 await two.a.commit(two.a.state(),edit(two.a,'second browser saved'));await two.a.sync();one.n.offline=false;await one.a.sync();
 assert.equal(one.a.view().conflicts.length,1);assert.deepEqual(one.idb.read().outbox[0].command,operation);assert.equal(one.a.state().diary[date].text,'offline first browser');
 await one.a.resolveConflict('diary:'+date,'local',one.a.view().conflicts[0]);await one.a.sync();await two.a.sync();
 assert.equal(one.a.view().pending,0);assert.equal(two.a.state().diary[date].text,'offline first browser');assert.equal(one.idb.read().syncCheckpoint.seq,two.idb.read().syncCheckpoint.seq);
 assert.equal(f.calls.filter(c=>c.action==='command').length,3);await one.a.logout();assert.equal(one.a.view().authenticated,false);one.a.destroy();two.a.destroy();
});

test('client + public API + generated GAS: local receipt abort replays the exact durable operation',async()=>{
 const f=cloudEndpointFixture({activate:true}),c=f.profile();await c.a.init();await c.a.maintenance();let abort=true;
 c.hooks.after=(request,response)=>{if(request.action==='command'&&response.body.ok&&abort){abort=false;c.idb.fail();}};
 await c.a.commit(c.a.state(),edit(c.a,'remote committed, local ACK aborted'));await c.a.sync({automatic:true});assert.equal(c.a.view().pending,1);assert.equal(c.a.view().error,'IDB_QUOTA');
 const original=structuredClone(c.idb.read().outbox[0].command);c.a.destroy();const next=f.profile({idb:c.idb});await next.a.init();
 assert.equal(next.a.view().pending,0);assert.equal(next.idb.read().syncCheckpoint.seq,1);assert.deepEqual(f.calls.filter(c=>c.action==='command').map(c=>c.payload),[original,original]);assert.equal(next.idb.read().entities['diary:'+date].version,1);next.a.destroy();
});

test('client + public API + generated GAS: first-use migration is actionable and never implicitly activated',async()=>{
 const f=cloudEndpointFixture(),c=f.profile();await c.a.init();assert.equal(c.a.view().error,'SYNC_V2_MIGRATION_REQUIRED');assert.equal(c.a.view().automaticPaused,true);assert.equal(c.a.view().ready,false);assert.equal(c.idb.read().syncCheckpoint,undefined);
 const count=f.calls.length;await c.a.refreshSession({automatic:true});assert.equal(f.calls.length,count);assert.equal(f.calls.some(c=>/enable|activate/i.test(c.action||'')),false);c.a.destroy();
});

test('client + generated GAS: expired staged bootstrap restarts without publishing partial records',async()=>{
 const f=cloudEndpointFixture({activate:true,seed(rt){const domain=createAppDomain({writer:rt.writer,locked:rt.locked,digest:s=>createHash('sha256').update(s).digest('hex')});for(let i=1;i<=9;i++)domain.command({operationId:'fixture_diary_'+String(i).padStart(6,'0'),epoch:'default',generation:'1',store:rt.writer.storeId,key:'diary:2026-10-'+String(i).padStart(2,'0'),expectedVersion:0,deleted:false,value:{text:'😀'.repeat(8000),mood:null},recreate:false});}}),c=f.profile();let interrupt=true;
 c.hooks.before=request=>{if(request.action==='pull'&&request.payload.cursor&&interrupt)throw Error('fixture offline');};
 await c.a.init();assert.equal(c.a.view().ready,false);const cursor=c.idb.read().snapshotStage.meta.cursor;assert.equal(typeof cursor,'string');assert.equal(Object.keys(c.idb.read().entities).length,0);c.a.destroy();
 f.gas.advance(24*60*60*1000);interrupt=false;const next=f.profile({idb:c.idb});f.calls.length=0;await next.a.init();assert.equal(f.calls.find(c=>c.action==='pull').payload.cursor,cursor);assert.equal(next.a.view().error,null);assert.equal(Object.keys(next.a.state().diary).length,9);assert.equal(next.idb.read().syncCheckpoint.seq,9);assert.equal(next.idb.read().snapshotStage,null);next.a.destroy();
});

const gate=()=>{let enter,release;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);return {enter,release,entered,wait};};
test('real auth logout/relogin joins a fresh sync rather than stale previous-session completion',{timeout:10000},async()=>{
 const f=cloudEndpointFixture({activate:true}),c=f.profile();await c.a.init();await c.a.maintenance();const wait=gate();let held=false;
 c.hooks.after=async request=>{if(request.action==='pull'&&!held){held=true;wait.enter();await wait.wait;}};
 const old=c.a.sync();await wait.entered;await c.a.logout();const calls=f.calls.length;const login=c.login();await new Promise(r=>setImmediate(r));wait.release();await Promise.all([old,login]);
 assert.equal(c.a.view().authenticated,true);assert.equal(c.a.view().verified,true);assert(f.calls.slice(calls).some(r=>r.action==='pull'));c.a.destroy();
});

test('logout after an API reply but before local receipt storage keeps its UUID for the fresh session',{timeout:10000},async()=>{
 const f=cloudEndpointFixture({activate:true}),idb=keyedIndexedDBDouble(),storage=createIndexedDBStorage(idb),wait=gate();let pause=false,held=false;
 const guardedStorage={...storage,async read(options){if(pause&&!held){held=true;wait.enter();await wait.wait;}return storage.read(options);}};
 const c=f.profile({idb,extra:{storage:guardedStorage}});await c.a.init();await c.a.maintenance();
 c.hooks.after=request=>{if(request.action==='command')pause=true;};await c.a.commit(c.a.state(),edit(c.a,'preserve through session boundary'));await wait.entered;
 const original=structuredClone(idb.read().outbox[0].command);await c.a.logout();const login=c.login();await new Promise(r=>setImmediate(r));wait.release();await login;
 assert.equal(c.a.view().verified,true);assert.equal(c.a.view().pending,0);assert.deepEqual(f.calls.filter(r=>r.action==='command').map(r=>r.payload),[original,original]);assert.equal(idb.read().entities['diary:'+date].version,1);c.a.destroy();
});

const coldTail=tail=>rt=>{rt.writer.checkpoint({operationId:'prepared',digest:writerDigest('prepared')});for(let n=0;n<tail;n++)rt.writer.transact({operationId:'tail_'+n,digest:writerDigest(n),changes:[{key:'internal-record',expectedVersion:n,value:n}]});};
for(const latency of [750,1000])for(const tail of [1,20])test(`client consumes bounded recovery pages under slow generated-GAS service (${latency}ms, ${tail} tails)`,async()=>{
 const f=cloudEndpointFixture({activate:true,readMs:latency,writeMs:latency,seed:coldTail(tail)}),c=f.profile({extra:{now:()=>f.gas.now}}),outcomes=[];
 c.hooks.after=(request,response)=>{if(request.action)outcomes.push({action:request.action,error:response.body.error??null,recovery:response.body.recovery??null,hasResult:response.body.result!==undefined,elapsed:f.gas.last.elapsedMs});};
 await c.a.init();for(let attempt=0;!c.a.view().verified&&attempt<10;attempt++){assert.equal(c.a.view().automaticPaused,false);assert(c.a.view().retryAt>f.gas.now);f.gas.advance(c.a.view().retryAt-f.gas.now);await c.a.refreshSession({automatic:true,poll:true});}
 assert.equal(c.a.view().verified,true,JSON.stringify({view:c.a.view(),outcomes}));assert.equal(c.idb.read().syncCheckpoint.seq,0);
 const recordCalls=f.calls.filter(r=>['pull','recover'].includes(r.action)),recordOutcomes=outcomes.filter(r=>['pull','recover'].includes(r.action));
 assert.equal(recordOutcomes.filter(r=>r.error===null).length,1,'a complete page must not be followed by a redundant cold read');
 assert.equal(recordOutcomes.at(-1).error,null,'no record request follows the first successful page');
 if(!recordCalls.some(r=>r.action==='recover')){assert(recordCalls.every(r=>r.action==='pull'));assert(recordOutcomes.every(r=>r.elapsed<45000));assert(recordOutcomes.slice(0,-1).every(r=>r.error==='WRITER_RECOVERY_PENDING'&&!r.hasResult&&r.recovery?.cursorPersisted===true&&r.recovery.cursorAdvanced===true));}
 assert(outcomes.filter(r=>r.action==='recover').every(r=>r.elapsed<45000));assert(outcomes.filter(r=>r.action==='pull').every(r=>r.elapsed<45000));c.a.destroy();
});

test('client reports sustained read budget exhaustion without confirmation or abandoning local staging',async()=>{
 const f=cloudEndpointFixture({activate:true,readMs:5000,writeMs:5000,seed:coldTail(1)}),c=f.profile({extra:{now:()=>f.gas.now}});await c.a.init();
 for(let attempt=0;attempt<3;attempt++){assert.equal(c.a.view().verified,false);assert.equal(c.a.view().recordsConfirmed,false);assert.equal(c.a.view().automaticPaused,false);assert(['STORE_YIELD','SYNC_BUDGET_YIELD','WRITER_RECOVERY_PENDING','STORE_READ_UNRESOLVED'].includes(c.a.view().error));assert.equal(c.idb.read().syncCheckpoint,undefined);f.gas.advance(Math.max(0,c.a.view().retryAt-f.gas.now));await c.a.refreshSession({automatic:true,poll:true});}
 assert.equal(c.a.view().ready,false);assert.equal(c.a.view().pending,0);c.a.destroy();
});

test('two profiles deleting the same record can explicitly keep the local deletion without a conflict loop',async()=>{
 const f=cloudEndpointFixture({activate:true}),one=f.profile(),two=f.profile();await one.a.init();await one.a.commit(one.a.state(),edit(one.a,'both will delete'));await one.a.sync();await two.a.init();
 one.n.offline=true;await one.a.commit(one.a.state(),{...one.a.state(),diary:{}});await one.a.sync({automatic:true});
 await two.a.commit(two.a.state(),{...two.a.state(),diary:{}});await two.a.sync();one.n.offline=false;await one.a.sync();
 assert.equal(one.a.view().conflicts.length,1);assert.equal(one.a.view().conflicts[0].remote.deleted,true);const commands=f.calls.filter(r=>r.action==='command').length;
 await one.a.resolveConflict('diary:'+date,'local',one.a.view().conflicts[0]);await one.a.sync();
 assert.equal(one.a.view().conflicts.length,0);assert.equal(one.a.view().pending,0);assert.equal(one.a.state().diary[date],undefined);assert.equal(f.calls.filter(r=>r.action==='command').length,commands,'an already confirmed deletion needs no replacement mutation');one.a.destroy();two.a.destroy();
});

for(const baseline of ['absent','tombstone'])test(`a stale ${baseline} cannot discard a local deletion when conflict refresh fails`,async()=>{
 const f=cloudEndpointFixture({activate:true}),one=f.profile(),two=f.profile();await one.a.init();
 if(baseline==='tombstone'){await one.a.commit(one.a.state(),edit(one.a,'old deleted value'));await one.a.sync();await one.a.commit(one.a.state(),{...one.a.state(),diary:{}});await one.a.sync();}
 await two.a.init();one.n.offline=true;await one.a.commit(one.a.state(),edit(one.a,'offline temporary value'));await one.a.sync({automatic:true});await one.a.commit(one.a.state(),{...one.a.state(),diary:{}});await one.a.sync({automatic:true});
 const original=structuredClone(one.idb.read().outbox.map(q=>q.command));await two.a.commit(two.a.state(),edit(two.a,'remote current value'));await two.a.sync();
 one.n.offline=false;one.hooks.before=request=>{if(request.action==='pull')throw Error('failed conflict refresh');};await one.a.sync();const preview=one.a.view().conflicts[0];assert(preview);assert.equal(preview.remote?.deleted??true,true);
 await assert.rejects(one.a.resolveConflict('diary:'+date,'local',preview),/CONFLICT_REFRESH_REQUIRED/);assert.deepEqual(one.idb.read().outbox.map(q=>q.command),original);
 one.hooks.before=null;await assert.rejects(one.a.resolveConflict('diary:'+date,'local',preview),/CONFLICT_PREVIEW_CHANGED/);assert.deepEqual(one.idb.read().outbox.map(q=>q.command),original);assert.equal(one.a.view().conflicts[0].remote.value.text,'remote current value');
 await one.a.resolveConflict('diary:'+date,'local',one.a.view().conflicts[0]);await one.a.sync();await two.a.sync();assert.equal(one.a.view().pending,0);assert.equal(one.a.view().conflicts.length,0);assert.equal(two.a.state().diary[date],undefined);one.a.destroy();two.a.destroy();
});

test('feedback rendering exceptions cannot strand busy or prevent a durable command from completing',async()=>{
 let failFeedback=false,attempts=0;const f=cloudEndpointFixture({activate:true}),c=f.profile({extra:{onChange(){attempts++;if(failFeedback)throw Error('SYNTHETIC_RENDER_FAILED');}}});await c.a.init();failFeedback=true;
 await c.a.commit(c.a.state(),edit(c.a,'core storage survives feedback failure'));await c.a.sync();assert.equal(c.a.view().busy,false);assert.equal(c.a.view().pending,0);assert.equal(c.a.view().verified,true);assert.equal(c.a.view().feedbackError,'SYNTHETIC_RENDER_FAILED');assert.equal(c.idb.read().entities['diary:'+date].version,1);
 const before=attempts;failFeedback=false;await c.a.sync();assert(attempts>before);assert.equal(c.a.view().feedbackError,null);assert.equal(c.a.view().busy,false);c.a.destroy();
});

test('wider bounded recovery now completes the formerly exhausted two-second service fixture',async()=>{
 const f=cloudEndpointFixture({activate:true,readMs:2000,writeMs:2000,seed:coldTail(1)}),c=f.profile({extra:{now:()=>f.gas.now}});await c.a.init();
 assert.equal(c.a.view().verified,true);assert.equal(c.a.view().error,null);assert.equal(c.idb.read().syncCheckpoint.seq,0);assert.equal(c.a.view().pending,0);c.a.destroy();
});
