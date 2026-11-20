import { sourceOverride, runningSource, readAccount, loginErrorMessage } from './lib/account.js';
import { createDriveRunningSource, driveRequest } from './lib/running-drive.js';
import { validateSyncStatus, syncPresentation, syncTime } from './lib/running-sync.js';
import { createStore, localDate } from './lib/state.js';
import { createDiaryController } from './lib/diary-view.js';
import { mountMap } from './lib/map.js';
import { explorationByRun } from './lib/exploration.js';
import { runSlotModel, mountRunSlotInput } from './lib/run-slots.js';
import { indexRunDays, monthSummary, shiftMonth, shiftDay, dayInMonth, initialRunningMonth } from './lib/running-calendar.js';
import { runningPanel, runningSelectionCard, runningMapHeading, runningWeather } from './lib/running-view.js';
import { createThemeController, THEME_NAMES } from './lib/theme.js';
import { getWeather, weatherLabel, upcomingHours } from './lib/weather.js';
import { weatherGlyph, weatherTone } from './lib/weather-view.js';
import { icon, esc, $, shortDate } from './lib/ui.js';
import { pageForHash, categoryNavigation, placeholderPage } from './lib/navigation.js';
import { createRunningMotion } from './lib/running-motion.js';
import { mountEnglish } from './lib/english-view.js';

const workspaceStore=createStore();
let workspaceState=workspaceStore.get();
let runs=[],selectedRunId=null,logExpanded=false,splitPage=0;
let runsLoaded=false,runDays=new Map(),runningMonth=localDate().slice(0,7),selectedDay=null;
let runsTask=null,runsError='';
const diagnosticSource = sourceOverride(location.search);
let account = { phase:'checking', configured:null, authenticated:null, error:'' }, accountTask=null, accountVersion=0;
let activeSource=diagnosticSource==='local'?'local':'checking', usingDrive=false, runsVersion=0;
const authError=loginErrorMessage(new URLSearchParams(location.search).get('authError'));
let loggingOut=false;
const accountChannel=typeof BroadcastChannel==='function'?new BroadcastChannel('mypace-account'):null;
let driveSource = null, driveRoutes = [], driveViewKey = '', driveLoadedKey = '', driveVersion = 0, driveViewError = '', maskErrorShown = false;
let syncStatus=null,syncError='',syncTask=null,syncCheckedAt=0,syncVersion=0,displayedHash='',recordsRefreshTask=null,recordsRefreshError='';
const runningMotion=createRunningMotion();
let routeMotionState={},panelMarkup=null,selectionMarkup=null;
let englishView=null;

let lastSelectedDay=localDate(),calendarEnd=localDate().slice(0,7),calendarMonths=6;
let area={mode:'demo',areaName:'東京駅周辺（公開サンプル）',center:{lat:35.7,lon:139.8}};
let explorationStats=new Map();
let mapView=null,weather=null,weatherBusy=false,weatherError='',selectedWeatherHour=0;
let toastTimer,areaTask=null,weatherTask=null,weatherController=null,weatherVersion=0;
const dialog=$('#dialog');
const diary=createDiaryController({dialog,openDialog,getState:()=>workspaceState,updateState:saveWorkspace,status:()=>workspaceStore.status()});
const isMobile=()=>matchMedia('(max-width:760px)').matches;
const runningSlotCount=()=>!isMobile()?(innerHeight>880?7:innerHeight<=520?3:5):5;
const currentOrigin=()=>area.center;
// Keep old bookmarks useful after retiring the planner.
function normalizeLocation(){if(location.hash==='#explore')history.replaceState(null,'','#records');}
normalizeLocation();
let activePage=pageForHash(location.hash);
const isRunning=()=>activePage.id==='records';
function selectedRunningRuns(){return selectedDay?(runDays.get(selectedDay)?.runs||[]):monthSummary(runDays,runningMonth).days.flatMap(day=>day.runs);}
function explorationHelp(){openDialog('探索マップ',`<div class="stack"><div class="source-box"><strong>走った道から、地図が開きます</strong>取り込まれたランの記録から、走った道と、その道で囲まれた内側を明るくします。別の日の経路がつながって囲んだ場所も含まれます。日付や月を変えても残ります。</div><p class="form-hint">薄い陰影の場所は、まだこのアプリの記録で開いていない範囲です。実際の訪問歴とは限りません。山や池なども、走った道で囲めば内側が開きます。道の周囲は最大約60mまで柔らかく明るくし、囲みの判定では小さなGPSのずれを吸収します。欠測や250mを超える点の間に直線を補うことはありません。</p><p class="form-hint">「新しく走った道」は、その日より前の記録から約30m以上離れた区間の走行距離を、GPSから推定した値です。月表示では、その月の各日の推定距離を合計します。同じ日の往復や繰り返しも含むため、道路そのものの延長とは異なります。囲んで開いた面積や道路そのものの踏破率ではなく、実際の経路を比較した値で、GPSのずれも含みます。同じ日を何度見ても、同じ道を繰り返しても、地図の範囲は水増ししません。</p><p class="form-hint">探索表示は常に有効です。${usingDrive?'探索範囲と新しく走った距離は、Google側で作成済みの表示用データを使います。':'探索範囲の計算は端末内で行います。'}</p></div>`);}
function toast(message){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3500);}
function checkStorage(){const errors=[workspaceStore.status().error].filter(Boolean);$('#save-warning').hidden=!errors.length;$('#save-warning').textContent=errors.join(' ');}
function saveWorkspace(mutator){workspaceState=workspaceStore.update(mutator);checkStorage();}
function savedNotice(message){toast(workspaceStore.status().available?message:'変更はこの画面内のみです。設定から書き出せます。');}
async function api(path,body){const options=body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};const response=await fetch(path,options);let data;try{data=await response.json();}catch{throw new Error('ローカルサーバーを再起動して、もう一度お試しください。');}if(!response.ok){const error=new Error(data.error?.message||'データを取得できませんでした。');error.code=data.error?.code;error.retryAfterSeconds=data.error?.retryAfterSeconds;throw error;}return data;}
function renderHeader(){
  const name=workspaceState.profile.name||'';
  const label=account.authenticated===true?'ログイン済み':account.phase==='checking'?'接続を確認中':'アカウント';
  $('#header').innerHTML=`<a class="brand" href="#home" aria-label="my pace ホーム" ${activePage.id==='home'?'aria-current="page"':''}><img src="/assets/mark.svg?v=3" alt=""><span class="brand-word">my pace<span class="brand-dot">.</span></span></a><nav class="top-nav" aria-label="取り組み">${categoryNavigation(activePage.id)}</nav><div class="header-right"><button class="profile-button account-trigger ${account.authenticated===true?'is-signed-in':''}" data-action="account" aria-label="アカウント" aria-haspopup="dialog" title="${label}"><span class="avatar">${account.authenticated===true&&name?esc(name.slice(0,1).toUpperCase()):icon('user')}</span>${name?`<span class="account-name">${esc(name)}</span>`:''}</button></div>`;
  $('#records-heading').innerHTML=`${icon('calendar')}記録`;$('.diary-trigger').innerHTML=`${icon('note')}<span>今日の日記</span>`;
}

