// Authenticated bounded full-anchor recovery. Synthetic local immutable IO only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {ReservedSlotWriter,writerDigest} from './reserved-writer.mjs';
import {createCheckpointHintCodec,INDEX_SCAN_HINT_PROTOCOL,CHECKPOINT_HINT_PROTOCOL,CHECKPOINT_HINT_MAX_BYTES} from './checkpoint-hint.mjs';
import {encodeUtf8,decodeUtf8} from './codec.mjs';
const key='local-index-recovery-test-only-secret-0123456789';
const codecFor=(secret=key)=>createCheckpointHintCodec({hmacSha256:text=>createHmac('sha256',secret).update(text).digest('hex')});
const command=(operationId,changes=[],epoch='default')=>({operationId,epoch,digest:writerDigest({operationId,changes,epoch}),changes});
const put=(id,key,value,expectedVersion=0)=>command(id,[{key,value,expectedVersion}]);
function fixture({budget=3,codec=codecFor(),warm=true,leaf=16}={}){
 const files=new Map(),calls=[],faults={};let serial=0,hint=null;const phase={};
 const io={
  getScriptId:()=> 'writer',assertLockHeld:()=>true,...(warm?{getVerifiedReadPhase:()=>phase}:{}),
  allocateIds:n=>Array.from({length:n},()=>`f_${++serial}`),
  readFile(id,max){calls.push(['read',id]);faults.read?.(id);const bytes=files.get(id);if(!bytes)return null;assert(bytes.length<=max);return Uint8Array.from(bytes);},
  createFile(id,bytes,role){calls.push(['create',id,role]);faults.create?.(id,bytes,role);assert(!files.has(id));files.set(id,Uint8Array.from(bytes));return {id};},
  readCheckpointHint(){calls.push(['hint-read']);faults.hintRead?.();return hint&&Uint8Array.from(hint);},
  writeCheckpointHint(bytes){calls.push(['hint-write']);faults.beforeHintWrite?.(bytes);hint=Uint8Array.from(bytes);faults.afterHintWrite?.(bytes);return true;}
 };
 const config={io,anchorId:'anchor',storeId:'store',writerScriptId:'writer',checkpointHintId:'hint',checkpointHintCodec:codec,limits:{maxIndexLinks:budget,maxLeafEntries:leaf},clock:()=> '2026-10-06T17:00:00.000Z'};
 const fresh=(extra={})=>new ReservedSlotWriter({...config,...extra}),writer=fresh();writer.bootstrap();
 return {files,calls,faults,config,codec,writer,fresh,get hint(){return hint&&Uint8Array.from(hint);},set hint(bytes){hint=bytes&&Uint8Array.from(bytes);}};
}
const object=(f,id)=>({id,...JSON.parse(decodeUtf8(f.files.get(id)))});
const objects=(f,kind)=>[...f.files.keys()].map(id=>object(f,id)).filter(o=>o.kind===kind);
const creates=f=>f.calls.filter(c=>c[0]==='create').length;
function populate(f,n){const original=f.writer.transact(put('original','record',{kept:true}));for(let i=0;i<n;i++)f.writer.checkpoint(command('cp_'+i));return original;}
function pending(w,options={}){let error;try{w.recoveryBarrier(options);}catch(e){error=e;}assert.equal(error?.code,'WRITER_RECOVERY_PENDING');assert.equal(error.retryable,true);assert.throws(()=>w.status(),/RECOVERY_REQUIRED/);assert.throws(()=>w.getReceipt('original'),/RECOVERY_REQUIRED/);assert.throws(()=>w.get('record'),/RECOVERY_REQUIRED/);return error;}
function finish(f,{codec=f.codec,minimumAcknowledged,maxCalls=10000}={}){
 const indexes=new Set(objects(f,'checkpoint-index').map(o=>o.id)),limit=f.config.limits.maxIndexLinks,measurements=[];let pendingCalls=0;
 for(let n=0;n<maxCalls;n++){
  const at=f.calls.length,writer=f.fresh({checkpointHintCodec:codec});
  try{writer.recoveryBarrier(minimumAcknowledged?{minimumAcknowledged}:{});measurements.push(f.calls.slice(at).filter(c=>c[0]==='read'&&indexes.has(c[1])).length);return {writer,pendingCalls,measurements};}
  catch(error){assert.equal(error.code,'WRITER_RECOVERY_PENDING');assert.equal(error.scannedLinks,limit);assert(error.cursorPersisted);assert.throws(()=>writer.status(),/RECOVERY_REQUIRED/);pendingCalls++;}
  const reads=f.calls.slice(at).filter(c=>c[0]==='read'&&indexes.has(c[1])).length;assert(reads<=limit+2,`bounded INDEX reads ${reads} <= ${limit+2}`);measurements.push(reads);
  assert(f.hint.length<=CHECKPOINT_HINT_MAX_BYTES);assert.equal(codec.decode(f.hint).protocol,INDEX_SCAN_HINT_PROTOCOL);
 }
 assert.fail('bounded recovery did not finish');
}

