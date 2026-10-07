// Independent adversarial review; synthetic local stores and secrets only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {ReservedSlotWriter,writerDigest} from './reserved-writer.mjs';
import {createCheckpointHintCodec,INDEX_SCAN_HINT_PROTOCOL} from './checkpoint-hint.mjs';
import {encodeUtf8,decodeUtf8} from './codec.mjs';
import {runtimeFixture} from './runtime-fixture.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
const secret='index-review-synthetic-key-01234567890123456789';
const codec=createCheckpointHintCodec({hmacSha256:s=>createHmac('sha256',secret).update(s).digest('hex')});
const sorted=x=>Array.isArray(x)?x.map(sorted):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])])):x;
const bytes=x=>encodeUtf8(JSON.stringify(sorted(x)));
const cmd=(operationId,changes=[])=>({operationId,digest:writerDigest({operationId,changes}),changes});
function fixture(limit=3){
 const files=new Map(),events=[],hooks={};let serial=0,hint=null;const phase={};
 const io={getScriptId:()=> 'writer',assertLockHeld:()=>true,getVerifiedReadPhase:()=>phase,
  allocateIds:n=>Array.from({length:n},()=>`file_${++serial}`),
  readFile(id){events.push(['read',id]);hooks.read?.(id);return files.has(id)?Uint8Array.from(files.get(id)):null;},
  createFile(id,b,role){events.push(['create',id,role]);assert(!files.has(id));files.set(id,Uint8Array.from(b));return {id};},
  readCheckpointHint(){events.push(['hint-read']);hooks.hintRead?.();return hint&&Uint8Array.from(hint);},
  writeCheckpointHint(b){events.push(['hint-write',codec.decode(b)]);hooks.beforeWrite?.(b);hint=Uint8Array.from(b);hooks.afterWrite?.(b);return true;}
 };
 const config={io,anchorId:'anchor',storeId:'store',writerScriptId:'writer',checkpointHintId:'hint',checkpointHintCodec:codec,limits:{maxIndexLinks:limit,maxLeafEntries:16},clock:()=> '2026-10-06T17:00:00Z'};
 const fresh=extra=>new ReservedSlotWriter({...config,...extra}),writer=fresh();writer.bootstrap();
 return {files,events,hooks,writer,fresh,config,get hint(){return hint&&Uint8Array.from(hint);},set hint(b){hint=b&&Uint8Array.from(b);}};
}
const obj=(f,id)=>JSON.parse(decodeUtf8(f.files.get(id)));
const indexes=f=>[...f.files].filter(([,b])=>JSON.parse(decodeUtf8(b)).kind==='checkpoint-index').map(([id])=>id);
function populate(f,n){const receipt=f.writer.transact(cmd('original',[{key:'record',value:'preserved',expectedVersion:0}]));for(let i=0;i<n;i++)f.writer.checkpoint(cmd('cp_'+i));return receipt;}
function waitRecovery(w,options){try{w.recoveryBarrier(options);return null;}catch(e){return e;}}
function pending(w){const e=waitRecovery(w);assert.equal(e?.code,'WRITER_RECOVERY_PENDING');assert.equal(e.retryable,true);assert.throws(()=>w.status(),/RECOVERY_REQUIRED/);return e;}
function complete(f,options={}){for(let i=0;i<50;i++){const w=f.fresh(),e=waitRecovery(w,options);if(!e)return w;assert.equal(e.code,'WRITER_RECOVERY_PENDING');}assert.fail('no eventual completion');}
function reseal(f,id,mutate){const o=obj(f,id);mutate(o);const {hash,...body}=o;o.hash=writerDigest(body);f.files.set(id,bytes(o));}

test('foreign, malformed, ahead and self-signed scan cursors never select arbitrary recovery roots',()=>{
 const f=fixture(2);populate(f,12);f.hint=null;pending(f.fresh());const good=f.hint,base=codec.decode(good);
 const cases=[];
 for(const field of ['anchorId','anchorHash','hintFileId','storeId','writerScriptId','datasetGeneration','schemaVersion']){const p=structuredClone(base);p[field]=field==='schemaVersion'?99:field==='anchorHash'?'a'.repeat(64):'foreign';p.indexRef={id:'attacker',hash:'f'.repeat(64)};cases.push(codec.encode(p));}
 for(const mutate of [p=>{p.extra=true;},p=>{p.indexLinks=0;},p=>{p.indexLinks=-1;},p=>{p.indexLinks='2';},p=>{p.indexRef.extra=true;}]){const p=structuredClone(base);mutate(p);cases.push(codec.encode(p));}
 const raw=JSON.parse(decodeUtf8(good));raw.payload.indexRef={id:'attacker',hash:'f'.repeat(64)};raw.mac=writerDigest(raw.payload);cases.push(bytes(raw));
 cases.push(null,encodeUtf8('{'),new Uint8Array(4097));
 for(const b of cases){f.hint=b;const at=f.events.length;assert.equal(pending(f.fresh()).indexLinks,2);assert(!f.events.slice(at).some(e=>e[0]==='read'&&e[1]==='attacker'));}
 f.hint=codec.encode({...base,indexRef:{id:'signed_missing_ahead',hash:'a'.repeat(64)}});const w=f.fresh();assert.match(waitRecovery(w)?.code||'',/MISSING_REFERENCE/);assert.throws(()=>w.status(),/RECOVERY_REQUIRED/);
});

