import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {ownerBootstrapFixture} from './owner-bootstrap-fixture.mjs';
import {OWNER_STORE_PROPERTY} from './owner-bootstrap.mjs';
import {createGasCheckpointHintCodec,CHECKPOINT_HINT_PROTOCOL} from './checkpoint-hint.mjs';
import {ReservedSlotWriter,writerDigest} from './reserved-writer.mjs';
import {GasStoreIO} from './gas-store-io.mjs';
import {encodeUtf8,decodeUtf8} from './codec.mjs';
const secret='test-only-owner-managed-secret-at-least-32-bytes';
const owner='yakitorihanbagu0412@gmail.com';
const canonical=x=>JSON.stringify(sort(x));
const sort=x=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;
const copies=x=>structuredClone(x);
const writeEvents=f=>f.events.filter(x=>['create','update','property-write'].includes(x[0]));
const reservationEvents=f=>f.events.filter(x=>x[0]==='ids');
function fixture(options={}){
 const f=ownerBootstrapFixture(options);
 Object.assign(f.globals.Utilities,{Charset:{UTF_8:'utf8'},computeHmacSha256Signature:(text,key,charset)=>{assert.equal(charset,'utf8');return Array.from(createHmac('sha256',key).update(text).digest(),x=>x>127?x-256:x);}});
 f.properties.set('MYPACE_WRITER_SECRET',secret);
 f.globals.Drive.Files.get=fileId=>copies(f.files.get(fileId)?.meta);
 f.globals.Drive.Files.update=(metadata,fileId,blob,options)=>{f.events.push(['update',fileId,copies(metadata)]);const entry=f.files.get(fileId);assert.ok(entry);entry.bytes=Uint8Array.from(blob.bytes);entry.meta.size=String(entry.bytes.length);return {id:fileId};};
 return f;
}
function makeLegacy(f,{discovery=false,hint=false,bootstrapOptions}={}){
 const c=copies(f.api(bootstrapOptions).bootstrap());
 if(!hint){delete c.checkpointHintId;const entry=f.files.get(c.anchorId),a=JSON.parse(decodeUtf8(entry.bytes));delete a.payload.checkpointHintId;const {hash,...body}=a;a.hash=writerDigest(body);entry.bytes=encodeUtf8(canonical(a));entry.meta.size=String(entry.bytes.length);}
 if(!discovery)delete c.discoveryStateId;
 f.properties.set(OWNER_STORE_PROPERTY,JSON.stringify(c));return c;
}
function writer(f,c,{authenticated=false,limits}={}){
 const io=new GasStoreIO({...f.globals,lock:f.lock,storeId:c.storeId,managedParentId:c.metadataParentId,checkBudget:()=>true,checkpointHintId:c.checkpointHintId});
 return new ReservedSlotWriter({io,storeId:c.storeId,writerScriptId:c.writerScriptId,anchorId:c.anchorId,checkpointHintId:c.checkpointHintId,checkpointHintAnchorHash:c.checkpointHintAnchorHash,...(authenticated?{checkpointHintCodec:createGasCheckpointHintCodec({Utilities:f.globals.Utilities,secret})}:{}),limits});
}
function history(f,c,count=3){f.lock.tryLock(1);const w=writer(f,c);for(let i=0;i<count;i++)w.checkpoint({operationId:'legacy_cp_'+i,digest:writerDigest(i),changes:[]});f.lock.releaseLock();}
function anchorHash(f,c){f.lock.tryLock(1);const hash=writer(f,c).readBootstrapInfo().hash;f.lock.releaseLock();return hash;}
function repair(f){return f.api().repairRecoveryConfiguration();}

