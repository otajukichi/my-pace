import test from 'node:test';import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';
import {createGasDailyMaterializer} from './daily-gas-runtime.mjs';
import {DAILY_ALGORITHM} from './daily-calculator.mjs';
import {createDriveChangeHints} from './drive-change-hints.mjs';
import {runtimeFixture} from './runtime-fixture.mjs';import {createGasImportRuntime} from './gas-import-runtime.mjs';import {createOwnerScheduler,meteredGas,OWNER_LIMITS} from './owner-scheduler.mjs';import {createDriveChangeDiscovery,DRIVE_CHANGE_KEY,DRIVE_CHANGE_LIMITS,driveChangeTokenInput} from './drive-change-discovery.mjs';import {SOURCE_FOLDER_ID} from './transport.mjs';
function setup(){const f=runtimeFixture();let now=1000000,listCalls=0,changeCalls=0;const secret='fixture'.repeat(6);const props=new Map([['MYPACE_WRITER_SECRET',secret]]);f.globals.PropertiesService={getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty:(k,v)=>props.set(k,v)})};Object.assign(f.globals.Utilities,{getUuid:()=> 'channel',Charset:{UTF_8:'utf8'},computeHmacSha256Signature:(s,k)=>createHmac('sha256',k).update(s).digest(),base64EncodeWebSafe:bytes=>Buffer.from(bytes).toString('base64url')});
 f.files.set(SOURCE_FOLDER_ID,{meta:{id:SOURCE_FOLDER_ID,parents:[],trashed:false,mimeType:'application/vnd.google-apps.folder'}});const list=f.globals.Drive.Files.list;f.globals.Drive.Files.list=(...args)=>{listCalls++;return list(...args);};f.globals.Drive.Changes={getStartPageToken:()=>({startPageToken:'start'}),watch:r=>({id:r.id,resourceId:'resource',expiration:r.expiration}),list:()=>{changeCalls++;return {changes:[],newStartPageToken:'start'};}};
 const r=createGasImportRuntime(f.globals,{...f.config,sourceSubtree:true});r.locked(()=>r.writer.bootstrap());const channelToken=id=>createHmac('sha256',secret).update(driveChangeTokenInput(f.config.storeId,id)).digest('base64url'),hints=createDriveChangeHints({properties:f.globals.PropertiesService.getScriptProperties(),storeId:f.config.storeId,channelToken,now:()=>now});const d=createDriveChangeDiscovery({hints,runtime:r,Drive:f.globals.Drive,config:f.config,now:()=>now,channelToken,randomId:()=> 'channel'});d.activate({webhookUrl:'https://example.com/api/drive-changes'});
 return {...f,r,d,hints,channelToken,tick:()=>createOwnerScheduler(f.globals,f.config,{now:()=>now}).tick(),advance:ms=>now+=ms,get listCalls(){return listCalls;},get changeCalls(){return changeCalls;}};
}
test('activated delta discovery and importer share one bounded scheduler; no legacy rescans',()=>{const f=setup();let out;for(let i=0;i<12;i++){out=f.tick();assert.notEqual(out.status,'blocked',JSON.stringify(out));if(out.status==='complete')break;if(out.retryAt)f.advance(out.retryAt-1000000+1);}assert.equal(out.status,'complete',JSON.stringify(out));assert.equal(out.scanId,null);assert.equal(f.listCalls,1);assert.equal(f.changeCalls,1);const before=f.calls.length;const idle=f.tick();assert.equal(idle.status,'complete');assert.equal(f.listCalls,1);assert.equal(f.changeCalls,1);assert(f.calls.slice(before).every(c=>c[0]!=='create'));f.advance(DRIVE_CHANGE_LIMITS.intervalMs);f.tick();assert.equal(f.changeCalls,2);assert.equal(f.listCalls,1);});
test('Drive Changes requests obey the same external call budget',()=>{const f=setup(),m=meteredGas(f.globals,{limits:{...OWNER_LIMITS,calls:1}});m.globals.Drive.Changes.list('start',{});assert.equal(m.usage().calls,1);assert.throws(()=>m.globals.Drive.Changes.watch({},'start',{}),/OWNER_BUDGET_YIELD/);});
test('full scheduler quiesces when every writer/output write generates another Drive notification',()=>{
 const f=setup();let writes=0,message=0;const changes=[];const create=f.globals.Drive.Files.create;
 f.globals.Drive.Files.create=(meta,...args)=>{const result=create(meta,...args);writes++;changes.push({fileId:meta.id,file:{id:meta.id,name:meta.name||'state.bin',mimeType:meta.mimeType||'application/octet-stream',parents:meta.parents||[],trashed:false}});return result;};
 f.globals.Drive.Changes.list=(cursor,{pageSize})=>{const offset=cursor==='start'?0:Number(cursor.slice(1)),end=Math.min(changes.length,offset+pageSize);return {changes:changes.slice(offset,end),...(end<changes.length?{nextPageToken:'c'+end}:{newStartPageToken:'c'+end})};};
 let out;for(let n=0;n<12;n++){out=f.tick();assert.notEqual(out.status,'blocked',JSON.stringify(out));if(out.status==='complete')break;if(out.retryAt)f.advance(10000);}
 assert.equal(out.status,'complete');assert(writes>0);const settledWrites=writes;
 // Simulate notifications for every source-queue, cursor, checkpoint and output
 // write emitted by the composed real runtime, not just discovery's mock.
 f.d.hint({channelId:'channel',resourceId:'resource',resourceState:'change',messageNumber:String(++message),token:f.channelToken('channel')});
 for(let n=0;n<30&&f.hints.read().pending;n++){f.advance(5000);out=f.tick();assert.equal(out.status,'complete',JSON.stringify(out));assert.equal(writes,settledWrites,'self-change processing wrote Drive again');}
 assert.equal(f.hints.read().pending,false);assert.equal(writes,settledWrites);
 f.advance(DRIVE_CHANGE_LIMITS.intervalMs);f.tick();assert.equal(writes,settledWrites,'empty periodic reconciliation wrote Drive');
 const state=f.r.locked(()=>{f.r.store.recoveryBarrier();return f.r.writer.get(DRIVE_CHANGE_KEY).value;});assert.equal(state.pending,false);assert.equal(state.queue.length,0);
});

