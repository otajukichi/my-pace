import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {ReservedSlotWriter} from '../../storage/reserved-writer.mjs';
import {canonical,validateEntity} from '../../src/lib/entity-codec.js';
import {createAppDomain,APP_CHANGE_HEAD,APP_CHANGE_CAPACITY,appChangeSlot} from '../../gas/app-domain.mjs';
import {createAppSyncV2} from '../../gas/app-sync-v2.mjs';
import {createCursorCodec} from '../../gas/signed-dispatcher.mjs';
const digest=s=>createHash('sha256').update(s).digest('hex');
const cmd=(key,value,expectedVersion=0,patch={})=>({operationId:randomUUID(),epoch:'default',generation:'1',store:'store',key,expectedVersion,deleted:false,value,recreate:false,...patch});
const proof=(revision,hash,patch={})=>({store:'store',generation:'1',revision,hash,...patch});
const request=(patch={})=>({cursor:null,since:null,minimumAcknowledged:null,...patch});
const event=i=>cmd('event:e'+i,{id:'e'+i,date:'2026-10-07',time:null,title:'event '+i,note:''});
function harness({ioPatch={},limits={},activate=true}={}){
 const files=new Map(),stats={reads:0,writes:0},rootReads=[];let counter=0,ms=1_000_000;
 const io={getScriptId:()=> 'script',assertLockHeld:()=>true,getVerifiedReadPhase:()=> 'same-test-lock',allocateIds:n=>Array.from({length:n},()=> 'id_'+(++counter)),readFile:(id,max)=>{stats.reads++;const b=files.get(id);if(b&&b.length>max)throw Error('TOO_LARGE');return b??null;},createFile:(id,bytes)=>{stats.writes++;if(files.has(id))throw Error('409');files.set(id,Uint8Array.from(bytes));return {id};}};
 Object.assign(io,typeof ioPatch==='function'?ioPatch({files,io}):ioPatch);
 const cfg={io,anchorId:'anchor',storeId:'store',writerScriptId:'script',limits:{maxLeafEntries:32,...limits}},writer=new ReservedSlotWriter(cfg);writer.bootstrap();
 const locked=fn=>fn(),domain=w=>createAppDomain({writer:w,locked,digest}),codec=createCursorCodec({secret:'x'.repeat(32),hmac:(s,k)=>createHmac('sha256',k).update(s).digest('base64url'),encode:s=>Buffer.from(s).toString('base64url'),decode:s=>Buffer.from(s,'base64url').toString(),now:()=>ms,ttlMs:86400000,domain:'app-sync-v2'});
 const sync=(w=writer,options={})=>createAppSyncV2({writer:w,locked,...codec,now:()=>ms,...options});
 const activateV2=()=>writer.enableFormatFence({operationId:randomUUID(),epoch:'default',datasetGeneration:'1',digest:digest('explicit test-only v2 activation'),changes:[{key:APP_CHANGE_HEAD,expectedVersion:0,value:{protocol:2,seq:0,floor:1,capacity:APP_CHANGE_CAPACITY}}],result:{incrementalSyncEnabled:true}});
 if(activate)activateV2();
 const original=writer.readEntityAtRoot.bind(writer);writer.readEntityAtRoot=(root,key)=>{rootReads.push(key);return original(root,key);};
 return {files,io,cfg,writer,api:domain(writer),domain,codec,sync,stats,rootReads,activate:activateV2,setTime:n=>{ms=n;},time:()=>ms,fresh:()=>new ReservedSlotWriter(cfg)};
}
function drain(sync,first){const pages=[first];while(pages.at(-1).nextCursor)pages.push(sync.pull(request({cursor:pages.at(-1).nextCursor})));return pages;}

