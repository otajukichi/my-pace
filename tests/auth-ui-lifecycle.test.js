// Controller regressions use DOM/SDK/network/IndexedDB doubles only.
import test from 'node:test';import assert from 'node:assert/strict';
import {launch} from './helpers/auth-ui-harness.mjs';
import {keyedIndexedDBDouble} from './helpers/indexeddb-keyed-double.js';
import {createInitialState,todayKey} from '../src/lib/domain.js';
import {stateToEntities} from '../src/lib/entity-codec.js';
function globalValue(t,key,value){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else delete globalThis[key];});}
const ready=async predicate=>{for(let n=0;n<100&&!predicate();n++)await Promise.resolve();assert(predicate());};
const authResponse=()=>Response.json({ok:true,authenticated:true,csrf:'current-csrf'});
const signedOut=()=>Response.json({ok:true,authenticated:false,configured:true});
const challenge=n=>Response.json({ok:true,clientId:'fixture.apps.googleusercontent.com',nonce:'nonce-'+n,csrf:'csrf-'+n});
function sdk(t){const initialized=[],rendered=[];const identity={initialize(x){initialized.push(x);},renderButton(...args){rendered.push(args);}};globalValue(t,'google',{accounts:{id:identity}});return {identity,initialized,rendered};}
function cached(){const state={...createInitialState(),wake:{[todayKey()]:'04:51'}},entities=Object.fromEntries(Object.entries(stateToEntities(state)).map(([key,value])=>[key,{key,value,version:1,deleted:false}]));return {format:1,store:'store',generation:'1',epoch:'default',revision:4,entities,outbox:[],conflicts:[],importedRuns:[],importStatus:null,recordConfirmation:{kind:'snapshot',store:'store',generation:'1',epoch:'default',revision:4}};}
function cloudNetwork(seed,{logout,login,challengeHook}={}){const calls=[];let challenges=0;return {calls,fetcher:async(path,opts)=>{calls.push(path);if(path==='/api/auth/session')return authResponse();if(path==='/api/auth/logout')return logout?logout():Response.json({ok:true});if(path==='/api/auth/challenge')return challengeHook?challengeHook(++challenges):challenge(++challenges);if(path==='/api/auth/login')return login?login():authResponse();const {action}=JSON.parse(opts.body);calls.push(action);return Response.json({ok:true,result:action==='snapshot'?{store:seed.store,generation:seed.generation,epoch:seed.epoch,revision:seed.revision,entities:Object.values(seed.entities),cursor:null}:action==='imports'?{revision:seed.revision,runs:[],nextCursor:null}:{status:'idle'}});}};}

// SDK loading never uses an actual document or Google endpoint.
test('cancelled SDK setup detaches immediately; retry shares one load and renders only its new challenge',async t=>{
 globalValue(t,'google',undefined);let challenges=0;const scripts=[];const ui=await launch(t,{timers:[],fetcher:async path=>path==='/api/auth/session'?signedOut():challenge(++challenges)});ui.document.head={append:s=>scripts.push(s)};
 const first=ui.click('cloud-login');await ready(()=>scripts.length===1);await ui.click('dialog-close');const second=ui.click('cloud-login');await ready(()=>challenges===2);for(let n=0;n<20;n++)await Promise.resolve();assert.equal(scripts.length,1);await ui.editor.emit('close',{});assert.equal(ui.editor.open,true,'a queued old close event cannot cancel the reopened dialog');
 const google=sdk(t);scripts[0].onload();await Promise.all([first,second]);assert.deepEqual(google.initialized.map(x=>x.nonce),['nonce-2']);assert.equal(google.rendered.length,1);assert.equal(ui.editor.open,true);await ui.window.emit('pagehide',{});
});

test('cancelled SDK rejection cannot mark a newer diary form or prevent saving its draft',async t=>{
 globalValue(t,'google',undefined);let script;const ui=await launch(t,{timers:[],fetcher:async path=>path==='/api/auth/session'?signedOut():challenge(1)});ui.document.head={append:s=>script=s};const opening=ui.click('cloud-login');await ready(()=>script);await ui.click('dialog-close');await ui.click('diary-edit');const markup=ui.editor.innerHTML,field=ui.editor.querySelector('textarea');field.value='A newer draft';script.onerror();await opening;
 assert.equal(ui.editor.innerHTML,markup);assert.equal(field.value,'A newer draft');assert.equal(ui.editor.querySelector('#form-error').hidden,true);await ui.submit('diary',{text:'A newer draft',mood:''});assert.equal(ui.state().diary[todayKey()].text,'A newer draft');await ui.window.emit('pagehide',{});
});

