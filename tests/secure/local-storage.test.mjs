import test from 'node:test';
import assert from 'node:assert/strict';
import {createIndexedDBStorage} from '../../src/lib/cloud-local-storage.js';
import {keyedIndexedDBDouble} from '../helpers/indexeddb-keyed-double.js';
const entity=(key='diary:2026-10-07',version=1,value='entry')=>({key,version,deleted:false,value});
const queued=(id='operation-1',key='diary:2026-10-07')=>({command:{operationId:id,key,store:'owner',generation:'generation',epoch:'epoch',expectedVersion:1,deleted:false,value:'local intent'},status:'pending'});
const seed=(entities={})=>({format:1,store:'owner',generation:'generation',epoch:'epoch',revision:4,entities,outbox:[],conflicts:[],importedRuns:[{id:'run-1'}],importStatus:{status:'idle'},recordConfirmation:{kind:'receipt',store:'owner',generation:'generation',epoch:'epoch',revision:4}});
const storage=(value,options)=>{const idb=keyedIndexedDBDouble(value);return {idb,s:createIndexedDBStorage(idb,options)};};
const open=(idb,version)=>new Promise((resolve,reject)=>{const r=idb.open('mypace.owner-sync.v1',version);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});

test('v1 migration preserves legacy owner, exact operation IDs, metadata, conflicts and queue order',async()=>{
 const value=seed({'diary:2026-10-07':entity()});value.outbox=[queued('z-original'),queued('a-original')];value.conflicts=[{key:'diary:2026-10-07',error:'CONFLICT',operationId:'z-original'}];
 const {idb,s}=storage(value),read=await s.read();assert.equal(idb.version,2);assert.deepEqual(idb.rows('state'),[value]);assert.equal(read.localRevision,0);assert.deepEqual(read.outbox,value.outbox);assert.deepEqual(read.conflicts,value.conflicts);assert.deepEqual(read.entities,value.entities);assert.deepEqual(read.recordConfirmation,value.recordConfirmation);assert.deepEqual(read.importedRuns,value.importedRuns);assert.deepEqual(read.importStatus,value.importStatus);
 await s.apply({expectedVersion:0,outboxPut:[{...value.outbox[0],status:'conflict'}]});assert.deepEqual((await s.read()).outbox.map(q=>q.command.operationId),['z-original','a-original']);assert.deepEqual(idb.rows('state'),[value]);
});
test('aborted schema upgrade leaves v1 and its owner intact; failed open promise is retryable',async()=>{
 const value=seed({a:entity('a')}),{idb,s}=storage(value);idb.failUpgrade();await assert.rejects(s.read(),/IDB_UPGRADE_ABORT/);assert.equal(idb.version,1);assert.deepEqual(idb.rows('state'),[value]);assert.deepEqual(idb.rows('metadata'),[]);assert.deepEqual((await s.read()).entities,value.entities);assert.equal(idb.version,2);
});
test('migration failure never repairs by deleting or dropping duplicate pending operation IDs',async()=>{
 const value=seed();value.outbox=[queued('same'),queued('same')];const {idb,s}=storage(value);await assert.rejects(s.read(),/LOCAL_MIGRATION_DUPLICATE_OPERATION/);assert.equal(idb.version,1);assert.deepEqual(idb.read(),value);
});
test('upgrade blocked by an older tab is actionable and retry succeeds after it closes',async()=>{
 const {idb,s}=storage(seed()),old=await open(idb,1);await assert.rejects(s.read(),/INDEXEDDB_BLOCKED_CLOSE_OTHER_TABS/);old.close();for(let i=0;i<10;i++)await Promise.resolve();assert.equal((await s.read()).localRevision,0);
});
test('versionchange closes the connection and requires reload rather than deleting data',async()=>{
 const {idb,s}=storage(seed());await s.read();idb.versionchange(3);await assert.rejects(s.read(),/INDEXEDDB_VERSION_CHANGED_RELOAD_REQUIRED/);await assert.rejects(s.apply({expectedVersion:0,meta:{revision:9}}),/RELOAD_REQUIRED/);assert.equal(idb.read().revision,4);
});
test('entity, cursor, confirmation, and outbox ACK commit or roll back together',async()=>{
 const value=seed();value.outbox=[queued()];const {idb,s}=storage(value);await s.read();const patch={expectedVersion:0,entitiesPut:[entity()],outboxDelete:['operation-1'],meta:{revision:5,syncCheckpoint:'checkpoint-5',recordConfirmation:{kind:'receipt',revision:5}}};
 idb.fail();await assert.rejects(s.apply(patch),/IDB_QUOTA/);const failed=await s.read();assert.equal(failed.revision,4);assert.equal(failed.localRevision,0);assert.equal(failed.syncCheckpoint,undefined);assert.deepEqual(failed.entities,{});assert.deepEqual(failed.outbox,value.outbox);
 await s.apply(patch);const success=await s.read();assert.equal(success.revision,5);assert.equal(success.syncCheckpoint,'checkpoint-5');assert.equal(success.localRevision,1);assert.deepEqual(success.entities[entity().key],entity());assert.deepEqual(success.outbox,[]);
});
test('paused durable transaction exposes no partial writes before completion',async()=>{
 const {idb,s}=storage(seed());await s.read();idb.pause();let completed=false;const write=s.apply({expectedVersion:0,entitiesPut:[entity()],meta:{syncCheckpoint:'next'}}).then(()=>{completed=true;});for(let i=0;i<40;i++)await Promise.resolve();assert(idb.pending);assert.equal(completed,false);assert.equal(idb.read().syncCheckpoint,undefined);assert.deepEqual(idb.read().entities,{});idb.release();await write;assert.equal(completed,true);assert.equal(idb.read().syncCheckpoint,'next');
});
test('concurrent independent tabs serialize writes; stale CAS never overwrites local intent',async()=>{
 const {idb,s:a}=storage(seed());await a.read();const b=createIndexedDBStorage(idb);await b.read();const [one,two]=await Promise.allSettled([a.apply({expectedVersion:0,outboxPut:[queued('a')]}),b.apply({expectedVersion:0,outboxPut:[queued('b')]})]);assert.equal([one,two].filter(x=>x.status==='fulfilled').length,1);assert.match([one,two].find(x=>x.status==='rejected').reason.message,/LOCAL_STATE_CHANGED/);assert.equal((await a.read()).outbox.length,1);const change=await b.read({sinceVersion:0});assert.equal(change.kind,'delta');assert.equal(change.outboxPut.length,1);assert.equal(change.localRevision,1);
 await b.apply({expectedVersion:1,outboxPut:[queued('b-retry')]});assert.equal((await a.read()).outbox.length,2);
});
test('older entity versions are ignored; duplicate versions are no-op; same-version mismatch rolls back cursor',async()=>{
 const {s}=storage(seed({a:entity('a',3,'new')}));await s.read();assert.deepEqual(await s.apply({expectedVersion:0,entitiesPut:[entity('a',2,'old')]}),{localRevision:0});assert.deepEqual(await s.apply({expectedVersion:0,entitiesPut:[entity('a',3,'new')]}),{localRevision:0});await assert.rejects(s.apply({expectedVersion:0,entitiesPut:[entity('a',3,'tampered')],meta:{syncCheckpoint:'bad'}}),/LOCAL_ENTITY_VERSION_COLLISION/);assert.equal((await s.read()).syncCheckpoint,undefined);
 await s.apply({expectedVersion:0,entitiesPut:[{...entity('a',4,null),deleted:true}],meta:{syncCheckpoint:'delete'}});await assert.rejects(s.apply({expectedVersion:0,entitiesPut:[entity('a',5,'recreate')]}),/LOCAL_STATE_CHANGED/);await s.apply({expectedVersion:1,entitiesPut:[entity('a',5,'recreate')]});assert.equal((await s.read()).entities.a.value,'recreate');
});
test('pending operation IDs cannot be reused with different commands',async()=>{
 const value=seed();value.outbox=[queued()];const {s}=storage(value);await s.read();await assert.rejects(s.apply({expectedVersion:0,outboxPut:[{...queued(),command:{...queued().command,value:'replacement'}}]}),/LOCAL_OPERATION_ID_REUSED/);assert.deepEqual((await s.read()).outbox,value.outbox);
});
test('snapshot pages stage durably, resume without entities, and publish pointer plus cursor atomically',async()=>{
 const value=seed({old:entity('old')});value.outbox=[queued()];const {idb,s}=storage(value);await s.read();const context={cursor:'page-2',store:'owner',generation:'generation',epoch:'epoch',revision:8,headHash:'hash',targetSeq:6,mode:'snapshot'};
 const first={expectedVersion:0,snapshot:{id:'cut-1',page:0,entities:[entity('new-a')],meta:context}};assert.equal((await s.apply(first)).localRevision,1);assert.deepEqual(await s.apply(first),{localRevision:1,duplicate:true});
 const staged=await s.read();assert.deepEqual(staged.entities,value.entities);assert.deepEqual(staged.outbox,value.outbox);assert.deepEqual(staged.snapshotStage,{id:'cut-1',nextPage:1,meta:context});const incremental=await s.read({sinceVersion:0});assert.equal(incremental.kind,'delta');assert.deepEqual(incremental.entitiesPut,[]);assert.equal(incremental.meta.snapshotStage.nextPage,1);
 const reopened=createIndexedDBStorage(idb);assert.equal((await reopened.read()).snapshotStage.nextPage,1);const last={expectedVersion:1,snapshot:{id:'cut-1',page:1,entities:[entity('new-b')],meta:{cursor:null},complete:true},meta:{revision:8,syncCheckpoint:'complete'}};
 idb.fail();await assert.rejects(reopened.apply(last),/IDB_QUOTA/);assert.equal((await s.read()).snapshotStage.nextPage,1);assert.deepEqual((await s.read()).entities,value.entities);await reopened.apply(last);assert.deepEqual(await reopened.apply(last),{localRevision:2,duplicate:true});
 const published=await s.read({sinceVersion:1});assert.equal(published.kind,'full');assert.deepEqual(Object.keys(published.data.entities).sort(),['new-a','new-b']);assert.equal(published.data.syncCheckpoint,'complete');assert.equal(published.data.snapshotStage,null);assert.equal(published.data.cursor,undefined);assert.equal(published.data.headHash,undefined);assert.deepEqual(published.data.outbox,value.outbox);
});
test('snapshot rejects out-of-order, altered retry, repeated key, cut changes and competing stage',async()=>{
 const {s}=storage(seed());await s.read();await s.apply({expectedVersion:0,snapshot:{id:'one',page:0,entities:[entity('a')],meta:{revision:8,headHash:'cut'}}});
 for(const [snapshot,message] of [[{id:'one',page:2,entities:[]},/OUT_OF_ORDER/],[{id:'one',page:0,entities:[entity('b')]},/OUT_OF_ORDER/],[{id:'one',page:1,entities:[entity('a')]},/DUPLICATE_ENTITY/],[{id:'one',page:1,entities:[],meta:{headHash:'changed'}},/CUT_CHANGED/],[{id:'two',page:0,entities:[]},/STAGE_CHANGED/]])await assert.rejects(s.apply({expectedVersion:1,snapshot}),message);
 assert.equal((await s.read()).localRevision,1);assert.equal((await s.read()).snapshotStage.nextPage,1);
});
test('discarding interrupted snapshot leaves baseline, cursor and queue intact and permits new stage',async()=>{
 const value=seed({a:entity('a')});value.outbox=[queued()];const {s}=storage(value);await s.read();await s.apply({expectedVersion:0,snapshot:{id:'expired',page:0,entities:[entity('staged')],meta:{cursor:'expired-token'}}});await s.apply({expectedVersion:1,snapshotDiscard:'expired'});const after=await s.read();assert.equal(after.snapshotStage,null);assert.deepEqual(after.entities,value.entities);assert.deepEqual(after.outbox,value.outbox);assert.equal(after.revision,4);await assert.rejects(s.apply({expectedVersion:2,snapshot:{id:'expired',page:1,entities:[]}}),/STAGE_CHANGED/);await s.apply({expectedVersion:2,snapshot:{id:'fresh',page:0,entities:[]}});assert.equal((await s.read()).snapshotStage.id,'fresh');
});
test('bounded change log coalesces changed keys and explicitly hydrates expired tabs',async()=>{
 const {idb,s}=storage(seed(),{logLimit:3});await s.read();for(let i=1;i<=8;i++)await s.apply({expectedVersion:i-1,entitiesPut:[entity('a',i)]});assert.equal(idb.rows('localChanges').length,3);assert.equal((await s.read({sinceVersion:4})).kind,'full');const current=await s.read({sinceVersion:5});assert.equal(current.kind,'delta');assert.equal(current.entitiesPut.length,1);assert.equal(current.entitiesPut[0].version,8);assert.equal((await s.read({sinceVersion:9})).kind,'full');
});
test('delta reload includes physical deletions and metadata-only patches without entity enumeration',async()=>{
 const value=seed({a:entity('a')});value.outbox=[queued()];value.conflicts=[{key:'a',error:'conflict'}];const {idb,s}=storage(value);await s.read();await s.apply({expectedVersion:0,entitiesDelete:['a'],outboxDelete:['operation-1'],conflictsDelete:['a'],meta:{importStatus:{status:'done'}}});idb.resetMetrics();const patch=await s.read({sinceVersion:0});assert.deepEqual(patch.entitiesDelete,['a']);assert.deepEqual(patch.outboxDelete,['operation-1']);assert.deepEqual(patch.conflictsDelete,['a']);assert.equal(patch.meta.importStatus.status,'done');assert.equal(idb.metrics.entities.getAll,0);
});
test('idle and single-key IO stay constant at 1, 1000 and 50000 baseline entities',async t=>{
 const samples=[];for(const count of [1,1000,50000]){
  const entities=Object.fromEntries(Array.from({length:count},(_,i)=>{const e=entity('run:'+String(i).padStart(5,'0'),1,'fixture-value');return [e.key,e];})),{idb,s}=storage(seed(entities));await s.read();idb.resetMetrics();
  assert.deepEqual(await s.apply({expectedVersion:0}),{localRevision:0});const idle=await s.read({sinceVersion:0});assert.equal(idle.kind,'delta');assert.equal(idle.entitiesPut.length,0);assert.equal(idb.metrics.entities,undefined);
  idb.resetMetrics();await s.apply({expectedVersion:0,entitiesPut:[entity('run:00000',2,'changed')],meta:{syncCheckpoint:'next'}});const change=await s.read({sinceVersion:0});assert.equal(change.entitiesPut.length,1);const m=idb.metrics;assert.equal(m.entities.getAll,0);assert.equal(m.entities.get,2);assert.equal(m.entities.put,1);assert.equal(m.entities.rowsRead,2);assert.equal(m.state,undefined);assert.equal(m.outbox,undefined);assert.equal(m.conflicts,undefined);samples.push({count,entityReads:m.entities.get,entityWrites:m.entities.put,entityBytesRead:m.entities.bytesRead,entityBytesWritten:m.entities.bytesWritten,allRequests:Object.values(m).reduce((n,x)=>n+x.get+x.getAll+x.put+x.delete,0)});
 }assert.equal(new Set(samples.map(s=>s.allRequests)).size,1);assert.equal(new Set(samples.map(s=>s.entityBytesRead)).size,1);assert.equal(new Set(samples.map(s=>s.entityBytesWritten)).size,1);t.diagnostic(JSON.stringify(samples));
});

