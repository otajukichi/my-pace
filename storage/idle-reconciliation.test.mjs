import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {fixture,finish,csv,clockEvent} from './scheduled-runtime-fixture.mjs';
import {createOwnerScheduler,OWNER_LIMITS} from './owner-scheduler.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {createImportReader} from './import-reader.mjs';
import {importKeys} from './import-store.mjs';import {sourceKey,PARSER_VERSION} from './import-core.mjs';import {mappingHash} from './bounded-import.mjs';
import {sourceIsCurrentlySettled,reconcileCompletedSources,createIdleScanThrottle,RECONCILIATION_LIMITS} from './idle-reconciliation.mjs';
import {createDiscoveryStateCodec,createDiscoveryStateIO,DISCOVERY_STATE_MAX_BYTES} from './discovery-state.mjs';
function sources(f,count){
 const originals=[];for(let i=0;i<count;i++){const bytes=new TextEncoder().encode(csv(1).replace(',1,2\n',`,${i%90},${i%180}\n`)),id=i?'source_'+i:'source';const meta={...structuredClone(f.source),id,name:`source-${i}.csv`,size:String(bytes.length),md5Checksum:createHash('md5').update(bytes).digest('hex')};f.files.set(id,{meta,bytes});originals.push(meta);}
 const list=f.globals.Drive.Files.list;let pageCalls=0,expire=null;
 f.globals.Drive.Files.list=args=>{list(args);pageCalls++;if(expire&&args.pageToken===expire){expire=null;const e=Error('expired');e.code=400;throw e;}const offset=args.pageToken?Number(args.pageToken.slice(1)):0;return {files:originals.slice(offset,offset+32).map(x=>structuredClone(x)),...(offset+32<originals.length?{nextPageToken:'p'+(offset+32)}:{})};};
 return {originals,pageCalls:()=>pageCalls,expire:token=>{expire=token;}};
}
const immutableCounts=f=>Object.fromEntries(['frame','checkpoint-index','checkpoint-manifest','index-node'].map(role=>[role,[...f.files.values()].filter(x=>x.meta.appProperties?.['mypace.role']===role).length]));
function manual(f,method){return createOwnerScheduler(f.globals,f.config,{now:()=>f.state.now,limits:{...OWNER_LIMITS,steps:1}})[method]();}
function seedSettled(f,records){
 const runtime=createGasImportRuntime(f.globals,{...f.config,protocolReadCache:{mode:'lock-phase'}});
 runtime.locked(()=>{runtime.store.recoveryBarrier();let head=null;for(let i=0;i<records.length;i++){
  const source=records[i],jobId='seed_'+i,runId='seed_run_'+i,key=sourceKey(source,mappingHash()),job={schema:1,storeId:f.config.storeId,jobId,queueNext:head,status:'completed',pinActive:false,progress:{},sourceIdentity:source,sourceKey:key,parserVersion:PARSER_VERSION,mappingHash:mappingHash(),runId};
  const entries=[[importKeys.job(jobId),job],[importKeys.identity(key),{jobId}],[importKeys.source(source.id),{sourceId:source.id,mappingHash:mappingHash(),runId,activeJobId:jobId,publishedSourceKey:key}],[importKeys.run(runId),{imported:{sourceIdentity:source,sourceKey:key,jobId,parserVersion:PARSER_VERSION,mappingHash:mappingHash()}}]];
  runtime.writer.transact({operationId:'seed_'+i,epoch:'default',digest:'a'.repeat(64),changes:entries.map(([key,value])=>({key,expectedVersion:runtime.writer.get(key)?.version||0,value})),result:{}});head=jobId;
 }
 const directoryKey=importKeys.directory(),prior=runtime.writer.get(directoryKey);runtime.writer.transact({operationId:'seed_directory',epoch:'default',digest:'a'.repeat(64),changes:[{key:directoryKey,expectedVersion:prior?.version||0,value:{head,count:records.length}}],result:{}});
 const value={schema:1,generation:1,status:'complete',scanId:'seed_scan',cursor:null,queueStarted:false,cycleActive:false,attempt:0,retryAt:0,error:null,lastJob:null,completedAt:0,buckets:[],completedDirectoryVersion:(prior?.version||0)+1};runtime.writer.transact({operationId:'seed_scheduler',epoch:'default',digest:'a'.repeat(64),changes:[{key:'import/owner-scheduler',expectedVersion:0,value}],result:{}});
 runtime.writer.checkpoint({operationId:'seed_seal',epoch:'default',digest:'a'.repeat(64),result:{}});
 });
}
for(const cache of [false,true])test(`24h unchanged three-source scheduled model has zero immutable churn; CacheService=${cache}`,()=>{
 const f=fixture({checkpointHints:true,discoveryState:true,cache}),listing=sources(f,3);const done=finish(f).at(-1);const before=immutableCounts(f),calls=f.state.serviceCalls,files=f.files.size,lists=listing.pageCalls();
 const results=[];for(let i=1;i<=96;i++){f.state.now=done.completedAt+i*900000;results.push(f.tick());}
 assert(results.every(x=>x.status==='complete'&&x.scanId===done.scanId),JSON.stringify(results));assert.deepEqual(immutableCounts(f),before);assert(f.files.size-files<=1);assert.equal(f.state.writes,0);assert(listing.pageCalls()-lists<=24);
 console.log(JSON.stringify({model:'unchanged-three-source-24h',cache,cadenceMs:900000,ticks:96,sourceBytes:listing.originals.map(x=>Number(x.size)),actualDriveAndFetchCalls:f.state.serviceCalls-calls,sourceLists:listing.pageCalls()-lists,newImmutableFrames:0,newCheckpointIndexes:0,newFiles:f.files.size-files,cacheOperations:f.cacheCalls.length,rollingWorkLedgerDoesNotIncludeIdle:true}));
});
test('cache flush and absence only repeat authoritative reads; completed discovery remains bounded idle',()=>{
 const f=fixture({checkpointHints:true,discoveryState:true,cache:true}),listing=sources(f,3),done=finish(f).at(-1);f.state.now=done.nextScanAt;assert.equal(f.tick().reconciliation,'unchanged');const before=immutableCounts(f),lists=listing.pageCalls();
 for(let i=0;i<3;i++){f.cacheEntries.clear();f.state.now+=900000;assert.equal(f.tick().reconciliation,'recorded-idle');}assert.equal(listing.pageCalls(),lists);assert.deepEqual(immutableCounts(f),before);
 f.cacheEntries.clear();delete f.globals.CacheService;f.state.now+=900000;assert.equal(f.tick().reconciliation,'unchanged');assert.deepEqual(immutableCounts(f),before);
});
test('manual Start invalidates idle cache; a new queued job resumes even inside idle interval',()=>{
 const f=fixture({checkpointHints:true,discoveryState:true,cache:true}),listing=sources(f,1),done=finish(f).at(-1);f.state.now=done.nextScanAt;f.tick();assert(f.cacheEntries.size);const manualOut=manual(f,'start');assert.equal(f.cacheEntries.size,0);assert.equal(manualOut.scanId,'owner_scan_2');
 finish(f);const r=createGasImportRuntime(f.globals,f.config),next={...listing.originals[0],id:'manual_new'};f.files.set(next.id,{meta:next,bytes:f.files.get('source').bytes});r.locked(()=>r.store.registerJob({operationId:'manual_new',jobId:'manual_new',sourceIdentity:next}));const out=f.tick();assert.notEqual(out.reconciliation,'cached-idle');assert(['importing','complete'].includes(out.status));assert.equal(out.lastJob?.jobId,'manual_new');
});
test('changed source and later new file enter durable pipeline after bounded idle interval',()=>{
 const f=fixture({checkpointHints:true,discoveryState:true,cache:true}),listing=sources(f,1),done=finish(f).at(-1);f.state.now=done.nextScanAt;f.tick();
 const original=listing.originals[0],bytes=new TextEncoder().encode(csv(2));Object.assign(original,{version:'2',size:String(bytes.length),md5Checksum:createHash('md5').update(bytes).digest('hex')});f.files.set('source',{meta:original,bytes});
 f.state.now+=3600000;const changed=f.tick();assert.equal(changed.scanId,'owner_scan_2');finish(f);assert(f.inspect().some(j=>j.status==='completed'&&j.sourceIdentity.version==='2'));
 const newer={...structuredClone(original),id:'later',name:'later.csv',version:'1'};listing.originals.push(newer);f.files.set('later',{meta:newer,bytes});f.state.now+=3600000;assert.equal(f.tick().scanId,'owner_scan_3');finish(f);assert(f.inspect().some(j=>j.sourceIdentity.id==='later'&&['completed','duplicate'].includes(j.status)));
});
test('paginated 145-source unchanged folder uses one bounded mutable cursor and survives every-tick cache eviction',()=>{
 const f=fixture({checkpointHints:true,discoveryState:true,cache:true}),listing=sources(f,145);seedSettled(f,listing.originals);f.state.now=3600000;const before=immutableCounts(f),fileCount=f.files.size;let last,partial=0;
 for(let i=0;i<50;i++){f.cacheEntries.clear();last=f.tick();assert.equal(last.status,'complete',JSON.stringify(last));if(last.reconciliation==='unchanged')break;assert.equal(last.reconciliation,'scanning');assert.equal(last.discoverySaved,true);partial++;f.state.now+=900000;}
 assert.equal(last.reconciliation,'unchanged');assert(partial>0);assert.deepEqual(immutableCounts(f),before);assert.equal(f.files.size,fileCount+1);assert(f.files.get('discovery').bytes.length<=DISCOVERY_STATE_MAX_BYTES);
});
test('expired discovery token restarts safely and a late-page new file enters durable pipeline with cold/evicted cache',()=>{
 const f=fixture({checkpointHints:true,discoveryState:true,cache:true}),listing=sources(f,145);seedSettled(f,listing.originals);f.state.now=3600000;const before=immutableCounts(f);let first=f.tick();assert.equal(first.reconciliation,'scanning');
 const codec=f.config.discoveryStateCodec,state=codec.decode(f.files.get('discovery').bytes);assert(state.state.pageToken);listing.expire(state.state.pageToken);f.cacheEntries.clear();f.state.now+=900000;const expired=f.tick();assert.equal(expired.reconciliation,'scanning');assert.deepEqual(immutableCounts(f),before);
 const old=listing.originals.at(-1),bytes=new TextEncoder().encode(csv(2));const late={...old,id:'late_new',name:'late.csv',size:String(bytes.length),md5Checksum:createHash('md5').update(bytes).digest('hex')};listing.originals.push(late);f.files.set(late.id,{meta:late,bytes});let out;
 for(let i=0;i<50;i++){f.cacheEntries.clear();f.state.now+=900000;out=f.tick();if(out.scanId!=='seed_scan')break;}assert.notEqual(out.scanId,'seed_scan');assert.equal(out.status,'scanning');
});
test('discovery authentication corruption restarts listing and never chooses alternate IDs',()=>{
 const f=fixture({checkpointHints:true,discoveryState:true,cache:true}),listing=sources(f,145);seedSettled(f,listing.originals);f.state.now=3600000;f.tick();const file=f.files.get('discovery');file.bytes[20]^=1;const before=immutableCounts(f);f.cacheEntries.clear();f.state.now+=900000;assert.equal(f.tick().reconciliation,'scanning');assert.deepEqual(immutableCounts(f),before);assert.equal([...f.files.values()].filter(x=>x.meta.appProperties?.['mypace.role']==='source-discovery').length,1);
});
test('advisory cache is scoped to real script/store and cannot extend its expiry with malformed values',()=>{
 const f=fixture({cache:true}),head={headHash:'a'.repeat(64),revision:1};const a=createIdleScanThrottle(f.globals,f.config,{now:()=>f.state.now,intervalMs:3600000});a.remember(head);assert.equal(a.get(head),3600000);const b=createIdleScanThrottle(f.globals,{...f.config,storeId:'other'},{now:()=>f.state.now,intervalMs:3600000});assert.equal(b.get(head),null);assert.equal(a.get({...head,revision:2}),null);const entry=[...f.cacheEntries.values()][0];entry.text=JSON.stringify({schema:1,headHash:head.headHash,revision:1,checkedAt:999999999});assert.equal(a.get(head),null);assert(f.cacheCalls.every(x=>x[1].length<250));
});
test('bounded discovery codec rejects forged bytes and maximum token remains within fixed file bound',()=>{
 const codec=createDiscoveryStateCodec({hmacSha256:text=>createHash('sha256').update('fixture-'+text).digest('hex')}),bytes=codec.encode({pageToken:'x'.repeat(4096)});assert(bytes.length<DISCOVERY_STATE_MAX_BYTES);assert.equal(codec.decode(bytes).pageToken.length,4096);bytes[bytes.length-10]^=1;assert.equal(codec.decode(bytes),null);
});