test('challenge cancellation releases editing but serializes its cookie-setting request before a retry',async t=>{
 globalValue(t,'google',undefined);let resolveChallenge,challenges=0;const scripts=[];const ui=await launch(t,{timers:[],fetcher:async path=>{if(path==='/api/auth/session')return signedOut();challenges++;return new Promise(resolve=>resolveChallenge=resolve);}});ui.document.head={append:s=>scripts.push(s)};
 const first=ui.click('cloud-login');await ready(()=>resolveChallenge);await ui.click('dialog-close');await ui.click('cloud-login');assert.equal(challenges,1);assert.equal(ui.editor.open,false);assert.match(ui.notice.innerHTML,/ログイン状態の確認が終わるのを待っています/);
 await ui.click('diary-edit');await ui.submit('diary',{text:'Saved locally while challenge settles',mood:''});assert.equal(ui.state().diary[todayKey()].text,'Saved locally while challenge settles');resolveChallenge(challenge(1));await first;assert.equal(scripts.length,0);
 const second=ui.click('cloud-login');await ready(()=>challenges===2);resolveChallenge(challenge(2));await ready(()=>scripts.length===1);const google=sdk(t);scripts[0].onload();await second;assert.equal(google.initialized[0].nonce,'nonce-2');await ui.window.emit('pagehide',{});
});

test('an obsolete SDK error cannot release ownership of a newer pending challenge',async t=>{
 globalValue(t,'google',undefined);let challenges=0,resolveSecond;const scripts=[];const ui=await launch(t,{timers:[],fetcher:async path=>{if(path==='/api/auth/session')return signedOut();challenges++;return challenges===1?challenge(1):new Promise(resolve=>resolveSecond=resolve);}});ui.document.head={append:s=>scripts.push(s)};
 const first=ui.click('cloud-login');await ready(()=>scripts.length===1);await ui.click('dialog-close');const second=ui.click('cloud-login');await ready(()=>resolveSecond);scripts[0].onerror();await first;assert.equal(ui.editor.querySelector('#form-error').hidden,true);await ui.click('cloud-login');assert.equal(challenges,2);
 resolveSecond(challenge(2));await ready(()=>scripts.length===2);const google=sdk(t);scripts[1].onload();await second;assert.equal(google.initialized[0].nonce,'nonce-2');await ui.window.emit('pagehide',{});
});

test('native dialog cancellation invalidates captured SDK callbacks before credential dispatch',async t=>{
 const google=sdk(t);let loginCalls=0;const ui=await launch(t,{timers:[],fetcher:async path=>{if(path==='/api/auth/session')return signedOut();if(path==='/api/auth/login'){loginCalls++;return authResponse();}return challenge(1);}});await ui.click('cloud-login');const callback=google.initialized[0].callback;await ui.cancelDialog();await ui.click('diary-edit');const markup=ui.editor.innerHTML;await callback({credential:'obsolete'});assert.equal(loginCalls,0);assert.equal(ui.editor.innerHTML,markup);assert.equal(ui.editor.querySelector('#form-error').hidden,true);await ui.window.emit('pagehide',{});
});

test('cancelled credential completion cannot publish authentication or start sync when its response arrives later',async t=>{
 const google=sdk(t),seed=cached(),idb=keyedIndexedDBDouble(seed);let resolveLogin,challenges=0,syncCalls=0;const ui=await launch(t,{idb,timers:[],fetcher:async(path)=>{if(path==='/api/auth/session')return signedOut();if(path==='/api/auth/challenge')return challenge(++challenges);if(path==='/api/auth/login')return new Promise(resolve=>resolveLogin=resolve);syncCalls++;throw Error('Obsolete login must not sync');}});
 await ui.click('cloud-login');const completing=google.initialized[0].callback({credential:'synthetic'});await ready(()=>resolveLogin);await ui.click('dialog-close');await ui.click('cloud-login');assert.equal(challenges,1,'auth-changing requests remain serialized');await ui.click('diary-edit');const markup=ui.editor.innerHTML;resolveLogin(authResponse());await completing;
 assert.equal(syncCalls,0);assert.equal(ui.editor.innerHTML,markup);assert.equal(ui.editor.querySelector('#form-error').hidden,true);assert.doesNotMatch(ui.app.innerHTML,/04:51/);assert.deepEqual(idb.read().entities,seed.entities);await ui.window.emit('pagehide',{});
});

