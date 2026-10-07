import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {ReservedSlotWriter,writerDigest,WRITER_ROLES} from './reserved-writer.mjs';
import {encodeUtf8,decodeUtf8} from './codec.mjs';

// The fault harness models remote immutable Drive bytes; a new writer instance
// gets no authoritative JS maps/state from its predecessor. It does not claim
// this model establishes Google's live atomicity or consistency guarantees.
function fixture(options={}) {
  const files=new Map(),calls=[],faults={};let counter=0,held=true,scriptId='script';
  const io={
    getScriptId:()=>scriptId,assertLockHeld:()=>held,
    allocateIds:n=>Array.from({length:n},()=>`file_${++counter}`),
    readFile(id,maxBytes){calls.push(['read',id]);if(faults.read)return faults.read(id,maxBytes,()=>read(id,maxBytes));return read(id,maxBytes);},
    createFile(id,bytes,role){calls.push(['create',id,role]);assert.ok(WRITER_ROLES.includes(role));if(faults.create)return faults.create(id,bytes,role,()=>create(id,bytes));return create(id,bytes);}
  };
  function read(id,max){const f=files.get(id);if(!f)return null;assert.ok(f.length<=max);return Uint8Array.from(f);}
  function create(id,bytes){if(files.has(id)){const e=new Error('409');e.status=409;throw e;}files.set(id,Uint8Array.from(bytes));return {id};}
  const config={io,anchorId:'anchor',storeId:'store',writerScriptId:'script',clock:()=>`2026-10-06T15:00:00.000Z`,...options};
  const fresh=()=>new ReservedSlotWriter(config),writer=fresh();
  return {io,files,calls,faults,config,fresh,writer,setHeld:v=>held=v,setScript:v=>scriptId=v};
}
function command(id,changes=[],extra={}) {return {operationId:id,epoch:'default',digest:writerDigest({id,changes,...extra}),changes,...extra};}
function put(id,key,value,version=0,extra={}) {return command(id,[{key,expectedVersion:version,value}],extra);}
function objects(f,kind){return [...f.files].map(([id,b])=>({id,...JSON.parse(decodeUtf8(b))})).filter(x=>x.kind===kind);}
function reseal(f,id,mutate){const value=JSON.parse(decodeUtf8(f.files.get(id)));mutate(value);const {hash,...body}=value;value.hash=writerDigest(body);f.files.set(id,encodeUtf8(JSON.stringify(sort(value))));}
function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));return v;}
function bootstrap(f){f.writer.bootstrap();return f;}

test('fixed bootstrap binds store, actual script and caller-owned lock',()=>{
  const f=fixture();assert.throws(()=>f.writer.recoveryBarrier(),/MISSING_REFERENCE/);f.writer.bootstrap();
  const old=f.files.get('anchor');f.fresh().bootstrap();assert.deepEqual(f.files.get('anchor'),old);
  f.setHeld(false);assert.throws(()=>f.writer.get('x'),/LOCK_REQUIRED/);f.setHeld(true);
  f.setScript('clone');assert.throws(()=>f.fresh().recoveryBarrier(),/SCRIPT_MISMATCH/);
  f.setScript('script');assert.throws(()=>new ReservedSlotWriter({...f.config,storeId:'else'}).recoveryBarrier(),/IDENTITY_INVALID/);
  assert.throws(()=>f.fresh().bootstrap({datasetGeneration:'2'}),/BOOTSTRAP_MISMATCH/);
});

test('atomic versioned batch, fresh-process recovery, original receipt before stale preconditions',()=>{
  const f=bootstrap(fixture());const c=command('op1',[{key:'job/a',expectedVersion:0,value:{offset:12}},{key:'pin/a',expectedVersion:0,value:{active:true}}],{result:{accepted:true}});
  const receipt=f.writer.commit(c);assert.equal(receipt.revision,1);assert.equal(receipt.entityVersions.length,2);
  const restarted=f.fresh();restarted.recoveryBarrier();assert.equal(restarted.get('job/a').value.offset,12);
  assert.deepEqual(restarted.transact(c),receipt);assert.equal(objects(f,'frame').length,1);
  assert.throws(()=>restarted.transact({...c,digest:'b'.repeat(64)}),/OP_ID_REUSED/);
  assert.throws(()=>restarted.transact(put('op2','job/a',{},0)),/VERSION_CONFLICT/);
  assert.equal(objects(f,'frame').length,1);
});

