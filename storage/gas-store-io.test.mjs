import test from 'node:test';
import assert from 'node:assert/strict';
import {GasStoreIO} from './gas-store-io.mjs';

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
 const calls=f.events.filter(e=>e[0]==='fetch');assert.equal(calls.length,2);
 assert.equal(calls[0][1],'https://www.googleapis.com/drive/v3/files/frame_1?fields='+encodeURIComponent('id,parents,appProperties,size,trashed,mimeType,ownedByMe,shared'));
 assert.equal(calls[1][1],'https://www.googleapis.com/drive/v3/files/frame_1?alt=media');
 for(const [,url,request] of calls){assert.equal(new URL(url).origin,'https://www.googleapis.com');assert.equal(request.headers.Authorization,'Bearer test_token');assert.equal(request.muteHttpExceptions,true);assert.equal(request.followRedirects,false);assert.equal(request.method,'get');}
 assert.equal(calls[1][2].headers.Range,'bytes=0-4');assert.equal(calls[1][2].headers['Accept-Encoding'],'identity');assert.equal(f.count('create'),0);
});

test('404 alone returns absent without reading error body, media, or issuing writes',()=>{
 const f=fixture();assert.equal(f.io.readFile('missing_1'),null);assert.equal(f.count('fetch'),1);assert.equal(f.count('metadata-body'),0);assert.equal(f.count('media-body'),0);assert.equal(f.count('create'),0);
});

for(const status of [200.1,201,204,301,302,400,401,403,409,429,500,503])test(`metadata status ${status} remains unresolved, never absent`,()=>{
 const f=fixture({metadataStatus:status});
 assert.throws(()=>f.io.readFile('missing_1'),errorIs('STORE_METADATA_UNRESOLVED',true,status));
 assert.equal(f.count('metadata-body'),0);assert.equal(f.count('media-body'),0);assert.equal(f.count('generateIds'),0);assert.equal(f.count('create'),0);
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
 const f=fixture({metadataStatus:200,metadataText:JSON.stringify(value)});assert.throws(()=>f.io.readFile('frame_1'));assert.equal(f.count('fetch'),1);assert.equal(f.count('media-body'),0);
});

for(const [name,mutate] of [
 ['wrong ID',m=>m.id='other'],['missing ID',m=>delete m.id],['trashed',m=>m.trashed=true],['missing trash state',m=>delete m.trashed],['not owned',m=>m.ownedByMe=false],['missing owner',m=>delete m.ownedByMe],['shared',m=>m.shared=true],['unknown sharing',m=>delete m.shared],['string sharing',m=>m.shared='false'],['wrong MIME',m=>m.mimeType='text/csv'],['folder MIME',m=>m.mimeType='application/vnd.google-apps.folder'],['missing parent',m=>delete m.parents],['string parent',m=>m.parents='managed_parent'],['source parent',m=>m.parents=['source_parent']],['extra parent',m=>m.parents.push('source_parent')],['no parent',m=>m.parents=[]],['wrong store',m=>m.appProperties['mypace.store']='another_store'],['no marker',m=>delete m.appProperties],['null marker',m=>m.appProperties=null]
])test(`rejects ${name} before media read`,()=>{
 const f=fixture();mutate(f.add().metadata);assert.throws(()=>f.io.readFile('frame_1'),/STORE_METADATA_MISMATCH/);assert.equal(f.count('fetch'),1);assert.equal(f.count('media-body'),0);
});

for(const size of [undefined,null,'',' 5','5 ','+5','-5','1.5','5e0','0','9007199254740992',String(MAX+1),true,{}])test('rejects invalid metadata size '+JSON.stringify(size),()=>{
 const f=fixture();f.add().metadata.size=size;assert.throws(()=>f.io.readFile('frame_1'),/STORE_SIZE_INVALID/);assert.equal(f.count('fetch'),1);
});

test('caller read ceiling is enforced before media',()=>{
 const f=fixture();f.add();assert.throws(()=>f.io.readFile('frame_1',4),/STORE_SIZE_INVALID/);assert.equal(f.count('fetch'),1);
});

for(const limit of [0,-1,1.5,NaN,Infinity,MAX+1,'5',null])test('invalid read bound makes no request '+String(limit),()=>{
 const f=fixture();assert.throws(()=>f.io.readFile('frame_1',limit),/STORE_READ_BOUND/);assert.deepEqual(f.events,[]);
});

for(const status of [200,201,204,301,302,400,401,403,404,409,416,429,500,503])test(`media status ${status} rejects without whole-body fallback`,()=>{
 const f=fixture({mediaStatus:status});f.add();assert.throws(()=>f.io.readFile('frame_1'),errorIs('STORE_RANGE_STATUS',true,status));assert.equal(f.count('fetch'),2);assert.equal(f.count('headers'),0);assert.equal(f.count('media-body'),0);
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
 const f=fixture();f.add();let checks=0;f.state.budget=()=>++checks<2;assert.throws(()=>f.io.readFile('frame_1'),errorIs('STORE_YIELD',true));assert.equal(f.count('fetch'),1);assert.equal(f.count('media-body'),0);
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