for(const failure of [false,true])test(`logout hides immediately, preserves the cloud cache and lets new local edits survive ${failure?'failure':'completion'}`,async t=>{
 const seed=cached(),idb=keyedIndexedDBDouble(seed);let resolveLogout;const n=cloudNetwork(seed,{logout:()=>new Promise(resolve=>resolveLogout=resolve)}),ui=await launch(t,{idb,fetcher:n.fetcher,modePreference:'cloud',timers:[]});assert.match(ui.app.innerHTML,/04:51/);const signingOut=ui.click('cloud-logout');await ready(()=>resolveLogout);
 assert.equal(ui.mode(),'signed-out');assert.doesNotMatch(ui.app.innerHTML,/04:51/);assert.deepEqual(idb.read().entities,seed.entities);await ui.click('cloud-use');assert.doesNotMatch(ui.app.innerHTML,/04:51/);await ui.click('diary-edit');const field=ui.editor.querySelector('textarea');field.value='New local draft';const markup=ui.editor.innerHTML;
 resolveLogout(failure?Response.json({ok:false,error:'SERVER_UNAVAILABLE'},{status:503}):Response.json({ok:true}));await signingOut;assert.equal(ui.editor.innerHTML,markup);assert.equal(field.value,'New local draft');assert.equal(ui.editor.querySelector('#form-error').hidden,true);await ui.submit('diary',{text:'New local draft',mood:''});assert.equal(ui.state().diary[todayKey()].text,'New local draft');assert.deepEqual(idb.read().entities,seed.entities);assert.deepEqual(idb.read().outbox,[]);await ui.window.emit('pagehide',{});
});

test('a never-returning logout times out with local display locked and no stale error in the new editor',async t=>{
 const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout,timers=new Map();globalValue(t,'setTimeout',(callback,ms,...args)=>{if(ms!==45000)return originalSet(callback,ms,...args);const id={};timers.set(id,callback);return id;});globalValue(t,'clearTimeout',id=>{if(timers.has(id))timers.delete(id);else originalClear(id);});
 const seed=cached(),idb=keyedIndexedDBDouble(seed),n=cloudNetwork(seed,{logout:()=>new Promise(()=>{})}),ui=await launch(t,{idb,fetcher:n.fetcher,modePreference:'cloud',timers:[]});const signingOut=ui.click('cloud-logout');await ready(()=>timers.size===1);assert.equal(ui.mode(),'signed-out');assert.doesNotMatch(ui.app.innerHTML,/04:51/);await ui.click('diary-edit');const markup=ui.editor.innerHTML;for(const callback of [...timers.values()])callback();await signingOut;
 assert.equal(ui.editor.innerHTML,markup);assert.equal(ui.editor.querySelector('#form-error').hidden,true);assert.match(ui.notice.innerHTML,/サーバー側のログアウトは確認できていません/);assert.equal(ui.mode(),'signed-out');assert.deepEqual(idb.read().entities,seed.entities);await ui.window.emit('pagehide',{});
});

test('failed logout survives reload as explicitly signed out even when a server cookie could remain valid',async t=>{
 const seed=cached(),idb=keyedIndexedDBDouble(seed),n=cloudNetwork(seed,{logout:()=>Response.json({ok:false,error:'OFFLINE'},{status:503})}),ui=await launch(t,{idb,fetcher:n.fetcher,modePreference:'cloud',timers:[]});await ui.click('cloud-logout');assert.equal(ui.mode(),'signed-out');assert.match(ui.notice.innerHTML,/サーバー側のログアウトは確認できていません/);await ui.window.emit('pagehide',{});let requests=0;const reloaded=await launch(t,{idb,modePreference:ui.mode(),timers:[],fetcher:async()=>{requests++;return authResponse();}});assert.equal(requests,0);assert.doesNotMatch(reloaded.app.innerHTML,/04:51/);await reloaded.click('cloud-use');assert.equal(requests,0);assert.doesNotMatch(reloaded.app.innerHTML,/04:51/);await reloaded.window.emit('pagehide',{});
});

test('current login still publishes a confirmed cached profile after explicit sign-in',async t=>{
 const google=sdk(t),seed=cached(),idb=keyedIndexedDBDouble(seed),n=cloudNetwork(seed);const ui=await launch(t,{idb,modePreference:'signed-out',timers:[],fetcher:n.fetcher});assert.doesNotMatch(ui.app.innerHTML,/04:51/);await ui.click('cloud-login');await google.initialized[0].callback({credential:'current'});assert.equal(ui.mode(),'cloud');assert.match(ui.app.innerHTML,/04:51/);assert.equal(ui.editor.open,false);await ui.window.emit('pagehide',{});
});