function historyPanel(){return runningPanel(runningContext());}
function historyCard(){return runningSelectionCard(runningContext());}
function replacePanel(markup){
  // Weather updates its own section. They must not replace the rest of the
  // dashboard during a route response, or discard its in-flight animations.
  const signature=markup.replace(/(<section id="running-weather"[^>]*>)[\s\S]*?(<\/section>)/,'$1$2');
  if(signature===panelMarkup)return;
  runningMotion.stop('panel');$('#context').innerHTML=markup;panelMarkup=signature;
}
function animateRunningPanel(){runningMotion.rendered({ready:isRunning()&&runsLoaded&&!runsError&&['local','drive'].includes(activeSource),month:runningMonth,calendar:`${calendarEnd}/${calendarMonths}`});}
function renderPanel(){
  if(!isRunning())return;
  $('#workspace').className=`workspace with-sidebar history ${logExpanded?'log-expanded':''}`;
  if(activeSource==='checking'){replacePanel('<div class="loading"><span class="spinner"></span>アカウントを確認しています</div>');return;}
  if(activeSource==='unavailable'){replacePanel(`<div class="empty">${icon('cloud')}<h2>接続を確認できませんでした</h2><p>${esc(account.error)}</p><button class="button" data-action="account-retry">もう一度確認</button></div>`);return;}
  if(activeSource==='guest'){replacePanel(`<div class="empty account-welcome">${icon('run')}<h2>自分の記録を、ここに。</h2><p>${authError?esc(authError):'Googleでログインすると、走った記録を表示できます。'}</p><button class="button" data-action="account">アカウントを開く</button><small>日記と設定は、このブラウザーに保存されます。</small></div>`);return;}
  if(runsError){replacePanel(`<div class="empty">${icon('note')}<h2>記録を読み込めませんでした</h2><p>${esc(runsError)}</p><button class="button" data-action="retry-runs">読み込み直す</button></div>`);return;}
  if(!runsLoaded){replacePanel('<div class="loading"><span class="spinner"></span>記録を読み込んでいます</div>');return;}
  replacePanel(historyPanel());
}
function renderMapTop(){ $('#map-top').className='map-top history-map-top'; $('#map-top').innerHTML=runningMapHeading(runningContext())+(driveViewError?`<button class="drive-view-retry" data-action="retry-drive-view">${esc(driveViewError)} · 再読込</button>`:''); }
function renderMapBottom(){const markup=historyCard();if(markup===selectionMarkup)return;runningMotion.stop('selection');$('#map-bottom').innerHTML=markup;selectionMarkup=markup;}
function mapOptions(){
  const padding={top:Math.ceil($('#map-top').getBoundingClientRect().height)+45,right:isMobile()?55:65,bottom:Math.ceil($('#map-bottom').getBoundingClientRect().height)+34,left:isMobile()?22:35};
  const exploration={exploredRuns:usingDrive?[]:runs,explorationEnabled:true,maskTiles:driveSource?.maskTiles,onMaskError:()=>{if(!maskErrorShown){maskErrorShown=true;toast('探索範囲を読み込めませんでした。アカウントから読み込み直せます。');void refreshAccount();}}};
    const overlay=$('#map-bottom');
    if(isMobile()&&logExpanded){
      const stage=$('.map-stage').getBoundingClientRect(),card=overlay.querySelector('.running-selection'),analysis=overlay.querySelector('.running-analysis');
      if(card&&analysis){
        const height=card.getBoundingClientRect().height;
        const summaryHeight=height-analysis.getBoundingClientRect().height-parseFloat(getComputedStyle(analysis).marginTop);
        // Keep the summary where it was; unfold the analysis below it.
        // Only lift the card if the expanded content would leave the screen.
        overlay.style.top=`${Math.min(stage.height-summaryHeight-19,innerHeight-stage.top-height-12)}px`;
      }
    }else overlay.style.removeProperty('top');
    const stage=$('.map-stage').getBoundingClientRect(),top=$('#map-top').getBoundingClientRect(),bottom=$('#map-bottom').getBoundingClientRect();
    padding.top=Math.ceil(top.bottom-stage.top)+(isMobile()?10:18);
    padding.bottom=Math.max(24,Math.ceil(stage.bottom-bottom.top)+(isMobile()?10:22));
    const shown=usingDrive?driveRoutes:selectedRunningRuns();
    const routeKey=`${runningMonth}/${selectedDay||'month'}`;
    const routeReady=isRunning()&&runsLoaded&&!runsError&&['local','drive'].includes(activeSource)&&(!usingDrive||driveLoadedKey.split('|')[0]===routeKey);
    return {...exploration,fitPadding:padding,runs:shown,selectedRunId:selectedDay&&shown.length===1?shown[0].id:null,selectedRunIds:selectedDay?shown.map(r=>r.id):[],speedRoutes:true,overview:!selectedDay,routeMotionKey:routeReady?routeKey:null,routeMotionEnabled:routeReady,routeMotionState,viewportKey:`records:${runningMonth}:${selectedDay||'month'}:${usingDrive?driveLoadedKey:''}`};
  }

