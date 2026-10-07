// Independent adversarial review: all files and credentials are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
import {ReservedSlotWriter,writerDigest} from './reserved-writer.mjs';
import {createCheckpointHintCodec,createGasCheckpointHintCodec} from './checkpoint-hint.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {runtimeFixture} from './runtime-fixture.mjs';
import {encodeUtf8,decodeUtf8} from './codec.mjs';

const KEY='synthetic-review-key-material-0123456789';
const codecFor=key=>createCheckpointHintCodec({hmacSha256:text=>createHmac('sha256',key).update(text).digest('hex')});
const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
const bytes=v=>encodeUtf8(JSON.stringify(sorted(v)));
const command=(operationId,changes=[])=>({operationId,digest:writerDigest({operationId,changes}),changes});
const put=(id,key,value,expectedVersion=0)=>command(id,[{key,value,expectedVersion}]);
function fixture(overrides={}){
 const files=new Map(),calls=[],faults={};let serial=0,hint=null;const phase={};
 const io={
  checkpointHintId:'hint',getScriptId:()=> 'script',assertLockHeld:()=>true,getVerifiedReadPhase:()=>phase,
  allocateIds:n=>Array.from({length:n},()=>`file_${++serial}`),
  readFile(id,max){calls.push(['read',id]);if(faults.read)faults.read(id);const b=files.get(id);if(!b)return null;assert(b.length<=max);return Uint8Array.from(b);},
  createFile(id,b,role){calls.push(['create',id,role]);if(faults.create)faults.create(id,b,role);if(files.has(id))throw Error('409');files.set(id,Uint8Array.from(b));return {id};},
  readCheckpointHint(){calls.push(['hint-read','hint']);if(faults.hintRead)faults.hintRead();return hint?Uint8Array.from(hint):null;},
  writeCheckpointHint(b){calls.push(['hint-write','hint']);if(faults.beforeHintWrite)faults.beforeHintWrite(b);hint=Uint8Array.from(b);if(faults.afterHintWrite)faults.afterHintWrite(b);}
 };
 const config={io,anchorId:'anchor',checkpointHintId:'hint',storeId:'store',writerScriptId:'script',checkpointHintCodec:codecFor(KEY),clock:()=> '2026-10-06T15:00:00.000Z',...overrides};
 const fresh=extra=>new ReservedSlotWriter({...config,...extra}),writer=fresh();writer.bootstrap();
 return {files,calls,faults,io,config,fresh,writer,get hint(){return hint&&Uint8Array.from(hint);},set hint(v){hint=v&&Uint8Array.from(v);}};
}
function objects(f,kind){return [...f.files].map(([id,b])=>({id,...JSON.parse(decodeUtf8(b))})).filter(o=>o.kind===kind);}
function object(f,id){return JSON.parse(decodeUtf8(f.files.get(id)));}
function reseal(f,id,mutate){const o=object(f,id);mutate(o);const {hash,...body}=o;o.hash=writerDigest(body);f.files.set(id,bytes(o));}
function populate(f,count){for(let i=0;i<count;i++){f.writer.transact(put('put_'+i,'x',i,i));f.writer.checkpoint(command('cp_'+i));}return f.writer.status();}
function recover(f,extra){const w=f.fresh(extra);w.recoveryBarrier();return w;}
function invalidates(f,expression){const w=f.fresh();assert.throws(()=>w.recoveryBarrier(),expression);assert.throws(()=>w.status(),/WRITER_RECOVERY_REQUIRED/);return w;}

test('authenticated hint cold recovery has history-independent index reads and preserves receipts',()=>{
 const measurements=[];
 for(const count of [8,96]){
  const f=fixture(),head=populate(f,count);assert(f.hint,'checkpoint must publish a hint');
  const start=f.calls.length,w=recover(f);
  assert.equal(w.status().headHash,head.headHash);assert.equal(w.get('x').value,count-1);
  const indexIds=new Set(objects(f,'checkpoint-index').map(o=>o.id));
  const readIds=f.calls.slice(start).filter(c=>c[0]==='read').map(c=>c[1]);
  measurements.push(readIds.filter(id=>indexIds.has(id)).length);
  assert.deepEqual(w.getReceipt('put_0'),f.writer.getReceipt('put_0'));
  assert.deepEqual(w.transact(put('put_0','x',0)),f.writer.getReceipt('put_0'));
  const old=w.getReceipt('put_0');assert.doesNotThrow(()=>w.recoveryBarrier({minimumAcknowledged:{revision:old.revision,hash:old.frameHash}}));
  assert.throws(()=>w.recoveryBarrier({minimumAcknowledged:{revision:head.revision+1,hash:head.headHash}}),/ACKNOWLEDGEMENT_UNPROVEN/);
 }
 assert(measurements[1]<=measurements[0]+1,JSON.stringify(measurements));
 assert(measurements[1]<=2,JSON.stringify(measurements));
});