test('lost hint scans across calls without ready state, immutable writes or lost records/receipts',()=>{
 const f=fixture({budget:2}),original=populate(f,11),head=f.writer.status();f.hint=null;const before=creates(f);
 const first=f.fresh();const error=pending(first);assert.equal(error.indexLinks,2);assert.equal(error.scannedLinks,2);assert(error.cursorPersisted);
 const cursor=f.codec.decode(f.hint);assert.equal(cursor.protocol,INDEX_SCAN_HINT_PROTOCOL);assert.equal(cursor.indexLinks,2);
 const recovered=finish(f,{minimumAcknowledged:{revision:original.revision,hash:original.frameHash}});
 assert.equal(recovered.pendingCalls,4);assert.equal(recovered.writer.status().headHash,head.headHash);assert.deepEqual(recovered.writer.get('record').value,{kept:true});assert.deepEqual(recovered.writer.getReceipt('original'),original);assert.equal(creates(f),before);
 const finalHint=f.codec.decode(f.hint),finalState=recovered.writer.status();
 // A fully verified recovery may retain the already-persisted authenticated
 // INDEX prefix instead of spending another advisory write to relabel it.
 // Both protocols still require current manifest/publication/tail validation.
 assert([CHECKPOINT_HINT_PROTOCOL,INDEX_SCAN_HINT_PROTOCOL].includes(finalHint.protocol));assert.deepEqual(finalHint.indexRef,finalState.indexHead);assert.equal(finalHint.indexLinks,finalState.indexLinks);
 const cold=f.fresh();cold.recoveryBarrier({minimumAcknowledged:{revision:original.revision,hash:original.frameHash}});assert.equal(cold.status().headHash,head.headHash);assert.deepEqual(cold.get('record').value,{kept:true});assert.deepEqual(cold.getReceipt('original'),original);
 assert.deepEqual(recovered.writer.transact(put('original','record',{kept:true})),original);
});

test('old signed checkpoint hints and scan cursors never require retired intermediate bodies',()=>{
 const f=fixture({budget:2});populate(f,3);const old=f.hint;for(let i=3;i<14;i++)f.writer.checkpoint(command('cp_'+i));
 const current=f.writer.status();for(const o of objects(f,'checkpoint-manifest'))if(o.id!==current.checkpoint.manifestRef.id)f.files.delete(o.id);
 for(const o of objects(f,'frame'))if(o.payload.revision<=current.checkpoint.cut.revision)f.files.delete(o.id);
 f.hint=old;const start=f.calls.length,w=finish(f).writer;assert.equal(w.status().headHash,current.headHash);assert.equal(w.getReceipt('original').revision,1);
 const bodyReads=f.calls.slice(start).filter(c=>c[0]==='read'&&f.files.has(c[1])).map(c=>object(f,c[1])).filter(o=>['checkpoint-manifest','frame'].includes(o.kind));
 assert(bodyReads.every(o=>o.id===current.checkpoint.manifestRef.id||o.payload.revision>current.checkpoint.cut.revision));
});