test('unfenced commands stay legacy, explicit fence starts sequence zero, old receipts never add events',()=>{
 const f=harness({activate:false}),c=cmd('wake:2026-10-07','07:00'),receipt=f.api.command(c),before=f.writer.status().revision;
 assert.equal(f.writer.status().writerFence,0);assert.equal(receipt.result.appSeq,undefined);assert.equal(f.writer.getEntity(APP_CHANGE_HEAD),null);
 assert.throws(()=>f.sync().pull(request()),e=>e.code==='SYNC_V2_MIGRATION_REQUIRED'&&e.requiresOwnerAction===true&&!e.retryable);
 assert.equal(f.writer.status().revision,before);assert.equal(f.writer.getEntity(APP_CHANGE_HEAD),null);
 assert.deepEqual(f.api.command(c),receipt);assert.equal(f.writer.status().revision,before);
 f.activate();assert.equal(f.writer.status().writerFence,2);const fenced=f.writer.status().revision;
 assert.deepEqual(f.writer.getEntity(APP_CHANGE_HEAD).value,{protocol:2,seq:0,floor:1,capacity:APP_CHANGE_CAPACITY});
 const page=f.sync().pull(request());assert.equal(page.targetSeq,0);assert.equal(page.throughSeq,0);assert.deepEqual(page.checkpoint,{store:'store',generation:'1',seq:0});assert.equal(page.entries[0].value,'07:00');assert.equal(f.writer.status().revision,fenced);
 assert.deepEqual(f.api.command(c),receipt);assert.equal(f.writer.getEntity(APP_CHANGE_HEAD).value.seq,0);assert.equal(f.writer.status().revision,fenced);
 const next=f.api.command(cmd(c.key,'08:00',1));assert.equal(next.result.appSeq,1);
 const delta=f.sync().pull(request({since:page.checkpoint}));assert.equal(delta.fromSeq,0);assert.equal(delta.throughSeq,1);assert.equal(delta.entries[0].value,'08:00');
 assert.deepEqual(f.api.command(c),receipt);assert.equal(f.writer.getEntity(APP_CHANGE_HEAD).value.seq,1);
});

test('100 commands atomically journal one event each; maintenance and receipt replays do not advance sequence',()=>{
 const f=harness(),commands=[];
 for(let i=0;i<100;i++){const c=cmd('wake:2026-10-07',i%2?'07:00':'08:00',i);commands.push(c);const receipt=f.api.command(c);assert.equal(receipt.result.appSeq,i+1);assert.ok(receipt.entityVersions.some(e=>e.key===appChangeSlot(i+1)));assert.ok(receipt.entityVersions.some(e=>e.key===APP_CHANGE_HEAD));}
 assert.equal(f.writer.getEntity(APP_CHANGE_HEAD).value.seq,100);assert.ok(f.writer.status().revision>100);
 for(const c of [commands[0],commands[49],commands[99]])assert.equal(f.api.command(c).result.appSeq,c.expectedVersion+1);
 const sync=f.sync(),pages=drain(sync,sync.pull(request({since:{store:'store',generation:'1',seq:0}})));
 assert.deepEqual(pages.map(p=>[p.fromSeq,p.throughSeq]),[[0,24],[24,48],[48,72],[72,96],[96,100]]);
 for(const p of pages){assert.equal(p.entries.length,1);assert.equal(p.entries[0].version,100);assert.equal(p.targetSeq,100);}
 assert.equal(pages.at(-1).checkpoint.seq,100);
});

test('snapshot and delta pages keep an immutable cut during concurrent writes, including a cold continuation',()=>{
 const f=harness();for(let i=0;i<130;i++)f.api.command(event(i));
 const sync=f.sync(),snapshot=sync.pull(request()),delta=sync.pull(request({since:{store:'store',generation:'1',seq:0}}));
 assert.equal(snapshot.entries.length,128);assert.equal(snapshot.throughSeq,null);assert.equal(snapshot.checkpoint,null);
 const oldValue=event(0).value;f.api.command(cmd('event:e0',{...oldValue,title:'newer'},1));f.api.command(event(130));
 const cold=f.fresh();cold.recoveryBarrier=()=>{throw Error('CONTINUATION_MUST_NOT_RECOVER');};
 const last=f.sync(cold).pull(request({cursor:snapshot.nextCursor}));assert.equal(last.revision,snapshot.revision);assert.equal(last.headHash,snapshot.headHash);assert.equal(last.entries.length,2);assert.equal([...snapshot.entries,...last.entries].find(e=>e.key==='event:e0').value.title,'event 0');assert.equal(last.throughSeq,130);
 const deltaPages=drain(sync,delta);assert.equal(deltaPages.flatMap(p=>p.entries).length,130);assert.equal(deltaPages.at(-1).throughSeq,130);for(const page of deltaPages)assert.equal(page.targetSeq,130);
 const later=sync.pull(request({since:last.checkpoint}));assert.equal(later.targetSeq,132);assert.deepEqual(new Set(later.entries.map(e=>e.key)),new Set(['event:e0','event:e130']));
});

