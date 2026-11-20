import { ENGLISH_AREAS, ENGLISH_MODES, createEnglishStore, activeCatalog, progressFor, buildStartText } from './english-model.js';
import { mountEnglishSphere } from './english-sphere.js';
import { esc, icon } from './ui.js';

const formats = { phrases:'フレーズ', dialogue:'会話文', speech:'スピーチ', article:'長文', research:'研究発表' };
const number = value => String(value).padStart(2,'0');
const dateLabel = value => new Intl.DateTimeFormat('ja-JP',{month:'numeric',day:'numeric'}).format(new Date(value));

/** An independent activity. Neither running data nor its Google credentials enter here. */
export function mountEnglish(root) {
  const store = createEnglishStore();
  let state = store.get(), screen = 'conversation', areaIndex = 0, mode = 'scene';
  let pageSize=3, resizeFrame, sphere=null;
  let materialId = '', themePage = 0, historyPage = 0, query = '', destroyed = false;
  const abort = new AbortController(), signal = abort.signal;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const q = selector => root.querySelector(selector);
  const area = () => ENGLISH_AREAS[areaIndex];
  const catalog = () => activeCatalog(state);
  const progress = () => progressFor(state.records);
  const material = () => catalog().materials.find(item => item.id === materialId);
  const pool = () => catalog().materials.filter(item => screen === 'reading' ? item.kind === 'reading' : item.kind === 'conversation' && item.areaId === area().id);
  function chooseMaterial() {
    const items = pool();
    if (!items.some(item => item.id === materialId)) {
      // Start with a less-practised title; the user can always pick any other title.
      const counts = new Map();
      for (const record of state.records) counts.set(record.themeId,(counts.get(record.themeId)||0)+1);
      materialId = [...items].sort((a,b)=>(counts.get(a.id)||0)-(counts.get(b.id)||0))[0]?.id || '';
    }
    themePage = Math.max(0, Math.floor(items.findIndex(item=>item.id===materialId)/pageSize));
  }

  root.innerHTML = `<section class="en-app"><header class="en-toolbar"><h1 id="category-title">英会話<span>ENGLISH</span></h1><nav class="en-tabs" aria-label="英会話のページ">${[['conversation','chat','会話'],['reading','book','音読'],['history','calendar','足あと']].map(([id,symbol,label])=>`<button data-en-screen="${id}" aria-pressed="${id===screen}">${icon(symbol)}${label}</button>`).join('')}</nav><button class="en-connection" data-en-action="settings" aria-label="英会話の教材・保存設定">${icon('settings')}<span>教材・保存</span></button></header><div class="en-body"></div><footer class="en-footer"><span>${icon('note')}<span>記録はこの端末に保存</span></span><button data-en-action="settings">教材の設定 ${icon('chevron')}</button></footer></section><dialog class="en-dialog" aria-labelledby="en-dialog-title"></dialog><div class="en-notice" role="status" aria-live="polite"></div>`;
  const body = q('.en-body'), dialog = q('.en-dialog');
  let noticeTimer;
  function notice(text) { if(destroyed)return; q('.en-notice').textContent=text; q('.en-notice').classList.add('visible');clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>q('.en-notice')?.classList.remove('visible'),4500); }
  function animate(element, direction=1) {
    if (!element || motion.matches) return;
    element.getAnimations().forEach(animation=>animation.cancel());
    element.animate([{opacity:0,transform:`translateY(${direction*12}px)`},{opacity:1,transform:'translateY(0)'}],{duration:470,easing:'cubic-bezier(.2,.8,.2,1)'});
  }
  function enterSpace() {
    if(motion.matches)return;
    const book=q('.en-book');
    if(book)book.animate([
      {transform:`${getComputedStyle(book).transform} rotateY(-46deg) translateY(28px)`,opacity:0},
      {transform:getComputedStyle(book).transform,opacity:1},
    ],{duration:1100,easing:'cubic-bezier(.16,.8,.2,1)'});
  }
  function render() {
    if (destroyed) return;
    sphere?.destroy();sphere=null;
    pageSize=3;
    q('.en-app').dataset.screen=screen;
    root.querySelectorAll('[data-en-screen]').forEach(button=>button.setAttribute('aria-pressed',button.dataset.enScreen===screen));
    chooseMaterial();
    if (screen==='history') renderHistory();
    else if (screen==='reading') renderReading();
    else renderConversation();
    q('.en-footer > span > span').textContent=store.status().persistent?'記録はこの端末に保存':'この端末で保存できません';
    animate(body);
    enterSpace();
  }
  function renderConversation() {
    const p=progress();
    body.innerHTML=`<section class="en-gallery" aria-label="会話エリア"><div class="en-gallery-intro"><div><span class="en-eyebrow">A LITTLE CONVERSATION</span><h2>今日は、どこから話そう。</h2></div><button class="en-visit-count" data-en-screen="history"><strong>${p.distinctAreas}<span> / 8</span></strong><span>話したエリア ${icon('arrow')}</span></button></div><div class="en-sphere-stage"></div><nav class="en-area-dock" aria-label="8つの会話エリア">${ENGLISH_AREAS.map((item,index)=>`<button data-en-area="${index}" aria-pressed="${index===areaIndex}"><span>${number(index+1)}</span>${esc(item.short)}${p.perArea[item.id]?.sessions?'<i aria-label="練習済み"></i>':''}</button>`).join('')}</nav></section><aside class="en-practice" aria-label="テーマと会話のスタイル"></aside>`;
    renderPractice();
    sphere=mountEnglishSphere(q('.en-sphere-stage'),{areas:ENGLISH_AREAS,selected:areaIndex,visits:p.perArea,onSelect:selectArea});
  }
  function renderPractice() {
    const items=pool().filter(item=>`${item.title} ${item.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    themePage=Math.min(themePage,Math.max(0,Math.ceil(items.length/pageSize)-1));
    if(!items.some(item=>item.id===materialId))materialId=items[0]?.id||'';
    const current=items.find(item=>item.id===materialId), p=progress(), reading=screen==='reading';
    q('.en-practice').innerHTML=`<div class="en-practice-head"><span class="en-eyebrow">${reading?'READ ALOUD':`AREA ${number(areaIndex+1)}`}</span>${catalog().sample?'<span class="en-sample">テーマ例</span>':'<span class="en-sample">登録した教材</span>'}<h2>${reading?'声に出す時間':esc(area().label)}</h2><p>${reading?'短いフレーズも、まとまった文章も。':esc(area().description)}</p></div>${!reading?`<section class="en-mode-section"><div class="en-section-label">会話のスタイル<button data-en-action="modes" aria-label="会話スタイルの解放条件">?</button></div><div class="en-mode-options">${ENGLISH_MODES.map(item=>`<button data-en-mode="${item.id}" aria-label="${esc(item.label)}${p.unlockedModes.includes(item.id)?'':'・未解放、条件を見る'}" aria-pressed="${mode===item.id}" class="${p.unlockedModes.includes(item.id)?'':'is-locked'}">${p.unlockedModes.includes(item.id)?icon(item.id==='scene'?'chat':item.id==='topic'?'compass':'sun'):'<span class="en-lock" aria-hidden="true">◇</span>'}<span>${esc(item.label)}</span></button>`).join('')}</div><p class="en-mode-help">${esc(ENGLISH_MODES.find(item=>item.id===mode).description)}</p></section>`:'<div class="en-reading-note">すべての音読教材を、最初から選べます。</div>'}<section class="en-theme-section"><div class="en-section-label">${reading?'読むものを選ぶ':'話すきっかけ'}<span>${items.length} テーマ</span></div>${pool().length>6?'<input class="en-theme-search" type="search" placeholder="テーマを探す" aria-label="テーマを探す" value="'+esc(query)+'">':''}<div class="en-themes" role="group" aria-label="テーマを選ぶ">${items.slice(themePage*pageSize,themePage*pageSize+pageSize).map(item=>`<button class="en-theme ${item.id===materialId?'is-selected':''}" data-en-material="${esc(item.id)}" aria-pressed="${item.id===materialId}"><span class="en-theme-dot">${icon(reading?'book':'chat')}</span><span><strong>${esc(item.title)}</strong><small>${esc(item.description)}</small></span><span class="en-theme-time">${item.durationMinutes}<small>分</small></span></button>`).join('')||(query?'<p class="en-no-themes">一致するテーマがありません。検索語を変えてみてください。</p>':'<p class="en-no-themes">このエリアの教材はまだありません。<button data-en-action="settings">教材を登録する</button></p>')}</div>${items.length>pageSize?`<div class="en-theme-pager"><span>${themePage+1} / ${Math.ceil(items.length/pageSize)}</span><button data-en-action="themes-previous" aria-label="前のテーマ" ${themePage===0?'disabled':''}>${icon('left')}</button><button data-en-action="themes-next" aria-label="次のテーマ" ${themePage>=Math.ceil(items.length/pageSize)-1?'disabled':''}>${icon('chevron')}</button></div>`:''}</section><div class="en-launch"><button class="en-primary" data-en-action="prepare" ${current||state.pending?'':'disabled'}><span>${state.pending?'準備した練習に戻る':reading?'この文章を音読する':'このテーマで話す'}</span>${icon('arrow')}</button><p>会話・音読はChatGPTで。${!state.settings.folderId||catalog().sample?'最初に教材を設定します。':'開始文をコピーして、開きます。'}</p></div>`;
    // Fit the number of theme choices to the actual remaining height. The CTA
    // stays reachable on laptops; additional titles have explicit page buttons.
    const panel=q('.en-practice');
    if(innerWidth>760 && panel.scrollHeight>panel.clientHeight+1 && pageSize>1){
      pageSize--;themePage=Math.max(0,Math.floor(items.findIndex(item=>item.id===materialId)/pageSize));renderPractice();
    }
  }
  function selectArea(index) {
    if(!ENGLISH_AREAS[index])return;
    if(index===areaIndex){sphere?.focus(index);return;}
    areaIndex=index;query='';materialId='';pageSize=3;chooseMaterial();
    sphere?.focus(index);
    root.querySelectorAll('[data-en-area]').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.enArea)===index)));
    renderPractice();animate(q('.en-practice'));
  }
  function renderReading() {
    const p=progress();
    body.innerHTML=`<section class="en-library"><div class="en-gallery-intro"><div><span class="en-eyebrow">WORDS, OUT LOUD</span><h2>ひとつずつ、声にして。</h2></div><span class="en-library-count">${p.readingSessions} 回の音読</span></div><div class="en-book-scene" aria-hidden="true"><div class="en-book-shadow"></div><div class="en-book-stack en-book-back"></div><div class="en-book-stack en-book-middle"></div><div class="en-book"><span class="en-book-edition">MY PACE / READING ROOM</span><span class="en-book-title">One<br>word.<br><em>Then<br>another.</em></span><span class="en-book-wave">${'<i></i>'.repeat(13)}</span><span class="en-book-foot">A LITTLE EVERY DAY</span></div><span class="en-book-orbit en-book-orbit-one"></span><span class="en-book-orbit en-book-orbit-two"></span></div><div class="en-reading-formats">${Object.entries(formats).map(([key,label])=>`<span>${label}</span>`).join('')}</div></section><aside class="en-practice" aria-label="音読教材"></aside>`;
    renderPractice();
  }
  function renderHistory() {
    const p=progress(), all=[...state.records].sort((a,b)=>b.performedAt.localeCompare(a.performedAt));
    historyPage=Math.min(historyPage,Math.max(0,Math.ceil(all.length/5)-1));
    const records=all.slice(historyPage*5,historyPage*5+5);
    body.innerHTML=`<section class="en-history-map"><div class="en-gallery-intro"><div><span class="en-eyebrow">YOUR ENGLISH, SO FAR</span><h2>話したことが、残っていく。</h2></div><span class="en-sample">この端末の記録</span></div><div class="en-sphere-stage"></div><div class="en-history-totals"><div><strong>${p.conversationSessions}<small>回</small></strong><span>会話</span></div><div><strong>${p.readingSessions}<small>回</small></strong><span>音読</span></div><div><strong>${p.distinctDays}<small>日</small></strong><span>練習した日</span></div></div></section><aside class="en-history-list"><div class="en-section-label">最近の練習<span>${all.length} 件</span></div>${records.length?`<ol>${records.map(record=>{const item=catalog().materials.find(item=>item.id===record.themeId);return `<li><span class="en-record-icon">${icon(record.kind==='reading'?'book':'chat')}</span><div><strong>${esc(item?.title||'登録済みの教材')}</strong><span>${record.kind==='reading'?'音読':esc(ENGLISH_MODES.find(mode=>mode.id===record.modeId)?.label||'会話')} · ${dateLabel(record.performedAt)}</span></div>${icon('check')}</li>`;}).join('')}</ol>`:`<div class="en-history-empty">${icon('chat')}<h3>最初のひとことから。</h3><p>練習を終えたら、ここに記録できます。<br>会話の内容や音声は保存しません。</p><button data-en-screen="conversation">会話を選ぶ ${icon('arrow')}</button></div>`}${all.length>5?`<div class="en-theme-pager"><span>${historyPage+1} / ${Math.ceil(all.length/5)}</span><button data-en-action="history-previous" ${historyPage===0?'disabled':''} aria-label="前の記録">${icon('left')}</button><button data-en-action="history-next" ${historyPage>=Math.ceil(all.length/5)-1?'disabled':''} aria-label="次の記録">${icon('chevron')}</button></div>`:''}<button class="en-unlock-link" data-en-action="modes">${icon('compass')}使える会話スタイル <span>${p.unlockedModes.length} / 3</span></button><p class="en-local-note">この端末に保存した練習の記録です。<br>英語力の評価・採点はしません。</p></aside>`;
    sphere?.destroy();
    sphere=mountEnglishSphere(q('.en-sphere-stage'),{areas:ENGLISH_AREAS,selected:areaIndex,visits:p.perArea,history:true,onSelect:index=>{areaIndex=index;screen='conversation';query='';materialId='';render();}});
  }
  function open(title,html,kind) {
    const room=(kind==='setup'||kind==='handoff')&&!dialog.open?q('.en-world.is-selected')?.getBoundingClientRect():null;
    dialog.innerHTML=`<header class="en-dialog-head"><div><span class="en-eyebrow">MY PACE / ENGLISH</span><h2 id="en-dialog-title" tabindex="-1">${esc(title)}</h2></div><button data-en-action="close" aria-label="閉じる">${icon('close')}</button></header><div class="en-dialog-content">${html}<p class="en-dialog-error" role="alert"></p></div>`;
    if(!dialog.open)dialog.showModal();
    q('#en-dialog-title').focus({preventScroll:true});
    if(room&&!motion.matches){
      const box=dialog.getBoundingClientRect(),dx=room.x+room.width/2-box.x-box.width/2,dy=room.y+room.height/2-box.y-box.height/2;
      dialog.animate([{opacity:0,transform:`translate(${dx}px,${dy}px) scale(.35)`},{opacity:1,transform:'translate(0,0) scale(1)'}],{duration:620,easing:'cubic-bezier(.16,.8,.2,1)'});
    }else animate(dialog);
  }
  function settings() {
    open('教材と記録の設定',`<p class="en-dialog-intro">会話の中身はDriveに。ここには、選ぶためのタイトルと短い説明だけを登録します。</p><form class="en-settings-form"><label>英会話教材フォルダのURL または ID<input name="folder" value="${esc(state.settings.folderId)}" placeholder="https://drive.google.com/drive/folders/…" autocomplete="off"></label><button class="en-primary" type="submit">フォルダを保存 ${icon('check')}</button></form><section class="en-setting-block"><h3>教材の目次</h3><p>${catalog().sample?'現在はテーマ例を表示しています。実際の教材はまだ接続されていません。':`${catalog().materials.length}件の教材情報を登録済み。Drive上の本文を読めるかは、ChatGPT側で確認します。`}</p><label class="en-file-button">${icon('plus')}目次JSONを読み込む<input data-en-file="catalog" type="file" accept="application/json,.json"></label><small>教材の本文は取り込みません。目次とフォルダ設定は、この端末に保存します。</small></section><section class="en-setting-block"><h3>記録の保存</h3><p>いまはこのブラウザー内に保存します。Drive同期・ChatGPTからの自動記録は未接続です。</p><div class="en-backup-actions"><button data-en-action="export">${icon('download')}バックアップ</button><label class="en-file-button">読み戻す<input data-en-file="backup" type="file" accept="application/json,.json"></label></div><small>書き出すファイルには練習履歴と教材の識別名を含みます。DriveのIDや目次は含みません。自分の手元で保管してください。</small></section>`,'settings');
  }
  function showModes() {
    const p=progress();
    open('会話の幅を、少しずつ',`<p class="en-dialog-intro">話した経験に合わせて、会話のスタイルが増えます。英語力の判定ではありません。8つのエリアと音読は、最初から選べます。</p><div class="en-mode-details">${p.modes.map(item=>`<section class="${item.unlocked?'is-unlocked':''}"><div>${icon(item.unlocked?'check':'compass')}<h3>${esc(item.label)}</h3><span>${item.unlocked?'選べます':'これから'}</span></div><p>${esc(ENGLISH_MODES.find(mode=>mode.id===item.id).description)}</p>${item.unlocked?'':`<p class="en-requirements">会話 ${p.conversationSessions} / ${item.requirements.sessions}回 · テーマ ${p.distinctThemes} / ${item.requirements.themes}種類 · エリア ${p.distinctAreas} / ${item.requirements.areas}種類</p>`}</section>`).join('')}</div><small class="en-local-note">同じテーマの繰り返しだけでは、テーマやエリアの種類は増えません。以前のスタイルも、いつでも選べます。</small>`,'modes');
  }
  function prepare() {
    if(state.pending){resume();return;}
    if(catalog().sample||!state.settings.folderId){
      open('最初に、教材を用意しよう',`<div class="en-setup-art">${icon('book')}</div><p class="en-dialog-intro">いま表示しているのは${catalog().sample?'テーマ例':'教材の目次'}です。ChatGPTが読む教材をDriveに置き、そのフォルダと目次を登録すると、短い開始文を作れます。</p><p class="en-local-note">教材の本文や、これから起きる会話は画面に表示しません。</p><button class="en-primary" data-en-action="settings">教材を設定する ${icon('arrow')}</button>`,'setup');return;
    }
    store.start({materialId,mode:screen==='reading'?'reading':mode});
    state=store.get();renderPractice();resume();
  }
  function resume() {
    const session=state.pending;
    if(!session){notice('準備中の練習はありません。');return;}
    const item=catalog().materials.find(item=>item.id===session.materialId);
    let text;
    try {text=buildStartText({session,material:item,folderId:state.settings.folderId});} catch {
      open('準備した練習について',`<p class="en-dialog-intro">教材の目次やフォルダ設定が変わったため、開始文を作れません。設定を戻すか、この準備を取り消して選び直してください。</p><button class="en-primary" data-en-action="settings">教材の設定を確認する ${icon('arrow')}</button><button class="en-text-link" data-en-action="finish">すでに練習を終えたので記録する</button><button class="en-cancel" data-en-action="cancel-pending">この準備を取り消す</button>`,'recovery');return;
    }
    open(item?.title||'練習を始める',`<div class="en-handoff-steps"><span class="active">1 <strong>開始文をコピー</strong></span><i></i><span>2 <strong>ChatGPTで練習</strong></span><i></i><span>3 <strong>ここに記録</strong></span></div><p class="en-dialog-intro">ChatGPTに貼り付けて、まず教材を読めたか確認します。読めたら音声モードで話しかけてください。</p><details class="en-starter-details"><summary>開始文を確認する</summary><pre>${esc(text)}</pre></details><div class="en-handoff-actions"><button class="en-primary" data-en-action="copy">${icon('note')}開始文をコピー</button><a class="en-secondary" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">ChatGPTを開く ${icon('arrow')}</a></div><p class="en-integration-note">スマホの音声モードでDrive教材を読めるかは未検証です。読めない場合は練習を開始せず、接続を確認してください。</p><section class="en-finish"><div><h3>練習を終えたら</h3><p>完了したことだけ、この端末に残します。</p></div><button class="en-secondary" data-en-action="finish">練習を記録 ${icon('check')}</button></section><button class="en-cancel" data-en-action="cancel-pending">この準備を取り消す</button>`,'handoff');
  }
  function confirmFinish() {
    open('練習を記録する',`<div class="en-setup-art">${icon('check')}</div><p class="en-dialog-intro">ChatGPTで今回の練習を終えましたか？ 実際に練習した場合だけ、完了を記録してください。</p><button class="en-primary" data-en-action="complete">練習を終えたので記録する ${icon('check')}</button><button class="en-text-link" data-en-action="resume">まだ練習中です</button><p class="en-local-note">開始文をコピーしただけでは記録されません。</p>`,'finish');
  }
  function turnThemes(step){
    themePage+=step;
    const items=pool().filter(item=>`${item.title} ${item.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    materialId=items[themePage*pageSize]?.id||'';
    renderPractice();
  }
  async function click(event) {
    const button=event.target.closest('button,a');if(!button||!root.contains(button))return;
    try {
      if(button.dataset.enScreen){screen=button.dataset.enScreen;query='';themePage=0;render();return;}
      if(button.dataset.enArea!==undefined){selectArea(Number(button.dataset.enArea));return;}
      if(button.dataset.enHistoryArea!==undefined){areaIndex=Number(button.dataset.enHistoryArea);screen='conversation';query='';materialId='';render();return;}
      if(button.dataset.enMaterial){materialId=button.dataset.enMaterial;renderPractice();q(`[data-en-material="${materialId}"]`)?.focus({preventScroll:true});return;}
      if(button.dataset.enMode){if(!progress().unlockedModes.includes(button.dataset.enMode)){showModes();return;}mode=button.dataset.enMode;renderPractice();q(`[data-en-mode="${mode}"]`)?.focus({preventScroll:true});return;}
      switch(button.dataset.enAction){
        case 'settings':settings();break;
        case 'close':dialog.close();break;
        case 'modes':showModes();break;
        case 'prepare':prepare();break;
        case 'resume':resume();break;
        case 'finish':confirmFinish();break;
        case 'complete':{
          const before=progress().unlockedModes.length;
          store.complete(state.pending.sessionId);state=store.get();dialog.close();render();
          notice(progress().unlockedModes.length>before?'練習を記録しました。新しい会話スタイルが選べます。':'練習をこの端末に記録しました。');
          break;
        }
        case 'cancel-pending':store.cancel(state.pending.sessionId);state=store.get();dialog.close();render();notice('準備を取り消しました。練習の記録は増えていません。');break;
        case 'copy':{
          const session=state.pending,item=catalog().materials.find(item=>item.id===session.materialId);
          const text=buildStartText({session,material:item,folderId:state.settings.folderId});
          try {await navigator.clipboard.writeText(text);if(destroyed||!button.isConnected)return;button.innerHTML=`${icon('check')}コピーしました`;}catch{if(destroyed||!button.isConnected)return;const details=q('.en-starter-details');if(details)details.open=true;notice('開始文を開きました。テキストを選択してコピーしてください。');}
          break;
        }
        case 'themes-previous':turnThemes(-1);break;
        case 'themes-next':turnThemes(1);break;
        case 'history-previous':historyPage--;renderHistory();break;
        case 'history-next':historyPage++;renderHistory();break;
        case 'export':{
          const blob=new Blob([store.exportJSON()],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');
          link.href=url;link.download=`mypace-english-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);break;
        }
      }
    }catch(error){showError(error);}
  }
  function showError(error){if(destroyed)return;q('.en-footer > span > span').textContent=store.status().persistent?'記録はこの端末に保存':'保存できません・設定を確認してください';const target=dialog.open?q('.en-dialog-error'):null;if(target)target.textContent=error.message;else notice(error.message||'操作を完了できませんでした。');}
  root.addEventListener('click',event=>void click(event),{signal});
  root.addEventListener('submit',event=>{
    if(!event.target.matches('.en-settings-form'))return;
    event.preventDefault();try{store.configure({folderId:new FormData(event.target).get('folder')});state=store.get();render();settings();notice('教材フォルダの参照先を保存しました。');}catch(error){showError(error);}
  },{signal});
  root.addEventListener('change',async event=>{
    const input=event.target;if(!input.matches('[data-en-file]'))return;
    const file=input.files?.[0];if(!file)return;
    try{
      if(file.size>6_000_000)throw new Error('ファイルが大きすぎます。6MB以内のJSONを選んでください。');
      const text=await file.text();
      if(destroyed)return;
      // A backup merge is explicit and preserves/deduplicates existing local records.
      if(input.dataset.enFile==='catalog')store.setCatalog(text);else store.importJSON(text);
      state=store.get();materialId='';render();settings();notice(input.dataset.enFile==='catalog'?'教材の目次を登録しました。':'バックアップを読み戻しました。');
    }catch(error){if(destroyed)return;showError(error);input.value='';}
  },{signal});
  root.addEventListener('input',event=>{
    if(!event.target.matches('.en-theme-search'))return;
    query=event.target.value;themePage=0;pageSize=3;renderPractice();const input=q('.en-theme-search');input.focus({preventScroll:true});// Search inputs preserve the caret at the end after a filtered redraw.
  },{signal});
  root.addEventListener('pointerover',event=>{const button=event.target.closest('[data-en-area]');if(button)sphere?.hover(Number(button.dataset.enArea));},{signal});
  root.addEventListener('pointerout',event=>{if(event.target.closest('[data-en-area]'))sphere?.hover(null);},{signal});
  window.addEventListener('resize',()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{if(!destroyed&&screen!=='history'){pageSize=3;renderPractice();}});},{signal});
  window.addEventListener('storage',event=>{if(event.key==='mypace.english.v1')notice('別のタブで英会話データが変わりました。ページを開き直してください。');},{signal});
  render();
  return {destroy(){destroyed=true;sphere?.destroy();abort.abort();clearTimeout(noticeTimer);cancelAnimationFrame(resizeFrame);if(dialog.open)dialog.close();root.querySelectorAll('*').forEach(element=>element.getAnimations().forEach(animation=>animation.cancel()));root.innerHTML='';}};
}
