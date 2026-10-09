/** Controller tests with a deliberately minimal event/DOM double.
 * They cover state transitions and interruption safety, not native browser rendering,
 * validation, focus trapping, keyboard behavior, file pickers, or accessibility layout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState, serializeBackup, todayKey, addDays} from '../src/lib/domain.js';
import {STORAGE_KEY} from '../src/lib/storage.js';
import {indexedDBDouble} from './helpers/indexeddb-double.js';
import {stateToEntities} from '../src/lib/entity-codec.js';
import {createIndexedDBStorage} from '../src/lib/cloud-local-storage.js';

let instance=0;
class EventNode {
  constructor(){this.dataset={};this.handlers=new Map();this._innerHTML='';this.htmlWrites=0;this.hidden=true;this.open=false;this.fields=new Map();this.focused=false;this.focusCalls=0;}
  get innerHTML(){return this._innerHTML;}
  set innerHTML(value){this._innerHTML=value;this.htmlWrites++;this.fields.clear();}
  addEventListener(type,handle){this.handlers.set(type,[...(this.handlers.get(type)||[]),handle]);}
  removeEventListener(type,handle){this.handlers.set(type,(this.handlers.get(type)||[]).filter(item=>item!==handle));}
  async emit(type,event={}){for(const handle of this.handlers.get(type)||[]) await handle(event);}
  showModal(){this.open=true;}
  close(){if(this.open){this.open=false;for(const handle of this.handlers.get('close')||[])handle({});}}
  focus(){this.focused=true;this.focusCalls++;}
  insertAdjacentHTML(position,value){assert.equal(position,'beforeend');this._innerHTML+=value;}
  querySelector(selector){if(selector==='[data-route-map]'&&!this._innerHTML.includes('data-route-map='))return null;if(!this.fields.has(selector))this.fields.set(selector,new EventNode());return this.fields.get(selector);}
  click(){this.clicked=true;}
}
async function launch(t,{initial=createInitialState(),raw:initialRaw,hash='#home',denyRead=false,width=1280,height=900,idb,fetcher,modePreference=null,timers,pullSupported=false,legacySchema=false}={}) {
  // Ordinary controller fixtures represent an already upgraded cache. Explicit
  // legacySchema tests exercise the app migration consent boundary separately.
  if(idb?.version===1&&!legacySchema){const migrated=createIndexedDBStorage(idb);await migrated.read();migrated.close();}
  const originals=new Map(), app=new EventNode(), editor=new EventNode(), notice=new EventNode(), main=new EventNode();
  const document=new EventNode(), window=new EventNode(), created=[];
  window.innerWidth=width;window.innerHeight=height;
  const location={hash}; let raw=initialRaw===undefined?serializeBackup(initial):initialRaw, deniedRead=denyRead, deniedWrite=false, writes=0;
  document.documentElement = {dataset: {}};
  document.querySelector=selector=>({'#app':app,'#editor':editor,'#notice':notice,main}[selector]||null);
  document.createElement=tag=>{const node=new EventNode();node.tag=tag;created.push(node);return node;};
  const localStorage={getItem(key){if(key==='mypace.persistence.mode.v1')return modePreference;assert.equal(key,STORAGE_KEY);if(deniedRead)throw new Error('Storage denied');return raw;},setItem(key,value){if(key==='mypace.persistence.mode.v1'){modePreference=value;return;}assert.equal(key,STORAGE_KEY);if(deniedWrite)throw new Error('Quota exceeded');raw=value;writes++;}};
  const FormData=class{constructor(form){this.values=form.values;}get(key){return this.values[key]??null;}getAll(key){return this.values[key]??[];}};
  for(const [key,value] of Object.entries({document,window,location,localStorage,FormData,indexedDB:idb,fetch:async(path,options)=>{if(!pullSupported&&path==='/api/sync'&&['pull','recover'].includes(JSON.parse(options.body).action))return Response.json({ok:false,error:'ACTION_INVALID'},{status:400});return (fetcher||originals.get('fetch')?.value)(path,options);},requestAnimationFrame:callback=>callback(),addEventListener:window.addEventListener.bind(window),removeEventListener:window.removeEventListener.bind(window),...(timers?{setInterval:(callback,delay)=>{const timer={callback,delay,unref(){}};timers.push(timer);return timer;},clearInterval:timer=>{const i=timers.indexOf(timer);if(i>=0)timers.splice(i,1);}}:{})})) {
    originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  t.after(()=>{for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  await import(`../src/app.js?controller-test=${instance++}`);
  const click=async(action,data={})=>{const button={dataset:{action,...data},disabled:false};await document.emit('click',{target:{closest:selector=>selector==='[data-action]'?button:null},preventDefault(){}});};
  const form=(type,values,valid=true)=>({dataset:{form:type},values,closest(){return this;},reportValidity(){return valid;}});
  const submitForm=form=>editor.emit('submit',{target:form,preventDefault(){}});
  const submit=(type,values,valid=true)=>submitForm(form(type,values,valid));
  const changeDate=value=>document.emit('change',{target:{id:'selected-date',value}});
  const changeHash=async value=>{location.hash=value;await window.emit('hashchange');};
  const resize=async(width,height)=>{window.innerWidth=width;window.innerHeight=height;await window.emit('resize');};
  const cancelDialog=async()=>{
    const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};
    await editor.emit('cancel',event);
    // Explicitly model the dialog cancel default action. This does not exercise
    // a real Escape key, focus restoration, or the browser's native dialog stack.
    if(!event.defaultPrevented)editor.close();
    return event;
  };
  const fileInput=()=>created.filter(node=>node.type==='file').at(-1);
  const selectFile=async(file,input=fileInput())=>{assert.ok(input,'file input opened');input.files=[file];await input.emit('change');};
  return {app,editor,notice,main,document,window,location,click,form,submit,submitForm,changeDate,changeHash,resize,cancelDialog,fileInput,selectFile,
    get raw(){return raw;},get writes(){return writes;},state:()=>JSON.parse(raw),setRaw:value=>{raw=value;},denyWrite:value=>{deniedWrite=value;},denyRead:value=>{deniedRead=value;}};
}
const numericHabit={id:'read',name:'本を読む',type:'number',unit:'ページ',target:10,archived:false};
const checkHabit={id:'stretch',name:'ストレッチ',type:'check',unit:'',target:1,archived:false};

test('wake save uses the dialog date, persists only valid values, and single-level undo is durable',async t=>{
  const ui=await launch(t), yesterday=addDays(todayKey(),-1);
  await ui.changeDate(yesterday);await ui.click('wake-edit');
  await ui.submit('wake',{time:'06:15'});
  assert.equal(ui.state().wake[yesterday],'06:15');assert.equal(ui.editor.open,false);assert.equal(ui.writes,1);
  await ui.click('undo');assert.deepEqual(ui.state().wake,{});assert.equal(ui.writes,2);
  await ui.click('undo');assert.equal(ui.writes,2);
  await ui.click('wake-edit');await ui.submit('wake',{time:'25:00'});
  assert.equal(ui.writes,2);assert.equal(ui.editor.open,true);assert.equal(ui.editor.querySelector('#form-error').hidden,false);
});

test('storage write failures retain the old durable state and keep an editable dialog open',async t=>{
  const ui=await launch(t);await ui.click('wake-edit');ui.denyWrite(true);
  await ui.submit('wake',{time:'07:00'});
  assert.equal(ui.writes,0);assert.deepEqual(ui.state().wake,{});assert.equal(ui.editor.open,true);
  assert.match(ui.notice.innerHTML,/保存できませんでした/);
  ui.denyWrite(false);await ui.submit('wake',{time:'07:00'});
  assert.equal(ui.state().wake[todayKey()],'07:00');assert.equal(ui.writes,1);
});

test('corrupt initial data is preserved and mutations blocked until confirmed valid restore',async t=>{
  const corrupt='{this is not valid JSON',ui=await launch(t,{raw:corrupt,hash:'#settings'});
  assert.match(ui.app.innerHTML,/変更を止めています/);
  await ui.click('wake-now');assert.equal(ui.raw,corrupt);assert.equal(ui.writes,0);
  await ui.click('backup-import');await ui.selectFile({size:12,text:async()=>'{bad'});
  assert.equal(ui.raw,corrupt);assert.equal(ui.editor.open,false);
  const restored={...createInitialState(),wake:{[todayKey()]:'06:00'}};
  await ui.click('backup-import');await ui.selectFile({size:200,text:async()=>serializeBackup(restored)});
  assert.equal(ui.raw,corrupt);assert.equal(ui.writes,0);assert.equal(ui.editor.open,true);
  assert.match(ui.editor.innerHTML,/現在の全データを置き換えます/);
  await ui.click('backup-restore-confirm');assert.deepEqual(ui.state(),restored);assert.equal(ui.editor.open,false);
});

test('canceling a restore does not replace data',async t=>{
  const initial={...createInitialState(),wake:{[todayKey()]:'06:00'}},ui=await launch(t,{initial,hash:'#settings'});
  const before=ui.raw;await ui.click('backup-import');await ui.selectFile({size:200,text:async()=>serializeBackup(createInitialState())});
  await ui.click('dialog-close');assert.equal(ui.raw,before);assert.equal(ui.writes,0);assert.equal(ui.editor.open,false);
});

test('zero numeric habit logs, checkbox toggle, archive and restore preserve historical entries',async t=>{
  const initial={...createInitialState(),habits:[numericHabit,checkHabit]},ui=await launch(t,{initial,hash:'#habits'});
  await ui.click('habit-log',{id:'read'});await ui.submit('habit-log',{id:'read',value:'0'});
  assert.equal(ui.state().habitLogs.read[todayKey()],0);
  await ui.click('habit-log',{id:'stretch'});assert.equal(ui.state().habitLogs.stretch[todayKey()],true);
  await ui.click('habit-log',{id:'stretch'});assert.equal(ui.state().habitLogs.stretch[todayKey()],false);
  await ui.click('habit-archive',{id:'read'});assert.equal(ui.state().habits[0].archived,true);
  const writes=ui.writes;await ui.click('habit-log',{id:'read'});assert.equal(ui.writes,writes);
  await ui.click('habit-restore',{id:'read'});assert.equal(ui.state().habits[0].archived,false);assert.equal(ui.state().habitLogs.read[todayKey()],0);
});

test('run save rejects zero duration; deletion requires confirmation and is undoable',async t=>{
  const ui=await launch(t,{hash:'#running'});await ui.click('run-add');
  const values={id:'',date:todayKey(),distance:'5',minutes:'0',seconds:'0',note:'  朝  '};
  await ui.submit('run',values);assert.equal(ui.writes,0);assert.equal(ui.editor.open,true);
  await ui.submit('run',{...values,minutes:'30'});assert.equal(ui.state().runs.length,1);assert.equal(ui.state().runs[0].note,'朝');
  const id=ui.state().runs[0].id;
  await ui.click('run-edit',{id});await ui.click('run-delete');assert.equal(ui.state().runs.length,1);
  await ui.click('dialog-close');assert.equal(ui.state().runs.length,1);
  await ui.click('run-edit',{id});await ui.click('run-delete');await ui.click('run-delete-confirm');assert.equal(ui.state().runs.length,0);
  await ui.click('undo');assert.equal(ui.state().runs[0].id,id);
});

test('latest external-tab state closes stale editors and clears obsolete undo',async t=>{
  const ui=await launch(t);await ui.click('wake-now');await ui.click('wake-edit');
  const external={...createInitialState(),wake:{[todayKey()]:'08:45'}};
  ui.setRaw(serializeBackup(external));await ui.window.emit('storage',{key:STORAGE_KEY});
  assert.equal(ui.editor.open,false);assert.match(ui.app.innerHTML,/08:45/);
  const writes=ui.writes;await ui.click('undo');assert.equal(ui.writes,writes);assert.deepEqual(ui.state(),external);
  ui.setRaw('invalid');await ui.window.emit('storage',{key:STORAGE_KEY});await ui.click('wake-now');
  assert.equal(ui.raw,'invalid');assert.equal(ui.writes,writes);assert.match(ui.app.innerHTML,/変更を止めています/);
});

test('navigation closes a dialog and focuses the new main content',async t=>{
  const ui=await launch(t);await ui.click('wake-edit');assert.equal(ui.editor.open,true);
  await ui.changeHash('#running');assert.equal(ui.editor.open,false);assert.equal(ui.main.focused,true);assert.match(ui.app.innerHTML,/<h1>ランニング<\/h1>/);
});

test('Close and modeled native cancel after resize discard only the draft and invalidate its form',async t=>{
  const ui=await launch(t),before=ui.raw;
  for(const dismiss of ['close','cancel']){
    const date=addDays(todayKey(),dismiss==='close'?-1:-2);
    await ui.changeDate(date);await ui.click('wake-edit');
    const input=ui.editor.querySelector('[name="time"]');input.value='06:40';
    const stale=ui.form('wake',{time:input.value}),renders=ui.app.htmlWrites,editorRenders=ui.editor.htmlWrites;
    await ui.resize(320,568);await ui.resize(1440,1080);
    assert.ok(ui.app.htmlWrites>renders,'viewport capacity changes exercise app rerenders');
    assert.equal(ui.editor.htmlWrites,editorRenders);assert.equal(ui.editor.open,true);
    assert.equal(ui.editor.querySelector('[name="time"]'),input);assert.equal(input.value,'06:40');
    if(dismiss==='close'){
      const focusCalls=ui.main.focusCalls;
      await ui.click('dialog-close');assert.ok(ui.main.focusCalls>focusCalls);
    }else{
      assert.equal((await ui.cancelDialog()).defaultPrevented,false);
    }
    assert.equal(ui.editor.open,false);await ui.submitForm(stale);
    assert.equal(ui.raw,before);assert.equal(ui.writes,0);
    await ui.click('wake-edit');
    assert.notEqual(ui.editor.querySelector('[name="time"]'),input,'reopening creates fresh fields');
    assert.match(ui.app.innerHTML,new RegExp(`id="selected-date"[^>]*value="${date}"`));
    await ui.click('dialog-close');
  }
  await ui.click('wake-edit');await ui.submit('wake',{time:'07:15'});
  assert.deepEqual(ui.state().wake,{[addDays(todayKey(),-2)]:'07:15'});assert.equal(ui.writes,1);
});

test('navigation after resize closes a draft, and Close/Cancel remain safe after modeled history changes',async t=>{
  const ui=await launch(t,{hash:'#running'}),before=ui.raw;
  await ui.click('run-add');
  const stale=ui.form('run',{id:'',date:todayKey(),distance:'5',minutes:'30',seconds:'0',note:'未保存'});
  await ui.resize(375,640);
  assert.equal(ui.editor.open,true);
  const firstFocus=ui.main.focusCalls;
  await ui.changeHash('#wake');
  assert.equal(ui.editor.open,false);assert.ok(ui.main.focusCalls>firstFocus);
  await ui.submitForm(stale);await ui.click('dialog-close');await ui.cancelDialog();
  assert.equal(ui.raw,before);assert.equal(ui.writes,0);
  // Back and Forward are represented only by setting hash and emitting hashchange.
  for(const hash of ['#running','#wake']){
    const focusCalls=ui.main.focusCalls;await ui.changeHash(hash);
    assert.equal(ui.editor.open,false);assert.ok(ui.main.focusCalls>focusCalls);
    await ui.click(hash==='#running'?'run-add':'wake-edit');assert.equal(ui.editor.open,true);
    if(hash==='#running')await ui.cancelDialog();else await ui.click('dialog-close');
    assert.equal(ui.editor.open,false);assert.equal(ui.raw,before);assert.equal(ui.writes,0);
  }
});

test('a slow file import is ignored after navigation',async t=>{
  const ui=await launch(t,{hash:'#settings'});let finish;
  await ui.click('backup-import');const pending=ui.selectFile({size:100,text:()=>new Promise(resolve=>{finish=resolve;})});
  await ui.changeHash('#running');finish(serializeBackup(createInitialState()));await pending;
  assert.equal(ui.editor.open,false);assert.equal(ui.writes,0);
});

test('a slow file import cannot replace a newer editor on the same page',async t=>{
  const ui=await launch(t,{hash:'#running'});let finish;
  await ui.click('gpx-import');const pending=ui.selectFile({size:100,text:()=>new Promise(resolve=>{finish=resolve;})});
  await ui.click('run-add');const newEditor=ui.editor.innerHTML;
  finish('<gpx><trk><trkseg><trkpt lat="35" lon="139"/><trkpt lat="35.01" lon="139.01"/></trkseg></trk></gpx>');await pending;
  assert.equal(ui.editor.innerHTML,newEditor);assert.equal(ui.writes,0);
});

test('minimum date navigation and all allowed input dates render safely',async t=>{
  const ui=await launch(t);await ui.changeDate('1900-01-01');
  assert.match(ui.app.innerHTML,/value="1900-01-01"/);
  assert.match(ui.app.innerHTML,/data-action="previous-day"[^>]*disabled/);
  await ui.changeHash('#wake');await ui.click('period',{days:'30'});
  assert.match(ui.app.innerHTML,/<h1>朝の記録<\/h1>/);
});

test('stale local editor does not overwrite a newer tab before its storage event arrives',async t=>{
  const ui=await launch(t);await ui.click('wake-edit');
  const newer={...createInitialState(),wake:{[todayKey()]:'08:20'}};
  ui.setRaw(serializeBackup(newer));await ui.submit('wake',{time:'06:00'});
  assert.deepEqual(ui.state(),newer);assert.equal(ui.writes,0);assert.equal(ui.editor.open,true);
  assert.match(ui.notice.innerHTML,/別のタブで記録が変わったため/);
});

test('Drive tab has explicit connection actions and no initial upload',async t=>{
  const ui=await launch(t,{hash:'#settings'});await ui.click('view-tab',{tab:'drive'});
  assert.match(ui.app.innerHTML,/Google でログイン/);assert.match(ui.app.innerHTML,/data-action="cloud-migrate" disabled/);assert.doesNotMatch(ui.app.innerHTML,/drive-auto-on/);
  assert.equal(ui.writes,0);
});

test('switching settings tabs while Drive confirmation hashes cancels the stale dialog',async t=>{
  const ui=await launch(t,{hash:'#settings'});await ui.click('view-tab',{tab:'drive'});
  const saving=ui.click('drive-save');await ui.click('view-tab',{tab:'backup'});await saving;
  assert.equal(ui.editor.open,false);assert.match(ui.app.innerHTML,/JSON を保存/);
});

function cachedCloud(state=createInitialState()){
 return indexedDBDouble({format:1,store:'owner',generation:'generation',epoch:'epoch',revision:1,entities:Object.fromEntries(Object.entries(stateToEntities(state)).map(([key,value])=>[key,{key,value,version:1,deleted:false}])),outbox:[],conflicts:[],importedRuns:[],importStatus:null});
}
const signedOut=async()=>Response.json({ok:true,authenticated:false,configured:true});
async function untilPending(idb){for(let i=0;i<30&&!idb.pending;i++)await Promise.resolve();assert.equal(idb.pending,true);}
test('cloud save waits for a durable outbox, ignores duplicate submits, and preserves legacy bytes',async t=>{
 const idb=cachedCloud(),ui=await launch(t,{idb,fetcher:signedOut,modePreference:'cloud'});
 const legacy=ui.raw;await ui.click('wake-edit');idb.pause();
 const save=ui.submit('wake',{time:'06:25'});await untilPending(idb);
 assert.equal(ui.editor.open,true);assert.doesNotMatch(ui.app.innerHTML,/06:25/);assert.equal(idb.read().outbox.length,0);
 await ui.submit('wake',{time:'07:10'});assert.equal(ui.writes,0);
 idb.release();await save;
 assert.equal(idb.read().outbox.length,1);assert.equal(idb.read().outbox[0].command.value,'06:25');
 assert.equal(ui.editor.open,false);assert.equal(ui.raw,legacy);assert.match(ui.app.innerHTML,/再ログイン待ち/);
 await ui.click('undo');assert.equal(idb.read().outbox.length,2);assert.equal(idb.read().outbox[1].command.deleted,true);
});
test('cached cloud pending changes survive reload without becoming new writes or overwriting legacy',async t=>{
 const idb=cachedCloud();const first=await launch(t,{idb,fetcher:signedOut,modePreference:'cloud'});await first.click('wake-edit');await first.submit('wake',{time:'06:40'});
 const queued=idb.read().outbox.length,legacy=first.raw;
 const second=await launch(t,{idb,fetcher:signedOut,modePreference:'cloud'});
 assert.match(second.app.innerHTML,/06:40/);assert.equal(idb.read().outbox.length,queued);assert.equal(second.raw,legacy);assert.equal(second.writes,0);
});
test('cloud transaction failure retains old UI and editable dialog, and retry is durable',async t=>{
 const idb=cachedCloud(),ui=await launch(t,{idb,fetcher:signedOut,modePreference:'cloud'});await ui.click('wake-edit');idb.fail();
 await ui.submit('wake',{time:'05:55'});assert.equal(idb.read().outbox.length,0);assert.equal(ui.editor.open,true);assert.doesNotMatch(ui.app.innerHTML,/05:55/);
 await ui.submit('wake',{time:'05:55'});assert.equal(idb.read().outbox.length,1);assert.equal(ui.editor.open,false);
});
test('navigation and a newer dialog are not dismissed by an older durable save acknowledgement',async t=>{
 const idb=cachedCloud(),ui=await launch(t,{idb,fetcher:signedOut,modePreference:'cloud'});await ui.click('wake-edit');idb.pause();
 const save=ui.submit('wake',{time:'06:10'});await untilPending(idb);
 await ui.changeHash('#diary');await ui.click('diary-edit');const markup=ui.editor.innerHTML;
 idb.release();await save;
 assert.equal(ui.editor.open,true);assert.equal(ui.editor.innerHTML,markup);assert.match(ui.app.innerHTML,/<h1>日記<\/h1>/);assert.equal(ui.main.focused,true);
});
test('cancel while a cloud save is durable-pending never reopens its editor',async t=>{
 const idb=cachedCloud(),ui=await launch(t,{idb,fetcher:signedOut,modePreference:'cloud'});await ui.click('wake-edit');idb.pause();
 const save=ui.submit('wake',{time:'06:30'});await untilPending(idb);await ui.cancelDialog();idb.release();await save;
 assert.equal(ui.editor.open,false);assert.equal(idb.read().outbox.length,1);
});
test('opening local mode and migration preview never silently enqueue legacy data',async t=>{
 const initial={...createInitialState(),wake:{[todayKey()]:'08:00'}},idb=cachedCloud(),ui=await launch(t,{initial,idb,fetcher:signedOut,hash:'#settings',modePreference:'cloud'});
 await ui.click('view-tab',{tab:'drive'});assert.equal(idb.read().outbox.length,0);
 await ui.click('cloud-migrate');assert.match(ui.editor.innerHTML,/新しく追加: 1件/);await ui.click('dialog-close');assert.equal(idb.read().outbox.length,0);
 await ui.click('cloud-local');assert.match(ui.app.innerHTML,/このブラウザーのみ/);assert.equal(ui.state().wake[todayKey()],'08:00');assert.equal(idb.read().outbox.length,0);
});

test('imported routes progressively load signed pages and stale navigation cannot reopen the route dialog',async t=>{
 const idb=cachedCloud();let release;const requests=[];
 const fetcher=async(path,options)=>{
   if(path==='/api/auth/session')return Response.json({ok:true,authenticated:true,csrf:'test'});
   const body=JSON.parse(options.body);if(body.action!=='route')return Response.json({ok:false,error:'OFFLINE'},{status:503});requests.push(body);
   const result={runId:'csv-run',revision:5,points:[{lat:35,lon:139},{lat:35.1,lon:139.1}],nextCursor:body.payload.cursor?null:'next'};
   if(body.payload.cursor)return Response.json({ok:true,result});
   return new Promise(resolve=>{release=()=>resolve(Response.json({ok:true,result}));});
 };
 const ui=await launch(t,{idb,fetcher,hash:'#running',modePreference:'cloud'});const legacy=ui.raw;
 const opening=ui.click('cloud-route',{id:'csv-run'});for(let i=0;i<10&&!release;i++)await Promise.resolve();
 await ui.changeHash('#calendar');release();await opening;
 assert.equal(ui.editor.open,false);assert.equal(ui.raw,legacy);assert.equal(idb.read().outbox.length,0);
 const second=ui.click('cloud-route',{id:'csv-run'});for(let i=0;i<10&&requests.length<2;i++)await Promise.resolve();release();await second;
 assert.equal(ui.editor.open,true);assert.match(ui.editor.querySelector('.cloud-route-result').innerHTML,/1〜4 サンプル/);assert.equal(requests[1].payload.cursor,null);
 assert.equal(requests.length,3);assert.match(ui.editor.querySelector('.cloud-route-progress').textContent,/読み込みました/);
 assert.equal(requests[2].payload.cursor,'next');assert.equal(requests[2].payload.revision,5);assert.equal(idb.read().outbox.length,0);
});

test('explicit migration submits the displayed preview and preserves the original legacy backup',async t=>{
 const initial={...createInitialState(),wake:{[todayKey()]:'08:00'}},idb=cachedCloud(),ui=await launch(t,{initial,idb,fetcher:signedOut,hash:'#settings',modePreference:'cloud'});
 const raw=ui.raw;await ui.click('view-tab',{tab:'drive'});await ui.click('cloud-migrate');
 await ui.submit('cloud-migration',{overwrite:[]});assert.equal(ui.raw,raw);assert.equal(idb.read().outbox.length,1);
 assert.equal(idb.read().outbox[0].command.key,`wake:${todayKey()}`);assert.equal(idb.read().outbox[0].command.value,'08:00');
});

test('an explicit local-mode preference survives reload even when cloud records are cached',async t=>{
 const initial={...createInitialState(),wake:{[todayKey()]:'08:00'}},remote={...createInitialState(),wake:{[todayKey()]:'06:00'}};
 const ui=await launch(t,{initial,idb:cachedCloud(remote),fetcher:signedOut,modePreference:'local'});
 assert.match(ui.app.innerHTML,/08:00/);assert.match(ui.app.innerHTML,/このブラウザーのみ/);assert.equal(ui.writes,0);
 await ui.click('cloud-use');assert.match(ui.app.innerHTML,/08:00/);assert.equal(ui.state().wake[todayKey()],'08:00');
});

test('an unverified cold cache is never displayed before owner authentication',async t=>{
 const remote={...createInitialState(),wake:{[todayKey()]:'04:55'}},ui=await launch(t,{idb:cachedCloud(remote),fetcher:signedOut});
 assert.doesNotMatch(ui.app.innerHTML,/04:55/);assert.match(ui.app.innerHTML,/このブラウザーのみ/);
 await ui.click('cloud-use');assert.doesNotMatch(ui.app.innerHTML,/04:55/);
});

test('explicit logout hides cloud records, clears dialogs and undo, and preserves unsent queue',async t=>{
 const idb=cachedCloud(),ui=await launch(t,{idb,fetcher:signedOut,modePreference:'cloud'});
 await ui.click('wake-edit');await ui.submit('wake',{time:'04:45'});await ui.click('diary-edit');
 await ui.click('cloud-logout');assert.equal(ui.editor.open,false);assert.doesNotMatch(ui.app.innerHTML,/04:45/);assert.equal(idb.read().outbox.length,1);
 await ui.click('cloud-use');assert.doesNotMatch(ui.app.innerHTML,/04:45/);await ui.click('undo');assert.equal(idb.read().outbox.length,1);
});
test('a persisted explicit logout prevents both cached display and startup authentication or outbox transmission',async t=>{
 const remote={...createInitialState(),wake:{[todayKey()]:'04:35'}},idb=cachedCloud(remote);let requests=0;
 const ui=await launch(t,{idb,modePreference:'signed-out',fetcher:async()=>{requests++;throw Error('Must not request while locked');}});
 assert.equal(requests,0);assert.doesNotMatch(ui.app.innerHTML,/04:35/);await ui.click('cloud-use');assert.equal(requests,0);
});
test('cross-tab logout during a pending durable save cannot redisplay cloud state after acknowledgement',async t=>{
 const idb=cachedCloud(),ui=await launch(t,{idb,fetcher:signedOut,modePreference:'cloud'});await ui.click('wake-edit');idb.pause();
 const save=ui.submit('wake',{time:'04:15'});await untilPending(idb);
 await ui.window.emit('storage',{key:'mypace.persistence.mode.v1',newValue:'signed-out'});idb.release();await save;
 assert.equal(ui.editor.open,false);assert.doesNotMatch(ui.app.innerHTML,/04:15/);assert.equal(idb.read().outbox.length,1);
});
test('an external local update during async dispatch prevents stale candidate overwrite',async t=>{
 const ui=await launch(t);await ui.click('wake-edit');const save=ui.submit('wake',{time:'04:10'});
 const external={...createInitialState(),wake:{[todayKey()]:'08:20'}};ui.setRaw(serializeBackup(external));await ui.window.emit('storage',{key:STORAGE_KEY});await save;
 assert.equal(ui.state().wake[todayKey()],'08:20');assert.equal(ui.writes,0);
});


test('STORE_YIELD backs off timer, visibility and online retries while explicit sync remains available',async t=>{
 const initial={...createInitialState(),wake:{[todayKey()]:'06:25'}},idb=cachedCloud(initial),timers=[],requests=[];let failure=true;
 const fetcher=async(path,options)=>{
  requests.push(path);
  if(path==='/api/auth/session')return Response.json({ok:true,authenticated:true,csrf:'test'});
  const {action}=JSON.parse(options.body);
  if(failure)return Response.json({ok:false,error:'STORE_YIELD',retryable:true},{status:503});
  const cached=idb.read();
  const result=action==='snapshot'?{store:cached.store,generation:cached.generation,epoch:cached.epoch,revision:cached.revision,entities:Object.values(cached.entities),cursor:null}:action==='imports'?{revision:cached.revision,runs:[],nextCursor:null}:{status:'idle'};
  return Response.json({ok:true,result});
 };
 const ui=await launch(t,{idb,fetcher,timers,modePreference:'cloud',hash:'#settings'}),legacy=ui.raw;await ui.click('view-tab',{tab:'drive'});
 assert.match(ui.app.innerHTML,/Drive の記録をまだ確認できていません/);assert.doesNotMatch(ui.app.innerHTML,/Google Drive に保存済み/);
 const at=requests.length;ui.document.hidden=false;
 await ui.document.emit('visibilitychange');await ui.window.emit('online');timers.find(timer=>timer.delay===60000).callback();await Promise.resolve();
 assert.equal(requests.length,at);assert.equal(idb.read().outbox.length,0);assert.equal(ui.raw,legacy);
 assert.equal(ui.window.handlers.get('online').length,1,'there is only one online refresh listener');
 await ui.click('cloud-sync');assert.equal(requests.length,at+2);assert.doesNotMatch(ui.app.innerHTML,/Google Drive に保存済み/);
 failure=false;await ui.click('cloud-sync');assert.match(ui.app.innerHTML,/Google Drive に保存済み/);assert.equal(ui.raw,legacy);
 await ui.window.emit('pagehide',{persisted:false});assert.equal(timers.length,0);assert.equal(ui.window.handlers.get('online').length,0);
});

test('successful login with unready recovery leaves legacy state intact and explains that cloud data was not fetched',async t=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'google');let callback;
 Object.defineProperty(globalThis,'google',{configurable:true,value:{accounts:{id:{initialize(options){callback=options.callback;},renderButton(){}}}}});
 t.after(()=>{if(original)Object.defineProperty(globalThis,'google',original);else delete globalThis.google;});
 const fetcher=async path=>{
  if(path==='/api/auth/session')return Response.json({ok:true,authenticated:false});
  if(path==='/api/auth/challenge')return Response.json({ok:true,clientId:'test-client',nonce:'test-nonce',csrf:'test'});
  if(path==='/api/auth/login')return Response.json({ok:true,authenticated:true,csrf:'test'});
  return Response.json({ok:false,error:'STORE_YIELD',retryable:true},{status:503});
 };
 const ui=await launch(t,{idb:indexedDBDouble(),fetcher,hash:'#settings',timers:[]}),legacy=ui.raw;
 await ui.click('view-tab',{tab:'drive'});await ui.click('cloud-login');await callback({credential:'test-credential'});
 assert.equal(ui.editor.open,false);assert.equal(ui.raw,legacy);assert.equal(ui.writes,0);
 assert.match(ui.notice.innerHTML,/クラウドの記録はまだ取得できていません/);assert.match(ui.app.innerHTML,/今すぐ同期/);
 assert.doesNotMatch(ui.app.innerHTML,/Google Drive に保存済み/);assert.match(ui.app.innerHTML,/このブラウザーのみ/);
});

test('valid large cloud records remain displayable beyond the JSON backup byte limit',async t=>{
 const large=createInitialState();for(let i=0;i<1100;i++)large.diary[addDays('2000-01-01',i)]={text:'あ'.repeat(4000),mood:null};
 assert.throws(()=>serializeBackup(large),/12MiB/);const idb=indexedDBDouble({...cachedCloud(large).read(),syncProtocol:2,syncCheckpoint:{store:'owner',generation:'generation',seq:0},minimumObserved:{revision:1,hash:'a'.repeat(64)}});let authenticated=false;
 const fetcher=async(path,options)=>{
  if(path==='/api/auth/session')return Response.json({ok:true,authenticated,csrf:'test'});
  const {action}=JSON.parse(options.body);
  if(action==='pull')return Response.json({ok:true,result:{protocol:2,mode:'delta',store:'owner',generation:'generation',epoch:'epoch',revision:2,headHash:'b'.repeat(64),fromSeq:0,targetSeq:1,throughSeq:1,entries:[{key:'wake:'+todayKey(),version:1,deleted:false,value:'06:05'}],nextCursor:null,checkpoint:{store:'owner',generation:'generation',seq:1},syncMeta:{format:1,imports:{ok:true,result:{revision:2,runs:[],nextCursor:null}},importStatus:{ok:true,result:{status:'idle'}}}}});
  throw Error('Unexpected request');
 };
 const ui=await launch(t,{idb,fetcher,modePreference:'cloud',pullSupported:true,timers:[]});
 // The delta leaves the large diary baseline intact while changing a single
 // visible record. The cloud read must not use the export-size gate.
 authenticated=true;await ui.click('cloud-sync');
 assert.match(ui.app.innerHTML,/06:05/);assert.equal(idb.read().outbox.length,0);assert.equal(Object.keys(idb.read().entities).filter(key=>key.startsWith('diary:')).length,1100);assert.equal(ui.writes,0);
});

function draftSyncServer(initial){
 let state=structuredClone(initial),seq=0,revision=1,changed=[];const versions=new Map(Object.keys(stateToEntities(initial)).map(key=>[key,1]));
 const entries=()=>Object.entries(stateToEntities(state)).map(([key,value])=>({key,value,version:versions.get(key)||1,deleted:false}));
 return {change(next,keys){state=structuredClone(next);seq++;revision++;changed=keys.map(key=>{versions.set(key,(versions.get(key)||0)+1);const value=stateToEntities(state)[key];return {key,version:versions.get(key),deleted:value===undefined,value:value??null};});},fetcher:async(path,options)=>{
  if(path==='/api/auth/session')return Response.json({ok:true,authenticated:true,csrf:'test'});
  const {action,payload}=JSON.parse(options.body);
  if(action==='command')return Response.json({ok:false,error:'WRITER_BUSY',retryable:true},{status:503});
  if(action!=='pull')throw Error('Unexpected action '+action);
  const snapshot=payload.since===null;
  return Response.json({ok:true,result:{protocol:2,mode:snapshot?'snapshot':'delta',store:'owner',generation:'generation',epoch:'epoch',revision,headHash:revision.toString(16).padStart(64,'0'),fromSeq:snapshot?null:payload.since.seq,targetSeq:seq,throughSeq:seq,entries:snapshot?entries():payload.since.seq<seq?changed:[],nextCursor:null,checkpoint:{store:'owner',generation:'generation',seq},syncMeta:{format:1,imports:{ok:true,result:{revision,runs:[],nextCursor:null}},importStatus:{ok:true,result:{status:'idle'}}}}});
 }};
}

test('remote change to an open diary preserves its typed draft and blocks stale save/delete until fresh review',async t=>{
 const date=todayKey(),initial={...createInitialState(),diary:{[date]:{text:'original',mood:null}}},idb=cachedCloud(initial),server=draftSyncServer(initial),ui=await launch(t,{idb,fetcher:server.fetcher,modePreference:'cloud',hash:'#diary',pullSupported:true,timers:[]});
 await ui.click('diary-edit');const textarea=ui.editor.querySelector('textarea');textarea.value='unsaved typed draft';const writes=ui.editor.htmlWrites;
 server.change({...initial,diary:{[date]:{text:'new remote entry',mood:null}}},['diary:'+date]);await ui.click('cloud-sync');
 assert.equal(ui.editor.open,true);assert.equal(ui.editor.htmlWrites,writes);assert.equal(ui.editor.querySelector('textarea'),textarea);assert.equal(textarea.value,'unsaved typed draft');assert.match(ui.editor.querySelector('#form-error').textContent,/入力中の内容は残しています/);
 await ui.submit('diary',{text:'unsaved typed draft',mood:''});assert.equal(ui.editor.open,true);assert.equal(idb.read().outbox.length,0);assert.equal(idb.read().entities['diary:'+date].value.text,'new remote entry');
 await ui.click('diary-delete');assert.equal(ui.editor.htmlWrites,writes);assert.equal(ui.editor.open,true);assert.equal(idb.read().outbox.length,0);
 await ui.click('dialog-close');await ui.click('diary-edit');assert.match(ui.editor.innerHTML,/new remote entry/);await ui.submit('diary',{text:'reviewed saved draft',mood:''});assert.equal(idb.read().outbox.length,1);assert.equal(idb.read().outbox[0].command.value.text,'reviewed saved draft');
});

test('an unrelated remote change keeps a diary draft editable and its save preserves the remote record',async t=>{
 const date=todayKey(),initial={...createInitialState(),diary:{[date]:{text:'original',mood:null}}},idb=cachedCloud(initial),server=draftSyncServer(initial),ui=await launch(t,{idb,fetcher:server.fetcher,modePreference:'cloud',hash:'#diary',pullSupported:true,timers:[]});
 await ui.click('diary-edit');const textarea=ui.editor.querySelector('textarea');textarea.value='unrelated update must keep this';const writes=ui.editor.htmlWrites;
 server.change({...initial,wake:{[date]:'05:15'}},['wake:'+date]);await ui.click('cloud-sync');assert.equal(ui.editor.open,true);assert.equal(ui.editor.htmlWrites,writes);assert.equal(textarea.value,'unrelated update must keep this');
 await ui.submit('diary',{text:'save after unrelated update',mood:''});assert.equal(ui.editor.open,false);assert.equal(idb.read().outbox.length,1);assert.equal(idb.read().outbox[0].command.key,'diary:'+date);assert.equal(idb.read().entities['wake:'+date].value,'05:15');
});

for(const kind of ['wake','target','run','habit','habit-log','event'])test(`remote ${kind} changes preserve the matching open editor and prevent stale submission`,async t=>{
 const date=todayKey(),initial=createInitialState();initial.wake[date]='07:00';initial.settings.wakeTarget='07:30';initial.runs=[{id:'run1',date,distanceKm:5,durationSec:1800,note:'original',points:[]}];initial.habits=[{id:'read',name:'Reading',type:'number',unit:'pages',target:10,archived:false}];initial.habitLogs={read:{[date]:2}};initial.events=[{id:'event1',date,time:null,title:'Original event',note:''}];
 const next=structuredClone(initial);let action,context={},key,values;
 if(kind==='wake'){action='wake-edit';key='wake:'+date;next.wake[date]='08:00';values={time:'06:00'};}
 if(kind==='target'){action='target-edit';key='settings:wakeTarget';next.settings.wakeTarget='08:00';values={target:'06:00'};}
 if(kind==='run'){action='run-edit';context={id:'run1'};key='run:run1';next.runs[0].note='Remote run';values={id:'run1',date,distance:'5',minutes:'30',seconds:'0',note:'Typed run'};}
 if(kind==='habit'){action='habit-edit';context={id:'read'};key='habit:read';next.habits[0].name='Remote habit';values={id:'read',name:'Typed habit',type:'number',unit:'pages',target:'12'};}
 if(kind==='habit-log'){action='habit-log';context={id:'read'};key='habitLog:read:'+date;next.habitLogs.read[date]=9;values={id:'read',value:'5'};}
 if(kind==='event'){action='event-edit';context={id:'event1'};key='event:event1';next.events[0].title='Remote event';values={id:'event1',date,time:'',title:'Typed event',note:''};}
 const idb=cachedCloud(initial),server=draftSyncServer(initial),ui=await launch(t,{idb,fetcher:server.fetcher,modePreference:'cloud',pullSupported:true,timers:[]});await ui.click(action,context);const field=ui.editor.querySelector('input');field.value='retained draft';const writes=ui.editor.htmlWrites;
 server.change(next,[key]);await ui.click('cloud-sync');assert.equal(ui.editor.open,true);assert.equal(ui.editor.htmlWrites,writes);assert.equal(field.value,'retained draft');assert.match(ui.editor.querySelector('#form-error').textContent,/入力中の内容は残しています/);
 await ui.submit(kind,values);assert.equal(ui.editor.open,true);assert.equal(idb.read().outbox.length,0);assert.equal(ui.editor.htmlWrites,writes);
});

test('advisory cloud renders retain the active date control node until focus leaves',async t=>{
 const initial=createInitialState(),idb=cachedCloud(initial),server=draftSyncServer(initial),ui=await launch(t,{idb,fetcher:server.fetcher,modePreference:'cloud',pullSupported:true,timers:[]});
 const input=ui.app.querySelector('#selected-date');input.matches=()=>true;input.value='';input.partialNativeSegment='2026-__-08';ui.app.contains=node=>node===input;ui.document.activeElement=input;
 const before=ui.app.htmlWrites;
 server.change({...initial,wake:{[todayKey()]:'06:20'}},['wake:'+todayKey()]);await ui.click('cloud-sync');
 assert.equal(ui.app.htmlWrites,before,'status and remote-state callbacks do not replace the control');assert.equal(ui.app.querySelector('#selected-date'),input);assert.equal(input.partialNativeSegment,'2026-__-08');
 ui.document.activeElement=null;await ui.document.emit('focusout');await Promise.resolve();assert(ui.app.htmlWrites>before);assert.match(ui.app.innerHTML,/06:20/);
});