test('CacheService errors and a lost successful cursor response preserve discovery without journal frames',()=>{
 const f=fixture({checkpointHints:true,discoveryState:true,cache:true}),listing=sources(f,1),done=finish(f).at(-1);f.globals.CacheService={getScriptCache:()=>{throw Error('unavailable');}};
 const create=f.globals.Drive.Files.create;let once=true;f.globals.Drive.Files.create=(metadata,...args)=>{const result=create(metadata,...args);if(metadata.id==='discovery'&&once){once=false;throw Error('lost cursor response');}return result;};f.state.now=done.nextScanAt;const before=immutableCounts(f),out=f.tick();assert.equal(out.reconciliation,'unchanged');assert.equal(out.discoverySaved,true);assert.deepEqual(immutableCounts(f),before);f.state.now+=900000;assert.equal(f.tick().reconciliation,'recorded-idle');assert.equal([...f.files.values()].filter(x=>x.meta.appProperties?.['mypace.role']==='source-discovery').length,1);assert.equal(listing.pageCalls(),2);
});
test('manual Retry clears stale idle throttles even when it has no blocked work',()=>{
 const f=fixture({checkpointHints:true,discoveryState:true,cache:true});sources(f,1);const done=finish(f).at(-1);f.state.now=done.nextScanAt;f.tick();assert(f.cacheEntries.size);manual(f,'retryBlocked');assert.equal(f.cacheEntries.size,0);
});
test('event fields cannot select discovery file or cache keys',()=>{
 const f=fixture({checkpointHints:true,discoveryState:true,cache:true});sources(f,1);const done=finish(f).at(-1);f.state.now=done.nextScanAt;const out=f.tick({}, {...clockEvent(),discoveryStateId:'attacker',cacheKey:'attacker',pageToken:'attacker'});assert.equal(out.reconciliation,'unchanged');assert(f.files.has('discovery'));assert(!f.files.has('attacker'));assert(f.cacheCalls.every(x=>!x[1].includes('attacker')));
});
test('copied discovery cursor is rejected under a different script/store/head and unsafe file identity is never overwritten',()=>{
 const f=fixture({checkpointHints:true,discoveryState:true}),listing=sources(f,1),done=finish(f).at(-1);f.state.now=done.nextScanAt;f.tick();const original=f.files.get('discovery').bytes.slice(),r=createGasImportRuntime(f.globals,f.config);
 r.locked(()=>{r.store.recoveryBarrier();const head=r.writer.status();const io=createDiscoveryStateIO(f.globals,f.config,{now:()=>f.state.now});assert.equal(io.read(head).phase,'complete');assert.equal(io.read({...head,revision:head.revision+1}),null);const payload=f.config.discoveryStateCodec.decode(original);payload.storeId='other';f.files.get('discovery').bytes=f.config.discoveryStateCodec.encode(payload);f.files.get('discovery').meta.size=String(f.files.get('discovery').bytes.length);assert.equal(io.read(head),null);f.files.get('discovery').meta.shared=true;assert.throws(()=>io.write(head,{phase:'complete',pageToken:null,index:0,pageHash:null,checkedAt:f.state.now}),/DISCOVERY_STATE_METADATA_MISMATCH/);});
});
test('changed/reordered resumed source page rechecks its full prefix instead of skipping a new source',()=>{
 const source={listPage:()=>({files:[],nextPageToken:null})},writer={get:()=>null};const newSource={id:'new',name:'new.csv',mimeType:'text/csv',parents:['1xam56gYF-jcBU5XzXBKtMxqhyJYwiNE1'],trashed:false,size:'71',version:'1',md5Checksum:'a'.repeat(32)};
 source.listPage=()=>({files:[newSource],nextPageToken:null});const result=reconcileCompletedSources({writer,source,cursor:{phase:'scan',pageToken:null,index:1,pageHash:'a'.repeat(64),checkedAt:0}});assert.equal(result.reason,'source-work');assert.equal(result.checked,1);
});

