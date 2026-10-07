import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodeUtf8} from './codec.mjs';
import {ImmutableAssetAdapter,ImportCheckpointCoordinator,createGasAssetMediaReader,hashAssetBytes,encodeBoundedJson,MAX_CHECKPOINT_BYTES,MAX_OUTPUT_BYTES} from './immutable-assets.mjs';

const sha=b=>createHash('sha256').update(Uint8Array.from(b)).digest('hex');
const clone=x=>JSON.parse(JSON.stringify(x));
function proposal(fileId='out_1',role='output',text='synthetic,\u{1F680}\n') {
 const bytes=encodeUtf8(text);
 return {reservation:{fileId,storeId:'store_1',jobId:'job_1',pinId:'pin_1',role,sha256:sha(bytes),byteLength:bytes.length},bytes};
}
function gasFake() {
 const events=[],files=new Map(),durable=new Map();let createFailure=null,readFailure=null,metaFailure=null;
 const Drive={Files:{
  create(meta,blob,options){
   events.push(['create',meta.id]);assert.equal(options.fields,'id');assert.equal(options.ignoreDefaultVisibility,true);
   if(createFailure==='before')throw Error('transport timeout');
   if(files.has(meta.id)){const e=Error('409 conflict');e.code=409;throw e;}
   files.set(meta.id,{meta:{...clone(meta),size:String(blob.bytes.length),trashed:false,ownedByMe:true,shared:false},bytes:Uint8Array.from(blob.bytes,n=>n&255)});
   if(createFailure==='after')throw Error('lost create response');
   if(createFailure==='wrong-id')return {id:'wrong'};
   return {id:meta.id};
  },
  get(id){events.push(['get',id]);if(metaFailure)throw Error(metaFailure);if(id==='managed_parent')return {id,mimeType:'application/vnd.google-apps.folder',trashed:false,ownedByMe:true,shared:false};if(!files.has(id))throw Error('404 not found or no access');return clone(files.get(id).meta);}
 }};
 const Utilities={newBlob(bytes,mimeType,name){events.push(['blob',name]);assert.ok(bytes.every(n=>n>=-128&&n<=127));return {bytes,mimeType,name};}};
 const adapter=new ImmutableAssetAdapter({Drive,Utilities,readAssetBytes(id,length,maxBytes){events.push(['media',id]);assert.ok(length<=maxBytes);if(readFailure)throw Error(readFailure);return Array.from(files.get(id).bytes,n=>n>127?n-256:n);},managedParentId:'managed_parent',storeId:'store_1',assertReservation(r){events.push(['reservation',r.fileId]);const saved=durable.get(r.fileId);return Boolean(saved)&&Object.keys(r).every(k=>saved[k]===r[k]);}});
 return {adapter,events,files,durable,reserve(a){durable.set(a.reservation.fileId,clone(a.reservation));return a;},failCreate(x){createFailure=x;},failRead(x){readFailure=x;},failMeta(x){metaFailure=x;}};
}

test('GAS immutable create uses fixed reserved ID, parent, markers and signed Blob bytes, exact readback',()=>{
 const f=gasFake(),a=f.reserve(proposal());const result=f.adapter.putOnce(a);
 assert.equal(result.fileId,a.reservation.fileId);assert.equal(result.verified,true);assert.equal(hashAssetBytes(a.bytes),sha(a.bytes));
 assert.equal(f.files.size,1);const meta=f.files.get(result.fileId).meta;
 assert.deepEqual(meta.parents,['managed_parent']);assert.equal(meta.appProperties['mypace.store'],'store_1');assert.equal(meta.appProperties['mypace.job'],'job_1');assert.equal(meta.appProperties['mypace.pin'],'pin_1');assert.equal(meta.appProperties['mypace.role'],'output');
 assert.deepEqual(f.events.map(e=>e[0]),['reservation','get','blob','create','get','media']);
});

