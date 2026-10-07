import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerBootstrap,parsePinnedOwnerStoreConfig,OWNER_STORE_PROPERTY,OWNER_BOOTSTRAP_PROTOCOL} from './owner-bootstrap.mjs';
import {ReservedSlotWriter,writerDigest} from './reserved-writer.mjs';
import {GasStoreIO} from './gas-store-io.mjs';
import {encodeUtf8,decodeUtf8} from './codec.mjs';

const MIME='application/vnd.google-apps.folder';
const copy=x=>structuredClone(x);
const canonical=x=>JSON.stringify(sort(x));
const sort=x=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;
import {ownerBootstrapFixture as fixture} from './owner-bootstrap-fixture.mjs';

const creates=f=>f.events.filter(x=>x[0]==='create');
const writes=f=>f.events.filter(x=>x[0]==='property-write');
const ids=f=>f.events.filter(x=>x[0]==='ids');
function saved(f){return JSON.parse(f.properties.get(OWNER_STORE_PROPERTY));}
function sealedAnchor(f,c,mutate){const entry=f.files.get(c.anchorId),a=JSON.parse(decodeUtf8(entry.bytes));mutate(a);const {hash,...body}=a;a.hash=writerDigest(body);entry.bytes=encodeUtf8(canonical(a));entry.meta.size=String(entry.bytes.length);}
function realWriter(f,c){return new ReservedSlotWriter({io:new GasStoreIO({...f.globals,lock:f.lock,storeId:c.storeId,managedParentId:c.metadataParentId,checkBudget:()=>true}),anchorId:c.anchorId,storeId:c.storeId,writerScriptId:c.writerScriptId});}

test('construction and absent load never bootstrap, allocate IDs, request token or write',()=>{
 const f=fixture();f.api();assert.equal(f.events.length,0);assert.equal(f.api().load(),null);
 assert.equal(f.events.some(x=>['ids','create','token','property-write'].includes(x[0])),false);assert.equal(f.state.held,false);
});

test('explicit bootstrap persists all fixed IDs before creates and preserves probes/properties',()=>{
 const f=fixture(),probe=copy(f.files.get('probe-folder')),c=f.bootstrap();
 assert.equal(c.protocol,OWNER_BOOTSTRAP_PROTOCOL);assert.deepEqual(c,saved(f));assert.ok(Object.isFrozen(c));assert.ok(Object.isFrozen(c.acceptedEpochs));
 assert.deepEqual(ids(f).map(x=>x[1]),[{count:8,space:'drive',type:'files'}]);
 assert.equal(writes(f).length,1);assert.ok(f.events.indexOf(writes(f)[0])<f.events.indexOf(creates(f)[0]));
 assert.deepEqual(creates(f).map(x=>x[1].id),[c.rootParentId,c.metadataParentId,c.assetsParentId,c.anchorId]);
 for(const event of creates(f)){assert.deepEqual(event[3],{fields:'id',ignoreDefaultVisibility:true});assert.ok(event[1].parents.length===1);}
 assert.deepEqual(f.files.get('probe-folder'),probe);assert.equal(f.properties.get('old.probe'),'probe-folder');assert.equal(f.properties.get('existing.source'),'unchanged');
 const a=JSON.parse(decodeUtf8(f.files.get(c.anchorId).bytes));assert.equal(a.payload.firstSlotId,c.firstSlotId);assert.equal(a.payload.firstIndexId,c.firstIndexId);
 assert.equal(c.writerScriptId,'script_1');assert.equal(c.storeId,c.rootParentId);assert.equal(f.state.held,false);
});

test('optional expectedScriptId binds actual script ID once and rejects later project clone',()=>{
 const f=fixture(),api=f.api({expectedScriptId:undefined});const c=api.bootstrap();assert.equal(c.writerScriptId,'script_1');
 f.state.script='script_clone';assert.throws(()=>f.api({expectedScriptId:undefined}).load(),/CONFIG_MISMATCH/);assert.throws(()=>f.api({expectedScriptId:undefined}).bootstrap(),/CONFIG_MISMATCH/);
 assert.equal(ids(f).length,1);assert.equal(writes(f).length,1);assert.equal(creates(f).length,4);
});

