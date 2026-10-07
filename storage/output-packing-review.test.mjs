import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {initialCheckpoint,prepareRange,buildStagedPayloads,checkpointPointLimit,LIMITS} from './bounded-import.mjs';
import {encodeUtf8,decodeUtf8} from './codec.mjs';
import {createImportReader} from './import-reader.mjs';
import {ImportStoreBinding,importKeys} from './import-store.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {runtimeFixture} from './runtime-fixture.mjs';
import {hashAssetBytes} from './immutable-assets.mjs';
const prefix='# sensor:multi_record\ntime,latitude,longitude\n';
const row='2026-01-01T00:00:00Z,1,2\n';
const source=b=>({id:'source',version:'1',size:String(b.length),md5Checksum:createHash('md5').update(b).digest('hex')});
const command=(operationId,changes)=>({operationId,digest:hashAssetBytes(encodeUtf8(operationId)),changes});

test('new packing reduces output files while preserving source identity and exact normalized stream',()=>{
 const b=encodeUtf8(prefix+row.repeat(5000)),old=prepareRange(initialCheckpoint(source(b),{packingVersion:0}),b),packed=prepareRange(initialCheckpoint(source(b)),b);
 assert.deepEqual(old.outputs.map(o=>o.pointCount),[1024,1024,1024,1024,904]);assert.deepEqual(packed.outputs.map(o=>o.pointCount),[4096,904]);
 assert.equal(old.outputs[0].digest,'0ac7946bbccdf72168a0787feded8025a6a5c09af4bd2d6d0729fa112bfd3701');
 assert.equal(old.checkpoint.packingVersion,undefined);assert.equal(packed.checkpoint.packingVersion,1);
 assert.equal(packed.checkpoint.sourceKey,old.checkpoint.sourceKey);assert.equal(packed.checkpoint.sourceSha256,old.checkpoint.sourceSha256);assert.equal(packed.checkpoint.normalizedSha256,old.checkpoint.normalizedSha256);
 assert.deepEqual(Buffer.concat(old.outputs.map(o=>Buffer.from(o.bytes))),Buffer.concat(packed.outputs.map(o=>Buffer.from(o.bytes))));
 for(const o of packed.outputs){assert(o.pointCount<=4096);assert(o.bytes.length<=262144);}
});

test('256 KiB byte bound still flushes packed output before its point ceiling',()=>{
 const line='2026-01-01T00:00:00.123456Z,35.123456789,139.123456789,12345.6789,123.456789\n',b=encodeUtf8('# sensor:multi_record\ntime,latitude,longitude,altitude,speed\n'+line.repeat(8000));
 const prepared=prepareRange(initialCheckpoint(source(b)),b);assert.equal(prepared.checkpoint.points,8000);
 assert(prepared.outputs[0].pointCount>1024);assert(prepared.outputs[0].pointCount<4096);assert(prepared.outputs.every(o=>o.bytes.length<=LIMITS.output));
 assert.equal(prepared.outputs.reduce((n,o)=>n+o.pointCount,0),8000);
});

test('legacy absent packing remains absent across resumes and malformed versions fail closed',()=>{
 const b=encodeUtf8(prefix+row.repeat(5000));let cp=initialCheckpoint(source(b),{packingVersion:0});
 const first=prepareRange(cp,b.slice(0,50000));cp=JSON.parse(JSON.stringify(first.checkpoint));assert.equal(checkpointPointLimit(cp),1024);
 const rest=prepareRange(cp,b.slice(cp.offset));assert.equal(rest.checkpoint.packingVersion,undefined);assert(rest.outputs.every(o=>o.pointCount<=1024));
 for(const value of [0,2,null,'1',-1,1.5]){const bad={...cp,packingVersion:value};assert.throws(()=>prepareRange(bad,b.slice(cp.offset)),/CHECKPOINT_PACKING/);}
});

