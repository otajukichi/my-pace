import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createInitialState} from '../src/lib/domain.js';
import {createDriveUI,renderDrivePanel,driveConfigDialog,DRIVE_CONFIG_KEY} from '../src/lib/drive-ui.js';

const config={clientId:'402304619999-example.apps.googleusercontent.com',apiKey:'AIza'+'x'.repeat(35)};
function fixture(){
  let state=createInitialState(),prepared=false,connected=false,folder=false,dialog=null,pendingDialogClose=null;
  const calls=[],data=new Map(),status={state:'disconnected',message:'未接続',connected:false,dirty:true,verified:false,autosave:false,locksAvailable:true,busy:false,pendingCount:0};
  const inspection={status:'empty',heads:[],snapshots:[]};
  const store={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
  const api={isPrepared:()=>prepared,isConnected:()=>connected,prepare:async()=>{calls.push('prepare');prepared=true;},connect:async c=>{calls.push(['connect',c]);connected=true;},selectFolder:async()=>{calls.push('picker');folder=true;return{id:'1kqtRzzNKZAq7-HE83XIN_JErtBn9YM_6'};},disconnect(){calls.push('disconnect');connected=false;}};
  const coordinator={getStatus:()=>status,connectFolder:async()=>{status.connected=true;},setReady(){},disconnect(){status.connected=false;status.autosave=false;},inspect:async()=>{calls.push('inspect');return inspection;},save:async choice=>{calls.push(['save',choice]);status.verified=true;},load:async(id,choice)=>{calls.push(['load',id,choice]);},setAutosave(value){calls.push(['autosave',value]);status.autosave=value;},notifyLocalChange(){calls.push('dirty');}};
  const ui=createDriveUI({getState:()=>state,applyState:s=>{state=s;return true;},onChange(){},toast:text=>calls.push(['toast',text]),showDialog(markup,context){pendingDialogClose?.();dialog={markup,context};},closeDialog(){dialog=null;ui.dialogClosed();},download(){},storage:()=>store,apiFactory:()=>api,coordinatorFactory:()=>coordinator});
  return {ui,calls,data,status,inspection,coordinator,setState:s=>{state=s;},get dialog(){return dialog;},setCloseOnReplace(){pendingDialogClose=()=>ui.dialogClosed();},submitConfig:remember=>ui.submit('drive-config',{get:key=>key==='remember'?(remember?'on':null):config[key]})};
}

test('initial Drive UI is local only and never loads SDKs or reads configuration',()=>{
  const f=fixture();assert.deepEqual(f.calls,[]);assert.equal(f.ui.view().configured,false);
  assert.match(renderDrivePanel(f.ui.view()),/既存の running_data と CSV は読み書きしません/);
  assert.match(renderDrivePanel(f.ui.view()),/閉じている間は同期しません/);
  assert.match(renderDrivePanel(f.ui.view()),/data-action="drive-auto-on" disabled/);
});

test('public browser configuration is remembered only by explicit checkbox and can be removed',async()=>{
  const f=fixture();await f.submitConfig(false);assert.equal(f.data.has(DRIVE_CONFIG_KEY),false);
  await f.submitConfig(true);assert.equal(JSON.parse(f.data.get(DRIVE_CONFIG_KEY)).apiKey,config.apiKey);
  await f.submitConfig(false);assert.equal(f.data.has(DRIVE_CONFIG_KEY),false);
  assert.equal(f.calls.some(c=>Array.isArray(c)&&c[0]==='connect'),false);
});

test('config dialog escapes fields and does not request client secrets',()=>{
  const html=driveConfigDialog({clientId:'"><img src=x>',apiKey:'secret'},false);
  assert.doesNotMatch(html,/<img src=x>/);assert.match(html,/name="apiKey" type="password"/);
  assert.match(html,/クライアント シークレット・パスワード・トークンは入力しません/);
  assert.doesNotMatch(html,/type="checkbox" checked/);
});

test('SDK preparation, OAuth connection and Picker selection require separate explicit actions',async()=>{
  const f=fixture();await f.submitConfig(false);await f.ui.handle('drive-prepare');
  assert.equal(f.calls.filter(c=>c==='prepare').length,1);assert.equal(f.calls.includes('picker'),false);
  await f.ui.handle('drive-connect');assert.equal(f.calls.includes('picker'),false);
  await f.ui.handle('drive-folder');assert.ok(f.calls.includes('picker'));assert.ok(f.calls.includes('inspect'));
  assert.equal(f.calls.some(c=>Array.isArray(c)&&c[0]==='save'),false);
});

test('cancelled first-save confirmation never uploads and repeated confirm only saves once',async()=>{
  const f=fixture();await f.submitConfig(false);await f.ui.handle('drive-prepare');await f.ui.handle('drive-connect');await f.ui.handle('drive-folder');
  await f.ui.handle('drive-save');assert.match(f.dialog.markup,/日記・予定・位置情報も含まれます/);
  f.ui.dialogClosed();await f.ui.handle('drive-save-confirm');assert.equal(f.calls.some(c=>Array.isArray(c)&&c[0]==='save'),false);
  await f.ui.handle('drive-save');await f.ui.handle('drive-save-confirm');await f.ui.handle('drive-save-confirm');
  assert.equal(f.calls.filter(c=>Array.isArray(c)&&c[0]==='save').length,1);
  const saved=f.calls.find(c=>Array.isArray(c)&&c[0]==='save')[1];assert.equal(saved.explicit,true);assert.match(saved.expectedLocalHash,/^[a-f0-9]{64}$/);
});

test('autosave needs separate confirmation and cancelling it does not enable uploads',async()=>{
  const f=fixture();await f.submitConfig(false);await f.ui.handle('drive-prepare');await f.ui.handle('drive-connect');await f.ui.handle('drive-folder');
  await f.ui.handle('drive-auto-on');f.ui.dialogClosed();await f.ui.handle('drive-auto-confirm');assert.equal(f.status.autosave,false);
  await f.ui.handle('drive-auto-on');await f.ui.handle('drive-auto-confirm');assert.equal(f.status.autosave,true);
  await f.ui.handle('drive-auto-off');assert.equal(f.status.autosave,false);
});

test('conflict decisions carry exact displayed heads and never select by timestamp',async()=>{
  const f=fixture();await f.submitConfig(false);await f.ui.handle('drive-prepare');await f.ui.handle('drive-connect');await f.ui.handle('drive-folder');
  Object.assign(f.inspection,{status:'conflict',heads:['a','b']});
  await f.ui.handle('drive-save');await f.ui.handle('drive-save-confirm');
  const saved=f.calls.find(c=>Array.isArray(c)&&c[0]==='save')[1];assert.equal(saved.resolution,true);assert.deepEqual(saved.expectedHeads,['a','b']);
});

test('replacing choose dialog retains only the freshly confirmed load and closing invalidates it',async()=>{
  const f=fixture();await f.submitConfig(false);await f.ui.handle('drive-prepare');await f.ui.handle('drive-connect');await f.ui.handle('drive-folder');
  f.inspection.heads=['a'];f.inspection.snapshots=[{fileId:'f',envelope:{commitId:'a',createdAt:'2026-10-06T00:00:00Z',state:createInitialState()}}];
  f.setCloseOnReplace();await f.ui.handle('drive-choose');await f.ui.submit('drive-choose',{get:()=> 'a'});
  assert.match(f.dialog.markup,/現在の全データを置き換えます/);await f.ui.handle('drive-load-confirm');assert.equal(f.calls.filter(c=>Array.isArray(c)&&c[0]==='load').length,1);
});

test('Drive status and snapshot content cannot inject HTML',()=>{
  const html=renderDrivePanel({message:'<img src=x onerror=alert(1)>',status:{message:'',state:'error',dirty:true},inspection:{status:'conflict',snapshots:[],heads:['a']}});
  assert.doesNotMatch(html,/<img src=x/);assert.match(html,/&lt;img/);
});

test('initial HTML includes no third-party scripts, secrets or eager connections',async()=>{
  const html=await fs.readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/accounts\.google|apis\.google|preconnect|client_secret|AIza/);
});