test('cold retry and load reuse exact IDs, anchor bytes and names can change harmlessly',()=>{
 const f=fixture(),c=f.bootstrap(),before=copy(f.files);for(const k of [c.rootParentId,c.metadataParentId,c.assetsParentId])f.files.get(k).meta.name='Owner renamed this';
 assert.deepEqual(f.api().load(),c);assert.deepEqual(f.api().bootstrap(),c);assert.equal(ids(f).length,1);assert.equal(writes(f).length,1);assert.equal(creates(f).length,4);
 assert.deepEqual(f.files.get(c.anchorId),before.get(c.anchorId));
});

for(const [label,change] of [
 ['missing active user',{active:''}],['other active user',{active:'visitor@example.com'}],['other effective user',{effective:'other@example.com'}],['missing effective user',{effective:''}],['wrong actual script',{script:'clone'}]
])test(`${label} is rejected before any property/Drive access`,()=>{const f=fixture(change);for(const method of ['bootstrap','load'])assert.throws(()=>f.api()[method](),/OWNER_UNVERIFIED|SCRIPT_MISMATCH/);assert.equal(f.events.length,0);});

test('owner comparison is normalized, but still checks both active and effective identity',()=>{const f=fixture({active:' OWNER@EXAMPLE.COM ',effective:'OWNER@example.com'});assert.equal(f.bootstrap().ownerEmail,'owner@example.com');});

test('shared lock respects caller ownership and busy lock performs no work',()=>{
 const f=fixture({busy:true});assert.throws(()=>f.bootstrap(),e=>e.message==='OWNER_BOOTSTRAP_BUSY'&&e.retryable);assert.equal(f.events.some(x=>x[0]==='property-read'),false);
 f.state.busy=false;f.state.held=true;f.bootstrap();assert.equal(f.state.held,true);assert.equal(f.events.some(x=>x[0]==='unlock'),false);
});

test('budget yield happens before property/Drive mutation and releases acquired lock',()=>{
 const f=fixture({budget:false});assert.throws(()=>f.bootstrap(),e=>e.message==='OWNER_BOOTSTRAP_YIELD'&&e.retryable);assert.equal(f.events.length,0);
 const g=fixture();g.state.afterPropertyWrite=()=>{g.state.budget=false;};assert.throws(()=>g.bootstrap(),/YIELD/);assert.equal(creates(g).length,0);assert.equal(g.state.held,false);
 g.state.budget=true;delete g.state.afterPropertyWrite;g.bootstrap();assert.equal(ids(g).length,1);
});

test('a failed property write creates nothing; ambiguous committed write is recovered by exact readback',()=>{
 const f=fixture();f.state.beforePropertyWrite=()=>{throw Error('before property commit');};assert.throws(()=>f.bootstrap(),/CONFIG_WRITE_UNRESOLVED/);assert.equal(creates(f).length,0);assert.equal(f.properties.has(OWNER_STORE_PROPERTY),false);
 const g=fixture();g.state.afterPropertyWrite=()=>{throw Error('lost property response');};g.bootstrap();assert.equal(writes(g).length,1);assert.equal(creates(g).length,4);
});

test('unreadable persisted configuration after write pauses before create and resumes same IDs',()=>{
 const f=fixture();f.state.afterPropertyWrite=()=>{f.state.propertyReadFault=()=>{throw Error('unreadable');};};assert.throws(()=>f.bootstrap(),/CONFIG_UNRESOLVED/);
 assert.equal(creates(f).length,0);const c=saved(f);delete f.state.propertyReadFault;delete f.state.afterPropertyWrite;
 assert.deepEqual(f.bootstrap(),c);assert.equal(ids(f).length,1);assert.equal(writes(f).length,1);
});

test('a conflicting config appearing during reservation is never overwritten',()=>{
 const f=fixture();f.state.idsFault=()=>{f.properties.set(OWNER_STORE_PROPERTY,'existing-config');return {ids:['one','two','three','four','five','six','seven','eight']};};
 assert.throws(()=>f.bootstrap(),/CONFIG_CHANGED/);assert.equal(f.properties.get(OWNER_STORE_PROPERTY),'existing-config');assert.equal(writes(f).length,0);assert.equal(creates(f).length,0);
});

for(const raw of ['', '{}','null','[]','not json','x'.repeat(8193)])test(`existing invalid config is preserved (${raw.length} bytes)`,()=>{
 const f=fixture();f.properties.set(OWNER_STORE_PROPERTY,raw);assert.throws(()=>f.bootstrap(),/CONFIG_/);assert.equal(f.properties.get(OWNER_STORE_PROPERTY),raw);assert.equal(ids(f).length,0);assert.equal(creates(f).length,0);
});

