import test from 'node:test';
import assert from 'node:assert/strict';
import {GasStoreIO} from './gas-store-io.mjs';
import {IncrementalSha256} from './codec.mjs';

const MAX = 2 * 1024 * 1024;
const MIME = 'application/octet-stream';
const copy = value => JSON.parse(JSON.stringify(value));
const signed = bytes => Array.from(bytes, n => n > 127 ? n - 256 : n);
const errorIs = (message, retryable, status) => error => {
 assert.equal(error.message, message);
 if (retryable !== undefined) assert.equal(error.retryable, retryable);
 if (status !== undefined) assert.equal(error.status, status);
 return true;
};

// Deliberately GAS-shaped mocks: signed Java byte arrays, HTTPResponse methods,
// Advanced Drive Files.create(metadata, blob, options), and per-invocation lock.
function fixture(options = {}) {
 const events = [], files = new Map(), state = {locked: true, budget: true, ...options};
 const parent = {id:'managed_parent', mimeType:'application/vnd.google-apps.folder', trashed:false, ownedByMe:true, shared:false};
 const source = {id:'source_csv', parents:['source_parent'], mimeType:'text/csv', appProperties:{}, size:'3', trashed:false, ownedByMe:true, shared:false};
 files.set('source_csv', {metadata:source, bytes:Uint8Array.of(97,98,99)});
 const metadata = (id, bytes) => ({id, parents:['managed_parent'], appProperties:{'mypace.store':'store_1','mypace.role':'frame'}, size:String(bytes.length), trashed:false, mimeType:MIME, ownedByMe:true, shared:false});
 const response = (status, values = {}) => ({
  getResponseCode(){events.push(['status',status]);if(state.statusThrows)throw Error('private status error');return status;},
  getContentText(){events.push(['metadata-body']);if(state.metadataBodyThrows)throw Error('private body error');return values.text;},
  getAllHeaders(){events.push(['headers']);return values.headers;},
  getContent(){events.push(['media-body']);return values.bytes;}
 });
 const config = {
  storeId:'store_1', managedParentId:'managed_parent',
  lock:{hasLock(){events.push(['lock']);return state.locked;}, releaseLock(){events.push(['release']);throw Error('IO must never release its caller\'s lock');}},
  checkBudget(stage){events.push(['budget',stage]);return typeof state.budget === 'function' ? state.budget() : state.budget;},
  ScriptApp:{getScriptId(){events.push(['script-id']);return 'script_1';},getOAuthToken(){events.push(['token']);if(state.tokenThrows)throw Error('private token error');return Object.hasOwn(state,'token') ? state.token : 'test_token';}},
  UrlFetchApp:{fetch(url, request){
   events.push(['fetch',url,request]);
   if(state.fetchThrows)throw Error('private fetch error test_token');
   const parsed = new URL(url), fileId = parsed.pathname.split('/').at(-1);
   assert.equal(parsed.origin,'https://www.googleapis.com');
   assert.equal(request.method,'get');
   if(Object.hasOwn(state,'response'))return state.response;
   if(parsed.searchParams.get('alt') === 'media') {
    const entry = files.get(fileId), size = entry.bytes.length;
    return response(state.mediaStatus ?? 206, {
     headers:Object.hasOwn(state,'headers') ? state.headers : {'Content-Range':`bytes 0-${size-1}/${size}`, 'Content-Length':String(size)},
     bytes:Object.hasOwn(state,'rawBytes') ? state.rawBytes : signed(entry.bytes)
    });
   }
   if(fileId === 'managed_parent') {
    if(state.afterParentFetch)state.afterParentFetch();
    return response(state.parentStatus ?? 200,{text:Object.hasOwn(state,'parentText') ? state.parentText : JSON.stringify(state.parent ?? parent)});
   }
   const entry = files.get(fileId), status = state.metadataStatus ?? (entry ? 200 : 404);
   if(state.afterMetadataFetch)state.afterMetadataFetch(fileId);
   return response(status,{text:Object.hasOwn(state,'metadataText') ? state.metadataText : JSON.stringify(entry?.metadata)});
  }},
  Utilities:{newBlob(bytes,mimeType,name){events.push(['blob',copy(bytes),mimeType,name]);return {bytes:copy(bytes),mimeType,name};}},
  Drive:{Files:{
   generateIds(request){events.push(['generateIds',copy(request)]);if(state.idsThrow)throw Error('private ids error');return Object.hasOwn(state,'generated') ? state.generated : {ids:Array.from({length:request.count},(_,i)=>`reserved_${i}`)};},
   create(meta,blob,request){
    events.push(['create',copy(meta),copy(blob),copy(request)]);
    if(state.createFailure === 'before')throw Error('create timeout before persistence');
    if(files.has(meta.id)){const e=Error('409 conflict');e.code=409;throw e;}
    const bytes = Uint8Array.from(blob.bytes,n=>n&255);
    files.set(meta.id,{metadata:{...copy(meta),size:String(bytes.length),trashed:false,ownedByMe:true,shared:false},bytes});
    if(state.createFailure === 'after')throw Error('create timeout after persistence');
    return Object.hasOwn(state,'createResult') ? state.createResult : {id:meta.id};
   },
   update(){throw Error('source/update writes are prohibited');},
   remove(){throw Error('source/deletion writes are prohibited');},
   copy(){throw Error('source/copy writes are prohibited');}
  }}
 };
 const io = new GasStoreIO(config);
 return {io,config,state,events,files,parent,source,
  add(id='frame_1',bytes=Uint8Array.of(0,127,128,200,255)){files.set(id,{metadata:metadata(id,bytes),bytes});return files.get(id);},
  count(type){return events.filter(e=>e[0]===type).length;}
 };
}

for(const path of ['Drive','Drive.Files','Drive.Files.create','Drive.Files.generateIds','Utilities.newBlob','UrlFetchApp.fetch','ScriptApp.getOAuthToken','ScriptApp.getScriptId','lock.hasLock','checkBudget','storeId','managedParentId']) {
 test(`constructor rejects missing ${path}`,()=>{
  const f=fixture(),config={...f.config};
  const keys=path.split('.');let current=config;
  for(const key of keys.slice(0,-1)){current[key]={...current[key]};current=current[key];}
  delete current[keys.at(-1)];assert.throws(()=>new GasStoreIO(config),/STORE_IO_CONFIG/);
 });
}

