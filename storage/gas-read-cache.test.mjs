import test from 'node:test';
import assert from 'node:assert/strict';
import {GasStoreIO} from './gas-store-io.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {runtimeFixture} from './runtime-fixture.mjs';
import {createHash} from 'node:crypto';
import {importKeys} from './import-store.mjs';

function cachedFixture(cache={mode:'lock-phase'}) {
 const f=runtimeFixture();
 const io=new GasStoreIO({...f.globals,lock:f.lock,storeId:'store',managedParentId:'metadata',checkBudget:()=>f.allowed!==false,protocolReadCache:cache});
 f.lock.tryLock();io.beginReadPhase();
 const add=(id,bytes=Uint8Array.of(1,2))=>{const entry={meta:{id,parents:['metadata'],appProperties:{'mypace.store':'store','mypace.role':'frame'},size:String(bytes.length),version:'1',md5Checksum:createHash('md5').update(bytes).digest('hex'),trashed:false,ownedByMe:true,shared:false,mimeType:'application/octet-stream'},bytes};f.files.set(id,entry);return entry;};
 const count=id=>f.calls.filter(c=>c[0]==='fetch'&&(!id||c[1]===id)).length;
 return {...f,io,add,count,state:f};
}

test('protocol positive cache is opt-in, with no effect until a phase starts',()=>{
 for(const option of [false,true,{mode:'lock-phase'}]){
  const f=cachedFixture(option);f.io.endReadPhase();f.add('one');f.io.readFile('one');f.io.readFile('one');assert.equal(f.count(),6);
 }
 const f=cachedFixture(false);f.add('one');f.io.readFile('one');f.io.readFile('one');assert.equal(f.count(),6);
});
test('lock-phase cache stores only complete verified positive reads and returns defensive copies',()=>{
 const f=cachedFixture();f.add('one');const first=f.io.readFile('one');first[0]=99;const second=f.io.readFile('one');assert.deepEqual(second,Uint8Array.of(1,2));second[1]=99;assert.deepEqual(f.io.readFile('one'),Uint8Array.of(1,2));assert.equal(f.count(),3);
});
test('strict byte mode revalidates privacy metadata even inside the same phase',()=>{
 const f=cachedFixture(true),entry=f.add('one');f.io.readFile('one');f.io.readFile('one');assert.equal(f.count(),4);entry.meta.shared=true;assert.throws(()=>f.io.readFile('one'),/STORE_METADATA_MISMATCH/);assert.equal(f.count(),5);
});
test('strict byte mode downloads changed version or checksum again',()=>{
 for(const key of ['version','md5Checksum']){const f=cachedFixture(true),entry=f.add('one');entry.meta[key]=key==='version'?'1':'a'.repeat(32);f.io.readFile('one');entry.meta[key]=key==='version'?'2':'b'.repeat(32);entry.bytes[0]=3;assert.deepEqual(f.io.readFile('one'),Uint8Array.of(3,2));assert.equal(f.count(),5);}
});
test('missing slots are never cached and later positive visibility is discovered',()=>{
 const f=cachedFixture();assert.equal(f.io.readFile('one'),null);assert.equal(f.io.readFile('one'),null);f.add('one');assert.deepEqual(f.io.readFile('one'),Uint8Array.of(1,2));assert.equal(f.count(),5);
});
test('failed metadata and media responses cannot become cached success',()=>{
 const f=cachedFixture(),entry=f.add('one');entry.meta.shared=true;assert.throws(()=>f.io.readFile('one'),/STORE_METADATA_MISMATCH/);entry.meta.shared=false;entry.bytes=Uint8Array.of(1);assert.throws(()=>f.io.readFile('one'),/STORE_RANGE_INVALID/);entry.bytes=Uint8Array.of(1,2);assert.deepEqual(f.io.readFile('one'),entry.bytes);assert.equal(f.count(),6);
});
test('cache hits obey narrower caller bounds, lock ownership and current budget',()=>{
 const f=cachedFixture();f.add('one');f.io.readFile('one');assert.throws(()=>f.io.readFile('one',1),/STORE_SIZE_INVALID/);f.state.allowed=false;assert.throws(()=>f.io.readFile('one'),/STORE_YIELD/);f.state.allowed=true;f.lock.releaseLock();assert.throws(()=>f.io.readFile('one'),/STORE_LOCK_REQUIRED/);assert.equal(f.io._readCache.size,0);assert.equal(f.count(),3);
});
test('entry-count cap evicts least recently used positive file',()=>{
 const f=cachedFixture({mode:'lock-phase',maxEntries:2,maxBytes:8});for(const id of ['one','two','three'])f.add(id);f.io.readFile('one');f.io.readFile('two');f.io.readFile('one');f.io.readFile('three');assert.equal(f.io._readCache.size,2);assert.equal(f.io._readCacheBytes,4);f.io.readFile('one');assert.equal(f.count('one'),2);f.io.readFile('two');assert.equal(f.count('two'),4);
});
test('aggregate byte cap evicts before retaining another file',()=>{
 const f=cachedFixture({mode:'lock-phase',maxEntries:10,maxBytes:3});f.add('one');f.add('two');f.io.readFile('one');f.io.readFile('two');assert.equal(f.io._readCache.size,1);assert.equal(f.io._readCacheBytes,2);f.io.readFile('one');assert.equal(f.count('one'),4);
});
test('files larger than total cache byte cap remain uncached',()=>{
 const f=cachedFixture({mode:'lock-phase',maxBytes:1});f.add('one');f.io.readFile('one');f.io.readFile('one');assert.equal(f.io._readCacheBytes,0);assert.equal(f.count(),5);
});
test('ending or restarting a phase drops every retained byte',()=>{
 const f=cachedFixture();f.add('one');f.io.readFile('one');f.io.endReadPhase();assert.equal(f.io._readCache.size,0);assert.equal(f.io._readCacheBytes,0);f.io.beginReadPhase();f.io.readFile('one');f.io.beginReadPhase();f.io.readFile('one');assert.equal(f.count(),9);
});
test('create result never seeds cache, and same-ID create invalidates earlier readback',()=>{
 const f=cachedFixture();f.io.createFile('one',Uint8Array.of(1,2),'frame');assert.equal(f.io._readCache.size,0);f.io.readFile('one');assert.equal(f.count('one'),2);assert.throws(()=>f.io.createFile('one',Uint8Array.of(3,4),'frame'),/conflict/);f.io.readFile('one');assert.equal(f.count('one'),4);
});
test('managed parent privacy is checked freshly before every create',()=>{
 const f=cachedFixture();f.io.createFile('one',Uint8Array.of(1),'frame');f.files.get('metadata').meta.shared=true;assert.throws(()=>f.io.createFile('two',Uint8Array.of(1),'frame'),/STORE_PARENT_NOT_PRIVATE/);assert.equal(f.files.has('two'),false);assert.equal(f.count('metadata'),2);
});
for(const cache of [null,0,'yes',[],{mode:'all'},{maxBytes:0},{maxBytes:8388609},{maxBytes:1.5},{maxEntries:0},{maxEntries:1025},{maxEntries:1.5},{unknown:true}])test('invalid cache config is rejected '+JSON.stringify(cache),()=>assert.throws(()=>cachedFixture(cache),/STORE_CACHE_CONFIG/));

