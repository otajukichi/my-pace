import test from 'node:test';
import assert from 'node:assert/strict';
import {createIndexedDBStorage} from '../../src/lib/cloud-local-storage.js';
import {keyedIndexedDBDouble} from '../helpers/indexeddb-keyed-double.js';
const seed=()=>({format:1,store:'owner',generation:'1',epoch:'old',revision:3,entities:{'wake:2026-10-08':{key:'wake:2026-10-08',value:'07:00',version:1,deleted:false}},outbox:[{command:{operationId:'original',value:'08:00'},status:'pending'}],conflicts:[{key:'wake:2026-10-08',error:'ENTITY_VERSION_CONFLICT'}],importedRuns:[],importStatus:null});
test('unapproved read inspects v1 without ever opening version2 or changing pending/conflict bytes',async()=>{
 const raw=seed(),idb=keyedIndexedDBDouble(raw),opens=[],open=idb.open.bind(idb);idb.open=(...args)=>{opens.push(args);return open(...args);};let seen;
 const storage=createIndexedDBStorage(idb,{onLegacyMigration:owner=>{seen=owner;return false;}});
 await assert.rejects(storage.read(),/INDEXEDDB_UPGRADE_APPROVAL_REQUIRED/);assert.deepEqual(seen,raw);assert.equal(idb.version,1);assert.equal(idb.writes,0);assert.deepEqual(idb.read(),raw);assert.deepEqual(opens.map(args=>args[1]),[undefined]);storage.close();
});
test('approved migration preserves exact owner blob, pending UUIDs and conflicts',async()=>{
 const raw=seed(),idb=keyedIndexedDBDouble(raw),storage=createIndexedDBStorage(idb,{onLegacyMigration:owner=>{assert.deepEqual(owner,raw);return true;}});
 const result=await storage.read();assert.equal(idb.version,2);assert.deepEqual(result.outbox,raw.outbox);assert.deepEqual(result.conflicts,raw.conflicts);assert.deepEqual(idb.rows('state'),[raw]);storage.close();
});
test('fresh-origin inspection aborts its probe then creates normal v2 without migration consent',async()=>{
 const idb=keyedIndexedDBDouble();let prompted=0;const storage=createIndexedDBStorage(idb,{onLegacyMigration:()=>{prompted++;return false;}});assert.deepEqual((await storage.read()).outbox,[]);assert.equal(idb.version,2);assert.equal(prompted,0);storage.close();
});
test('existing v2 cache opens unchanged without another migration prompt',async()=>{
 const idb=keyedIndexedDBDouble(seed()),first=createIndexedDBStorage(idb);await first.read();first.close();let prompted=0;const storage=createIndexedDBStorage(idb,{onLegacyMigration:()=>{prompted++;return false;}});await storage.read();assert.equal(prompted,0);assert.equal(idb.version,2);storage.close();
});
test('close while awaiting consent prevents later approval from opening version2',async()=>{
 const idb=keyedIndexedDBDouble(seed());let resolve;const storage=createIndexedDBStorage(idb,{onLegacyMigration:()=>new Promise(r=>resolve=r)}),reading=storage.read();while(!resolve)await Promise.resolve();storage.close();resolve(true);await assert.rejects(reading,/INDEXEDDB_CONNECTION_CLOSED/);assert.equal(idb.version,1);
});

test('a v1 writer changing the raw state after inspection aborts migration instead of trusting an older export',async()=>{
 const original=seed(),changed=seed();changed.outbox[0].command.value='09:00';const idb=keyedIndexedDBDouble(original);
 const storage=createIndexedDBStorage(idb,{onLegacyMigration:async owner=>{
  assert.deepEqual(owner,original);
  const db=await new Promise((resolve,reject)=>{const r=idb.open('mypace.owner-sync.v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const tx=db.transaction(['state'],'readwrite');tx.objectStore('state').put(changed,'owner');await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();return true;
 }});
 await assert.rejects(storage.read(),/INDEXEDDB_LEGACY_CHANGED_REVIEW_REQUIRED/);assert.equal(idb.version,1);assert.deepEqual(idb.read(),changed);assert.deepEqual(idb.rows('state'),[changed]);storage.close();
});

for(const initial of ['absent','v2'])test(`a v1 database appearing after ${initial} inspection cannot bypass approval`,async()=>{
 let current=keyedIndexedDBDouble(initial==='v2'?seed():undefined);
 if(initial==='v2'){const setup=createIndexedDBStorage(current);await setup.read();setup.close();}
 const raw=seed();let replaced=false,prompted=0;
 // Model another tab creating/recreating v1 between the no-version inspection
 // and version2 open; no deleteDatabase action is performed by the adapter.
 const idb={open(name,version){if(version===2&&!replaced){replaced=true;current=keyedIndexedDBDouble(raw);}return current.open(name,version);}};
 const storage=createIndexedDBStorage(idb,{onLegacyMigration:()=>{prompted++;return true;}});
 await assert.rejects(storage.read(),/INDEXEDDB_LEGACY_CHANGED_REVIEW_REQUIRED/);assert.equal(prompted,0);assert.equal(current.version,1);assert.deepEqual(current.read(),raw);storage.close();
});
