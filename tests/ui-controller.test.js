/** Controller tests with a deliberately minimal event/DOM double.
 * They cover state transitions and interruption safety, not native browser rendering,
 * validation, focus trapping, keyboard behavior, file pickers, or accessibility layout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState, serializeBackup, todayKey, addDays} from '../src/lib/domain.js';
import {STORAGE_KEY} from '../src/lib/storage.js';

let instance=0;
class EventNode {
  constructor(){this.dataset={};this.handlers=new Map();this._innerHTML='';this.htmlWrites=0;this.hidden=true;this.open=false;this.fields=new Map();this.focused=false;this.focusCalls=0;}
  get innerHTML(){return this._innerHTML;}
  set innerHTML(value){this._innerHTML=value;this.htmlWrites++;this.fields.clear();}
  addEventListener(type,handle){this.handlers.set(type,[...(this.handlers.get(type)||[]),handle]);}
  async emit(type,event={}){for(const handle of this.handlers.get(type)||[]) await handle(event);}
  showModal(){this.open=true;}
  close(){if(this.open){this.open=false;for(const handle of this.handlers.get('close')||[])handle({});}}
  focus(){this.focused=true;this.focusCalls++;}
  querySelector(selector){if(!this.fields.has(selector))this.fields.set(selector,new EventNode());return this.fields.get(selector);}
  click(){this.clicked=true;}
}
async function launch(t,{initial=createInitialState(),raw:initialRaw,hash='#home',denyRead=false,width=1280,height=900}={}) {
  const originals=new Map(), app=new EventNode(), editor=new EventNode(), notice=new EventNode(), main=new EventNode();
  const document=new EventNode(), window=new EventNode(), created=[];
  window.innerWidth=width;window.innerHeight=height;
  const location={hash}; let raw=initialRaw===undefined?serializeBackup(initial):initialRaw, deniedRead=denyRead, deniedWrite=false, writes=0;
  document.documentElement = {dataset: {}};
  document.querySelector=selector=>({'#app':app,'#editor':editor,'#notice':notice,main}[selector]||null);
  document.createElement=tag=>{const node=new EventNode();node.tag=tag;created.push(node);return node;};
  const localStorage={getItem(key){assert.equal(key,STORAGE_KEY);if(deniedRead)throw new Error('Storage denied');return raw;},setItem(key,value){assert.equal(key,STORAGE_KEY);if(deniedWrite)throw new Error('Quota exceeded');raw=value;writes++;}};
  const FormData=class{constructor(form){this.values=form.values;}get(key){return this.values[key]??null;}};
  for(const [key,value] of Object.entries({document,window,location,localStorage,FormData,requestAnimationFrame:callback=>callback()})) {
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
  assert.match(ui.app.innerHTML,/Google の準備/);assert.match(ui.app.innerHTML,/data-action="drive-auto-on" disabled/);
  assert.equal(ui.writes,0);
});

test('switching settings tabs while Drive confirmation hashes cancels the stale dialog',async t=>{
  const ui=await launch(t,{hash:'#settings'});await ui.click('view-tab',{tab:'drive'});
  const saving=ui.click('drive-save');await ui.click('view-tab',{tab:'backup'});await saving;
  assert.equal(ui.editor.open,false);assert.match(ui.app.innerHTML,/JSON を保存/);
});