test('deleted and explicitly recreated records retain monotonic versions in metadata-only deltas',()=>{
 const f=harness(),key='wake:2026-10-07';f.api.command(cmd(key,'07:00'));const baseline=f.sync().pull(request());
 f.api.command(cmd(key,null,1,{deleted:true}));const deleted=f.sync().pull(request({since:baseline.checkpoint}));assert.deepEqual(deleted.entries,[{key,version:2,deleted:true,value:null}]);
 f.api.command(cmd(key,'09:00',2,{recreate:true}));const recreated=f.sync().pull(request({since:baseline.checkpoint}));assert.deepEqual(recreated.entries,[{key,version:3,deleted:false,value:'09:00'}]);assert.equal(recreated.throughSeq,3);
});

test('idle pull reads only app head, no catalog or business entities, and returns a small envelope',()=>{
 const f=harness();for(let i=0;i<30;i++)f.api.command(event(i));const s=f.sync().pull(request({since:{store:'store',generation:'1',seq:30}}));
 f.rootReads.length=0;const reads=f.stats.reads,writes=f.stats.writes;
 const idle=f.sync().pull(request({since:s.checkpoint}));assert.deepEqual(f.rootReads,[APP_CHANGE_HEAD]);assert.deepEqual(idle.entries,[]);assert.equal(idle.nextCursor,null);assert.equal(idle.throughSeq,30);assert.ok(Buffer.byteLength(JSON.stringify(idle))<600);assert.ok(f.stats.reads-reads<10);assert.equal(f.stats.writes,writes);
});

test('strict payloads and foreign, import, malformed, tampered and expired cursors fail closed',()=>{
 const f=harness();for(let i=0;i<129;i++)f.api.command(event(i));const sync=f.sync(),first=sync.pull(request()),token=first.nextCursor,value=f.codec.openCursor(token);
 for(const p of [{},request({unexpected:true}),request({cursor:token,since:{store:'store',generation:'1',seq:0}}),request({minimumAcknowledged:{revision:1,hash:'bad'}})])assert.throws(()=>sync.pull(p),/SYNC_PAYLOAD_INVALID/);
 for(const t of ['x',token.slice(0,-1)+'!',f.codec.sealCursor({kind:'imports',revision:first.revision,jobId:'job'}),f.codec.sealCursor({...value,protocol:1})])assert.throws(()=>sync.pull(request({cursor:t})),/SYNC_CURSOR_INVALID/);
 for(const view of [{...value.view,storeId:'foreign'},{...value.view,writerScriptId:'other'},{...value.view,schemaVersion:4},{...value.view,datasetGeneration:'other'}])assert.throws(()=>sync.pull(request({cursor:f.codec.sealCursor({...value,view})})),e=>e.code==='RESET_REQUIRED'&&e.resetReason==='identity-changed');
 f.setTime(value.expiresAt);assert.throws(()=>sync.pull(request({cursor:token})),e=>e.code==='RESET_REQUIRED'&&e.resetReason==='cursor-expired');
 for(const since of [{store:'other',generation:'1',seq:0},{store:'store',generation:'2',seq:0}])assert.throws(()=>sync.pull(request({since})),e=>e.code==='RESET_REQUIRED'&&e.resetReason==='identity-changed');
 assert.throws(()=>sync.pull(request({since:{store:'store',generation:'1',seq:130}})),/SYNC_CHECKPOINT_AHEAD/);
});

