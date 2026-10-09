import test from 'node:test';import assert from 'node:assert/strict';
import {ReservedSlotWriter,writerDigest} from './reserved-writer.mjs';
import {encodeUtf8} from './codec.mjs';import {hashAssetBytes} from './immutable-assets.mjs';
import {activateSyncV2} from './sync-v2-activation.mjs';
import {ImportStoreBinding,importKeys} from './import-store.mjs';import {createImportReader} from './import-reader.mjs';
import {createAppDomain} from '../gas/app-domain.mjs';
import {createBackupJob,backupSlice,createRestoreJob,restoreSlice,openBackupSnapshot,createBackupAssetReader,readBackupEntities,verifyRestoreSlice,createBackupDailyAssetReader} from './incremental-backup.mjs';
function fixture(name='live'){const files=new Map();let n=0;const io={getScriptId:()=> 'script',assertLockHeld:()=>true,allocateIds:k=>Array.from({length:k},()=>name+'_'+ ++n),readFile:id=>files.get(id)||null,createFile(id,b){if(files.has(id))throw Error('409');files.set(id,Uint8Array.from(b));}};const config={io,anchorId:name+'_anchor',storeId:name+'_store',writerScriptId:'script'},fresh=()=>new ReservedSlotWriter(config),writer=fresh();writer.bootstrap();activateSyncV2({writer,locked:f=>f()});return {files,writer,io,fresh};}
function put(w,key,value){const d=writerDigest({key,value}),old=w.get(key);return w.transact({operationId:'test_'+d.slice(0,48),epoch:'default',digest:d,changes:[{key,expectedVersion:old?.version||0,value}]});}
function archive(f,previous=null){const copies=new Map();let n=0,persisted=null,reads=0;const io={allocateId:()=> 'copy_'+ ++n,readSource:r=>{reads++;return f.files.get(r.id)||null;},readBackup:id=>copies.get(id)||null,createBackup(id,b){if(copies.has(id))throw Error('409');copies.set(id,Uint8Array.from(b));},saveJob:j=>{persisted=structuredClone(j);}};let job=createBackupJob(f.writer.captureReadView(),previous);return {io,copies,get job(){return job;},set job(j){job=j;},get persisted(){return persisted;},get reads(){return reads;},finish(){let r;for(let i=0;i<1000;i++){r=backupSlice(job,io,{maxFiles:2});if(r.manifest)return r.manifest;}throw Error('limit');}};}
function importFixture(f){const point={time:'2026-01-01T00:00:00.000Z',lat:35,lon:139,speed:null};const make=(fileId,role,b)=>{f.files.set(fileId,b);return {fileId,role,storeId:f.writer.storeId,jobId:'jobA',pinId:'pinA',byteLength:b.length,sha256:hashAssetBytes(b)};};const assets=[make('outA','output',encodeUtf8(JSON.stringify(point)+'\n')),make('cpA','checkpoint',encodeUtf8('{}')),make('mfA','manifest-page',encodeUtf8('{}'))];
 put(f.writer,importKeys.job('jobA'),{jobId:'jobA',storeId:f.writer.storeId,runId:'runA',status:'completed',pinActive:false,firstPin:'pinA',lastPin:'pinA',batchCount:1,queueNext:null,progress:{}});
 put(f.writer,importKeys.pin('pinA'),{pinId:'pinA',jobId:'jobA',storeId:f.writer.storeId,state:'ready',previousPin:null,nextPin:null,assets});put(f.writer,importKeys.directory(),{head:'jobA',count:1});put(f.writer,importKeys.run('runA'),{imported:{jobId:'jobA',assetsRoot:'pinA',sampleCount:1,firstTime:point.time,lastTime:point.time,normalizedSha256:assets[0].sha256}});return point;}
function restore(a,m,t){let job=createRestoreJob(m,{storeId:t.writer.storeId,anchorId:t.writer.anchorId}),saved;for(let i=0;i<1000;i++){const r=restoreSlice(job,{manifest:m,readBackup:a.io.readBackup,writer:t.writer,saveJob:j=>saved=j},{maxEntities:2});if(r.status==='restored-needs-verification')return saved;}throw Error('limit');}