function render(){
  const running=isRunning();
  document.documentElement.dataset.page=activePage.id;
  document.title=`my pace — ${activePage.label}`;
  renderHeader();checkStorage();renderSyncStatus();
  $('.sidebar').hidden=!running;$('.map-stage').hidden=!running;
  const page=$('#category-page');page.hidden=running;
  $('.skip-link').href=running?'#context':'#category-page';
  if(!running){
    runningMotion.reset();routeMotionState={};
    mapView?.destroy();mapView=null;
    $('#workspace').className='workspace category-workspace';
    if(activePage.id==='english'){
      // Account/weather refreshes must not reset a selected room or a handoff.
      englishView ||= mountEnglish(page);
    }else{
      englishView?.destroy();englishView=null;
      page.innerHTML=placeholderPage(activePage);
    }
    return;
  }
  englishView?.destroy();englishView=null;
  renderPanel();
  if(activeSource==='checking'||activeSource==='unavailable')return;
  if(!runsLoaded){if(!runsError)void loadRuns();return;}
  renderMapTop();renderMapBottom();
  if(usingDrive)void loadDriveView();
  if(mapView)mapView.update(mapOptions());else mapView=mountMap($('#map'),mapOptions());
  void loadWeather();
  animateRunningPanel();
}

window.addEventListener('hashchange',()=>{
  normalizeLocation();const page=pageForHash(location.hash);
  if(page.id===activePage.id)return;
  if(dialog.open)closeDialog();
  activePage=page;render();
  (isRunning()?$('#context'):$('#category-page')).focus({preventScroll:true});
});