test('continuations retain original absolute expiry rather than refreshing the frozen root lease',()=>{
 const f=harness();for(let i=0;i<260;i++)f.api.command(event(i));const sync=f.sync(),first=sync.pull(request()),original=f.codec.openCursor(first.nextCursor);
 f.setTime(f.time()+1000);const second=sync.pull(request({cursor:first.nextCursor})),renewed=f.codec.openCursor(second.nextCursor);assert.equal(renewed.issuedAt,original.issuedAt);assert.equal(renewed.expiresAt,original.expiresAt);
 // Re-sealing the outer codec cannot extend the inner absolute expiry.
 f.setTime(original.expiresAt);assert.throws(()=>f.codec.sealCursor(renewed),/CURSOR_EXPIRED/);
 assert.throws(()=>sync.pull(request({cursor:second.nextCursor})),e=>e.code==='RESET_REQUIRED'&&e.resetReason==='cursor-expired');
});

test('minimum acknowledgement proof is enforced on initial and frozen reads, including newly supplied older proofs',()=>{
 const f=harness();let oldest;for(let i=0;i<129;i++){const r=f.api.command(event(i));if(i===0)oldest=r;}
 const sync=f.sync(),first=sync.pull(request()),latest=f.api.command(event(129));
 assert.throws(()=>sync.pull(request({cursor:first.nextCursor,minimumAcknowledged:proof(latest.revision,latest.frameHash)})),e=>e.code==='SYNC_CUT_BEHIND'&&e.retryable);
 assert.throws(()=>sync.pull(request({cursor:first.nextCursor,minimumAcknowledged:proof(first.revision,'0'.repeat(64))})),/ACKNOWLEDGEMENT_MISMATCH/);
 assert.throws(()=>sync.pull(request({cursor:first.nextCursor,minimumAcknowledged:proof(oldest.revision,'0'.repeat(64))})),/ACKNOWLEDGEMENT_UNPROVEN/);
 const valid=sync.pull(request({cursor:first.nextCursor,minimumAcknowledged:proof(oldest.revision,oldest.frameHash)}));assert.equal(valid.targetSeq,129);
 const fresh=sync.pull(request({minimumAcknowledged:proof(latest.revision,latest.frameHash)}));assert.ok(fresh.revision>=latest.revision);
 assert.throws(()=>sync.pull(request({minimumAcknowledged:proof(latest.revision+100,latest.frameHash)})),e=>e.code==='SYNC_CUT_BEHIND'&&e.retryable);
});

test('budget yields never emit an unchanged continuation and partial-unit retry does not skip data',()=>{
 const f=harness();for(let i=0;i<4;i++)f.api.command(event(i));let allowed=false;
 const sync=f.sync(f.writer,{canContinue:()=>allowed});assert.throws(()=>sync.pull(request()),e=>e.code==='SYNC_BUDGET_YIELD'&&e.retryable);
 const scan=f.writer.scanEntitiesAtRoot.bind(f.writer);f.writer.scanEntitiesAtRoot=(root,options)=>scan(root,{...options,limit:1,scanLimit:2});
 allowed=true;const first=sync.pull(request()),pages=drain(sync,first);assert.equal(pages.flatMap(p=>p.entries).length,4);assert.ok(pages.length>1);
 f.writer.scanEntitiesAtRoot=scan;
 const original=f.writer.readEntityAtRoot.bind(f.writer);let seen=0;f.writer.readEntityAtRoot=(root,key)=>{if(key.startsWith('app/data/')&&++seen===2)throw Object.assign(Error('STORE_YIELD'),{code:'STORE_YIELD',retryable:true});return original(root,key);};
 const partial=f.sync().pull(request({since:{store:'store',generation:'1',seq:0}}));assert.equal(partial.entries.length,1);f.writer.readEntityAtRoot=original;assert.equal(f.sync().pull(request({cursor:partial.nextCursor})).entries.length,3);
});

