// Independent packing/reader review. Synthetic files only; no production edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {encodeUtf8,decodeUtf8,IncrementalSha256} from './codec.mjs';
import {initialCheckpoint,prepareRange,buildStagedPayloads,LIMITS} from './bounded-import.mjs';
import {ImportStoreBinding,importKeys} from './import-store.mjs';
import {createImportReader} from './import-reader.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {runtimeFixture} from './runtime-fixture.mjs';
import {hashAssetBytes} from './immutable-assets.mjs';
const digest=hashAssetBytes;
const header='# sensor:multi_record\ntime,latitude,longitude\n';
const sample=n=>({time:new Date(Date.UTC(2026,0,1)+n).toISOString(),lat:n%89,lon:n%179});
const source=b=>({id:'source',version:'1',size:String(b.length),md5Checksum:createHash('md5').update(b).digest('hex')});
const cmd=(operationId,changes)=>({operationId,digest:digest(encodeUtf8(operationId)),changes});

for(const size of [1,1023,1024,1025,4095,4096,4097,8193])test(`independent packing boundary ${size} preserves normalized records and fixed maximums`,()=>{
 const points=Array.from({length:size},(_,n)=>sample(n)),bytes=encodeUtf8(header+points.map(p=>`${p.time},${p.lat},${p.lon}\n`).join(''));
 for(const version of [0,1]){const p=prepareRange(initialCheckpoint(source(bytes),{packingVersion:version}),bytes),decoded=p.outputs.flatMap(o=>decodeUtf8(o.bytes).trimEnd().split('\n').map(JSON.parse));assert.deepEqual(decoded,points);assert.equal(p.checkpoint.points,size);assert(p.outputs.every(o=>o.pointCount<=(version?4096:1024)&&o.bytes.length<=262144));assert.equal(digest(Uint8Array.from(Buffer.concat(p.outputs.map(o=>Buffer.from(o.bytes))))),p.checkpoint.normalizedSha256);}
});

test('packing-version absence survives irregular persisted parser resumes with identical normalized stream',()=>{
 const points=Array.from({length:9000},(_,n)=>sample(n)),b=encodeUtf8(header+points.map(p=>`${p.time},${p.lat},${p.lon}\r\n`).join(''));
 let expected=null;
 for(const version of [0,1]){let cp=initialCheckpoint(source(b),{packingVersion:version}),outputs=[],steps=0;while(!cp.complete){const n=[79,10111,37777,19003][steps++%4],p=prepareRange(cp,b.slice(cp.offset,Math.min(b.length,cp.offset+n)));outputs.push(...p.outputs);cp=JSON.parse(JSON.stringify(p.checkpoint));assert.equal(Object.hasOwn(cp,'packingVersion'),version===1);}const stream=Buffer.concat(outputs.map(o=>Buffer.from(o.bytes)));if(expected)assert.deepEqual(stream,expected);else expected=stream;assert.equal(cp.points,9000);assert.equal(cp.sourceSha256,digest(b));}
});

for(const value of [0,2,null,'1',false,-1,1.5])test(`persisted invalid job packing ${JSON.stringify(value)} fails before source read/reservation`,()=>{
 const f=runtimeFixture(header+'2026-01-01T00:00:00Z,1,2\n'.repeat(2000)),r=createGasImportRuntime(f.globals,f.config);
 r.locked(()=>{r.writer.bootstrap();r.store.registerJob({operationId:'register',jobId:'job',sourceIdentity:f.source});const e=r.writer.get(importKeys.job('job'));r.writer.transact(cmd('poison',[{key:importKeys.job('job'),expectedVersion:e.version,value:{...e.value,packingVersion:value}}]));});
 const before=f.calls.length;assert.throws(()=>r.runner.stepJob('job'),/CHECKPOINT_PACKING/);assert.equal(f.calls.slice(before).some(x=>x[0]==='create'||x[0]==='fetch'&&x[1]==='source'),false);
});