function openDialog(title,content,wide=false){delete dialog.dataset.view;dialog.className=wide?'dialog-wide':'';dialog.innerHTML=`<div class="dialog-header"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close" aria-label="閉じる">${icon('close')}</button></div><div class="dialog-content">${content}</div>`;if(!dialog.open)dialog.showModal();}
function closeDialog(){dialog.close();}
function settingsDialog(){
  openDialog('マイスペース',`<div class="stack"><form class="form" id="profile-form"><label class="field">呼び名<input name="name" value="${esc(workspaceState.profile.name)}" maxlength="100" required></label><div class="form-actions"><button class="button secondary" type="submit">名前を保存</button></div></form>${themeSettings()}<section class="settings-section"><div class="settings-line"><span>天気のエリア</span><button class="text-button" data-action="weather-area">変更 ${icon('arrow')}</button></div><div class="settings-line"><span>ローカルデータ</span><button class="text-button" data-action="export">${icon('download')}書き出す</button></div><p class="form-hint">日記と、以前の予定・習慣・ノートを含めて書き出します。</p><button class="text-button" data-action="sources">データと外部サービスについて ${icon('arrow')}</button></section>${connectionDiagnostics()}<button class="text-button" data-action="account">${icon('left')} アカウントに戻る</button></div>`);
}
function weatherAreaDialog(){
  openDialog('天気のエリア',`<div class="stack"><div class="source-box"><strong>現在：${esc(area.areaName)}</strong>現在・今後の予報に使うエリアです。選択しているランの日付とは連動しません。</div><p class="form-hint">記録の周辺を選ぶと、最新の記録の位置を緯度・経度0.1度単位に丸めて、Open-Meteoに送ります。現在地のGPS取得は行いません。</p><div class="form-actions"><button class="button secondary" data-action="weather-area-demo">東京駅周辺</button><button class="button" data-action="weather-area-recorded">記録の周辺</button></div></div>`);
}
async function setWeatherArea(recorded){
  const buttons=[...dialog.querySelectorAll('[data-action^="weather-area-"]')];
  buttons.forEach(button=>button.disabled=true);
  try{
    let value;
    if(usingDrive&&recorded){
      const latest=runs.at(-1);
      if(!latest)throw Error('位置のある記録がまだありません。');
      const result=await driveSource.view({day:latest.date,month:latest.date.slice(0,7)});
      const point=result.routes.flatMap(r=>r.segments).find(s=>s.points.length)?.points[0];
      if(!point)throw Error('この記録には位置情報がありません。');
      value={mode:'recorded',areaName:'記録の周辺',center:{lat:Math.round(point[0]*10)/10,lon:Math.round(point[1]*10)/10}};
    }else value=await api('/api/weather-area',{useRecordedLocation:recorded});
    weatherVersion++;weatherController?.abort();weatherTask=null;weatherBusy=false;weather=null;weatherError='';
    area=value;areaTask=Promise.resolve();closeDialog();renderWeather();loadWeather();
  }catch(error){buttons.forEach(button=>button.disabled=false);toast(error.message);}
}
function sourcesDialog(){
  openDialog('データと出典',`<div class="stack"><div class="source-box"><strong>走った記録：Google Driveの実データ</strong>${usingDrive?'本人のGoogleログインで、Driveに作成済みの表示用データを読み込んでいます。CSV本文の取得・変換や、Driveへの書き込みは行いません。':'取得済みCSVから距離とペースを計算したローカル記録です。Googleへの自動書き込みは行いません。'}</div><p class="form-hint">地図は選んだ日の経路を速度に応じた色で表示し、「月全体」ではその月の経路をまとめます。カレンダーの濃さは1日の合計距離、空白は取得済みの記録がない日です。日付は日本時間・午前3時区切り。停止時間を含み、GPSの欠測はつなぎません。</p><div class="source-box"><strong>背景地図と天気</strong>背景地図はOpenStreetMap、天気はOpen-Meteoです。地図には表示範囲のタイルを取得し、天気には0.1度単位に丸めた位置を使います。無料の公開サービスのため、通信できない場合があります。</div><div class="source-links"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a><a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a></div><p class="form-hint">日記・呼び名・配色はこのブラウザーに保存します。</p></div>`);
}
function download(contents,type,name){const url=URL.createObjectURL(new Blob([contents],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function ensureArea(){
  if(activeSource!=='local')return Promise.resolve();
  if(!areaTask)areaTask=api('/api/weather-area').then(value=>{area=value;}).catch(error=>{areaTask=null;throw error;});
  return areaTask;
}
function renderWeather(){
  const panel=$('#running-weather');
  if(panel)panel.innerHTML=runningWeather({weather,weatherBusy,weatherError,area});
}
function loadWeather(){
  if(weatherTask)return weatherTask;
  if(weather&&Date.now()-Date.parse(weather.fetchedAt)<20*60000)return Promise.resolve();
  const version=++weatherVersion;
  weatherBusy=true;weatherError='';renderWeather();
  weatherTask=(async()=>{
    try{
      await ensureArea();if(version!==weatherVersion)return;
      renderWeather();weatherController=new AbortController();
      const origin=currentOrigin();
      const result=await getWeather({latitude:origin.lat,longitude:origin.lon,signal:weatherController.signal});
      if(version===weatherVersion){weather=result;weatherError='';}
    }catch(error){if(version===weatherVersion){weather=null;weatherError=error.message;}}
    finally{if(version===weatherVersion){weatherBusy=false;weatherTask=null;weatherController=null;renderWeather();}}
  })();
  return weatherTask;
}
async function weatherDialog(){if(!weather||Date.now()-Date.parse(weather.fetchedAt)>=20*60000){openDialog('出かける時間',`<div class="loading"><span class="spinner"></span>予報を取得しています</div>`);await loadWeather();if(!dialog.open)return;}if(!weather){openDialog('出かける時間',`<div class="stack"><p class="form-hint">${esc(weatherError||'予報を取得しています。少し待ってから開いてください。')}</p><button class="button secondary" data-action="weather">もう一度取得</button></div>`);return;}renderWeatherDialog();}
function forecastHours(){return upcomingHours(weather);}
function renderWeatherDialog(){const hours=forecastHours();selectedWeatherHour=Math.max(0,Math.min(selectedWeatherHour,hours.length-1));const h=hours[selectedWeatherHour]||weather.current,sunset=weather.sunset?.slice(11,16)||'—',sameSolarDay=weather.sunrise?.slice(0,10)===h.time.slice(0,10)&&weather.sunset?.slice(0,10)===h.time.slice(0,10),beforeSunset=sameSolarDay&&h.time>=weather.sunrise&&h.time<weather.sunset;openDialog('出かける時間',`<div class="weather-focus" data-weather="${weatherTone(h,weather)}"><div><h3>${shortDate(h.time.slice(0,10))} ${h.time.slice(11,16)} · ${weatherLabel(h.code)}</h3><p>気温 ${Math.round(h.temperature)}° · 風 ${h.wind} m/s<br>降水確率 ${h.rainProbability??'—'}% · ${sameSolarDay?(beforeSunset?'日の入り前':'夜間または日の出前'):'翌日の予報'}</p></div>${weatherGlyph(h,weather)}</div><div class="weather-hour-list">${hours.map((hour,i)=>`<button class="weather-hour ${i===selectedWeatherHour?'active':''}" data-weather="${weatherTone(hour,weather)}" data-weather-hour="${i}" aria-pressed="${i===selectedWeatherHour}"><small>${shortDate(hour.time.slice(0,10))} ${hour.time.slice(11,16)}</small>${weatherGlyph(hour,weather)}<strong>${Math.round(hour.temperature)}°</strong><span class="rain">雨 ${hour.rainProbability??'—'}%</span></button>`).join('')}</div><p class="form-hint">${shortDate(weather.sunset?.slice(0,10)||localDate())} の日の入り ${sunset} · ${esc(area.areaName)}付近の概略位置<br>2時間ごとの予報。時刻を選んで比較できます。</p><p class="form-hint" style="margin-top:13px"><a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Weather data by Open-Meteo</a> · ${new Date(weather.fetchedAt).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo'})} 取得</p>`,true);}

document.addEventListener('click',event=>{
  const b=event.target.closest('button,a');if(!b||b.disabled)return;const d=b.dataset;
  if(b.matches('.skip-link')){event.preventDefault();(isRunning()?$('#context'):$('#category-page')).focus({preventScroll:true});return;}
  if(d.slotDate){selectSlotDate(d.slotDate);return;}
  if(d.slotStep){const model=runSlotModel(runningContext()),date=model[Number(d.slotStep)<0?'previous':'next'];if(date)selectSlotDate(date,Number(d.slotStep));return;}
  if(d.calendarDay){selectRunningDay(d.calendarDay,true);return;}
  if(d.runningMonth){selectRunningMonth(d.runningMonth);return;}
  if(d.mapMonth){setRunningMode('month',false);selectRunningMonth(d.mapMonth);return;}
  if(d.runningMode){setRunningMode(d.runningMode);return;}
  if(d.calendarMonths){calendarMonths=Number(d.calendarMonths)===12?12:6;renderPanel();animateRunningPanel();return;}
  if(d.calendarStep){const next=shiftMonth(calendarEnd,Number(d.calendarStep)*calendarMonths);calendarEnd=next>localDate().slice(0,7)?localDate().slice(0,7):next;renderPanel();animateRunningPanel();return;}
  if(d.runningStep){stepRunningDay(Number(d.runningStep));return;}
  if(d.themeMode){const saved=themeController.set(d.themeMode);const section=$('#theme-settings');if(section)section.outerHTML=themeSettings();if(!saved)toast('配色はこの画面内だけで変更しています');return;}
  if(d.splitStep){splitPage=Math.max(0,splitPage+Number(d.splitStep));refreshRunningLog(`[data-split-step="${d.splitStep}"]`);return;}
  if(d.weatherHour!==undefined){selectedWeatherHour=Number(d.weatherHour);renderWeatherDialog();return;}
  switch(d.action){
    case'account':case'connection':accountDialog();break;
    case'account-retry':refreshAccount();break;
    case'drive-refresh':closeDialog();if(usingDrive&&runsLoaded)void refreshDriveRecords();else{resetRunningData();render();}break;
    case'running-sync':syncDialog();break;
    case'sync-retry':void refreshSyncStatus(true).then(()=>{if(usingDrive&&runsLoaded)return refreshDriveRecords(syncStatus?.catalogHash||'');}).then(()=>{if(dialog.open&&dialog.dataset.view==='sync')syncDialog();});break;
    case'drive-logout':logoutDrive();break;
    case'retry-drive-view':driveViewKey='';driveViewError='';render();break;
    case'exploration-help':explorationHelp();break;
    case'diary':diary.open();break;
    case'close':closeDialog();break;
    case'running-month-map':setRunningMode('month');break;
    case'speed-help':speedHelp();break;
    case'running-latest':{const date=[...runDays.keys()].at(-1);if(date)selectRunningDay(date);break;}
    case'calendar-help':calendarHelp();break;
    case'settings':settingsDialog();break;
    case'weather-area':weatherAreaDialog();break;
    case'weather-area-demo':setWeatherArea(false);break;
    case'weather-area-recorded':setWeatherArea(true);break;
    case'sources':sourcesDialog();break;
    case'weather':weatherDialog();break;
    case'retry-weather':loadWeather();break;
    case'retry-runs':resetRunningData();render();break;
    case'export':download(JSON.stringify({version:2,workspace:workspaceStore.get()},null,2),'application/json',`my-pace-${localDate()}.json`);toast('ローカルデータを書き出しました');break;
  }
});
document.addEventListener('change',event=>{if(event.target.id==='analysis-run'&&runDays.get(selectedDay)?.runs.some(run=>run.id===event.target.value)){selectedRunId=event.target.value;splitPage=0;refreshRunningLog('#analysis-run');}});
document.addEventListener('submit',event=>{
  const form=event.target;if(form.id!=='profile-form')return;event.preventDefault();
  try{saveWorkspace(s=>s.profile.name=String(new FormData(form).get('name')).trim());closeDialog();renderHeader();savedNotice('名前を保存しました');}
  catch{toast('入力内容を確認してください。変更は保存されていません。');}
});
dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeDialog();}});
window.addEventListener('focus',()=>{void refreshAccount();if(isRunning()&&runsLoaded)loadWeather();});
window.addEventListener('online',()=>void refreshAccount());
window.addEventListener('pageshow',event=>{if(event.persisted)void refreshAccount();});
window.addEventListener('pagehide',()=>{if(usingDrive){accountVersion++;accountTask=null;account={...account,phase:'checking',authenticated:null};applyAccount();}});
if(accountChannel)accountChannel.onmessage=event=>{if(event.data==='logout'){accountVersion++;accountTask=null;account={phase:'ready',configured:account.configured,authenticated:false,error:''};applyAccount();}else if(event.data==='login')void refreshAccount();};
let lastMobile=isMobile(),lastSlotCount=runningSlotCount(),lastSplitPageSize=runningContext().splitPageSize,resizeTimer;
window.addEventListener('resize',()=>{
  clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{
    const mobile=isMobile(),slotCount=runningSlotCount(),splitPageSize=runningContext().splitPageSize;
    if(mobile!==lastMobile||slotCount!==lastSlotCount||splitPageSize!==lastSplitPageSize){lastMobile=mobile;lastSlotCount=slotCount;lastSplitPageSize=splitPageSize;splitPage=0;render();}
    mapView?.update(mapOptions());mapView?.fit();
  },150);
});
const mapCardObserver=new ResizeObserver(()=>{if(mapView){mapView.update(mapOptions());mapView.fit();}});mapCardObserver.observe($('#map-bottom'));
window.addEventListener('beforeunload',()=>{mapCardObserver.disconnect();mapView?.destroy();runningMotion.destroy();themeController.destroy();clearTimeout(resizeTimer);weatherController?.abort();});