test('receipt-only commits and prior receipts survive independent checkpoint shards',()=>{
  const f=bootstrap(fixture());const c=put('old','diary/one',{text:'hello'});const r=f.writer.transact(c);
  f.writer.transact(command('empty',[],{result:{alreadyKnown:true}}));f.writer.checkpoint(command('cp'));
  const oldFrames=objects(f,'frame').filter(x=>x.payload.revision<=2);for(const file of oldFrames)f.files.delete(file.id);
  const w=f.fresh();w.recoveryBarrier();assert.deepEqual(w.getReceipt('old'),r);assert.deepEqual(w.transact(c),r);assert.equal(w.get('diary/one').value.text,'hello');
  w.recoveryBarrier({minimumAcknowledged:{revision:r.revision,hash:r.frameHash}});
  assert.throws(()=>w.recoveryBarrier({minimumAcknowledged:{revision:r.revision,hash:'f'.repeat(64)}}),/ACKNOWLEDGEMENT_UNPROVEN/);
});

test('tombstone versions survive checkpoints and prohibit ordinary resurrection',()=>{
  const f=bootstrap(fixture());f.writer.commit(put('create','day',1));
  f.writer.commit(command('delete',[{key:'day',expectedVersion:1,deleted:true}]));f.writer.checkpoint(command('cp'));
  const w=f.fresh();w.recoveryBarrier();assert.deepEqual(w.get('day'),{key:'day',version:2,deleted:true,value:null});
  assert.throws(()=>w.commit(put('stale','day',2)),/VERSION_CONFLICT/);
  assert.throws(()=>w.commit(put('unasked','day',2,2)),/TOMBSTONED/);
  const r=w.commit(command('recreate',[{key:'day',expectedVersion:2,value:2,recreate:true}]));assert.equal(r.entityVersions[0].version,3);
});

test('committed create followed by timeout adopts the read-back receipt exactly once',()=>{
  const f=bootstrap(fixture());f.faults.create=(id,bytes,role,write)=>{write();throw Error('timeout after write');};
  const c=put('ambiguous','job',1),r=f.writer.commit(c);delete f.faults.create;
  assert.deepEqual(f.fresh().commit(c),r);assert.equal(objects(f,'frame').length,1);
});

test('same-ID retry keeps exact proposal bytes after verified absent read',()=>{
  const f=bootstrap(fixture());const attempts=[];let first=true;
  f.faults.create=(id,bytes,role,write)=>{if(role==='frame'){attempts.push([id,Buffer.from(bytes)]);if(first){first=false;throw Error('timeout before write');}}return write();};
  f.writer.commit(put('op','x',1));assert.equal(attempts.length,2);assert.equal(attempts[0][0],attempts[1][0]);assert.deepEqual(attempts[0][1],attempts[1][1]);
});

test('process death after committed frame before read-back recovers without another mutation',()=>{
  const f=bootstrap(fixture());let frameId;
  f.faults.create=(id,bytes,role,write)=>{const r=write();if(role==='frame')frameId=id;return r;};
  f.faults.read=(id,max,read)=>{if(id===frameId)throw Error('execution ended');return read();};
  const c=put('dead','x',1);assert.throws(()=>f.writer.commit(c),/execution ended/);delete f.faults.read;delete f.faults.create;
  const r=f.fresh().commit(c);assert.equal(r.revision,1);assert.equal(objects(f,'frame').length,1);
});

test('same operation older valid proposal wins original timestamp and successor',()=>{
  const f=bootstrap(fixture()),c=put('same','x',1);let captured;
  f.faults.create=(id,bytes,role,write)=>{if(role==='frame'){captured={id,bytes:Uint8Array.from(bytes)};throw Error('timed out');}return write();};
  assert.throws(()=>f.writer.commit(c),/COMMIT_UNRESOLVED/);delete f.faults.create;
  const newer=new ReservedSlotWriter({...f.config,clock:()=>`2026-10-07T00:00:00.000Z`});
  f.faults.create=(id,bytes,role,write)=>{if(role==='frame'){assert.equal(id,captured.id);f.files.set(id,captured.bytes);throw Error('409 delayed original won');}return write();};
  const r=newer.commit(c);assert.equal(r.committedAt,'2026-10-06T15:00:00.000Z');assert.equal(objects(f,'frame').length,1);
});