test('legacy repair pins only missing IDs and exact immutable anchor hash without Drive writes',()=>{
 const f=fixture(),old=makeLegacy(f);history(f,old);const files=copies(f.files),beforeWrites=writeEvents(f).length,beforeIds=reservationEvents(f).length,hash=anchorHash(f,old);
 const c=repair(f);for(const [key,value] of Object.entries(old))assert.deepEqual(c[key],value,key);
 assert.equal(c.checkpointHintAnchorHash,hash);assert.notEqual(c.checkpointHintId,c.discoveryStateId);assert.equal(reservationEvents(f).length,beforeIds+1);assert.equal(reservationEvents(f).at(-1)[1].count,2);
 assert.deepEqual(f.files,files);assert.equal(writeEvents(f).length,beforeWrites+1);assert.equal(writeEvents(f).at(-1)[0],'property-write');
 assert.deepEqual(f.api().load(),c);assert.deepEqual(repair(f),c);assert.equal(reservationEvents(f).length,beforeIds+1);assert.equal(writeEvents(f).length,beforeWrites+1);assert.equal(f.properties.get('MYPACE_WRITER_SECRET'),secret);
});

test('repair of modern eight-ID config is read-only and keeps every fixed ID',()=>{const f=fixture(),c=f.bootstrap(),writes=writeEvents(f).length,ids=reservationEvents(f).length;assert.deepEqual(repair(f),c);assert.equal(writeEvents(f).length,writes);assert.equal(reservationEvents(f).length,ids);assert.equal(Object.hasOwn(c,'checkpointHintAnchorHash'),false);});

test('hinted older config allocates only discovery ID and preserves its embedded hint binding',()=>{
 const f=fixture(),old=makeLegacy(f,{hint:true}),files=copies(f.files),count=reservationEvents(f).length,c=repair(f);
 assert.equal(c.checkpointHintId,old.checkpointHintId);assert.equal(c.checkpointHintAnchorHash,undefined);assert.ok(c.discoveryStateId);assert.equal(reservationEvents(f).length,count+1);assert.equal(reservationEvents(f).at(-1)[1].count,1);assert.deepEqual(f.files,files);
});

test('legacy config with discovery pin allocates only a hint pin',()=>{const f=fixture(),old=makeLegacy(f,{discovery:true}),c=repair(f);assert.equal(c.discoveryStateId,old.discoveryStateId);assert.equal(reservationEvents(f).at(-1)[1].count,1);assert.ok(c.checkpointHintAnchorHash);});

for(const key of [undefined,'','short'])test(`repair requires existing valid owner secret (${String(key)}) before allocation`,()=>{
 const f=fixture();makeLegacy(f);if(key===undefined)f.properties.delete('MYPACE_WRITER_SECRET');else f.properties.set('MYPACE_WRITER_SECRET',key);const before=copies(f.properties),ids=reservationEvents(f).length,writes=writeEvents(f).length;
 assert.throws(()=>repair(f),e=>e.code==='OWNER_RECOVERY_SECRET_REQUIRED'&&e.requiresOwnerAction===true&&typeof e.setup==='string');assert.deepEqual(f.properties,before);assert.equal(reservationEvents(f).length,ids);assert.equal(writeEvents(f).length,writes);
});

test('repair rejects unavailable HMAC implementation and secret-read failure safely',()=>{
 const f=fixture();makeLegacy(f);delete f.globals.Utilities.computeHmacSha256Signature;assert.throws(()=>repair(f),/OWNER_RECOVERY_SECRET_REQUIRED/);
 const g=fixture();makeLegacy(g);g.state.propertyReadFault=key=>{if(key==='MYPACE_WRITER_SECRET')throw Error('secret detail must not escape');};assert.throws(()=>repair(g),e=>e.message==='OWNER_RECOVERY_SECRET_UNRESOLVED'&&e.retryable);assert.equal(reservationEvents(g).length,1);
});

for(const mutation of [{active:'other@example.com'},{active:''},{effective:'other@example.com'},{script:'clone'}])test(`repair rejects wrong execution identity ${JSON.stringify(mutation)} before IO`,()=>{
 const f=fixture();makeLegacy(f);Object.assign(f.state,mutation);const before=f.events.length;assert.throws(()=>repair(f),/OWNER_UNVERIFIED|SCRIPT_MISMATCH/);assert.equal(f.events.length,before);
});