test('constructor and script ID lookup perform no Drive calls',()=>{
 const f=fixture();assert.deepEqual(f.events,[]);assert.equal(f.io.getScriptId(),'script_1');assert.deepEqual(f.events,[['script-id']]);
});

test('read requires exact private managed metadata and bounded Range GET on fixed host',()=>{
 const f=fixture(),entry=f.add();assert.deepEqual(f.io.readFile('frame_1'),entry.bytes);
 const calls=f.events.filter(e=>e[0]==='fetch');assert.equal(calls.length,3);
 assert.equal(calls[0][1],'https://www.googleapis.com/drive/v3/files/managed_parent?fields='+encodeURIComponent('id,parents,appProperties,size,trashed,mimeType,ownedByMe,shared'));
 assert.equal(calls[1][1],'https://www.googleapis.com/drive/v3/files/frame_1?fields='+encodeURIComponent('id,parents,appProperties,size,trashed,mimeType,ownedByMe,shared'));
 assert.equal(calls[2][1],'https://www.googleapis.com/drive/v3/files/frame_1?alt=media');
 for(const [,url,request] of calls){assert.equal(new URL(url).origin,'https://www.googleapis.com');assert.equal(request.headers.Authorization,'Bearer test_token');assert.equal(request.muteHttpExceptions,true);assert.equal(request.followRedirects,false);assert.equal(request.method,'get');}
 assert.equal(calls[2][2].headers.Range,'bytes=0-4');assert.equal(calls[2][2].headers['Accept-Encoding'],'identity');assert.equal(f.count('create'),0);
});

test('404 alone returns absent without reading error body, media, or issuing writes',()=>{
 const f=fixture();assert.equal(f.io.readFile('missing_1'),null);assert.equal(f.count('fetch'),2);assert.equal(f.count('metadata-body'),1);assert.equal(f.count('media-body'),0);assert.equal(f.count('create'),0);
});

for(const status of [200.1,201,204,301,302,400,401,403,409,429,500,503])test(`metadata status ${status} remains unresolved, never absent`,()=>{
 const f=fixture({metadataStatus:status});
 assert.throws(()=>f.io.readFile('missing_1'),errorIs('STORE_METADATA_UNRESOLVED',true,status));
 assert.equal(f.count('metadata-body'),1);assert.equal(f.count('media-body'),0);assert.equal(f.count('generateIds'),0);assert.equal(f.count('create'),0);
});

for(const state of [{fetchThrows:true},{tokenThrows:true},{token:''},{token:null}])test('read transport/auth failure is sanitized and retryable '+JSON.stringify(state),()=>{
 const f=fixture(state);assert.throws(()=>f.io.readFile('missing_1'),errorIs('STORE_READ_UNRESOLVED',true));assert.equal(f.count('create'),0);
});

for(const response of [null,undefined,{}, {getResponseCode:2}])test('invalid HTTPResponse shape fails before body access '+String(response),()=>{
 const f=fixture({response});assert.throws(()=>f.io.readFile('frame_1'),/STORE_RESPONSE_INVALID/);assert.equal(f.count('metadata-body'),0);assert.equal(f.count('media-body'),0);
});

for(const text of ['{','', ' '.repeat(16385),42,undefined])test('malformed or over-bound metadata body fails closed '+String(text).slice(0,30),()=>{
 const f=fixture({metadataStatus:200,metadataText:text});assert.throws(()=>f.io.readFile('frame_1'),/STORE_METADATA_INVALID/);assert.equal(f.count('media-body'),0);
});

for(const value of [null,[],false,3,'string',{}, {'__proto__':{id:'frame_1'}}])test('non-file JSON metadata fails closed '+JSON.stringify(value),()=>{
 const f=fixture({metadataStatus:200,metadataText:JSON.stringify(value)});assert.throws(()=>f.io.readFile('frame_1'));assert.equal(f.count('fetch'),2);assert.equal(f.count('media-body'),0);
});

for(const [name,mutate] of [
 ['wrong ID',m=>m.id='other'],['missing ID',m=>delete m.id],['trashed',m=>m.trashed=true],['missing trash state',m=>delete m.trashed],['not owned',m=>m.ownedByMe=false],['missing owner',m=>delete m.ownedByMe],['shared',m=>m.shared=true],['unknown sharing',m=>delete m.shared],['string sharing',m=>m.shared='false'],['wrong MIME',m=>m.mimeType='text/csv'],['folder MIME',m=>m.mimeType='application/vnd.google-apps.folder'],['missing parent',m=>delete m.parents],['string parent',m=>m.parents='managed_parent'],['source parent',m=>m.parents=['source_parent']],['extra parent',m=>m.parents.push('source_parent')],['no parent',m=>m.parents=[]],['wrong store',m=>m.appProperties['mypace.store']='another_store'],['no marker',m=>delete m.appProperties],['null marker',m=>m.appProperties=null]
])test(`rejects ${name} before media read`,()=>{
 const f=fixture();mutate(f.add().metadata);assert.throws(()=>f.io.readFile('frame_1'),/STORE_METADATA_MISMATCH/);assert.equal(f.count('fetch'),2);assert.equal(f.count('media-body'),0);
});

for(const size of [undefined,null,'',' 5','5 ','+5','-5','1.5','5e0','0','9007199254740992',String(MAX+1),true,{}])test('rejects invalid metadata size '+JSON.stringify(size),()=>{
 const f=fixture();f.add().metadata.size=size;assert.throws(()=>f.io.readFile('frame_1'),/STORE_SIZE_INVALID/);assert.equal(f.count('fetch'),2);
});

test('caller read ceiling is enforced before media',()=>{
 const f=fixture();f.add();assert.throws(()=>f.io.readFile('frame_1',4),/STORE_SIZE_INVALID/);assert.equal(f.count('fetch'),2);
});