test('explicit logout overrides only login-owned work and hides cached data during the initial authenticated sync',async t=>{
 const google=sdk(t),seed=cached(),idb=keyedIndexedDBDouble(seed);let settleSnapshot,logoutCalls=0,signedIn=false;const ui=await launch(t,{idb,modePreference:'cloud',timers:[],fetcher:async(path,opts)=>{
  if(path==='/api/auth/session')return signedOut();if(path==='/api/auth/challenge')return challenge(1);if(path==='/api/auth/login'){signedIn=true;return authResponse();}if(path==='/api/auth/logout'){logoutCalls++;return Response.json({ok:true});}
  const {action}=JSON.parse(opts.body);assert(signedIn);assert.equal(action,'snapshot');return new Promise(resolve=>settleSnapshot=()=>resolve(Response.json({ok:true,result:{store:seed.store,generation:seed.generation,epoch:seed.epoch,revision:seed.revision,entities:Object.values(seed.entities),cursor:null}})));
 }});
 assert.match(ui.app.innerHTML,/04:51/);await ui.click('cloud-login');const completing=google.initialized[0].callback({credential:'current'});await ready(()=>settleSnapshot);await ui.click('cloud-logout');assert.equal(ui.mode(),'signed-out');assert.doesNotMatch(ui.app.innerHTML,/04:51/);assert.equal(logoutCalls,0,'do not race a server logout against unsettled authentication work');assert.match(ui.notice.innerHTML,/サーバー側のログアウトは確認できていません/);
 await ui.click('diary-edit');const field=ui.editor.querySelector('textarea');field.value='A newer local draft';const markup=ui.editor.innerHTML;settleSnapshot();await completing;assert.equal(ui.editor.innerHTML,markup);assert.equal(field.value,'A newer local draft');assert.equal(ui.editor.querySelector('#form-error').hidden,true);assert.doesNotMatch(ui.app.innerHTML,/04:51/);assert.deepEqual(idb.read().entities,seed.entities);await ui.window.emit('pagehide',{});
});

test('pending original cloud operation is byte-preserved through delayed logout and its duplicate click',async t=>{
 const seed=cached();seed.outbox=[{status:'pending',command:{operationId:'original_pending_before_logout',store:seed.store,generation:seed.generation,epoch:seed.epoch,key:'diary:'+todayKey(),expectedVersion:0,deleted:false,value:{text:'offline intent',mood:null},recreate:false}}];const idb=keyedIndexedDBDouble(seed);let settle,logoutCalls=0;const n=cloudNetwork(seed,{logout:()=>{logoutCalls++;return new Promise(resolve=>settle=resolve);}});
 const ui=await launch(t,{idb,modePreference:'cloud',timers:[],fetcher:async(path,opts)=>path==='/api/sync'&&JSON.parse(opts.body).action==='command'?Response.json({ok:false,error:'WRITER_BUSY',retryable:true},{status:503}):n.fetcher(path,opts)});const before=idb.read();const signingOut=ui.click('cloud-logout');await ready(()=>settle);await ui.click('cloud-logout');assert.equal(logoutCalls,1);assert.deepEqual(idb.read().outbox,before.outbox);assert.deepEqual(idb.rows('state'),[seed]);settle(Response.json({ok:true}));await signingOut;assert.deepEqual(idb.read().outbox,before.outbox);assert.deepEqual(idb.read().entities,before.entities);assert.equal(ui.mode(),'signed-out');await ui.window.emit('pagehide',{});
});