test('stale or delayed regressed authenticated hint follows every newer committed checkpoint',()=>{
 const f=fixture();populate(f,3);const stale=f.hint;
 for(let i=3;i<14;i++){f.writer.transact(put('put_'+i,'x',i,i));f.writer.checkpoint(command('cp_'+i));}
 const expected=f.writer.status();f.hint=stale;
 const w=recover(f);assert.equal(w.status().headHash,expected.headHash);assert.equal(w.get('x').value,13);
 assert.equal(w.getReceipt('cp_13').revision,expected.revision);
});

test('absent, malformed, tampered, oversized and self-signed hints cannot select untrusted IDs',()=>{
 const f=fixture();const expected=populate(f,5),good=f.hint;
 const candidates=[null,encodeUtf8('{'),encodeUtf8('[]'),encodeUtf8('null'),new Uint8Array(16385),bytes({payload:{indexRef:{id:'attacker',hash:'a'.repeat(64)}},mac:'f'.repeat(64)})];
 const changed=Uint8Array.from(good);changed[Math.floor(changed.length/2)]^=1;candidates.push(changed);
 for(const h of candidates){f.hint=h;const at=f.calls.length,w=recover(f);assert.equal(w.status().headHash,expected.headHash);assert(!f.calls.slice(at).some(c=>c[0]==='read'&&c[1]==='attacker'));}
});

test('valid foreign-store, anchor, file, generation and script envelopes fall back to authority',()=>{
 const f=fixture();const expected=populate(f,5),codec=codecFor(KEY),payload=codec.decode(f.hint);assert(payload);
 for(const key of ['storeId','anchorId','anchorHash','hintFileId','writerScriptId','datasetGeneration','schemaVersion']){
  const p=structuredClone(payload);p[key]=key==='schemaVersion'?payload[key]+1:key==='anchorHash'?'f'.repeat(64):'foreign';p.indexRef={id:'attacker',hash:'f'.repeat(64)};
  f.hint=codec.encode(p);const at=f.calls.length,w=recover(f);assert.equal(w.status().headHash,expected.headHash);assert(!f.calls.slice(at).some(c=>c[0]==='read'&&c[1]==='attacker'),key);
 }
});

test('missing and corrupt authenticated checkpoint targets fail closed rather than reverting',()=>{
 for(const target of ['index','manifest','publication'])for(const mode of ['missing','corrupt']){
  const f=fixture();populate(f,3);const payload=codecFor(KEY).decode(f.hint),index=object(f,payload.indexRef.id);
  const id=target==='index'?payload.indexRef.id:target==='manifest'?index.payload.manifestRef.id:index.payload.publishingFrame.id;
  if(mode==='missing')f.files.delete(id);else f.files.get(id)[20]^=1;
  invalidates(f,/WRITER_(MISSING_REFERENCE|MISSING_PUBLICATION_FRAME|FILE_INVALID|HASH_MISMATCH|IDENTITY_INVALID)/);
 }
});

test('hinted current state shards retain lazy missing and corruption detection',()=>{
 for(const mode of ['missing','corrupt']){
  const f=fixture();const head=populate(f,3);if(mode==='missing')f.files.delete(head.stateRoot.id);else f.files.get(head.stateRoot.id)[20]^=1;
  const w=f.fresh();assert.throws(()=>{w.recoveryBarrier();w.get('x');},/WRITER_(MISSING_REFERENCE|FILE_INVALID|HASH_MISMATCH|IDENTITY_INVALID)/);
 }
});