test('same-ID 409 returns only after matching metadata and exact media bytes',()=>{
 const f=gasFake(),a=f.reserve(proposal());f.adapter.putOnce(a);f.adapter.putOnce(a);
 assert.equal(f.files.size,1);assert.deepEqual(f.events.filter(e=>e[0]==='create').map(e=>e[1]),['out_1','out_1']);assert.equal(f.events.filter(e=>e[0]==='media').length,2);
});

test('ambiguous create after persistence reads same ID and resolves exact bytes',()=>{
 const f=gasFake(),a=f.reserve(proposal());f.failCreate('after');assert.equal(f.adapter.putOnce(a).verified,true);assert.equal(f.files.size,1);
});

test('ambiguous create before persistence remains unresolved; retry keeps exact ID',()=>{
 const f=gasFake(),a=f.reserve(proposal());f.failCreate('before');assert.throws(()=>f.adapter.putOnce(a),/ASSET_UNRESOLVED/);assert.equal(f.files.size,0);
 f.failCreate(null);assert.equal(f.adapter.putOnce(a).verified,true);assert.deepEqual(f.events.filter(e=>e[0]==='create').map(e=>e[1]),['out_1','out_1']);
});

test('lost media read and permission error never infer absence or choose fresh ID',()=>{
 const f=gasFake(),a=f.reserve(proposal());f.failRead('timeout');assert.throws(()=>f.adapter.putOnce(a),/ASSET_UNRESOLVED/);
 f.failRead(null);f.failMeta('403 forbidden');assert.throws(()=>f.adapter.putOnce(a),/MANAGED_PARENT_UNRESOLVED/);assert.equal(f.files.size,1);
 f.failMeta(null);assert.equal(f.adapter.putOnce(a).verified,true);
});

for(const [name,mutate] of [
 ['shared',m=>m.shared=true],['not owned',m=>m.ownedByMe=false],['wrong parent',m=>m.parents=['source_parent']],['extra parent',m=>m.parents.push('other')],['wrong store',m=>m.appProperties['mypace.store']='other'],['wrong job',m=>m.appProperties['mypace.job']='other'],['wrong role',m=>m.appProperties['mypace.role']='checkpoint'],['wrong pin',m=>m.appProperties['mypace.pin']='other'],['wrong id',m=>m.id='other'],['trashed',m=>m.trashed=true],['missing trashed',m=>delete m.trashed],['wrong MIME',m=>m.mimeType='application/vnd.google-apps.document'],['wrong size',m=>m.size='999'],['missing digest marker',m=>delete m.appProperties['mypace.sha256']]
]) test(`fail closed on ${name} even after 409`,()=>{
 const f=gasFake(),a=f.reserve(proposal());f.adapter.putOnce(a);mutate(f.files.get('out_1').meta);const mediaBefore=f.events.filter(e=>e[0]==='media').length;
 assert.throws(()=>f.adapter.putOnce(a),/ASSET_METADATA_MISMATCH/);assert.equal(f.events.filter(e=>e[0]==='media').length,mediaBefore);assert.equal(f.files.size,1);
});

test('same length wrong actual bytes fail closed despite expected metadata hash',()=>{
 const f=gasFake(),a=f.reserve(proposal());f.adapter.putOnce(a);f.files.get('out_1').bytes[0]^=1;
 assert.throws(()=>f.adapter.putOnce(a),/ASSET_CONTENT_MISMATCH/);assert.equal(f.files.size,1);
});

test('unpersisted descriptor and changed proposal are rejected before any create',()=>{
 const f=gasFake(),a=proposal();a.reservation.durable=true;assert.throws(()=>f.adapter.putOnce(a),/RESERVATION_NOT_DURABLE/);delete a.reservation.durable;
 f.reserve(a);a.bytes[0]^=1;assert.throws(()=>f.adapter.putOnce(a),/ASSET_PROPOSAL_MISMATCH/);assert.ok(!f.events.some(e=>e[0]==='create'));
});

