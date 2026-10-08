import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPreparedAppCommand} from '../../gas/prepared-app-domain.mjs';
import {createAppDomain} from '../../gas/app-domain.mjs';
import {canonical} from '../../src/lib/entity-codec.js';
import {initialSyncAppChangeHead,SYNC_APP_CHANGE_HEAD,syncAppChangeSlot,SYNC_APP_CHANGE_CAPACITY} from '../../storage/app-sync-protocol.mjs';
const copy=x=>structuredClone(x);
const hash=x=>createHash('sha256').update(typeof x==='string'?x:canonical(x)).digest('hex');
const base={storeId:'store',datasetGeneration:'generation',acceptedEpochs:['epoch'],writerFence:2};
let serial=0;
const command=(key='wake:2026-10-07',value='07:00',expectedVersion=0,patch={})=>({operationId:'prepared_operation_'+(++serial),epoch:'epoch',generation:'generation',store:'store',key,expectedVersion,deleted:false,value,recreate:false,...patch});
const entity=(key,value,version=1,deleted=false)=>({key,value:deleted?null:copy(value),version,deleted});
const records=()=>new Map([[SYNC_APP_CHANGE_HEAD,entity(SYNC_APP_CHANGE_HEAD,initialSyncAppChangeHead())]]);
function run(command,rows=records(),options={}){
 const bound=options.base??base,digest=options.digest??hash(command);let state=createPreparedAppCommand({command,digest,base:bound}).initialState();const states=[],lookups=[];
 for(let n=0;n<12;n++){
  states.push(copy(state));const before=copy(state),prior=lookups.length;
  // Recreate the adapter on every microstep, exactly as a cold continuation.
  const adapter=createPreparedAppCommand({command:copy(command),digest,base:copy(bound)});
  const next=adapter.advance(copy(state),key=>{lookups.push(key);return copy(rows.get(key)??null);});
  assert(lookups.length-prior<=1,'one domain entity lookup at most per durable advance');assert.deepEqual(state,before,'advance does not mutate its supplied cursor');
  if(next.kind!=='progress')return {...next,states,lookups};state=JSON.parse(JSON.stringify(next.state));
 }
 assert.fail('application expansion must terminate in a fixed number of phases');
}
function direct(command,rows,bound=base){let sent;const writer={recoveryBarrier(){},getReceipt(){return null;},status(){return copy(bound);},getEntity:key=>copy(rows.get(key)??null),transact:c=>{sent=copy(c);return c;}};createAppDomain({writer,locked:fn=>fn(),digest:hash}).command(command);return sent;}
function apply(rows,changes){for(const c of changes)rows.set(c.key,entity(c.key,c.value,(rows.get(c.key)?.version??0)+1,c.deleted===true));}
const habit={id:'walk',name:' Walk ',type:'check',target:1};

test('staged expansion matches normal domain commands across every entity type and fence',()=>{
 const cases=[command(),command('diary:2026-10-07',{text:'A diary 😀',mood:'calm'}),command('habit:walk',habit),command('habitLog:walk:2026-10-07',true),command('run:r',{id:'r',date:'2026-10-07',distanceKm:1.5,durationSec:600}),command('event:e',{id:'e',date:'2026-10-07',title:'Meeting'}),command('settings:wakeTarget',null),command('garden:preferences',{plant:'cosmos',theme:'day'})];
 for(const fence of [0,2])for(const c of cases){
  const rows=records(),bound={...base,writerFence:fence};if(c.key.startsWith('habitLog:'))rows.set('app/data/habit:walk',entity('app/data/habit:walk',{...habit,unit:'',archived:false}));
  const expected=direct(c,rows,bound),actual=run(c,rows,{base:bound});assert.equal(actual.kind,'ready');assert.deepEqual(actual.changes,expected.changes);assert.deepEqual(actual.result,expected.result);assert.equal(actual.result.appSeq,fence?1:undefined);
 }
});

test('one hundred sequential create/update/delete/recreate commands keep catalog and journal semantics',()=>{
 const rows=records();
 for(let i=0;i<100;i++){
  const key='wake:2026-10-'+String(1+i%25).padStart(2,'0'),old=rows.get('app/data/'+key),deleted=i>=50&&i<75;
  const c=command(key,deleted?null:'08:'+String(i%60).padStart(2,'0'),old?.version??0,{deleted,recreate:old?.deleted===true&&!deleted});
  const expected=direct(c,rows),actual=run(c,rows);assert.equal(actual.kind,'ready');assert.deepEqual(actual.changes,expected.changes);assert.deepEqual(actual.result,expected.result);apply(rows,actual.changes);
 }
 assert.equal(rows.get(SYNC_APP_CHANGE_HEAD).value.seq,100);assert.equal([...rows.keys()].filter(k=>k.startsWith('app/catalog/')&&k!=='app/catalog/head').length,25);
});