test('hint signing key absence and rotation fall back without changing existing authorities',()=>{
 const f=fixture();const expected=populate(f,7),hint=f.hint,authorities=[...f.files].map(([id,b])=>[id,Buffer.from(b)]);
 const at=f.calls.length,w=recover(f,{checkpointHintCodec:undefined});assert.equal(w.status().headHash,expected.headHash);
 assert.equal(f.calls.slice(at).filter(c=>c[0]==='hint-write').length,0);
 f.hint=hint;const rotated=recover(f,{checkpointHintCodec:codecFor(KEY+'rotated')});assert.equal(rotated.status().headHash,expected.headHash);
 assert.deepEqual([...f.files].map(([id,b])=>[id,Buffer.from(b)]),authorities);
});

test('hint writes failing before or after commit never invalidate the authoritative checkpoint',()=>{
 for(const when of ['beforeHintWrite','afterHintWrite']){
  const f=fixture();f.writer.transact(put('first','x',1));f.faults[when]=()=>{throw Error('simulated hint timeout');};
  const receipt=f.writer.checkpoint(command('cp'));delete f.faults[when];
  const w=recover(f);assert.deepEqual(w.getReceipt('cp'),receipt);assert.equal(w.get('x').value,1);
 }
});

test('checkpoint index barrier remains compulsory and no hint blesses an unpublished checkpoint',()=>{
 const f=fixture();populate(f,2);const prior=f.hint;f.writer.transact(put('tail','x',2,2));const indexId=f.writer.status().nextIndexId;
 f.faults.create=(id,b,role)=>{if(role==='checkpoint-index')throw Error('denied index create');};
 assert.throws(()=>f.writer.checkpoint(command('blocked_cp')),/WRITER_CREATE_UNRESOLVED/);assert.deepEqual(f.hint,prior);
 const frames=objects(f,'frame').length;assert.throws(()=>f.fresh().transact(put('forbidden_successor','y',1)),/WRITER_CREATE_UNRESOLVED/);assert.equal(objects(f,'frame').length,frames);
 delete f.faults.create;const w=recover(f);assert(f.files.has(indexId));assert(w.getReceipt('blocked_cp'));assert.equal(w.getReceipt('forbidden_successor'),null);
});

test('hinted cold recovery permits checkpoint history beyond the per-call scan budget',()=>{
 const f=fixture({limits:{maxIndexLinks:5}});populate(f,5);const w=recover(f);
 const receipt=w.checkpoint(command('beyond_old_limit'));assert.equal(w._state.indexLinks,6);
 assert.deepEqual(recover(f).getReceipt('beyond_old_limit'),receipt);
});

test('GAS signed-byte HMAC matches independent SHA256 with domain separation and rejects malformed envelopes',()=>{
 const calls=[];const Utilities={Charset:{UTF_8:'utf-8'},computeHmacSha256Signature:(text,key,charset)=>{calls.push({text,key,charset});return [...createHmac('sha256',key).update(text).digest()].map(x=>x>127?x-256:x);}};
 const codec=createGasCheckpointHintCodec({Utilities,secret:KEY}),payload={protocol:'fixture',indexRef:{id:'valid',hash:'f'.repeat(64)}};
 assert.deepEqual(codec.decode(codec.encode(payload)),payload);
 assert(calls.every(x=>x.charset==='utf-8'&&x.key===KEY&&x.text.startsWith('MyPace/Drive/checkpoint-hint/HMAC-SHA256/v1\n')));
 const canonicalPayload=JSON.stringify(sorted(payload));const unseparated=bytes({payload,mac:createHmac('sha256',KEY).update(canonicalPayload).digest('hex')});assert.equal(codec.decode(unseparated),null);
 const envelope=JSON.parse(decodeUtf8(codec.encode(payload)));assert.equal(codec.decode(encodeUtf8(JSON.stringify(envelope,null,2))),null);
 assert.equal(codec.decode(bytes({...envelope,extra:1})),null);assert.equal(codec.decode(bytes({...envelope,mac:envelope.mac.toUpperCase()})),null);
 for(const secret of [undefined,'','short','x'.repeat(4097)])assert.throws(()=>createGasCheckpointHintCodec({Utilities,secret}),/AUTH_REQUIRED/);
 assert.throws(()=>createGasCheckpointHintCodec({Utilities:{Charset:Utilities.Charset},secret:KEY}),/AUTH_REQUIRED/);
});