import {createHmac} from 'node:crypto';
import {createDailyReader,createGasDailyReadHead,DAILY_HEAD_PROPERTY} from './daily-reader.mjs';
import {startDailyFile,appendDailyPoints,finishDailyFile,assembleDailyDate} from './daily-calculator.mjs';
function dailyFixture(f,{omitDayPin=false,monthly=false}={}){
 const generation=f.writer.captureReadView().datasetGeneration,storeId=f.writer.storeId;
 const points=[{time:'2026-10-08T17:59:30Z',lat:35,lon:139},{time:'2026-10-08T18:00:30Z',lat:35.001,lon:139}];
 const file=finishDailyFile(appendDailyPoints(startDailyFile({sourceKey:'crossing',version:'v1'}),points));
 const models={},days={},assets=[];
 function reserve(fileId,role,model){const bytes=encodeUtf8(JSON.stringify(model));f.files.set(fileId,bytes);const r={fileId,role,storeId,jobId:'dailyJob',pinId:'dailyPin',byteLength:bytes.length,sha256:hashAssetBytes(bytes)};assets.push(r);return r;}
 for(const date of ['2026-10-08','2026-10-09']){models[date]=assembleDailyDate({date,files:[file],storeId,generation});const asset=reserve('day_'+date.replaceAll('-',''),'output',models[date]);days[date]={asset,hash:asset.sha256,updatedAt:1};}
 const month=monthly?reserve('daily_month','manifest-page',{schema:1,storeId,generation,month:'2026-10',days}):null;const directory=reserve('daily_directory','manifest-page',{schema:1,storeId,generation,...(month?{months:{'2026-10':{asset:month,hash:month.sha256}}}:{days})});
 reserve('daily_provenance','checkpoint',{schema:1,sourceKey:'crossing',version:'v1'});
 const head={schema:1,storeId,generation,publication:1,sourceStoreId:storeId,sourceGeneration:generation,directory,coverage:true,pending:false,error:null,updatedAt:1};
 put(f.writer,'daily/pin/dailyPin',{schema:1,pinId:'dailyPin',state:'ready',storeId,generation,assets:omitDayPin?assets.filter(a=>a.role!=='output'):assets});
 put(f.writer,'import/drive-change-discovery',{schema:1,enabled:true,pending:true,coverage:true,channels:[{id:'original_channel',token:'fixture_nonsecret'}],watchPending:{id:'original_watch'},cursor:'oldcursor',queue:[],folders:[]});put(f.writer,'daily/head',head);put(f.writer,'daily/owner-scheduler',{schema:1,enabled:true,status:'publishing',pending:true});
 return {head,assets,models};
}
function signedHeads(storeId,generation='1'){
 const properties=new Map([['MYPACE_WRITER_SECRET','local-fixture-secret-only-0123456789abcdef']]);
 const globals={PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties.get(k)||null,setProperty:(k,v)=>properties.set(k,v)})},Utilities:{Charset:{UTF_8:'utf8'},computeHmacSha256Signature:(s,k)=>Array.from(createHmac('sha256',k).update(s).digest()),base64EncodeWebSafe:b=>Buffer.from(b).toString('base64url')}};
 return {properties,fresh:()=>createGasDailyReadHead(globals,{storeId,generation})};
}
const makeImportReader=(writer,storeId,readAsset)=>createImportReader({runtime:{writer,store:new ImportStoreBinding({writer,storeId,readAsset,validateSourceCurrent:()=>{throw Error('original unavailable');}}),locked:f=>f()},sealCursor:JSON.stringify,openCursor:JSON.parse});
function qualify(a,m,t,job,heads){for(let n=0;n<1000;n++){const result=verifyRestoreSlice(job,{manifest:m,readBackup:a.io.readBackup,writer:t.fresh(),saveJob:j=>{job=j;},makeImportReader,dailyHeadStore:heads.fresh()},{maxEntities:2});if(result.status==='restore-verified')return result;}throw Error('verification did not complete');}