for(const limit of [0,-1,1.5,NaN,Infinity,MAX+1,'5',null])test('invalid read bound makes no request '+String(limit),()=>{
 const f=fixture();assert.throws(()=>f.io.readFile('frame_1',limit),/STORE_READ_BOUND/);assert.deepEqual(f.events,[]);
});

for(const status of [200,201,204,301,302,400,401,403,404,409,416,429,500,503])test(`media status ${status} rejects without whole-body fallback`,()=>{
 const f=fixture({mediaStatus:status});f.add();assert.throws(()=>f.io.readFile('frame_1'),errorIs('STORE_RANGE_STATUS',true,status));assert.equal(f.count('fetch'),3);assert.equal(f.count('headers'),0);assert.equal(f.count('media-body'),0);
});

for(const headers of [
 null,[], 'header',{},
 {'Content-Range':'bytes 1-5/6'}, {'Content-Range':'bytes 0-4/6'}, {'Content-Range':'bytes 0-4/*'}, {'Content-Range':'bytes 0-4/5, bytes 0-4/5'},
 {'Content-Range':'bytes 0-4/5','content-range':'bytes 0-4/5'}, {'Content-Range':['bytes 0-4/5']}, {'Content-Range':{value:'bytes 0-4/5'}},
 {'Content-Range':'bytes 0-4/5','Content-Length':'4'}, {'Content-Range':'bytes 0-4/5','Content-Length':'05'}, {'Content-Range':'bytes 0-4/5','Content-Length':['5']},
 {'Content-Range':'bytes 0-4/5','Content-Length':'5','content-length':'5'}, {'Content-Range':'bytes 0-4/5','Content-Encoding':'gzip'}, {'Content-Range':'bytes 0-4/5','Content-Encoding':['identity']},
 {'Content-Range':'bytes 0-4/5','Content-Encoding':'identity','content-encoding':'identity'}
])test('rejects malformed/ambiguous media headers '+JSON.stringify(headers),()=>{
 const f=fixture({headers});f.add();assert.throws(()=>f.io.readFile('frame_1'),/STORE_(HEADERS_INVALID|RANGE_INVALID)/);assert.equal(f.count('media-body'),0);
});

test('case-insensitive header names, outer whitespace, numeric length and identity encoding work',()=>{
 const f=fixture({headers:{'cOnTeNt-RaNgE':' bytes 0-4/5 ','CONTENT-LENGTH':5,'Content-Encoding':' IDENTITY '}});const entry=f.add();assert.deepEqual(f.io.readFile('frame_1'),entry.bytes);
});

test('Content-Length and Content-Encoding are optional when range and actual bytes are exact',()=>{
 const f=fixture({headers:{'Content-Range':'bytes 0-4/5'}});const entry=f.add();assert.deepEqual(f.io.readFile('frame_1'),entry.bytes);
});

for(const rawBytes of [null,[],[0,127,-128,-56], [0,127,-128,-56,-1,0], [0,127,-129,-56,-1], [0,127,256,-56,-1], [0,127,1.5,-56,-1], [0,127,NaN,-56,-1], [0,127,'128',-56,-1], [0,127,undefined,-56,-1]])test('rejects malformed signed Java bytes '+JSON.stringify(rawBytes),()=>{
 const f=fixture({rawBytes});f.add();assert.throws(()=>f.io.readFile('frame_1'),/STORE_BYTES_INVALID/);
});

test('all 256 unsigned byte values survive signed Java-byte read and create conversion',()=>{
 const f=fixture(),bytes=Uint8Array.from({length:256},(_,i)=>i);f.add('frame_1',bytes);assert.deepEqual(f.io.readFile('frame_1'),bytes);
 f.io.createFile('new_frame',bytes,'operation-frame');const blob=f.events.find(e=>e[0]==='blob');assert.deepEqual(blob[1],signed(bytes));assert.equal(blob[2],MIME);assert.ok(blob[1].every(x=>x>=-128&&x<=127));assert.deepEqual(f.io.readFile('new_frame'),bytes);
});

test('create uses exactly the fixed ID, private managed parent and store/role markers',()=>{
 const f=fixture();const bytes=Uint8Array.of(0,128,255);assert.deepEqual(f.io.createFile('reserved_1',bytes,'operation-frame'),{id:'reserved_1'});
 const call=f.events.find(e=>e[0]==='create');assert.deepEqual(call[1],{id:'reserved_1',name:'mypace-operation-frame-reserved_1',mimeType:MIME,parents:['managed_parent'],appProperties:{'mypace.store':'store_1','mypace.role':'operation-frame'}});assert.deepEqual(call[3],{fields:'id',ignoreDefaultVisibility:true});assert.equal(f.count('generateIds'),0);assert.equal(f.count('media-body'),0);
 // A returned create alone is not verified success: the caller must read this ID.
 assert.deepEqual(f.io.readFile('reserved_1'),bytes);
});

for(const failure of ['before','after'])test(`same-ID create retry after timeout ${failure} persistence never allocates a replacement`,()=>{
 const f=fixture({createFailure:failure}),bytes=Uint8Array.of(1,2,3);
 assert.throws(()=>f.io.createFile('reserved_1',bytes,'frame'),/create timeout/);
 const observed=f.io.readFile('reserved_1');if(failure==='after')assert.deepEqual(observed,bytes);else assert.equal(observed,null);
 f.state.createFailure=null;
 if(failure==='after')assert.throws(()=>f.io.createFile('reserved_1',bytes,'frame'),/409/);else assert.equal(f.io.createFile('reserved_1',bytes,'frame').id,'reserved_1');
 assert.deepEqual(f.io.readFile('reserved_1'),bytes);assert.equal(f.count('generateIds'),0);assert.deepEqual(f.events.filter(e=>e[0]==='create').map(e=>e[1].id),['reserved_1','reserved_1']);assert.equal(f.files.size,2);
});

test('conflicting same-ID bytes cannot overwrite the original winner',()=>{
 const f=fixture();const first=Uint8Array.of(1,2,3);f.io.createFile('reserved_1',first,'frame');assert.throws(()=>f.io.createFile('reserved_1',Uint8Array.of(9,9,9),'frame'),/409/);assert.deepEqual(f.io.readFile('reserved_1'),first);assert.equal(f.count('generateIds'),0);
});