function gasFixture(){
 const f=runtimeFixture();f.config.checkpointHintId='hint';f.config.checkpointHintCodec=codecFor(KEY);f.config.protocolReadCache={mode:'lock-phase'};
 const events=[];const oldFetch=f.globals.UrlFetchApp.fetch;
 f.globals.UrlFetchApp.fetch=(url,o)=>{const u=new URL(url);events.push([u.searchParams.get('alt')==='media'?'media':'metadata',decodeURIComponent(u.pathname.split('/').pop())]);return oldFetch(url,o);};
 f.globals.Drive.Files.update=(metadata,id,blob,options)=>{events.push(['update',id,structuredClone(metadata),structuredClone(options)]);const e=f.files.get(id);assert(e);e.bytes=Uint8Array.from(blob.bytes);e.meta.size=String(e.bytes.length);e.meta.version=String(Number(e.meta.version)+1);e.meta.md5Checksum=createHash('md5').update(e.bytes).digest('hex');return {id};};
 const runtime=createGasImportRuntime(f.globals,f.config);runtime.locked(()=>runtime.writer.bootstrap());return {f,events,runtime};
}

test('fixed GAS hint IO creates once and only updates its pinned ID without immutable caching',()=>{
 const {f,events,runtime:r}=gasFixture();r.locked(()=>{r.writer.transact(put('one','x',1));r.writer.checkpoint(command('cp_one'));r.writer.transact(put('two','x',2,1));r.writer.checkpoint(command('cp_two'));});
 assert.equal(f.calls.filter(c=>c[0]==='create'&&c[1]==='hint').length,1);
 assert.equal(events.filter(c=>c[0]==='update').length,1);assert(events.filter(c=>c[0]==='update').every(c=>c[1]==='hint'&&Object.keys(c[2]).length===0));
 const io=r.writer.io;r.locked(()=>{
  const before=events.length;io.readCheckpointHint('attacker');io.readCheckpointHint('attacker');assert.equal(events.slice(before).filter(c=>c[0]==='media'&&c[1]==='hint').length,2);
  assert(!events.slice(before).some(c=>c[1]==='attacker'));
  assert.throws(()=>io.readFile('hint'),/STORE_HINT_ROLE_REQUIRED/);assert.throws(()=>io.createFile('hint',encodeUtf8('{}'),'frame'),/STORE_HINT_ROLE_REQUIRED/);
  assert.throws(()=>io.createFile('other',encodeUtf8('{}'),'checkpoint-hint'),/STORE_HINT_ROLE_REQUIRED/);
 });
});

test('hint metadata privacy and parent gates run before media and before mutable updates',()=>{
 const mutations=[e=>{e.meta.shared=true;},e=>{e.meta.ownedByMe=false;},e=>{e.meta.trashed=true;},e=>{e.meta.parents=['elsewhere'];},e=>{e.meta.parents=['metadata','elsewhere'];},e=>{e.meta.appProperties['mypace.role']='frame';},e=>{e.meta.appProperties['mypace.store']='foreign';},e=>{e.meta.mimeType='text/plain';}];
 for(const mutate of mutations){
  const {f,events,runtime:r}=gasFixture();r.locked(()=>r.writer.checkpoint(command('cp')));mutate(f.files.get('hint'));const start=events.length;
  r.locked(()=>{assert.throws(()=>r.writer.io.readCheckpointHint(),/STORE_(METADATA_MISMATCH|HINT_ROLE_MISMATCH)/);assert.throws(()=>r.writer.io.writeCheckpointHint(encodeUtf8('{}')),/STORE_HINT_METADATA_MISMATCH/);});
  assert(!events.slice(start).some(c=>['media','update'].includes(c[0])&&c[1]==='hint'));
 }
 const {f,events,runtime:r}=gasFixture();r.locked(()=>r.writer.checkpoint(command('cp')));f.files.get('metadata').meta.shared=true;const start=events.length;
 r.locked(()=>{assert.throws(()=>r.writer.io.readCheckpointHint(),/STORE_PARENT_NOT_PRIVATE/);assert.throws(()=>r.writer.io.writeCheckpointHint(encodeUtf8('{}')),/STORE_PARENT_NOT_PRIVATE/);});
 assert(!events.slice(start).some(c=>['media','update'].includes(c[0])&&c[1]==='hint'));
});

