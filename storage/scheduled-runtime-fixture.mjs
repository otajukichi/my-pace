// Local synthetic fixture only. Never included in the production bundle.
import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
import {createGasCheckpointHintCodec} from './checkpoint-hint.mjs';
import {createGasDiscoveryStateCodec} from './discovery-state.mjs';
import {createScheduledImportRuntime,SCHEDULED_OWNER_EMAIL} from './scheduled-runtime.mjs';
import {runtimeFixture} from './runtime-fixture.mjs';import {createGasImportRuntime} from './gas-import-runtime.mjs';import {OWNER_STORE_PROPERTY,OWNER_BOOTSTRAP_PROTOCOL} from './owner-bootstrap.mjs';
export const clockEvent=()=>({authMode:'FULL',triggerUid:'4034124084959907503',year:2026,month:10,'day-of-month':6,'day-of-week':2,hour:12,minute:0,second:0,timezone:'Asia/Tokyo'});
export const csv=rows=>'# sensor:multi_record\ntime,latitude,longitude\n'+'2026-01-01T00:00:00Z,1,2\n'.repeat(rows);
export const SCHEDULED_MODEL_CADENCE_MS=15*60*1000;
export function fixture({rows=1,latency=0,csvText,checkpointHints=false,discoveryState=false,cache=false}={}){
 const f=runtimeFixture(csvText??csv(rows));
 const secret='synthetic-local-fixture-hmac-key-32bytes';
 if(checkpointHints||discoveryState){
  if(checkpointHints)f.config.checkpointHintId='hint';
  if(discoveryState)f.config.discoveryStateId='discovery';f.globals.Utilities.Charset={UTF_8:'UTF-8'};
  f.globals.Utilities.computeHmacSha256Signature=(text,key)=>Array.from(createHmac('sha256',key).update(text).digest());
  if(checkpointHints)f.config.checkpointHintCodec=createGasCheckpointHintCodec({Utilities:f.globals.Utilities,secret});
  if(discoveryState)f.config.discoveryStateCodec=createGasDiscoveryStateCodec({Utilities:f.globals.Utilities,secret});
 }
 f.globals.Drive.Files.update=(metadata,id,blob)=>{
  assert(['hint','discovery'].includes(id));assert.equal(f.lock.hasLock(),true);const file=f.files.get(id);assert(file);assert.equal(file.meta.appProperties['mypace.role'],id==='hint'?'checkpoint-hint':'source-discovery');assert(blob.bytes.length<=(id==='hint'?4096:8192));
  f.calls.push(['update',id]);file.bytes=Uint8Array.from(blob.bytes);file.meta={...file.meta,size:String(blob.bytes.length),version:String(Number(file.meta.version||0)+1),md5Checksum:createHash('md5').update(blob.bytes).digest('hex')};return {id};
 };
 const setup=createGasImportRuntime(f.globals,f.config);setup.locked(()=>setup.writer.bootstrap({datasetGeneration:'1',acceptedEpochs:['default'],firstSlotId:'slot_1',firstIndexId:'index_1'}));
 const state={now:0,effective:SCHEDULED_OWNER_EMAIL,active:'',script:'writer',reads:0,writes:0,serviceCalls:0};
 const config={protocol:OWNER_BOOTSTRAP_PROTOCOL,ownerEmail:SCHEDULED_OWNER_EMAIL,writerScriptId:'writer',myDriveRootId:'mydrive',storeId:'store',rootParentId:'store',metadataParentId:'metadata',assetsParentId:'assets',anchorId:'anchor',firstSlotId:'slot_1',firstIndexId:'index_1',datasetGeneration:'1',acceptedEpochs:['default'],...(checkpointHints?{checkpointHintId:'hint'}:{}),...(discoveryState?{discoveryStateId:'discovery'}:{})};
 const properties=new Map([[OWNER_STORE_PROPERTY,JSON.stringify(config)]]);if(checkpointHints||discoveryState)properties.set('MYPACE_WRITER_SECRET',secret);
 f.globals.Session={getActiveUser:()=>({getEmail:()=>state.active}),getEffectiveUser:()=>({getEmail:()=>state.effective})};
 f.globals.PropertiesService={getScriptProperties:()=>({getProperty:k=>{state.reads++;return properties.get(k)??null;},setProperty:()=>{state.writes++;throw Error('Progress properties forbidden');}})};
 f.globals.Utilities.sleep=()=>{};f.globals.ScriptApp.AuthMode={FULL:'FULL'};f.globals.ScriptApp.getScriptId=()=>state.script;
 const cost=fn=>(...args)=>{state.now+=latency;state.serviceCalls++;return fn(...args);};for(const k of ['get','list','create','generateIds','update'])f.globals.Drive.Files[k]=cost(f.globals.Drive.Files[k]);f.globals.UrlFetchApp.fetch=cost(f.globals.UrlFetchApp.fetch);
 const cacheEntries=new Map(),cacheCalls=[];
 if(cache)f.globals.CacheService={getScriptCache:()=>({get:key=>{cacheCalls.push(['get',key]);const v=cacheEntries.get(key);return v&&v.expires>state.now?v.text:null;},put:(key,text,ttl)=>{cacheCalls.push(['put',key]);cacheEntries.set(key,{text,expires:state.now+ttl*1000});},remove:key=>{cacheCalls.push(['remove',key]);cacheEntries.delete(key);}})};
 const tick=(options={},event=clockEvent())=>createScheduledImportRuntime(f.globals,{now:()=>state.now,...options}).tick(event);
 const advance=out=>{state.now=Math.max(state.now+SCHEDULED_MODEL_CADENCE_MS,out.retryAt||0);};
 const inspect=()=>{const r=createGasImportRuntime(f.globals,f.config);return r.locked(()=>{r.store.recoveryBarrier();const jobs=r.store.listJobsPage().jobs;return jobs.map(j=>r.store.getJob(j.jobId));});};
 return {...f,state,properties,cacheEntries,cacheCalls,config:{...config,checkBudget:()=>true,...(checkpointHints?{checkpointHintCodec:f.config.checkpointHintCodec}:{}),...(discoveryState?{discoveryStateCodec:f.config.discoveryStateCodec}:{})},tick,advance,inspect};
}
export function finish(f,options={},max=80){const results=[];for(let n=0;n<max;n++){const out=f.tick(options);results.push(out);assert(!['blocked','manual-resume-required'].includes(out.status),JSON.stringify(results));if(out.status==='complete')return results;f.advance(out);}assert.fail('No terminal completion: '+JSON.stringify(results.at(-1)));}