test('ambiguous previous upload has a retry route even when fresh inspection needs a choice',async()=>{
  const f=fixture();await f.submitConfig(false);await f.ui.handle('drive-prepare');await f.ui.handle('drive-connect');await f.ui.handle('drive-folder');
  f.status.pendingCount=1;f.inspection.status='choice-required';f.inspection.heads=['previous'];
  await f.ui.handle('drive-save');assert.match(f.dialog.markup,/前回確認した送信待ちの版/);assert.match(f.dialog.markup,/新しい編集は、この送信では反映されず/);
  await f.ui.handle('drive-save-confirm');assert.equal(f.calls.find(c=>Array.isArray(c)&&c[0]==='save')[1].resolution,false);
});

test('navigation during confirmation hashing does not reopen an old dialog',async()=>{
  const f=fixture();const operation=f.ui.handle('drive-save');f.ui.navigate();await operation;assert.equal(f.dialog,null);
});

test('closing the chooser during hash validation does not reopen a stale confirmation',async()=>{
  const f=fixture();await f.submitConfig(false);await f.ui.handle('drive-prepare');await f.ui.handle('drive-connect');await f.ui.handle('drive-folder');
  f.inspection.heads=['a'];f.inspection.snapshots=[{fileId:'f',envelope:{commitId:'a',createdAt:'2026-10-06T00:00:00Z',state:createInitialState()}}];
  await f.ui.handle('drive-choose');const original=f.dialog;const operation=f.ui.submit('drive-choose',{get:()=> 'a'});f.ui.dialogClosed();await operation;assert.equal(f.dialog,original);
});