test('invalid hint metadata is advisory, but valid hint cannot bypass committed-object privacy',()=>{
 for(const target of ['hint','index','manifest','publication']){
  const {f,events,runtime:r}=gasFixture();r.locked(()=>{r.writer.transact(put('one','x',1));r.writer.checkpoint(command('cp'));});
  const hint=codecFor(KEY).decode(f.files.get('hint').bytes),index=JSON.parse(decodeUtf8(f.files.get(hint.indexRef.id).bytes));
  const id=target==='hint'?'hint':target==='index'?hint.indexRef.id:target==='manifest'?index.payload.manifestRef.id:index.payload.publishingFrame.id;
  f.files.get(id).meta.shared=true;const cold=createGasImportRuntime(f.globals,f.config),before=events.length;
  if(target==='hint')cold.locked(()=>{cold.writer.recoveryBarrier();assert.equal(cold.writer.get('x').value,1);});
  else assert.throws(()=>cold.locked(()=>cold.writer.recoveryBarrier()),/STORE_METADATA_MISMATCH/);
  assert(!events.slice(before).some(c=>c[0]==='media'&&c[1]===id));
 }
});

test('anchored hint identity cannot be retrofitted onto an existing no-hint store',()=>{
 const f=fixture({checkpointHintId:undefined,checkpointHintCodec:undefined});f.writer.transact(put('one','x',1));const before=[...f.files].map(([id,b])=>[id,Buffer.from(b)]);
 const altered=f.fresh({checkpointHintId:'hint',checkpointHintCodec:codecFor(KEY)});
 assert.throws(()=>altered.recoveryBarrier(),/WRITER_BOOTSTRAP_MISMATCH/);assert.throws(()=>altered.bootstrap(),/WRITER_BOOTSTRAP_MISMATCH/);
 assert.deepEqual([...f.files].map(([id,b])=>[id,Buffer.from(b)]),before);
});

test('tampered ahead pointers and unkeyed self-signatures never become recovery authorities',()=>{
 const f=fixture();const expected=populate(f,6),codec=codecFor(KEY),valid=JSON.parse(decodeUtf8(f.hint));
 const fakeId='uncommitted_ahead',indexId=valid.payload.indexRef.id,cloned=object(f,indexId);
 cloned.payload.cut.revision+=100;const {hash,...body}=cloned;cloned.hash=writerDigest(body);f.files.set(fakeId,bytes(cloned));
 for(const mutate of [o=>{o.payload.indexRef={id:fakeId,hash:cloned.hash};},o=>{o.payload.indexRef={id:fakeId,hash:cloned.hash};o.mac=writerDigest(o.payload);},o=>{o.payload.indexRef.id=expected.nextIndexId;}]){
  const envelope=structuredClone(valid);mutate(envelope);f.hint=bytes(envelope);const at=f.calls.length,w=recover(f);assert.equal(w.status().headHash,expected.headHash);assert(!f.calls.slice(at).some(c=>c[0]==='read'&&c[1]===fakeId));
 }
 const payload=structuredClone(valid.payload);payload.indexRef={id:'signed_missing_ahead',hash:'a'.repeat(64)};f.hint=codec.encode(payload);invalidates(f,/WRITER_MISSING_REFERENCE/);
});

test('authenticated malformed shape, index count and unknown hint fields fall back safely',()=>{
 const f=fixture();const expected=populate(f,4),codec=codecFor(KEY),payload=codec.decode(f.hint);
 const mutations=[p=>{p.indexLinks=0;},p=>{p.indexLinks=-1;},p=>{p.indexLinks='4';},p=>{p.indexRef=null;},p=>{p.indexRef={id:'arbitrary',hash:'f'.repeat(64),extra:1};},p=>{p.extra=true;},p=>{delete p.indexLinks;}];
 for(const mutate of mutations){const p=structuredClone(payload);mutate(p);f.hint=codec.encode(p);const at=f.calls.length,w=recover(f);assert.equal(w.status().headHash,expected.headHash);assert(!f.calls.slice(at).some(c=>c[0]==='read'&&c[1]==='arbitrary'));}
 f.hint=codec.encode({...payload,indexLinks:4097});invalidates(f,/WRITER_CHECKPOINT_INDEX_INVALID/);
});