for(const [label,mutate] of [
 ['script',c=>{c.writerScriptId='other';}],['owner',c=>{c.ownerEmail='other@example.com';}],['protocol',c=>{c.protocol='other';}],['same IDs',c=>{c.assetsParentId=c.metadataParentId;}],['store identity',c=>{c.storeId='other';}],['root cycle',c=>{c.myDriveRootId=c.rootParentId;}],['extra progress',c=>{c.phase='complete';}],['generation',c=>{c.datasetGeneration='2';}],['epoch',c=>{c.acceptedEpochs=['other'];}],['unsafe ID',c=>{c.rootParentId='../unsafe';}]
])test(`configured ${label} mismatch fails closed without provisioning`,()=>{const f=fixture(),c=copy(f.bootstrap());mutate(c);f.properties.set(OWNER_STORE_PROPERTY,JSON.stringify(c));const before=creates(f).length;assert.throws(()=>f.api().load(),/CONFIG_/);assert.throws(()=>f.bootstrap(),/CONFIG_/);assert.equal(creates(f).length,before);assert.equal(ids(f).length,1);});

for(const generated of [null,{}, {ids:[]},{ids:['same','same','same','same','same','same']},{ids:['one','two','three','four','five',null]},{ids:['one','two','three','four','five','mydrive']},{ids:['one','two','three','four','five','x'.repeat(101)]}])test(`invalid ID reservation ${JSON.stringify(generated)?.slice(0,45)} has no creates/config write`,()=>{
 const f=fixture();f.state.idsFault=()=>generated;assert.throws(()=>f.bootstrap(),/IDS_INVALID/);assert.equal(writes(f).length,0);assert.equal(creates(f).length,0);
});

for(const role of ['store-root','store-metadata','store-assets','bootstrap'])test(`lost ${role} create response resolves same reserved ID`,()=>{
 const f=fixture();f.state.afterCreate=meta=>{if(meta.appProperties['mypace.role']===role)throw Error('lost response');};const c=f.bootstrap();assert.equal(creates(f).length,4);assert.equal(ids(f).length,1);assert.deepEqual(f.api().load(),c);
});

test('false-success and before-commit failures retry only same folder ID, then pause',()=>{
 const f=fixture({skipCreate:true});assert.throws(()=>f.bootstrap(),/CREATE_UNRESOLVED/);const c=saved(f);assert.deepEqual(creates(f).map(x=>x[1].id),[c.rootParentId,c.rootParentId]);
 f.state.skipCreate=false;assert.deepEqual(f.bootstrap(),c);assert.equal(ids(f).length,1);
 const g=fixture();g.state.beforeCreate=()=>{throw Error('no commit');};assert.throws(()=>g.bootstrap(),/CREATE_UNRESOLVED/);assert.equal(new Set(creates(g).map(x=>x[1].id)).size,1);
});

test('malformed create response cannot override the exact ID readback',()=>{const f=fixture({createResult:{id:'different'}});f.bootstrap();assert.equal(creates(f).length,4);assert.equal(f.files.has('different'),false);});

for(const role of ['store-root','store-metadata','store-assets','bootstrap'])test(`cold retry after post-create ${role} read failure reuses all IDs and exact bytes`,()=>{
 const f=fixture();let broken=null;f.state.afterCreate=meta=>{if(meta.appProperties['mypace.role']===role)broken=meta.id;};
 f.state.fetchFault=fileId=>{if(fileId===broken)return f.response(503,'service unavailable');};assert.throws(()=>f.bootstrap(),/UNRESOLVED/);const c=saved(f),first=creates(f).filter(x=>x[1].id===broken);
 delete f.state.fetchFault;delete f.state.afterCreate;assert.deepEqual(f.bootstrap(),c);assert.equal(ids(f).length,1);assert.equal(writes(f).length,1);assert.equal(creates(f).filter(x=>x[1].id===broken).length,first.length);
});

for(const status of [401,403,429,500,503,302])test(`folder metadata HTTP ${status} is unresolved, never absence`,()=>{
 const f=fixture(),c=f.bootstrap(),before=creates(f).length;f.state.fetchFault=fileId=>fileId===c.metadataParentId?f.response(status,'{}'):null;
 assert.throws(()=>f.bootstrap(),e=>e.message==='OWNER_BOOTSTRAP_READ_UNRESOLVED'&&e.retryable&&e.status===status);assert.equal(creates(f).length,before);assert.equal(ids(f).length,1);
});