test('different operation winning reserved slot is recovered before version re-evaluation',()=>{
  const f=bootstrap(fixture());let captured;
  f.faults.create=(id,bytes,role,write)=>{if(role==='frame'){captured={id,bytes:Uint8Array.from(bytes)};throw Error('unresolved');}return write();};
  assert.throws(()=>f.writer.commit(put('first','same',1)),/COMMIT_UNRESOLVED/);delete f.faults.create;
  let once=true;f.faults.create=(id,bytes,role,write)=>{if(role==='frame'&&once){once=false;f.files.set(captured.id,captured.bytes);throw Error('409 winner');}return write();};
  assert.throws(()=>f.fresh().commit(put('second','same',2)),/VERSION_CONFLICT/);
  const w=f.fresh();w.recoveryBarrier();assert.equal(w.get('same').value,1);assert.equal(w.getReceipt('second'),null);
});

test('different unrelated operation winner permits reassessed independent command',()=>{
  const f=bootstrap(fixture());let captured;
  f.faults.create=(id,bytes,role,write)=>{if(role==='frame'){captured={id,bytes:Uint8Array.from(bytes)};throw Error('unresolved');}return write();};
  assert.throws(()=>f.writer.commit(put('one','a',1)),/COMMIT_UNRESOLVED/);delete f.faults.create;
  let once=true;f.faults.create=(id,bytes,role,write)=>{if(role==='frame'&&once){once=false;f.files.set(captured.id,captured.bytes);throw Error('409 winner');}return write();};
  const r=f.fresh().commit(put('two','b',2));assert.equal(r.revision,2);
});

test('checkpoint-index publication is mandatory barrier and recovered at fixed link ID',()=>{
  const f=bootstrap(fixture());f.writer.commit(put('one','a',1));const indexId=f.writer.status().nextIndexId;
  f.faults.create=(id,bytes,role,write)=>{if(role==='checkpoint-index')throw Error('quota');return write();};
  assert.throws(()=>f.writer.checkpoint(command('cp')),/CREATE_UNRESOLVED/);
  const before=objects(f,'frame').length;assert.throws(()=>f.fresh().commit(put('two','b',2)),/CREATE_UNRESOLVED/);assert.equal(objects(f,'frame').length,before);
  delete f.faults.create;const w=f.fresh();w.recoveryBarrier();assert.ok(f.files.has(indexId));assert.equal(w.getReceipt('cp').revision,2);assert.equal(w.commit(put('two','b',2)).revision,3);
});

test('index traversal never opens retired older manifests or operation bodies',()=>{
  const f=bootstrap(fixture());f.writer.commit(put('one','a',1));f.writer.checkpoint(command('cp1'));f.writer.commit(put('two','a',2,1));f.writer.checkpoint(command('cp2'));const newest=f.writer.status().checkpoint;
  for(const o of objects(f,'checkpoint-manifest'))if(o.id!==newest.manifestRef.id)f.files.delete(o.id);
  for(const o of objects(f,'frame'))if(o.payload.revision<=newest.cut.revision)f.files.delete(o.id);
  const w=f.fresh();w.recoveryBarrier();assert.equal(w.get('a').value,2);assert.equal(w.getReceipt('one').revision,1);assert.equal(w.getReceipt('cp1').revision,2);
});

test('missing current publication body and shard fail closed',()=>{
  const f=bootstrap(fixture());f.writer.commit(put('one','a',1));f.writer.checkpoint(command('cp'));const last=objects(f,'frame').find(x=>x.payload.revision===2);f.files.delete(last.id);
  assert.throws(()=>f.fresh().recoveryBarrier(),/MISSING_PUBLICATION_FRAME/);
  const g=bootstrap(fixture());g.writer.commit(put('one','a',1));const root=g.writer.status().stateRoot;g.files.delete(root.id);
  assert.throws(()=>g.fresh().recoveryBarrier(),/MISSING_REFERENCE/);
});

test('permission/quota read error never means an empty store or free tail',()=>{
  const f=bootstrap(fixture());const tail=f.writer.status().nextSlotId;
  f.faults.read=(id,max,read)=>{if(id===tail)throw Error('403 forbidden');return read();};
  assert.throws(()=>f.writer.commit(put('op','a',1)),/403 forbidden/);assert.equal(objects(f,'frame').length,0);assert.throws(()=>f.writer.get('a'),/RECOVERY_REQUIRED/);
});