test('per-role limits include encoded UTF8 bytes, not just character count',()=>{
 assert.throws(()=>encodeBoundedJson({s:'🚀'.repeat(MAX_CHECKPOINT_BYTES/4)}),/CHECKPOINT_TOO_LARGE/);
 const f=gasFake(),a=proposal('large','output','x'.repeat(MAX_OUTPUT_BYTES+1));f.reserve(a);assert.throws(()=>f.adapter.putOnce(a),/ASSET_TOO_LARGE/);assert.equal(f.files.size,0);
 const b=proposal('largecp','checkpoint','x'.repeat(MAX_CHECKPOINT_BYTES+1));f.reserve(b);assert.throws(()=>f.adapter.putOnce(b),/ASSET_TOO_LARGE/);
});

test('bad byte arrays are not silently clamped',()=>{
 const f=gasFake(),a=f.reserve(proposal());a.bytes=[300];assert.throws(()=>f.adapter.putOnce(a),/ASSET_BYTES_INVALID/);
});

test('an unexpected create result ID is terminal and never adopted',()=>{
 const f=gasFake(),a=f.reserve(proposal());f.failCreate('wrong-id');assert.throws(()=>f.adapter.putOnce(a),/ASSET_CREATE_ID_MISMATCH/);assert.deepEqual([...f.files.keys()],['out_1']);
});

function coordinatorFixture() {
 const f=gasFake(),events=[],receipts=new Map();let locked=false,lockCalls=0,denyLockAt=0,barrierCalls=0,denyBarrierAt=0,valid=true,sourceValid=true,commitFailure=null;
 const cp=proposal('checkpoint_1','checkpoint',JSON.stringify({offset:12,previousManifest:{fileId:'manifest_1'},complete:false}));
 const manifest=proposal('manifest_1','manifest-page',JSON.stringify({previous:null,outputs:['out_1']}));
 const input={operationId:'operation_1',jobId:'job_1',expectedCheckpointId:null,sourceIdentity:{id:'source_1',version:'7',md5Checksum:'abc',size:'100'},completed:false,assets:[f.reserve(proposal()),f.reserve(manifest),f.reserve(cp)]};
 const writer={
  recoveryBarrier(){assert.ok(locked);events.push('barrier');barrierCalls++;if(barrierCalls===denyBarrierAt)throw Error('BARRIER_PENDING');},
  getReceipt(id){assert.ok(locked);events.push('receipt');return receipts.get(id)||null;},
  validateImportBatch(command,content){assert.ok(locked);events.push('validate');assert.equal(content.checkpoint.offset,12);assert.equal(content.manifestPage.previous,null);assert.ok(Object.isFrozen(content.checkpoint));assert.ok(Object.isFrozen(command));return valid;},
  commitImportBatch(command,{verifiedAssets}){assert.ok(locked);events.push('commit');assert.equal(verifiedAssets.length,3);assert.ok(verifiedAssets.every(a=>a.verified));if(commitFailure==='before')throw Error('COMMIT_TIMEOUT');const receipt={operationId:command.operationId,digest:command.digest,revision:17};receipts.set(command.operationId,receipt);if(commitFailure==='after')throw Error('COMMIT_TIMEOUT');return receipt;}
 };
 const rawPut=f.adapter.putOnce.bind(f.adapter),rawVerify=f.adapter.verify.bind(f.adapter);
 const assets={putOnce(a){assert.equal(locked,false);events.push('stage:'+a.reservation.role);return rawPut(a);},verify(a){assert.ok(locked);events.push('verify:'+a.reservation.role);return rawVerify(a);}};
 const coordinator=new ImportCheckpointCoordinator({writer,assets,checkBudget:()=>true,getScriptLock(){return {tryLock(ms){assert.ok(ms<=5000);lockCalls++;events.push('lock');if(lockCalls===denyLockAt)return false;assert.equal(locked,false);locked=true;return true;},releaseLock(){assert.ok(locked);locked=false;events.push('unlock');}};},validateSourceCurrent(source){assert.ok(locked);events.push('source');assert.equal(source.version,'7');return sourceValid;}});
 return {f,events,input,writer,coordinator,receipts,isLocked:()=>locked,denyLock(n){denyLockAt=n;},denyBarrier(n){denyBarrierAt=n;},invalid(){valid=false;},changeSource(){sourceValid=false;},commitFailure(x){commitFailure=x;}};
}