test('response admission counts UTF-8 before append and one maximum 128 KiB entity fits',()=>{
 const f=harness();for(let i=1;i<=9;i++)f.api.command(cmd('diary:2026-10-'+String(i).padStart(2,'0'),{text:'😀'.repeat(8000),mood:null}));
 const sync=f.sync(),pages=drain(sync,sync.pull(request()));assert.ok(pages.length>1);assert.equal(pages.flatMap(p=>p.entries).length,9);for(const p of pages)assert.ok(Buffer.byteLength(JSON.stringify(p))<=262144);
 const run={id:'maximum',date:'2026-10-07',distanceKm:1,durationSec:60,note:'',points:[]},point={lat:1,lon:1,segment:0};
 while(Buffer.byteLength(JSON.stringify(run))+JSON.stringify(point).length+1<=131072)run.points.push(point);
 run.note='x'.repeat(131072-Buffer.byteLength(JSON.stringify(run)));assert.equal(Buffer.byteLength(JSON.stringify(validateEntity('run:maximum',run))),131072);
 const fresh=harness();fresh.api.command(cmd('run:maximum',run));const page=fresh.sync().pull(request());assert.equal(page.entries.length,1);assert.equal(page.entries[0].value.note,run.note);assert.ok(Buffer.byteLength(JSON.stringify(page))<262144);
});

test('delayed unrelated winner rebuilds catalog and journal; genuine business conflicts remain conflicts',()=>{
 let mode='normal',captured;
 const f=harness({ioPatch:({files,io})=>{const create=io.createFile;return {createFile:(id,bytes,role)=>{if(role==='frame'&&mode==='capture'){captured={id,bytes:Uint8Array.from(bytes)};throw Error('timeout');}if(role==='frame'&&mode==='publish'){mode='normal';files.set(captured.id,captured.bytes);throw Error('409');}return create(id,bytes,role);}};}});
 const a=event(0),b=event(1);mode='capture';assert.throws(()=>f.domain(f.fresh()).command(a),/WRITER_COMMIT_UNRESOLVED/);mode='publish';const receipt=f.domain(f.fresh()).command(b);assert.equal(receipt.result.appSeq,2);
 assert.equal(f.api.command(a).result.appSeq,1);assert.equal(f.api.command(b).result.appSeq,2);
 assert.throws(()=>f.api.command(cmd(b.key,{...b.value,title:'stale'})),/ENTITY_VERSION_CONFLICT/);
 assert.equal(f.writer.getEntity(APP_CHANGE_HEAD).value.seq,2);
});

test('bounded internal metadata contention is retryable, never a false business conflict',()=>{
 const f=harness(),original=f.writer.transact.bind(f.writer);let tries=0;f.writer.transact=()=>{tries++;throw Object.assign(Error('ENTITY_VERSION_CONFLICT'),{code:'ENTITY_VERSION_CONFLICT'});};
 assert.throws(()=>f.api.command(event(0)),e=>e.code==='DOMAIN_CONTENTION'&&e.retryable);assert.equal(tries,4);f.writer.transact=original;assert.equal(f.api.command(event(0)).result.appSeq,1);
});