test('authenticated index cut, manifest and publication identities are checked against committed objects',()=>{
 const mutations=[o=>{o.payload.cut.hash='f'.repeat(64);},o=>{o.payload.cut.revision++;},o=>{o.payload.publishingFrame.hash='f'.repeat(64);},o=>{o.payload.publishingFrame.id='different_publication';},o=>{o.payload.manifestRef.hash='f'.repeat(64);},o=>{o.payload.nextIndexId='different_next';},o=>{o.payload.previousIndex={id:'different_previous',hash:'f'.repeat(64)};}];
 for(const mutate of mutations){
  const f=fixture();populate(f,3);const codec=codecFor(KEY),p=codec.decode(f.hint);reseal(f,p.indexRef.id,mutate);p.indexRef.hash=object(f,p.indexRef.id).hash;f.hint=codec.encode(p);
  invalidates(f,/WRITER_(CHECKPOINT|HASH_MISMATCH|MISSING_REFERENCE)/);
 }
});

test('authenticated hint does not hide corrupt, foreign or cyclic successor index links',()=>{
 for(const mutate of [o=>{o.payload.previousIndex={id:'foreign',hash:'f'.repeat(64)};},o=>{o.payload.cut.revision=0;},o=>{o.payload.nextIndexId=o.id;}]){
  const f=fixture();populate(f,2);const stale=f.hint,p=codecFor(KEY).decode(stale),next=object(f,p.indexRef.id).payload.nextIndexId;
  f.writer.transact(put('next','x',2,2));f.writer.checkpoint(command('next_cp'));
  reseal(f,next,o=>{mutate(Object.assign(o,{id:next}));delete o.id;});f.hint=stale;invalidates(f,/WRITER_(CHECKPOINT_INDEX_INVALID|INDEX_CYCLE)/);
 }
});

test('restored hint cold state does not suppress a later frame or re-use trust after failed recovery',()=>{
 const f=fixture();populate(f,3);const w=recover(f),before=w.status();
 f.writer.transact(put('late','x',3,3));assert.equal(w.recoveryBarrier().revision,before.revision+1);assert.equal(w.get('x').value,3);
 const next=w.status().nextSlotId;f.faults.read=id=>{if(id===next)throw Error('temporary read failure');};assert.throws(()=>w.recoveryBarrier(),/temporary read failure/);assert.throws(()=>w.get('x'),/WRITER_RECOVERY_REQUIRED/);
 delete f.faults.read;f.files.get('anchor')[0]^=1;assert.throws(()=>w.recoveryBarrier(),/WRITER_FILE_INVALID/);
});

test('authenticated publication validation shares the per-recovery frame budget',()=>{
 const f=fixture({limits:{checkpointEvery:2,maxReplayFrames:5}});
 f.writer.checkpoint(command('first_cp'));const stale=f.hint,firstIndex=object(f,codecFor(KEY).decode(stale).indexRef.id);
 for(let i=0;i<3;i++)f.writer.transact(command('empty_'+i));
 assert.equal(f.writer.status().revision,6);
 f.hint=stale;f.files.delete(firstIndex.payload.nextIndexId);
 invalidates(f,/WRITER_REPLAY_BUDGET/);
});

test('authenticated checkpoint recovery retains retired-epoch receipts before stale-version checks',()=>{
 const f=fixture(),first=put('old_operation','x',1),receipt=f.writer.transact(first);
 f.writer.advanceEpochs(command('retire_default'),['next']);f.writer.checkpoint({...command('new_epoch_cp'),epoch:'next'});
 const w=recover(f);assert.deepEqual(w.status().acceptedEpochs,['next']);assert.deepEqual(w.transact(first),receipt);
 assert.throws(()=>w.transact(put('new_old_epoch_operation','y',1)),/OP_EXPIRED/);
 assert.doesNotThrow(()=>w.recoveryBarrier({minimumAcknowledged:{revision:receipt.revision,hash:receipt.frameHash}}));
});