test('late scan-cursor writes may regress progress but cannot roll back ready records or receipts',()=>{
 const f=fixture(2),receipt=populate(f,10),expected=f.writer.status();f.hint=null;pending(f.fresh());const stale=f.hint;
 pending(f.fresh());assert.equal(codec.decode(f.hint).indexLinks,4);f.hint=stale;
 assert.equal(pending(f.fresh()).indexLinks,4);const w=complete(f);assert.equal(w.status().headHash,expected.headHash);assert.deepEqual(w.getReceipt('original'),receipt);
 f.writer.transact(cmd('late',[{key:'record',value:'newer',expectedVersion:1}]));f.writer.checkpoint(cmd('late_cp'));f.hint=stale;
 const after=complete(f);assert.equal(after.get('record').value,'newer');assert.deepEqual(after.getReceipt('original'),receipt);
});

test('a boundary INDEX hidden until after the probe is recovered through the mandatory live frame tail',()=>{
 const f=fixture(2);populate(f,6);const head=f.writer.status(),tailIndex=head.nextIndexId;
 f.writer.transact(cmd('late',[{key:'record',value:'late',expectedVersion:1}]));f.writer.checkpoint(cmd('late_cp'));const durable=f.files.get(tailIndex);assert(durable);
 f.hint=null;let hiddenOnce=false;const savedRead=f.config.io.readFile;
 f.config.io.readFile=id=>{if(id===tailIndex&&!hiddenOnce){hiddenOnce=true;f.events.push(['read',id]);return null;}return savedRead(id);};
 const w=complete(f);assert(hiddenOnce);assert.equal(w.get('record').value,'late');assert(w.getReceipt('late_cp'));assert.deepEqual(f.files.get(tailIndex),durable);
});

test('seed INDEX and invalid successor identities cannot be bypassed by signing cursor progress',()=>{
 for(const kind of ['missing-seed','corrupt-seed','foreign-successor','bad-order','cycle']){
  const f=fixture(2);populate(f,9);f.hint=null;pending(f.fresh());const p=codec.decode(f.hint),next=obj(f,p.indexRef.id).payload.nextIndexId;
  if(kind==='missing-seed')f.files.delete(p.indexRef.id);
  if(kind==='corrupt-seed')f.files.get(p.indexRef.id)[0]^=1;
  if(kind==='foreign-successor')reseal(f,next,o=>{o.storeId='foreign';});
  if(kind==='bad-order')reseal(f,next,o=>{o.payload.previousIndex={id:'foreign',hash:'f'.repeat(64)};});
  if(kind==='cycle')reseal(f,next,o=>{o.payload.nextIndexId=next;});
  const w=f.fresh(),e=waitRecovery(w);assert.match(e?.code||'',/WRITER_(MISSING_REFERENCE|FILE_INVALID|IDENTITY_INVALID|CHECKPOINT_INDEX_INVALID)/,kind);assert.throws(()=>w.status(),/RECOVERY_REQUIRED/);
 }
});

test('a recovered prefix never bypasses final current roots, publication or minimum acknowledgement',()=>{
 for(const kind of ['manifest','publication','state','receipt','wrong-proof']){
  const f=fixture(2),receipt=populate(f,9),head=f.writer.status();f.hint=null;
  while(codec.decode(f.hint)?.indexLinks!==8)pending(f.fresh());
  const target=kind==='manifest'?head.checkpoint.manifestRef.id:kind==='publication'?head.headId:kind==='state'?head.stateRoot.id:kind==='receipt'?head.receiptRoot.id:null;
  if(target)f.files.delete(target);
  const w=f.fresh();assert.throws(()=>{w.recoveryBarrier(kind==='wrong-proof'?{minimumAcknowledged:{revision:receipt.revision,hash:'f'.repeat(64)}}:{});if(kind==='state')w.get('record');if(kind==='receipt')w.getReceipt('original');},/WRITER_(MISSING_REFERENCE|MISSING_PUBLICATION_FRAME|ACKNOWLEDGEMENT_UNPROVEN)/,kind);
 }
});