function legacyRuntime(rangeBytes){
 const f=runtimeFixture(prefix+row.repeat(5000));f.config.rangeBytes=rangeBytes;const r=createGasImportRuntime(f.globals,f.config);
 r.locked(()=>{r.writer.bootstrap();r.store.registerJob({operationId:'register',jobId:'job',sourceIdentity:f.source});const entry=r.writer.get(importKeys.job('job')),legacy=structuredClone(entry.value);delete legacy.packingVersion;r.writer.transact(command('legacy_fixture',[{key:importKeys.job('job'),expectedVersion:entry.version,value:legacy}]));});
 return {f,r};
}
function pendingPayload(r,f){
 const resumed=r.locked(()=>r.store.resumeJob('job')),p=resumed.pending,cp=resumed.checkpoint;assert(p);assert.equal(cp.packingVersion,undefined);
 const prepared=prepareRange(cp,f.files.get('source').bytes.slice(cp.offset,p.transition.progress.offset));
 const expected=buildStagedPayloads(prepared,{outputIds:p.assets.filter(a=>a.role==='output').map(a=>a.fileId),manifestId:p.assets.find(a=>a.role==='manifest-page').fileId,checkpointId:p.assets.find(a=>a.role==='checkpoint').fileId});
 for(const asset of expected.assets){const reserved=p.assets.find(a=>a.fileId===asset.fileId);assert.equal(asset.sha256,reserved.sha256);assert.equal(asset.byteLength,reserved.byteLength);}
 return {p,expected};
}
for(const later of [false,true])test(`legacy ${later?'later-checkpoint':'initial'} pending reservation resumes identical bytes and IDs`,()=>{
 const {f,r}=legacyRuntime(later?30000:LIMITS.range);if(later){assert.equal(r.runner.stepJob('job').status,'checkpointed');const cp=r.locked(()=>r.store.resumeJob('job')).checkpoint;assert(cp.offset>0);assert.equal(cp.packingVersion,undefined);}
 const create=f.globals.Drive.Files.create;f.globals.Drive.Files.create=(m,b,o)=>{if(m.appProperties?.['mypace.role']==='output')throw Error('simulated termination before asset create');return create(m,b,o);};
 assert.throws(()=>r.runner.stepJob('job'));const {p,expected}=pendingPayload(r,f);if(!later)assert.equal(p.assets.filter(a=>a.role==='output').length,5);
 f.globals.Drive.Files.create=create;const cold=createGasImportRuntime(f.globals,{...f.config,rangeBytes:LIMITS.range});cold.runner.stepJob('job');
 for(const asset of expected.assets)assert.deepEqual(f.files.get(asset.fileId).bytes,asset.bytes);
 const resumed=cold.locked(()=>cold.store.resumeJob('job'));assert.equal(resumed.pending,null);assert.equal(resumed.checkpoint.packingVersion,undefined);assert.equal(resumed.checkpoint.offset,p.transition.progress.offset);
});

test('new jobs durably pin packing version and reject inconsistent checkpoint changes',()=>{
 const f=runtimeFixture(prefix+row.repeat(5000)),r=createGasImportRuntime(f.globals,f.config);r.locked(()=>{r.writer.bootstrap();r.store.registerJob({operationId:'register',jobId:'job',sourceIdentity:f.source});const job=r.writer.get(importKeys.job('job')).value,cp=r.store.resumeJob('job').checkpoint;assert.equal(job.packingVersion,1);assert.equal(cp.packingVersion,1);
  const bad=structuredClone(cp);delete bad.packingVersion;assert.throws(()=>r.store._checkpointShape(bad,job),/CHECKPOINT_PACKING_CHANGED/);
 });assert.equal(r.runner.stepJob('job').status,'parsed');const outputs=[...f.files.values()].filter(e=>e.meta.appProperties?.['mypace.role']==='output');assert.equal(outputs.length,2);
});

function routeFixture(groups){
 const values=new Map(),assets=new Map();let revision=12,reads=0;
 const writer={get:key=>values.has(key)?{value:structuredClone(values.get(key)),version:1}:null,status:()=>({revision}),recoveryBarrier:()=>{},transact:()=>{},getReceipt:()=>null};
 const store=new ImportStoreBinding({writer,storeId:'store',validateSourceCurrent:()=>true,readAsset:r=>{reads++;return assets.get(r.fileId);}}),runtime={writer,store,locked:fn=>fn()};
 const sign=s=>createHmac('sha256','synthetic-route-packing-review-key').update(s).digest('base64url');
 const sealCursor=c=>{const body=Buffer.from(JSON.stringify(c)).toString('base64url');return body+'.'+sign(body);};
 const openCursor=c=>{const [body,mac,...extra]=c.split('.');if(extra.length||mac!==sign(body))throw Error('forged');return JSON.parse(Buffer.from(body,'base64url').toString());};
 groups.forEach((outputs,n)=>{const pinId='pin'+n,descriptors=outputs.map((points,i)=>{const fileId='out'+n+'_'+i,bytes=encodeUtf8(points.map(p=>JSON.stringify(p)+'\n').join(''));assert(bytes.length<=262144);assets.set(fileId,bytes);return {fileId,role:'output',storeId:'store',jobId:'job',pinId,sha256:hashAssetBytes(bytes),byteLength:bytes.length};});values.set(importKeys.pin(pinId),{state:'ready',storeId:'store',jobId:'job',pinId,previousPin:n?'pin'+(n-1):null,nextPin:n+1<groups.length?'pin'+(n+1):null,assets:[...descriptors,{role:'checkpoint'},{role:'manifest-page'}]});});
 values.set(importKeys.job('job'),{status:'completed',pinActive:false,storeId:'store',jobId:'job',runId:'run',firstPin:'pin0',lastPin:'pin'+(groups.length-1),batchCount:groups.length});values.set(importKeys.run('run'),{imported:{jobId:'job',assetsRoot:'pin0'}});
 return {reader:createImportReader({runtime,sealCursor,openCursor}),sealCursor,openCursor,setRevision:n=>revision=n,get reads(){return reads;}};
}
const point=n=>({time:new Date(Date.UTC(2026,0,1)+n).toISOString(),lat:n%80,lon:n%170});
test('signed within-output cursors page mixed packed/legacy outputs and empty pins without gaps or duplicates',()=>{
 const all=Array.from({length:6077},(_,n)=>point(n));const f=routeFixture([[all.slice(0,3000),all.slice(3000,3300)],[],[all.slice(3300,5300),all.slice(5300)]]);let cursor=null,pages=0,seen=[];const offsets=[];
 do{const page=f.reader.readRoutePage({runId:'run',cursor});assert(page.points.length<=1024);assert(encodeUtf8(JSON.stringify(page)).length<=262144);seen.push(...page.points);cursor=page.nextCursor;if(cursor)offsets.push(f.openCursor(cursor).pointOffset);assert(++pages<15);}while(cursor);
 assert.deepEqual(seen,all);assert.equal(new Set(seen.map(p=>p.time)).size,all.length);assert(offsets.includes(1024));assert(offsets.includes(2048));assert(offsets.includes(0));
});

