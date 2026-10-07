// Independent read-adapter boundary review. All fixtures are synthetic/local.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {createImportReader} from './import-reader.mjs';
import {ImportStoreBinding,importKeys} from './import-store.mjs';
import {encodeUtf8} from './codec.mjs';
import {hashAssetBytes} from './immutable-assets.mjs';
import {runtimeFixture} from './runtime-fixture.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {createOwnerScheduler} from './owner-scheduler.mjs';
import {LIMITS} from './bounded-import.mjs';

function authenticatedCursors(){
 const sign=s=>createHmac('sha256','local-reader-review-fixture-key').update(s).digest('base64url');
 return {
  sealCursor:value=>{const body=Buffer.from(JSON.stringify(value)).toString('base64url');return body+'.'+sign(body);},
  openCursor:encoded=>{const [body,signature,...extra]=encoded.split('.');if(extra.length||!body||!signature)throw Error('bad cursor');const expected=sign(body);if(signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw Error('bad cursor');return JSON.parse(Buffer.from(body,'base64url').toString('utf8'));}
 };
}
const sample=n=>({time:new Date(Date.UTC(2026,0,1,0,0,n)).toISOString(),lat:n,lon:n+1,speed:null});
function fixture(){
 const values=new Map(),assets=new Map();let rev=10,locked=false,reads=0,barriers=0;
 const writer={get:key=>{assert.equal(locked,true);return values.has(key)?{value:structuredClone(values.get(key)),version:1}:null;},status:()=>({revision:rev}),transact:()=>{throw Error('review fixture is read-only');},getReceipt:()=>null,recoveryBarrier:()=>{assert.equal(locked,true);barriers++;}};
 const store=new ImportStoreBinding({writer,storeId:'store',validateSourceCurrent:()=>true,readAsset:r=>{reads++;return assets.get(r.fileId);}});
 const runtime={writer,store,locked:fn=>{assert.equal(locked,false);locked=true;try{return fn();}finally{locked=false;}}};
 const auth=authenticatedCursors(),reader=createImportReader({runtime,...auth});
 const output=(fileId,pinId,points)=>{const bytes=encodeUtf8(points.map(p=>JSON.stringify(p)+'\n').join(''));assets.set(fileId,bytes);return {fileId,storeId:'store',jobId:'jobA',pinId,role:'output',sha256:hashAssetBytes(bytes),byteLength:bytes.length};};
 const makePin=(pinId,previousPin,nextPin,outputs)=>({pinId,jobId:'jobA',storeId:'store',state:'ready',previousPin,nextPin,assets:[...outputs,{role:'manifest-page'},{role:'checkpoint'}]});
 values.set(importKeys.job('jobA'),{jobId:'jobA',storeId:'store',runId:'runA',status:'completed',pinActive:false,firstPin:'pinA',lastPin:'pinB',batchCount:2,queueNext:null,progress:{}});
 values.set(importKeys.run('runA'),{imported:{jobId:'jobA',assetsRoot:'pinA',sampleCount:5,firstTime:sample(0).time,lastTime:sample(4).time,normalizedSha256:'a'.repeat(64)}});
 values.set(importKeys.pin('pinA'),makePin('pinA',null,'pinB',[output('outA','pinA',[sample(0),sample(1)]),output('outB','pinA',[sample(2),sample(3)])]));
 values.set(importKeys.pin('pinB'),makePin('pinB','pinA',null,[output('outC','pinB',[sample(4)])]));
 values.set(importKeys.directory(),{head:'jobA',count:1});
 return {reader,runtime,auth,values,assets,output,setRevision:n=>{rev=n;},get reads(){return reads;},get barriers(){return barriers;}};
}

test('authenticated route cursors traverse outputs and pin boundaries exactly once',()=>{
 const f=fixture(),points=[];let cursor=null,pages=0;
 do{const page=f.reader.readRoutePage({runId:'runA',cursor,revision:pages?10:null});assert.equal(page.revision,10);assert.deepEqual(Object.keys(page).sort(),['nextCursor','points','revision','runId']);assert.ok(page.points.length<=1024);points.push(...page.points);cursor=page.nextCursor;pages++;assert.ok(pages<=3);}while(cursor);
 assert.equal(pages,3);assert.equal(f.reads,3);assert.equal(f.barriers,3);assert.deepEqual(points,Array.from({length:5},(_,n)=>sample(n)));
});

test('forged, wrong-kind, wrong-run, wrong-job, malformed and stale cursors cannot fetch assets',()=>{
 const f=fixture(),page=f.reader.readRoutePage({runId:'runA'}),base=f.auth.openCursor(page.nextCursor),reads=f.reads;
 const bad=[page.nextCursor.slice(0,-1)+'!', 'source-file-id', '', 'x'.repeat(4097), f.auth.sealCursor({...base,kind:'imports'}), f.auth.sealCursor({...base,runId:'other'}), f.auth.sealCursor({...base,jobId:'other'}), f.auth.sealCursor({...base,pinId:'source/file'}), f.auth.sealCursor({...base,output:64}), f.auth.sealCursor({...base,output:0.5}), f.auth.sealCursor({...base,pinIndex:2}), f.auth.sealCursor({...base,previousPin:'other'})];
 for(const cursor of bad)assert.throws(()=>f.reader.readRoutePage({runId:'runA',cursor}),/IMPORT_CURSOR_INVALID|IMPORT_ROUTE_PIN_INVALID/);
 for(const revision of [9,'10',false,NaN,Infinity])assert.throws(()=>f.reader.readRoutePage({runId:'runA',revision}),/CURSOR_REVISION_CHANGED/);
 f.setRevision(11);assert.throws(()=>f.reader.readRoutePage({runId:'runA',cursor:page.nextCursor,revision:null}),/CURSOR_REVISION_CHANGED/);
 assert.equal(f.reads,reads);assert.throws(()=>f.reader.readRoutePage({runId:'source/file'}),/IMPORT_RUN_INVALID/);assert.throws(()=>f.reader.readRoutePage({runId:'source'}),/IMPORT_READ_NOT_FOUND/);
});

test('list cursors paginate 16 jobs and return only the current completed publication',()=>{
 const f=fixture(),job=f.values.get(importKeys.job('jobA'));job.queueNext='prior0';
 for(let n=0;n<17;n++)f.values.set(importKeys.job('prior'+n),{...job,jobId:'prior'+n,queueNext:n===16?null:'prior'+(n+1)});
 const first=f.reader.listImportedRuns({revision:null});assert.equal(first.runs.length,1);assert.ok(first.nextCursor);assert.deepEqual(Object.keys(first.runs[0]).sort(),['firstTime','id','kind','lastTime','normalizedSha256','routeAvailable','sampleCount','statistics']);
 const second=f.reader.listImportedRuns({cursor:first.nextCursor,revision:first.revision});assert.deepEqual(second.runs,[]);assert.equal(second.nextCursor,null);
 assert.throws(()=>f.reader.listImportedRuns({cursor:'asset-id'}),/IMPORT_CURSOR_INVALID/);
 f.setRevision(11);assert.throws(()=>f.reader.listImportedRuns({cursor:first.nextCursor}),/CURSOR_REVISION_CHANGED/);assert.equal(f.reads,0);
});

test('replacing a published generation invalidates old cursors and hides its metadata',()=>{
 const f=fixture(),old=f.reader.readRoutePage({runId:'runA'}),base=f.auth.openCursor(old.nextCursor),run=f.values.get(importKeys.run('runA')),prior=f.values.get(importKeys.job('jobA'));
 f.values.set(importKeys.job('jobB'),{...prior,jobId:'jobB',firstPin:'pinNew',lastPin:'pinNew',batchCount:1,queueNext:'jobA'});run.imported={...run.imported,jobId:'jobB',assetsRoot:'pinNew'};f.values.set(importKeys.directory(),{head:'jobB',count:2});f.setRevision(11);
 assert.throws(()=>f.reader.readRoutePage({runId:'runA',cursor:old.nextCursor}),/CURSOR_REVISION_CHANGED/);
 assert.throws(()=>f.reader.readRoutePage({runId:'runA',cursor:f.auth.sealCursor({...base,revision:11})}),/IMPORT_CURSOR_INVALID/);
 const list=f.reader.listImportedRuns();assert.equal(list.runs.length,1);assert.equal(list.runs[0].id,'runA');assert.equal(f.reads,1);
 run.imported.jobId='jobA';assert.throws(()=>f.reader.readRoutePage({runId:'runA'}),/IMPORT_RUN_NOT_PUBLISHED/);
});

test('corrupt bytes, malformed point shapes and output limits fail closed',()=>{
 const changed=fixture();changed.assets.get('outA')[0]^=1;assert.throws(()=>changed.reader.readRoutePage({runId:'runA'}),/ASSET_CONTENT_MISMATCH/);
 const invalid=[null,[],{}, {...sample(0),sourceId:'private'}, {...sample(0),lat:91}, {...sample(0),lon:-181}, {...sample(0),time:'2026-02-30T00:00:00Z'}, {...sample(0),speed:-1}, {...sample(0),altitude:100001}];
 for(const point of invalid){const f=fixture(),pin=f.values.get(importKeys.pin('pinA'));pin.assets[0]=f.output('outA','pinA',[point]);assert.throws(()=>f.reader.readRoutePage({runId:'runA'}),/IMPORT_ROUTE_INVALID/);}
 const count=fixture();count.values.get(importKeys.pin('pinA')).assets[0]=count.output('outA','pinA',Array.from({length:4097},()=>({time:'2026-01-01T00:00:00Z',lat:0,lon:0})));assert.throws(()=>count.reader.readRoutePage({runId:'runA'}),/IMPORT_ROUTE_BOUND/);
 const bytes=fixture();bytes.values.get(importKeys.pin('pinA')).assets[0].byteLength=262145;assert.throws(()=>bytes.reader.readRoutePage({runId:'runA'}),/IMPORT_ROUTE_PIN_INVALID/);assert.equal(bytes.reads,0);
 const truncated=fixture(),pin=truncated.values.get(importKeys.pin('pinA')),raw=encodeUtf8(JSON.stringify(sample(0)));truncated.assets.set('outA',raw);pin.assets[0]={...pin.assets[0],byteLength:raw.length,sha256:hashAssetBytes(raw)};assert.throws(()=>truncated.reader.readRoutePage({runId:'runA'}),/IMPORT_ROUTE_INVALID/);
});

test('pin-chain metadata cannot silently jump to a foreign root or loop',()=>{
 for(const change of [p=>{p.storeId='other';},p=>{p.jobId='other';},p=>{p.pinId='other';},p=>{p.previousPin='other';},p=>{p.nextPin='pinA';},p=>{p.nextPin=null;},p=>{p.state='reserved';},p=>{p.assets[0].jobId='other';}]){
  const f=fixture();change(f.values.get(importKeys.pin('pinA')));assert.throws(()=>f.reader.readRoutePage({runId:'runA'}),/IMPORT_ROUTE_PIN_INVALID/);assert.equal(f.reads,0);
 }
});

test('status is revision-bearing, recovery guarded, and whitelists nested progress',()=>{
 const f=fixture();assert.deepEqual(f.reader.status({revision:null}),{revision:10,status:'idle',retryAt:0,error:null,lastJob:null,processingMode:'idle',allowanceMs:null,requiresOwnerAction:false});
 const progress={offset:123,batch:2,points:4,normalizedBytes:456,rows:6,comments:1,nonIncreasingTimes:0,firstTime:sample(0).time,lastTime:sample(3).time,complete:false};
 f.values.set('import/owner-scheduler',{schema:1,status:'retry',retryAt:123456,error:'SOURCE_CHANGED',scanId:'hidden',cursor:'hidden',config:{secret:'hidden'},lastJob:{jobId:'hidden',status:'active',progress:{...progress,fileId:'hidden',sourceIdentity:{id:'hidden'}}}});
 assert.deepEqual(f.reader.status(),{revision:10,status:'retry',retryAt:123456,error:'SOURCE_CHANGED',lastJob:{status:'active',progress},processingMode:'check',allowanceMs:null,requiresOwnerAction:false});assert.equal(JSON.stringify(f.reader.status()).includes('hidden'),false);
 assert.throws(()=>f.reader.status({revision:9}),/CURSOR_REVISION_CHANGED/);
 f.values.get('import/owner-scheduler').error='https://private.example/secret';assert.throws(()=>f.reader.status(),/IMPORT_STATUS_INVALID/);
});

test('real runtime reads recheck current private asset metadata and content every call',()=>{
 const f=runtimeFixture(),runtime=createGasImportRuntime(f.globals,f.config);runtime.locked(()=>runtime.writer.bootstrap());let result=createOwnerScheduler(f.globals,f.config).start();
 for(let n=0;result.status!=='complete'&&n<15;n++)result=createOwnerScheduler(f.globals,f.config).resume();assert.equal(result.status,'complete');
 const reader=createImportReader({runtime,...authenticatedCursors()}),list=reader.listImportedRuns({revision:null}),runId=list.runs[0].id;
 assert.equal(reader.readRoutePage({runId,revision:null}).points.length,1);assert.equal(reader.status().status,'complete');
 const [id,asset]=[...f.files].find(([,v])=>v.meta.appProperties?.['mypace.role']==='output'),original=structuredClone(asset.meta);
 const mutations=[m=>{m.shared=true;},m=>{m.ownedByMe=false;},m=>{m.trashed=true;},m=>{m.parents=['other'];},m=>{m.parents.push('other');},m=>{m.appProperties['mypace.job']='other';},m=>{m.appProperties['mypace.sha256']='b'.repeat(64);},m=>{m.mimeType='text/plain';},m=>{m.size=String(Number(m.size)+1);}];
 for(const mutate of mutations){asset.meta=structuredClone(original);mutate(asset.meta);const start=f.calls.length;assert.throws(()=>reader.readRoutePage({runId}),/ASSET_METADATA_MISMATCH/);assert.equal(f.calls.slice(start).some(c=>c[0]==='fetch'&&c[1]===id),false);}
 asset.meta=structuredClone(original);asset.bytes[0]^=1;assert.throws(()=>reader.readRoutePage({runId}),/ASSET_CONTENT_MISMATCH/);
});

test('real imported route paginates across multiple outputs and source ranges without reading sources',()=>{
 const count=45000,csv='# sensor:multi_record\ntime,latitude,longitude\n'+Array.from({length:count},(_,n)=>new Date(Date.UTC(2026,0,1,0,0,n)).toISOString()+',1,2\n').join('');
 assert.ok(encodeUtf8(csv).length>LIMITS.range);
 const f=runtimeFixture(csv),runtime=createGasImportRuntime(f.globals,f.config);runtime.locked(()=>runtime.writer.bootstrap());let result=createOwnerScheduler(f.globals,f.config).start();
 for(let n=0;result.status!=='complete'&&n<15;n++)result=createOwnerScheduler(f.globals,f.config).resume();assert.equal(result.status,'complete');
 const reader=createImportReader({runtime,...authenticatedCursors()}),start=f.calls.length,list=reader.listImportedRuns(),runId=list.runs[0].id,seen=[];let cursor=null,pages=0;
 assert.equal(list.runs[0].sampleCount,count);
 do{const page=reader.readRoutePage({runId,cursor,revision:list.revision});assert.ok(page.points.length<=1024);assert.ok(encodeUtf8(page.points.map(p=>JSON.stringify(p)+'\n').join('')).length<=262144);seen.push(...page.points.map(p=>p.time));cursor=page.nextCursor;assert.ok(++pages<=100);}while(cursor);
 assert.equal(seen.length,count);assert.equal(new Set(seen).size,count);assert.equal(seen[0],new Date(Date.UTC(2026,0,1)).toISOString());assert.equal(seen.at(-1),new Date(Date.UTC(2026,0,1,0,0,count-1)).toISOString());
 assert.ok(pages>=44);assert.equal(f.calls.slice(start).some(c=>c[0]==='create'||c[0]==='fetch'&&c[1]==='source'),false);
});