test('two lock phases, mandatory barriers, receipts first, source immediately before durable commit',()=>{
 const f=coordinatorFixture();const receipt=f.coordinator.commitPreparedBatch(f.input);assert.equal(receipt.revision,17);
 assert.deepEqual(f.events,['lock','barrier','receipt','validate','unlock','stage:output','stage:manifest-page','stage:checkpoint','lock','barrier','receipt','validate','verify:output','verify:manifest-page','verify:checkpoint','source','commit','barrier','unlock']);assert.equal(f.isLocked(),false);
});

test('receipt replay precedes stale state checks and returns exact original receipt without stages',()=>{
 const f=coordinatorFixture(),original=f.coordinator.commitPreparedBatch(f.input);f.invalid();f.changeSource();f.events.length=0;
 const again=f.coordinator.commitPreparedBatch(f.input);assert.equal(again,original);assert.deepEqual(f.events,['lock','barrier','receipt','unlock']);
});

test('complete checkpoint bytes, completion flag, source and all references are digest-bound',()=>{
 for(const change of [i=>i.completed=true,i=>i.sourceIdentity.version='8',i=>{const a=i.assets.find(x=>x.reservation.role==='checkpoint');a.bytes=encodeUtf8('{"offset":13}');a.reservation={...a.reservation,sha256:sha(a.bytes),byteLength:a.bytes.length};},i=>i.expectedCheckpointId='different']) {
  const f=coordinatorFixture();f.coordinator.commitPreparedBatch(f.input);change(f.input);assert.throws(()=>f.coordinator.commitPreparedBatch(f.input),/OP_ID_REUSED/);
 }
});

test('busy first lock does not release someone else\'s lock or create files',()=>{
 const f=coordinatorFixture();f.denyLock(1);assert.throws(()=>f.coordinator.commitPreparedBatch(f.input),/WRITER_BUSY/);assert.deepEqual(f.events,['lock']);assert.equal(f.f.files.size,0);
});

test('busy final lock keeps staged same-ID assets and retry publishes once',()=>{
 const f=coordinatorFixture();f.denyLock(2);assert.throws(()=>f.coordinator.commitPreparedBatch(f.input),/WRITER_BUSY/);assert.equal(f.f.files.size,3);assert.equal(f.events.filter(e=>e==='unlock').length,1);assert.equal(f.receipts.size,0);
 f.denyLock(0);f.coordinator.commitPreparedBatch(f.input);assert.equal(f.f.files.size,3);assert.equal(f.receipts.size,1);
});

test('unresolved barrier stops before validation or staging',()=>{
 const f=coordinatorFixture();f.denyBarrier(1);assert.throws(()=>f.coordinator.commitPreparedBatch(f.input),/BARRIER_PENDING/);assert.deepEqual(f.events,['lock','barrier','unlock']);assert.equal(f.f.files.size,0);
});

test('post-commit barrier failure is recovered before receipt replay',()=>{
 const f=coordinatorFixture();f.denyBarrier(3);assert.throws(()=>f.coordinator.commitPreparedBatch(f.input),/BARRIER_PENDING/);assert.equal(f.receipts.size,1);f.events.length=0;
 assert.equal(f.coordinator.commitPreparedBatch(f.input).revision,17);assert.deepEqual(f.events,['lock','barrier','receipt','unlock']);
});

test('writer rejects invalid binding/pin/version before creating assets',()=>{
 const f=coordinatorFixture();f.invalid();assert.throws(()=>f.coordinator.commitPreparedBatch(f.input),/JOB_RESERVATION_OR_VERSION_INVALID/);assert.equal(f.f.files.size,0);assert.equal(f.isLocked(),false);
});

test('pin/expected state rechecked after outside-lock staging',()=>{
 const f=coordinatorFixture();const put=f.coordinator.assets.putOnce;f.coordinator.assets.putOnce=a=>{const r=put(a);f.invalid();return r;};
 assert.throws(()=>f.coordinator.commitPreparedBatch(f.input),/JOB_RESERVATION_OR_VERSION_INVALID/);assert.equal(f.receipts.size,0);assert.equal(f.isLocked(),false);
});