for(const createResult of [null,{}, {id:'wrong_id'}])test('unexpected create result is rejected without alternate ID '+JSON.stringify(createResult),()=>{
 const f=fixture({createResult});assert.throws(()=>f.io.createFile('reserved_1',Uint8Array.of(1),'frame'),/STORE_CREATE_ID_MISMATCH/);assert.deepEqual(f.io.readFile('reserved_1'),Uint8Array.of(1));assert.equal(f.count('create'),1);assert.equal(f.count('generateIds'),0);
});

for(const [name,mutate] of [
 ['wrong ID',m=>m.id='wrong_parent'],['folder missing',m=>null],['not folder',m=>m.mimeType=MIME],['trashed',m=>m.trashed=true],['unknown trash state',m=>delete m.trashed],['not owned',m=>m.ownedByMe=false],['unknown owner',m=>delete m.ownedByMe],['shared',m=>m.shared=true],['unknown sharing',m=>delete m.shared]
])test(`non-private managed parent (${name}) rejects before blob or create`,()=>{
 const f=fixture();f.state.parent=copy(f.parent);const result=mutate(f.state.parent);if(result===null)f.state.parentText='null';
 assert.throws(()=>f.io.createFile('reserved_1',Uint8Array.of(1),'frame'),/STORE_(PARENT_NOT_PRIVATE|METADATA_INVALID)/);assert.equal(f.count('blob'),0);assert.equal(f.count('create'),0);
});

for(const status of [404,403,500])test(`managed-parent status ${status} prevents all writes`,()=>{
 const f=fixture({parentStatus:status});assert.throws(()=>f.io.createFile('reserved_1',Uint8Array.of(1),'frame'),status===404 ? /STORE_PARENT_NOT_PRIVATE/ : /STORE_METADATA_UNRESOLVED/);assert.equal(f.count('blob'),0);assert.equal(f.count('create'),0);
});

for(const [id,bytes,role] of [
 ['',Uint8Array.of(1),'frame'],['../source',Uint8Array.of(1),'frame'],['x'.repeat(129),Uint8Array.of(1),'frame'],['reserved_1',[], 'frame'],['reserved_1',new Uint8Array(), 'frame'],['reserved_1',new Uint8Array(MAX+1),'frame'],['reserved_1',Uint8Array.of(1),''],['reserved_1',Uint8Array.of(1),'Frame'],['reserved_1',Uint8Array.of(1),'frame/path'],['reserved_1',Uint8Array.of(1),'a'.repeat(65)]
])test('invalid create input rejects before parent request '+String(id).slice(0,20)+' / '+role,()=>{
 const f=fixture();assert.throws(()=>f.io.createFile(id,bytes,role),/STORE_CREATE_INVALID/);assert.equal(f.count('fetch'),0);assert.equal(f.count('blob'),0);assert.equal(f.count('create'),0);
});

for(const locked of [false,undefined,1,'true'])test('read/create/allocate require exact true lock ownership '+String(locked),()=>{
 const f=fixture({locked});for(const action of [()=>f.io.readFile('frame_1'),()=>f.io.createFile('reserved_1',Uint8Array.of(1),'frame'),()=>f.io.allocateIds(1)])assert.throws(action,/STORE_LOCK_REQUIRED/);assert.equal(f.count('fetch'),0);assert.equal(f.count('create'),0);assert.equal(f.count('generateIds'),0);assert.equal(f.count('release'),0);
});

test('all paths leave acquisition/release to the caller',()=>{
 const f=fixture();f.add();f.io.readFile('frame_1');f.io.allocateIds(1);f.io.createFile('new_frame',Uint8Array.of(1),'frame');assert.equal(f.state.locked,true);assert.equal(f.count('release'),0);
});

test('expired budget prevents reads, ID generation and creates',()=>{
 const f=fixture({budget:false});for(const action of [()=>f.io.readFile('frame_1'),()=>f.io.allocateIds(1),()=>f.io.createFile('new_frame',Uint8Array.of(1),'frame')])assert.throws(action,errorIs('STORE_YIELD',true));assert.equal(f.count('fetch'),0);assert.equal(f.count('generateIds'),0);assert.equal(f.count('blob'),0);assert.equal(f.count('create'),0);
});

test('budget is rechecked between metadata and media requests',()=>{
 const f=fixture();f.add();f.state.afterMetadataFetch=()=>{f.state.budget=false;};assert.throws(()=>f.io.readFile('frame_1'),errorIs('STORE_YIELD',true));assert.equal(f.count('fetch'),2);assert.equal(f.count('media-body'),0);
});

test('budget consumed by parent lookup prevents starting a create',()=>{
 const f=fixture();f.state.afterParentFetch=()=>{f.state.budget=false;};assert.throws(()=>f.io.createFile('new_frame',Uint8Array.of(1),'frame'),errorIs('STORE_YIELD',true));assert.equal(f.count('create'),0);
});

test('lock lost during parent lookup prevents starting a create',()=>{
 const f=fixture();f.state.afterParentFetch=()=>{f.state.locked=false;};assert.throws(()=>f.io.createFile('new_frame',Uint8Array.of(1),'frame'),/STORE_LOCK_REQUIRED/);assert.equal(f.count('create'),0);assert.equal(f.count('release'),0);
});

test('ID generation uses explicit Drive file space/count with no persisted writes',()=>{
 const f=fixture();assert.deepEqual(f.io.allocateIds(3),['reserved_0','reserved_1','reserved_2']);assert.deepEqual(f.events.find(e=>e[0]==='generateIds')[1],{count:3,space:'drive',type:'files'});assert.equal(f.count('create'),0);assert.equal(f.count('fetch'),0);
});

for(const n of [0,-1,1001,1.5,NaN,Infinity,'1',null])test('invalid generation count is rejected '+String(n),()=>{
 const f=fixture();assert.throws(()=>f.io.allocateIds(n),/STORE_ID_COUNT/);assert.equal(f.count('generateIds'),0);
});