test('regressed, tampered and lost scan cursors cost bounded work, never authority',()=>{
 const f=fixture({budget:2});const receipt=populate(f,12),head=f.writer.status();f.hint=null;pending(f.fresh());const earlier=f.hint;
 pending(f.fresh());assert.equal(f.codec.decode(f.hint).indexLinks,4);f.hint=earlier;pending(f.fresh());assert.equal(f.codec.decode(f.hint).indexLinks,4);
 const raw=JSON.parse(decodeUtf8(f.hint));raw.payload.indexRef={id:'attacker',hash:'a'.repeat(64)};f.hint=encodeUtf8(JSON.stringify(raw));const start=f.calls.length;pending(f.fresh());assert.equal(f.codec.decode(f.hint).indexLinks,2);assert(!f.calls.slice(start).some(c=>c[1]==='attacker'));
 f.hint=null;pending(f.fresh());const w=finish(f).writer;assert.equal(w.status().headHash,head.headHash);assert.deepEqual(w.getReceipt('original'),receipt);
});

test('authenticated referenced INDEX deletion or corruption fails closed for both hint protocols',()=>{
 for(const protocol of ['checkpoint','scan'])for(const mode of ['missing','corrupt']){
  const f=fixture();populate(f,8);if(protocol==='scan'){f.hint=null;pending(f.fresh());}
  const index=f.codec.decode(f.hint).indexRef.id;if(mode==='missing')f.files.delete(index);else f.files.get(index)[20]^=1;
  const w=f.fresh(),before=creates(f);assert.throws(()=>w.recoveryBarrier(),/WRITER_(MISSING_REFERENCE|FILE_INVALID|IDENTITY_INVALID|HASH_MISMATCH)/);assert.throws(()=>w.status(),/RECOVERY_REQUIRED/);assert.equal(creates(f),before);
 }
});

test('new signing key safely restarts prefix discovery; key loss explicitly requires setup',()=>{
 const f=fixture({budget:2});const receipt=populate(f,9),head=f.writer.status();f.hint=null;pending(f.fresh());const oldCursor=f.hint;
 const rotated=codecFor(key+'rotated');pending(f.fresh({checkpointHintCodec:rotated}));assert.equal(rotated.decode(f.hint).indexLinks,2);assert.equal(f.codec.decode(f.hint),null);
 const recovered=finish(f,{codec:rotated}).writer;assert.equal(recovered.status().headHash,head.headHash);assert.deepEqual(recovered.getReceipt('original'),receipt);
 f.hint=oldCursor;const unkeyed=f.fresh({checkpointHintCodec:undefined});assert.throws(()=>unkeyed.recoveryBarrier(),e=>e.code==='WRITER_RECOVERY_SETUP_REQUIRED'&&e.requiresOwnerAction&&/HMAC/.test(e.setup));assert.throws(()=>unkeyed.status(),/RECOVERY_REQUIRED/);
});

test('mid-scan service interruption retains verified progress and never exposes partial state',()=>{
 const f=fixture({budget:32});populate(f,37);f.hint=null;const indexes=objects(f,'checkpoint-index');let w=f.fresh();
 f.faults.read=id=>{assert.throws(()=>w.status(),/RECOVERY_REQUIRED/);if(id===indexes[18].id){const e=Error('STORE_YIELD');e.retryable=true;throw e;}};
 assert.throws(()=>w.recoveryBarrier(),/STORE_YIELD/);delete f.faults.read;assert.equal(f.codec.decode(f.hint).indexLinks,18);assert.equal(f.codec.decode(f.hint).protocol,INDEX_SCAN_HINT_PROTOCOL);assert.throws(()=>w.status(),/RECOVERY_REQUIRED/);
 assert.equal(finish(f).writer.getReceipt('cp_36').operationId,'cp_36');
});

