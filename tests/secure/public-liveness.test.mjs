import test from 'node:test';import assert from 'node:assert/strict';
import {gasWebFixture} from '../helpers/gas-web-fixture.mjs';
import {writerDigest} from '../../storage/reserved-writer.mjs';
const seed=rt=>{for(let i=0;i<15;i++)rt.writer.transact({operationId:'legacy_'+i,digest:writerDigest(i),changes:[{key:'legacy-preserved',expectedVersion:i,value:i}]});rt.writer.checkpoint({operationId:'owner-prepared',digest:writerDigest('owner-prepared')});};
const payload=f=>({cursor:null,since:null,minimumAcknowledged:null});
function request(f,action,p,stats=[]){
 const previous=new Map();
 for(let n=0;n<20;n++){
  const r=f.invoke(action,p);stats.push({...f.last,action,error:r.error||null});if(r.ok)return r.result;
  const progress=r.recovery;assert.equal(r.error,'WRITER_RECOVERY_PENDING',JSON.stringify({r,last:f.last}));assert.equal(progress?.cursorPersisted,true);assert.equal(progress?.cursorAdvanced,true);
  // Preparation ordinals restart for a new pinned descriptor (for example an
  // automatic checkpoint followed by this command). Count actual immutable
  // work facts in this fixture, rather than compare unrelated ordinal spaces.
  const marker=progress.phase==='preparation'?[...f.files.values()].filter(file=>file.meta.appProperties?.['mypace.role']==='preparation-work').length:progress.revision??progress.indexLinks;
  assert(Number.isSafeInteger(marker)&&marker>0);if(previous.has(progress.phase))assert(marker>previous.get(progress.phase),'continuation must durably advance');previous.set(progress.phase,marker);f.advance(250);
 }
 assert.fail('bounded fixture failed to finish');
}
for(const latency of [100,300,500])test(`100 acknowledged writes retain bounded cold-read work at ${latency}ms/service`,()=>{
 const f=gasWebFixture({readMs:latency,writeMs:latency,seed,activate:true}),stats=[],initial=request(f,'pull',payload(f),stats);let checkpoint=initial.checkpoint,proof={store:initial.store,generation:initial.generation,revision:initial.revision,hash:initial.headHash};const reads=[];
 for(let n=0;n<100;n++){
  const date=new Date(Date.UTC(2026,9,8+n)).toISOString().slice(0,10),command={operationId:'public_diary_operation_'+String(n).padStart(4,'0'),epoch:'default',generation:'1',store:f.config.storeId,key:'diary:'+date,expectedVersion:0,deleted:false,value:{text:'test '+n,mood:null},recreate:false};
  const ack=request(f,'commandV2',command,stats);assert.equal(ack.result.appSeq,n+1);proof={store:f.config.storeId,generation:'1',revision:ack.revision,hash:ack.frameHash};
  const at=stats.length,pull=request(f,'pull',{cursor:null,since:checkpoint,minimumAcknowledged:proof},stats);assert.equal(pull.mode,'delta');assert.equal(pull.entries.length,1);assert.equal(pull.entries[0].value.text,'test '+n);assert.equal(pull.checkpoint.seq,n+1);checkpoint=pull.checkpoint;proof={store:pull.store,generation:pull.generation,revision:pull.revision,hash:pull.headHash};reads.push(stats.slice(at).reduce((sum,s)=>sum+s.calls,0));
 }
 const idle=request(f,'pull',{cursor:null,since:checkpoint,minimumAcknowledged:proof},stats);assert.equal(idle.entries.length,0);assert.equal(idle.checkpoint.seq,100);assert(Math.max(...reads)<=40,JSON.stringify({latency,reads}));assert(stats.every(s=>s.elapsedMs<=(['commandV2','recover','pull','snapshot','maintain'].includes(s.action)?45000:20000)));
 console.log(JSON.stringify({model:'public100',latency,maximumReadCalls:Math.max(...reads),firstReadCalls:reads[0],lastReadCalls:reads.at(-1),maximumRequestMs:Math.max(...stats.map(s=>s.elapsedMs)),continuations:stats.filter(s=>s.error).length,totalRequests:stats.length}));
});