test('checkpoint/job packing mismatch rejects both legacy-to-new and new-to-legacy representation switches',()=>{
 const f=runtimeFixture(),r=createGasImportRuntime(f.globals,f.config);r.locked(()=>{r.writer.bootstrap();r.store.registerJob({operationId:'register',jobId:'job',sourceIdentity:f.source});const job=r.writer.get(importKeys.job('job')).value,cp=r.store.resumeJob('job').checkpoint,legacyJob=structuredClone(job),legacyCp=structuredClone(cp);delete legacyJob.packingVersion;delete legacyCp.packingVersion;
 assert.throws(()=>r.store._checkpointShape(cp,legacyJob),/CHECKPOINT_PACKING_CHANGED/);assert.throws(()=>r.store._checkpointShape(legacyCp,job),/CHECKPOINT_PACKING_CHANGED/);assert.doesNotThrow(()=>r.store._checkpointShape(legacyCp,legacyJob));});
});

function routeFixture(groups){
 const values=new Map(),assets=new Map(),readIds=[];let revision=7;
 const writer={get:key=>values.has(key)?{value:structuredClone(values.get(key)),version:1}:null,status:()=>({revision}),recoveryBarrier(){},transact(){},getReceipt(){}};
 const store=new ImportStoreBinding({writer,storeId:'store',readAsset:r=>{readIds.push(r.fileId);return assets.get(r.fileId);},validateSourceCurrent:()=>true});
 groups.forEach((outputs,n)=>{const pinId='pin'+n,descriptors=outputs.map((points,k)=>{const fileId='asset'+n+'_'+k,b=encodeUtf8(points.map(p=>JSON.stringify(p)+'\n').join(''));assert(b.length<=262144);assets.set(fileId,b);return {fileId,storeId:'store',jobId:'job',pinId,role:'output',sha256:digest(b),byteLength:b.length};});values.set(importKeys.pin(pinId),{pinId,storeId:'store',jobId:'job',state:'ready',previousPin:n?'pin'+(n-1):null,nextPin:n<groups.length-1?'pin'+(n+1):null,assets:[...descriptors,{role:'checkpoint'},{role:'manifest-page'}]});});
 values.set(importKeys.job('job'),{jobId:'job',storeId:'store',runId:'run',status:'completed',pinActive:false,firstPin:'pin0',lastPin:'pin'+(groups.length-1),batchCount:groups.length});values.set(importKeys.run('run'),{imported:{jobId:'job',assetsRoot:'pin0'}});
 const mac=x=>createHmac('sha256','independent-route-review-test-key').update(x).digest('hex');
 const seal=x=>{const body=Buffer.from(JSON.stringify(x)).toString('base64url');return body+'.'+mac(body);};
 const open=x=>{const [body,signature,...other]=x.split('.');if(other.length||signature!==mac(body))throw Error('tampered');return JSON.parse(Buffer.from(body,'base64url'));};
 return {reader:createImportReader({runtime:{writer,store,locked:fn=>fn()},sealCursor:seal,openCursor:open}),seal,open,readIds,setRevision:n=>revision=n};
}

test('independent signed route pagination covers 1024/4096 boundaries, multiple outputs and consecutive empty pins',()=>{
 const all=Array.from({length:10240},(_,n)=>sample(n)),groups=[[all.slice(0,4096),all.slice(4096,5120)],[],[],[all.slice(5120,9216),all.slice(9216)]],f=routeFixture(groups);let cursor=null,seen=[],pages=0;
 do{const p=f.reader.readRoutePage({runId:'run',cursor,revision:7});assert(p.points.length<=1024);assert(encodeUtf8(JSON.stringify(p)).length<=262144);seen.push(...p.points);cursor=p.nextCursor;assert(++pages<=15);}while(cursor);
 assert.deepEqual(seen,all);assert.equal(seen.length,new Set(seen.map(p=>p.time)).size);assert(f.readIds.every(id=>/^asset[03]_[01]$/.test(id)));
});

