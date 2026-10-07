import test from 'node:test';import assert from 'node:assert/strict';
import {ImportRunner} from './import-runner.mjs';
import {initialCheckpoint} from './bounded-import.mjs';
import {encodeUtf8} from './codec.mjs';
const bytes=encodeUtf8('# sensor:multi_record\ntime,latitude,longitude\n2026-01-01T00:00:00Z,1,2\n');
const sourceIdentity={id:'source',version:'1',md5Checksum:'a'.repeat(32),size:String(bytes.length)};
function harness(){let pending=null,calls=0,commits=0,allocation=0;const cp=initialCheckpoint(sourceIdentity);let last;
 const store={storeId:'store',getJob:()=>({status:'active'}),resumeJob:()=>({job:{checkpoint:null},checkpoint:cp,pending}),reserveBatch:r=>{pending={...r,transition:{progress:{offset:r.checkpoint.offset}}};}};
 const coordinator={commitPreparedBatch:r=>{last=r;if(++calls===1)throw Error('LOST_RESPONSE');commits++;return {operationId:r.operationId};}};
 const runner=new ImportRunner({store,coordinator,source:{readRange:()=>bytes},allocateIds:n=>Array.from({length:n},()=>`id${++allocation}`),locked:fn=>fn(),checkBudget:()=>true});
 return {runner,getPending:()=>pending,getLast:()=>last,getAllocation:()=>allocation,getCommits:()=>commits};}
test('runner persists fixed IDs before upload and regenerates same batch on restart',()=>{const h=harness();assert.throws(()=>h.runner.stepJob('job'),/LOST_RESPONSE/);const first=h.getLast();const allocation=h.getAllocation();assert(h.getPending());const result=h.runner.stepJob('job');assert.equal(result.status,'parsed');assert.equal(h.getAllocation(),allocation);assert.equal(first.reuseExisting,false);assert.equal(h.getLast().reuseExisting,true);assert.deepEqual({...h.getLast(),reuseExisting:false},first);assert.equal(h.getCommits(),1);});
test('budget failure before new work makes no source call or reservation',()=>{let called=false;const runner=new ImportRunner({store:{},coordinator:{},source:{readRange:()=>{called=true;}},allocateIds:()=>[],locked:fn=>fn(),checkBudget:()=>false});assert.throws(()=>runner.stepJob('job'),/IMPORT_YIELD/);assert.equal(called,false);});