function browserStatus(f){return createImportReader({runtime:createGasImportRuntime(f.globals,f.config),sealCursor:JSON.stringify,openCursor:JSON.parse,now:()=>f.state.now}).status();}
for(const fault of ['forbidden','wrong-owner'])test(`discovery ${fault} persists one app-visible blocked status and owner Retry restores reconciliation`,()=>{
 const f=fixture({checkpointHints:true,discoveryState:true,cache:true});sources(f,1);const done=finish(f).at(-1);f.state.now=done.nextScanAt;f.tick();f.state.now+=3600000;
 const fetch=f.globals.UrlFetchApp.fetch;
 if(fault==='forbidden')f.globals.UrlFetchApp.fetch=(url,...args)=>url.includes('/discovery?fields=')?{getResponseCode:()=>403}:fetch(url,...args);
 else f.files.get('discovery').meta.ownedByMe=false;
 const blocked=f.tick();assert.equal(blocked.status,'blocked');assert.equal(blocked.requiresOwnerAction,true);assert.equal(blocked.errorPersisted,true);assert.equal(blocked.error,fault==='forbidden'?'DISCOVERY_STATE_PERMISSION_DENIED':'DISCOVERY_STATE_METADATA_MISMATCH');
 const read=browserStatus(f);assert.equal(read.status,'blocked');assert.equal(read.requiresOwnerAction,true);assert.equal(read.error,blocked.error);const counts=immutableCounts(f);for(let i=0;i<3;i++)assert.equal(f.tick().status,'blocked');assert.deepEqual(immutableCounts(f),counts);
 f.globals.UrlFetchApp.fetch=fetch;f.files.get('discovery').meta.ownedByMe=true;assert.equal(manual(f,'retryBlocked').status,'complete');assert.equal(f.tick().reconciliation,'unchanged');assert.equal(browserStatus(f).status,'complete');
});
test('transient discovery read error retries without pretending new progress or writing a journal frame',()=>{
 const f=fixture({checkpointHints:true,discoveryState:true});sources(f,1);const done=finish(f).at(-1);f.state.now=done.nextScanAt;const before=immutableCounts(f),fetch=f.globals.UrlFetchApp.fetch;f.globals.UrlFetchApp.fetch=(url,...args)=>url.includes('/discovery?fields=')?{getResponseCode:()=>503}:fetch(url,...args);const out=f.tick();assert.equal(out.reconciliation,'deferred');assert.equal(out.retryable,true);assert(out.retryAt>f.state.now);assert.deepEqual(immutableCounts(f),before);f.globals.UrlFetchApp.fetch=fetch;assert.equal(f.tick().reconciliation,'unchanged');
});
test('persistent cursor-create failure pauses a large sweep visibly; owner retry reaches a late new file',()=>{
 const f=fixture({checkpointHints:true,discoveryState:true,cache:true}),listing=sources(f,145);seedSettled(f,listing.originals);f.state.now=3600000;
 const late={...structuredClone(listing.originals[0]),id:'late_new',name:'late.csv'};listing.originals.push(late);f.files.set(late.id,{meta:late,bytes:f.files.get('source').bytes});
 const create=f.globals.Drive.Files.create;f.globals.Drive.Files.create=(metadata,...args)=>{if(metadata.id==='discovery'){const e=Error('forbidden');e.code=403;throw e;}return create(metadata,...args);};
 const blocked=f.tick();assert.equal(blocked.status,'blocked');assert.equal(blocked.error,'DISCOVERY_STATE_WRITE_UNRESOLVED');assert.equal(blocked.errorPersisted,true);assert.equal(browserStatus(f).status,'blocked');const before=immutableCounts(f),lists=listing.pageCalls();for(let i=0;i<4;i++){f.cacheEntries.clear();f.state.now+=900000;assert.equal(f.tick().status,'blocked');}assert.equal(listing.pageCalls(),lists);assert.deepEqual(immutableCounts(f),before);
 f.globals.Drive.Files.create=create;manual(f,'retryBlocked');let out;for(let i=0;i<50;i++){f.cacheEntries.clear();f.state.now+=900000;out=f.tick();if(out.scanId!=='seed_scan')break;}assert.notEqual(out.scanId,'seed_scan');assert.equal(out.status,'scanning');
});