for(const generated of [null,{}, {ids:'one'}, {ids:[]}, {ids:['one']}, {ids:['one','one']}, {ids:['one',null]}, {ids:['one','../bad']}, {ids:['one','x'.repeat(129)]}])test('malformed/duplicate generated IDs are rejected '+JSON.stringify(generated),()=>{
 const f=fixture({generated});assert.throws(()=>f.io.allocateIds(2),/STORE_IDS_INVALID/);assert.equal(f.count('create'),0);
});

test('ID generation failure is sanitized and retryable',()=>{
 const f=fixture({idsThrow:true});assert.throws(()=>f.io.allocateIds(1),errorIs('STORE_IDS_UNRESOLVED',true));assert.equal(f.count('create'),0);
});

for(const badId of ['','../escape','source?alt=media','https://example.test/','x'.repeat(129),null,42])test('unsafe read ID is rejected before token or request '+String(badId),()=>{
 const f=fixture();assert.throws(()=>f.io.readFile(badId),/STORE_ID_INVALID/);assert.equal(f.count('token'),0);assert.equal(f.count('fetch'),0);
});

test('original source file cannot be read as managed data, overwritten, moved, or deleted',()=>{
 const f=fixture(),original={metadata:copy(f.source),bytes:Array.from(f.files.get('source_csv').bytes)};
 assert.throws(()=>f.io.readFile('source_csv'),/STORE_METADATA_MISMATCH/);
 assert.throws(()=>f.io.createFile('source_csv',Uint8Array.of(9,9,9),'frame'),/409/);
 f.io.createFile('managed_new',Uint8Array.of(1),'frame');
 assert.deepEqual(f.files.get('source_csv').metadata,original.metadata);assert.deepEqual(Array.from(f.files.get('source_csv').bytes),original.bytes);
 assert.ok(f.events.filter(e=>e[0]==='create').every(e=>e[1].parents.length===1&&e[1].parents[0]==='managed_parent'));
 assert.equal(f.count('release'),0);
});


test('exact maximum byte bound is accepted and over-bound caller sizes are not',()=>{
 const f=fixture(),bytes=new Uint8Array(MAX);bytes[0]=128;bytes[MAX-1]=255;f.add('max_frame',bytes);assert.deepEqual(f.io.readFile('max_frame',MAX),bytes);
 f.io.createFile('max_created',bytes,'frame');assert.deepEqual(f.io.readFile('max_created',MAX),bytes);assert.equal(f.files.get('max_created').bytes.length,MAX);
});

test('maximum generation count is accepted, unique and bounded',()=>{
 const f=fixture();const ids=f.io.allocateIds(1000);assert.equal(ids.length,1000);assert.equal(new Set(ids).size,1000);assert.equal(f.count('generateIds'),1);
});

function prefetchFixture({mode='lock-phase'}={}){
 const f=fixture(),batches=[];let io;
 const read=(id,suffix,headers={})=>f.config.UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+id+suffix,{method:'get',headers});
 const transport={read,readMany(requests){batches.push(copy(requests));const out=requests.map(r=>read(r.id,r.suffix,r.headers));f.onBatch?.(requests,out,io);return out;},generateIds(){throw Error('no writes');},create(){throw Error('no writes');},update(){throw Error('no writes');},advisory(){throw Error('no writes');},canStartAdvisory:()=>false};
 io=new GasStoreIO({...f.config,protocolReadCache:{mode},restTransport:transport,checkpointHintId:'hint'});io.beginReadPhase();return {...f,io,batches,source:f};
}

test('prefetch verifies parent, batch metadata and exact ranged bytes before filling the same lock-phase cache',()=>{
 const f=prefetchFixture(),a=f.add('frame_a'),b=f.add('frame_b');assert.equal(f.io.prefetchFiles(['frame_a','frame_b','missing','frame_a']),2);assert.equal(f.batches.length,2);assert.equal(f.batches[0].length,3);assert.equal(f.batches[1].length,2);assert(f.batches[1].every(r=>r.headers.Range==='bytes=0-4'));
 const before=f.count('fetch');assert.deepEqual(f.io.readFile('frame_a'),a.bytes);assert.deepEqual(f.io.readFile('frame_b'),b.bytes);assert.equal(f.count('fetch'),before);assert.equal(f.io.prefetchFiles(['frame_a','frame_b']),0);assert.equal(f.count('fetch'),before);
 assert.equal(f.io.readFile('missing'),null);assert.equal(f.count('fetch'),before+1);const delayed=f.add('missing');assert.deepEqual(f.io.readFile('missing'),delayed.bytes);assert.equal(f.count('fetch'),before+3,'404 was not cached');
});

test('prefetch validates all IDs and bounds before any lock, token, parent or network access',()=>{
 for(const [ids,bound]of [[['frame_a','../other'],MAX],[Array.from({length:17},(_,i)=>'f'+i),MAX],[['frame_a'],0],[['frame_a','hint'],MAX],[null,MAX]]){const f=prefetchFixture(),before=f.events.length;assert.throws(()=>f.io.prefetchFiles(ids,bound));assert.equal(f.events.length,before);assert.equal(f.batches.length,0);}
});

test('prefetch never keeps metadata or bytes outside a continuously owned lock-phase cache',()=>{
 const f=prefetchFixture({mode:'bytes'});f.add();const before=f.count('fetch');assert.equal(f.io.prefetchFiles(['frame_1']),0);assert.equal(f.count('fetch'),before);
 const g=prefetchFixture();g.add();g.io.endReadPhase();assert.equal(g.io.prefetchFiles(['frame_1']),0);assert.equal(g.count('fetch'),0);
 g.state.locked=false;assert.throws(()=>g.io.prefetchFiles(['frame_1']),/STORE_LOCK_REQUIRED/);
});