test('partial occupied file, wrong parent, corrupted hash and unknown fields quarantine',()=>{
  for(const mode of ['partial','hash','parent','unknown']){
    const f=bootstrap(fixture());f.writer.commit(put('one','x',1));const frame=objects(f,'frame')[0];
    if(mode==='partial')f.files.set(frame.id,encodeUtf8('{'));
    if(mode==='hash'){const bytes=f.files.get(frame.id);bytes[20]^=1;}
    if(mode==='parent')reseal(f,frame.id,x=>{x.payload.parent.id='unrelated';});
    if(mode==='unknown')reseal(f,frame.id,x=>{x.payload.surprise=true;});
    assert.throws(()=>f.fresh().commit(put('two','y',2)),/WRITER_/);assert.equal(objectsSafe(f,'frame'),1);
  }
});
function objectsSafe(f,kind){return [...f.files.values()].filter(b=>{try{return JSON.parse(decodeUtf8(b)).kind===kind;}catch{return kind==='frame';}}).length;}

test('epoch retirement is ordered; known original receipt precedes OP_EXPIRED',()=>{
  const f=bootstrap(fixture());const c=put('old','a',1),r=f.writer.commit(c);
  f.writer.advanceEpochs(command('fence'),['next']);assert.deepEqual(f.writer.commit(c),r);
  assert.throws(()=>f.writer.commit(put('expired','b',2)),/OP_EXPIRED/);
  assert.equal(f.writer.commit({...put('new','b',2),epoch:'next'}).revision,3);
});

test('references require explicit verifier and validation runs before frame creation',()=>{
  const f=bootstrap(fixture());assert.throws(()=>f.writer.commit(put('op','a',1,0,{references:[{fileId:'asset'}]})),/REFERENCES_UNVERIFIED/);assert.equal(objects(f,'frame').length,0);
  const seen=[],g=bootstrap(fixture({verifyReferences:(refs,ctx)=>{seen.push(ctx.phase);return refs[0].fileId==='asset';}}));g.writer.commit(put('ok','a',1,0,{references:[{fileId:'asset'}]}));g.fresh().recoveryBarrier();assert.deepEqual(seen,['proposal','readback','recovery']);
});

test('bounded radix shards scale independently and automatic checkpoints bound replay',()=>{
  const f=bootstrap(fixture({limits:{checkpointEvery:12,maxReplayFrames:32,maxLeafEntries:4,maxCachedNodes:5}}));
  for(let i=0;i<45;i++)f.writer.commit(put('op_'+i,'entity/'+i,{n:i}));
  const w=f.fresh();const s=w.recoveryBarrier();assert.ok(s.replayFrames<14);assert.ok(objects(f,'checkpoint-index').length>=3);
  for(let i=0;i<45;i++)assert.equal(w.get('entity/'+i).value.n,i);
  const nodes=objects(f,'index-node');assert.ok(nodes.every(n=>n.payload.type!=='leaf'||n.payload.entries.length<=4));assert.ok(nodes.every(n=>f.files.get(n.id).length<=256*1024));
  assert.ok(Math.max(...nodes.map(n=>n.payload.depth))<8);assert.ok(w._cache.size<=5);
});

test('bounded individual values reject before any frame; duplicate entity changes reject',()=>{
  const f=bootstrap(fixture());assert.throws(()=>f.writer.commit(put('huge','x','x'.repeat(128*1024+1))),/VALUE_TOO_LARGE/);
  assert.throws(()=>f.writer.commit(command('dup',[{key:'x',expectedVersion:0,value:1},{key:'x',expectedVersion:0,value:2}])),/CHANGE_INVALID/);assert.equal(objects(f,'frame').length,0);
});

test('same UUID changing insertion order has stable canonical hash',()=>{assert.equal(writerDigest({a:1,b:2}),writerDigest({b:2,a:1}));assert.throws(()=>writerDigest({x:undefined}),/VALUE_INVALID/);assert.throws(()=>writerDigest([,1]),/VALUE_INVALID/);});

test('portable implementation runs without Node, Buffer or WebCrypto globals',()=>{
  const codec=fs.readFileSync(new URL('./codec.mjs',import.meta.url),'utf8').replace(/\bexport\s+(?=(?:function|class|const)\b)/g,'');
  const writer=fs.readFileSync(new URL('./reserved-writer.mjs',import.meta.url),'utf8').replace(/import[^\n]+\n/g,'').replace(/\bexport\s+(?=(?:function|class|const)\b)/g,'');
  const context=vm.createContext({});vm.runInContext(codec+'\n'+writer+'\nthis.digest=writerDigest({a:1});',context);assert.equal(context.digest,writerDigest({a:1}));
});


