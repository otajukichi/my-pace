// Synthetic owner-manual placement only. No code moves any Drive object.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {ownerBootstrapFixture} from './owner-bootstrap-fixture.mjs';
import {OWNER_STORE_PROPERTY} from './owner-bootstrap.mjs';
const DESTINATION='1kqtRzzNKZAq7-HE83XIN_JErtBn9YM_6';
const FOLDER='application/vnd.google-apps.folder';
const methods=['load','loadRecoveryConfiguration','bootstrap','repairRecoveryConfiguration'];
const writes=f=>f.events.filter(e=>['create','update','property-write','ids'].includes(e[0]));
function fixture(){
 const f=ownerBootstrapFixture();f.properties.set('MYPACE_WRITER_SECRET','synthetic-existing-owner-secret-with-more-than-32-bytes');
 Object.assign(f.globals.Utilities,{Charset:{UTF_8:'utf8'},computeHmacSha256Signature:(text,key)=>Array.from(createHmac('sha256',key).update(text).digest())});
 f.files.set(DESTINATION,{meta:{id:DESTINATION,name:'my-pace',mimeType:FOLDER,parents:['mydrive'],ownedByMe:true,shared:false,trashed:false}});
 const config=f.bootstrap();return {...f,config};
}
function manuallyMove(f,parent=DESTINATION){f.files.get(f.config.rootParentId).meta.parents=[parent];}

test('manual move keeps exact pinned root, config and immutable bytes and every owner path accepts it',()=>{
 const f=fixture(),originalConfig=f.properties.get(OWNER_STORE_PROPERTY),anchor=structuredClone(f.files.get(f.config.anchorId)),writeCount=writes(f).length;
 manuallyMove(f);const files=structuredClone(f.files);
 for(const method of methods)assert.deepEqual(f.api()[method](),f.config);
 assert.deepEqual(f.files,files);assert.deepEqual(f.files.get(f.config.anchorId),anchor);assert.equal(f.properties.get(OWNER_STORE_PROPERTY),originalConfig);assert.equal(writes(f).length,writeCount);
 assert.ok(f.events.filter(e=>e[0]==='fetch'&&e[1]===DESTINATION).length>=methods.length);
});

test('bootstrap creates only in original My Drive even if destination exists or options request another parent',()=>{
 const f=ownerBootstrapFixture();f.files.set(DESTINATION,{meta:{id:DESTINATION,name:'my-pace',mimeType:FOLDER,ownedByMe:true,shared:false,trashed:false}});
 const c=f.api({rootParentId:DESTINATION,placementParentId:'arbitrary',destinationParentId:'other'}).bootstrap();const rootCreate=f.events.find(e=>e[0]==='create'&&e[1].id===c.rootParentId);
 assert.deepEqual(rootCreate[1].parents,['mydrive']);assert.equal(f.events.some(e=>e[0]==='fetch'&&e[1]===DESTINATION),false);
});

test('original placement remains valid without contacting the alternate destination',()=>{const f=fixture();f.files.delete(DESTINATION);const count=f.events.length;assert.deepEqual(f.api().load(),f.config);assert.equal(f.events.slice(count).some(e=>e[0]==='fetch'&&e[1]===DESTINATION),false);});

for(const parent of ['arbitrary','probe-folder','named-my-pace','source-folder'])test(`manual placement at unapproved ${parent} is rejected without writes`,()=>{const f=fixture();f.files.set(parent,{meta:{id:parent,name:'my-pace',mimeType:FOLDER,ownedByMe:true,shared:false,trashed:false}});manuallyMove(f,parent);const before=writes(f).length;for(const method of methods)assert.throws(()=>f.api()[method](),/FOLDER_MISMATCH/);assert.equal(writes(f).length,before);});