test('prefetch rejects unprivate parent and every malformed file metadata before any batch media read',()=>{
 for(const mutation of [f=>{f.state.parent={...f.parent,shared:true};},f=>{f.files.get('frame_b').metadata.shared=true;},f=>{f.files.get('frame_b').metadata.parents=['foreign'];},f=>{f.files.get('frame_b').metadata.appProperties['mypace.store']='foreign';},f=>{f.files.get('frame_b').metadata.size='2097153';},f=>{f.files.get('frame_b').metadata.appProperties['mypace.role']='source-discovery';}]){
  const f=prefetchFixture();f.add('frame_a');f.add('frame_b');mutation(f);assert.throws(()=>f.io.prefetchFiles(['frame_a','frame_b']));assert.equal(f.batches.filter(batch=>batch[0]?.suffix==='?alt=media').length,0);assert.equal(f.io._readCache.size,0);assert.equal(f.io._readCacheActive,false);
 }
});

test('prefetch rechecks lock and exact phase after metadata and media, never publishing interrupted bytes',()=>{
 for(const at of ['metadata','media'])for(const mode of ['lost','changed']){
  const f=prefetchFixture();f.add('frame_a');f.source.onBatch=(requests,_,io)=>{if((requests[0].suffix==='?alt=media'?'media':'metadata')!==at)return;if(mode==='lost')f.state.locked=false;else{io.endReadPhase();io.beginReadPhase();}};
  assert.throws(()=>f.io.prefetchFiles(['frame_a']),new RegExp(mode==='lost'?'STORE_LOCK_REQUIRED':'STORE_READ_PHASE_CHANGED'));assert.equal(f.io._readCache.size,0);assert.equal(f.io._readCacheActive,false);
 }
});

test('prefetch has atomic positive-cache publication when one media result is malformed or incomplete',()=>{
 for(const mutation of [r=>({...r,getResponseCode:()=>200}),r=>({...r,getAllHeaders:()=>({'Content-Range':'bytes 0-3/5'})}),r=>({...r,getAllHeaders:()=>({'Content-Range':'bytes 0-4/5','Content-Encoding':'gzip'})}),r=>({...r,getContent:()=>[0,1,2]}),r=>({...r,getContent:()=>[0,1,2,3,256]})]){
  const f=prefetchFixture();f.add('frame_a');f.add('frame_b');f.source.onBatch=(requests,responses)=>{if(requests[0].suffix==='?alt=media')responses[1]=mutation(responses[1]);};assert.throws(()=>f.io.prefetchFiles(['frame_a','frame_b']));assert.equal(f.io._readCache.size,0);assert.equal(f.io._readCacheActive,false);
 }
});

test('prefetch privacy and bytes are freshly verified after a later lock phase',()=>{
 const f=prefetchFixture();f.add('frame_a');assert.equal(f.io.prefetchFiles(['frame_a']),1);f.io.endReadPhase();f.files.get('frame_a').metadata.shared=true;f.io.beginReadPhase();assert.throws(()=>f.io.prefetchFiles(['frame_a']),/STORE_METADATA_MISMATCH/);assert.equal(f.io._readCache.size,0);
});

function batchCreateFixture(){
 const f=fixture(),parentBatches=[],creates=[];
 const read=(id,suffix,headers={})=>f.config.UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+id+suffix,{method:'get',headers});
 const transport={read,readMany(requests){parentBatches.push(copy(requests));const responses=requests.map(r=>read(r.id,r.suffix,r.headers));f.afterParents?.(responses);return responses;},createMany(proposals){creates.push(proposals);if(f.createFailure)throw Error('STORE_REQUEST_UNRESOLVED');return proposals.map(p=>({id:p.metadata.id}));},generateIds(){throw Error('no ID allocation');},create(){throw Error('no serial fallback');},update(){throw Error('no mutable writes');},advisory(){throw Error('no advisory writes');},canStartAdvisory:()=>false};
 const io=new GasStoreIO({...f.config,restTransport:transport,checkpointHintId:'hint',protocolReadCache:{mode:'lock-phase'}});io.beginReadPhase();return {...f,io,parentBatches,creates,source:f};
}
const batchNode=(id='node_a',bytes=Uint8Array.of(1,2,3))=>({id,role:'index-node',bytes});

test('createMany rechecks managed-parent privacy once per node despite an already warm positive cache',()=>{
 const f=batchCreateFixture();f.add('old');f.io.readFile('old');const before=f.count('fetch');const files=[batchNode('stable_a'),batchNode('stable_b')];assert.deepEqual(f.io.createMany(files),[{id:'stable_a'},{id:'stable_b'}]);assert.equal(f.count('fetch')-before,2);assert.equal(f.parentBatches.length,1);assert(f.parentBatches[0].every(r=>r.id==='managed_parent'));assert.equal(f.creates.length,1);assert.equal(f.io._readCache.has('stable_a'),false);assert.equal(f.io._readCache.has('stable_b'),false);
 const proposals=f.creates[0];assert(proposals.every(p=>p.metadata.appProperties['mypace.role']==='index-node'&&p.metadata.parents[0]==='managed_parent'));assert.deepEqual(proposals.map(p=>p.metadata.id),files.map(f=>f.id));
});

test('createMany validates all output IDs, byte bounds and immutable roles before parent checks or creates',()=>{
 for(const files of [[batchNode('ok'),batchNode('../bad')],[batchNode('same'),batchNode('same')],[batchNode('hint')],[{...batchNode(),role:'frame'}],[batchNode('a',new Uint8Array(600000)),batchNode('b',new Uint8Array(600000))],Array.from({length:5},(_,i)=>batchNode('n'+i))]){const f=batchCreateFixture(),before=f.events.length;assert.throws(()=>f.io.createMany(files));assert.equal(f.events.length,before);assert.equal(f.parentBatches.length,0);assert.equal(f.creates.length,0);}
});

test('createMany refuses every POST when any one fresh parent response is unprivate or lock ownership changes',()=>{
 for(const mode of ['parent','lock','budget']){const f=batchCreateFixture();f.source.afterParents=responses=>{if(mode==='parent')responses[1]={getResponseCode:()=>200,getContentText:()=>JSON.stringify({...f.parent,shared:true})};else if(mode==='lock')f.state.locked=false;else f.state.budget=false;};assert.throws(()=>f.io.createMany([batchNode('a'),batchNode('b')]));assert.equal(f.creates.length,0);}
});