test('a forged root cannot discard an unrelated entity or earlier receipt',()=>{
  for(const tree of ['entities','receipts']) {
    const f=bootstrap(fixture());f.writer.commit(put('a','a',1));f.writer.commit(put('b','b',2));f.writer.commit(put('c','c',3));
    const head=objects(f,'frame').find(x=>x.payload.revision===3),field=tree==='entities'?'stateRoot':'receiptRoot';
    const nodeId=head.payload[field].id;
    reseal(f,nodeId,x=>{x.payload.entries=x.payload.entries.filter(e=>tree==='entities'?e.key!=='a':e.key!==JSON.stringify(['default','a']));});
    const node=JSON.parse(decodeUtf8(f.files.get(nodeId)));
    reseal(f,head.id,x=>{x.payload[field].hash=node.hash;});
    assert.throws(()=>f.fresh().recoveryBarrier(),/INDEX_TRANSITION_INVALID/);
  }
});

test('a corrupt checkpoint cut cannot skip intervening edits',()=>{
  const f=bootstrap(fixture());f.writer.commit(put('one','a',1));f.writer.commit(put('two','b',2));
  f.faults.create=(id,b,role,write)=>{if(role==='checkpoint-index')throw Error('stop index');return write();};
  assert.throws(()=>f.writer.checkpoint(command('cp')),/CREATE_UNRESOLVED/);delete f.faults.create;
  const cp=objects(f,'frame').find(x=>x.payload.checkpoint);reseal(f,cp.id,x=>{x.payload.checkpoint.cut.revision=1;});
  assert.throws(()=>f.fresh().recoveryBarrier(),/CHECKPOINT_CUT_MISMATCH/);
});

test('invalid clock is rejected before occupying a commit slot',()=>{
  const f=bootstrap(fixture({clock:()=>''}));assert.throws(()=>f.writer.commit(put('one','a',1)),/CLOCK_INVALID/);assert.equal(objects(f,'frame').length,0);
});

test('barrier recovery failure clears even previously loaded record state',()=>{
  const f=bootstrap(fixture());f.writer.commit(put('one','a',1));
  f.faults.create=(id,b,role,write)=>{if(role==='checkpoint-index')throw Error('quota');return write();};
  assert.throws(()=>f.writer.checkpoint(command('cp')),/CREATE_UNRESOLVED/);assert.throws(()=>f.writer.get('a'),/RECOVERY_REQUIRED/);
  assert.throws(()=>f.writer.recoveryBarrier(),/CREATE_UNRESOLVED/);assert.throws(()=>f.writer.get('a'),/RECOVERY_REQUIRED/);
});

test('saved acknowledgement detects deleted latest frame; fresh clients cannot infer the loss',()=>{
  const f=bootstrap(fixture());f.writer.commit(put('old','a',1));const latest=f.writer.commit(put('new','b',2));f.files.delete(latest.frameId);
  const fresh=f.fresh();assert.equal(fresh.recoveryBarrier().revision,1);
  assert.throws(()=>f.fresh().recoveryBarrier({minimumAcknowledged:{revision:latest.revision,hash:latest.frameHash}}),/ACKNOWLEDGEMENT_UNPROVEN/);
});

test('large batch frame preflight does not leave staged files after obvious over-limit input',()=>{
  const f=bootstrap(fixture());const before=f.files.size;
  assert.throws(()=>f.writer.commit(command('oversize',Array.from({length:3},(_,i)=>({key:'large'+i,expectedVersion:0,value:'x'.repeat(100*1024)})))),/FILE_TOO_LARGE/);
  assert.equal(f.files.size,before);
});