test('daily snapshot directly copies all ready dependencies and fresh signed isolated read survives every original loss across 03:00 JST',()=>{
 const f=fixture(),point=importFixture(f),daily=dailyFixture(f);put(f.writer,'app/data/legacy',{distanceKm:7});const a=archive(f),m=a.finish(),savedCopies=new Map(a.copies);
 assert.equal(m.daily.schema,1);for(const r of daily.assets.filter(a=>a.role!=='checkpoint'))assert.ok(m.entries.some(e=>e.ref.id===r.fileId&&e.copyId!==r.fileId));
 f.files.clear();const t=fixture('restored'),job=restore(a,m,t),heads=signedHeads(t.writer.storeId);
 assert.equal(heads.fresh().read(),null);assert.equal(t.writer.get('daily/owner-scheduler').value.enabled,false);assert.equal(t.writer.get('daily/pin/dailyPin').deleted,false);assert.equal(t.writer.get('daily/pin/dailyPin').value.assets.length,3);
 const result=qualify(a,m,t,job,heads);assert.equal(result.status,'restore-verified');assert.equal(result.job.verification.dailyDays,2);assert.equal(result.job.verification.dailyAssets,3);assert.ok(!m.entries.some(e=>e.ref.id==='daily_provenance'));
 const h=heads.fresh().read();assert.equal(h.storeId,t.writer.storeId);assert.equal(h.sourceStoreId,m.view.storeId);assert.equal(h.archiveManifestHash,m.hash);
 const reader=createDailyReader({storeId:t.writer.storeId,generation:'1',readHead:heads.fresh().read,readAsset:createBackupDailyAssetReader(m,a.io.readBackup,h)});
 for(const date of Object.keys(daily.models)){const actual=reader.dailyRun({date,knownHash:null});assert.deepEqual(actual.summary,daily.models[date].summary);assert.deepEqual(actual.segments,daily.models[date].segments);assert.equal(actual.summary.durationSeconds,30);assert.equal(actual.store,t.writer.storeId);}
 assert.deepEqual(t.writer.get('app/data/legacy').value,{distanceKm:7});assert.equal(t.writer.get('import/owner-scheduler').value.processingMode,'paused');assert.equal(t.writer.get('import/drive-change-discovery').value.enabled,false);assert.deepEqual(t.writer.get('import/drive-change-discovery').value.channels,[]);assert.equal(t.writer.get('import/drive-change-discovery').value.watchPending,null);
 for(const [id,bytes]of savedCopies)assert.deepEqual(a.copies.get(id),bytes);
});

test('published daily reference without a ready pin stops snapshot publication',()=>{const f=fixture();dailyFixture(f,{omitDayPin:true});const a=archive(f);assert.throws(()=>a.finish(),/BACKUP_DAILY_PIN_MISSING/);assert.notEqual(a.job.status,'complete');});

test('each missing or corrupt published day/index copy blocks qualification with originals still present',()=>{
 for(const corrupted of [false,true])for(const assetId of ['day_20261008','day_20261009','daily_directory']){
  const f=fixture();dailyFixture(f);const a=archive(f),m=a.finish(),t=fixture('target'),job=restore(a,m,t),heads=signedHeads(t.writer.storeId),entry=m.entries.find(e=>e.ref.id===assetId);
  if(corrupted)a.copies.set(entry.copyId,Uint8Array.from([1,2,3]));else a.copies.delete(entry.copyId);
  assert.throws(()=>qualify(a,m,t,job,heads),/BACKUP_/);assert.throws(()=>qualify(a,m,t,job,heads),/BACKUP_/);assert.notEqual(job.status,'restore-verified');assert.equal(heads.fresh().read(),null);
 }
});

test('removed dependency mapping and daily capability marker cannot silently fall back to rebuilding',()=>{
 for(const damage of ['mapping','capability']){const f=fixture();dailyFixture(f);const a=archive(f),m=a.finish();if(damage==='mapping')m.entries=m.entries.filter(e=>e.ref.id!=='day_20261009');else delete m.daily;const {hash,...body}=m;m.hash=writerDigest(body);const t=fixture('target');assert.throws(()=>{const job=restore(a,m,t);qualify(a,m,t,job,signedHeads(t.writer.storeId));},/BACKUP_(MAP_MISSING|DAILY_MAP_MISSING|DAILY_CAPABILITY_MISSING)/);}
});

