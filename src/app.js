import {createDailyCacheStorage} from './lib/daily-cache.js';
import {createDailyRunning,runningDayKey} from './lib/daily-running.js';
import {mountRouteMaps,disposeRouteMaps,discardRouteMapRegistration,reusePreparedRouteMap} from './lib/route-map.js';
import  {
  createInitialState,todayKey,addDays,isDateKey,validateState,parseBackup,serializeBackup,makeId,upsertWake,upsertHabitLog,upsertEvent,removeEvent,upsertDiary,removeDiary
}
from './lib/domain.js';
import  {
  loadState,saveState,STORAGE_KEY
}
from './lib/storage.js';
import  {
  e,icon,dayLabel
}
from './lib/ui.js';
import  {
  renderDashboard
}
from './views/dashboard.js';
import  {
  renderWake
}
from './views/wake.js';
import  {
  renderRunning
}
from './views/running.js';
import  {
  renderHabits
}
from './views/habits.js';
import  {
  renderSettings
}
from './views/settings.js';
import  {
  wakeDialog,targetDialog,habitDialog,habitLogDialog,confirmDialog
}
from './dialogs.js';
import {captureFocus,restoreFocus as restoreElementFocus} from './lib/focus.js';
import {renderNavigation,bindNavigationTooltips} from './lib/navigation.js';
import {renderCalendar} from './views/calendar.js';
import {renderDiary} from './views/diary.js';
import {renderGarden} from './views/garden.js';
import {eventDialog,diaryDialog} from './journal-dialogs.js';
import {pageCapacity,habitPageCapacity} from './lib/workspace.js';
import {gardenProgress,GARDEN_THEMES} from './lib/garden.js';
import {createCloudSync,createIndexedDBStorage} from './lib/cloud-sync.js';
import {cloudStatus,cloudErrorText,renderCloudPanel,migrationDialog,loadGoogleIdentity} from './lib/cloud-panel.js';
const app=document.querySelector('#app'), editor=document.querySelector('#editor'), notice=document.querySelector('#notice');
bindNavigationTooltips(document);
const loaded=loadState();
let state=loaded.state||createInitialState(), storageBlocked=!loaded.ok;
const MODE_KEY='mypace.persistence.mode.v1';
let preferredMode=null;try{preferredMode=localStorage.getItem(MODE_KEY);}catch{}
function rememberMode(value){preferredMode=value;try{localStorage.setItem(MODE_KEY,value);return localStorage.getItem(MODE_KEY)===value;}catch{return false;}}
let mode='local',initializing=true,commitPending=false,cloudOperation=false,advisoryRenderPending=false;
let loginAttempt=null,authUiGeneration=0,authRequestPending=null,localUpgradePrompt=null,legacyUpgradeApproved=null;
let legacyState=loaded.ok?structuredClone(state):null;
let selectedDate=location.hash==='#running'?runningDayKey():todayKey(), previousToday=location.hash==='#running'?runningDayKey():todayKey(), period=7, undoState=null, dialogContext=null, fileSequence=0, editorNeedsFocus=false;
const viewState={};
let renderedDailyReady=false;
let calendarMonth=selectedDate.slice(0,7),pageSize=pageCapacity(window.innerWidth,window.innerHeight),habitSize=habitPageCapacity(window.innerWidth,window.innerHeight);
const routes={
  home:{label:'ホーム',title:'今日の記録',subtitle:'記録と、これまでの積み重ね。',icon:'home',render:renderDashboard,tabs:[['today','今日'],['rhythm','積み重ね']]},
  running:{label:'ランニング',title:'ランニング',subtitle:'歩幅も、ペースも、自分らしく。',icon:'run',render:context=>renderRunning({...context,dailyView:dailyRunning.view(),dailyIdentity:dailyScope()}),tabs:[['record','記録']]},
  wake:{label:'早起き',title:'朝の記録',subtitle:'一日の始まりを、心地よく。',icon:'sun',render:renderWake,tabs:[['record','記録する'],['trends','推移'],['history','履歴']]},
  habits:{label:'習慣',title:'習慣',subtitle:'小さな積み重ねが、日常になる。',icon:'habits',render:renderHabits,tabs:[['active','今日の習慣'],['archived','お休み中']]},
  calendar:{label:'カレンダー',title:'カレンダー',subtitle:'予定も、記録も。日々をひと目に。',icon:'calendar',render:renderCalendar,tabs:[['month','月のながめ'],['agenda','予定一覧']]},
  diary:{label:'日記',title:'日記',subtitle:'何気ない一日を、言葉に。',icon:'book',render:renderDiary,tabs:[['entry','この日の日記'],['history','振り返る']]},
  garden:{label:'暮らしの庭',title:'暮らしの庭',subtitle:'記録した日が、小さな庭を育てる。',icon:'leaf',render:renderGarden,tabs:[['garden','庭をながめる'],['collection','模様替え'],['guide','育つしくみ']]},
  settings:{label:'設定',title:'設定',subtitle:'大切な記録を、これからも。',icon:'settings',render:context=>context.tab==='drive'?renderCloudPanel(cloudView(),mode):renderSettings({...context,mode}),tabs:[['backup','保存と復元'],['drive','Google Drive'],['about','このアプリ']]}
};
// Keep typed drafts separate from newly received cloud state. A changed record
// requires a fresh review; unrelated remote records can update behind the dialog.
function editorRecord(context,candidate){
  if(!context)return undefined;
  const type=context.type?.replace(/-delete$/,'');
  if(type==='wake'||type==='diary')return candidate[type][context.date]??null;
  if(type==='target')return candidate.settings.wakeTarget;
  if(type==='run'||type==='habit'||type==='event')return candidate[type==='run'?'runs':type==='habit'?'habits':'events'].find(item=>item.id===context.id)??null;
  if(type==='habit-log')return {habit:candidate.habits.find(item=>item.id===context.id)??null,value:candidate.habitLogs[context.id]?.[context.date]??null};
  if(type==='backup-restore')return candidate;
  return undefined;
}
function legacyBackupText(owner){return JSON.stringify({format:1,kind:'mypace-legacy-owner-backup',database:'mypace.owner-sync.v1',schema:1,owner:owner??null},null,2);}
function requestLocalUpgrade(owner){
 const text=legacyBackupText(owner);
 if(legacyUpgradeApproved===text)return true;
 legacyUpgradeApproved=null;localUpgradePrompt={text,exported:false};
 showDialog('<div class="dialog-top"><h2 id="dialog-title">この端末の保存形式を更新する前に</h2><button class="icon-button" data-action="dialog-close" aria-label="閉じる">閉じる</button></div><p>旧版のクラウド記録がこのブラウザーに残っています。まず、未送信の変更と競合を含む退避ファイルを保存してください。</p><p>更新すると、このブラウザーの保存形式は旧版では開けなくなります。ほかの端末・ブラウザーの記録はこの退避に含まれません。これは通常の JSON 復元用ではなく、障害時の復旧用ファイルです。旧版を開いているタブは閉じてください。</p><p>ファイルには個人の記録が含まれます。安全な場所に保存し、保存したファイルを確認してから更新してください。</p><div class="dialog-actions"><button class="btn secondary" data-action="cloud-storage-export">この端末の旧データを退避</button><button class="btn primary" data-action="cloud-storage-upgrade">退避ファイルを確認したので更新する</button><button class="btn secondary" data-action="dialog-close">今は更新しない</button></div><p id="form-error" class="form-error" hidden></p>',{type:'cloud-storage-upgrade'});
 return false;
}
const cloud=createCloudSync({storage:createIndexedDBStorage(globalThis.indexedDB,{onLegacyMigration:requestLocalUpgrade}),onChange:()=>render({advisory:true}),onRemoteState(candidate){
  if(mode!=='cloud')return;
  const next=validateState(candidate);
  // Cloud display is independent of the bounded JSON backup/import format.
  if(JSON.stringify(next)!==JSON.stringify(state)){
    const previousEntry=editorRecord(dialogContext,state),nextEntry=editorRecord(dialogContext,next);
    state=next;undoState=null;
    if(editor.open&&previousEntry!==undefined){
      if(JSON.stringify(previousEntry)!==JSON.stringify(nextEntry)){
        dialogContext.cloudChanged=true;++fileSequence;formError('EDITOR_REMOTE_CHANGED');
      }
    }else closeDialog();
  }
  storageBlocked=false;render({advisory:true});
}});
const dailyCache=createDailyCacheStorage();
const dailyRunning=createDailyRunning({storage:dailyCache,read:(date,hash)=>cloud.dailyRun(date,hash),onChange:()=>render({advisory:true})});
function dailyScope(){return preferredMode==='signed-out'||preferredMode==='local'?null:cloud.view().dailyIdentity;}
function screenToday(){return routeKey()==='running'?runningDayKey():todayKey();}

