import test from 'node:test';
import assert from 'node:assert/strict';
import {ReservedSlotWriter,writerDigest} from './reserved-writer.mjs';
import {createPreparedTransaction} from './prepared-transaction.mjs';

function fixture({maxLeafEntries=4,maxFileBytes=256*1024}={}){
 const files=new Map();let next=0,reads=0;
 const io={getScriptId:()=> 'script',assertLockHeld:()=>true,allocateIds:n=>Array.from({length:n},()=>`seed_${++next}`),readFile:(id,max)=>{const b=files.get(id);if(!b)return null;assert.ok(b.length<=max);return Uint8Array.from(b);},createFile:(id,bytes)=>{if(files.has(id))throw Error('409');files.set(id,Uint8Array.from(bytes));return {id};}};
 const writer=new ReservedSlotWriter({io,anchorId:'anchor',storeId:'store',writerScriptId:'script',limits:{maxLeafEntries,maxFileBytes,maxValueBytes:Math.min(128*1024,maxFileBytes)}});
 const base={readNode:(...args)=>{reads++;return writer._node(...args);},hashValue:writerDigest,hashNode:p=>writer._sealed('index-node',p).hash,nodeFits:p=>{try{writer._bytes(writer._sealed('index-node',p));return true;}catch(e){if(e.code==='WRITER_FILE_TOO_LARGE')return false;throw e;}},maxLeafEntries};
 return {files,writer,base,reads:()=>reads,make:config=>createPreparedTransaction({...base,...config})};
}
const entity=(key,value,version=1)=>({key,value:{key,version,deleted:false,value}});
function run(f,config,{cold=true,crashEachNode=false}={}){
 let machine=f.make(config),state=machine.initialState(),nodes=0,steps=0;const assigned=new Map(),cursors=[];
 while(steps++<20000){
  const before=f.reads(),action=machine.nextRecipe(state);assert.ok(f.reads()-before<=1,'nextRecipe has one old-node read maximum');
  if(action.kind==='done')return {...action,nodes,steps,cursors,assigned};
  if(action.kind==='progress')state=action.state;
  else{
   const key=action.recipe.stateHash;if(!assigned.has(key))assigned.set(key,`planned_${assigned.size+1}`);const id=assigned.get(key);
   const ref=f.writer._createExact(id,'index-node',action.payload);nodes++;
   if(crashEachNode){const again=f.make(config).nextRecipe(JSON.parse(JSON.stringify(state)));assert.deepEqual(again,action);const observed=f.writer._read(id,'index-node',{id,hash:again.recipe.expectedHash});assert.equal(observed.hash,ref.hash);machine=f.make(config);}
   const reads=f.reads();state=machine.completeRecipe(state,action.recipe,ref);assert.ok(f.reads()-reads<=1,'completion recomputes one old-node dependency maximum');
  }
  cursors.push(JSON.parse(JSON.stringify(state)));if(cold){machine=f.make(config);state=JSON.parse(JSON.stringify(state));f.writer._cache.clear();}
 }
 throw Error('planner did not finish');
}

test('resumes every microstep and produces both exact COW transitions',()=>{
 const f=fixture();
 const old=Array.from({length:100},(_,i)=>entity('entity_'+i,{text:'old '+i}));
 const priorReceipts=Array.from({length:80},(_,i)=>({key:'receipt_'+i,value:{operationId:'old_'+i}}));
 const stateRoot=f.writer._putMany(null,'entities',old,'seed_slot'),receiptRoot=f.writer._putMany(null,'receipts',priorReceipts,'seed_slot');
 const stateUpdates=[entity('entity_4',{text:'changed'},2),entity('new_one',{text:'new'}),entity('entity_75',null,2)],receiptUpdates=[{key:'receipt_latest',value:{operationId:'previous'}},{key:'@revision:9',value:{revision:9,hash:'a'.repeat(64)}}];
 const result=run(f,{slotId:'commit_slot',stateRoot,receiptRoot,stateUpdates,receiptUpdates},{crashEachNode:true});
 f.writer._verifyTree(stateRoot,result.stateRoot,'entities',stateUpdates,'commit_slot');
 f.writer._verifyTree(receiptRoot,result.receiptRoot,'receipts',receiptUpdates,'commit_slot');
 assert.equal(result.nodes,result.assigned.size);assert.ok(result.nodes>3);assert.ok(result.steps>result.nodes);
});

test('zero updates preserve both roots without reading or creating nodes',()=>{
 const f=fixture(),stateRoot=f.writer._putMany(null,'entities',[entity('a',1)],'old_slot');const before=f.reads(),files=f.files.size;
 const r=run(f,{slotId:'commit_slot',stateRoot,receiptRoot:null});assert.deepEqual(r.stateRoot,stateRoot);assert.equal(r.receiptRoot,null);assert.equal(r.nodes,0);assert.equal(f.reads(),before);assert.equal(f.files.size,files);
});

test('empty-root split uses descriptor indexes without retaining large values',()=>{
 const f=fixture({maxLeafEntries:2}),large='あ'.repeat(43000);
 const stateUpdates=[entity('large_a',large),entity('large_b',large),entity('small_c','c'),entity('small_d','d')];
 const result=run(f,{slotId:'commit_slot',stateUpdates});f.writer._verifyTree(null,result.stateRoot,'entities',stateUpdates,'commit_slot');
 assert.ok(result.cursors.every(c=>!JSON.stringify(c).includes(large)));assert.ok(result.cursors.every(c=>Buffer.byteLength(JSON.stringify(c))<10000));
});