function runtimeSetup(){const f=runtimeFixture();f.config.protocolReadCache={mode:'lock-phase'};const r=createGasImportRuntime(f.globals,f.config);r.locked(()=>r.writer.bootstrap());return {f,r};}
test('runtime invalidates cache at release, reacquisition and exceptional exit',()=>{
 const {f,r}=runtimeSetup();const before=f.calls.length;r.locked(()=>{r.writer.readBootstrap();r.locked(()=>r.writer.readBootstrap());});assert.equal(f.calls.length-before,3);assert.equal(r.writer.io._readCache.size,0);
 assert.throws(()=>r.locked(()=>{r.writer.readBootstrap();throw Error('stop');}),/stop/);assert.equal(f.lock.hasLock(),false);assert.equal(r.writer.io._readCache.size,0);
 f.files.get('anchor').meta.shared=true;assert.throws(()=>r.locked(()=>r.writer.readBootstrap()),/STORE_METADATA_MISMATCH/);assert.equal(f.lock.hasLock(),false);
});
test('externally acquired lock never enables a runtime cache it cannot invalidate',()=>{
 const {f,r}=runtimeSetup();f.lock.tryLock();const before=f.calls.length;r.locked(()=>r.writer.readBootstrap());r.locked(()=>r.writer.readBootstrap());assert.equal(f.calls.length-before,6);assert.equal(r.writer.io._readCache.size,0);f.lock.releaseLock();
});
test('corrupted protocol content is re-read and rejected on the next lock phase',()=>{
 const {f,r}=runtimeSetup();r.locked(()=>r.writer.readBootstrap());f.files.get('anchor').bytes[0]=0;assert.throws(()=>r.locked(()=>r.writer.readBootstrap()),/WRITER_FILE_INVALID/);assert.equal(r.writer.io._readCache.size,0);
});
test('coordinator and runner phases leave no cached trust between acquisitions',()=>{
 const {f,r}=runtimeSetup();r.locked(()=>r.store.registerJob({operationId:'register',jobId:'job',sourceIdentity:f.source}));assert.equal(r.runner.stepJob('job').status,'parsed');assert.equal(f.lock.hasLock(),false);assert.equal(r.writer.io._readCache.size,0);assert.equal(r.writer.io._readCacheActive,false);
});
test('managed asset privacy remains fresh even during one cached protocol phase',()=>{
 const {f,r}=runtimeSetup();r.locked(()=>r.store.registerJob({operationId:'register',jobId:'job',sourceIdentity:f.source}));r.runner.stepJob('job');
 r.locked(()=>{const job=r.store.resumeJob('job').job;f.files.get(job.checkpoint.fileId).meta.shared=true;const before=f.calls.length;assert.throws(()=>r.store.resumeJob('job'),/ASSET_METADATA_MISMATCH/);assert.equal(f.calls.slice(before).filter(c=>c[0]==='fetch'&&c[1]===job.checkpoint.fileId).length,0);});
});
test('cancellation in another runtime invalidates old cached reservation before asset create',()=>{
 const {f,r}=runtimeSetup();r.locked(()=>r.store.registerJob({operationId:'register',jobId:'job',sourceIdentity:f.source}));r.runner.stepJob('job');const job=r.locked(()=>r.store.resumeJob('job')).job;const asset=r.locked(()=>r.writer.get(importKeys.pin(job.lastPin)).value.assets.find(a=>a.role==='output'));
 const other=createGasImportRuntime(f.globals,f.config);other.locked(()=>other.store.cancelJob({operationId:'cancel',jobId:'job'}));const before=f.calls.filter(c=>c[0]==='create').length;assert.throws(()=>r.assets.putOnce({reservation:asset,bytes:f.files.get(asset.fileId).bytes}),/RESERVATION_NOT_DURABLE/);assert.equal(f.calls.filter(c=>c[0]==='create').length,before);
});
test('failed recovery of an uncached successor still invalidates writer state',()=>{
 const {f,r}=runtimeSetup();r.locked(()=>{r.writer.recoveryBarrier();const next=r.writer.status().nextSlotId,fetch=f.globals.UrlFetchApp.fetch;f.globals.UrlFetchApp.fetch=(url,o)=>{if(new URL(url).pathname.endsWith('/'+next))throw Error('outage');return fetch(url,o);};assert.throws(()=>r.writer.recoveryBarrier(),/STORE_READ_UNRESOLVED/);assert.throws(()=>r.writer.status(),/WRITER_RECOVERY_REQUIRED/);});
});

test('strict byte cache refuses absent or malformed immutable revision evidence',()=>{for(const patch of [{version:undefined},{md5Checksum:undefined},{version:'0'},{version:'x'},{md5Checksum:'abc'}]){const f=cachedFixture(true),entry=f.add('one');Object.assign(entry.meta,patch);f.io.readFile('one');f.io.readFile('one');assert.equal(f.count(),5);assert.equal(f.io._readCache.size,0);}});