function cloudView(){const view=cloud.view();return preferredMode==='signed-out'||mode!=='cloud'&&!view.authenticated?{...view,authenticated:false,ready:false,recordsConfirmed:false,importedRuns:[],conflicts:[],importStatus:null,importErrors:{}}:view;}
const routeKey=()=>Object.hasOwn(routes,location.hash.slice(1))?location.hash.slice(1):'home';
function activeView() {
  const key=routeKey();
  return viewState[key]||(viewState[key]={tab:routes[key].tabs[0][0],page:0});
}
function render({focus=false,advisory=false}={}) {
  const previousDaily=dailyRunning.view();
  dailyRunning.setIdentity(dailyScope());
  if((previousDaily.daily||renderedDailyReady)&&!dailyRunning.view().daily)advisory=false;
  // A native date control can contain uncommitted segments that its value
  // property cannot represent. Keep the actual node until editing ends.
  if(advisory&&app.contains?.(document.activeElement)&&document.activeElement?.matches?.('input,textarea,select,[contenteditable="true"]')){
    advisoryRenderPending=true;
    const indicator=app.querySelector('.local-indicator');
    if(indicator)indicator.innerHTML=`<i></i> ${e(cloudStatus(cloud.view(),mode,initializing))}`;
    return;
  }
  advisoryRenderPending=false;
  const restoreFocus=Boolean(app.contains?.(document.activeElement));
  const focusSnapshot=captureFocus(app,document.activeElement);
  if(editor.open)editorNeedsFocus=true;
  const current=routeKey(),route=routes[current],today=screenToday(),view=activeView();
  if(current==='running')void dailyRunning.select(selectedDate>today?today:selectedDate);else dailyRunning.cancel();
  const futureAllowed=['calendar','diary'].includes(current),dateVisible=!['settings','garden'].includes(current);
  if(!futureAllowed&&selectedDate>today)selectedDate=today;
  document.title=`${route.label} · マイペース`;
  document.documentElement.dataset.page=current;
  const retainedMap=app.querySelector?.('.daily-running [data-map-identity]');
  app.innerHTML=`<div class="workspace"><header class="topbar"><a href="#home" class="topbar-brand" aria-label="マイペース ホーム"><img src="./favicon.svg" width="28" height="28" alt=""><span>マイペース</span></a>${renderNavigation(routes,current)}<span class="local-indicator"><i></i> ${e(cloudStatus(cloud.view(),mode,initializing))}</span></header><main id="main" tabindex="-1"><div class="page-heading"><div><p class="journal-date ${dateVisible&&selectedDate===today?'is-today':''}">${dateVisible?`${selectedDate.slice(0,4)}年 ${dayLabel(selectedDate)}`:e(route.label)}</p><h1>${current==='home'&&selectedDate!==today?'この日の記録':route.title}</h1></div>${dateVisible?`<div class="date-picker"><button class="icon-button" data-action="previous-day" aria-label="前の日" ${selectedDate==='1900-01-01'?'disabled':''}>${icon('left',17)}</button><label><span>${selectedDate===today?'今日':dayLabel(selectedDate,true)}</span><input id="selected-date" type="date" value="${selectedDate}" min="1900-01-01" max="${futureAllowed?'2200-12-31':today}" aria-label="表示する日付"></label><button class="icon-button" data-action="next-day" aria-label="次の日" ${selectedDate>=(futureAllowed?'2200-12-31':today)?'disabled':''}>${icon('right',17)}</button></div>`:''}</div>
  <div class="view-bar"><nav class="view-tabs" aria-label="${route.label}の表示">${route.tabs.map(([key,label])=>`<button type="button" data-action="view-tab" data-tab="${key}" aria-pressed="${view.tab===key}">${label}</button>`).join('')}</nav>${dateVisible&&selectedDate!==today?'<button class="text-link return-today" data-action="today">今日に戻る</button>':''}</div>
  ${storageBlocked?`<div class="error-banner" role="alert">保存データを読み込めません。記録の変更を止めています。<button class="text-link" data-action="backup-raw">既存データを退避</button><a href="#settings">設定で復元</a></div>`:''}
  <div class="view-stage" role="region" aria-label="${route.label}の内容" tabindex="0">${route.render({state,date:selectedDate,today,period,tab:view.tab,page:view.page,pageSize:current==='habits'?habitSize:pageSize,month:calendarMonth})}</div><footer class="app-footer"><span>マイペース</span><nav aria-label="アプリ情報"><a href="./about.html">このアプリについて</a><a href="./privacy.html">プライバシー</a><a href="./terms.html">利用について</a></nav></footer></main></div>`;
  const replacementMap=app.querySelector?.('.daily-running [data-map-identity]');
  if(retainedMap?.dataset?.mapDayIdentity&&retainedMap.dataset.mapDayIdentity===replacementMap?.dataset?.mapDayIdentity){
    replacementMap.replaceWith(retainedMap);
    if(reusePreparedRouteMap(retainedMap,replacementMap))discardRouteMapRegistration(replacementMap);else retainedMap.replaceWith(replacementMap);
  }
  renderedDailyReady=current==='running'&&dailyRunning.view().daily?.status==='ready';
  mountRouteMaps(app);
  if((focus||restoreFocus)&&!editor.open){
    if(focus||!restoreElementFocus(app,focusSnapshot))document.querySelector('main')?.focus();
  }
}
function toast(text,undo=false)  {
  notice.innerHTML=`<span>${e(text)}</span>${undo?'<button class="toast-undo" data-action="undo">元に戻す</button>':''}<button class="toast-close" data-action="notice-close" aria-label="通知を閉じる">${icon('close',16)}</button>`;
  notice.hidden=false;
}
async function commit(candidate,message, {
  allowBlocked=false,undo=true
}
= {
}
)  {
  if(initializing||commitPending){toast('保存処理を確認しています。少し待ってから操作してください。');return false;}
  if(storageBlocked&&!allowBlocked) {
    toast('保存できないため、変更していません。設定を確認してください。');
    return false;
  }
  commitPending=true;
  const before=state,context=dialogContext,commitMode=mode;
  try  {
    await Promise.resolve(); // Keep repeated dispatches locked through durable acknowledgement.
    if(mode==='cloud'&&context?.cloudChanged)throw Error('EDITOR_REMOTE_CHANGED');
    if(state!==before)throw Error('LOCAL_STATE_CHANGED');
    let next=validateState(candidate);
    if(mode==='cloud'){
      const result=await cloud.commit(before,next);
      if(!result.ok)return false;
      if(mode!==commitMode||preferredMode==='signed-out')return true;
      next=validateState(result.state);
    }else{
    if(!allowBlocked){
      const latest=loadState();
      if(!latest.ok||serializeBackup(latest.state)!==serializeBackup(state)){
        toast('別のタブで記録が変わったため、上書きを止めました。編集内容を控えてページを再読み込みしてください。');
        return false;
      }
    }
    const result=saveState(next);
    if(!result.ok) {
      toast(`保存できませんでした。変更は反映していません。${result.error||''}`);
      return false;
    }
    }
    undoState=undo?structuredClone(before):null;
    state=next;
    storageBlocked=false;
    if(mode==='local')legacyState=structuredClone(next);
    render();
    toast(message,undo);
    return true;
  }
  catch(error) {
    if(context===dialogContext)formError(error.message);else toast(error.message);
    return false;
  }finally{commitPending=false;}
}
async function commitAndClose(candidate,message,options){
  const context=dialogContext;
  const saved=await commit(candidate,message,options);
  if(saved&&dialogContext===context)closeDialog();
  return saved;
}
function releaseCloudOperation(owner){if(cloudOperation===owner)cloudOperation=false;}
function cancelLoginAttempt(){const attempt=loginAttempt;if(!attempt)return;loginAttempt=null;++authUiGeneration;releaseCloudOperation(attempt.operation);}
function currentLoginAttempt(attempt){return loginAttempt===attempt&&attempt.generation===authUiGeneration&&dialogContext===attempt.context&&fileSequence===attempt.sequence&&editor.open;}
async function authRequest(owner,request){authRequestPending=owner;try{return await request();}finally{if(authRequestPending===owner)authRequestPending=null;}}
function cancelRouteRead(){}
function showDialog(markup,context = {}) {
  cancelRouteRead();
  if(dialogContext?.cloudChanged&&context.type?.endsWith('-delete'))throw Error('EDITOR_REMOTE_CHANGED');
  cancelLoginAttempt();
  ++fileSequence;
  const previousTheme=editor.open?editor.dataset.theme:routeKey();
  if(editor.open)editor.close();
  editor.dataset.theme=({wake:'wake',target:'wake',run:'running',habit:'habits','habit-log':'habits',event:'calendar','event-delete':'calendar',diary:'diary','diary-delete':'diary'})[context.type]||previousTheme;
  dialogContext=context;
  editorNeedsFocus=false;
  disposeRouteMaps(editor);
  editor.innerHTML=markup;
  editor.showModal();
  mountRouteMaps(editor);
  requestAnimationFrame(()=>editor.querySelector('[autofocus],input:not([type=hidden]),button')?.focus());
}
function closeDialog() {
  cancelRouteRead();
  cancelLoginAttempt();
  ++fileSequence;
  editor.close();
  disposeRouteMaps(editor);
  dialogContext=null;
  if(editorNeedsFocus){editorNeedsFocus=false;document.querySelector('main')?.focus();}
}
function formError(text) {
  text=({CLOUD_STATE_UNDISPLAYABLE:cloudErrorText('CLOUD_STATE_UNDISPLAYABLE'),EDITOR_REMOTE_CHANGED:'この記録が別の場所で更新されました。入力中の内容は残しています。内容を控えてからいったん閉じ、最新の記録を確認してください。',RECORD_TOO_LARGE_USE_FOLDER_IMPORT:'この記録は大きすぎます。大きな GPS データは Drive の CSV フォルダーから取り込んでください。',LOCAL_STATE_CHANGED:'別のタブで記録が更新されました。内容を控えてから再読み込みしてください。',MIGRATION_PREVIEW_CHANGED:'移行先が更新されました。いったん閉じて、移行内容をもう一度確認してください。',CONFLICT_CHANGED:'比べている記録が変わりました。閉じて最新の内容を確認してください。',CONFLICT_PREVIEW_CHANGED:'比べている間に記録が更新されました。閉じて最新の内容を確認してください。',CONFLICT_REFRESH_REQUIRED:'削除済みかを確認できませんでした。変更は端末に残っています。接続が戻ってから同期し、もう一度内容を確認してください。',SESSION_LOCKED:'ログアウトしています。Google でログインし直してください。',CLOUD_NOT_READY:'保存先の記録をまだ確認できていません。少し待ってからもう一度保存してください。',INDEXEDDB_BLOCKED_CLOSE_OTHER_TABS:cloudErrorText('INDEXEDDB_BLOCKED_CLOSE_OTHER_TABS'),INDEXEDDB_VERSION_CHANGED_RELOAD_REQUIRED:cloudErrorText('INDEXEDDB_VERSION_CHANGED_RELOAD_REQUIRED')})[text]||text;
  const target=editor.open?editor.querySelector('#form-error'):null;
  if(target) {
    target.textContent=text;
    target.hidden=false;
  }
  else toast(text);
}
function chooseFile(accept,handle)  {
  const seq=++fileSequence, startRoute=routeKey();
  const input=document.createElement('input');
  input.type='file';
  input.accept=accept;
  input.addEventListener('change',async()=> {
    const file=input.files?.[0];
    if(!file)return;
    try {
      if(file.size>12*1024*1024)throw new Error('12 MB 以下のファイルを選んでください。');
      const text=await file.text();
      if(seq!==fileSequence||startRoute!==routeKey())return;
      await handle(text,file);
    }
    catch(error) {
      if(seq!==fileSequence||startRoute!==routeKey())return;
      toast(error.message);
    }
  }
  ,  {
    once:true
  }
  );
  input.click();
}
function download(text,name) {
  const url=URL.createObjectURL(new Blob([text], {
    type:'application/json'
  }
  ));
  const a=document.createElement('a');
  a.href=url;
  a.download=name;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function getHabit(id) {
  return state.habits.find(h=>h.id===id);
}
async function openHabitLog(id) {
  const h=getHabit(id);
  if(!h||h.archived)return;
  const value=state.habitLogs[id]?.[selectedDate];
  if(h.type==='check') {
    await commit(upsertHabitLog(state,id,selectedDate,value!==true),value===true?'チェックを外しました':'できた、を記録しました');
  }
  else showDialog(habitLogDialog(h,value,selectedDate), {
    type:'habit-log',id,date:selectedDate
  }
  );
}
const actions= {
  'daily-retry':()=>dailyRunning.select(selectedDate,{force:true}),
  'view-tab':el=>{const view=activeView();if(!routes[routeKey()].tabs.some(([key])=>key===el.dataset.tab))return;if(routeKey()==='settings'&&view.tab==='drive'&&el.dataset.tab!=='drive')closeDialog();view.tab=el.dataset.tab;view.page=0;render({focus:true});},
  'view-page':el=>{const page=Number(el.dataset.page);if(!Number.isInteger(page)||page<0)return;activeView().page=page;render({focus:true});},
  'calendar-month':el=>{const offset=Number(el.dataset.offset);if(![-1,1].includes(offset))return;const [year,month]=calendarMonth.split('-').map(Number);const value=new Date(year,month-1+offset,1,12);const key=`${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}`;if(key<'1900-01'||key>'2200-12')return;calendarMonth=key;activeView().page=0;render({focus:true});},
  'calendar-today':()=>{selectedDate=screenToday();calendarMonth=selectedDate.slice(0,7);activeView().page=0;render({focus:true});},
  'calendar-day':el=>{if(!isDateKey(el.dataset.date))return;selectedDate=el.dataset.date;calendarMonth=selectedDate.slice(0,7);activeView().page=0;render({focus:true});},
  'diary-day':el=>{if(!isDateKey(el.dataset.date))return;selectedDate=el.dataset.date;calendarMonth=selectedDate.slice(0,7);viewState.diary={tab:'entry',page:0};if(routeKey()!=='diary')location.hash='#diary';render({focus:true});},
  'event-add':()=>showDialog(eventDialog(null,selectedDate),{type:'event'}),
  'event-edit':el=>{const event=state.events.find(item=>item.id===el.dataset.id);if(event)showDialog(eventDialog(event,selectedDate),{type:'event',id:event.id});},
  'event-delete':()=>{if(dialogContext?.type!=='event'||!dialogContext.id)return;showDialog(confirmDialog('予定を削除','この予定とメモを削除します。直後に元に戻せます。','削除する','event-delete-confirm'),{type:'event-delete',id:dialogContext.id});},
  'event-delete-confirm':async()=>{if(dialogContext?.type==='event-delete'&&dialogContext.id)await commitAndClose(removeEvent(state,dialogContext.id),'予定を削除しました');},
  'diary-edit':()=>showDialog(diaryDialog(state.diary[selectedDate],selectedDate),{type:'diary',date:selectedDate}),
  'diary-delete':()=>{if(dialogContext?.type!=='diary'||!state.diary[dialogContext.date])return;showDialog(confirmDialog('日記を削除','この日の日記を削除します。直後に元に戻せます。','削除する','diary-delete-confirm'),{type:'diary-delete',date:dialogContext.date});},
  'diary-delete-confirm':async()=>{if(dialogContext?.type==='diary-delete'&&dialogContext.date)await commitAndClose(removeDiary(state,dialogContext.date),'日記を削除しました');},
  'garden-plant':async el=>{const plant=el.dataset.plant;if(!gardenProgress(state,todayKey()).unlockedPlants.includes(plant))return;if(state.garden.plant===plant)return;await commit({...state,garden:{...state.garden,plant}},'庭の植物を変えました');},
  'garden-theme':async el=>{const theme=el.dataset.theme;if(!GARDEN_THEMES.some(item=>item.id===theme)||state.garden.theme===theme)return;await commit({...state,garden:{...state.garden,theme}},'庭の空を変えました');},
  'dialog-close':closeDialog,'notice-close':()=>notice.hidden=true,   'previous-day':()=> {
    if(selectedDate>'1900-01-01') {
      selectedDate=addDays(selectedDate,-1);
      calendarMonth=selectedDate.slice(0,7);activeView().page=0;
      render();
    }
  }
  ,   'next-day':()=> {
    if(selectedDate<(['calendar','diary'].includes(routeKey())?'2200-12-31':screenToday())) {
      selectedDate=addDays(selectedDate,1);
      calendarMonth=selectedDate.slice(0,7);activeView().page=0;
      render();
    }
  }
  ,   today:()=> {
    selectedDate=screenToday();
    calendarMonth=selectedDate.slice(0,7);activeView().page=0;
    render();
  }
  ,   'select-date':el=> {
    if(!isDateKey(el.dataset.date)||el.dataset.date>screenToday())return;
    selectedDate=el.dataset.date;
    calendarMonth=selectedDate.slice(0,7);
    activeView().page=0;
    render({focus:true});
  }
  ,   period:el=> {
    if(!['7','30'].includes(el.dataset.days))return;
    period=Number(el.dataset.days);
    render();
  }
  ,   'wake-now':async()=> {
    if(selectedDate!==todayKey())return;
    const now=new Date();
    const time=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    await commit(upsertWake(state,selectedDate,time),'おはよう。起きた時間を記録しました');
  }
  ,   'wake-edit':()=>showDialog(wakeDialog(selectedDate,state.wake[selectedDate]), {
    type:'wake',date:selectedDate
  }
  ),   'wake-history':el=> {
    const date=el.dataset.date;
    showDialog(wakeDialog(date,state.wake[date]), {
      type:'wake',date
    }
    );
  }
  ,   'wake-delete':async()=> {
    if(dialogContext?.type!=='wake'||!dialogContext.date)return;
    const next=structuredClone(state);
    delete next.wake[dialogContext.date];
    await commitAndClose(next,'起床の記録を削除しました');
  }
  ,   'target-edit':()=>showDialog(targetDialog(state.settings.wakeTarget), {
    type:'target'
  }
  ),   'habit-add':()=>showDialog(habitDialog(null), {
    type:'habit'
  }
  ),   'habit-edit':el=> {
    const habit=getHabit(el.dataset.id);
    if(habit)showDialog(habitDialog(habit), {
      type:'habit',id:habit.id
    }
    );
  }
  ,   'habit-log':el=>openHabitLog(el.dataset.id),   'habit-log-delete':async()=> {
    if(dialogContext?.type!=='habit-log'||!dialogContext.id||!dialogContext.date)return;
    const next=structuredClone(state);
    delete next.habitLogs[dialogContext.id][dialogContext.date];
    await commitAndClose(next,'習慣の記録を削除しました');
  }
  ,   'habit-archive':el=>commit( {
    ...state,habits:state.habits.map(h=>h.id===el.dataset.id? {
      ...h,archived:true
    }
    :h)
  }
  ,'習慣をお休み中にしました'),   'habit-restore':el=>commit( {
    ...state,habits:state.habits.map(h=>h.id===el.dataset.id? {
      ...h,archived:false
    }
    :h)
  }
  ,'習慣を再開しました'),   'backup-export':()=> {
    download(serializeBackup(state),`my-pace-backup-${todayKey()}.json`);
    toast('JSON バックアップのダウンロードを開始しました');
  }
  ,   'backup-raw':()=> {
    try {
      const raw=localStorage.getItem(STORAGE_KEY);
      if(raw)download(raw,`my-pace-recovery-${todayKey()}.json`);
      else toast('保存済みデータが見つかりません。');
    }
    catch {
      toast('ブラウザーの保存データにアクセスできません。');
    }
  }
  ,   'backup-import':()=>chooseFile('.json,application/json',(text)=> {
    const pending=parseBackup(text);
    const count=Object.keys(pending.wake).length+pending.runs.length+Object.values(pending.habitLogs).reduce((n,logs)=>n+Object.keys(logs).length,0);
    showDialog(confirmDialog('バックアップを復元',`${pending.habits.length}個の習慣・${count}件の記録・${pending.events.length}件の予定・${Object.keys(pending.diary).length}日の日記で、現在の全データを置き換えます。必要なら先に現在の JSON を保存してください。${storageBlocked?'現在の保存データが読み取れないため、この復元は取り消せません。':'復元直後は「元に戻す」で取り消せます。'}`,'置き換えて復元','backup-restore-confirm'), {
      type:'backup-restore',pending
    }
    );
  }
  ),   'backup-restore-confirm':async()=> {
    if(dialogContext?.type!=='backup-restore'||!dialogContext.pending)return;
    await commitAndClose(dialogContext.pending,'バックアップを復元しました', {
      allowBlocked:true,undo:!storageBlocked
    }
    );
  }
  ,   undo:async()=> {
    if(!undoState)return;
    const previous=undoState;
    await commitAndClose(previous,'ひとつ前の状態に戻しました', {
      undo:false
    }
    );
  }
  ,
};
async function openCloudLogin(){
 if(authRequestPending){toast('ログイン状態の確認が終わるのを待っています。少し待ってから、もう一度ログインしてください。');return;}
 showDialog('<div class="dialog-top"><h2 id="dialog-title">Google でログイン</h2><button class="icon-button" data-action="dialog-close" aria-label="閉じる">閉じる</button></div><p>オーナーの Google アカウントを選んでください。</p><div id="google-signin"></div><p id="form-error" class="form-error" hidden></p>',{type:'cloud-login'});
 const operation={},attempt={context:dialogContext,sequence:fileSequence,generation:++authUiGeneration,operation};loginAttempt=attempt;cloudOperation=operation;
 try{
  const challenge=await authRequest(operation,()=>cloud.login());if(!currentLoginAttempt(attempt))return;
  const identity=await loadGoogleIdentity();if(!currentLoginAttempt(attempt))return;
  identity.initialize({client_id:challenge.clientId,nonce:challenge.nonce,callback:async response=>{
   if(!currentLoginAttempt(attempt)||cloudOperation||authRequestPending)return;
   const completion={};attempt.operation=completion;cloudOperation=completion;
   try{
    const result=await authRequest(completion,()=>cloud.completeLogin(response.credential,challenge.csrf,{isCurrent:()=>currentLoginAttempt(attempt)}));
    if(!currentLoginAttempt(attempt))return;
    if(result.provisioningRequired){formError(`オーナー設定が必要です。導入手順に従って、この Google の識別子をサーバー設定に登録してください: ${result.ownerSubject}`);return;}
    if(result.authenticated){
     const cached=cloud.state();
     if(!cached){closeDialog();render();toast('ログインしました。クラウドの記録はまだ取得できていません。設定の Google Drive で同期状況を確認してください。');return;}
     mode='cloud';rememberMode('cloud');state=validateState(cached);storageBlocked=false;undoState=null;closeDialog();render();
     toast(cloud.view().error?'この端末に残っているクラウドの記録を開きました。設定の Google Drive で同期状況を確認してください。':'クラウドの記録を開きました。旧記録の移行は設定から確認できます。');
    }
   }catch(error){if(currentLoginAttempt(attempt))formError(error.message);}finally{releaseCloudOperation(completion);}
  }});
  if(currentLoginAttempt(attempt))identity.renderButton(editor.querySelector('#google-signin'),{theme:'outline',size:'large',text:'signin_with'});
 }catch(error){if(currentLoginAttempt(attempt))formError(error.message);}finally{releaseCloudOperation(operation);}
}
function showSignedOutState(){void dailyCache.clear();const local=loadState();mode='local';const remembered=rememberMode('signed-out');state=local.state||createInitialState();storageBlocked=!local.ok;undoState=null;closeDialog();render();return remembered;}
function logoutMessage(remembered,result){
 const server=result==='pending'?'サーバー側のログアウトを確認しています。':result==='confirmed'?'サーバー側のログアウトは確認できました。':'サーバー側のログアウトは確認できていません。';
 if(!remembered)return `このページのクラウド表示は閉じました。ログアウト状態をこのブラウザーに保存できませんでした。ほかのタブや、再読み込み・開き直しで、端末に残る記録が表示される可能性があります。${server}記録を失わないよう、このサイトのデータは消さないでください。`;
 return result==='pending'?'クラウドの表示を閉じました。サーバー側のログアウトを確認しています。端末にある記録は残っています。':result==='confirmed'?'マイペースからログアウトしました。端末内の記録と確認待ちの変更は残っています。':'クラウドの表示は閉じました。サーバー側のログアウトは確認できていません。端末内の記録と確認待ちの変更は残っています。';
}
async function closeCloudView(){
 if(authRequestPending?.kind==='logout')return;
 const authenticationPending=!!authRequestPending;cancelLoginAttempt();const generation=++authUiGeneration,operation={kind:'logout'};
 if(authenticationPending){
  // Local logout takes effect even during a prior sign-in. Do not race a new
  // cookie-changing request with that request or later clear a newer session.
  cloud.lock();const remembered=showSignedOutState();toast(logoutMessage(remembered,'unconfirmed'));return;
 }
 // logout captures its CSRF value before locking the sync session. Hide the
 // cached display in this same turn, without waiting for its HTTP response.
 const pending=authRequest(operation,()=>cloud.logout());
 const remembered=showSignedOutState();
 toast(logoutMessage(remembered,'pending'));const originalNotice=notice.innerHTML;
 try{
  await pending;
  if(generation===authUiGeneration&&preferredMode==='signed-out'&&!notice.hidden&&notice.innerHTML===originalNotice)toast(logoutMessage(remembered,'confirmed'));
 }catch{
  if(generation===authUiGeneration&&preferredMode==='signed-out'&&!notice.hidden&&notice.innerHTML===originalNotice)toast(logoutMessage(remembered,'unconfirmed'));
 }
}
async function handleCloud(button){
 const action=button.dataset.action;
 if(action==='cloud-storage-export'||action==='cloud-storage-upgrade'){
  if(dialogContext?.type!=='cloud-storage-upgrade'||!localUpgradePrompt)return;
  if(action==='cloud-storage-export'){download(localUpgradePrompt.text,`my-pace-owner-v1-recovery-${todayKey()}.json`);localUpgradePrompt.exported=true;return;}
  if(!localUpgradePrompt.exported){formError('先に退避ファイルを保存し、そのファイルを確認してください。');return;}
  legacyUpgradeApproved=localUpgradePrompt.text;closeDialog();
  try{const initial=await cloud.init({resume:preferredMode!=='signed-out'});if(initial.state&&(initial.authenticated||preferredMode==='cloud')&&!['local','signed-out'].includes(preferredMode)){mode='cloud';if(initial.authenticated)rememberMode('cloud');state=validateState(initial.state);storageBlocked=false;}render();}
  catch(error){legacyUpgradeApproved=null;toast(error.message==='INDEXEDDB_LEGACY_CHANGED_REVIEW_REQUIRED'?'旧データが別のタブで変わりました。更新していません。ほかのタブを閉じて、もう一度退避してから更新してください。':error.message);}
  return;
 }
 if(commitPending)return;
 if(action==='cloud-logout'&&(!cloudOperation||cloudOperation===loginAttempt?.operation||cloudOperation.kind==='sync')){await closeCloudView();return;}
 if(cloudOperation)return;
 if(action==='cloud-login'){await openCloudLogin();return;}
 if(action==='cloud-local'){
   const local=loadState();mode='local';rememberMode('local');state=local.state||createInitialState();legacyState=local.ok?structuredClone(state):null;storageBlocked=!local.ok;undoState=null;closeDialog();render();return;
 }
 if(action==='cloud-use'){
   if((!cloud.view().authenticated&&preferredMode!=='cloud')||preferredMode==='signed-out')throw Error('オーナーの Google アカウントでログインしてください。');
   const cached=cloud.state();if(!cached)throw Error('クラウドの記録はまだ取得できていません。');
   mode='cloud';rememberMode('cloud');state=validateState(cached);storageBlocked=false;undoState=null;closeDialog();render();return;
 }
 if(action==='cloud-migrate'){
   if((!cloud.view().authenticated&&preferredMode!=='cloud')||preferredMode==='signed-out')throw Error('オーナーの Google アカウントでログインしてください。');
   const local=loadState();if(!local.ok)throw Error('旧データが読み込めません。先に JSON を退避してください。');
   legacyState=structuredClone(local.state);
   const preview=cloud.migrationPreview(legacyState);
   showDialog(migrationDialog(preview),{type:'cloud-migration',local:structuredClone(legacyState),preview});return;
 }
 if(action==='cloud-conflict'){
   if(!cloudView().ready)return;
   const conflict=cloud.view().conflicts.find(c=>c.key===button.dataset.key);if(!conflict)return;
   showDialog(`<div class="dialog-top"><h2 id="dialog-title">どちらの記録を残しますか？</h2></div><p>${e(conflict.key)}</p><div class="info-note sync-review"><strong>この端末の変更</strong><p>${e(JSON.stringify(conflict.local))}</p><strong>クラウドの最新</strong><p>${e(JSON.stringify(conflict.remote))}</p></div><p>選んだ内容を残します。この操作の取り消しはできません。必要なら先に JSON を保存してください。</p><div class="dialog-actions"><button class="btn secondary" data-action="dialog-close">キャンセル</button><button class="btn secondary" data-action="cloud-resolve-remote">クラウドを残す</button><button class="btn primary" data-action="cloud-resolve-local">この端末を残す</button></div>`,{type:'cloud-conflict',key:conflict.key,conflict});return;
 }
 const operation={kind:action==='cloud-sync'?'sync':'mutation'};cloudOperation=operation;
 try{
   if(action==='cloud-sync'){await cloud.refreshSession({automatic:false});return;}
   if(action.startsWith('cloud-resolve-')){
     if(dialogContext?.type!=='cloud-conflict')return;
     const context=dialogContext;await cloud.resolveConflict(context.key,action==='cloud-resolve-local'?'local':'remote',context.conflict);
     if(context===dialogContext)closeDialog();return;
   }
 }finally{releaseCloudOperation(operation);}
}

async function onClick(event) {
  const button=event.target.closest('[data-action]');
  if(!button||button.disabled||button.isConnected===false)return;
  if(button.dataset.action.startsWith('cloud-')){
    event.preventDefault();
    try{await handleCloud(button);}catch(error){formError(error.message);}
    return;
  }
  const action=actions[button.dataset.action];
  if(action) {
    event.preventDefault();
    try {
      await action(button);
    }
    catch(error) {
      formError(error.message);
    }
  }
}
document.addEventListener('click',onClick);
document.addEventListener('change',event=> {
  if(event.target.id==='selected-date') {
    const value=event.target.value;
    if(isDateKey(value)&&value<=(['calendar','diary'].includes(routeKey())?'2200-12-31':screenToday())) {
      selectedDate=value;
      calendarMonth=value.slice(0,7);
      activeView().page=0;
      render({focus:true});
    }
  }
  if(event.target.name==='type'&&editor.open) {
    const type=event.target.value;
    editor.querySelector('#habit-details').hidden=type==='check';
    editor.querySelector('#habit-unit-field').hidden=type==='time';
    editor.querySelector('#time-unit-hint').hidden=type!=='time';
  }
}
);
editor.addEventListener('submit',async event=> {
  const form=event.target.closest('form');
  if(!form||form.isConnected===false)return;
  event.preventDefault();
  if(commitPending||cloudOperation||!form.reportValidity())return;
  const data=new FormData(form);
  const type=form.dataset.form;
  if(!dialogContext||!editor.open)return;
  if(dialogContext.type!==type)return;
  let next;
  try  {
    if(type==='cloud-migration'){const context=dialogContext;cloudOperation=true;try{await cloud.migrate(context.local,{overwriteKeys:data.getAll('overwrite'),expectedPreview:context.preview});if(dialogContext===context){mode='cloud';rememberMode('cloud');state=validateState(cloud.state());storageBlocked=false;closeDialog();render();toast('移行内容をこの端末に保存しました。同期状況を確認してください。');}}finally{cloudOperation=false;}return;}
    if(type==='wake'){if(dialogContext.date>todayKey())throw new Error('今日以前の日付を選んでください。');next=upsertWake(state,dialogContext.date,data.get('time'));}
    else if(type==='target')next= {
      ...state,settings: {
        ...state.settings,wakeTarget:data.get('target')||null
      }
    }
    ;
    else if(type==='habit') {
      const previous=getHabit(data.get('id'));
      const habitType=previous?.type||data.get('type');
      const h= {
        id:previous?.id||makeId(),name:data.get('name').trim(),type:habitType,unit:habitType==='time'?'分':habitType==='check'?'':data.get('unit').trim(),target:habitType==='check'?1:Number(data.get('target')),archived:previous?.archived||false
      }
      ;
      if(!h.name)throw new Error('習慣の名前を入力してください。');
      if(h.type==='number'&&!h.unit)throw new Error('数値の単位を入力してください。');
      next= {
        ...state,habits:previous?state.habits.map(item=>item.id===h.id?h:item):[...state.habits,h]
      }
      ;
    }
    else if(type==='habit-log')next=upsertHabitLog(state,dialogContext.id,dialogContext.date,Number(data.get('value')));
    else if(type==='event')next=upsertEvent(state,{id:dialogContext.id||makeId(),date:data.get('date'),time:data.get('time')||null,title:data.get('title').trim(),note:data.get('note').trim()});
    else if(type==='diary'){const text=data.get('text').trim(),mood=data.get('mood')||null;if(!text&&!mood)throw new Error('ひとこと、または気分を選んでください。');next=upsertDiary(state,dialogContext.date,{text,mood});}
    if(next)await commitAndClose(next,'記録を保存しました');
  }
  catch(error) {
    formError(error.message);
  }
}
);
editor.addEventListener('close',()=> {
  if(!editor.open){cancelRouteRead();disposeRouteMaps(editor);cancelLoginAttempt();dialogContext=null;++fileSequence;}
}
);
window.addEventListener('hashchange',()=> {

  ++fileSequence;
  closeDialog();
  render();
  document.querySelector('main')?.focus();
}
);
window.addEventListener('storage',event=> {
  if(event.key===MODE_KEY&&event.newValue==='signed-out'){void dailyCache.clear();cloud.lock();preferredMode='signed-out';mode='local';const local=loadState();state=local.state||createInitialState();storageBlocked=!local.ok;undoState=null;closeDialog();render();return;}
  if(event.key!==STORAGE_KEY&&event.key!==null)return;
  if(mode==='cloud'){const local=loadState();legacyState=local.ok?local.state:null;return;}
  const latest=loadState();
  closeDialog();
  undoState=null;
  if(latest.ok) {
    state=latest.state;
    storageBlocked=false;
    render();
    legacyState=structuredClone(state);
    toast('別のタブの最新の記録を読み込みました。');
  }
  else {
    storageBlocked=true;
    render();
    toast('保存データを読み込めません。変更を停止しました。');
  }
}
);
document.addEventListener('focusout',()=>{queueMicrotask(()=>{if(advisoryRenderPending)render({advisory:true});});});
document.addEventListener('visibilitychange',()=> {
  if(document.hidden)return;
  if(mode==='cloud')void cloud.refreshSession({automatic:true});
  const current=screenToday();
  if(current!==previousToday) {
    if(selectedDate===previousToday){selectedDate=current;calendarMonth=current.slice(0,7);}
    previousToday=current;
    // Keep an open editor: its context retains the original record date.
    render();
  }
}
);
window.addEventListener('resize',()=>{
  const capacity=pageCapacity(window.innerWidth,window.innerHeight);
  const habits=habitPageCapacity(window.innerWidth,window.innerHeight);
  if(capacity!==pageSize||habits!==habitSize){pageSize=capacity;habitSize=habits;render();}
});
render();
try{const initial=await cloud.init({resume:preferredMode!=='signed-out'});if(initial.state&&(initial.authenticated||preferredMode==='cloud')&&!['local','signed-out'].includes(preferredMode)){mode='cloud';if(initial.authenticated)rememberMode('cloud');state=validateState(initial.state);storageBlocked=false;}}catch(error){toast(error.message==='INDEXEDDB_UPGRADE_APPROVAL_REQUIRED'?'旧データは更新していません。この端末の退避と確認が済むまで、クラウド保存形式の更新を待ちます。':['INDEXEDDB_BLOCKED_CLOSE_OTHER_TABS','INDEXEDDB_VERSION_CHANGED_RELOAD_REQUIRED','CLOUD_STATE_UNDISPLAYABLE'].includes(error.message)?cloudErrorText(error.message):'クラウド用の端末保存を利用できません。ローカルの記録はそのままです。');}finally{initializing=false;render();}

const refreshTimer=setInterval(()=>{if(!document.hidden&&mode==='cloud'&&!commitPending&&!cloudOperation){void cloud.refreshSession({automatic:true,poll:true});if(routeKey()==='running')void dailyRunning.select(selectedDate,{force:true});}},60000);
refreshTimer?.unref?.();
window.addEventListener('pagehide',event=>{if(!event.persisted){clearInterval(refreshTimer);dailyRunning.clear();dailyCache.close();cloud.destroy();}});
