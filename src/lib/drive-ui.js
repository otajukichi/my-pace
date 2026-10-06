import {e,sectionHead} from './ui.js';
import {dialogShell,confirmDialog} from '../dialogs.js';
import {serializeBackup} from './domain.js';
import {createGoogleDrive,validateGoogleConfig as validateConfig} from './google-drive.js';
import {DriveSyncCoordinator,hashState} from './drive-sync.js';

export const DRIVE_CONFIG_KEY='my-pace.drive.config.v1';
const defaultStatus=()=>({state:'disconnected',message:'Google Drive は未接続です。',connected:false,busy:false,dirty:true,verified:false,autosave:false,pendingCount:0});
const button=(action,label,disabled=false,primary=false)=>`<button type="button" class="btn ${primary?'primary':'secondary'}" data-action="${action}" ${disabled?'disabled':''}>${label}</button>`;
export function stateSummary(state) {
  return `${Object.keys(state.wake).length}件の起床・${state.runs.length}件のラン・${state.habits.length}個の習慣・${state.events.length}件の予定・${Object.keys(state.diary).length}日の日記`;
}
export function renderDrivePanel(view={}) {
  const {configured=false,prepared=false,connected=false,folder=false,busy=false,status=defaultStatus(),inspection=null,message=''}=view;
  const blocked=busy||status.busy;
  const needsChoice=inspection&&['choice-required','conflict'].includes(inspection.status);
  return `<section class="card drive-panel">${sectionHead('Google Drive に、もうひとつの保存先。','このブラウザーの記録を、版付き JSON で保存します。')}<div class="drive-grid"><div class="drive-section"><h3>接続</h3><p class="hint">初回は、接続設定 → Google の準備 → Google に接続 → my-pace を選択、の順に進めます。</p><div class="row-actions">${button('drive-config','接続設定',blocked)}${!prepared?button('drive-prepare','Google の準備',!configured||blocked):button('drive-connect',connected?'Google に再接続':'Google に接続',!configured||blocked)}${button('drive-folder','my-pace を選択',!connected||blocked)}</div><p class="hint">保存先：my-pace ${folder?'（本人所有を確認済み）':''}<br>既存の running_data と CSV は読み書きしません。</p>${connected?button('drive-disconnect','接続を解除',false):''}</div><div class="drive-section"><h3>保存と読戻し</h3><p class="drive-status" role="status" aria-live="polite">${e(message||status.message)}</p><p class="hint">端末：ブラウザーに保存 ／ Drive：${e(status.state==='ready'&&!status.dirty?'読戻し確認済み':status.dirty?'未反映の変更あり':'状態を確認してください')}${status.pendingCount?` ／ 未送信 ${e(status.pendingCount)}件`:''}</p><div class="row-actions">${button('drive-inspect','Drive を確認',!folder||blocked)}${button('drive-save',status.pendingCount?'保存待ちを再試行':needsChoice?'端末の記録を採用':'Drive に保存',!folder||blocked,true)}${button('drive-choose','版を選んで復元',!inspection?.snapshots?.length||blocked)}</div>${inspection?`<p class="hint">保存済み ${inspection.historyCount??inspection.snapshots.length}版 ／ 末端 ${inspection.heads.length}版。${needsChoice?'自動選択せず、採用する記録の確認を待っています。':'履歴は削除しません。'}</p>`:''}<div class="row-actions">${status.autosave?button('drive-auto-off','自動保存を止める',blocked):button('drive-auto-on','開いている間の自動保存を有効にする',!folder||!status.verified||!status.locksAvailable||blocked)}</div></div></div><p class="hint drive-privacy">日記・予定・習慣・起床時間・ランの位置情報・庭の設定を、Google Drive に送信します。まず手動保存と読戻しを確認してから、自動保存を選べます。閉じている間は同期しません。認証期限後は再接続が必要です。Drive 保存は1版5 MBまでです。</p></section>`;
}
export function driveConfigDialog(config={},saved=false) {
  return dialogShell('Google Drive の接続設定',`<form data-form="drive-config"><p class="dialog-description">Google Cloud で作った Web OAuth クライアント ID と、利用先を制限したブラウザー用 API キーを入力してください。クライアント シークレット・パスワード・トークンは入力しません。</p><label class="field">OAuth クライアント ID<input name="clientId" value="${e(config.clientId||'')}" placeholder="…apps.googleusercontent.com" autocomplete="off" spellcheck="false" required autofocus></label><label class="field">制限付き API キー<input name="apiKey" type="password" value="${e(config.apiKey||'')}" autocomplete="off" spellcheck="false" required></label><p class="hint">プロジェクト番号：402304619999 ／ 保存先：my-pace<br>この2つはブラウザーで使う識別情報です。チャット・GitHub・バックアップには入れないでください。</p><label class="drive-checkbox"><input name="remember" type="checkbox" ${saved?'checked':''}>このブラウザーに接続設定を保存する</label><p class="hint">チェックしない場合は、このページを閉じると入力値を破棄します。アクセストークンは常にメモリーだけに保持します。</p><div class="dialog-actions"><button class="btn secondary" type="button" data-action="dialog-close">キャンセル</button><button class="btn primary" type="submit">設定する</button></div></form>`);
}
export function createDriveUI({getState,applyState,onChange,toast,showDialog,closeDialog,download,canUse=()=>true,storage=()=>globalThis.localStorage,apiFactory=createGoogleDrive,coordinatorFactory=options=>new DriveSyncCoordinator(options)}) {
  let config=null,saved=false,coordinator=null,inspection=null,pending=null,busy=false,message='',generation=0,foreground=false;
  const api=apiFactory({onDisconnect(){coordinator?.disconnect();message='接続が切れました。端末の記録は残っています。再接続してください。';onChange();}});
  function ensureConfig(){if(config)return;try{const raw=storage().getItem(DRIVE_CONFIG_KEY);if(raw){config=validateConfig(JSON.parse(raw));saved=true;}}catch{config=null;saved=false;}}
  function view(){return {configured:!!config,prepared:api.isPrepared(),connected:api.isConnected(),folder:!!coordinator?.getStatus().connected,busy,status:coordinator?.getStatus()||defaultStatus(),inspection,message};}
  function statusLabel(){const s=coordinator?.getStatus();if(!s)return 'ブラウザー保存';if(['conflict','choice-required','invalid','error'].includes(s.state))return '端末保存 · Drive 要確認';if(!s.connected)return '端末保存 · Drive 未接続';if(s.autosave)return s.dirty?'Drive 保存待ち':'Drive 自動保存';return s.dirty?'端末保存 · Drive 未反映':'Drive 読戻し確認済み';}
  function disconnect(){generation++;api.disconnect();coordinator?.disconnect();inspection=null;pending=null;message='接続を解除しました。端末と Drive の記録は残しています。';onChange();}
  async function run(task){if(busy)return;const seq=generation;busy=true;foreground=true;message='確認しています…';onChange();try{const result=await task();if(seq!==generation)return;message='';return result;}catch(error){if(seq===generation){message=error?.message||'Drive の処理を完了できませんでした。端末の記録は残っています。';toast(message);}}finally{busy=false;foreground=false;onChange();}}
  function requireLocal(){if(!canUse())throw new Error('端末のデータを読み込めません。先に JSON を退避・復元してください。');}
  async function savePrompt(){requireLocal();const seq=generation,request={type:'preparing-save'};pending=request;const current=getState(),hash=await hashState(current);if(seq!==generation||pending!==request)return;if(current!==getState())throw new Error('確認中に記録が変わりました。もう一度やり直してください。');const retry=!!coordinator?.getStatus().pendingCount;const resolution=!retry&&!!inspection&&['choice-required','conflict'].includes(inspection.status);const confirmation={type:'save',hash,heads:inspection?.heads?.slice()||[],resolution};showDialog(confirmDialog(retry?'保存待ちの版を再試行':resolution?'端末の記録を Drive に採用':'Google Drive に保存',retry?'前回確認した送信待ちの版を、同じ Drive ファイル ID で再試行します。前回の記録には日記・予定・位置情報が含まれます。その後の新しい編集は、この送信では反映されず端末に残ります。既存の版は消しません。':`${stateSummary(current)}を含む全データを、Google Drive の my-pace に新しい JSON として送信します。日記・予定・位置情報も含まれます。${resolution?'現在表示されている Drive の版を親にして、この端末の内容を採用します。':''}既存の版・CSV は消しません。`,retry?'前回の版を再試行':'この内容を保存','drive-save-confirm'),{type:'drive-confirm'});pending=confirmation;}
  function showHistory(page){
    if(!inspection?.snapshots?.length)return;
    const history=inspection.history||inspection.snapshots.map(({fileId,envelope})=>({fileId,commitId:envelope.commitId,createdAt:envelope.createdAt}));
    const ordered=[...history].sort((a,b)=>Number(inspection.heads.includes(b.commitId))-Number(inspection.heads.includes(a.commitId))||b.createdAt.localeCompare(a.createdAt)||a.commitId.localeCompare(b.commitId));
    const pages=Math.max(1,Math.ceil(ordered.length/25));page=Math.max(0,Math.min(page,pages-1));
    const confirmation={type:'choose',heads:inspection.heads.slice(),page};
    showDialog(dialogShell('復元する版を選択',`<form data-form="drive-choose"><label class="field">Drive の保存版<select name="commitId">${ordered.slice(page*25,(page+1)*25).map(s=>`<option value="${e(s.commitId)}">${inspection.heads.includes(s.commitId)?'末端 · ':''}${e(s.createdAt)} · ${e(s.commitId.slice(0,8))}</option>`).join('')}</select></label><div class="row-actions">${button('drive-history-prev','前の25版',page===0)}<span class="hint">${page+1} / ${pages}ページ</span>${button('drive-history-next','次の25版',page===pages-1)}</div><p class="hint">末端の版を先頭に、その他を日時順で表示しています。日時だけで正しい版を決めません。選んだ1版を読み込み、次の画面で内容を確認します。</p><div class="dialog-actions"><button class="btn secondary" type="button" data-action="dialog-close">キャンセル</button><button class="btn primary" type="submit">内容を確認</button></div></form>`),{type:'drive-choose'});pending=confirmation;
  }
  async function handle(action){
    if(action==='drive-config'){ensureConfig();showDialog(driveConfigDialog(config||{},saved),{type:'drive-config'});return;}
    if(action==='drive-disconnect'){disconnect();return;}
    if(action==='drive-auto-off'){coordinator?.setAutosave(false);message='自動保存を止めました。';onChange();return;}
    if(action==='drive-save'){await savePrompt();return;}
    if(action==='drive-choose'){showHistory(0);return;}
    if(action==='drive-history-prev'||action==='drive-history-next'){if(pending?.type==='choose')showHistory(pending.page+(action==='drive-history-next'?1:-1));return;}
    if(action==='drive-export-preview'){if(pending?.type==='load'&&pending.previewState)download(serializeBackup(pending.previewState),`my-pace-drive-${pending.commitId}.json`);return;}
    if(action==='drive-save-confirm'||action==='drive-load-confirm'){
      const choice=pending;if(!choice||choice.type!==(action==='drive-save-confirm'?'save':'load'))return;
      pending=null;closeDialog();
      return run(async()=>{requireLocal();if(action==='drive-save-confirm'){const result=await coordinator.save({explicit:true,resolution:choice.resolution,expectedHeads:choice.heads,expectedLocalHash:choice.hash});toast(result?.dirty?'前の保存待ちを Drive に確認しました。新しい編集はまだ端末に残っています。':'Drive に保存し、読み直して内容を確認しました。');}else{await coordinator.load(choice.commitId,{expectedLocalHash:choice.hash,expectedHeads:choice.heads,expectedSnapshotHash:choice.snapshotHash});toast('選んだ Drive の版を端末に復元しました。');}inspection=await coordinator.inspect();});
    }
    if(action==='drive-auto-on'){
      showDialog(confirmDialog('自動保存を有効にする','このページを開いて Google に接続している間、編集した全記録（日記・予定・位置情報を含む）を my-pace に自動送信します。競合や通信エラー時は止まり、端末の記録を残します。ページを閉じた後は、再び接続して有効にしてください。','有効にする','drive-auto-confirm'),{type:'drive-confirm'});pending={type:'auto'};return;
    }
    if(action==='drive-auto-confirm'){if(pending?.type!=='auto')return;pending=null;closeDialog();coordinator?.setAutosave(true);message='開いている間の自動保存を有効にしました。';onChange();return;}
    return run(async()=>{
      if(action==='drive-prepare'){ensureConfig();if(!config)throw new Error('先に接続設定を入力してください。');await api.prepare();toast('Google の準備ができました。「Google に接続」を押してください。');}
      else if(action==='drive-connect'){requireLocal();ensureConfig();if(!config)throw new Error('接続設定を入力してください。');coordinator?.disconnect();inspection=null;await api.connect(config);toast('Google に接続しました。「my-pace を選択」に進んでください。');}
      else if(action==='drive-folder'){requireLocal();const folder=await api.selectFolder(config);if(!folder)return;if(!coordinator)coordinator=coordinatorFactory({api,storage:storage(),getState,applyState,onStatus(){if(!busy)message='';onChange();}});await coordinator.connectFolder(folder.id);coordinator.setReady(true);inspection=await coordinator.inspect();toast('保存先を確認しました。端末の記録を保存するか、Drive の版を復元してください。');}
      else if(action==='drive-inspect'){requireLocal();inspection=await coordinator.inspect();}
    });
  }
  async function submit(type,data){
    if(type==='drive-config'){
      const next=validateConfig({clientId:String(data.get('clientId')||'').trim(),apiKey:String(data.get('apiKey')||'').trim()});
      const remember=data.get('remember')==='on';
      if(remember)storage().setItem(DRIVE_CONFIG_KEY,JSON.stringify(next));else storage().removeItem(DRIVE_CONFIG_KEY);
      disconnect();config=next;saved=remember;message='設定しました。Google の準備から進めてください。';closeDialog();onChange();return;
    }
    if(type==='drive-choose'){
      if(pending?.type!=='choose')return;
      const request=pending,seq=generation,commitId=data.get('commitId');
      const current=getState(),hash=await hashState(current);if(seq!==generation||pending!==request)return;
      const choice=coordinator.preview?await coordinator.preview(commitId,{expectedHeads:request.heads}):inspection?.snapshots.find(item=>item.envelope.commitId===commitId);
      if(seq!==generation||pending!==request||!choice)return;
      if(current!==getState())throw new Error('確認中に端末の記録が変わりました。やり直してください。');
      const heads=choice.heads||request.heads;pending={type:'load',commitId:choice.envelope.commitId,hash,heads,previewState:choice.envelope.state,snapshotHash:choice.envelope.hash};
      // showDialog may close the previous dialog; reset the pending choice afterwards.
      const confirmation=pending;
      showDialog(confirmDialog('Drive の版を端末に復元',`${stateSummary(choice.envelope.state)}で現在の全データを置き換えます。復元直後は「元に戻す」で取り消せます。先に端末の JSON を保存しておくと安心です。Drive の履歴は変更しません。`,'置き換えて復元','drive-load-confirm').replace('<div class="dialog-actions">','<div class="dialog-actions"><button type="button" class="btn secondary" data-action="drive-export-preview">この版の JSON を保存</button>'),{type:'drive-confirm'});pending=confirmation;
    }
  }
  return {view,statusLabel,handle,submit,enter(){ensureConfig();},dialogClosed(){pending=null;},navigate(){pending=null;if(foreground)disconnect();},notifyLocalChange(){message='';coordinator?.notifyLocalChange();},storageChanged(){coordinator?.notifyLocalChange();},resume(){if(coordinator?.getStatus().autosave&&api.isConnected())coordinator.notifyLocalChange();},exportSnapshot(commitId){const item=inspection?.snapshots.find(s=>s.envelope.commitId===commitId);if(item)download(serializeBackup(item.envelope.state),`my-pace-drive-${commitId}.json`);}};
}
