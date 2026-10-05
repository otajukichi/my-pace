import  {
  createInitialState,todayKey,addDays,validateState,parseBackup,serializeBackup,makeId,upsertWake,upsertHabitLog
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
const app=document.querySelector('#app'), editor=document.querySelector('#editor'), notice=document.querySelector('#notice');
const loaded=loadState();
let state=loaded.state||createInitialState(), storageBlocked=!loaded.ok;
let selectedDate=todayKey(), previousToday=todayKey(), period=7, undoState=null, dialogContext=null, fileSequence=0;
const routes= {
  home: {
    label:'今日',title:'今日の記録',subtitle:'自分のペースで、少しずつ。',icon:'home',render:renderDashboard
  }
  ,wake: {
    label:'早起き',title:'朝の記録',subtitle:'一日の始まりを、心地よく。',icon:'sun',render:renderWake
  }
  ,running: {
    label:'ランニング',title:'ランニング',subtitle:'歩幅も、ペースも、自分らしく。',icon:'run',render:renderRunning
  }
  ,habits: {
    label:'習慣',title:'習慣',subtitle:'小さな積み重ねが、日常になる。',icon:'habits',render:renderHabits
  }
  ,settings: {
    label:'設定',title:'設定',subtitle:'大切な記録を、これからも。',icon:'settings',render:renderSettings
  }
};
const routeKey=()=>Object.hasOwn(routes,location.hash.slice(1))?location.hash.slice(1):'home';
function render()  {
  const current=routeKey(), route=routes[current], today=todayKey();
  document.title=`${route.label} · マイペース`;
  app.innerHTML=`<aside class="sidebar"><a href="#home" class="brand" aria-label="マイペース ホーム"><img src="./favicon.svg" width="42" height="42" alt=""><span>マイペース<small>My Pace</small></span></a><div class="sidebar-caption">日々を、整える。</div><nav class="navigation" aria-label="メインナビゲーション">${Object.entries(routes).map(([key,item])=>`<a href="#${key}" ${current===key?'aria-current="page"':''}>${icon(item.icon)}<span>${item.label}</span>${key!=='settings'?'<i></i>':''}</a>`).join('')}</nav><div class="sidebar-bottom"><div class="side-art" aria-hidden="true"><i></i><i></i><i></i><i></i></div><p>続けることを、<br>心地よいことに。</p><span>${icon('lock',13)} このブラウザーに保存</span></div></aside>
  <div class="workspace"><header class="topbar"><a href="#home" class="mobile-brand"><img src="./favicon.svg" width="30" height="30" alt="">マイペース</a><span class="desktop-breadcrumb">My Pace <b>/</b> ${route.label}</span><span class="local-indicator"><i></i> ブラウザー保存</span></header><main id="main" tabindex="-1"><div class="page-heading"><div><p class="page-overline">${current==='home'?'A LITTLE, EVERY DAY':'YOUR OWN PACE'}</p><h1>${route.title}</h1><p>${route.subtitle}</p></div>${current!=='settings'?`<div class="date-picker"><button class="icon-button" data-action="previous-day" aria-label="前の日" ${selectedDate==='1900-01-01'?'disabled':''}>${icon('left',18)}</button><label><span>${selectedDate===today?'今日':dayLabel(selectedDate,true)}</span><input id="selected-date" type="date" value="${selectedDate}" min="1900-01-01" max="${today}" aria-label="表示する日付"></label><button class="icon-button" data-action="next-day" aria-label="次の日" ${selectedDate>=today?'disabled':''}>${icon('right',18)}</button></div>`:''}</div>
  ${selectedDate!==today&&current!=='settings'?`<div class="date-notice">${dayLabel(selectedDate)}の記録を表示中 <button class="text-link" data-action="today">今日に戻る</button></div>`:''}
  ${storageBlocked?`<div class="error-banner" role="alert">保存データを読み込めないか、ブラウザー保存を利用できません。記録の変更を止めています。<button class="text-link" data-action="backup-raw">既存データを退避</button> 設定から正常な JSON を復元するか、ブラウザーの保存設定を確認してください。</div>`:''}
  ${route.render({state,date:selectedDate,today,period})}<footer class="app-footer"><span>マイペース</span> 自分のペースで、少しずつ。</footer></main></div>`;
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
  editor.innerHTML=markup;
  editor.showModal();
  requestAnimationFrame(()=>editor.querySelector('[autofocus],input:not([type=hidden]),button')?.focus());
}
function closeDialog() {
  ++fileSequence;
  editor.close();
  dialogContext=null;
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
  'dialog-close':closeDialog,'notice-close':()=>notice.hidden=true,   'previous-day':()=> {
    if(selectedDate>'1900-01-01') {
      selectedDate=addDays(selectedDate,-1);
      render();
    }
  }
  ,   'next-day':()=> {
    if(selectedDate<todayKey()) {
      selectedDate=addDays(selectedDate,1);
      render();
    }
  }
  ,   today:()=> {
    selectedDate=todayKey();
    render();
  }
  ,   'select-date':el=> {
    selectedDate=el.dataset.date;
    render();
  }
  ,   period:el=> {
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
    showDialog(confirmDialog('バックアップを復元',`${pending.habits.length}個の習慣と${count}件の記録で、現在の全データを置き換えます。必要なら先に現在の JSON を保存してください。${storageBlocked?'現在の保存データが読み取れないため、この復元は取り消せません。':'復元直後は「元に戻す」で取り消せます。'}`,'置き換えて復元','backup-restore-confirm'), {
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
    if(value&&value<=todayKey()&&value>='1900-01-01') {
      selectedDate=value;
      render();
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
  let next;
  try  {
    if(type==='wake')next=upsertWake(state,dialogContext.date,data.get('time'));
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
    if(selectedDate===previousToday)selectedDate=current;
    previousToday=current;
    closeDialog();
    render();
  }
}
);
render();