test('failed or lost cursor updates remain bounded and safe to retry',()=>{
 for(const when of ['beforeHintWrite','afterHintWrite']){
  const f=fixture({budget:2});const receipt=populate(f,8);f.hint=null;f.faults[when]=()=>{throw Error('lost update');};
  const before=creates(f),error=pending(f.fresh());assert.equal(error.cursorPersisted,false);assert.equal(creates(f),before);delete f.faults[when];
  assert.deepEqual(finish(f).writer.getReceipt('original'),receipt);
 }
});

test('every public mutation stops before admission while discovery remains incomplete',()=>{
 const f=fixture({budget:1});populate(f,10);const before=creates(f);
 for(const invoke of [w=>w.transact(put('blocked','new',1)),w=>w.checkpoint(command('blocked')),w=>w.advanceEpochs(command('blocked'),['next'])]){
  f.hint=null;const w=f.fresh();assert.throws(()=>invoke(w),e=>e.code==='WRITER_RECOVERY_PENDING'&&e.retryable);assert.throws(()=>w.status(),/RECOVERY_REQUIRED/);assert.equal(creates(f),before);
 }
});

test('current manifest, publication, tail and acknowledgement remain mandatory after last scan slice',()=>{
 for(const bad of ['manifest','publication','tail','ack']){
  const f=fixture({budget:2});populate(f,7);const cp=f.writer.status();f.writer.transact(put('tail','record',{kept:2},1));f.hint=null;
  if(bad==='manifest')f.files.delete(cp.checkpoint.manifestRef.id);
  if(bad==='publication')f.files.delete(cp.headId);
  if(bad==='tail')f.files.get(f.writer.status().headId)[20]^=1;
  let terminal;
  for(let i=0;i<10;i++){const w=f.fresh();try{w.recoveryBarrier(bad==='ack'?{minimumAcknowledged:{revision:999,hash:'a'.repeat(64)}}:{});assert.fail('corrupt authority accepted');}catch(e){if(e.code==='WRITER_RECOVERY_PENDING')continue;terminal=e;assert.throws(()=>w.status(),/RECOVERY_REQUIRED/);break;}}
  assert.match(terminal?.message||'',/WRITER_(MISSING_REFERENCE|MISSING_PUBLICATION_FRAME|FILE_INVALID|IDENTITY_INVALID|HASH_MISMATCH|ACKNOWLEDGEMENT_UNPROVEN)/);
 }
});

test('delayed INDEX and tail publication after a completed scan are observed before writes',()=>{
 const f=fixture({budget:2});populate(f,7);const oldHint=f.hint,oldHead=f.writer.status(),oldIds=new Set(f.files.keys());
 const receipt=f.writer.transact(put('late','record',{kept:'late'},1));f.writer.checkpoint(command('late_cp'));const newer=[...f.files].filter(([id])=>!oldIds.has(id));for(const [id] of newer)f.files.delete(id);
 f.hint=null;const recovered=finish(f).writer;assert.equal(recovered.status().headHash,oldHead.headHash);
 for(const [id,b] of newer)f.files.set(id,b);f.hint=oldHint;recovered.recoveryBarrier();assert.deepEqual(recovered.getReceipt('late'),receipt);assert.equal(recovered.get('record').value.kept,'late');
});

