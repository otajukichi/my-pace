import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createCheckpointHintCodec,createGasCheckpointHintCodec,CHECKPOINT_HINT_DOMAIN,CHECKPOINT_HINT_MAX_BYTES} from './checkpoint-hint.mjs';
import {GasStoreIO} from './gas-store-io.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {writerDigest} from './reserved-writer.mjs';
import {runtimeFixture} from './runtime-fixture.mjs';
import {ownerBootstrapFixture} from './owner-bootstrap-fixture.mjs';
import {OWNER_STORE_PROPERTY,parsePinnedOwnerStoreConfig} from './owner-bootstrap.mjs';
import {encodeUtf8,decodeUtf8} from './codec.mjs';
const secret='test-only-secret-that-has-at-least-32-bytes';
const hmac=text=>createHmac('sha256',secret).update(text).digest('hex');
const codec=createCheckpointHintCodec({hmacSha256:hmac});
function ioFixture(){
 const f=runtimeFixture();f.globals.Drive.Files.update=(meta,fileId,blob,options)=>{
  f.calls.push(['update',fileId,meta,options]);assert.equal(fileId,'hint');assert.deepEqual(meta,{});assert.deepEqual(options,{fields:'id'});
  const old=f.files.get(fileId);if(!old)throw Error('404');old.bytes=Uint8Array.from(blob.bytes);old.meta.size=String(old.bytes.length);return {id:fileId};
 };
 const config={...f.config,checkpointHintId:'hint',checkpointHintCodec:codec,protocolReadCache:{mode:'lock-phase'}};
 const io=new GasStoreIO({...f.globals,lock:f.lock,storeId:'store',managedParentId:'metadata',checkBudget:()=>true,checkpointHintId:'hint',protocolReadCache:{mode:'lock-phase'}});
 f.lock.tryLock(1);return {...f,config,io};
}
function command(operationId,changes=[]){return {operationId,digest:writerDigest({operationId,changes}),changes};}

test('portable hint authentication is HMAC over canonical domain-separated payload',()=>{
 const bytes=codec.encode({z:2,a:{x:1}}),raw=JSON.parse(decodeUtf8(bytes));
 assert.equal(raw.mac,hmac(CHECKPOINT_HINT_DOMAIN+'{"a":{"x":1},"z":2}'));
 assert.deepEqual(codec.decode(bytes),{a:{x:1},z:2});assert.deepEqual(bytes,codec.encode({a:{x:1},z:2}));
 assert.notEqual(raw.mac,hmac('{"a":{"x":1},"z":2}'));
});
for(const [label,mutate] of [
 ['forged MAC',x=>x.mac='0'.repeat(64)],['changed payload',x=>x.payload.revision=3],['extra envelope field',x=>x.extra=1],['missing MAC',x=>delete x.mac]
])test('codec ignores '+label,()=>{const x=JSON.parse(decodeUtf8(codec.encode({revision:2})));mutate(x);assert.equal(codec.decode(encodeUtf8(JSON.stringify(x))),null);});

test('codec rejects malformed, noncanonical, over-bound and callback-failure bytes',()=>{
 for(const value of [null,{},[],Uint8Array.of(255),encodeUtf8('{}'),encodeUtf8('null'),encodeUtf8(' '+decodeUtf8(codec.encode({ok:true}))),new Uint8Array(CHECKPOINT_HINT_MAX_BYTES+1)])assert.equal(codec.decode(value),null);
 const unavailable=createCheckpointHintCodec({hmacSha256:()=>{throw Error('unavailable');}});assert.equal(unavailable.decode(codec.encode({ok:true})),null);assert.throws(()=>unavailable.encode({ok:true}),/unavailable/);
 assert.throws(()=>createCheckpointHintCodec(),/AUTH_REQUIRED/);assert.throws(()=>createCheckpointHintCodec({hmacSha256:()=>null}).encode({ok:true}),/AUTH_INVALID/);
 assert.throws(()=>codec.encode({large:'x'.repeat(CHECKPOINT_HINT_MAX_BYTES)}),/BOUND/);
});

test('GAS codec uses explicit charset, signed Java bytes and manual bounded secret',()=>{
 const Utilities={Charset:{UTF_8:'utf8'},computeHmacSha256Signature:(text,key,charset)=>{assert.equal(key,secret);assert.equal(charset,'utf8');return [...createHmac('sha256',key).update(text).digest()].map(x=>x>127?x-256:x);}};
 assert.deepEqual(createGasCheckpointHintCodec({Utilities,secret}).encode({revision:1}),codec.encode({revision:1}));
 for(const key of [null,'','a'.repeat(31),'a'.repeat(4097)])assert.throws(()=>createGasCheckpointHintCodec({Utilities,secret:key}),/AUTH_REQUIRED/);
 assert.throws(()=>createGasCheckpointHintCodec({Utilities:{},secret}),/AUTH_REQUIRED/);
 assert.throws(()=>createGasCheckpointHintCodec({Utilities:{Charset:{UTF_8:'utf8'},computeHmacSha256Signature:()=>Array(32).fill(300)},secret}).encode({a:1}),/AUTH_INVALID/);
});