test('repair rejects another actual script even with optional expectedScriptId omitted',()=>{const f=fixture();makeLegacy(f);f.state.script='clone';const count=reservationEvents(f).length;assert.throws(()=>f.api({expectedScriptId:undefined}).repairRecoveryConfiguration(),/CONFIG_MISMATCH/);assert.equal(reservationEvents(f).length,count);});

for(const key of ['rootParentId','metadataParentId','assetsParentId','anchorId'])test(`missing ${key} blocks repair before ID reservation`,()=>{
 const f=fixture(),c=makeLegacy(f);f.files.delete(c[key]);const ids=reservationEvents(f).length,writes=writeEvents(f).length;assert.throws(()=>repair(f),/FOLDER_MISSING|MISSING_REFERENCE/);assert.equal(reservationEvents(f).length,ids);assert.equal(writeEvents(f).length,writes);
});

test('private folder and canonical anchor checks precede repair allocation',()=>{
 const f=fixture(),c=makeLegacy(f);f.files.get(c.assetsParentId).meta.shared=true;assert.throws(()=>repair(f),/FOLDER_MISMATCH/);assert.equal(reservationEvents(f).length,1);
 const g=fixture(),d=makeLegacy(g),entry=g.files.get(d.anchorId),raw=JSON.parse(decodeUtf8(entry.bytes));raw.hash='a'.repeat(64);entry.bytes=encodeUtf8(canonical(raw));entry.meta.size=String(entry.bytes.length);assert.throws(()=>repair(g),/HASH_MISMATCH/);assert.equal(reservationEvents(g).length,1);
});

test('ambiguous successful config write resolves exact readback and retries allocate nothing',()=>{
 const f=fixture();makeLegacy(f);f.state.afterPropertyWrite=()=>{throw Error('lost response');};const c=repair(f),count=reservationEvents(f).length;delete f.state.afterPropertyWrite;assert.deepEqual(repair(f),c);assert.equal(reservationEvents(f).length,count);assert.equal(f.files.has(c.checkpointHintId),false);
});

test('unreadable write readback pauses without Drive writes, restart uses persisted IDs',()=>{
 const f=fixture();makeLegacy(f);const files=copies(f.files);f.state.afterPropertyWrite=()=>{f.state.propertyReadFault=()=>{throw Error('interrupted');};};assert.throws(()=>repair(f),/CONFIG_UNRESOLVED/);const c=JSON.parse(f.properties.get(OWNER_STORE_PROPERTY)),count=reservationEvents(f).length;assert.deepEqual(f.files,files);delete f.state.afterPropertyWrite;delete f.state.propertyReadFault;assert.deepEqual(repair(f),c);assert.equal(reservationEvents(f).length,count);
});

test('failed or concurrent configuration writes never mutate Drive or overwrite another config',()=>{
 const f=fixture();const old=makeLegacy(f),files=copies(f.files);f.state.beforePropertyWrite=()=>{throw Error('write rejected');};assert.throws(()=>repair(f),/CONFIG_WRITE_UNRESOLVED/);assert.deepEqual(JSON.parse(f.properties.get(OWNER_STORE_PROPERTY)),old);assert.deepEqual(f.files,files);
 const g=fixture();makeLegacy(g);g.state.idsFault=()=>{g.properties.set(OWNER_STORE_PROPERTY,'changed independently');return {ids:['repair_hint','repair_discovery']};};assert.throws(()=>repair(g),/CONFIG_CHANGED/);assert.equal(g.properties.get(OWNER_STORE_PROPERTY),'changed independently');
});

test('newly reserved repair IDs must be valid, unique and distinct from all existing pins',()=>{
 for(const generated of [[],['same','same'],['invalid/id','good'],['reserved_1','good']]){const f=fixture();makeLegacy(f);const before=f.properties.get(OWNER_STORE_PROPERTY);f.state.idsFault=()=>({ids:generated});assert.throws(()=>repair(f),/IDS_INVALID|CONFIG_INVALID/);assert.equal(f.properties.get(OWNER_STORE_PROPERTY),before);}
});