test('splitting a full old leaf preserves every untouched key after cold restart',()=>{
 const f=fixture({maxLeafEntries:4}),old=Array.from({length:4},(_,i)=>entity('old_'+i,i)),stateRoot=f.writer._putMany(null,'entities',old,'seed_slot'),stateUpdates=[entity('new_key',9),entity('old_1',11,2)];
 const result=run(f,{slotId:'commit_slot',stateRoot,stateUpdates});f.writer._verifyTree(stateRoot,result.stateRoot,'entities',stateUpdates,'commit_slot');
 for(const u of old)assert.ok(f.writer._lookup(result.stateRoot,'entities',u.key));
});

test('planner refuses wrong result hashes, changed recipes and foreign cursors',()=>{
 const f=fixture(),config={slotId:'commit_slot',stateUpdates:[entity('x',1)]},m=f.make(config),state=m.initialState(),a=m.nextRecipe(state);
 assert.equal(a.kind,'node');assert.throws(()=>m.completeRecipe(state,a.recipe,{id:'result',hash:'0'.repeat(64)}),/RESULT_MISMATCH/);
 assert.throws(()=>m.completeRecipe(state,{...a.recipe,expectedHash:'0'.repeat(64)},{id:'result',hash:'0'.repeat(64)}),/RESULT_MISMATCH/);
 assert.throws(()=>f.make({...config,slotId:'other_slot'}).nextRecipe(state),/CURSOR_INVALID/);
 assert.throws(()=>m.nextRecipe({...state,roots:['bad',null]}),/CURSOR_INVALID/);
});

test('immutable old-node corruption is not accepted as planner evidence',()=>{
 const f=fixture(),stateRoot=f.writer._putMany(null,'entities',[entity('x',1)],'seed_slot');
 const m=createPreparedTransaction({...f.base,slotId:'commit_slot',stateRoot,stateUpdates:[entity('x',2,2)],readNode:()=>({tree:'receipts',depth:0,type:'leaf',slotId:'old',entries:[entity('x',1)]})});
 assert.throws(()=>m.nextRecipe(m.initialState()),/OLD_NODE_INVALID/);
});

test('pathological depth is bounded and survives every split frontier',()=>{
 const f=fixture({maxLeafEntries:1});const hashValue=v=>typeof v==='string'&&/^collision_[ab]$/.test(v)?'0'.repeat(63)+(v.endsWith('a')?'a':'b'):writerDigest(v);
 const config={slotId:'commit_slot',stateUpdates:[entity('collision_a',1),entity('collision_b',2)],hashValue};let m=createPreparedTransaction({...f.base,...config}),s=m.initialState(),count=0,maxBytes=0;
 while(count++<1000){const a=m.nextRecipe(s);if(a.kind==='done'){assert.ok(a.stateRoot);assert.equal(a.receiptRoot,null);assert.ok(maxBytes<65536);return;}if(a.kind==='progress')s=a.state;else{s=m.completeRecipe(s,a.recipe,{id:'planned_'+count,hash:a.recipe.expectedHash});}maxBytes=Math.max(maxBytes,Buffer.byteLength(JSON.stringify(s)));s=JSON.parse(JSON.stringify(s));m=createPreparedTransaction({...f.base,...config});}
 assert.fail('deep planner did not finish');
});

test('actual depth-64 collision fails instead of looping or dropping entries',()=>{
 const f=fixture({maxLeafEntries:1}),hashValue=v=>typeof v==='string'&&v.startsWith('collision_')?'0'.repeat(64):writerDigest(v);
 const m=createPreparedTransaction({...f.base,slotId:'commit_slot',stateUpdates:[entity('collision_a',1),entity('collision_b',2)],hashValue});let s=m.initialState();
 assert.throws(()=>{for(let n=0;n<100;n++){const a=m.nextRecipe(s);assert.equal(a.kind,'progress');s=a.state;}},/COLLISION_LIMIT/);
});

test('authenticated assignment completion reuses exact scoped recipe without old-node IO',()=>{
 const f=fixture(),stateRoot=f.writer._putMany(null,'entities',[entity('x',1)],'old_slot'),config={slotId:'commit_slot',stateRoot,stateUpdates:[entity('x',2,2)]},m=f.make(config),state=m.initialState(),a=m.nextRecipe(state),ref={id:'assigned_output',hash:a.recipe.expectedHash};
 assert.equal(a.kind,'node');const before=f.reads(),out=m.completeAuthenticatedRecipe(state,a.recipe,ref);assert.equal(f.reads(),before);assert.deepEqual(out,m.completeRecipe(state,a.recipe,ref));
 for(const [field,value]of Object.entries({binding:'0'.repeat(64),stateHash:'0'.repeat(64),slotId:'other_slot',tree:'receipts',depth:1,expectedHash:'0'.repeat(64),updateIndexes:[],protocol:'other',type:'other'}))assert.throws(()=>m.completeAuthenticatedRecipe(state,{...a.recipe,[field]:value},ref),/RESULT_MISMATCH/);
 assert.throws(()=>f.make({...config,slotId:'other_slot'}).completeAuthenticatedRecipe(state,a.recipe,ref),/CURSOR_INVALID/);
});