test('offset tampering, invalid positions and stale revision fail closed; legacy cursors remain readable',()=>{
 const f=routeFixture([[Array.from({length:2100},(_,n)=>point(n))]]),first=f.reader.readRoutePage({runId:'run'}),base=f.openCursor(first.nextCursor);
 assert.equal(base.pointOffset,1024);const before=f.reads;
 for(const pointOffset of [-1,0.5,null,'1024',4096])assert.throws(()=>f.reader.readRoutePage({runId:'run',cursor:f.sealCursor({...base,pointOffset})}),/IMPORT_CURSOR_INVALID/);
 assert.equal(f.reads,before);assert.throws(()=>f.reader.readRoutePage({runId:'run',cursor:first.nextCursor+'x'}),/IMPORT_CURSOR_INVALID/);
 assert.throws(()=>f.reader.readRoutePage({runId:'run',cursor:f.sealCursor({...base,pointOffset:2100})}),/IMPORT_CURSOR_INVALID/);
 const legacy={...base};delete legacy.pointOffset;assert.deepEqual(f.reader.readRoutePage({runId:'run',cursor:f.sealCursor(legacy)}).points,first.points);
 f.setRevision(13);assert.throws(()=>f.reader.readRoutePage({runId:'run',cursor:first.nextCursor}),/CURSOR_REVISION_CHANGED/);
});

test('route byte ceiling also bounds unusually large valid points and cursor envelope',()=>{
 const large={time:'2026-01-01T00:00:00.'+'0'.repeat(60000)+'Z',lat:1,lon:2},f=routeFixture([[[large,large,large,large]]]);
 const first=f.reader.readRoutePage({runId:'run'});assert.equal(first.points.length,3);assert(first.nextCursor);assert(encodeUtf8(JSON.stringify(first)).length<=262144);
 const last=f.reader.readRoutePage({runId:'run',cursor:first.nextCursor});assert.equal(last.points.length,1);assert.equal(last.nextCursor,null);assert(encodeUtf8(JSON.stringify(last)).length<=262144);
});

test('actual reservation-index shard failures preserve retry/recovery control flow instead of false authorization denial',()=>{
 const f=runtimeFixture(),r=createGasImportRuntime(f.globals,f.config);r.locked(()=>{r.writer.bootstrap();r.store.registerJob({operationId:'register',jobId:'job',sourceIdentity:f.source});});r.runner.stepJob('job');
 r.locked(()=>{
  r.writer.recoveryBarrier();const job=r.writer.get(importKeys.job('job')).value,pin=r.writer.get(importKeys.pin(job.firstPin)).value,asset=pin.assets.find(a=>a.role==='output'),read=r.writer.io.readFile.bind(r.writer.io);
  for(const label of ['OWNER_BUDGET_YIELD','STORE_YIELD','STORE_READ_UNRESOLVED','WRITER_RECOVERY_PENDING','WRITER_RECOVERY_REQUIRED','WRITER_RECOVERY_SETUP_REQUIRED','WRITER_LOCK_REQUIRED']){
   const fault=Error(label);if(label==='STORE_READ_UNRESOLVED')fault.retryable=true;if(label==='WRITER_RECOVERY_SETUP_REQUIRED')fault.requiresOwnerAction=true;let intercepted=0;
   r.writer.io.readFile=(id,max)=>{if(f.files.get(id)?.meta.appProperties?.['mypace.role']==='index-node'){intercepted++;throw fault;}return read(id,max);};
   for(const check of [()=>r.store.assertReservation(asset),()=>r.store.assertReadableAsset(asset.fileId,asset.byteLength,262144)]){r.writer._cache.clear();assert.throws(check,e=>e===fault,label);}
   assert.equal(intercepted,2,label);
  }
  r.writer.io.readFile=read;r.writer._cache.clear();assert.equal(r.store.assertReservation(asset),true);assert.equal(r.store.assertReadableAsset(asset.fileId,asset.byteLength,262144),true);
  assert.equal(r.store.assertReservation({...asset,jobId:'missing_job'}),false);assert.equal(r.store.assertReadableAsset('missing_asset',asset.byteLength,262144),false);
 });
});