test('real immutable history beyond 4096 checkpoints survives loss of all acceleration',()=>{
 const f=fixture({budget:64,leaf:16}),original=populate(f,4101),head=f.writer.status();assert.equal(f.writer._state.indexLinks,4101);
 const indexCount=objects(f,'checkpoint-index').length;assert.equal(indexCount,4101);f.hint=null;const before=creates(f);
 const recovered=finish(f,{minimumAcknowledged:{revision:original.revision,hash:original.frameHash}});assert.equal(recovered.pendingCalls,64);assert(recovered.measurements.every(n=>n<=66));assert.equal(creates(f),before);
 assert.equal(recovered.writer.status().headHash,head.headHash);assert.deepEqual(recovered.writer.getReceipt('original'),original);assert.deepEqual(recovered.writer.get('record').value,{kept:true});
 const next=recovered.writer.checkpoint(command('beyond_4101'));assert.equal(recovered.writer._state.indexLinks,4102);assert.equal(next.revision,head.revision+1);
});

test('explicit owner legacy/repair pin retains original immutable anchor bytes and identity',()=>{
 for(const legacy of [false,true]){
  const f=fixture({budget:2});populate(f,7);let anchor=object(f,'anchor');
  if(legacy){delete anchor.id;delete anchor.payload.checkpointHintId;const {hash,...body}=anchor;anchor.hash=writerDigest(body);const sort=x=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;f.files.set('anchor',encodeUtf8(JSON.stringify(sort(anchor))));}
  const anchorBytes=Uint8Array.from(f.files.get('anchor'));f.hint=null;
  const replacement={checkpointHintId:'replacement',checkpointHintAnchorHash:object(f,'anchor').hash};
  const attempts=[];
  for(let i=0;i<10;i++){const w=f.fresh(replacement);try{w.recoveryBarrier();assert.deepEqual(w.get('record').value,{kept:true});break;}catch(e){assert.equal(e.code,'WRITER_RECOVERY_PENDING');attempts.push(e);}}
  assert(attempts.length);assert.deepEqual(f.files.get('anchor'),anchorBytes);assert.equal(f.codec.decode(f.hint).hintFileId,'replacement');
  assert.throws(()=>f.fresh({checkpointHintId:'replacement'}).recoveryBarrier(),/BOOTSTRAP_MISMATCH/);
  assert.throws(()=>f.fresh({...replacement,checkpointHintAnchorHash:'f'.repeat(64)}).recoveryBarrier(),/BOOTSTRAP_MISMATCH/);
 }
});

test('owner repair pin never recreates a missing bound anchor and exposes only verified bootstrap info',()=>{
 const f=fixture(),info=f.writer.readBootstrapInfo();assert.deepEqual(info.payload,f.writer.readBootstrap());assert.equal(info.hash,object(f,'anchor').hash);
 const replacement={checkpointHintId:'replacement',checkpointHintAnchorHash:info.hash},w=f.fresh(replacement);assert.deepEqual(w.readBootstrapInfo(),info);
 f.files.delete('anchor');const before=creates(f);assert.throws(()=>w.bootstrap({firstSlotId:'slot',firstIndexId:'index'}),/WRITER_MISSING_REFERENCE/);assert.equal(creates(f),before);
 assert.throws(()=>f.fresh({checkpointHintAnchorHash:undefined,checkpointHintId:undefined,checkpointHintCodec:undefined}).readBootstrapInfo(),/WRITER_MISSING_REFERENCE/);
});

test('authenticated epoch fences keep the replay guard while crossing old lifetime limits',()=>{
 const f=fixture({budget:1});f.writer.limits.checkpointEvery=2;const receipts=[];
 for(let i=0;i<20;i++)receipts.push(f.writer.advanceEpochs(command('epoch_fence_'+i),['default']));
 assert(f.writer._state.indexLinks>1);assert(f.writer.status().replayFrames<=2);f.hint=null;
 const w=finish(f).writer;for(let i=0;i<20;i++)assert.deepEqual(w.getReceipt('epoch_fence_'+i),receipts[i]);
});