test('createMany clears stale same-ID byte cache and preserves original input snapshot before ambiguous create',()=>{
 const f=batchCreateFixture();f.add('stable_a',Uint8Array.of(9,9,9));f.io.readFile('stable_a');assert(f.io._readCache.has('stable_a'));const input=batchNode('stable_a');f.source.afterParents=()=>{input.bytes[0]=255;};f.source.createFailure=true;assert.throws(()=>f.io.createMany([input]),e=>e.message==='STORE_CREATE_UNRESOLVED'&&e.retryable===true);assert.equal(f.creates.length,1);assert.equal(f.creates[0][0].bytes[0],1);assert.equal(f.io._readCache.has('stable_a'),false);assert.equal(f.count('generateIds'),0);
});

test('native createMany fallback normalizes only post-admission response loss or conflict for same-ID readback',()=>{
 for(const kind of ['before','after','409']){const f=fixture({createFailure:kind==='409'?undefined:kind});if(kind==='409')f.add('stable_node');assert.throws(()=>f.io.createMany([batchNode('stable_node')]),e=>e.message==='STORE_CREATE_UNRESOLVED'&&e.retryable===true);assert.equal(f.count('create'),1);assert.equal(f.count('generateIds'),0);if(kind!=='before')assert(f.files.has('stable_node'));}
 const f=fixture({parent:{id:'managed_parent',mimeType:'application/vnd.google-apps.folder',ownedByMe:true,trashed:false,shared:true}});assert.throws(()=>f.io.createMany([batchNode()]),e=>e.message==='STORE_PARENT_NOT_PRIVATE'&&e.retryable!==true);assert.equal(f.count('create'),0);
 const g=fixture({locked:false});assert.throws(()=>g.io.createMany([batchNode()]),/STORE_LOCK_REQUIRED/);assert.equal(g.count('create'),0);
});

test('malformed post-dispatch createMany IDs are typed may-have-created outcomes, never readback proof',()=>{
 for(const result of [null,[],[{}],[{id:'foreign'}]]){const f=batchCreateFixture();f.io.restTransport.createMany=()=>result;assert.throws(()=>f.io.createMany([batchNode('stable')]),e=>e.code==='STORE_CREATE_UNRESOLVED'&&e.retryable===true&&e.mayHaveCreated===true);assert.equal(f.io._readCache.has('stable'),false);}
});

function recoveryReadFixture(){const f=prefetchFixture();f.add('anchor').metadata.appProperties['mypace.role']='bootstrap';f.add('hint',Uint8Array.of(1,2,3)).metadata.appProperties['mypace.role']='checkpoint-hint';return f;}

test('recovery prefetch batches anchor and fixed hint behind fresh parent proof and caches only the anchor',()=>{
 const f=recoveryReadFixture(),result=f.io.prefetchRecoveryRead('anchor');assert.deepEqual(result.hintBytes,Uint8Array.of(1,2,3));assert.equal(f.batches.length,2);assert.deepEqual(f.batches[0].map(r=>r.id),['anchor','hint']);assert.deepEqual(f.batches[1].map(r=>r.id),['anchor','hint']);assert(f.io._readCache.has('anchor'));assert.equal(f.io._readCache.has('hint'),false);
 const before=f.count('fetch');f.io.readFile('anchor');assert.equal(f.count('fetch'),before);f.files.get('hint').bytes[0]=9;const fresh=f.io.readCheckpointHint();assert.equal(fresh[0],9);assert.equal(f.count('fetch')-before,3,'later hint read rechecks parent, hint metadata and media');
});

test('recovery prefetch skips absent, corrupt, foreign, shared and denied hint metadata without another hint route',()=>{
 const mutations=[f=>f.files.delete('hint'),f=>{f.files.get('hint').metadata.shared=true;},f=>{f.files.get('hint').metadata.appProperties['mypace.store']='foreign';},f=>{f.files.get('hint').metadata.appProperties['mypace.role']='frame';},f=>{f.files.get('hint').metadata.size='4097';},f=>{f.source.onBatch=(requests,responses)=>{if(requests[0].suffix!=='?alt=media')responses[1]={getResponseCode:()=>403};};},f=>{f.source.onBatch=(requests,responses)=>{if(requests[0].suffix!=='?alt=media')responses[1]={getResponseCode:()=>200,getContentText:()=>'{'};};}];
 for(const mutate of mutations){const f=recoveryReadFixture();mutate(f);assert.deepEqual(f.io.prefetchRecoveryRead('anchor'),{hintBytes:null});assert(f.io._readCache.has('anchor'));assert.equal(f.io._readCache.has('hint'),false);assert.deepEqual(f.batches.filter(b=>b[0].suffix==='?alt=media').flat().map(r=>r.id),['anchor']);}
});

test('recovery prefetch treats anchor identity/privacy strictly and never publishes a partial batch on media or phase failure',()=>{
 for(const mode of ['anchor-role','anchor-privacy','phase','lock']){
  const f=recoveryReadFixture();if(mode==='anchor-role')f.files.get('anchor').metadata.appProperties['mypace.role']='frame';if(mode==='anchor-privacy')f.files.get('anchor').metadata.shared=true;
  f.source.onBatch=(requests,responses,io)=>{if(requests[0].suffix!=='?alt=media')return;if(mode==='hint-range')responses[1]={...responses[1],getAllHeaders:()=>({'Content-Range':'bytes 0-1/3'})};if(mode==='phase'){io.endReadPhase();io.beginReadPhase();}if(mode==='lock')f.state.locked=false;};
  assert.throws(()=>f.io.prefetchRecoveryRead('anchor'));assert.equal(f.io._readCache.size,0);assert.equal(f.io._readCacheActive,false);
 }
});

test('recovery prefetch validates caller bounds before IO and declines unsupported cache modes without touching storage',()=>{
 const f=recoveryReadFixture();for(const [id,bound]of [['../bad',MAX],['hint',MAX],['managed_parent',MAX],['anchor',0]]){const before=f.events.length;assert.throws(()=>f.io.prefetchRecoveryRead(id,bound));assert.equal(f.events.length,before);}
 const g=prefetchFixture({mode:'bytes'});assert.equal(g.io.prefetchRecoveryRead('anchor'),undefined);assert.equal(g.count('fetch'),0);
});