test('authenticated missing-authority witness is preserved by repair and fails closed in recovery',()=>{
 const f=fixture(),c=makeLegacy(f,{hint:true}),hash=anchorHash(f,c),codec=createGasCheckpointHintCodec({Utilities:f.globals.Utilities,secret});f.lock.tryLock(1);const w=writer(f,c,{authenticated:true});
 w.io.writeCheckpointHint(codec.encode({protocol:CHECKPOINT_HINT_PROTOCOL,anchorId:c.anchorId,anchorHash:hash,hintFileId:c.checkpointHintId,storeId:c.storeId,writerScriptId:c.writerScriptId,schemaVersion:3,datasetGeneration:c.datasetGeneration,indexRef:{id:'missing-index',hash:'b'.repeat(64)},indexLinks:1}));f.lock.releaseLock();
 const witness=copies(f.files.get(c.checkpointHintId)),repaired=repair(f);assert.deepEqual(f.files.get(c.checkpointHintId),witness);assert.equal(repaired.checkpointHintId,c.checkpointHintId);
 f.lock.tryLock(1);assert.throws(()=>writer(f,repaired,{authenticated:true}).recoveryBarrier(),/MISSING_REFERENCE/);f.lock.releaseLock();assert.deepEqual(f.files.get(c.checkpointHintId),witness);
});

test('missing advice is recreated at the same configured ID after repair, without replacement pins',()=>{
 const f=fixture(),legacy=makeLegacy(f);history(f,legacy);const c=repair(f),ids=reservationEvents(f).length;
 f.lock.tryLock(1);const first=writer(f,c,{authenticated:true}).recoveryBarrier();f.lock.releaseLock();assert.ok(f.files.has(c.checkpointHintId));f.files.delete(c.checkpointHintId);assert.deepEqual(repair(f),c);assert.equal(reservationEvents(f).length,ids);
 f.lock.tryLock(1);const second=writer(f,c,{authenticated:true}).recoveryBarrier();f.lock.releaseLock();assert.equal(second.revision,first.revision);assert.ok(f.files.has(c.checkpointHintId));assert.equal(reservationEvents(f).length,ids);assert.equal(f.events.filter(e=>e[0]==='create'&&e[1].id===c.checkpointHintId).length,2);
});

function editor(){
 execFileSync(process.execPath,['build-gas.mjs'],{cwd:new URL('.',import.meta.url)});
 const f=fixture({active:owner,effective:owner});f.config.ownerEmail=owner;const logs=[];
 const context={...f.globals,console:{log:x=>logs.push(x)}};vm.createContext(context);vm.runInContext(fs.readFileSync(new URL('gas/OwnerImportKit.gs',import.meta.url),'utf8'),context);return {f,context,logs};
}
test('maintenance editor wrappers report setup-needed without secrets or implicit first-store creation',()=>{
 const {f,context,logs}=editor();assert.equal(f.events.length,0);assert.equal(context.MyPaceRepairRecoveryConfiguration().status,'setup-needed');assert.equal(context.MyPaceRecoverStorage().status,'setup-needed');assert.equal(reservationEvents(f).length,0);
 makeLegacy(f);f.properties.delete('MYPACE_WRITER_SECRET');const r=context.MyPaceRepairRecoveryConfiguration();assert.equal(r.status,'setup-needed');assert.equal(r.code,'OWNER_RECOVERY_SECRET_REQUIRED');assert.equal(logs.some(x=>x.includes(secret)),false);
});

