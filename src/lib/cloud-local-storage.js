import {canonical} from './entity-codec.js';

// Version 1's owner blob is deliberately retained as a migration safety copy.
// Normal v2 writes never rewrite it or enumerate the current baseline.
const DB = 'mypace.owner-sync.v1';
const STORES = ['entities','outbox','conflicts','metadata','staging','localChanges'];
const DEFAULT_LOG_LIMIT = 128;
const blank = () => ({format:1,store:null,generation:null,epoch:null,revision:null,importedRuns:[],importStatus:null,recordConfirmation:null,snapshotStage:null});
const copy = value => structuredClone(value);
const fail = code => { throw Error(code); };
const assertKey = key => {if(typeof key !== 'string' || !key || key.length > 512)fail('LOCAL_KEY_INVALID');return key;};
const request = r => new Promise((resolve,reject) => {r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error || Error('INDEXEDDB_REQUEST_FAILED'));});
function done(tx){return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error || Error('INDEXEDDB_TRANSACTION_ABORTED'));tx.onerror=()=>{};});}
function metadata(data){const result={...data};for(const key of ['entities','outbox','conflicts','localRevision'])delete result[key];return result;}
function publicMeta(row){return {...row.value,localRevision:row.localRevision};}
function cleanMeta(value){if(value === undefined)return {};if(!value || typeof value !== 'object' || Array.isArray(value))fail('LOCAL_METADATA_INVALID');for(const key of ['entities','outbox','conflicts','localRevision','snapshotStage'])if(Object.hasOwn(value,key))fail('LOCAL_METADATA_INVALID');return copy(value);}
function validEntity(value){if(!value || typeof value !== 'object')fail('LOCAL_ENTITY_INVALID');assertKey(value.key);if(!Number.isSafeInteger(value.version)||value.version<1||typeof value.deleted!=='boolean')fail('LOCAL_ENTITY_INVALID');canonical(value);return value;}
const lists = ['entitiesPut','entitiesDelete','outboxPut','outboxDelete','conflictsPut','conflictsDelete'];
function validatePatch(input){
 if(!input || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion<0)fail('LOCAL_VERSION_REQUIRED');
 const patch=copy(input);patch.meta=cleanMeta(patch.meta);
 for(const name of lists){if(patch[name]===undefined)patch[name]=[];if(!Array.isArray(patch[name]))fail('LOCAL_PATCH_INVALID');}
 const unique=(items,key)=>{const seen=new Set();for(const value of items){const k=assertKey(key(value));if(seen.has(k))fail('LOCAL_PATCH_DUPLICATE_KEY');seen.add(k);}};
 unique(patch.entitiesPut,e=>validEntity(e).key);unique(patch.entitiesDelete,k=>k);
 unique(patch.outboxPut,q=>q?.command?.operationId);unique(patch.outboxDelete,k=>k);
 unique(patch.conflictsPut,c=>c?.key);unique(patch.conflictsDelete,k=>k);
 for(const [put,del,key] of [[patch.entitiesPut,patch.entitiesDelete,e=>e.key],[patch.outboxPut,patch.outboxDelete,q=>q.command.operationId],[patch.conflictsPut,patch.conflictsDelete,c=>c.key]])if(put.some(v=>del.includes(key(v))))fail('LOCAL_PATCH_DUPLICATE_KEY');
 if(patch.snapshot){const s=patch.snapshot;assertKey(s.id);if(!Number.isSafeInteger(s.page)||s.page<0||!Array.isArray(s.entities))fail('SNAPSHOT_PAGE_INVALID');s.meta=cleanMeta(s.meta);unique(s.entities,e=>validEntity(e).key);if(patch.entitiesPut.length||patch.entitiesDelete.length||patch.snapshotDiscard)fail('LOCAL_PATCH_INVALID');}
 if(patch.snapshotDiscard!==undefined)assertKey(patch.snapshotDiscard);
 return patch;
}