test('fixed ring wraps with exactly 1024 active slots; frozen deltas survive current-root overwrites',()=>{
 const f=harness(),key='wake:2026-10-07';for(let i=0;i<30;i++)f.api.command(cmd(key,i%2?'07:00':'08:00',i));
 const sync=f.sync(),old=sync.pull(request({since:{store:'store',generation:'1',seq:0}}));assert.equal(old.throughSeq,24);assert.equal(old.entries[0].version,30);
 for(let i=30;i<1060;i++)f.api.command(cmd(key,i%2?'07:00':'08:00',i));
 const head=f.writer.getEntity(APP_CHANGE_HEAD).value;assert.deepEqual(head,{protocol:2,seq:1060,floor:37,capacity:APP_CHANGE_CAPACITY});
 for(let slot=0;slot<APP_CHANGE_CAPACITY;slot++){const e=f.writer.getEntity('app/change-slot/'+slot);assert.ok(e);assert.equal(e.value.seq%APP_CHANGE_CAPACITY,slot);assert.ok(e.value.seq>=37&&e.value.seq<=1060);}
 assert.equal(f.writer.getEntity('app/change-slot/1024'),null);assert.equal(f.writer.getEntity(appChangeSlot(1025)).value.seq,1025);
 assert.throws(()=>sync.pull(request({since:{store:'store',generation:'1',seq:35}})),e=>e.code==='RESET_REQUIRED'&&e.resetReason==='retention-floor');
 const boundary=sync.pull(request({since:{store:'store',generation:'1',seq:36}}));assert.equal(boundary.fromSeq,36);assert.equal(boundary.throughSeq,60);
 const frozen=sync.pull(request({cursor:old.nextCursor}));assert.equal(frozen.targetSeq,30);assert.equal(frozen.entries[0].version,30);assert.equal(frozen.throughSeq,30);
 // A reused ring slot must match the requested absolute sequence. A plausible
 // key/value is insufficient, and cannot turn a missing event into no changes.
 const slot=f.writer.getEntity(appChangeSlot(1025));f.writer.transact({operationId:randomUUID(),epoch:'default',digest:digest('fault:wrong-absolute-seq'),changes:[{key:slot.key,expectedVersion:slot.version,value:{...slot.value,seq:1}}]});
 assert.throws(()=>sync.pull(request({since:{store:'store',generation:'1',seq:1024}})),/APP_JOURNAL_GAP/);
});

test('missing journal event and older business version are integrity failures, not empty deltas',()=>{
 const f=harness();f.api.command(event(0));const original=f.writer.readEntityAtRoot.bind(f.writer);
 f.writer.readEntityAtRoot=(root,key)=>key===appChangeSlot(1)?null:original(root,key);assert.throws(()=>f.sync().pull(request({since:{store:'store',generation:'1',seq:0}})),/APP_JOURNAL_GAP/);
 f.writer.readEntityAtRoot=(root,key)=>{const e=original(root,key);return key===appChangeSlot(1)?{...e,value:{...e.value,version:999}}:e;};assert.throws(()=>f.sync().pull(request({since:{store:'store',generation:'1',seq:0}})),/APP_JOURNAL_CORRUPT/);
});

test('bootstrap revision zero proof survives later checkpoints and is validated on continuation',()=>{
 const f=harness({activate:false}),empty=f.writer.status(),ack=proof(empty.revision,empty.headHash);assert.equal(ack.revision,0);f.activate();
 for(let i=0;i<129;i++)f.api.command(event(i));const sync=f.sync(),first=sync.pull(request({minimumAcknowledged:ack}));
 assert.equal(sync.pull(request({cursor:first.nextCursor,minimumAcknowledged:ack})).checkpoint.seq,129);
 assert.throws(()=>sync.pull(request({cursor:first.nextCursor,minimumAcknowledged:proof(0,'0'.repeat(64))})),/ACKNOWLEDGEMENT_MISMATCH/);
});

test('identity-bound acknowledgement resets foreign state before attempting any hash proof',()=>{
 const f=harness();for(let i=0;i<129;i++)f.api.command(event(i));const sync=f.sync(),first=sync.pull(request());
 const original=f.writer.assertMinimumAtReadView.bind(f.writer);let checks=0;f.writer.assertMinimumAtReadView=(...args)=>{checks++;return original(...args);};
 for(const bound of [proof(999,'0'.repeat(64),{store:'other'}),proof(999,'0'.repeat(64),{generation:'other'})]){
  for(const cursor of [null,first.nextCursor])assert.throws(()=>sync.pull(request({cursor,minimumAcknowledged:bound})),e=>e.code==='RESET_REQUIRED'&&e.resetReason==='identity-changed');
 }
 assert.equal(checks,0);
 assert.throws(()=>sync.pull(request({since:{store:'other',generation:'1',seq:0},minimumAcknowledged:proof(999,'0'.repeat(64))})),e=>e.code==='RESET_REQUIRED'&&e.resetReason==='identity-changed');assert.equal(checks,0);
 assert.throws(()=>sync.pull(request({minimumAcknowledged:{revision:1,hash:'0'.repeat(64)}})),/SYNC_PAYLOAD_INVALID/);
 assert.throws(()=>sync.pull(request({minimumAcknowledged:proof(first.revision,'0'.repeat(64))})),/ACKNOWLEDGEMENT_MISMATCH/);assert.equal(checks,1);
});