test('all business APIs stay unavailable in reentrant IO before and after latest manifest restoration',()=>{
 const f=fixture(2);populate(f,6);f.hint=null;let w;
 const assertions=()=>{
  if(!w)return;assert.throws(()=>w.status(),/RECOVERY_REQUIRED/);assert.throws(()=>w.get('record'),/RECOVERY_REQUIRED/);assert.throws(()=>w.getReceipt('original'),/RECOVERY_REQUIRED/);
  for(const action of [()=>w.transact(cmd('reentrant')),()=>w.checkpoint(cmd('reentrant')),()=>w.advanceEpochs(cmd('reentrant'),['next'])])assert.throws(action,/RECOVERY_REENTRANT/);
 };
 f.hooks.read=assertions;f.hooks.beforeWrite=assertions;let result;
 for(let i=0;i<10;i++){w=f.fresh();const e=waitRecovery(w);if(!e){result=w;break;}assert.equal(e.code,'WRITER_RECOVERY_PENDING');}
 delete f.hooks.read;delete f.hooks.beforeWrite;assert(result);assert.equal(result.get('record').value,'preserved');assert.equal(result.getReceipt('reentrant'),null);
});

test('scan-slice boundaries accept an absent next link without manufacturing pending work',()=>{
 for(const count of [1,2,3,4,5,6]){
  const f=fixture(2);populate(f,count);f.hint=null;let pendingCalls=0,w;
  for(let i=0;i<10;i++){w=f.fresh();const e=waitRecovery(w);if(!e)break;assert.equal(e.code,'WRITER_RECOVERY_PENDING');assert.equal(e.scannedLinks,2);pendingCalls++;}
  assert.equal(pendingCalls,Math.floor((count-1)/2));assert.equal(w.status().indexLinks,count);
 }
});

test('bounded cold scans make durable progress with twelve real GAS service requests per invocation',()=>{
 const f=runtimeFixture();let ceiling=Infinity;const config={...f.config,checkpointHintId:'hint',checkpointHintCodec:codec,protocolReadCache:{mode:'lock-phase'},writerLimits:{maxIndexLinks:64,maxLeafEntries:16},checkBudget:()=>f.calls.length<ceiling};
 f.globals.Drive.Files.update=(meta,id,blob)=>{f.calls.push(['update',id]);const item=f.files.get(id);assert(item);item.bytes=Uint8Array.from(blob.bytes);item.meta.size=String(item.bytes.length);return {id};};
 const first=createGasImportRuntime(f.globals,config);first.locked(()=>{first.writer.bootstrap();first.writer.transact(cmd('original',[{key:'record',value:'preserved',expectedVersion:0}]));for(let i=0;i<20;i++)first.writer.checkpoint(cmd('cp_'+i));});
 f.files.delete('hint');let prior=0;
 for(let i=0;i<6;i++){
  const at=f.calls.length;ceiling=at+12;const r=createGasImportRuntime(f.globals,config);assert.throws(()=>r.locked(()=>r.writer.recoveryBarrier()),/STORE_YIELD/);
  const cursor=codec.decode(f.files.get('hint').bytes);assert.equal(cursor.protocol,INDEX_SCAN_HINT_PROTOCOL);assert(cursor.indexLinks>prior);prior=cursor.indexLinks;assert(f.calls.length-at<=12);
 }
 ceiling=Infinity;const final=createGasImportRuntime(f.globals,config);final.locked(()=>{final.writer.recoveryBarrier();assert.equal(final.writer.get('record').value,'preserved');assert.equal(final.writer.status().indexLinks,20);});
});

test('owner replacement pins bind exact anchor bytes and never recreate missing or changed anchors',()=>{
 const f=fixture(2);populate(f,7);const info=f.writer.readBootstrapInfo(),before=Uint8Array.from(f.files.get('anchor'));f.hint=null;
 const config={checkpointHintId:'replacement',checkpointHintAnchorHash:info.hash};let w;
 for(let i=0;i<10;i++){w=f.fresh(config);const e=waitRecovery(w);if(!e)break;assert.equal(e.code,'WRITER_RECOVERY_PENDING');}
 assert.equal(w.get('record').value,'preserved');assert.deepEqual(f.files.get('anchor'),before);assert.equal(codec.decode(f.hint).hintFileId,'replacement');
 const creates=f.events.filter(e=>e[0]==='create').length;f.files.delete('anchor');assert.throws(()=>f.fresh(config).bootstrap(),/MISSING_REFERENCE/);assert.equal(f.events.filter(e=>e[0]==='create').length,creates);
 f.files.set('anchor',before);reseal(f,'anchor',o=>{o.payload.datasetGeneration='different';});assert.throws(()=>f.fresh(config).recoveryBarrier(),/BOOTSTRAP_MISMATCH/);
});