test('fresh qualification rejects detached signature corruption and wrong target head',()=>{
 const f=fixture();dailyFixture(f);const a=archive(f),m=a.finish(),t=fixture('target'),job=restore(a,m,t),heads=signedHeads(t.writer.storeId);
 for(let n=0;n<100&&job.status!=='restore-probe-written';n++)verifyRestoreSlice(job,{manifest:m,readBackup:a.io.readBackup,writer:t.writer,saveJob:()=>{},makeImportReader,dailyHeadStore:heads.fresh()},{maxEntities:4});
 const key=[...heads.properties.keys()].find(key=>key.startsWith(DAILY_HEAD_PROPERTY+'_')),raw=heads.properties.get(key);heads.properties.set(key,raw.replace('signature','damaged'));
 assert.throws(()=>qualify(a,m,t,job,heads),/DAILY_HEAD_SIGNATURE/);assert.notEqual(job.status,'restore-verified');heads.properties.set(key,raw);
 const other=signedHeads(f.writer.storeId);assert.throws(()=>qualify(a,m,t,job,other),/RESTORE_DAILY_HEAD_MISMATCH/);
});

test('older pre-daily immutable snapshots retain compatibility after a later daily snapshot',()=>{
 const f=fixture();put(f.writer,'app/data/legacy',{distanceKm:4});const a=archive(f),first=a.finish(),bytes=new Map(a.copies);dailyFixture(f);a.job=createBackupJob(f.writer.captureReadView(),first);const second=a.finish();assert.equal(first.daily,undefined);assert.equal(second.daily.schema,1);
 const t=fixture('legacy'),job=restore(a,first,t);for(let n=0;n<100&&job.status!=='restore-verified';n++)verifyRestoreSlice(job,{manifest:first,readBackup:a.io.readBackup,writer:t.fresh(),saveJob:()=>{},makeImportReader},{maxEntities:4});assert.equal(job.status,'restore-verified');assert.equal(t.writer.get('daily/head'),null);for(const [id,b]of bytes)assert.deepEqual(a.copies.get(id),b);
});

test('many tiny dependency descriptors fail the existing job capacity before any copy rather than truncate',()=>{
 const f=fixture(),a=archive(f);a.job.queue.push(...Array.from({length:16000},(_,n)=>({id:'tiny_'+n,hash:'a'.repeat(64),byteLength:2,kind:'asset',reservation:{fileId:'tiny_'+n,storeId:f.writer.storeId,jobId:'dailyJob',pinId:'dailyPin',role:'output',byteLength:2,sha256:'a'.repeat(64)}})));
 assert.throws(()=>backupSlice(a.job,a.io),/BACKUP_JOB_CAPACITY/);assert.equal(a.copies.size,0);assert.notEqual(a.job.status,'complete');
});

test('month index closure is copied, restored and verified with a durable one-item cursor',()=>{
 const f=fixture(),d=dailyFixture(f,{monthly:true}),a=archive(f),m=a.finish();assert.ok(m.entries.some(e=>e.ref.id==='daily_month'));assert.ok(!m.entries.some(e=>e.ref.id==='daily_provenance'));f.files.clear();const t=fixture('month_target');let job=restore(a,m,t);const heads=signedHeads(t.writer.storeId),progress=[];
 for(let n=0;n<200&&job.status!=='restore-verified';n++){verifyRestoreSlice(job,{manifest:m,readBackup:a.io.readBackup,writer:t.fresh(),saveJob:j=>{job=j;},makeImportReader,dailyHeadStore:heads.fresh()},{maxEntities:1});progress.push(job.verification?.daily?.pageIndex||0);}
 assert.equal(job.status,'restore-verified');assert.equal(job.verification.daily.pageIndex,2);assert.equal(job.verification.dailyAssets,4);assert.equal(job.verification.dailyDays,2);assert.ok(progress.includes(1));assert.ok(progress.includes(2));
 const entry=m.entries.find(e=>e.ref.id==='daily_month');a.copies.delete(entry.copyId);assert.throws(()=>createDailyReader({storeId:t.writer.storeId,generation:'1',readHead:heads.fresh().read,readAsset:createBackupDailyAssetReader(m,a.io.readBackup,heads.fresh().read())}).dailyRun({date:'2026-10-09',knownHash:null}),/BACKUP_/);
});