function reachableIndexIds(f,...roots){
 const seen=new Set();function visit(ref){if(!ref||seen.has(ref.id))return;seen.add(ref.id);const file=JSON.parse(decodeUtf8(f.files.get(ref.id)));if(file.payload.type==='branch')for(const child of file.payload.children)visit(child.ref);}
 for(const root of roots)visit(root);return seen;
}
test('one multi-entity leaf batch writes one final entity root, not intermediate roots',()=>{
 const f=bootstrap(fixture());const changes=Array.from({length:12},(_,i)=>({key:'batch/'+i,expectedVersion:0,value:i}));f.writer.transact(command('batch',changes));const nodes=objects(f,'index-node');assert.equal(nodes.length,1);assert.equal(nodes[0].payload.entries.length,12);const cold=f.fresh();cold.recoveryBarrier();for(const c of changes)assert.equal(cold.get(c.key).value,c.value);
});
test('paired receipt updates write one final receipt leaf',()=>{
 const f=bootstrap(fixture());const receipt=f.writer.transact(put('first','one',1)),before=objects(f,'index-node').length;f.writer.transact(put('second','two',2));const added=objects(f,'index-node').slice(before);assert.equal(added.length,2);assert.equal(added.filter(n=>n.payload.tree==='receipts').length,1);const cold=f.fresh();cold.recoveryBarrier();assert.deepEqual(cold.getReceipt('first'),receipt);
});
test('branched batches leave no unreachable intermediate copy-on-write nodes',()=>{
 const f=bootstrap(fixture({limits:{maxLeafEntries:2}}));const first=Array.from({length:64},(_,i)=>({key:'item/'+i,expectedVersion:0,value:i}));f.writer.transact(command('initial',first));
 const known=new Set(f.files.keys()),oldRoot=f.writer.status().stateRoot;const changes=first.filter((_,i)=>i%3===0).map(c=>({...c,expectedVersion:1,value:c.value+100}));f.writer.transact(command('batch',changes));const state=f.writer.status(),reachable=reachableIndexIds(f,state.stateRoot,state.receiptRoot);const created=objects(f,'index-node').filter(n=>!known.has(n.id));assert(created.length>1);assert(created.every(n=>reachable.has(n.id)));assert(created.length<changes.length*2);
 const old=JSON.parse(decodeUtf8(f.files.get(oldRoot.id))).payload,next=JSON.parse(decodeUtf8(f.files.get(state.stateRoot.id))).payload;const touched=new Set(changes.map(c=>writerDigest(c.key)[0]));for(const child of old.children)if(!touched.has(child.digit))assert.deepEqual(next.children.find(c=>c.digit===child.digit),child);
 const cold=f.fresh();cold.recoveryBarrier();for(const c of first){const changed=changes.find(v=>v.key===c.key);assert.equal(cold.get(c.key).value,changed?changed.value:c.value);}
});
test('batched create failures never publish a partial entity set',()=>{
 const f=bootstrap(fixture({limits:{maxLeafEntries:2}}));f.writer.transact(put('existing','keep',1));let writes=0;f.faults.create=(id,b,role,write)=>{if(role==='index-node'&&++writes>2)throw Error('interrupted');return write();};
 const changes=Array.from({length:16},(_,i)=>({key:'new/'+i,expectedVersion:0,value:i}));assert.throws(()=>f.writer.transact(command('batch',changes)),/CREATE_UNRESOLVED/);delete f.faults.create;const cold=f.fresh();cold.recoveryBarrier();assert.equal(cold.get('keep').value,1);for(const c of changes)assert.equal(cold.get(c.key),null);cold.transact(command('batch',changes));const final=f.fresh();final.recoveryBarrier();for(const c of changes)assert.equal(final.get(c.key).value,c.value);
});
test('cold randomized multi-key updates preserve versions, tombstones, receipts and checkpoints',()=>{
 const f=bootstrap(fixture({limits:{maxLeafEntries:3,checkpointEvery:8}})),expected=new Map(),receipts=[];let seed=1729;
 for(let batch=0;batch<20;batch++){
  const keys=new Set();while(keys.size<8){seed=(seed*1664525+1013904223)>>>0;keys.add('key/'+seed%40);}
  const changes=[...keys].map(key=>{const previous=expected.get(key),deleted=batch%5===4;return {key,expectedVersion:previous?.version||0,...(deleted&&previous&&!previous.deleted?{deleted:true}:{value:batch,recreate:previous?.deleted?true:undefined})};}).map(c=>Object.fromEntries(Object.entries(c).filter(([,v])=>v!==undefined)));
  const w=f.fresh();const receipt=w.transact(command('batch_'+batch,changes));receipts.push(receipt);for(const c of changes)expected.set(c.key,{key:c.key,version:c.expectedVersion+1,deleted:!!c.deleted,value:c.deleted?null:c.value});
  const cold=f.fresh();cold.recoveryBarrier();for(const [key,value] of expected)assert.deepEqual(cold.get(key),value);for(const r of receipts)assert.deepEqual(cold.getReceipt(r.operationId),r);
 }
});