test('source changed or moved after staging blocks checkpoint publication',()=>{
 const f=coordinatorFixture();f.changeSource();assert.throws(()=>f.coordinator.commitPreparedBatch(f.input),/SOURCE_CHANGED/);assert.equal(f.f.files.size,3);assert.equal(f.receipts.size,0);assert.equal(f.isLocked(),false);assert.equal(f.events.at(-2),'source');
});

test('readback corruption under final lock blocks commit and releases owned lock',()=>{
 const f=coordinatorFixture();const put=f.coordinator.assets.putOnce;f.coordinator.assets.putOnce=a=>{const r=put(a);if(a.reservation.role==='checkpoint')f.f.files.get('out_1').bytes[0]^=1;return r;};
 assert.throws(()=>f.coordinator.commitPreparedBatch(f.input),/ASSET_CONTENT_MISMATCH/);assert.equal(f.receipts.size,0);assert.equal(f.isLocked(),false);
});

for(const failure of ['before','after'])test(`interruption ${failure} writer commit retries original operation and IDs`,()=>{
 const f=coordinatorFixture();f.commitFailure(failure);assert.throws(()=>f.coordinator.commitPreparedBatch(f.input),/COMMIT_TIMEOUT/);assert.equal(f.isLocked(),false);f.commitFailure(null);
 const receipt=f.coordinator.commitPreparedBatch(f.input);assert.equal(receipt.operationId,'operation_1');assert.equal(f.receipts.size,1);assert.equal(f.f.files.size,3);
});

test('malformed checkpoint JSON cannot reach writer/staging',()=>{
 const f=coordinatorFixture();const cp=proposal('checkpoint_1','checkpoint','not json');f.input.assets[2]=f.f.reserve(cp);
 assert.throws(()=>f.coordinator.commitPreparedBatch(f.input),/IMPORT_CHECKPOINT_JSON_INVALID/);assert.equal(f.events.length,0);assert.equal(f.f.files.size,0);
});

test('empty-output checkpoint commits and retries with checkpoint-dependent digest',()=>{
 const f=coordinatorFixture();f.input.assets=f.input.assets.filter(a=>a.reservation.role!=='output');
 f.writer.commitImportBatch=(command,{verifiedAssets})=>{assert.equal(verifiedAssets.length,2);const r={operationId:command.operationId,digest:command.digest,revision:18};f.receipts.set(command.operationId,r);return r;};
 assert.equal(f.coordinator.commitPreparedBatch(f.input).revision,18);assert.equal(f.f.files.size,2);
});


test('non-private managed parent is rejected before any create or asset data transmission',()=>{
 const f=gasFake(),a=f.reserve(proposal());const get=f.adapter.Drive.Files.get;
 f.adapter.Drive.Files.get=(id,options)=>{const m=get(id,options);if(id==='managed_parent')m.shared=true;return m;};
 assert.throws(()=>f.adapter.putOnce(a),/MANAGED_PARENT_NOT_PRIVATE/);assert.equal(f.files.size,0);assert.ok(!f.events.some(e=>e[0]==='create'));
});

for(const budgetStage of ['stage','final-lock','verify','source','commit'])test(`budget yield at ${budgetStage} leaves previous checkpoint and pins intact`,()=>{
 const f=coordinatorFixture();const checks=[];f.coordinator.checkBudget=stage=>{checks.push(stage);return stage!==budgetStage;};
 assert.throws(()=>f.coordinator.commitPreparedBatch(f.input),/IMPORT_YIELD/);assert.equal(f.receipts.size,0);assert.equal(f.isLocked(),false);assert.equal(f.f.durable.size,3);assert.equal(checks.at(-1),budgetStage);
 f.coordinator.checkBudget=()=>true;assert.equal(f.coordinator.commitPreparedBatch(f.input).revision,17);assert.equal(f.f.files.size,3);
});

test('already committed receipt can return despite expired work budget',()=>{
 const f=coordinatorFixture();const original=f.coordinator.commitPreparedBatch(f.input);f.coordinator.checkBudget=()=>false;
 assert.equal(f.coordinator.commitPreparedBatch(f.input),original);
});

