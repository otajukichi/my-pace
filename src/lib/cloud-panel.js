import {e,icon,sectionHead} from './ui.js';
const hasImportErrors=view=>Object.keys(view.importErrors||{}).length>0;
export function cloudStatus(view,mode,initializing=false){
 if(initializing)return '保存先を確認中';
 if(mode==='local')return 'このブラウザーのみ';
 if(view.conflicts.length)return `別の変更があります · 確認待ち ${view.conflicts.length}件`;
 if(!view.authenticated){
  if(view.errorPhase==='session'&&['OFFLINE','REQUEST_TIMEOUT','SERVER_UNAVAILABLE'].includes(view.error))return `この端末の記録 · 接続待ち${view.pending?` · 未送信 ${view.pending}件`:''}`;
  return `Google への再ログイン待ち${view.pending?` · 未送信 ${view.pending}件`:''}`;
 }
 if(view.pending){
  if(view.automaticPaused)return `端末に保存済み · 送信に必要な設定を確認 · 未送信 ${view.pending}件`;
  if(view.error)return `端末に保存済み · 少し待って再送します · 未送信 ${view.pending}件`;
  if(view.continuation||view.busy&&view.phase==='preparation')return `端末に保存済み · Drive への保存を準備中 · 未送信 ${view.pending}件`;
  return `端末に保存済み · 送信待ち ${view.pending}件`;
 }
 if(view.recordsConfirmed===true){
  if(view.error||!view.verified||view.confirmationKind==='receipt')return 'Google Drive に保存済み · 最新の記録は確認待ち';
  if(view.busy&&['snapshot','recovery'].includes(view.phase))return 'Google Drive に保存済み · 最新の記録を確認中';
  if(hasImportErrors(view))return 'Google Drive に保存済み · ランの確認待ち';
  return 'Google Drive に保存済み';
 }
 if(view.automaticPaused)return '記録の確認に必要な設定を確認してください';
 if(view.error)return 'Drive の記録をまだ確認できていません';
 if(view.busy||view.continuation)return 'Drive の記録を確認中';
 return 'Drive の保存状態は未確認';
}
export function importStatusText(status){
 if(!status)return 'まだ取得していません';
 const label=({idle:'待機中','budget-wait':'取込の実行枠の回復待ち',scanning:'フォルダーを確認中',importing:'CSV を処理中',retry:'再試行待ち',blocked:'設定の確認が必要',complete:'今回の確認は完了'})[status.status]||'状態を確認中';
 const progress=status.lastJob?.progress,parts=[label];
 if(progress&&Number.isSafeInteger(progress.rows))parts.push(`${progress.rows.toLocaleString('ja-JP')} 行を処理`);
 if(progress&&Number.isSafeInteger(progress.points))parts.push(`${progress.points.toLocaleString('ja-JP')} サンプル`);
 if(status.error)parts.push(`確認内容: ${status.error}`);
 if(status.retryAt>0&&Number.isFinite(new Date(status.retryAt).getTime()))parts.push(`${status.status==='budget-wait'?'再開の目安':'再試行予定'}: ${new Date(status.retryAt).toLocaleString('ja-JP')}`);
 return parts.join(' · ');
}
export function cloudErrorText(code){return ({CLOUD_STATE_UNDISPLAYABLE:'取得した記録の件数または形式を、この画面で扱えません。記録と未送信の変更は残しています。保存先を作り直さず、アプリや保存先を確認してから再同期してください',STORE_YIELD:'確認に時間がかかっています。少し待って自動で再確認します。「今すぐ同期」でも確認できます',WRITER_BUSY:'ほかの保存処理が終わるのを待っています。少し待って自動で再確認します',WRITER_RECOVERY_PENDING:'保存先の準備をしています。少し待って自動で再確認します。「今すぐ同期」でも確認できます',WRITER_RECOVERY_SETUP_REQUIRED:'保存先の設定を確認する必要があります。記録や保存先を作り直さず、導入手順を確認した後に「今すぐ同期」で再確認してください',OFFLINE:'接続を確認できません。つながると自動で再確認します',REQUEST_TIMEOUT:'応答に時間がかかっています。送信待ちの記録を残して、少し待って再確認します',AUTH_REQUIRED:'Google にログインし直してください',SESSION_CHANGED:'ログイン状態が変わりました。Google にログインし直してください',INDEXEDDB_BLOCKED_CLOSE_OTHER_TABS:'ほかのタブでこのアプリを開いている場合は、先に閉じてからこのページを再読み込みしてください。記録は消さないでください',INDEXEDDB_VERSION_CHANGED_RELOAD_REQUIRED:'このアプリが更新されました。このページを再読み込みしてください。未送信の記録は残っています',WRITER_FORMAT_FENCE_REQUIRED:'保存先の更新状態を確認する必要があります。未送信の記録はそのまま残っています。更新の完了後に「今すぐ同期」で確認してください',WRITER_FORMAT_FENCE_MISSING:'保存先の更新状態を確認する必要があります。記録や保存先は作り直さず、更新の完了を確認してください',SYNC_V2_MIGRATION_REQUIRED:'保存先の更新を完了する必要があります。記録はそのまま残っています。導入手順に沿って更新した後に「今すぐ同期」で確認してください',SYNC_DEPLOYMENT_MISMATCH:'保存先と画面の更新がまだそろっていません。記録を残したまま、更新の完了を確認してください'})[code]||'今は確認できません。記録を残したまま、少し待って再確認します';}
function recordCaution(view){
 if(!view.error)return '';
 const title=view.errorPhase==='snapshot'?'最新の記録の確認':['command','preparation'].includes(view.errorPhase)?'記録の送信':'保存先の確認';
 return `<div class="info-note sync-review" role="status">${e(title)}: ${e(cloudErrorText(view.error))}。${view.recordsConfirmed&&!view.pending&&!view.conflicts.length?'送信済みの記録は保存の確認ができています。':''}この端末の記録は保持しています。</div>`;
}
function importCaution(view){
 if(!hasImportErrors(view))return '';
 return `<div class="info-note sync-review" role="status">${Object.entries(view.importErrors).map(([phase,code])=>`${phase==='imports'?'取り込み済みのラン':'ランの取り込み状況'}: ${e(cloudErrorText(code))}。`).join(' ')}${view.importAutomaticPaused?'取り込みに必要な設定を確認してください。':'記録の保存と、ランの確認は別々に進めます。'}${view.importStatus?'以下は前回確認できた状況です。':''}</div>`;
}
export function renderCloudPanel(view,mode){
 return `<section class="card settings-panel cloud-panel">${sectionHead('いつもの記録を、どのブラウザーでも。','Google Drive · 自分だけの保存先')}<div class="storage-info"><span class="storage-icon">${icon('lock',27)}</span><div><strong>${e(cloudStatus(view,mode))}</strong><p>単一オーナーの Google アカウントでログイン</p></div><span class="status-pill">${mode==='cloud'?'クラウド':'ローカル'}</span></div><p>クラウドの変更はまずこの端末に保存され、接続が戻ると送信されます。未送信の記録がある間は、このサイトのブラウザーデータを消さないでください。</p>${recordCaution(view)}<div class="row-actions">${!view.authenticated?'<button class="btn primary" data-action="cloud-login">Google でログイン</button>':'<button class="btn secondary" data-action="cloud-sync">今すぐ同期</button><button class="btn secondary" data-action="cloud-logout">ログアウト</button>'}${view.ready&&mode!=='cloud'?'<button class="btn primary" data-action="cloud-use">クラウドの記録を開く</button>':''}${mode==='cloud'?'<button class="btn secondary" data-action="cloud-local">このブラウザーの旧記録を開く</button>':''}</div><p class="hint">別のブラウザーでも同じサイトとオーナーアカウントを使います。一度ログインした端末はオフラインでも記録できます。ログアウトするとクラウドの表示を閉じ、再ログインまで開けません。端末内のキャッシュと未送信データは残ります。端末内の暗号化やプライバシーロックではありません。Google ログイン情報を入力するのは Google の画面だけです。</p><div class="quiet-divider"></div><h2>以前の記録を移す</h2><p>このブラウザーの旧データはそのまま残します。クラウドへの移行は件数と競合を確認してから行います。</p><div class="row-actions"><button class="btn secondary" data-action="backup-raw">旧データを JSON で退避</button><button class="btn secondary" data-action="cloud-migrate" ${!view.ready?'disabled':''}>移行内容を確認</button></div>${view.conflicts.length?`<div class="quiet-divider"></div><h2>競合を確認</h2><p>同じ記録が別の場所でも変更されました。どちらを残すか選んでください。</p>${view.conflicts.map(c=>`<div class="info-note sync-review"><strong>${e(c.key)}</strong><p>${e(c.error)}</p><button class="btn secondary" data-action="cloud-conflict" data-key="${e(c.key)}">内容を比較する</button></div>`).join('')}`:''}<div class="quiet-divider"></div><h2>ランニング CSV のフォルダー取り込み</h2><p>設定した Drive フォルダーの CSV はサーバーで分割処理します。定期実行は Google 側の設定が必要です。取り込んだランとルートはランニングの「Drive のラン」で確認できます。</p>${importCaution(view)}${view.maintenanceError?'<p class="hint">保存先の整理は確認待ちです。記録の保存状態とは別に、バックグラウンドで再確認します。</p>':''}<p class="hint">処理状況: ${e(importStatusText(view.importStatus))}。フォルダー・列名・開始と再開の操作は導入手順を確認してください。</p></section>`;
}
export function migrationDialog(preview){return `<form data-form="cloud-migration"><div class="dialog-top"><h2 id="dialog-title">旧データの移行を確認</h2><button type="button" class="icon-button" data-action="dialog-close" aria-label="閉じる">${icon('close')}</button></div><p>新しく追加: ${preview.add.length}件。同じキーの異なる記録: ${preview.conflicts.length}件。</p><p>追加分を送信します。競合は、チェックした項目だけこのブラウザーの旧記録で置き換えます。チェックしない項目はクラウドのままです。</p>${preview.conflicts.map(c=>`<div class="info-note sync-review"><label><input type="checkbox" name="overwrite" value="${e(c.key)}"> ${e(c.key)} を旧記録で置き換える</label><details><summary>内容を比較</summary><p>旧記録: ${e(JSON.stringify(c.local))}</p><p>クラウド: ${e(JSON.stringify(c.cloud))}</p></details></div>`).join('')}<p id="form-error" class="form-error" hidden></p><div class="dialog-actions"><button type="button" class="btn secondary" data-action="dialog-close">キャンセル</button><button type="submit" class="btn primary">確認した内容を移行</button></div></form>`;}
let gisLoading;
const googleIdentityReady=()=>{const identity=globalThis.google?.accounts?.id;return typeof identity?.initialize==='function'&&typeof identity?.renderButton==='function'?identity:null;};
export function loadGoogleIdentity(){
 const ready=googleIdentityReady();if(ready)return Promise.resolve(ready);
 if(gisLoading)return gisLoading;
 let resolve,reject,script,timer,settled=false;
 const pending=new Promise((yes,no)=>{resolve=yes;reject=no;});gisLoading=pending;
 const finish=(error,identity)=>{
  if(settled)return;settled=true;clearTimeout(timer);
  if(script){script.onload=null;script.onerror=null;if(error)script.remove?.();}
  if(gisLoading===pending)gisLoading=null;
  if(error)reject(error);else resolve(identity);
 };
 try{
  script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;
  script.onload=()=>{const identity=googleIdentityReady();finish(identity?null:Error('Google ログインを準備できませんでした。もう一度ログインしてください。'),identity);};
  script.onerror=()=>finish(Error('Google ログインを読み込めませんでした。接続を確認してください。'));
  timer=setTimeout(()=>{const identity=googleIdentityReady();finish(identity?null:Error('Google ログインの読み込みに時間がかかっています。もう一度ログインしてください。'),identity);},15000);
  document.head.append(script);
 }catch{finish(Error('Google ログインを読み込めませんでした。接続を確認してください。'));}
 return pending;
}
export function renderImportedRuns(view,page=0,pageSize=4){
 const runs=view.importedRuns||[],max=Math.max(1,Math.ceil(runs.length/pageSize)),p=Math.min(page,max-1),items=runs.slice(p*pageSize,(p+1)*pageSize);
 return `<section class="card list-panel">${sectionHead('Drive から届いたラン','CSV の計測サンプル。距離や達成回数には加算しません。')}${importCaution(view)}<div class="record-list">${items.length?items.map(r=>`<button class="record-row" data-action="cloud-route" data-id="${e(r.id)}"><span class="record-icon">${icon('run')}</span><span class="record-label"><strong>${e(r.firstTime||r.id)}</strong><small>${e(r.sampleCount)} サンプル · ${e(r.lastTime||'')}</small></span>${icon('right',17)}</button>`).join(''):hasImportErrors(view)?'<p class="hint">取り込み済みのランは、まだ確認できていません。少し待って再確認します。</p>':'<p class="hint">取り込み済みの CSV はまだありません。設定の Google Drive で処理状況を確認できます。</p>'}</div><div class="row-actions"><button class="btn secondary" data-action="view-page" data-page="${p-1}" ${p===0?'disabled':''}>前へ</button><span>${p+1} / ${max}</span><button class="btn secondary" data-action="view-page" data-page="${p+1}" ${p+1>=max?'disabled':''}>次へ</button></div></section>`;
}
