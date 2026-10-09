import {createHmac} from 'node:crypto';import {createGasCheckpointHintCodec} from './checkpoint-hint.mjs';import {createGasPreparationCodec} from './preparation-codec.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';
import {ownerBootstrapFixture} from './owner-bootstrap-fixture.mjs';
import * as owner from './owner-bootstrap.mjs';import * as runtime from './gas-import-runtime.mjs';import * as activation from './sync-v2-activation.mjs';import * as backup from './incremental-backup.mjs';import * as adapter from './gas-backup-adapter.mjs';import * as codec from './codec.mjs';import * as binding from './import-store.mjs';import * as reader from './import-reader.mjs';import {exportRecoveryAppJSON} from '../gas/backup-export.mjs';import {parseBackup} from '../src/lib/domain.js';import {writerDigest} from './reserved-writer.mjs';
function run(delay,recordCount,selected,tokenDelay=delay){
 const f=ownerBootstrapFixture(),c=f.bootstrap(),production=f.properties.get(owner.OWNER_STORE_PROPERTY);const g=f.globals;g.Utilities.Charset={UTF_8:'utf8'};g.Utilities.computeHmacSha256Signature=(s,key)=>Array.from(createHmac('sha256',key).update(s).digest());f.properties.set('MYPACE_WRITER_SECRET','test-secret-do-not-use-in-production-00000');
 g.LockService.getUserLock=()=>({tryLock:()=>true,releaseLock(){}});
 g.Drive.Files.get=id=>structuredClone(f.files.get(id==='root'?'mydrive':id)?.meta);
 g.Drive.Files.create=(m,b)=>{if(f.files.has(m.id))throw Error('409');f.files.set(m.id,{meta:{...structuredClone(m),ownedByMe:true,shared:false,trashed:false,...(b?{size:String(b.bytes.length)}:{})},...(b?{bytes:Uint8Array.from(b.bytes)}:{})});return{id:m.id};};
 g.Drive.Files.update=(m,id,b)=>{const e=f.files.get(id);e.bytes=Uint8Array.from(b.bytes);e.meta.size=String(e.bytes.length);return{id};};
 const originalFetch=g.UrlFetchApp.fetch;g.UrlFetchApp.fetch=(url,request)=>{if(url.includes('alt=media')&&!request.headers.Range){const id=decodeURIComponent(new URL(url).pathname.split('/').at(-1)),e=f.files.get(id);return f.response(e?200:404,e?e.bytes:'{}');}return originalFetch(url,request);};
 const r=runtime.createGasImportRuntime(g,{...c,checkBudget:()=>true});activation.activateSyncV2(r);r.locked(()=>{
 const point={time:'2026-01-01T00:00:00.000Z',lat:35,lon:139,speed:null};
 const make=(fileId,role,body)=>{const bytes=codec.encodeUtf8(body),sha256=new codec.IncrementalSha256().update(bytes).digestHex();f.files.set(fileId,{bytes,meta:{id:fileId,parents:[c.assetsParentId],mimeType:'application/octet-stream',ownedByMe:true,shared:false,trashed:false,size:String(bytes.length),appProperties:{'mypace.store':c.storeId,'mypace.job':'jobA','mypace.pin':'pinA','mypace.role':role,'mypace.sha256':sha256}}});return {fileId,role,storeId:c.storeId,jobId:'jobA',pinId:'pinA',byteLength:bytes.length,sha256};};
 const assets=[make('outA','output',JSON.stringify(point)+'\n'),make('cpA','checkpoint','{}'),make('mfA','manifest-page','{}')];
 const entries=Array.from({length:recordCount-6},(_,n)=>({key:'app/data/diary:'+n,value:{text:'keep'+n,mood:null}}));
 entries.push({key:'import/job/jobA',value:{jobId:'jobA',storeId:c.storeId,runId:'runA',status:'completed',pinActive:false,firstPin:'pinA',lastPin:'pinA',batchCount:1,queueNext:null,progress:{}}},{key:'import/pin/pinA',value:{pinId:'pinA',jobId:'jobA',storeId:c.storeId,state:'ready',previousPin:null,nextPin:null,assets}},{key:binding.importKeys.directory(),value:{head:'jobA',count:1}},{key:'run/runA',value:{imported:{jobId:'jobA',assetsRoot:'pinA',sampleCount:1,firstTime:point.time,lastTime:point.time,normalizedSha256:assets[0].sha256}}},{key:'import/owner-scheduler',value:{schema:1,status:'idle',retryAt:0,error:null}},{key:'app/data/deleted',value:{text:'deleted'}});
 for(let i=0;i<10;i++)entries.push({key:'app/change-slot/'+i,value:{seq:i}});
 r.writer.transact({operationId:'seed',epoch:'default',digest:writerDigest('seed'),changes:entries.map(e=>({...e,expectedVersion:0}))});
 r.writer.transact({operationId:'delete',epoch:'default',digest:writerDigest('delete'),changes:[{key:'app/data/deleted',expectedVersion:1,deleted:true}]});
 });
 const lib={createBackupSchedule:()=>({status:()=>({status:'disabled'})}),...owner,...runtime,...activation,...backup,...adapter,...codec,...binding,...reader};const context=vm.createContext({MyPaceFolderImport:lib,MyPaceSecureSync:{exportRecoveryAppJSON},MYPACE_IMPORT_OWNER:'owner@example.com',myPaceOwnerGlobals_:()=>g,myPaceOwnerRuntimeConfig_:(g,c)=>({...c,checkpointHintCodec:createGasCheckpointHintCodec({Utilities:g.Utilities,secret:f.properties.get('MYPACE_WRITER_SECRET')}),preparationCodec:createGasPreparationCodec({Utilities:g.Utilities,secret:f.properties.get('MYPACE_WRITER_SECRET')})}),myPaceOwnerReport_:r=>r,Date,Object,Error,JSON});vm.runInContext(fs.readFileSync(new URL('./backup-owner-entry.gs',import.meta.url),'utf8'),context);
 assert.equal(context.MyPaceBackupNow().status,'backup-complete');var a=adapter.createGasBackupAdapter(g,c);a.ensure();const firstId=a.getState().latestManifestId;assert.equal(context.MyPaceBackupNow().status,'backup-complete');a=adapter.createGasBackupAdapter(g,c);a.ensure();const latestId=a.getState().latestManifestId;assert.notEqual(firstId,latestId);f.properties.set('MYPACE_BACKUP_RESTORE_MANIFEST_ID',firstId);


 // Deliberately remove production metadata/assets: restoration must use only copies.
 for(const [id,e] of f.files)if(e.meta.parents?.includes(c.metadataParentId)||e.meta.parents?.includes(c.assetsParentId))f.files.delete(id);
 const archiveBefore=new Map([...f.files].map(([id,e])=>[id,e.bytes?Buffer.from(e.bytes).toString('hex'):null]));
 let clock=0,calls=0;const realNow=Date.now;Date.now=()=>clock;
 for(const [object,names] of [[g.Drive.Files,['get','create','update','generateIds']],[g.UrlFetchApp,['fetch']],[g.ScriptApp,['getOAuthToken']]])for(const n of names){const prior=object[n];object[n]=(...args)=>{clock+=n==='getOAuthToken'?tokenDelay:delay;calls++;return prior(...args);};}
 const results=[];let verificationStartCalls=null;
 try{
 for(let i=0;i<80;i++){
  const result=selected?context.MyPaceBackupRestoreSelected():context.MyPaceBackupRestoreTest();results.push(result);if(result.restoreProgress?.phase==='restored-needs-verification')verificationStartCalls=calls;
  assert.equal(f.properties.get(owner.OWNER_STORE_PROPERTY),production);
  if(result.status==='restore-verified')break;
  assert.ok(['backup-failed','backup-in-progress','restoring','pausing-imports','verifying','restored-needs-verification','restore-probe-written'].includes(result.status),JSON.stringify(result));
  if(result.status==='backup-failed')assert.equal(result.code,'STORE_YIELD');
 }
 const last=results.at(-1);assert.equal(last.status,'restore-verified',JSON.stringify(results));
 assert.equal(last.manifestId,selected?firstId:latestId);
 assert.equal(last.restoreProgress.verifiedRecords,recordCount); assert.equal(last.restoreProgress.verifiedRoutePages,1);
 assert.notEqual(last.testStoreId,c.storeId);
 const config=JSON.parse(f.properties.get(adapter.BACKUP_CONFIG_PROPERTY));
 for(const [id,body] of archiveBefore)if(id!==config.stateId)assert.equal(f.files.get(id)?.bytes?Buffer.from(f.files.get(id).bytes).toString('hex'):null,body);
 const saved=JSON.parse(codec.decodeUtf8(f.files.get(config.stateId).bytes));assert.equal(saved.latestManifestId,latestId);
 // Status is strictly read-only and exposes progress without entity contents.
 const before=JSON.stringify([...f.files]);const report=context.MyPaceBackupStatus();assert.deepEqual(JSON.parse(JSON.stringify(report.restoreProgress)),JSON.parse(JSON.stringify(last.restoreProgress)));assert.equal(JSON.stringify([...f.files]),before);
 return {results,elapsed:clock,calls,verificationCalls:verificationStartCalls===null?null:calls-verificationStartCalls};
 }finally{Date.now=realNow;}
}

test('34 mixed records and route: bounded real-adapter verification with ten-second OAuth acquisition',()=>{const r=run(1000,34,true,10000);assert.ok(r.calls<1200,JSON.stringify(r));assert.ok(r.verificationCalls!==null&&r.verificationCalls<400,JSON.stringify(r));assert.ok(r.results.every(x=>x.usage?.tokenRequests<=1));});