for(const [name,mutate] of [
 ['wrong owner',m=>{m.ownedByMe=false;}],['shared',m=>{m.shared=true;}],['trashed',m=>{m.trashed=true;}],['not folder',m=>{m.mimeType='text/plain';}],['wrong ID',m=>{m.id='other';}],['missing owner field',m=>{delete m.ownedByMe;}],['missing privacy field',m=>{delete m.shared;}],['missing trash field',m=>{delete m.trashed;}]
])test(`fixed destination ${name} blocks load, repair and bootstrap retry`,()=>{const f=fixture();manuallyMove(f);mutate(f.files.get(DESTINATION).meta);const before=writes(f).length;for(const method of methods)assert.throws(()=>f.api()[method](),/PLACEMENT_INVALID/);assert.equal(writes(f).length,before);});

test('missing or inaccessible fixed destination cannot become permission to recreate or move a store',()=>{
 for(const status of [404,403,429,503]){const f=fixture();manuallyMove(f);f.state.fetchFault=id=>id===DESTINATION?f.response(status,'{}'):null;const before=writes(f).length;for(const method of methods)assert.throws(()=>f.api()[method](),/PLACEMENT_INVALID|READ_UNRESOLVED/);assert.equal(writes(f).length,before);}
});

test('a moved root still requires exact one parent and every original identity marker',()=>{
 for(const mutate of [m=>{m.parents=['mydrive',DESTINATION];},m=>{m.parents=[];},m=>{m.id='different';},m=>{m.shared=true;},m=>{m.ownedByMe=false;},m=>{m.appProperties['mypace.store']='other';},m=>{m.appProperties['mypace.script']='other';},m=>{m.appProperties['mypace.role']='store-metadata';},m=>{m.appProperties['mypace.bootstrap']='different';}]){const f=fixture();manuallyMove(f);mutate(f.files.get(f.config.rootParentId).meta);const before=writes(f).length;assert.throws(()=>f.api().load(),/FOLDER_MISMATCH/);assert.throws(()=>f.bootstrap(),/FOLDER_MISMATCH/);assert.equal(writes(f).length,before);}
});

test('root and destination display-name changes remain harmless and do not cause name adoption',()=>{const f=fixture();manuallyMove(f);f.files.get(f.config.rootParentId).meta.name='Renamed private storage';f.files.get(DESTINATION).meta.name='Owner renamed my-pace';const before=writes(f).length;assert.deepEqual(f.api().load(),f.config);assert.deepEqual(f.bootstrap(),f.config);assert.equal(writes(f).length,before);});

for(const key of ['metadataParentId','assetsParentId'])test(`manual root allowance does not relax ${key} exact parent validation`,()=>{const f=fixture();manuallyMove(f);f.files.get(f.config[key]).meta.parents=[DESTINATION];const before=writes(f).length;for(const method of methods)assert.throws(()=>f.api()[method](),/FOLDER_MISMATCH/);assert.equal(writes(f).length,before);});

test('child-parent rechecks validate destination again before any missing child can be created',()=>{
 const f=fixture();manuallyMove(f);f.files.delete(f.config.metadataParentId);let visits=0;f.state.fetchFault=id=>{if(id===DESTINATION&&++visits===2)return f.response(200,JSON.stringify({...f.files.get(DESTINATION).meta,shared:true}));return null;};const before=writes(f).length;
 assert.throws(()=>f.bootstrap(),/PLACEMENT_INVALID/);assert.equal(writes(f).length,before);
});

test('retry can create a missing pre-reserved child under moved root without moving/adopting anything',()=>{
 const f=fixture();manuallyMove(f);f.files.delete(f.config.assetsParentId);const before=writes(f).length;assert.deepEqual(f.bootstrap(),f.config);const changes=writes(f).slice(before);assert.equal(changes.length,1);assert.equal(changes[0][0],'create');assert.equal(changes[0][1].id,f.config.assetsParentId);assert.deepEqual(changes[0][1].parents,[f.config.rootParentId]);
});

test('caller configuration cannot introduce another permitted root destination',()=>{const f=fixture(),c=JSON.parse(f.properties.get(OWNER_STORE_PROPERTY));c.destinationParentId='other';f.properties.set(OWNER_STORE_PROPERTY,JSON.stringify(c));const before=writes(f).length;assert.throws(()=>f.api().load(),/CONFIG_MISMATCH/);assert.equal(writes(f).length,before);});