test('entering Drive settings loads opted-in configuration without external requests',()=>{
  const f=fixture();f.data.set(DRIVE_CONFIG_KEY,JSON.stringify(config));f.ui.enter();assert.equal(f.ui.view().configured,true);assert.deepEqual(f.calls,[]);
});

test('historical metadata is paginated without hydrating archived state in the chooser',async()=>{
  const f=fixture();await f.submitConfig(false);await f.ui.handle('drive-prepare');await f.ui.handle('drive-connect');await f.ui.handle('drive-folder');
  f.inspection.heads=['c59'];f.inspection.historyCount=60;
  f.inspection.history=Array.from({length:60},(_,i)=>({fileId:`f${i}`,commitId:`c${i}`,createdAt:new Date(Date.UTC(2026,0,1+i)).toISOString()}));
  f.inspection.snapshots=[{fileId:'f59',envelope:{commitId:'c59',createdAt:'2026-03-01T00:00:00.000Z',state:createInitialState()}}];
  await f.ui.handle('drive-choose');assert.equal((f.dialog.markup.match(/<option /g)||[]).length,25);assert.match(f.dialog.markup,/1 \/ 3ページ/);
  await f.ui.handle('drive-history-next');assert.match(f.dialog.markup,/2 \/ 3ページ/);assert.equal((f.dialog.markup.match(/<option /g)||[]).length,25);
  await f.ui.handle('drive-history-next');assert.equal((f.dialog.markup.match(/<option /g)||[]).length,10);
  assert.match(renderDrivePanel(f.ui.view()),/保存済み 60版/);
});

test('historical preview binds reviewed remote hash into the eventual restore',async()=>{
  const f=fixture();await f.submitConfig(false);await f.ui.handle('drive-prepare');await f.ui.handle('drive-connect');await f.ui.handle('drive-folder');
  f.inspection.heads=['new'];f.inspection.history=[{fileId:'f',commitId:'old',createdAt:'2026-10-06T00:00:00.000Z'}];
  f.inspection.snapshots=[{fileId:'h',envelope:{commitId:'new',createdAt:'2026-10-06T01:00:00.000Z',state:createInitialState()}}];
  f.coordinator.preview=async id=>({fileId:'f',envelope:{commitId:id,hash:'a'.repeat(64),state:createInitialState()},heads:['new']});
  await f.ui.handle('drive-choose');await f.ui.submit('drive-choose',{get:()=> 'old'});assert.match(f.dialog.markup,/この版の JSON を保存/);
  await f.ui.handle('drive-load-confirm');assert.equal(f.calls.find(c=>Array.isArray(c)&&c[0]==='load')[2].expectedSnapshotHash,'a'.repeat(64));
});