// Open without a version: inspection cannot upgrade an existing database.
// For a new origin, abort the creation transaction rather than leave a probe DB.
async function inspectLegacy(indexedDB,name){
 return new Promise((resolve,reject)=>{
  const r=indexedDB.open(name);let absent=false;
  r.onupgradeneeded=event=>{absent=event.oldVersion===0;r.transaction.abort();};
  r.onerror=()=>absent?resolve(null):reject(r.error||Error('INDEXEDDB_OPEN_FAILED'));
  r.onblocked=()=>reject(Error('INDEXEDDB_BLOCKED_CLOSE_OTHER_TABS'));
  r.onsuccess=()=>{
   const d=r.result;
   if(d.version!==1){d.close();resolve(null);return;}
   if(!d.objectStoreNames.contains('state')){d.close();reject(Error('INDEXEDDB_LEGACY_SCHEMA_INVALID'));return;}
   const tx=d.transaction(['state'],'readonly'),complete=done(tx);
   const value=request(tx.objectStore('state').get('owner'));
   Promise.all([value,complete]).then(([owner])=>{d.close();resolve({owner});},error=>{d.close();reject(error);});
  };
 });
}

/** Keyed IndexedDB adapter. read() hydrates once; read({sinceVersion}) is incremental.
 * apply() accepts a declarative patch and an exact localRevision CAS. Successful
 * request events are not acknowledgements: every method waits for transaction completion.
 */