for(const [label,mutate] of [
 ['shared',m=>{m.shared=true;}],['ownership',m=>{m.ownedByMe=false;}],['trash',m=>{m.trashed=true;}],['mime',m=>{m.mimeType='text/plain';}],['ID',m=>{m.id='other';}],['parent',m=>{m.parents=['other'];}],['multiple parents',m=>{m.parents=['mydrive','other'];}],['missing parents',m=>{delete m.parents;}],['store marker',m=>{m.appProperties['mypace.store']='other';}],['script marker',m=>{m.appProperties['mypace.script']='other';}],['role marker',m=>{m.appProperties['mypace.role']='store-other';}],['protocol marker',m=>{m.appProperties['mypace.bootstrap']='other';}],['missing markers',m=>{delete m.appProperties;}]
])for(const key of ['rootParentId','metadataParentId','assetsParentId'])test(`${key} ${label} mismatch blocks read and bootstrap without writes`,()=>{
 const f=fixture(),c=f.bootstrap();mutate(f.files.get(c[key]).meta);const count=creates(f).length;for(const method of ['load','bootstrap'])assert.throws(()=>f.api()[method](),/FOLDER_MISMATCH/);assert.equal(creates(f).length,count);assert.equal(ids(f).length,1);
});

for(const text of ['null','[]','bad json','x'.repeat(16385)])test(`malformed folder metadata (${text.length} bytes) never means absence`,()=>{
 const f=fixture(),c=f.bootstrap();f.state.fetchFault=fileId=>fileId===c.rootParentId?f.response(200,text):null;assert.throws(()=>f.bootstrap(),/METADATA_INVALID/);assert.equal(creates(f).length,4);
});

test('load never reconstructs missing folders or missing anchor',()=>{
 for(const key of ['rootParentId','metadataParentId','assetsParentId','anchorId']){const f=fixture(),c=f.bootstrap();f.files.delete(c[key]);assert.throws(()=>f.api().load(),/FOLDER_MISSING|MISSING_REFERENCE/);assert.equal(creates(f).length,4);assert.equal(ids(f).length,1);}
});

test('same-name unmarked production-ID collision is rejected and existing probe is never adopted',()=>{
 const f=fixture();f.state.beforeCreate=meta=>{if(meta.appProperties['mypace.role']==='store-root')f.files.set(meta.id,{meta:{id:meta.id,name:meta.name,parents:meta.parents,mimeType:MIME,ownedByMe:true,shared:false,trashed:false}});};
 assert.throws(()=>f.bootstrap(),/FOLDER_MISMATCH/);assert.equal(creates(f).length,1);assert.equal(f.files.get('probe-folder').meta.name,'MyPace Private Store');assert.notEqual(saved(f).rootParentId,'probe-folder');
});

test('wrong My Drive identity or privacy stops before ID allocation or subsequent use',()=>{
 for(const mutate of [m=>{m.shared=true;},m=>{m.ownedByMe=false;},m=>{m.trashed=true;},m=>{m.mimeType='text/plain';}]){const f=fixture();mutate(f.files.get('mydrive').meta);assert.throws(()=>f.bootstrap(),/DRIVE_ROOT_INVALID/);assert.equal(ids(f).length,0);}
 const f=fixture();f.bootstrap();f.files.get('mydrive').meta.id='different';assert.throws(()=>f.api().load(),/DRIVE_ROOT_INVALID/);assert.equal(creates(f).length,4);
});

test('load validates canonical anchor hash and pinned slots, bootstrap never overwrites conflicts',()=>{
 const f=fixture(),c=f.bootstrap();sealedAnchor(f,c,a=>{a.payload.firstSlotId='other-slot';});assert.throws(()=>f.api().load(),/ANCHOR_MISMATCH/);assert.throws(()=>f.bootstrap(),/BOOTSTRAP_MISMATCH/);assert.equal(creates(f).length,4);
 const g=fixture(),d=g.bootstrap();const entry=g.files.get(d.anchorId),a=JSON.parse(decodeUtf8(entry.bytes));a.hash='a'.repeat(64);entry.bytes=encodeUtf8(canonical(a));entry.meta.size=String(entry.bytes.length);assert.throws(()=>g.api().load(),/HASH_MISMATCH/);assert.equal(creates(g).length,4);
});