for(const serverSucceeded of [true,false])test(`failed signed-out preference remains an explicit warning after server logout ${serverSucceeded?'success':'failure'}`,async t=>{
 const seed=cached(),idb=keyedIndexedDBDouble(seed);let settle;const n=cloudNetwork(seed,{logout:()=>new Promise(resolve=>settle=resolve)}),ui=await launch(t,{idb,modePreference:'cloud',timers:[],fetcher:n.fetcher});const set=globalThis.localStorage.setItem.bind(globalThis.localStorage);globalThis.localStorage.setItem=(key,value)=>{if(key==='mypace.persistence.mode.v1'&&value==='signed-out')throw Error('Preference storage denied');return set(key,value);};
 const signingOut=ui.click('cloud-logout');await ready(()=>settle);assert.doesNotMatch(ui.app.innerHTML,/04:51/);assert.equal(ui.mode(),'cloud','persistent preference remains unchanged when its write fails');assert.match(ui.notice.innerHTML,/ログアウト状態をこのブラウザーに保存できませんでした/);assert.match(ui.notice.innerHTML,/ほかのタブや、再読み込み・開き直し/);assert.deepEqual(idb.read().entities,seed.entities);settle(serverSucceeded?Response.json({ok:true}):Response.json({ok:false,error:'OFFLINE'},{status:503}));await signingOut;
 assert.match(ui.notice.innerHTML,/ログアウト状態をこのブラウザーに保存できませんでした/);assert.match(ui.notice.innerHTML,serverSucceeded?/サーバー側のログアウトは確認できました/:/サーバー側のログアウトは確認できていません/);assert.doesNotMatch(ui.notice.innerHTML,/マイペースからログアウトしました/);assert.deepEqual(idb.read().entities,seed.entities);await ui.window.emit('pagehide',{});
 const reloaded=await launch(t,{idb,modePreference:ui.mode(),timers:[],fetcher:async()=>signedOut()});assert.match(reloaded.app.innerHTML,/04:51/,'warning honestly describes residual cached display after reload');await reloaded.window.emit('pagehide',{});
});

test('logout can hide cloud data and abort a user-started slow synchronization',async t=>{
 const seed=cached(),idb=keyedIndexedDBDouble(seed),n=cloudNetwork(seed);let slow=false,settle,aborted=false;
 const ui=await launch(t,{idb,modePreference:'cloud',timers:[],fetcher:async(path,opts)=>{
  if(slow&&path==='/api/sync'&&JSON.parse(opts.body).action==='snapshot')return new Promise(resolve=>{settle=()=>resolve(Response.json({ok:false,error:'STORE_YIELD'},{status:503}));opts.signal.addEventListener('abort',()=>{aborted=true;settle();});});
  return n.fetcher(path,opts);
 }});
 slow=true;const syncing=ui.click('cloud-sync');await ready(()=>settle);await ui.click('cloud-logout');assert.equal(aborted,true);assert.equal(ui.mode(),'signed-out');assert.doesNotMatch(ui.app.innerHTML,/04:51/);await syncing;assert.equal(ui.mode(),'signed-out');assert.deepEqual(idb.read().entities,seed.entities);await ui.window.emit('pagehide',{});
});

test('opening the app on v1 prompts without upgrading or authenticating; cancel retains all local bytes',async t=>{
 const seed=cached();seed.outbox=[{status:'pending',command:{operationId:'pending-original',store:'store',generation:'1',epoch:'default',key:'wake:'+todayKey(),expectedVersion:1,deleted:false,value:'06:00',recreate:false}}];seed.conflicts=[{key:'wake:'+todayKey(),error:'ENTITY_VERSION_CONFLICT'}];const idb=keyedIndexedDBDouble(seed);let requests=0;
 const ui=await launch(t,{idb,legacySchema:true,modePreference:'cloud',timers:[],fetcher:async()=>{requests++;return signedOut();}});
 assert.equal(idb.version,1);assert.equal(requests,0);assert.equal(ui.editor.open,true);assert.match(ui.editor.innerHTML,/旧版では開けなくなります/);assert.match(ui.editor.innerHTML,/ほかの端末・ブラウザー/);
 await ui.click('cloud-storage-upgrade');assert.equal(idb.version,1);assert.match(ui.editor.querySelector('#form-error').textContent,/先に退避ファイル/);
 await ui.click('dialog-close');assert.equal(idb.version,1);assert.deepEqual(idb.read(),seed);await ui.window.emit('pagehide',{});
});

test('v1 upgrade requires a requested local backup then explicit approval and preserves the owner safety copy',async t=>{
 const seed=cached(),idb=keyedIndexedDBDouble(seed);let blob;
 const original=URL.createObjectURL;URL.createObjectURL=value=>{blob=value;return original(value);};t.after(()=>URL.createObjectURL=original);
 const ui=await launch(t,{idb,legacySchema:true,modePreference:'cloud',timers:[],fetcher:async()=>signedOut()});
 await ui.click('cloud-storage-export');assert.equal(idb.version,1);const backup=JSON.parse(await blob.text());assert.equal(backup.kind,'mypace-legacy-owner-backup');assert.deepEqual(backup.owner,seed);
 await ui.click('cloud-storage-upgrade');assert.equal(idb.version,2);assert.deepEqual(idb.rows('state'),[seed]);assert.equal(ui.editor.open,false);assert.match(ui.app.innerHTML,/04:51/);await ui.window.emit('pagehide',{});
});