test('existing records do not reread catalog and each cold state is compact',()=>{
 const c=command('diary:2026-10-07',{text:'😀'.repeat(8000),mood:null},1),rows=records();rows.set('app/data/'+c.key,entity('app/data/'+c.key,{text:'old',mood:null}));
 const r=run(c,rows);assert.equal(r.kind,'ready');assert.deepEqual(r.lookups,['app/data/'+c.key,SYNC_APP_CHANGE_HEAD,syncAppChangeSlot(1)]);assert(r.states.every(s=>Buffer.byteLength(JSON.stringify(s))<1200));assert(r.states.every(s=>!JSON.stringify(s).includes('😀')));assert.equal(r.changes[0].value.text,c.value.text);
});

test('new values are normalized without changing the original command or bound digest',()=>{
 const c=command('habit:walk',habit),original=copy(c),digest=hash(c),r=run(c,records(),{digest});assert.equal(r.kind,'ready');assert.equal(r.changes[0].value.unit,'');assert.equal(r.changes[0].value.archived,false);assert.deepEqual(c,original);assert.notEqual(hash(r.changes[0].value),hash(c.value));assert(r.states.every(s=>s.digest===digest));
 const adapter=createPreparedAppCommand({command:c,digest,base}),state=adapter.initialState();assert.throws(()=>adapter.advance({...state,digest:'a'.repeat(64)},()=>null),/APP_PREPARATION_STATE_INVALID/);assert.throws(()=>createPreparedAppCommand({command:c,digest,base:{...base,datasetGeneration:'other'}}).advance(state,()=>null),/APP_PREPARATION_STATE_INVALID/);
});

test('genuine command rejections yield an error with no changes, result or app sequence',()=>{
 const tests=[
  [command(undefined,undefined,0,{extra:true}),'COMMAND_INVALID'],
  [command('untrusted/fileId','x'),'ENTITY_KEY_INVALID'],
  [command(undefined,undefined,0,{store:'other'}),'STORE_ID_MISMATCH'],
  [command(undefined,undefined,0,{generation:'other'}),'DATASET_GENERATION_MISMATCH'],
  [command(undefined,undefined,0,{epoch:'old'}),'OPERATION_EPOCH_EXPIRED'],
  [command(undefined,undefined,1),'ENTITY_VERSION_CONFLICT'],
  [command(undefined,null,0,{deleted:true}),'ENTITY_MISSING'],
  [command(undefined,'99:99'),'VALIDATION_FAILED'],
  [command('habitLog:absent:2026-10-07',true),'HABIT_MISSING']
 ];
 for(const [c,error]of tests){const r=run(c);assert.equal(r.kind,'rejected',error);assert.equal(r.error,error);assert.equal(r.changes,undefined);assert.equal(r.result,undefined);}
});

test('tombstone, habit immutability and parent type failures are explicit terminal errors',()=>{
 const rows=records(),key='wake:2026-10-07';rows.set('app/data/'+key,entity('app/data/'+key,null,3,true));
 assert.equal(run(command(key,'08:00',3),rows).error,'ENTITY_TOMBSTONED');assert.equal(run(command(key,null,3,{deleted:true}),rows).error,'ENTITY_MISSING');assert.equal(run(command(key,'08:00',3,{recreate:true}),rows).kind,'ready');
 rows.set('app/data/habit:walk',entity('app/data/habit:walk',{...habit,unit:'',archived:false}));assert.equal(run(command('habit:walk',null,1,{deleted:true}),rows).error,'ENTITY_DELETE_FORBIDDEN');assert.equal(run(command('habit:walk',{...habit,type:'number'},1),rows).error,'HABIT_TYPE_IMMUTABLE');assert.equal(run(command('habitLog:walk:2026-10-07',3),rows).error,'VALIDATION_FAILED');
});