test('read-only load does not repair a pending checkpoint-index publication',()=>{
 const f=fixture(),c=f.bootstrap();f.state.held=true;const w=realWriter(f,c);w.recoveryBarrier();
 f.state.beforeCreate=meta=>{if(meta.appProperties['mypace.role']==='checkpoint-index')throw Error('index publication interrupted');};
 assert.throws(()=>w.checkpoint({operationId:'checkpoint',digest:writerDigest('checkpoint'),changes:[]}),/CREATE_UNRESOLVED/);
 delete f.state.beforeCreate;f.state.held=false;const count=creates(f).length;
 assert.deepEqual(f.api().load(),c);assert.equal(creates(f).length,count);
 f.state.held=true;realWriter(f,c).recoveryBarrier();f.state.held=false;assert.equal(creates(f).length,count+1);
});

test('writer pinned bootstrap accepts exactly both distinct slots and allocates no IDs',()=>{
 const f=fixture(),c=f.bootstrap();f.state.held=true;const w=realWriter(f,c),count=ids(f).length;
 assert.deepEqual(w.readBootstrap().firstSlotId,c.firstSlotId);w.bootstrap({firstSlotId:c.firstSlotId,firstIndexId:c.firstIndexId});assert.equal(ids(f).length,count);
 for(const slots of [{firstSlotId:'one'},{firstIndexId:'two'},{firstSlotId:'same',firstIndexId:'same'},{firstSlotId:c.anchorId,firstIndexId:'two'},{firstSlotId:'bad/id',firstIndexId:'two'}])assert.throws(()=>w.bootstrap(slots),/SLOTS_INVALID/);
});


test('trusted parser is pure and validates owner, actual script and optional bootstrap contract',()=>{
 const f=fixture(),c=f.bootstrap(),raw=f.properties.get(OWNER_STORE_PROPERTY),before=f.events.length;
 assert.deepEqual(parsePinnedOwnerStoreConfig(raw,{ownerEmail:' OWNER@EXAMPLE.COM ',writerScriptId:'script_1'}),c);
 assert.equal(parsePinnedOwnerStoreConfig(null,{ownerEmail:'owner@example.com',writerScriptId:'script_1'}),null);
 assert.throws(()=>parsePinnedOwnerStoreConfig(raw,{ownerEmail:'other@example.com',writerScriptId:'script_1'}),/CONFIG_MISMATCH/);
 assert.throws(()=>parsePinnedOwnerStoreConfig(raw,{ownerEmail:'owner@example.com',writerScriptId:'clone'}),/CONFIG_MISMATCH/);
 assert.throws(()=>parsePinnedOwnerStoreConfig(raw,{ownerEmail:'owner@example.com',writerScriptId:'script_1',acceptedEpochs:['new']}),/CONFIG_MISMATCH/);
 assert.throws(()=>parsePinnedOwnerStoreConfig(raw,{ownerEmail:'owner@example.com',writerScriptId:'script_1',datasetGeneration:'2'}),/CONFIG_MISMATCH/);
 assert.equal(f.events.length,before);
});

for(const acceptedEpochs of [null,[],['same','same'],['one','two','three','four','five'],['bad/id'],[null]])test(`trusted parser rejects invalid epochs ${JSON.stringify(acceptedEpochs)}`,()=>{
 const f=fixture(),c=copy(f.bootstrap());c.acceptedEpochs=acceptedEpochs;
 assert.throws(()=>parsePinnedOwnerStoreConfig(JSON.stringify(c),{ownerEmail:'owner@example.com',writerScriptId:'script_1'}),/CONFIG_INVALID/);
});

test('custom bootstrap generation and ordered epochs remain immutable across restarts',()=>{
 const f=fixture(),options={datasetGeneration:'dataset-2',acceptedEpochs:['epoch-old','epoch-current']},c=f.api(options).bootstrap();
 assert.equal(c.datasetGeneration,'dataset-2');assert.deepEqual(c.acceptedEpochs,options.acceptedEpochs);
 assert.deepEqual(f.api(options).load(),c);assert.throws(()=>f.api().load(),/CONFIG_MISMATCH/);
 const parsed=parsePinnedOwnerStoreConfig(f.properties.get(OWNER_STORE_PROPERTY),{ownerEmail:'owner@example.com',writerScriptId:'script_1'});assert.deepEqual(parsed,c);
});