test('hint-only range, header, body, and 404-after-metadata faults cannot block strictly verified anchor recovery',()=>{
 const failures=[r=>({...r,getResponseCode:()=>404}),r=>({...r,getResponseCode:()=>403}),r=>({...r,getResponseCode:()=>200}),r=>({...r,getAllHeaders:()=>({'Content-Range':'bytes 0-1/3'})}),r=>({...r,getAllHeaders:()=>({'Content-Range':'bytes 0-2/3','Content-Encoding':'gzip'})}),r=>({...r,getContent:()=>[1,2]}),r=>({...r,getContent:()=>[1,2,256]})];
 for(const fault of failures){const f=recoveryReadFixture();f.source.onBatch=(requests,responses)=>{if(requests[0].suffix==='?alt=media')responses[1]=fault(responses[1]);};assert.deepEqual(f.io.prefetchRecoveryRead('anchor'),{hintBytes:null});assert(f.io._readCache.has('anchor'));assert.equal(f.io._readCache.has('hint'),false);assert.equal(f.batches.length,2);}
});

test('unknown shared recovery-batch transport failures discard candidate proof and use anchor-only fallback',()=>{
 for(const at of ['metadata','media']){const f=recoveryReadFixture();f.source.onBatch=requests=>{if((requests[0].suffix==='?alt=media'?'media':'metadata')===at)throw Error('unknown batch transport failure');};assert.deepEqual(f.io.prefetchRecoveryRead('anchor'),{hintBytes:null});assert.equal(f.io._readCache.size,0);assert.equal(f.io._readCacheActive,true);const count=f.batches.length;assert(f.io.readFile('anchor').length>0);assert.equal(f.batches.length,count);assert.equal(f.io._readCache.has('hint'),false);}
});

test('shared recovery-batch fallback cannot cross a lost lock, changed phase or exhausted budget',()=>{
 for(const mode of ['lock','phase','budget']){const f=recoveryReadFixture();f.source.onBatch=(_,__,io)=>{if(mode==='lock')f.state.locked=false;if(mode==='phase'){io.endReadPhase();io.beginReadPhase();}if(mode==='budget')f.state.budget=false;throw Error('ambiguous batch failure');};assert.throws(()=>f.io.prefetchRecoveryRead('anchor'),new RegExp(mode==='lock'?'STORE_LOCK_REQUIRED':mode==='phase'?'STORE_READ_PHASE_CHANGED':'STORE_YIELD'));assert.equal(f.io._readCache.size,0);assert.equal(f.io._readCacheActive,false);}
});

// Explicit, bounded managed-store optimization; legacy default tests above stay unchanged.
function managedFixture({proof=true,mutate}={}){
 const f=fixture(),create=f.config.Drive.Files.create;
 f.config.Drive.Files.create=(meta,blob,request)=>{const result=create(meta,blob,request),entry=f.files.get(result.id);return proof?{...entry.metadata,version:'1',sha256Checksum:new IncrementalSha256().update(entry.bytes).digestHex(),...(mutate?mutate(entry.metadata):{})}:result;};
 const io=new GasStoreIO({...f.config,managedWritePhase:true,protocolReadCache:{mode:'lock-phase'}});io.beginReadPhase();return {...f,io};
}
test('managed successful create reuses exact SHA-256 storage proof within one held phase',()=>{
 const f=managedFixture(),b=Uint8Array.of(1,2,255);f.io.createFile('one',b,'frame');b[0]=9;const n=f.count('fetch');assert.deepEqual(f.io.readFile('one'),Uint8Array.of(1,2,255));assert.equal(f.count('fetch'),n);
 f.io.createFile('two',b,'frame');assert.equal(f.count('fetch'),n,'same parent is verified once');
 f.io.endReadPhase();f.io.beginReadPhase();f.io.readFile('one');assert.equal(f.count('fetch'),n+3,'new phase reads parent metadata and exact object again');
});
for(const [field,value]of Object.entries({id:'other',parents:['foreign'],size:'99',ownedByMe:false,shared:true,trashed:true,mimeType:'text/plain',version:undefined,sha256Checksum:'0'.repeat(64),appProperties:{'mypace.store':'store_1','mypace.role':'wrong'}}))test('managed create cannot cache invalid '+field,()=>{
 const f=managedFixture({mutate:()=>({[field]:value})});if(field==='id'){assert.throws(()=>f.io.createFile('one',Uint8Array.of(1),'frame'),/STORE_CREATE_ID_MISMATCH/);return;}
 f.io.createFile('one',Uint8Array.of(1),'frame');const n=f.count('fetch');assert.deepEqual(f.io.readFile('one'),Uint8Array.of(1));assert.equal(f.count('fetch'),n+2,'missing or invalid proof uses exact-ID readback');
});
test('managed optional checksum absence and lost successful response retain exact-ID recovery',()=>{
 for(const mode of ['missing','lost']){const f=managedFixture({proof:mode!=='missing'});if(mode==='lost')f.state.createFailure='after';try{f.io.createFile('one',Uint8Array.of(1),'frame');}catch(error){assert.equal(mode,'lost');}const n=f.count('fetch');assert.deepEqual(f.io.readFile('one'),Uint8Array.of(1));assert.equal(f.count('fetch'),n+2);}
});
test('managed cache invalidates before same-ID ambiguity and after lock loss',()=>{
 const f=managedFixture();f.io.createFile('one',Uint8Array.of(1),'frame');assert.throws(()=>f.io.createFile('one',Uint8Array.of(2),'frame'),/409/);const n=f.count('fetch');assert.deepEqual(f.io.readFile('one'),Uint8Array.of(1));assert.equal(f.count('fetch'),n+2);
 f.state.locked=false;assert.throws(()=>f.io.readFile('one'),/STORE_LOCK_REQUIRED/);f.state.locked=true;f.io.beginReadPhase();const m=f.count('fetch');f.io.readFile('one');assert.equal(f.count('fetch'),m+3);
});