test('a journal-looking head cannot implicitly activate an unfenced store',()=>{
 const f=harness({activate:false});
 f.writer.transact({operationId:randomUUID(),epoch:'default',digest:digest('unfenced head fixture'),changes:[{key:APP_CHANGE_HEAD,expectedVersion:0,value:{protocol:2,seq:0,floor:1,capacity:APP_CHANGE_CAPACITY}}]});
 const head=f.writer.getEntity(APP_CHANGE_HEAD),before=f.writer.status().revision;
 assert.throws(()=>f.sync().pull(request()),e=>e.code==='SYNC_V2_MIGRATION_REQUIRED'&&e.requiresOwnerAction===true);assert.equal(f.writer.status().revision,before);
 const r=f.api.command(event(0));assert.equal(r.result.appSeq,undefined);assert.deepEqual(f.writer.getEntity(APP_CHANGE_HEAD),head);assert.equal(f.writer.getEntity(appChangeSlot(1)),null);assert.equal(f.writer.status().writerFence,0);
});

test('fenced missing journal is corruption, but a previously recorded legacy receipt still replays',()=>{
 const f=harness({activate:false}),c=cmd('wake:2026-10-07','07:00'),legacy=f.api.command(c);
 f.writer.enableFormatFence({operationId:randomUUID(),epoch:'default',digest:digest('test missing app head'),changes:[],result:{fixture:true}});
 assert.equal(f.writer.status().writerFence,2);assert.equal(f.writer.getEntity(APP_CHANGE_HEAD),null);
 assert.deepEqual(f.api.command(c),legacy);
 assert.throws(()=>f.api.command(cmd(c.key,'08:00',1)),/APP_JOURNAL_CORRUPT/);
 assert.throws(()=>f.sync().pull(request()),/APP_JOURNAL_CORRUPT/);
 assert.equal(f.writer.getEntity(APP_CHANGE_HEAD),null);assert.equal(f.writer.getEntity('app/data/'+c.key).version,1);
});

test('radix snapshots return empty but advancing pages across non-app state',()=>{
 const f=harness();f.writer.transact({operationId:randomUUID(),epoch:'default',digest:digest('internal scan fixture'),changes:Array.from({length:12},(_,i)=>({key:'import/internal/'+i,expectedVersion:0,value:{n:i}}))});
 const original=f.writer.scanEntitiesAtRoot.bind(f.writer);f.writer.scanEntitiesAtRoot=(root,options)=>original(root,{...options,scanLimit:1});
 const sync=f.sync(),first=sync.pull(request());assert.deepEqual(first.entries,[]);assert.ok(first.nextCursor);assert.equal(first.throughSeq,null);
 const pages=drain(sync,first);assert.ok(pages.length>1);assert.ok(pages.every(p=>p.entries.length===0));assert.equal(new Set(pages.map(p=>p.nextCursor).filter(Boolean)).size,pages.length-1);assert.equal(pages.at(-1).checkpoint.seq,0);
});