export function createIndexedDBStorage(indexedDB=globalThis.indexedDB,{name=DB,logLimit=DEFAULT_LOG_LIMIT,onLegacyMigration=null}={}){
 if(!Number.isSafeInteger(logLimit)||logLimit<1||logLimit>4096)fail('LOCAL_LOG_LIMIT_INVALID');
 let opening=null,connection=null,versionChanged=false,cancelOpening=null,lifecycle=0;
 async function db(){
  if(versionChanged)fail('INDEXEDDB_VERSION_CHANGED_RELOAD_REQUIRED');
  if(connection)return connection;
  if(opening)return opening;
  const generation=lifecycle;
  const pending=(async()=>{
   let legacy=null;
   if(onLegacyMigration){
    if(!indexedDB)fail('INDEXEDDB_UNAVAILABLE');
    legacy=await inspectLegacy(indexedDB,name);
    if(generation!==lifecycle)fail('INDEXEDDB_CONNECTION_CLOSED');
    if(legacy&&await onLegacyMigration(copy(legacy.owner))!==true)fail('INDEXEDDB_UPGRADE_APPROVAL_REQUIRED');
   }
   if(generation!==lifecycle)fail('INDEXEDDB_CONNECTION_CLOSED');
   return new Promise((resolve,reject)=>{
   if(!indexedDB){reject(Error('INDEXEDDB_UNAVAILABLE'));return;}
   let settled=false,upgradeError;
   const r=indexedDB.open(name,2);
   const rejectOnce=error=>{if(!settled){settled=true;reject(error);}};
   const cancel=()=>{rejectOnce(Error('INDEXEDDB_CONNECTION_CLOSED'));try{r.transaction?.abort();}catch{}};
   const clearCancel=()=>{if(cancelOpening===cancel)cancelOpening=null;};
   cancelOpening=cancel;
   r.onblocked=()=>rejectOnce(Error('INDEXEDDB_BLOCKED_CLOSE_OTHER_TABS'));
   r.onupgradeneeded=event=>{
    // A blocked open may become unblocked after its promise was rejected.
    // Abort that obsolete upgrade rather than creating an unowned connection.
    if(settled){r.transaction.abort();return;}
    try{
     if(event.oldVersion===1&&onLegacyMigration&&!legacy)fail('INDEXEDDB_LEGACY_CHANGED_REVIEW_REQUIRED');
     const d=r.result,tx=r.transaction;
     if(!d.objectStoreNames.contains('state'))d.createObjectStore('state');
     const entities=d.createObjectStore('entities',{keyPath:['baseline','key']});entities.createIndex('baseline','baseline');
     d.createObjectStore('outbox',{keyPath:'id'});d.createObjectStore('conflicts',{keyPath:'id'});
     d.createObjectStore('metadata');d.createObjectStore('staging',{keyPath:'id'});d.createObjectStore('localChanges',{keyPath:'version'});
     const old=tx.objectStore('state').get('owner');
     old.onsuccess=()=>{try{
      if(legacy&&canonical(old.result??null)!==canonical(legacy.owner??null))fail('INDEXEDDB_LEGACY_CHANGED_REVIEW_REQUIRED');
      const data=old.result || {...blank(),entities:{},outbox:[],conflicts:[]},baseline='migrated-v1';
      const value={...blank(),...metadata(data),snapshotStage:null};
      let order=0;const outboxIds=new Set(),conflictIds=new Set();
      for(const [key,entity] of Object.entries(data.entities || {}))entities.put({baseline,key,value:entity});
      for(const q of data.outbox || []){const id=assertKey(q?.command?.operationId);if(outboxIds.has(id))fail('LOCAL_MIGRATION_DUPLICATE_OPERATION');outboxIds.add(id);tx.objectStore('outbox').put({id,order:order++,value:q});}
      for(const c of data.conflicts || []){const id=assertKey(c?.key);if(conflictIds.has(id))fail('LOCAL_MIGRATION_DUPLICATE_CONFLICT');conflictIds.add(id);tx.objectStore('conflicts').put({id,order:order++,value:c});}
      tx.objectStore('metadata').put({schema:2,baseline,localRevision:0,logFloor:0,nextOrder:order,value},'owner');
     }catch(e){upgradeError=e;tx.abort();}};
    }catch(e){upgradeError=e;r.transaction.abort();}
   };
   r.onerror=()=>{clearCancel();rejectOnce(upgradeError || (r.error?.name==='VersionError'?Error('INDEXEDDB_VERSION_CHANGED_RELOAD_REQUIRED'):r.error) || Error('INDEXEDDB_OPEN_FAILED'));};
   r.onsuccess=()=>{
    clearCancel();const d=r.result;if(settled){d.close();return;}
    d.onversionchange=()=>{versionChanged=true;connection=null;opening=null;d.close();};
    d.onclose=()=>{if(connection===d){connection=null;opening=null;}};
    settled=true;connection=d;resolve(d);
   };
   });
  })();
  opening=pending;
  try{return await pending;}catch(e){if(opening===pending)opening=null;throw e;}
 }
 function transaction(d,mode){
  // Strict is a durability hint; local storage can still be cleared by its owner.
  return mode==='readwrite'?d.transaction(STORES,mode,{durability:'strict'}):d.transaction(STORES,mode);
 }
 async function run(mode,fn){
  const d=await db(),tx=transaction(d,mode),complete=done(tx);
  try{const result=await fn(tx);await complete;return result;}catch(e){try{tx.abort();}catch{}await complete.catch(()=>{});throw e;}
 }
 async function full(tx,row){
  const [entities,outbox,conflicts]=await Promise.all([
   request(tx.objectStore('entities').index('baseline').getAll(row.baseline)),
   request(tx.objectStore('outbox').getAll()),request(tx.objectStore('conflicts').getAll())
  ]);
  return {...publicMeta(row),entities:Object.fromEntries(entities.map(e=>[e.key,e.value])),outbox:outbox.sort((a,b)=>a.order-b.order).map(q=>q.value),conflicts:conflicts.sort((a,b)=>a.order-b.order).map(c=>c.value)};
 }
 async function read(options){return run('readonly',async tx=>{
  const row=await request(tx.objectStore('metadata').get('owner'));if(!row||row.schema!==2)fail('INDEXEDDB_MIGRATION_INCOMPLETE');
  if(options===undefined || options.sinceVersion===undefined)return full(tx,row);
  const since=options.sinceVersion;
  const reset=async()=>({kind:'full',localRevision:row.localRevision,data:await full(tx,row)});
  if(!Number.isSafeInteger(since)||since<row.logFloor||since>row.localRevision||since<0)return reset();
  const logs=await Promise.all(Array.from({length:row.localRevision-since},(_,i)=>request(tx.objectStore('localChanges').get(since+i+1))));
  if(logs.some((log,i)=>!log||log.version!==since+i+1||log.reset))return reset();
  const keys={entities:new Set(),outbox:new Set(),conflicts:new Set()};
  for(const log of logs)for(const name of Object.keys(keys))for(const key of log[name])keys[name].add(key);
  const result={kind:'delta',localRevision:row.localRevision,meta:publicMeta(row),entitiesPut:[],entitiesDelete:[],outboxPut:[],outboxDelete:[],conflictsPut:[],conflictsDelete:[]};
  await Promise.all(Object.entries(keys).flatMap(([name,ids])=>[...ids].map(async id=>{
   const value=await request(tx.objectStore(name).get(name==='entities'?[row.baseline,id]:id));
   if(value)result[name+'Put'].push(name==='entities'?value.value:{...value.value,...(name==='outbox'?{localOrder:value.order}:{})});else result[name+'Delete'].push(id);
  })));
  result.outboxPut.sort((a,b)=>a.localOrder-b.localOrder);
  return result;
 });}
 async function apply(input){const patch=validatePatch(input);return run('readwrite',async tx=>{
  const store=tx.objectStore('metadata'),row=await request(store.get('owner'));if(!row||row.schema!==2)fail('INDEXEDDB_MIGRATION_INCOMPLETE');
  const currentVersion=row.localRevision;
  const snapshotSignature=patch.snapshot?canonical({...patch,expectedVersion:null}):null;
  const previousStage=patch.snapshot?await request(tx.objectStore('staging').get(patch.snapshot.id)):null;
  if(patch.expectedVersion<=currentVersion&&previousStage&&!previousStage.discarded&&(previousStage.published||row.value.snapshotStage?.id===previousStage.id)&&previousStage.lastPage===patch.snapshot.page&&previousStage.lastSignature===snapshotSignature)return {localRevision:currentVersion,duplicate:true};
  if(patch.expectedVersion!==currentVersion)fail('LOCAL_STATE_CHANGED');
  const changed={entities:[],outbox:[],conflicts:[]};let reset=false,stageChanged=false;
  if(patch.snapshotDiscard!==undefined){
   if(row.value.snapshotStage?.id===patch.snapshotDiscard){row.value.snapshotStage=null;stageChanged=true;}
   const prior=await request(tx.objectStore('staging').get(patch.snapshotDiscard));
   if(prior && !prior.published)tx.objectStore('staging').put({...prior,discarded:true});
  }
  if(patch.snapshot){
   const s=patch.snapshot,stages=tx.objectStore('staging');let stage=previousStage;
   const signature=snapshotSignature;
   if(stage?.discarded||stage?.published||stage&&row.value.snapshotStage?.id!==s.id)fail('SNAPSHOT_STAGE_CHANGED');
   if(!stage){if(s.page!==0)fail('SNAPSHOT_PAGE_OUT_OF_ORDER');if(row.value.snapshotStage && row.value.snapshotStage.id!==s.id)fail('SNAPSHOT_STAGE_CHANGED');stage={id:s.id,nextPage:0,meta:{}};}
   if(stage.nextPage!==s.page)fail('SNAPSHOT_PAGE_OUT_OF_ORDER');
   for(const key of ['store','generation','epoch','revision','headHash','mode','targetSeq'])if(Object.hasOwn(stage.meta,key)&&Object.hasOwn(s.meta,key)&&canonical(stage.meta[key])!==canonical(s.meta[key]))fail('SNAPSHOT_CUT_CHANGED');
   const baseline='snapshot:'+s.id,entityStore=tx.objectStore('entities');
   await Promise.all(s.entities.map(async entity=>{if(await request(entityStore.get([baseline,entity.key])))fail('SNAPSHOT_DUPLICATE_ENTITY');entityStore.put({baseline,key:entity.key,value:entity});}));
   stage={...stage,nextPage:s.page+1,meta:{...stage.meta,...s.meta},lastPage:s.page,lastSignature:signature,published:!!s.complete};stages.put(stage);stageChanged=true;
   if(s.complete){
    if(row.baseline==='migrated-v1')stages.put({id:0,retiredBaseline:'migrated-v1'});
    row.baseline=baseline;row.value.snapshotStage=null;reset=true;
   }
   else row.value.snapshotStage={id:s.id,nextPage:stage.nextPage,meta:stage.meta};
  }
  const entityStore=tx.objectStore('entities');
  await Promise.all(patch.entitiesPut.map(async entity=>{
   const old=await request(entityStore.get([row.baseline,entity.key]));
   if(old?.value.version>entity.version)return;
   if(old?.value.version===entity.version){if(canonical(old.value)!==canonical(entity))fail('LOCAL_ENTITY_VERSION_COLLISION');return;}
   entityStore.put({baseline:row.baseline,key:entity.key,value:entity});changed.entities.push(entity.key);
  }));
  for(const key of patch.entitiesDelete){entityStore.delete([row.baseline,key]);changed.entities.push(key);}
  for(const name of ['outbox','conflicts']){
   const records=tx.objectStore(name);
   await Promise.all(patch[name+'Put'].map(async value=>{
    const id=name==='outbox'?value.command.operationId:value.key,old=await request(records.get(id));
    if(name==='outbox'&&old&&canonical(old.value.command)!==canonical(value.command))fail('LOCAL_OPERATION_ID_REUSED');
    const stored={...value};delete stored.localOrder;
    records.put({id,order:old?.order??row.nextOrder++,value:stored});changed[name].push(id);
   }));
   for(const id of patch[name+'Delete']){records.delete(id);changed[name].push(id);}
  }
  const metaChanged=Object.entries(patch.meta).some(([key,value])=>!Object.hasOwn(row.value,key)||canonical(row.value[key])!==canonical(value));
  row.value={...row.value,...patch.meta};
  if(!stageChanged&&!metaChanged&&!Object.values(changed).some(keys=>keys.length))return {localRevision:currentVersion};
  row.localRevision++;if(!Number.isSafeInteger(row.localRevision))fail('LOCAL_VERSION_EXHAUSTED');
  const changes=tx.objectStore('localChanges');changes.put({version:row.localRevision,reset,...changed});
  const floor=Math.max(0,row.localRevision-logLimit);for(let version=row.logFloor+1;version<=floor;version++)changes.delete(version);row.logFloor=floor;
  store.put(row,'owner');return {localRevision:row.localRevision};
 });}
 // Explicit, resumable physical cleanup only. The caller owns yielding/lifecycle.
 // Current final-page retry evidence survives; once a newer baseline replaces it,
 // the retired stage/proof may be removed. The v1 safety blob is never touched.
 async function compact({limit=64}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>4096)fail('LOCAL_CLEANUP_LIMIT_INVALID');
  return run('readwrite',async tx=>{
   const row=await request(tx.objectStore('metadata').get('owner'));if(!row||row.schema!==2)fail('INDEXEDDB_MIGRATION_INCOMPLETE');
   const stages=tx.objectStore('staging');
   // At most two stage rows can be protected, so selection visits at most
   // three rows without retaining an ever-growing list or a scan cursor.
   const candidate=()=>new Promise((resolve,reject)=>{
    const r=stages.openCursor();r.onerror=()=>reject(r.error);r.onsuccess=()=>{
     const cursor=r.result;if(!cursor){resolve(null);return;}
     const stage=cursor.value,baseline=stage.retiredBaseline??'snapshot:'+stage.id;
     if(baseline===row.baseline||stage.id===row.value.snapshotStage?.id){cursor.continue();return;}
     resolve({id:stage.id,baseline});
    };
   });
   const retired=await candidate();if(!retired)return {removed:0,stagesRemoved:0,hasMore:false};
   let removed=0;
   const exhausted=await new Promise((resolve,reject)=>{
    const r=tx.objectStore('entities').index('baseline').openCursor(retired.baseline);
    r.onerror=()=>reject(r.error);r.onsuccess=()=>{
     const cursor=r.result;if(!cursor){resolve(true);return;}
     // The transaction holds the metadata scope, so another tab cannot make
     // this baseline live between the protection check and these deletions.
     cursor.delete();removed++;if(removed>=limit){resolve(false);return;}cursor.continue();
    };
   });
   let stagesRemoved=0;if(exhausted){await request(stages.delete(retired.id));stagesRemoved=1;}
   const hasMore=!exhausted||!!await candidate();
   return {removed,stagesRemoved,hasMore};
  });
 }
 return {read,apply,compact,close(){lifecycle++;cancelOpening?.();cancelOpening=null;connection?.close();connection=null;opening=null;}};
}