function runningContext(){return {days:runDays,month:runningMonth,selectedDay,lastSelectedDay,explorationStats,mobile:isMobile(),slotCount:runningSlotCount(),calendarEnd,calendarMonths,logExpanded,splitPage,splitPageSize:!isMobile()&&innerHeight<=620?3:5,selectedRunId,name:workspaceState.profile.name||'',latestRun:runs.at(-1),weather,weatherBusy,weatherError,area};}
function revealCalendarMonth(month){if(month>calendarEnd||month<shiftMonth(calendarEnd,1-calendarMonths))calendarEnd=month;}
function selectSlotDate(date){
  selectRunningDay(date);const reel=$('.run-slot-reel');reel?.focus({preventScroll:true});
}
mountRunSlotInput($('#context'),{getContext:runningContext,select:selectSlotDate});
function selectRunningDay(date,restoreFocus=false){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>localDate())return;
  selectedDay=date;lastSelectedDay=date;runningMonth=date.slice(0,7);revealCalendarMonth(runningMonth);selectedRunId=runDays.get(date)?.runs.at(-1)?.id||null;logExpanded=false;splitPage=0;render();
  if(restoreFocus)document.querySelector(`[data-calendar-day="${date}"]`)?.focus({preventScroll:true});
}
function selectRunningMonth(month){
  try{shiftMonth(month,0);}catch{return;}if(month>localDate().slice(0,7))return;
  const daily=!!selectedDay;runningMonth=month;revealCalendarMonth(month);
  if(daily){selectedDay=dayInMonth(selectedDay,month);lastSelectedDay=selectedDay;}
  selectedRunId=selectedDay?runDays.get(selectedDay)?.runs.at(-1)?.id||null:null;logExpanded=false;splitPage=0;render();
}
function setRunningMode(mode,redraw=true){
  if(!['day','month'].includes(mode))return;
  if(mode==='month'){if(selectedDay)lastSelectedDay=selectedDay;selectedDay=null;selectedRunId=null;}
  else{selectedDay=lastSelectedDay.startsWith(runningMonth)?dayInMonth(lastSelectedDay,runningMonth):runSlotModel(runningContext()).anchor;lastSelectedDay=selectedDay;selectedRunId=runDays.get(selectedDay)?.runs.at(-1)?.id||null;}
  logExpanded=false;splitPage=0;if(redraw)render();
}
function stepRunningDay(direction){
  if(![-1,1].includes(direction))return;
  if(!selectedDay){selectRunningMonth(shiftMonth(runningMonth,direction));return;}
  const date=shiftDay(selectedDay,direction);if(date<=localDate())selectRunningDay(date);
}
function speedHelp(){openDialog('経路の色と重なり',`<div class="stack"><p class="form-hint">GPSから推定した区間ごとの速度です。青 → 青緑 → 緑 → 黄 → 赤茶へ、速度に応じて色相が変わります。日別・月全体で同じ基準を使います。</p><p class="form-hint">6〜14 km/hの固定スケールで、6 km/h以下は青、14 km/h以上は赤茶です。取得済みの記録は0.5 km/h刻みの速度色を保持しています。色の境目は前後の区間から滑らかに補間しています。GPSの誤差や停止付近の揺れを含む推定値で、補間によって精度が上がるものではありません。速度が不明な区間は灰色で表示します。</p><p class="form-hint">経路は不透明度68%で重ねています。同じ道を走った記録が重なるほど色が深まります。GPS点ごとのつなぎ目で濃い斑点が出ないよう、1回のランをまとめて半透明にしています。異なる速度の記録が重なると色は混ざるため、1回ごとの速度色は日別で確認してください。</p></div>`);}
function refreshRunningLog(focusSelector){
  if(usingDrive)void loadDriveView();
  $('#workspace').classList.toggle('log-expanded',logExpanded);
  renderMapBottom();mapView?.update(mapOptions());mapView?.fit();
  if(focusSelector)$(focusSelector)?.focus({preventScroll:true});
}
$('#map-bottom').addEventListener('toggle',event=>{
  const disclosure=event.target;
  if(disclosure.id!=='running-log-disclosure'||!disclosure.isConnected)return;
  disclosure.querySelector('summary').setAttribute('aria-expanded',String(disclosure.open));
  if(logExpanded===disclosure.open)return;
  logExpanded=disclosure.open;
  // Native <details> changed the DOM without going through renderMapBottom.
  selectionMarkup=null;
  if(usingDrive)void loadDriveView();
  $('#workspace').classList.toggle('log-expanded',logExpanded);
  // Native details performs the open/close. Map work cannot prevent closing.
  mapView?.update(mapOptions());mapView?.fit();
},true);

