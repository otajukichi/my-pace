// Synthetic local protocol benchmark. Not browser/Drive performance evidence.
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {createInitialState,validateState,addDays} from '../src/lib/domain.js';
import {createCloudSync,createIndexedDBStorage} from '../src/lib/cloud-sync.js';
import {keyedIndexedDBDouble} from '../tests/helpers/indexeddb-keyed-double.js';
const hash=n=>createHash('sha256').update(String(n)).digest('hex');
for(const count of [1000,50000]){
 const entities={};for(let i=0;i<count;i++){const key=i<36600?'wake:'+addDays('1900-01-01',i):'diary:'+addDays('2000-01-01',i-36600);entities[key]={key,version:1,deleted:false,value:i<36600?'07:00':{text:'合成ベンチマークの短い日記。'.repeat(4),mood:null}};}
 const idb=keyedIndexedDBDouble({format:1,store:'store',generation:'generation',epoch:'epoch',revision:0,entities,outbox:[],conflicts:[],importedRuns:[],importStatus:null,syncProtocol:2,syncCheckpoint:{store:'store',generation:'generation',seq:0},minimumObserved:{revision:0,hash:hash(0)},recordConfirmation:{kind:'snapshot',store:'store',generation:'generation',epoch:'epoch',revision:0}});
 let seq=0,revision=0,change=null,notifications=0,displayMs=0,display=createInitialState();
 const fetcher=async(path,options)=>{
  if(path==='/api/auth/session')return Response.json({ok:true,authenticated:true,csrf:'test'});
  const {action,payload}=JSON.parse(options.body);let result;
  if(action==='pull')result={protocol:2,mode:'delta',store:'store',generation:'generation',epoch:'epoch',revision,headHash:hash(revision),fromSeq:payload.since.seq,targetSeq:seq,throughSeq:seq,entries:payload.since.seq<seq?[change]:[],nextCursor:null,checkpoint:{store:'store',generation:'generation',seq},syncMeta:{format:1,imports:{ok:true,result:{revision,runs:[],nextCursor:null}},importStatus:{ok:true,result:{status:'idle'}}}};
  else throw Error('Unexpected '+action);
  return Response.json({ok:true,result});
 };
 const sync=createCloudSync({storage:createIndexedDBStorage(idb),fetcher,onRemoteState(candidate){const start=performance.now();const next=validateState(candidate);if(JSON.stringify(next)!==JSON.stringify(display))display=next;displayMs+=performance.now()-start;notifications++;}});
 global.gc?.();const heapBefore=process.memoryUsage().heapUsed,loadStart=performance.now();await sync.init();await sync.maintenance();const loadMs=performance.now()-loadStart;
 const beforeIdle=notifications;displayMs=0;idb.resetMetrics();const idleStart=performance.now();await sync.sync();await sync.maintenance();const idleMs=performance.now()-idleStart,idleNotifications=notifications-beforeIdle,idleEntityRows=idb.metrics.entities?.rowsRead??0;
 const key='wake:1900-01-01';change={...entities[key],version:2,value:'08:00'};seq=revision=1;idb.resetMetrics();displayMs=0;const updateStart=performance.now();await sync.sync();await sync.maintenance();const updateMs=performance.now()-updateStart;
 global.gc?.();console.log(JSON.stringify({syntheticRecords:count,loadMs:+loadMs.toFixed(2),idleMs:+idleMs.toFixed(2),idleNotifications,idleEntityRows,sparseUpdateMs:+updateMs.toFixed(2),displayValidationEqualityMs:+displayMs.toFixed(2),sparseEntityRowsRead:idb.metrics.entities?.rowsRead??0,sparseEntityRowsWritten:idb.metrics.entities?.rowsWritten??0,heapGrowthMiB:+((process.memoryUsage().heapUsed-heapBefore)/1048576).toFixed(2),caveat:'Node + in-memory IDB protocol double; excludes DOM rendering and browser/Drive latency'}));sync.destroy();
}
