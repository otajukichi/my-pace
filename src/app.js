import  {
  createInitialState,todayKey,addDays,isDateKey,validateState,parseBackup,serializeBackup,makeId,upsertWake,upsertHabitLog,upsertEvent,removeEvent,upsertDiary,removeDiary
}
from './lib/domain.js';
import  {
  loadState,saveState,STORAGE_KEY
}
from './lib/storage.js';
import  {
  parseGpx
}
from './lib/gpx.js';
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
  wakeDialog,targetDialog,runDialog,habitDialog,habitLogDialog,confirmDialog
}
from './dialogs.js';
import {createSidebarController} from './lib/sidebar.js';
import {renderCalendar} from './views/calendar.js';
import {renderDiary} from './views/diary.js';
import {renderGarden} from './views/garden.js';
import {eventDialog,diaryDialog} from './journal-dialogs.js';
import {pageCapacity} from './lib/workspace.js';
import {gardenProgress,GARDEN_THEMES} from './lib/garden.js';
const app=document.querySelector('#app'), editor=document.querySelector('#editor'), notice=document.querySelector('#notice');
const sidebar=createSidebarController({document,window,editor});
const loaded=loadState();
let state=loaded.state||createInitialState(), storageBlocked=!loaded.ok;
let selectedDate=todayKey(), previousToday=todayKey(), period=7, undoState=null, dialogContext=null, fileSequence=0, editorNeedsFocus=false;
const viewState={};
let calendarMonth=selectedDate.slice(0,7),pageSize=pageCapacity(window.innerWidth,window.innerHeight);
const routes={
  home:{label:'ホーム',title:'今日の記録',subtitle:'自分のペースで、少しずつ。',icon:'home',render:renderDashboard,tabs:[['today','今日'],['rhythm','つづける']]},
  running:{label:'ランニング',title:'ランニング',subtitle:'歩幅も、ペースも、自分らしく。',icon:'run',render:renderRunning,tabs:[['record','記録する'],['trends','推移'],['history','履歴']]},
  wake:{label:'早起き',title:'朝の記録',subtitle:'一日の始まりを、心地よく。',icon:'sun',render:renderWake,tabs:[['record','記録する'],['trends','推移'],['history','履歴']]},
  habits:{label:'習慣',title:'習慣',subtitle:'小さな積み重ねが、日常になる。',icon:'habits',render:renderHabits,tabs:[['active','今日の習慣'],['archived','お休み中']]},
  calendar:{label:'カレンダー',title:'カレンダー',subtitle:'予定も、記録も。日々をひと目に。',icon:'calendar',render:renderCalendar,tabs:[['month','月のながめ'],['agenda','予定一覧']]},
  diary:{label:'日記',title:'日記',subtitle:'何気ない一日を、言葉に。',icon:'book',render:renderDiary,tabs:[['entry','この日の日記'],['history','振り返る']]},
  garden:{label:'暮らしの庭',title:'暮らしの庭',subtitle:'記録した日が、小さな庭を育てる。',icon:'leaf',render:renderGarden,tabs:[['garden','庭をながめる'],['collection','模様替え'],['guide','育つしくみ']]},
  settings:{label:'設定',title:'設定',subtitle:'大切な記録を、これからも。',icon:'settings',render:renderSettings,tabs:[['backup','保存と復元'],['about','このアプリ']]}
};
const routeKey=()=>Object.hasOwn(routes,location.hash.slice(1))?location.hash.slice(1):'home';
function activeView() {
  const key=routeKey();
  return viewState[key]||(viewState[key]={tab:routes[key].tabs[0][0],page:0});
}
function render({focus=false}={}) {
  const restoreFocus=Boolean(app.contains?.(document.activeElement));
  if(editor.open)editorNeedsFocus=true;
  const current=routeKey(),route=routes[current],today=todayKey(),view=activeView();
  const futureAllowed=['calendar','diary'].includes(current),dateVisible=!['settings','garden'].includes(current);
  if(!futureAllowed&&selectedDate>today)selectedDate=today;
  document.title=`${route.label} · マイペース`;
  const nav=keys=>keys.map(key=>`<a href="#${key}" ${current===key?'aria-current="page"':''}>${icon(routes[key].icon,20)}<span>${routes[key].label}</span><i></i></a>`).join('');
  app.innerHTML=`<aside id="app-sidebar" class="sidebar" aria-label="メインメニュー"><div class="sidebar-tools"><button type="button" class="icon-button" data-sidebar="close" aria-label="メニューを閉じる">${icon('close',20)}</button></div><a href="#home" class="brand" aria-label="マイペース ホーム"><img src="./favicon.svg" width="38" height="38" alt=""><span>マイペース<small>My Pace</small></span></a><p class="sidebar-caption">日々を、整える。</p><nav class="navigation" aria-label="メインナビゲーション">${nav(['home','running','wake','habits'])}<span class="nav-divider">日々の余白</span>${nav(['calendar','diary','garden'])}<span class="nav-divider line-only"></span>${nav(['settings'])}</nav><div class="sidebar-bottom"><span>${icon('lock',13)} このブラウザーに保存</span><p>続けることを、心地よく。</p></div></aside><button type="button" id="sidebar-backdrop" class="sidebar-backdrop" data-sidebar="close" tabindex="-1" aria-hidden="true" hidden></button>
  <div class="workspace"><header class="topbar"><button type="button" id="sidebar-toggle" class="icon-button sidebar-toggle" data-sidebar="toggle" aria-controls="app-sidebar" aria-expanded="true" aria-label="メニューを閉じる">${icon('menu',22)}</button><a href="#home" class="mobile-brand"><img src="./favicon.svg" width="28" height="28" alt="">マイペース</a><span class="desktop-breadcrumb">My Pace <b>/</b> ${route.label}</span><span class="local-indicator"><i></i> ブラウザー保存</span></header><main id="main" tabindex="-1"><div class="page-heading"><div><p class="page-overline">${current==='home'?'A LITTLE, EVERY DAY':'YOUR OWN PACE'}</p><h1>${route.title}</h1><p>${route.subtitle}</p></div>${dateVisible?`<div class="date-picker"><button class="icon-button" data-action="previous-day" aria-label="前の日" ${selectedDate==='1900-01-01'?'disabled':''}>${icon('left',17)}</button><label><span>${selectedDate===today?'今日':dayLabel(selectedDate,true)}</span><input id="selected-date" type="date" value="${selectedDate}" min="1900-01-01" max="${futureAllowed?'2200-12-31':today}" aria-label="表示する日付"></label><button class="icon-button" data-action="next-day" aria-label="次の日" ${selectedDate>=(futureAllowed?'2200-12-31':today)?'disabled':''}>${icon('right',17)}</button></div>`:''}</div>
  <div class="view-bar"><nav class="view-tabs" aria-label="${route.label}の表示">${route.tabs.map(([key,label])=>`<button type="button" data-action="view-tab" data-tab="${key}" aria-pressed="${view.tab===key}">${label}</button>`).join('')}</nav>${dateVisible&&selectedDate!==today?'<button class="text-link return-today" data-action="today">今日に戻る</button>':''}</div>
  ${storageBlocked?`<div class="error-banner" role="alert">保存データを読み込めません。記録の変更を止めています。<button class="text-link" data-action="backup-raw">既存データを退避</button><a href="#settings">設定で復元</a></div>`:''}
  <div class="view-stage" role="region" aria-label="${route.label}の内容" tabindex="0">${route.render({state,date:selectedDate,today,period,tab:view.tab,page:view.page,pageSize:current==='habits'?Math.max(1,Math.min(3,Math.floor(((window.innerHeight||768)-390)/110))):pageSize,month:calendarMonth})}</div><footer class="app-footer"><span>マイペース</span><span>日々の小さなことを、大切に。</span></footer></main></div>`;
  sidebar.sync();
  if((focus||restoreFocus)&&!editor.open)document.querySelector('main')?.focus();
}
function toast(text,undo=false)  {
  notice.innerHTML=`<span>${e(text)}</span>${undo?'<button class="toast-undo" data-action="undo">元に戻す</button>':''}<button class="toast-close" data-action="notice-close" aria-label="通知を閉じる">${icon('close',16)}</button>`;
  notice.hidden=false;
}
function commit(candidate,message, {
  allowBlocked=false,undo=true
}
= {
}
)  {
  if(storageBlocked&&!allowBlocked) {
    toast('保存できないため、変更していません。設定を確認してください。');
    return false;
  }
  try  {
    const next=validateState(candidate), result=saveState(next);
    if(!result.ok) {
      toast(`保存できませんでした。変更は反映していません。${result.error||''}`);
      return false;
    }
    undoState=undo?structuredClone(state):null;
    state=next;
    storageBlocked=false;
    render();
    toast(message,undo);
    return true;
  }
  catch(error) {
    formError(error.message);
    return false;
  }
}
function showDialog(markup,context = {}) {
  ++fileSequence;
  if(editor.open)editor.close();
  dialogContext=context;
  editorNeedsFocus=false;
  editor.innerHTML=markup;
  editor.showModal();
  requestAnimationFrame(()=>editor.querySelector('[autofocus],input:not([type=hidden]),button')?.focus());
}
function closeDialog() {
  ++fileSequence;
  editor.close();
  dialogContext=null;
  if(editorNeedsFocus){editorNeedsFocus=false;document.querySelector('main')?.focus();}
}
function formError(text) {
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
      handle(text,file);
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
function openHabitLog(id) {
  const h=getHabit(id);
  if(!h||h.archived)return;
  const value=state.habitLogs[id]?.[selectedDate];
  if(h.type==='check') {
    commit(upsertHabitLog(state,id,selectedDate,value!==true),value===true?'チェックを外しました':'できた、を記録しました');
  }
  else showDialog(habitLogDialog(h,value,selectedDate), {
    type:'habit-log',id,date:selectedDate
  }
  );
}
const actions= {
  'view-tab':el=>{const view=activeView();if(!routes[routeKey()].tabs.some(([key])=>key===el.dataset.tab))return;view.tab=el.dataset.tab;view.page=0;render({focus:true});},
  'view-page':el=>{const page=Number(el.dataset.page);if(!Number.isInteger(page)||page<0)return;activeView().page=page;render({focus:true});},
  'calendar-month':el=>{const offset=Number(el.dataset.offset);if(![-1,1].includes(offset))return;const [year,month]=calendarMonth.split('-').map(Number);const value=new Date(year,month-1+offset,1,12);const key=`${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}`;if(key<'1900-01'||key>'2200-12')return;calendarMonth=key;activeView().page=0;render({focus:true});},
  'calendar-today':()=>{selectedDate=todayKey();calendarMonth=selectedDate.slice(0,7);activeView().page=0;render({focus:true});},
  'calendar-day':el=>{if(!isDateKey(el.dataset.date))return;selectedDate=el.dataset.date;calendarMonth=selectedDate.slice(0,7);activeView().page=0;render({focus:true});},
  'diary-day':el=>{if(!isDateKey(el.dataset.date))return;selectedDate=el.dataset.date;calendarMonth=selectedDate.slice(0,7);viewState.diary={tab:'entry',page:0};if(routeKey()!=='diary')location.hash='#diary';render({focus:true});},
  'event-add':()=>showDialog(eventDialog(null,selectedDate),{type:'event'}),
  'event-edit':el=>{const event=state.events.find(item=>item.id===el.dataset.id);if(event)showDialog(eventDialog(event,selectedDate),{type:'event',id:event.id});},
  'event-delete':()=>{if(dialogContext?.type!=='event'||!dialogContext.id)return;showDialog(confirmDialog('予定を削除','この予定とメモを削除します。直後に元に戻せます。','削除する','event-delete-confirm'),{type:'event-delete',id:dialogContext.id});},
  'event-delete-confirm':()=>{if(dialogContext?.type==='event-delete'&&dialogContext.id&&commit(removeEvent(state,dialogContext.id),'予定を削除しました'))closeDialog();},
  'diary-edit':()=>showDialog(diaryDialog(state.diary[selectedDate],selectedDate),{type:'diary',date:selectedDate}),
  'diary-delete':()=>{if(dialogContext?.type!=='diary'||!state.diary[dialogContext.date])return;showDialog(confirmDialog('日記を削除','この日の日記を削除します。直後に元に戻せます。','削除する','diary-delete-confirm'),{type:'diary-delete',date:dialogContext.date});},
  'diary-delete-confirm':()=>{if(dialogContext?.type==='diary-delete'&&dialogContext.date&&commit(removeDiary(state,dialogContext.date),'日記を削除しました'))closeDialog();},
  'garden-plant':el=>{const plant=el.dataset.plant;if(!gardenProgress(state,todayKey()).unlockedPlants.includes(plant))return;if(state.garden.plant===plant)return;commit({...state,garden:{...state.garden,plant}},'庭の植物を変えました');},
  'garden-theme':el=>{const theme=el.dataset.theme;if(!GARDEN_THEMES.some(item=>item.id===theme)||state.garden.theme===theme)return;commit({...state,garden:{...state.garden,theme}},'庭の空を変えました');},
  'dialog-close':closeDialog,'notice-close':()=>notice.hidden=true,   'previous-day':()=> {
    if(selectedDate>'1900-01-01') {
      selectedDate=addDays(selectedDate,-1);
      calendarMonth=selectedDate.slice(0,7);activeView().page=0;
      render();
    }
  }
  ,   'next-day':()=> {
    if(selectedDate<(['calendar','diary'].includes(routeKey())?'2200-12-31':todayKey())) {
      selectedDate=addDays(selectedDate,1);
      calendarMonth=selectedDate.slice(0,7);activeView().page=0;
      render();
    }
  }
  ,   today:()=> {
    selectedDate=todayKey();
    calendarMonth=selectedDate.slice(0,7);activeView().page=0;
    render();
  }
  ,   'select-date':el=> {
    if(!isDateKey(el.dataset.date)||el.dataset.date>todayKey())return;
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
  ,   'wake-now':()=> {
    if(selectedDate!==todayKey())return;
    const now=new Date();
    const time=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    commit(upsertWake(state,selectedDate,time),'おはよう。起きた時間を記録しました');
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
  ,   'wake-delete':()=> {
    const next=structuredClone(state);
    delete next.wake[dialogContext.date];
    if(commit(next,'起床の記録を削除しました'))closeDialog();
  }
  ,   'target-edit':()=>showDialog(targetDialog(state.settings.wakeTarget), {
    type:'target'
  }
  ),   'run-add':()=>showDialog(runDialog(null,selectedDate,todayKey()), {
    type:'run',points:[]
  }
  ),   'run-edit':el=> {
    const run=state.runs.find(r=>r.id===el.dataset.id);
    if(run)showDialog(runDialog(run,selectedDate,todayKey()), {
      type:'run',id:run.id,points:run.points||[]
    }
    );
  }
  ,   'run-delete':()=> {
    const id=dialogContext.id;
    showDialog(confirmDialog('ランの記録を削除','この記録を削除します。直後に「元に戻す」で取り消せます。','削除する','run-delete-confirm'), {
      id
    }
    );
  }
  ,   'run-delete-confirm':()=> {
    if(commit( {
      ...state,runs:state.runs.filter(r=>r.id!==dialogContext.id)
    }
    ,'ランの記録を削除しました'))closeDialog();
  }
  ,   'gpx-import':()=>chooseFile('.gpx,application/gpx+xml,application/xml,text/xml',(text)=> {
    const parsed=parseGpx(text);
    const run= {
      ...parsed,date:parsed.date&&parsed.date<=todayKey()?parsed.date:selectedDate,note:''
    }
    ;
    showDialog(runDialog(run,selectedDate,todayKey(),parsed.warnings), {
      type:'run',points:parsed.points
    }
    );
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
  ,   'habit-log':el=>openHabitLog(el.dataset.id),   'habit-log-delete':()=> {
    const next=structuredClone(state);
    delete next.habitLogs[dialogContext.id][dialogContext.date];
    if(commit(next,'習慣の記録を削除しました'))closeDialog();
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
      pending
    }
    );
  }
  ),   'backup-restore-confirm':()=> {
    if(commit(dialogContext.pending,'バックアップを復元しました', {
      allowBlocked:true,undo:!storageBlocked
    }
    ))closeDialog();
  }
  ,   undo:()=> {
    if(!undoState)return;
    const previous=undoState;
    if(commit(previous,'ひとつ前の状態に戻しました', {
      undo:false
    }
    ))closeDialog();
  }
  ,
};
async function onClick(event) {
  const button=event.target.closest('[data-action]');
  if(!button||button.disabled)return;
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
    if(isDateKey(value)&&value<=(['calendar','diary'].includes(routeKey())?'2200-12-31':todayKey())) {
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
editor.addEventListener('submit',event=> {
  const form=event.target.closest('form');
  if(!form)return;
  event.preventDefault();
  if(!form.reportValidity())return;
  const data=new FormData(form);
  const type=form.dataset.form;
  if(!dialogContext||!editor.open)return;
  if(dialogContext.type!==type)return;
  let next;
  try  {
    if(type==='wake'){if(dialogContext.date>todayKey())throw new Error('今日以前の日付を選んでください。');next=upsertWake(state,dialogContext.date,data.get('time'));}
    else if(type==='target')next= {
      ...state,settings: {
        ...state.settings,wakeTarget:data.get('target')||null
      }
    }
    ;
    else if(type==='run') {
      const id=data.get('id')||makeId();
      const durationSec=Number(data.get('minutes'))*60+Number(data.get('seconds'));
      if(durationSec<=0||durationSec>31*24*3600)throw new Error('走行時間は 1 秒以上、31 日以内で入力してください。');
      const run= {
        id,date:data.get('date'),distanceKm:Number(data.get('distance')),durationSec,note:data.get('note').trim(),points:dialogContext.points||[]
      }
      ;
      if(run.date>todayKey())throw new Error('今日以前の日付を選んでください。');
      next= {
        ...state,runs:[...state.runs.filter(r=>r.id!==id),run]
      }
      ;
    }
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
    if(next&&commit(next,'記録を保存しました'))closeDialog();
  }
  catch(error) {
    formError(error.message);
  }
}
);
editor.addEventListener('close',()=> {
  if(!editor.open)dialogContext=null;
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
  if(event.key!==STORAGE_KEY&&event.key!==null)return;
  const latest=loadState();
  closeDialog();
  undoState=null;
  if(latest.ok) {
    state=latest.state;
    storageBlocked=false;
    render();
    toast('別のタブの最新の記録を読み込みました。');
  }
  else {
    storageBlocked=true;
    render();
    toast('保存データを読み込めません。変更を停止しました。');
  }
}
);
document.addEventListener('visibilitychange',()=> {
  if(document.hidden)return;
  const current=todayKey();
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
  if(capacity!==pageSize){pageSize=capacity;render();}
});
render();
