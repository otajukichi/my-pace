// Synthetic HTTP-shaped Drive costs, never network or a production ETA.
import assert from 'node:assert/strict';
import fs from 'node:fs';import {createHash} from 'node:crypto';
import {gasWebFixture} from '../../tests/helpers/gas-web-fixture.mjs';
import {syntheticCut} from '../../tests/helpers/synthetic-history-cut.mjs';
import {writerDigest} from '../../storage/reserved-writer.mjs';
for(const count of (process.env.RECORDS||'100,1000,10000').split(',').map(Number))for(const proof of [false,true])for(const concurrency of (process.env.CONCURRENCY||'16,1').split(',').map(Number))for(const tokenMs of (process.env.TOKENS||'0,10000').split(',').map(Number))for(const kind of ['new','existing']){
 const bundleSha256=createHash('sha256').update(fs.readFileSync(new URL('../../gas/MyPaceComplete.gs',import.meta.url))).digest('hex');
 const f=gasWebFixture({readMs:1000,writeMs:1000,tokenMs,createProof:proof,batchConcurrency:concurrency,batchTimeoutScope:'dispatch',seed:rt=>{syntheticCut(rt.writer,count,{paired:true,receiptCount:count});rt.writer.recoveryBarrier();for(let n=0;n<15;n++)rt.writer.transact({operationId:'tail_'+n,digest:writerDigest(['tail',n]),changes:[],result:{maintenance:n}});}});
 const c={operationId:'practical_'+count+'_'+kind,epoch:'default',generation:'1',store:f.config.storeId,key:kind==='new'?'diary:2099-01-01':'diary:2000-01-01',expectedVersion:kind==='new'?0:1,deleted:false,value:{text:'Practical sync test',mood:null},recreate:false};
 const start=f.now,rows=[];let receipt=null,last=null,stale=0;
 for(let n=0;n<100;n++){const r=f.invoke('commandV2',c);rows.push({...f.last,error:r.error,recovery:r.recovery});if(r.ok){receipt=r.result;break;}assert(r.retryable,JSON.stringify(r));const fingerprint=f.files.size+':'+Buffer.from(f.files.get(f.config.checkpointHintId)?.bytes||[]).toString('base64');stale=fingerprint===last?stale+1:0;last=fingerprint;if(stale>=8)break;f.advance(500);}
 const elapsedMs=f.now-start;let replay=false;if(receipt){for(let n=0;n<100;n++){const r=f.invoke('commandV2',c);if(r.ok){assert.deepEqual(r.result,receipt);replay=true;break;}assert(r.retryable);f.advance(500);}}
 console.log(JSON.stringify({bundleSha256,count,proof,concurrency,tokenMs,kind,completed:!!receipt,replay,elapsedMs,calls:rows.reduce((n,r)=>n+r.calls,0),requests:rows.length,maxRequestMs:Math.max(...rows.map(r=>r.elapsedMs)),rows}));
}