test('scheduler obeys property pause barrier even if Drive pause commit was interrupted',()=>{const f=setup();f.hints.registry(false,[]);const before=f.calls.length;const out=f.tick();assert.equal(out.status,'paused');assert.equal(out.error,'DRIVE_CHANGE_ACTIVATION_INCOMPLETE');assert(f.calls.slice(before).every(c=>c[0]!=='create'));});
test('settled combined scheduler wakes old daily algorithm before fallback or source changes',()=>{
 const f=setup();f.config.datasetGeneration='1';let out;
 for(let i=0;i<12;i++){out=f.tick();assert.notEqual(out.status,'blocked',JSON.stringify(out));if(out.status==='complete')break;}
 assert.equal(out.status,'complete');
 const daily=createGasDailyMaterializer(f.globals,{runtime:f.r,config:f.config});daily.activate();
 for(let i=0;i<12;i++){out=f.tick();assert.notEqual(out.status,'blocked',JSON.stringify(out));if(out.daily?.status==='complete')break;}
 assert.equal(out.daily?.status,'complete',JSON.stringify(out));
 const before=f.r.locked(()=>{f.r.store.recoveryBarrier();const state=f.r.writer.get('daily/owner-scheduler'),owner=f.r.writer.get('import/owner-scheduler'),sourceRevision=f.r.writer.get('daily/source-revision').version;assert.equal(owner.value.dailySourceRevision,sourceRevision);assert.equal(state.value.algorithm,DAILY_ALGORITHM);f.r.writer.transact({operationId:'seed_prior_daily_algorithm',epoch:'default',digest:'a'.repeat(64),changes:[{key:'daily/owner-scheduler',expectedVersion:state.version,value:{...state.value,algorithm:DAILY_ALGORITHM-1}}],result:{test:true}});return {sourceRevision,discoveryVersion:f.r.writer.get(DRIVE_CHANGE_KEY).version};});
 const changes=f.changeCalls;out=f.tick();
 const after=f.r.locked(()=>{f.r.store.recoveryBarrier();return {daily:f.r.writer.get('daily/owner-scheduler').value,sourceRevision:f.r.writer.get('daily/source-revision').version,discoveryVersion:f.r.writer.get(DRIVE_CHANGE_KEY).version};});
 assert.equal(after.daily.algorithm,DAILY_ALGORITHM,'idle gate skipped algorithm migration');assert.equal(after.sourceRevision,before.sourceRevision);assert.equal(after.discoveryVersion,before.discoveryVersion);assert.equal(f.changeCalls,changes,'fallback was not due and must not be needed for migration');assert.notEqual(out.status,'blocked',JSON.stringify(out));
});