function calendarHelp(){openDialog('カレンダーの見方',`<div class="stack"><p class="form-hint">標準では6か月分を表示し、1年表示にも切り替えられます。四角ひとつが1日です。同じ日の記録が複数ある場合は、距離を合計します。月をまたいでも同じ色の基準で比較できます。</p><div class="calendar-help-scale">${['取得済みの記録なし','0 kmを超え、2 km未満','2 km以上、4 km未満','4 km以上、6 km未満','6 km以上'].map((label,i)=>`<span><i class="level-${i}"></i>${label}</span>`).join('')}</div><p class="form-hint">カレンダーの色は距離、地図上の色は速度を示します。目標の達成・未達を示すものではありません。空白の日に走らなかったと断定するものでもありません。</p><p class="form-hint">四角を選ぶとその日の経路、月名を選ぶとその月全体の経路を表示します。地図上の日別・月全体の切替と前後ボタンは、記録のない日や月でも使えます。キーボードでは上下で1日、左右で1週間移動し、Enterで選べます。</p></div>`);}
function themeSettings(state=themeController.get()){
  const palettes={morning:['#FAF3E8','#F7D1C7','#D9EBEC','#CB5640','#3A5C88','#F0C57F'],day:['#F7F0E8','#F0D2D4','#F0E9F0','#BA514B','#3F4173','#ECBF53'],night:['#16283F','#203850','#ECD2CE','#D26F4A','#E9EEE7','#EFC477']};
  return `<section class="theme-settings" id="theme-settings"><div class="between"><h3>配色</h3><span class="form-hint">${state.mode==='auto'?'自動 · ':''}${THEME_NAMES[state.active]}</span></div><div class="theme-options">${['auto','morning','day','night'].map(mode=>`<button class="theme-option ${state.mode===mode?'active':''}" data-theme-mode="${mode}" aria-pressed="${state.mode===mode}">${mode==='auto'?`<span class="theme-auto-icon">${icon('clock')}</span>`:`<span class="theme-swatches" aria-hidden="true">${palettes[mode].map(color=>`<i style="background:${color}"></i>`).join('')}</span>`}${mode==='auto'?'自動':THEME_NAMES[mode]}</button>`).join('')}</div><p class="form-hint">自動では日本時間の朝5–11時、昼11–18時、晩18–翌5時に切り替わります。各配色を選ぶと、その配色で固定できます。</p></section>`;
}
const themeController=createThemeController({onChange:state=>{mapView?.update(mapOptions());const section=$('#theme-settings');if(section)section.outerHTML=themeSettings(state);}});
document.addEventListener('keydown',event=>{
  const cell=event.target.closest?.('[data-calendar-day]');if(!cell)return;
  const deltas={ArrowUp:-1,ArrowDown:1,ArrowLeft:-7,ArrowRight:7};if(!(event.key in deltas)&&!['Home','End'].includes(event.key))return;
  event.preventDefault();const cells=[...document.querySelectorAll('[data-calendar-day]:not(:disabled)')];
  const index=cells.indexOf(cell),next=event.key==='Home'?cells[0]:event.key==='End'?cells.at(-1):cells[index+deltas[event.key]];
  if(next){cell.tabIndex=-1;next.tabIndex=0;next.focus({preventScroll:true});}
});
function inspectCalendar(event){const cell=event.target.closest?.('[data-calendar-day]'),hint=$('#calendar-inspection');if(cell&&hint)hint.textContent=cell.title;}
document.addEventListener('pointerover',inspectCalendar);document.addEventListener('focusin',inspectCalendar);