test('corrupt committed entities, catalog, parents and journal fail closed rather than terminal conflict',()=>{
 const cases=[
  ['app/data/wake:2026-10-07',{key:'wrong',version:1,deleted:false,value:'08:00'},command(),/APP_ENTITY_CORRUPT/],
  ['app/catalog/wake:2026-10-07',entity('app/catalog/wake:2026-10-07',{key:'wake:2026-10-07',next:null}),command(),/CATALOG_CORRUPT/],
  ['app/catalog/head',entity('app/catalog/head',{first:'arbitrary/file'}),command(),/CATALOG_CORRUPT/],
  ['app/catalog/head',entity('app/catalog/head',{first:'wake:2026-10-07'}),command(),/CATALOG_CORRUPT/],
  ['app/data/habit:walk',entity('app/data/habit:walk',{...habit,type:'invalid'}),command('habitLog:walk:2026-10-07',true),/APP_ENTITY_CORRUPT/],
  [SYNC_APP_CHANGE_HEAD,null,command(),/APP_JOURNAL_CORRUPT/],
  [SYNC_APP_CHANGE_HEAD,entity(SYNC_APP_CHANGE_HEAD,{...initialSyncAppChangeHead(),floor:0}),command(),/APP_JOURNAL_CORRUPT/],
  [syncAppChangeSlot(1),entity(syncAppChangeSlot(1),{seq:1,key:'wake:2026-10-01',version:1,deleted:false}),command(),/APP_JOURNAL_CORRUPT/]
 ];
 for(const[key,value,c,error]of cases){const rows=records();if(value===null)rows.delete(key);else rows.set(key,value);assert.throws(()=>run(c,rows),error);}
});

test('journal wrap requires the exact preceding absolute event and validates its business key',()=>{
 const seq=SYNC_APP_CHANGE_CAPACITY+1,rows=records(),key=syncAppChangeSlot(seq);rows.set(SYNC_APP_CHANGE_HEAD,entity(SYNC_APP_CHANGE_HEAD,{protocol:2,seq:seq-1,floor:1,capacity:SYNC_APP_CHANGE_CAPACITY},seq));
 assert.throws(()=>run(command(),rows),/APP_JOURNAL_CORRUPT/);rows.set(key,entity(key,{seq:1,key:'wake:2026-10-01',version:3,deleted:true}));const r=run(command(),rows);assert.equal(r.kind,'ready');assert.equal(r.result.appSeq,seq);assert.equal(r.changes.at(-1).value.floor,2);assert.equal(r.changes.at(-2).expectedVersion,1);
 for(const patch of [{seq:2},{key:'file/foreign'},{version:0},{deleted:1}]){rows.set(key,entity(key,{seq:1,key:'wake:2026-10-01',version:3,deleted:true,...patch}));assert.throws(()=>run(command(),rows),/APP_JOURNAL_CORRUPT/);}
});

test('forged phase combinations and command-independent habit-log values cannot enter a ready state',()=>{
 const c=command(),adapter=createPreparedAppCommand({command:c,digest:hash(c),base}),initial=adapter.initialState();
 for(const patch of [{phase:'parent'},{phase:'ready'},{business:{exists:true,version:0}},{catalog:{nodeChecked:true,headVersion:0,first:null}},{journal:{headVersion:1,seq:1,slotVersion:null}},{extra:true},{logValue:true}])assert.throws(()=>adapter.advance({...initial,...patch},()=>null),/APP_PREPARATION_STATE_INVALID/);
 const rows=records();rows.set('app/data/habit:walk',entity('app/data/habit:walk',{...habit,unit:'',archived:false}));const log=command('habitLog:walk:2026-10-07',true),r=run(log,rows),a=createPreparedAppCommand({command:log,digest:hash(log),base});assert.throws(()=>a.advance({...r.states.at(-1),logValue:false},()=>null),/APP_PREPARATION_STATE_INVALID/);
});

test('domain route uses only explicitly paired preparation and preserves exact original command/digest',()=>{
 for(const paired of [false,true]){const c=command();let prepares=0,transacts=0,reads=0;const writer={recoveryBarrier(){},getReceipt(){assert.equal(paired,false,'prepared engine owns the receipt lookup');return null;},status(){return {...base,...(paired?{nextPreparationId:'pinned_id'}:{})};},getEntity(key){reads++;return records().get(key)??null;},prepareAppCommand(input,digest){prepares++;assert.deepEqual(input,c);assert.equal(digest,hash(c));return {result:{key:c.key,version:1,deleted:false}};},transact(c){transacts++;return {result:c.result};}};const result=createAppDomain({writer,locked:fn=>fn(),digest:hash}).command(c);assert.equal(result.result.key,c.key);assert.equal(prepares,paired?1:0);assert.equal(transacts,paired?0:1);if(paired)assert.equal(reads,0);}
});