test('same operation committed by a competing invocation during staging returns its original receipt',()=>{
 const f=coordinatorFixture();let command;const validate=f.writer.validateImportBatch;f.writer.validateImportBatch=(c,content)=>{command=c;return validate(c,content);};
 const put=f.coordinator.assets.putOnce;const winner={operationId:'operation_1',digest:null,revision:19};
 f.coordinator.assets.putOnce=a=>{const asset=put(a);winner.digest=command.digest;f.receipts.set('operation_1',winner);f.invalid();f.changeSource();return asset;};
 const receipt=f.coordinator.commitPreparedBatch(f.input);assert.equal(receipt,winner);assert.equal(f.events.filter(e=>e==='commit').length,0);assert.equal(f.events.filter(e=>e==='validate').length,1);
});

test('lock acquisition exception never releases a lock that was not acquired',()=>{
 const f=coordinatorFixture();let released=0;
 f.coordinator.getScriptLock=()=>({tryLock(){throw Error('LOCK_SERVICE_FAILURE');},releaseLock(){released++;}});
 assert.throws(()=>f.coordinator.commitPreparedBatch(f.input),/LOCK_SERVICE_FAILURE/);assert.equal(released,0);assert.equal(f.f.files.size,0);
});

test('budget callback is explicitly required at construction',()=>{
 const f=coordinatorFixture();assert.throws(()=>new ImportCheckpointCoordinator({writer:f.writer,assets:f.coordinator.assets,getScriptLock:f.coordinator.getScriptLock,validateSourceCurrent:f.coordinator.validateSourceCurrent}),/COORDINATOR_CONFIG_INVALID/);
});

function mediaFixture(changes={}) {
 const events=[],content=Uint8Array.from([65,200,255]);
 const response={getResponseCode:()=>changes.status??206,getAllHeaders:()=>changes.headers??{'Content-Range':'bytes 0-2/3','Content-Length':'3'},getContent:()=>changes.content??[65,-56,-1]};
 const reader=createGasAssetMediaReader({UrlFetchApp:{fetch(url,options){events.push({url,options});if(changes.throw)throw Error('private Google error text token-not-for-logs');return response;}},ScriptApp:{getOAuthToken(){events.push('token');return 'test_secret';}},assertReadableAsset(id,size,max){events.push('reservation');assert.equal(id,'managed_1');assert.equal(size,3);assert.equal(max,MAX_OUTPUT_BYTES);return changes.reserved!==false;},checkBudget(){events.push('budget');return changes.budget!==false;}});
 return {reader,events,content};
}

test('managed media reader sends token only to fixed Google host with exact range and no redirects',()=>{
 const f=mediaFixture();assert.deepEqual(f.reader('managed_1',3,MAX_OUTPUT_BYTES),f.content);
 assert.deepEqual(f.events.slice(0,3),['reservation','budget','token']);
 const request=f.events[3];assert.equal(request.url,'https://www.googleapis.com/drive/v3/files/managed_1?alt=media');assert.equal(request.options.headers.Range,'bytes=0-2');assert.equal(request.options.headers['Accept-Encoding'],'identity');assert.equal(request.options.followRedirects,false);assert.equal(request.options.muteHttpExceptions,true);
});

for (const status of [200,301,302,400,401,403,404,429,500,503])test(`media status ${status} never falls back to full download or another ID`,()=>{
 const f=mediaFixture({status});assert.throws(()=>f.reader('managed_1',3,MAX_OUTPUT_BYTES),/ASSET_MEDIA_STATUS/);assert.equal(f.events.filter(e=>typeof e==='object').length,1);
});