function resetRunningData(){
  runningMotion.reset();routeMotionState={};panelMarkup=null;selectionMarkup=null;
  syncVersion++;syncStatus=null;syncError='';syncTask=null;syncCheckedAt=0;displayedHash='';recordsRefreshTask=null;recordsRefreshError='';
  runsVersion++;driveVersion++;runsTask=null;runsLoaded=false;runsError='';
  driveSource?.clear();driveSource=null;driveRoutes=[];driveViewKey='';driveLoadedKey='';driveViewError='';maskErrorShown=false;
  runs=[];runDays=new Map();explorationStats=new Map();selectedDay=null;selectedRunId=null;logExpanded=false;splitPage=0;
  mapView?.destroy();mapView=null;$('#map-top').innerHTML='';$('#map-bottom').innerHTML='';
}
function applyAccount(){
  const next=runningSource(diagnosticSource,account);
  if(next!==activeSource){
    activeSource=next;usingDrive=next==='drive';resetRunningData();
    weatherVersion++;weatherController?.abort();weatherTask=null;weatherBusy=false;weather=null;weatherError='';areaTask=null;
    area={mode:'demo',areaName:'東京駅周辺（公開サンプル）',center:{lat:35.7,lon:139.8}};
  }
  render();
  void refreshSyncStatus();
  if(dialog.open&&dialog.dataset.view==='account')accountDialog();
}
function refreshAccount(){
  if(accountTask||loggingOut)return accountTask;
  const version=++accountVersion,previous=account;
  accountTask=readAccount(previous).then(next=>{
    if(version!==accountVersion)return;
    account=next;applyAccount();
    if(next.authenticated===true&&previous.authenticated!==true)accountChannel?.postMessage('login');
  }).finally(()=>{if(version===accountVersion)accountTask=null;});
  return accountTask;
}
function requireLogin(message){
  accountVersion++;accountTask=null;account={phase:'ready',configured:true,authenticated:false,error:''};
  // Also reset when the loss is detected by a route request, not the session check.
  resetRunningData();applyAccount();toast(message||'もう一度Googleでログインしてください。');
}
function loadRuns(){
  if(runsTask||runsLoaded||['checking','unavailable'].includes(activeSource))return runsTask;
  if(activeSource==='guest'){runsLoaded=true;render();return;}
  const version=++runsVersion,source=activeSource;
  runsTask=(async()=>{
    try{
      let data;
      if(source==='drive'){
        const reader=createDriveRunningSource();driveSource=reader;
        data=await reader.load();
      }else{
        const response=await fetch('/data/running.json');
        if(!response.ok)throw new Error('ランニング記録を読み込めませんでした。');
        data={runs:(await response.json()).days};
      }
      if(version!==runsVersion)return;
      runDays=indexRunDays(data.runs);runs=[...runDays.values()].flatMap(day=>day.runs);
      explorationStats=source==='drive'?data.explorationStats:explorationByRun(runs);
      selectedDay=[...runDays.keys()].at(-1)||null;
      runningMonth=initialRunningMonth(runDays);lastSelectedDay=selectedDay||localDate();calendarEnd=runningMonth;
      selectedRunId=runDays.get(selectedDay)?.runs.at(-1)?.id||null;runsLoaded=true;
    }catch(error){
      if(version!==runsVersion)return;
      if(error.code==='SIGN_IN'){requireLogin(error.message);return;}
      runsError=error.message;
    }finally{if(version===runsVersion){runsTask=null;render();if(usingDrive)void refreshSyncStatus();}}
  })();
  return runsTask;
}

render();
void refreshAccount();

async function loadDriveView() {
  if(!driveSource||!runsLoaded)return;
  const key=JSON.stringify([selectedDay,runningMonth,logExpanded,selectedRunId]);
  if(driveViewKey===key)return;
  driveViewKey=key;driveViewError='';const version=++driveVersion;
  const previousSelection=driveLoadedKey.split('|')[0], selection=`${runningMonth}/${selectedDay||'month'}`;
  if(previousSelection!==selection)driveRoutes=[];
  try{
    const value=await driveSource.view({day:selectedDay,month:runningMonth,analysis:logExpanded,runId:selectedRunId});
    if(version!==driveVersion)return;
    if(value.detail){const run=runs.find(r=>r.id===value.detail.id);if(run)Object.assign(run,value.detail);}
    driveRoutes=value.routes;driveLoadedKey=selection+'|'+key;render();
  }catch(error){
    if(version!==driveVersion)return;
    if(error.code==='SIGN_IN')requireLogin(error.message);
    else{driveViewError=error.message;renderMapTop();toast(error.message);}
  }
}
function connectionDiagnostics(){
  return `<details class="connection-diagnostics"><summary>接続の確認（検証用）</summary><p class="form-hint">表示方式を一時的に固定できます。Driveの内容は変更しません。</p><div class="diagnostic-links"><a href="/#records" ${!diagnosticSource?'aria-current="true"':''}>通常表示（自動）</a><a href="/?source=local#records" ${diagnosticSource==='local'?'aria-current="true"':''}>ローカル</a><a href="/?source=drive#records" ${diagnosticSource==='drive'?'aria-current="true"':''}>Driveプレビュー</a></div></details>`;
}
function accountDialog(){
  const signedIn=account.authenticated===true,name=workspaceState.profile.name;
  const message=account.phase==='error'?account.error:account.phase==='checking'?'接続を確認しています。':account.configured===false?'Google接続の初回設定がまだ完了していません。':signedIn?(diagnosticSource==='local'?'検証用のローカル表示です。設定から通常表示へ戻せます。':'走った記録をGoogle Driveから読み込みます。'):'記録を保存したGoogleアカウントでログインしてください。';
  openDialog('アカウント',`<div class="stack account-menu"><div class="account-identity"><span class="account-symbol">${icon('user')}</span><div><strong>${signedIn?esc(name||'マイアカウント'):'MyPaceへようこそ'}</strong><span>${signedIn?'Googleに接続済み':'自分の記録と、いつもの設定'}</span></div></div><p class="form-hint" role="status">${esc(message)}</p>${authError&&!signedIn?`<p class="account-error">${esc(authError)}</p>`:''}${!signedIn&&account.configured===true?'<a class="button google-login" href="/api/google-auth?start=1">Googleでログイン</a>':''}${account.phase==='error'||account.configured===false?'<button class="button secondary" data-action="account-retry">接続を確認する</button>':''}<div class="account-actions"><button data-action="settings">${icon('settings')}<span>設定</span>${icon('chevron')}</button>${signedIn?`<button data-action="drive-refresh">${icon('route')}<span>ランニング記録を更新</span>${icon('chevron')}</button><button data-action="drive-logout" ${loggingOut?'disabled':''}>${icon('logout')}<span>${loggingOut?'ログアウトしています…':'ログアウト'}</span></button>`:''}</div><p class="account-storage-note">${icon('note')}<span>日記・設定はこのブラウザーに保存<br><small>Driveへの同期は、今後対応します。</small></span></p></div>`);
  dialog.dataset.view='account';
}
async function logoutDrive(){
  if(loggingOut)return;loggingOut=true;accountDialog();
  try{
    await driveRequest('/api/google-auth',{action:'logout'});
    accountVersion++;accountTask=null;account={phase:'ready',configured:true,authenticated:false,error:''};
    resetRunningData();accountChannel?.postMessage('logout');
    activeSource='guest';usingDrive=false;closeDialog();render();
    // Replacing only an unchanged fragment does not reload the document.
    history.replaceState(null,'','/#records');location.reload();
  }catch(error){loggingOut=false;accountDialog();toast(error.message);}
}

