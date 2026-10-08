import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {ReservedSlotWriter,writerDigest} from './reserved-writer.mjs';
import {createCheckpointHintCodec} from './checkpoint-hint.mjs';
import {createPreparationCodec} from './preparation-codec.mjs';
import {createPreparedAppCommand} from '../gas/prepared-app-domain.mjs';
import {activateSyncV2} from './sync-v2-activation.mjs';
import {createAppDomain} from '../gas/app-domain.mjs';
const key='prepared-test-key'.repeat(4);
function fixture(){
 const files=new Map(),calls=[];let serial=0,hint=null,allowed=Infinity,count=0;const faults={};
 const io={getScriptId:()=> 'writer',assertLockHeld:()=>true,allocateIds:n=>Array.from({length:n},()=> 'id_'+(++serial)),readFile(id){if(++count>allowed){const e=Error('STORE_YIELD');e.code=e.message;e.retryable=true;throw e;}calls.push(['read',id]);if(faults.read)return faults.read(id,()=>files.get(id)||null);return files.get(id)||null;},createFile(id,bytes,role){if(++count>allowed){const e=Error('STORE_YIELD');e.code=e.message;e.retryable=true;throw e;}calls.push(['create',id,role]);const create=()=>{if(files.has(id))throw Error('409');files.set(id,bytes);};if(faults.create)return faults.create(id,bytes,role,create);return create();},readCheckpointHint:()=>hint,writeCheckpointHint:b=>{hint=b;}};
 const config={io,anchorId:'anchor',storeId:'store',writerScriptId:'writer',checkpointHintId:'hint',checkpointHintCodec:createCheckpointHintCodec({hmacSha256:t=>createHmac('sha256',key).update(t).digest('hex')}),preparationCodec:createPreparationCodec({hmacSha256:t=>createHmac('sha256',key).update(t).digest('hex')}),preparedAppAdapter:createPreparedAppCommand,progressiveRecovery:true,canContinuePreparation:()=>count<allowed-4,clock:()=> '2026-10-07T18:00:00Z'};
 const fresh=(over={})=>new ReservedSlotWriter({...config,...over});let writer=fresh();writer.bootstrap();activateSyncV2({writer,locked:fn=>fn()});
 return {files,calls,faults,config,fresh,setLimit(n){count=0;allowed=n;},get count(){return count;},get hint(){return hint;},set hint(h){hint=h;},writer,domain(w=writer){return createAppDomain({writer:w,locked:fn=>fn(),digest:text=>writerDigest(JSON.parse(text))});}};
}
const cmd=(id='abcdefghijklmnop',n=0)=>({operationId:id,epoch:'default',generation:'1',store:'store',key:'diary:2026-10-07',expectedVersion:n,deleted:false,value:{text:'hello '+n},recreate:false});
test('prepared command commits exactly once and replays original receipt',()=>{const f=fixture(),c=cmd(),receipt=f.domain().command(c);assert.equal(receipt.result.appSeq,1);assert.deepEqual(f.domain(f.fresh()).command(c),receipt);const w=f.fresh();w.recoveryBarrier();assert.equal(w.get('app/data/'+c.key).value.text,'hello 0');assert.equal([...f.files.values()].map(b=>JSON.parse(new TextDecoder().decode(b))).filter(x=>x.kind==='preparation').length,1);});
test('repeated interrupted preparation preserves one descriptor and assigned output IDs',()=>{const f=fixture(),c=cmd();let receipt,pending=0;for(let n=0;n<200;n++){f.setLimit(22);try{receipt=f.domain(f.fresh()).command(c);break;}catch(e){assert.ok(e.retryable||e.code==='STORE_YIELD',e.stack);pending++;}}assert.ok(receipt);assert.ok(pending>1);assert.equal(receipt.result.appSeq,1);const files=[...f.files.values()].map(b=>JSON.parse(new TextDecoder().decode(b)));assert.equal(files.filter(x=>x.kind==='preparation').length,1);const assignments=files.filter(x=>x.kind==='preparation-work').flatMap(x=>x.payload.state.assignment?.nodes.map(n=>n.id)||[]);assert.equal(new Set(assignments).size,assignments.length);});
test('domain conflict commits terminal typed original receipt without app event',()=>{const f=fixture();f.domain().command(cmd());const bad=cmd('otherabcdefghijkl',0);assert.throws(()=>f.domain().command(bad),/ENTITY_VERSION_CONFLICT/);const w=f.fresh();w.recoveryBarrier();const receipt=w.getReceipt(bad.operationId,bad.epoch);assert.deepEqual(receipt.result,{preparationError:'ENTITY_VERSION_CONFLICT'});assert.equal(w.get('app/change-head').value.seq,1);assert.throws(()=>f.domain(w).command(bad),/ENTITY_VERSION_CONFLICT/);});