test('per-invocation discovery bounds hold through fixed-ID GAS IO after hint loss',async()=>{
 const {runtimeFixture}=await import('./runtime-fixture.mjs'),{createGasImportRuntime}=await import('./gas-import-runtime.mjs');
 const f=runtimeFixture(),codec=codecFor(),config={...f.config,checkpointHintId:'hint',checkpointHintCodec:codec,protocolReadCache:{mode:'lock-phase'},writerLimits:{maxIndexLinks:3,maxLeafEntries:16}};
 f.globals.Drive.Files.update=(metadata,id,blob)=>{f.calls.push(['update',id]);const item=f.files.get(id);assert(item);item.bytes=Uint8Array.from(blob.bytes);item.meta.size=String(item.bytes.length);return {id};};
 const first=createGasImportRuntime(f.globals,config);let receipt;
 first.locked(()=>{first.writer.bootstrap();receipt=first.writer.transact(put('original','record',{kept:true}));for(let i=0;i<20;i++)first.writer.checkpoint(command('gas_cp_'+i));});
 const before=new Map([...f.files].filter(([id])=>id!=='hint').map(([id,x])=>[id,x.bytes&&Uint8Array.from(x.bytes)]));f.files.delete('hint');let slices=0,recovered;
 for(let i=0;i<10;i++){
  const at=f.calls.length,r=createGasImportRuntime(f.globals,config);
  try{r.locked(()=>r.writer.recoveryBarrier());recovered=r;break;}
  catch(e){assert.equal(e.code,'WRITER_RECOVERY_PENDING');assert(e.cursorPersisted);slices++;const actual=f.calls.slice(at).filter(c=>['fetch','create','update','get'].includes(c[0]));assert(actual.length<=22,`bounded external requests: ${actual.length}`);assert(f.calls.slice(at).filter(c=>c[0]==='create').every(c=>c[1]==='hint'));}
 }
 assert.equal(slices,6);assert(recovered);recovered.locked(()=>{recovered.writer.recoveryBarrier();assert.deepEqual(recovered.writer.getReceipt('original'),receipt);assert.deepEqual(recovered.writer.get('record').value,{kept:true});});
 for(const [id,bytes] of before)assert.deepEqual(f.files.get(id).bytes,bytes);
});

test('default authenticated recovery slices stop at 64 links independently of lifetime ordinal',()=>{
 const f=fixture({budget:4096});populate(f,70);f.hint=null;const before=f.calls.length,error=pending(f.fresh());
 assert.equal(error.scannedLinks,64);assert.equal(error.indexLinks,64);assert.equal(f.codec.decode(f.hint).indexLinks,64);
 const indexes=new Set(objects(f,'checkpoint-index').map(o=>o.id));assert.equal(f.calls.slice(before).filter(c=>c[0]==='read'&&indexes.has(c[1])).length,65);
 const w=f.fresh();w.recoveryBarrier();assert.equal(w.status().indexLinks,70);assert.equal(w.getReceipt('cp_69').operationId,'cp_69');
});

test('short external budgets still durably advance before the periodic cursor interval',()=>{
 const f=fixture({budget:64});populate(f,20);f.hint=null;let prior=0;
 for(let invocation=0;invocation<5;invocation++){
  let calls=0;const budget=()=>{if(++calls>6){const e=Error('STORE_YIELD');e.retryable=true;throw e;}};
  f.faults.read=budget;f.faults.hintRead=budget;f.faults.beforeHintWrite=budget;
  const w=f.fresh();assert.throws(()=>w.recoveryBarrier(),/STORE_YIELD/);assert.throws(()=>w.status(),/RECOVERY_REQUIRED/);
  const saved=f.codec.decode(f.hint);assert.equal(saved.protocol,INDEX_SCAN_HINT_PROTOCOL);assert(saved.indexLinks>prior);prior=saved.indexLinks;
  delete f.faults.read;delete f.faults.hintRead;delete f.faults.beforeHintWrite;
 }
 assert.equal(finish(f).writer.getReceipt('cp_19').operationId,'cp_19');
});