function syncModel(){return syncPresentation(syncStatus,{error:syncError,refreshError:recordsRefreshError,refreshing:!!recordsRefreshTask});}
function renderSyncStatus(){
  const button=$('#running-sync');button.hidden=!usingDrive;
  if(!usingDrive)return;
  const view=syncModel();button.dataset.tone=view.tone;button.title=view.detail;
  button.innerHTML=`<span class="sync-dot" aria-hidden="true"></span><span role="status">${esc(view.label)}</span>`;
  if(dialog.open&&dialog.dataset.view==='sync'){
    // Update the content only; preserve focus on the close/retry controls.
    const body=dialog.querySelector('.sync-detail');if(body)body.innerHTML=syncDetails();
  }
}
function syncDetails(){
  const s=syncStatus,view=syncModel();
  return `<h3>${esc(view.label)}</h3><p>${esc(view.detail)}</p>${s?`<dl class="sync-facts"><dt>反映済みCSV</dt><dd>${s.importedSources} / ${s.sources} 件</dd><dt>未処理の追加・変更</dt><dd>${s.pendingSources} 件</dd><dt>最終通知</dt><dd>${esc(syncTime(s.updatedAt))}</dd><dt>継続取り込みの最終反映</dt><dd>${esc(syncTime(s.lastSuccessfulUpdate))}</dd>${s.nextRunAt?`<dt>自動再開予定</dt><dd>${esc(syncTime(s.nextRunAt))}（日本時間）</dd>`:''}<dt>直近の内部計上</dt><dd>${s.budget.usedMinutes.toFixed(1)} / ${s.budget.limitMinutes} 分</dd></dl><p class="form-hint">監視・取り込み・準備・状態通知を合算した、直近約24〜25時間の目安です。次の実行用に${s.budget.reserveMinutes}分を確保します。Googleが計上する使用量・回復時刻とは一致しない場合があります。CSV数とランの件数は異なることがあります。</p>`:''}<p class="form-hint">ここで示すのはランニングCSVの取り込みです。日記・設定のDrive同期はまだありません。</p>`;
}
function syncDialog(){
  openDialog('ランニングの取り込み',`<div class="stack"><div class="sync-detail">${syncDetails()}</div><button class="button secondary" data-action="sync-retry">状態と表示を再確認</button></div>`);
  dialog.dataset.view='sync';
}
function refreshSyncStatus(force=false){
  if(!usingDrive||document.hidden||syncTask||!force&&Date.now()-syncCheckedAt<55000)return syncTask||Promise.resolve();
  const version=syncVersion;syncCheckedAt=Date.now();
  syncTask=(async()=>{
    try{
      const value=validateSyncStatus(await driveRequest('/api/running-drive',{path:'sync-status.json'},(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(20000)})));
      if(version!==syncVersion)return;
      syncStatus=value;syncError='';
      if(value?.catalogHash&&runsLoaded&&value.catalogHash!==displayedHash)await refreshDriveRecords(value.catalogHash);
    }catch(error){
      if(version!==syncVersion)return;
      if(error.code==='SIGN_IN'){requireLogin(error.message);return;}
      syncError=error.message;
    }finally{if(version===syncVersion){syncTask=null;renderSyncStatus();}}
  })();return syncTask;
}
function refreshDriveRecords(hash=''){
  if(!usingDrive||!runsLoaded||recordsRefreshTask)return recordsRefreshTask||Promise.resolve();
  const version=runsVersion,selection=JSON.stringify([selectedDay,runningMonth,logExpanded,selectedRunId]);
  const reader=createDriveRunningSource();recordsRefreshError='';
  recordsRefreshTask=(async()=>{
    try{
      // Keep the current reader, history and map until the replacement is usable.
      const data=await reader.load();
      const view=await reader.view({day:selectedDay,month:runningMonth,analysis:logExpanded,runId:selectedRunId});
      if(version!==runsVersion||selection!==JSON.stringify([selectedDay,runningMonth,logExpanded,selectedRunId])){reader.clear();return;}
      if(view.detail){const run=data.runs.find(r=>r.id===view.detail.id);if(run)Object.assign(run,view.detail);}
      driveVersion++;driveSource?.clear();driveSource=reader;
      runDays=indexRunDays(data.runs);runs=[...runDays.values()].flatMap(day=>day.runs);explorationStats=data.explorationStats;
      driveRoutes=view.routes;driveViewKey=selection;driveLoadedKey=`${runningMonth}/${selectedDay||'month'}|${selection}`;
      driveViewError='';runsError='';maskErrorShown=false;displayedHash=hash;
      // Refresh the exploration tiles as well as the routes for the new generation.
      mapView?.destroy();mapView=null;render();
    }catch(error){
      reader.clear();if(version!==runsVersion)return;
      if(error.code==='SIGN_IN'){requireLogin(error.message);return;}
      recordsRefreshError=error.message;
    }finally{if(version===runsVersion){recordsRefreshTask=null;renderSyncStatus();}}
  })();renderSyncStatus();return recordsRefreshTask;
}
const syncTimer=setInterval(()=>{renderSyncStatus();void refreshSyncStatus();},60000);
window.addEventListener('focus',()=>{void refreshSyncStatus();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshSyncStatus();});
window.addEventListener('beforeunload',()=>clearInterval(syncTimer));