test('editor repair/recover reports bounded recovering and eventually ready without resetting history',()=>{
 const {f,context,logs}=editor(),old=makeLegacy(f);history(f,old,4);const anchor=copies(f.files.get(old.anchorId));
 const repaired=context.MyPaceRepairRecoveryConfiguration();assert.equal(repaired.status,'recovery-configured');
 const original=context.MyPaceFolderImport.createGasImportRuntime;context.MyPaceFolderImport.createGasImportRuntime=(g,c)=>original(g,{...c,writerLimits:{maxIndexScanLinks:1}});
 let result=context.MyPaceRecoverStorage(),pending=0;while(result.status==='recovering'&&pending<10){assert.equal(result.code,'WRITER_RECOVERY_PENDING');assert.equal(result.cursorPersisted,true);pending++;result=context.MyPaceRecoverStorage();}
 assert.ok(pending>=1);assert.equal(result.status,'ready');assert.equal(result.storage.revision,4);assert.deepEqual(f.files.get(old.anchorId),anchor);assert.equal(logs.some(x=>x.includes(secret)),false);assert.equal(context.doGet,undefined);assert.equal(context.doPost,undefined);
});

test('maintenance wrappers keep strict owner guard and do not classify missing authority as setup',()=>{
 const {f,context}=editor(),c=makeLegacy(f);context.MyPaceRepairRecoveryConfiguration();f.state.active='visitor@example.com';const before=f.events.length;for(const fn of ['MyPaceRepairRecoveryConfiguration','MyPaceRecoverStorage'])assert.throws(()=>context[fn](),/OWNER_UNVERIFIED/);assert.equal(f.events.length,before);
 f.state.active=owner;f.files.delete(c.anchorId);assert.throws(()=>context.MyPaceRecoverStorage(),/MISSING_REFERENCE/);
});


test('maintenance preserves nondefault legacy generation and ordered epochs while ordinary import load stays strict',()=>{
 const f=fixture(),old=makeLegacy(f,{bootstrapOptions:{datasetGeneration:'historical-generation',acceptedEpochs:['older-epoch','current-epoch']}});
 f.lock.tryLock(1);writer(f,old).checkpoint({operationId:'historical_checkpoint',epoch:'current-epoch',digest:writerDigest('historical'),changes:[]});f.lock.releaseLock();
 const original=copies(f.files.get(old.anchorId)),c=repair(f);assert.equal(c.datasetGeneration,'historical-generation');assert.deepEqual(c.acceptedEpochs,['older-epoch','current-epoch']);assert.deepEqual(f.files.get(old.anchorId),original);
 assert.throws(()=>f.api().load(),/CONFIG_MISMATCH/);assert.deepEqual(f.api().loadRecoveryConfiguration(),c);
 f.lock.tryLock(1);const state=writer(f,c,{authenticated:true}).recoveryBarrier();f.lock.releaseLock();assert.equal(state.revision,1);assert.equal(state.datasetGeneration,'historical-generation');assert.deepEqual(state.acceptedEpochs,['older-epoch','current-epoch']);
});

test('maintenance editor helpers recover nondefault legacy store without changing current import compatibility',()=>{
 const {f,context}=editor(),old=makeLegacy(f,{bootstrapOptions:{datasetGeneration:'historical',acceptedEpochs:['historic-epoch']}}),before=copies(f.files.get(old.anchorId));
 assert.equal(context.MyPaceRepairRecoveryConfiguration().status,'recovery-configured');const result=context.MyPaceRecoverStorage();assert.equal(result.status,'ready');assert.equal(result.storage.datasetGeneration,'historical');assert.deepEqual(Array.from(result.storage.acceptedEpochs),['historic-epoch']);assert.deepEqual(f.files.get(old.anchorId),before);assert.throws(()=>context.MyPaceImportStatus(),/CONFIG_MISMATCH/);
});

test('HMAC execution must work before repair reserves IDs',()=>{const f=fixture();makeLegacy(f);f.globals.Utilities.computeHmacSha256Signature=()=>[];const count=reservationEvents(f).length;assert.throws(()=>repair(f),/OWNER_RECOVERY_SECRET_REQUIRED/);assert.equal(reservationEvents(f).length,count);});
