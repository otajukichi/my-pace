import {e,icon,sectionHead} from './ui.js';
export function cloudStatus(view,mode,initializing=false){
 if(initializing)return '保存先を確認中';
 if(mode==='local')return 'このブラウザーのみ';
 if(view.error==='STORE_YIELD')return `保存先の復旧を要確認・自動同期は停止中 · 未送信 ${view.pending}件`;
 if(view.conflicts.length)return `競合 ${view.conflicts.length}件 · 要確認`;
 if(view.error==='WRITER_RECOVERY_PENDING')return `履歴の復旧・再試行待ち · 未送信 ${view.pending}件`;
 if(view.error==='WRITER_RECOVERY_SETUP_REQUIRED')return `保存先の設定待ち · 未送信 ${view.pending}件`;
 if(view.error==='OFFLINE')return `オフライン・この端末の記録 · 未送信 ${view.pending}件`;
 if(view.error)return `同期できません・この端末の記録 · 未送信 ${view.pending}件`;
 if(!view.authenticated)return `この端末の記録 · 再ログイン待ち ${view.pending}件`;
 if(view.pending)return `端末に保存済み · 同期待ち ${view.pending}件`;
 if(view.busy)return 'Drive を確認中';
 if(view.ready===false||view.verified===false)return 'Drive の保存状態は未確認';
 return 'Google Drive に保存済み';
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
export function cloudErrorText(code){return ({STORE_YIELD:'保存先の確認が処理時間の上限に達したため、自動再試行を止めています。オーナー側の復旧状況を確認してから「今すぐ同期」で再確認してください。記録や保存先を作り直す必要はありません',WRITER_RECOVERY_PENDING:'保存先の履歴を復旧しています。時間をおいて「今すぐ同期」で続きを確認してください',WRITER_RECOVERY_SETUP_REQUIRED:'自動再試行を止めています。保存先の復旧設定を確認する必要があります。記録や保存先を作り直さず、導入手順を確認した後に「今すぐ同期」で再確認してください'})[code]||code;}
export function renderCloudPanel(view,mode){
 return `<section class="card settings-panel cloud-panel">${sectionHead('いつもの記録を、どのブラウザーでも。','Google Drive · 自分だけの保存先')}<div class="storage-info"><span class="storage-icon">${icon('lock',27)}</span><div><strong>${e(cloudStatus(view,mode))}</strong><p>単一オーナーの Google アカウントでログイン</p></div><span class="status-pill">${mode==='cloud'?'クラウド':'ローカル'}</span></div><p>クラウドの変更はまずこの端末に保存され、接続が戻ると送信されます。未送信の記録がある間は、このサイトのブラウザーデータを消さないでください。</p>${view.error?`<div class="info-note sync-review" role="status">同期状況: ${e(cloudErrorText(view.error))}。記録と未送信の変更は保持しています。</div>`:''}<div class="row-actions">${!view.authenticated?'<button class="btn primary" data-action="cloud-login">Google でログイン</button>':'<button class="btn secondary" data-action="cloud-sync">今すぐ同期</button><button class="btn secondary" data-action="cloud-logout">ログアウト</button>'}${view.ready&&mode!=='cloud'?'<button class="btn primary" data-action="cloud-use">クラウドの記録を開く</button>':''}${mode==='cloud'?'<button class="btn secondary" data-action="cloud-local">このブラウザーの旧記録を開く</button>':''}</div><p class="hint">別のブラウザーでも同じサイトとオーナーアカウントを使います。一度ログインした端末はオフラインでも記録できます。ログアウトするとクラウドの表示を閉じ、再ログインまで開けません。端末内のキャッシュと未送信データは残ります。端末内の暗号化やプライバシーロックではありません。Google ログイン情報を入力するのは Google の画面だけです。</p><div class="quiet-divider"></div><h2>以前の記録を移す</h2><p>このブラウザーの旧データはそのまま残します。クラウドへの移行は件数と競合を確認してから行います。</p><div class="row-actions"><button class="btn secondary" data-action="backup-raw">旧データを JSON で退避</button><button class="btn secondary" data-action="cloud-migrate" ${!view.ready?'disabled':''}>移行内容を確認</button></div>${view.conflicts.length?`<div class="quiet-divider"></div><h2>競合を確認</h2><p>同じ記録が別の場所でも変更されました。どちらを残すか選んでください。</p>${view.conflicts.map(c=>`<div class="info-note sync-review"><strong>${e(c.key)}</strong><p>${e(c.error)}</p><button class="btn secondary" data-action="cloud-conflict" data-key="${e(c.key)}">内容を比較する</button></div>`).join('')}`:''}<div class="quiet-divider"></div><h2>ランニング CSV のフォルダー取り込み</h2><p>設定した Drive フォルダーの CSV はサーバーで分割処理します。定期実行は Google 側の設定が必要です。取り込んだランとルートはランニングの「Drive のラン」で確認できます。</p><p class="hint">処理状況: ${e(importStatusText(view.importStatus))}。フォルダー・列名・開始と再開の操作は導入手順を確認してください。</p></section>`;
}
export function migrationDialog(preview){return `<form data-form="cloud-migration"><div class="dialog-top"><h2 id="dialog-title">旧データの移行を確認</h2><button type="button" class="icon-button" data-action="dialog-close" aria-label="閉じる">${icon('close')}</button></div><p>新しく追加: ${preview.add.length}件。同じキーの異なる記録: ${preview.conflicts.length}件。</p><p>追加分を送信します。競合は、チェックした項目だけこのブラウザーの旧記録で置き換えます。チェックしない項目はクラウドのままです。</p>${preview.conflicts.map(c=>`<div class="info-note sync-review"><label><input type="checkbox" name="overwrite" value="${e(c.key)}"> ${e(c.key)} を旧記録で置き換える</label><details><summary>内容を比較</summary><p>旧記録: ${e(JSON.stringify(c.local))}</p><p>クラウド: ${e(JSON.stringify(c.cloud))}</p></details></div>`).join('')}<p id="form-error" class="form-error" hidden></p><div class="dialog-actions"><button type="button" class="btn secondary" data-action="dialog-close">キャンセル</button><button type="submit" class="btn primary">確認した内容を移行</button></div></form>`;}
let gisLoading;
export async function loadGoogleIdentity(){
 if(globalThis.google?.accounts?.id)return globalThis.google.accounts.id;
 if(!gisLoading)gisLoading=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;script.onload=()=>resolve(globalThis.google.accounts.id);script.onerror=()=>{gisLoading=null;reject(Error('Google ログインを読み込めませんでした。接続を確認してください。'));};document.head.append(script);});
 return gisLoading;
}
export function renderImportedRuns(view,page=0,pageSize=4){
 const runs=view.importedRuns||[],max=Math.max(1,Math.ceil(runs.length/pageSize)),p=Math.min(page,max-1),items=runs.slice(p*pageSize,(p+1)*pageSize);
 return `<section class="card list-panel">${sectionHead('Drive から届いたラン','CSV の計測サンプル。距離や達成回数には加算しません。')}<div class="record-list">${items.length?items.map(r=>`<button class="record-row" data-action="cloud-route" data-id="${e(r.id)}"><span class="record-icon">${icon('run')}</span><span class="record-label"><strong>${e(r.firstTime||r.id)}</strong><small>${e(r.sampleCount)} サンプル · ${e(r.lastTime||'')}</small></span>${icon('right',17)}</button>`).join(''):'<p class="hint">取り込み済みの CSV はまだありません。設定の Google Drive で処理状況を確認できます。</p>'}</div><div class="row-actions"><button class="btn secondary" data-action="view-page" data-page="${p-1}" ${p===0?'disabled':''}>前へ</button><span>${p+1} / ${max}</span><button class="btn secondary" data-action="view-page" data-page="${p+1}" ${p+1>=max?'disabled':''}>次へ</button></div></section>`;
}