test('bounded cleanup removes only retired v2 baselines and leaves all visible state and v1 safety data unchanged',async()=>{
 const legacy=seed(Object.fromEntries(Array.from({length:20},(_,i)=>['old'+i,entity('old'+i)])));legacy.outbox=[queued()];legacy.conflicts=[{key:'old1',error:'needs review'}];const {idb,s}=storage(legacy);await s.read();
 const last={expectedVersion:0,snapshot:{id:'new',page:0,entities:[entity('current')],complete:true},meta:{revision:9,syncCheckpoint:'safe',recordConfirmation:{kind:'snapshot',revision:9}}};await s.apply(last);const before=await s.read();let result,total=0;
 do{idb.resetMetrics();result=await s.compact({limit:7});total+=result.removed;assert(result.removed+result.stagesRemoved<=7);assert((idb.metrics.staging?.cursorRead||0)<=6);assert.equal(idb.metrics.entities?.getAll||0,0);assert.equal(idb.metrics.metadata.put,0);assert.equal(idb.metrics.localChanges,undefined);}while(result.hasMore);
 assert.equal(total,20);assert.equal(idb.rows('entities').length,1);assert.equal(idb.rows('staging').length,1);assert.deepEqual(idb.rows('state'),[legacy]);assert.deepEqual(await s.read(),before);assert.deepEqual(await s.apply(last),{localRevision:1,duplicate:true});
});
test('cleanup abort rolls back deletions and resumes from remaining keys after a cold reopen',async()=>{
 const {idb,s}=storage(seed(Object.fromEntries(Array.from({length:15},(_,i)=>['old'+i,entity('old'+i)]))));await s.read();await s.apply({expectedVersion:0,snapshot:{id:'new',page:0,entities:[entity('safe')],complete:true}});idb.fail();await assert.rejects(s.compact({limit:5}),/IDB_QUOTA/);assert.equal(idb.rows('entities').length,16);assert.equal((await s.read()).localRevision,1);s.close();const restarted=createIndexedDBStorage(idb);const first=await restarted.compact({limit:5});assert.equal(first.removed,5);assert.equal(first.hasMore,true);while((await restarted.compact({limit:5})).hasMore){}assert.deepEqual(Object.keys((await restarted.read()).entities),['safe']);assert.equal(idb.rows('entities').length,1);
});
test('cleanup protects live staged pages while concurrently published snapshots remain complete',async()=>{
 const {idb,s}=storage(seed({original:entity('original')}));await s.read();await s.apply({expectedVersion:0,snapshot:{id:'first',page:0,entities:[entity('first')],complete:true}});await s.apply({expectedVersion:1,snapshot:{id:'second',page:0,entities:[entity('second-a')],meta:{cursor:'next'}}});const tab=createIndexedDBStorage(idb);await tab.read();
 await Promise.all([s.compact({limit:2}),tab.apply({expectedVersion:2,snapshot:{id:'second',page:1,entities:[entity('second-b')],meta:{cursor:null},complete:true},meta:{syncCheckpoint:'second'}})]);while((await s.compact({limit:2})).hasMore){}const data=await s.read();assert.deepEqual(Object.keys(data.entities).sort(),['second-a','second-b']);assert.equal(data.syncCheckpoint,'second');assert.equal(idb.rows('entities').length,2);assert.equal(idb.rows('staging').length,1);
});
test('discard cleanup and repeated resets have bounded retained rows after draining, with no orphaned signatures',async()=>{
 const legacy=seed({original:entity('original')}),{idb,s}=storage(legacy);await s.read();let version=0;
 for(let cut=0;cut<8;cut++){
  const prefix='cut-'+cut;await s.apply({expectedVersion:version++,snapshot:{id:prefix,page:0,entities:Array.from({length:10},(_,i)=>entity(prefix+'-'+i))}});
  if(cut%2===0)await s.apply({expectedVersion:version++,snapshotDiscard:prefix});else await s.apply({expectedVersion:version++,snapshot:{id:prefix,page:1,entities:[entity(prefix+'-end')],complete:true},meta:{syncCheckpoint:prefix}});
  let batches=0,part;do{part=await s.compact({limit:4});assert(part.removed+part.stagesRemoved<=4);assert(++batches<20);}while(part.hasMore);
  const state=await s.read();assert.equal(state.localRevision,version);assert.equal(idb.rows('entities').length,Object.keys(state.entities).length);assert(idb.rows('staging').length<=1);assert.deepEqual(idb.rows('state'),[legacy]);
 }
});
test('idle cleanup examines at most protected baseline and live stage, without scanning their entities',async()=>{
 const {idb,s}=storage(seed());await s.read();await s.apply({expectedVersion:0,snapshot:{id:'active',page:0,entities:[entity('active')],complete:true}});while((await s.compact()).hasMore){}await s.apply({expectedVersion:1,snapshot:{id:'live',page:0,entities:[entity('live')]}});idb.resetMetrics();assert.deepEqual(await s.compact({limit:1}),{removed:0,stagesRemoved:0,hasMore:false});assert.equal(idb.metrics.staging.cursorRead,2);assert.equal(idb.metrics.entities,undefined);assert.equal(idb.metrics.metadata.put,0);
});

test('simultaneous first opens share one atomic upgrade before independent CAS transactions',async()=>{
 const idb=keyedIndexedDBDouble(seed()),a=createIndexedDBStorage(idb),b=createIndexedDBStorage(idb);const [one,two]=await Promise.all([a.read(),b.read()]);assert.equal(idb.version,2);assert.equal(one.localRevision,0);assert.deepEqual(one,two);const settled=await Promise.allSettled([a.apply({expectedVersion:0,outboxPut:[queued('first')]}),b.apply({expectedVersion:0,outboxPut:[queued('second')]})]);assert.equal(settled.filter(x=>x.status==='fulfilled').length,1);assert.equal(idb.read().outbox.length,1);
});

test('closing while IndexedDB is opening rejects obsolete work and permits a clean later open',async()=>{
 const value=seed({a:entity('a')}),{idb,s}=storage(value);const pending=s.read();s.close();await assert.rejects(pending,/INDEXEDDB_CONNECTION_CLOSED/);assert.deepEqual(idb.rows('state'),[value]);
 const current=await s.read();assert.deepEqual(current.entities,value.entities);assert.deepEqual(idb.rows('state'),[value]);s.close();
});