test('snapshot cursor survives a two-hour pause while delta expires after fifteen minutes',()=>{
 const f=harness();for(let i=0;i<129;i++)f.api.command(event(i));const sync=f.sync(),snapshot=sync.pull(request()),delta=sync.pull(request({since:{store:'store',generation:'1',seq:0}}));
 const snapValue=f.codec.openCursor(snapshot.nextCursor),deltaValue=f.codec.openCursor(delta.nextCursor);assert.equal(snapValue.expiresAt-snapValue.issuedAt,86400000);assert.equal(deltaValue.expiresAt-deltaValue.issuedAt,900000);
 f.setTime(f.time()+2*60*60*1000);const last=sync.pull(request({cursor:snapshot.nextCursor}));assert.equal(last.entries.length,1);assert.equal(last.checkpoint.seq,129);
 assert.throws(()=>sync.pull(request({cursor:delta.nextCursor})),e=>e.code==='RESET_REQUIRED'&&e.resetReason==='cursor-expired');
});

test('50k-record synthetic checkpoint bootstraps completely through actual cold radix scans',()=>{
 // This fixture constructs an authenticated-shaped immutable checkpoint cut;
 // it is NOT historical mutation throughput, a GC proof, or live Drive timing.
 const count=50000,f=harness({activate:false,limits:{maxLeafEntries:128}}),entries=[];
 for(let i=0;i<count;i++){
  const date=new Date(Date.UTC(2000,0,1+Math.floor(i/2))).toISOString().slice(0,10),key=(i%2?'diary:':'wake:')+date,value=i%2?{text:'retained fixture '+i,mood:null}:'07:00';
  entries.push({key:'app/data/'+key,value:{key:'app/data/'+key,version:1,deleted:false,value}});
 }
 entries.push({key:APP_CHANGE_HEAD,value:{key:APP_CHANGE_HEAD,version:1,deleted:false,value:{protocol:2,seq:0,floor:1,capacity:APP_CHANGE_CAPACITY}}});entries.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
 const w=f.writer,root=w._writeEntries(entries,'entities','history_cut',0),indexId=w.status().nextIndexId,cut={id:'history_cut',hash:'a'.repeat(64),revision:100000,nextSlotId:'publication'};
 const manifest=w._sealed('checkpoint-manifest',{datasetGeneration:'1',cut,stateRoot:root,receiptRoot:null,acceptedEpochs:['default'],writerFence:2});f.files.set('manifest',w._bytes(manifest));const manifestRef={id:'manifest',hash:manifest.hash};
 const frame=w._sealed('frame',{writerFence:2,datasetGeneration:'1',revision:100001,parent:{id:cut.id,hash:cut.hash},nextSlotId:'absent_frame',operation:{operationId:'cut_checkpoint',epoch:'default',digest:digest('synthetic cut')},committedAt:'2026-10-07T17:00:00Z',changes:[],stateRoot:root,receiptRoot:null,result:{checkpoint:true},references:[],checkpoint:{indexId,nextIndexId:'absent_index',previousIndex:null,manifestRef,cut},acceptedEpochs:['default']});f.files.set('publication',w._bytes(frame));
 const index=w._sealed('checkpoint-index',{previousIndex:null,nextIndexId:'absent_index',manifestRef,cut,publishingFrame:{id:'publication',hash:frame.hash,revision:100001}});f.files.set(indexId,w._bytes(index));
 let cursor=null,pages=0,total=0,originalExpiry=null;const seen=new Set(),started=f.time();
 do{
  const page=f.sync(f.fresh()).pull(request({cursor}));pages++;total+=page.entries.length;assert.ok(page.entries.length<=128);assert.ok(Buffer.byteLength(JSON.stringify(page))<=262144);
  for(const entity of page.entries){assert.equal(seen.has(entity.key),false);seen.add(entity.key);assert.equal(entity.version,1);}
  cursor=page.nextCursor;if(cursor){const value=f.codec.openCursor(cursor);originalExpiry??=value.expiresAt;assert.equal(value.expiresAt,originalExpiry);}
  // Five modeled seconds per complete HTTP page deliberately exceeds15min.
  f.setTime(f.time()+5000);
 }while(cursor);
 assert.equal(total,count);assert.equal(seen.size,count);assert.equal(pages,Math.ceil(count/128));assert.ok(f.time()-started>900000);assert.ok(f.time()-started<86400000);
});
