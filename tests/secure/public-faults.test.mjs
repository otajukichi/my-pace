// Actual generated GAS handler and REST module with one interrupted service
// boundary at a time. Synthetic Google responses only; no external requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {gasWebFixture} from '../helpers/gas-web-fixture.mjs';
const command=f=>({operationId:'fault_matrix_original_operation_001',epoch:'default',generation:'1',store:f.config.storeId,key:'diary:2026-10-07',expectedVersion:0,deleted:false,value:{text:'元の操作を一度だけ保存',mood:null},recreate:false});
const pull={cursor:null,since:null,minimumAcknowledged:null};
function durableFrameCount(f,id){return [...f.files.values()].filter(e=>{if(!e.bytes)return false;try{const p=JSON.parse(Buffer.from(e.bytes).toString());return p.kind==='frame'&&p.payload.operation.operationId===id;}catch{return false;}}).length;}

test('generated public command survives interruption before and after every REST service boundary with one original receipt',()=>{
 const baseline=gasWebFixture({activate:true}),c=command(baseline),ok=baseline.invoke('commandV2',c);assert.equal(ok.ok,true);const boundaries=baseline.last.calls;assert(boundaries>=20);
 for(const mode of ['before','after'])for(let boundary=1;boundary<=boundaries;boundary++){
  let ordinal=0,enabled=false,interrupted=false;
  const f=gasWebFixture({activate:true,aroundRequest:(call,normal)=>{if(!enabled)return normal();const hit=++ordinal===boundary;if(hit&&mode==='before'){interrupted=true;throw Error('synthetic interrupted request');}const r=normal();if(hit&&mode==='after'){interrupted=true;throw Error('synthetic lost service acknowledgment');}return r;}}),original=command(f);
  enabled=true;let result=f.invoke('commandV2',original);enabled=false;
  assert(interrupted,mode+' boundary '+boundary+' did not run');
  for(let attempt=0;!result.ok&&attempt<6;attempt++){assert.equal(result.retryable,true,JSON.stringify({mode,boundary,result}));result=f.invoke('commandV2',original);}
  assert.equal(result.ok,true,JSON.stringify({mode,boundary,result}));assert.equal(result.result.result.appSeq,1);assert.equal(result.result.result.version,1);assert.equal(durableFrameCount(f,original.operationId),1);
  const receipt=structuredClone(result.result);assert.deepEqual(f.invoke('commandV2',original).result,receipt);
  const page=f.invoke('pull',pull);assert.equal(page.ok,true,JSON.stringify({mode,boundary,page}));assert.equal(page.result.targetSeq,1);assert.equal(page.result.entries.length,1);assert.equal(page.result.entries[0].value.text,original.value.text);assert.equal(page.result.entries[0].version,1);
 }
 console.log(JSON.stringify({model:'generated-rest-fault-matrix',boundaries,cases:boundaries*2,identity:'same original operation UUID',durableFramesPerCase:1}));
});

test('a lost outer web acknowledgement replays the exact generated receipt without another event',()=>{
 const f=gasWebFixture({activate:true}),c=command(f),first=f.invoke('commandV2',c);assert.equal(first.ok,true);const original=structuredClone(first.result),size=f.files.size;
 // Simulate discarding the entire response after the handler returned.
 const retried=f.invoke('commandV2',c);assert.deepEqual(retried.result,original);assert.equal(f.files.size,size);assert.equal(durableFrameCount(f,c.operationId),1);const page=f.invoke('pull',pull);assert.equal(page.result.checkpoint.seq,1);
});