test('hint IO is fixed-ID, bounded, private and always uncached across same phase',()=>{
 const f=ioFixture(),one=codec.encode({one:1}),two=codec.encode({two:2});
 f.io.beginReadPhase();assert.equal(f.io.readCheckpointHint(),null);f.io.writeCheckpointHint(one);assert.deepEqual(f.io.readCheckpointHint(),one);
 f.io.writeCheckpointHint(two);assert.deepEqual(f.io.readCheckpointHint(),two);
 assert.equal(f.calls.filter(c=>c[0]==='create'&&c[1]==='hint').length,1);assert.equal(f.calls.filter(c=>c[0]==='update').length,1);
 assert.throws(()=>f.io.createFile('hint',one,'frame'),/HINT_ROLE/);assert.throws(()=>f.io.createFile('arbitrary',one,'checkpoint-hint'),/HINT_ROLE/);assert.throws(()=>f.io.readFile('hint'),/HINT_ROLE/);
 assert.throws(()=>f.io.writeCheckpointHint(new Uint8Array(CHECKPOINT_HINT_MAX_BYTES+1)),/HINT_WRITE/);
 assert.equal(f.files.has('arbitrary'),false);
});
for(const [label,mutate] of [
 ['shared',m=>m.shared=true],['wrong owner',m=>m.ownedByMe=false],['trashed',m=>m.trashed=true],['wrong parent',m=>m.parents=['assets']],['extra parent',m=>m.parents.push('assets')],['wrong role',m=>m.appProperties['mypace.role']='frame'],['wrong store',m=>m.appProperties['mypace.store']='other'],['wrong MIME',m=>m.mimeType='text/csv'],['wrong ID',m=>m.id='source']
])test('hint IO rejects '+label+' before reading media or updating',()=>{
 const f=ioFixture();f.io.writeCheckpointHint(codec.encode({a:1}));mutate(f.files.get('hint').meta);const before=f.calls.length;
 assert.throws(()=>f.io.readCheckpointHint(),/MISMATCH/);assert.throws(()=>f.io.writeCheckpointHint(codec.encode({b:2})),/MISMATCH/);
 assert.equal(f.calls.slice(before).some(c=>c[0]==='update'),false);
});

test('hint parent privacy is rechecked even inside a verified immutable phase',()=>{
 const f=ioFixture();f.io.writeCheckpointHint(codec.encode({a:1}));f.io.beginReadPhase();f.io.readCheckpointHint();f.files.get('metadata').meta.shared=true;
 assert.throws(()=>f.io.readCheckpointHint(),/PARENT_NOT_PRIVATE/);assert.throws(()=>f.io.writeCheckpointHint(codec.encode({b:2})),/PARENT_NOT_PRIVATE/);
});

test('mutable update response loss is bounded and cannot fail an authoritative checkpoint',()=>{
 const f=ioFixture(),r=createGasImportRuntime(f.globals,f.config);r.writer.bootstrap();r.writer.checkpoint(command('cp1'));
 const update=f.globals.Drive.Files.update;f.globals.Drive.Files.update=(...args)=>{update(...args);throw Error('lost response');};
 const result=r.writer.checkpoint(command('cp2'));assert.ok(result.revision>1);assert.equal(f.calls.filter(c=>c[0]==='update').length,1);
 const cold=createGasImportRuntime(f.globals,f.config);cold.writer.recoveryBarrier();assert.deepEqual(cold.writer.getReceipt('cp2'),result);
});

test('new bootstrap pins a distinct hint ID before any creates; missing key creates no hint',()=>{
 const f=ownerBootstrapFixture(),c=f.bootstrap(),a=JSON.parse(decodeUtf8(f.files.get(c.anchorId).bytes));
 assert.ok(c.checkpointHintId);assert.equal(a.payload.checkpointHintId,c.checkpointHintId);assert.equal(f.files.has(c.checkpointHintId),false);
 const ids=['rootParentId','metadataParentId','assetsParentId','anchorId','firstSlotId','firstIndexId','checkpointHintId'].map(k=>c[k]);assert.equal(new Set(ids).size,7);
 assert.deepEqual(f.api().load(),c);assert.equal(f.events.filter(e=>e[0]==='property-write').length,1);
 for(const key of ids){const modified={...c,checkpointHintId:key};if(key===c.checkpointHintId)continue;assert.throws(()=>parsePinnedOwnerStoreConfig(JSON.stringify(modified),{ownerEmail:c.ownerEmail,writerScriptId:c.writerScriptId}),/CONFIG_INVALID/);}
});

test('legacy config and anchor remain byte-identical without reset, ID reservation or property rewrite',()=>{
 const f=ownerBootstrapFixture(),c=f.bootstrap(),legacy={...c};delete legacy.checkpointHintId;
 const entry=f.files.get(c.anchorId),anchor=JSON.parse(decodeUtf8(entry.bytes));delete anchor.payload.checkpointHintId;const {hash,...body}=anchor;anchor.hash=writerDigest(body);
 const sorted=x=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])])):Array.isArray(x)?x.map(sorted):x;
 entry.bytes=encodeUtf8(JSON.stringify(sorted(anchor)));entry.meta.size=String(entry.bytes.length);f.properties.set(OWNER_STORE_PROPERTY,JSON.stringify(legacy));
 const raw=f.properties.get(OWNER_STORE_PROPERTY),bytes=Uint8Array.from(entry.bytes),before=f.events.length;
 assert.deepEqual(f.api().load(),legacy);assert.deepEqual(f.bootstrap(),legacy);assert.equal(f.properties.get(OWNER_STORE_PROPERTY),raw);assert.deepEqual(entry.bytes,bytes);
 assert.equal(f.events.slice(before).some(e=>['ids','create','property-write'].includes(e[0])),false);
});