test('terminal rejection receipts replay before current state checks and never become a save acknowledgment',()=>{
 for(const replay of [false,true]){const c=command(),receipt={operationId:c.operationId,epoch:c.epoch,digest:hash(c),revision:4,result:{preparationError:'ENTITY_VERSION_CONFLICT'}};let prepared=0;const writer={recoveryBarrier(){},getReceipt(){return replay?receipt:null;},status(){return replay?{...base,storeId:'later-store',datasetGeneration:'later-generation'}:{...base,nextPreparationId:'pinned_id'};},getEntity(){assert.fail('no full domain lookup');},prepareAppCommand(){prepared++;return receipt;}};const domain=createAppDomain({writer,locked:fn=>fn(),digest:hash});assert.throws(()=>domain.command(c),e=>e.code==='ENTITY_VERSION_CONFLICT');assert.equal(prepared,replay?0:1);if(replay)assert.throws(()=>domain.command({...c,value:'09:00'}),/OP_ID_REUSED/);}
});

test('legacy success receipts remain exact, and malformed preparation errors fail closed',()=>{
 const c=command(),receipt={operationId:c.operationId,digest:hash(c),result:{key:c.key,version:1,deleted:false}},writer={recoveryBarrier(){},getReceipt(){return receipt;},status(){return {...base,storeId:'later-store',datasetGeneration:'later-generation'};}};const domain=createAppDomain({writer,locked:fn=>fn(),digest:hash});assert.equal(domain.command(c),receipt);
 for(const value of [{preparationError:'invalid text'},{preparationError:'ENTITY_VERSION_CONFLICT',appSeq:1},{preparationError:3}]){receipt.result=value;assert.throws(()=>domain.command(c),/APP_RECEIPT_INVALID/);}
});

test('numeric operation and epoch inputs never pass strict domain admission',()=>{
 for(const patch of [{operationId:1234567890123456},{epoch:123}]){
  const c=command(undefined,undefined,0,patch),r=run(c);assert.equal(r.kind,'rejected');assert.equal(r.error,'COMMAND_INVALID');assert.equal(r.lookups.length,0);
  const writer={recoveryBarrier(){assert.fail('invalid envelope must be rejected before any storage access');}};assert.throws(()=>createAppDomain({writer,locked:fn=>fn(),digest:hash}).command(c),/COMMAND_INVALID/);
 }
});

test('adapter copies its command/base binding and refuses impossible version advancement',()=>{
 const c=command(),b=copy(base),a=createPreparedAppCommand({command:c,digest:hash(c),base:b});c.value='99:99';b.acceptedEpochs[0]='other';let state=a.initialState(),result;
 for(let i=0;i<12;i++){result=a.advance(state,key=>copy(records().get(key)??null));if(result.kind!=='progress')break;state=result.state;}
 assert.equal(result.kind,'ready');assert.equal(result.changes[0].value,'07:00');
 const rows=records(),key='app/data/wake:2026-10-07';rows.set(key,entity(key,'07:00',Number.MAX_SAFE_INTEGER));assert.throws(()=>run(command('wake:2026-10-07','08:00',Number.MAX_SAFE_INTEGER),rows),/APP_ENTITY_VERSION_EXHAUSTED/);
 rows.delete(key);rows.set(SYNC_APP_CHANGE_HEAD,entity(SYNC_APP_CHANGE_HEAD,{protocol:2,seq:Number.MAX_SAFE_INTEGER,floor:Number.MAX_SAFE_INTEGER-SYNC_APP_CHANGE_CAPACITY+1,capacity:SYNC_APP_CHANGE_CAPACITY}));assert.throws(()=>run(command(),rows),/APP_SEQUENCE_EXHAUSTED/);
});

test('normalization growth beyond the admitted value size is a terminal rejection before catalog or COW work',()=>{
 const value={id:'r',date:'2026-10-07',distanceKm:1,durationSec:60,points:Array.from({length:5000},()=>({lat:0,lon:0}))},c=command('run:r',value);
 assert(Buffer.byteLength(canonical(value))<120000);const result=run(c);assert.equal(result.kind,'rejected');assert.equal(result.error,'WRITER_VALUE_TOO_LARGE');assert.deepEqual(result.lookups,['app/data/run:r']);assert.equal(result.changes,undefined);assert.equal(result.result,undefined);
});
