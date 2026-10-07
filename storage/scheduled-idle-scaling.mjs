// Synthetic read-only discovery scaling evidence. No source import or live IO.
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {fixture,csv} from './scheduled-runtime-fixture.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {importKeys} from './import-store.mjs';import {sourceKey,PARSER_VERSION} from './import-core.mjs';import {mappingHash} from './bounded-import.mjs';
const immutableCounts=f=>Object.fromEntries(['frame','checkpoint-index','checkpoint-manifest','index-node'].map(role=>[role,[...f.files.values()].filter(x=>x.meta.appProperties?.['mypace.role']===role).length]));
function sources(f,count){
 const originals=[];for(let i=0;i<count;i++){const bytes=new TextEncoder().encode(csv(1).replace(',1,2\n',`,${i%90},${i%180}\n`)),id=i?'source_'+i:'source';const meta={...structuredClone(f.source),id,name:`source-${i}.csv`,size:String(bytes.length),md5Checksum:createHash('md5').update(bytes).digest('hex')};f.files.set(id,{meta,bytes});originals.push(meta);}
 const list=f.globals.Drive.Files.list;let pageCalls=0,expire=null;
 f.globals.Drive.Files.list=args=>{list(args);pageCalls++;if(expire&&args.pageToken===expire){expire=null;const e=Error('expired');e.code=400;throw e;}const offset=args.pageToken?Number(args.pageToken.slice(1)):0;return {files:originals.slice(offset,offset+32).map(x=>structuredClone(x)),...(offset+32<originals.length?{nextPageToken:'p'+(offset+32)}:{})};};
 return {originals,pageCalls:()=>pageCalls,expire:token=>{expire=token;}};
}
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

export function measureUnchangedFolderDay({sourceCount=145,evictEveryTick=false}={}){
 const f=fixture({checkpointHints:true,discoveryState:true,cache:true}),listing=sources(f,sourceCount);
 // This is pre-existing trusted published state for discovery scaling only;
 // source parser/output construction is tested elsewhere, not modeled here.
 seedSettled(f,listing.originals);
 const initial=immutableCounts(f),initialFiles=f.files.size,before=f.state.serviceCalls,callIndex=f.calls.length,listBefore=listing.pageCalls(),results=[];
 for(let tick=1;tick<=96;tick++){
  if(evictEveryTick)f.cacheEntries.clear();f.state.now=tick*900000;
  const out=f.tick();assert.equal(out.status,'complete',JSON.stringify(out));assert.equal(out.scanId,'seed_scan');
  results.push({tick,calls:out.usage.calls,reconciliation:out.reconciliation||'not-due'});
 }
 const final=immutableCounts(f),growth=Object.fromEntries(Object.keys(initial).map(role=>[role,final[role]-initial[role]]));assert.deepEqual(growth,{frame:0,'checkpoint-index':0,'checkpoint-manifest':0,'index-node':0});assert.equal(f.state.writes,0);
 const actualCalls=f.state.serviceCalls-before;assert.equal(results.reduce((n,r)=>n+r.calls,0),actualCalls);
 return {model:'unchanged-large-folder-24h',sourceCount,seededPublishedState:true,sourceImportModeled:false,discoveryStateConfigured:!!f.config.discoveryStateId,cache:true,evictEveryTick,cadenceMs:900000,ticks:96,actualDriveAndFetchCalls:actualCalls,completedDiscoverySweeps:results.filter(r=>r.reconciliation==='unchanged').length,partialDiscoveryTicks:results.filter(r=>r.reconciliation==='scanning').length,sourceLists:listing.pageCalls()-listBefore,maximumDriveAndFetchCallsPerTick:Math.max(...results.map(r=>r.calls)),mutableCursorWrites:f.calls.slice(callIndex).filter(c=>['update','create'].includes(c[0])&&c[1]==='discovery').length,newFiles:f.files.size-initialFiles,immutableGrowth:growth,cacheOperations:f.cacheCalls.length,rollingWorkCallLimit:12000,illustrativeWorkCeilingPlusObservedIdleCalls:12000+actualCalls,rollingWorkLedgerDoesNotIncludeIdle:true,accountQuotaGuarantee:false};
}