for (const headers of [
 {'Content-Range':'bytes 1-3/4'}, {'Content-Range':'bytes 0-2/4'}, {'Content-Range':'bytes 0-2/*'}, {},
 {'Content-Range':'bytes 0-2/3','content-range':'bytes 0-2/3'},
 {'Content-Range':['bytes 0-2/3']},
 {'Content-Range':'bytes 0-2/3','Content-Length':'4'},
 {'Content-Range':'bytes 0-2/3','Content-Encoding':'gzip'}
])test('managed media reader rejects inconsistent or ambiguous headers '+JSON.stringify(headers),()=>{
 const f=mediaFixture({headers});assert.throws(()=>f.reader('managed_1',3,MAX_OUTPUT_BYTES),/ASSET_MEDIA_(RANGE_MISMATCH|HEADERS_INVALID)/);
});

test('managed media reader validates actual bytes length and normalizes GAS signed bytes',()=>{
 const f=mediaFixture({content:[65,-56]});assert.throws(()=>f.reader('managed_1',3,MAX_OUTPUT_BYTES),/ASSET_CONTENT_MISMATCH/);
 const bad=mediaFixture({content:[65,999,0]});assert.throws(()=>bad.reader('managed_1',3,MAX_OUTPUT_BYTES),/ASSET_BYTES_INVALID/);
});

test('media reader rejects empty asset, unsafe ID, excessive bound and unreserved read before credentials',()=>{
 const f=mediaFixture();for(const args of [['managed_1',0,MAX_OUTPUT_BYTES],['https://evil.example/',3,MAX_OUTPUT_BYTES],['managed_1',3,MAX_CHECKPOINT_BYTES+1]])assert.throws(()=>f.reader(...args),/ASSET_MEDIA_BOUNDS_INVALID/);assert.equal(f.events.length,0);
 const unreserved=mediaFixture({reserved:false});assert.throws(()=>unreserved.reader('managed_1',3,MAX_OUTPUT_BYTES),/ASSET_MEDIA_NOT_RESERVED/);assert.deepEqual(unreserved.events,['reservation']);
});

test('media reader budget stops before credentials/request and transport errors stay sanitized',()=>{
 const noBudget=mediaFixture({budget:false});assert.throws(()=>noBudget.reader('managed_1',3,MAX_OUTPUT_BYTES),/IMPORT_YIELD/);assert.deepEqual(noBudget.events,['reservation','budget']);
 const f=mediaFixture({throw:true});assert.throws(()=>f.reader('managed_1',3,MAX_OUTPUT_BYTES),error=>error.message==='ASSET_MEDIA_PENDING'&&error.retryable===true&&!JSON.stringify(error).includes('test_secret'));
});
test('resumed reservation verifies an existing asset without another create attempt',()=>{const f=gasFake(),a=f.reserve(proposal());f.adapter.putOnce(a);const before=f.events.filter(e=>e[0]==='create').length;assert.equal(f.adapter.putOnce({...a,reuseExisting:true}).verified,true);assert.equal(f.events.filter(e=>e[0]==='create').length,before);assert.equal(f.events.filter(e=>e[0]==='media').length,2);});
test('resumed reservation still creates its same reserved ID when no upload exists',()=>{const f=gasFake(),a=f.reserve(proposal());assert.equal(f.adapter.putOnce({...a,reuseExisting:true}).verified,true);assert.deepEqual(f.events.filter(e=>e[0]==='create').map(e=>e[1]),['out_1']);});
test('resumed wrong bytes or privacy metadata never permit another create attempt',()=>{for(const corrupt of [e=>e.bytes[0]^=1,e=>e.meta.shared=true]){const f=gasFake(),a=f.reserve(proposal());f.adapter.putOnce(a);corrupt(f.files.get('out_1'));const before=f.events.filter(e=>e[0]==='create').length;assert.throws(()=>f.adapter.putOnce({...a,reuseExisting:true}),/ASSET_(CONTENT|METADATA)_MISMATCH/);assert.equal(f.events.filter(e=>e[0]==='create').length,before);}});
test('resumed media outage preserves the existing asset and does not retry create',()=>{const f=gasFake(),a=f.reserve(proposal());f.adapter.putOnce(a);f.failRead('temporary read outage');const before=f.events.filter(e=>e[0]==='create').length;assert.throws(()=>f.adapter.putOnce({...a,reuseExisting:true}),/ASSET_UNRESOLVED/);assert.equal(f.events.filter(e=>e[0]==='create').length,before);});