test('opaque cursor MAC, run/job/revision/offset checks reject malformed navigation before any asset fetch',()=>{
 const f=routeFixture([[Array.from({length:4096},(_,n)=>sample(n))]]),first=f.reader.readRoutePage({runId:'run'}),base=f.open(first.nextCursor),reads=f.readIds.length;
 for(const change of [{runId:'other'},{jobId:'other'},{kind:'imports'},{revision:8},{pinId:'private-source'},{pointOffset:4096},{pointOffset:-1},{pointOffset:NaN},{pointOffset:Infinity},{pointOffset:'1024'}])assert.throws(()=>f.reader.readRoutePage({runId:'run',cursor:f.seal({...base,...change})}),/CURSOR|PIN|NOT_FOUND/);
 const [body,signature]=first.nextCursor.split('.'),tampered=Buffer.from(JSON.stringify({...base,pointOffset:2048})).toString('base64url')+'.'+signature;assert.throws(()=>f.reader.readRoutePage({runId:'run',cursor:tampered}),/CURSOR/);assert.equal(f.readIds.length,reads);
 f.setRevision(8);assert.throws(()=>f.reader.readRoutePage({runId:'run',cursor:first.nextCursor}),/REVISION_CHANGED/);assert.equal(f.readIds.length,reads);
});

test('caller-selected file/asset IDs cannot select Drive reads',()=>{const f=routeFixture([[Array.from({length:1025},(_,n)=>sample(n))]]);const p=f.reader.readRoutePage({runId:'run',fileId:'private-source',assetId:'other-secret'});assert.equal(p.points.length,1024);assert.deepEqual(f.readIds,['asset0_0']);assert.throws(()=>f.reader.readRoutePage({runId:'run',cursor:'private-source'}),/CURSOR/);assert.deepEqual(f.readIds,['asset0_0']);});

// Independent finalization must reject the same packing-bound violations as
// reservation and route reads, even if existing immutable envelopes/hash links
// are internally consistent. These fixtures bypass normal reservation on purpose.
function oversizedFinalization(packingVersion,count){
 const b=encodeUtf8(header+'2026-01-01T00:00:00Z,1,2\n'.repeat(count)),src=source(b),p=prepareRange(initialCheckpoint(src,{packingVersion}),b),joined=Uint8Array.from(Buffer.concat(p.outputs.map(x=>Buffer.from(x.bytes))));
 assert(joined.length<=262144);const staged=buildStagedPayloads({outputs:[{index:0,pointCount:count,bytes:joined,digest:digest(joined)}],checkpoint:{...p.checkpoint,batch:1}},{outputIds:['out'],manifestId:'manifest',checkpointId:'checkpoint'}),lookup=new Map(staged.assets.map(a=>[a.fileId,a.bytes])),values=new Map(),cp=staged.checkpoint;
 const assets=staged.assets.map(({bytes,...a})=>({...a,storeId:'store',jobId:'job',pinId:'pin'})),role=x=>assets.find(a=>a.role===x);
 const writer={get:key=>values.has(key)?{value:values.get(key)}:null,recoveryBarrier(){},transact(){},getReceipt(){}};
 const store=new ImportStoreBinding({writer,storeId:'store',readAsset:r=>lookup.get(r.fileId),validateSourceCurrent:()=>true});
 const job={storeId:'store',jobId:'job',...(packingVersion?{packingVersion}:{}),sourceIdentity:src,sourceKey:cp.sourceKey,status:'verifying',pinActive:true,checkpoint:role('checkpoint'),manifest:role('manifest-page'),progress:Object.fromEntries(['offset','batch','points','normalizedBytes','rows','comments','nonIncreasingTimes','firstTime','lastTime','complete'].map(k=>[k,cp[k]])),batchCount:1,lastPin:'pin',finalization:{cursor:'pin',previousPin:null,previousManifest:null,visited:0,nextOutputIndex:0,points:0,bytes:0,throughOffset:0,firstTime:null,lastTime:null,nonIncreasingTimes:0,hash:new IncrementalSha256().snapshot()}};
 values.set(importKeys.pin('pin'),{pinId:'pin',jobId:'job',state:'ready',previousPin:null,nextPin:null,assets,transition:{checkpoint:role('checkpoint'),manifest:role('manifest-page')}});return {store,job};
}
for(const [version,count] of [[0,1025],[1,4097]])test(`independent finalization rejects oversized ${version?'packed':'legacy'} output (${count} points)`,()=>{const f=oversizedFinalization(version,count);assert.throws(()=>f.store._verifyOneFinalizationBatch(f.job),/MANIFEST_OUTPUTS_MISMATCH|OUTPUT_POINT_COUNT|OUTPUT_POINT_BOUND/);});
