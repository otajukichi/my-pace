// Shared by the authenticated API and UI. Only operational summaries are allowed.
export function validateSyncStatus(value) {
  const fail = () => { throw Error('SYNC_STATUS_INVALID'); };
  const keys = ['schema','kind','updatedAt','status','enabled','phase','sources','importedSources','pendingSources','nextRunAt','waitReason','lastSuccessfulUpdate','catalogHash','budget','errorCode'];
  const record = (x, fields) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === fields.length && fields.every(k => Object.hasOwn(x,k));
  if (record(value,['schema','kind','available']) && value.schema === 1 && value.kind === 'running-sync-status' && value.available === false) return null;
  if (!record(value,keys) || value.schema !== 1 || value.kind !== 'running-sync-status') fail();
  const count = x => Number.isSafeInteger(x) && x >= 0 && x <= 1e9;
  const time = x => x === null || Number.isSafeInteger(x) && x > 0 && x < 1e14;
  const code = x => x === null || typeof x === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(x);
  if (!time(value.updatedAt) || value.updatedAt === null || !time(value.nextRunAt) || !time(value.lastSuccessfulUpdate)
    || !code(value.status) || value.status === null || !code(value.errorCode) || !code(value.waitReason)
    || typeof value.enabled !== 'boolean' || !['sources','importedSources','pendingSources'].every(k=>count(value[k]))
    || !(value.phase === null || typeof value.phase === 'string' && /^[a-z]{1,32}$/.test(value.phase))
    || !(value.catalogHash === null || typeof value.catalogHash === 'string' && /^[a-f0-9]{64}$/.test(value.catalogHash))) fail();
  const b=value.budget;
  if (!record(b,['limitMinutes','usedMinutes','reserveMinutes','requestLimit','requests'])
    || !['limitMinutes','usedMinutes','reserveMinutes'].every(k=>Number.isFinite(b[k])&&b[k]>=0&&b[k]<=10000)
    || !count(b.requestLimit)||!count(b.requests)) fail();
  return value;
}
export function syncTime(value) {
  return value ? new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(value) : 'まだありません';
}
export function syncPresentation(value,{now=Date.now(),error='',refreshError='',refreshing=false}={}) {
  const keep='表示済みの記録はそのまま利用できます。';
  if(error)return {tone:'warning',label:'更新状況を確認できません',detail:'通信が戻ったら再確認します。'+keep};
  if(!value)return {tone:'neutral',label:'自動取り込みの状態は未接続',detail:'Apps Scriptの更新後、開始すると状態が届きます。'+keep};
  const s=value, progress=`CSV ${s.importedSources}/${s.sources}件反映・未処理 ${s.pendingSources}件`;
  const delayed=s.enabled&&now>(s.status==='BUDGET_WAIT'&&s.nextRunAt?s.nextRunAt:s.updatedAt)+15*60000;
  if(delayed)return {tone:'warning',label:'自動更新の状態が届いていません',detail:`最終通知 ${syncTime(s.updatedAt)}。Apps Scriptの実行履歴を確認してください。${keep}`};
  if(s.status==='BUDGET_WAIT')return {tone:'waiting',label:'上限回復待ち',detail:`${progress}。${s.waitReason==='REQUEST_BUDGET'?'通信回数':'実行時間'}の内部予算に達したため待機中。${syncTime(s.nextRunAt)}ごろ自動再開予定（日本時間）。${keep}`};
  if(refreshError)return {tone:'warning',label:'新しい表示データを読み込めません',detail:'前回読み込んだ記録を表示しています。再確認から読み込み直せます。'};
  if(refreshing)return {tone:'active',label:'表示データを更新中',detail:keep};
  if(s.status==='READY')return {tone:'neutral',label:'取り込み準備完了・開始待ち',detail:`${progress}。Apps Scriptで startMyPaceRunningProduction を実行すると取り込みを開始します。`};
  if(['STOPPED','ROLLED_BACK','ALREADY_STARTED'].includes(s.status)&&!s.enabled)return {tone:'neutral',label:s.status==='ROLLED_BACK'?'初期表示に戻しました':'自動取り込みを停止中',detail:keep};
  if(['WATCHING','UPDATED'].includes(s.status))return {tone:'ok',label:s.pendingSources?'取り込みを継続中':'更新確認済み',detail:`${progress}。新しいCSVを約5分ごとに確認します。`};
  if(['PROCESSING','PREPARING','SETTLING','INPUT_CHANGED_RETRY'].includes(s.status))return {tone:'active',label:s.status==='PREPARING'?'取り込みを準備中':s.status==='SETTLING'?'CSVの追加・変更を確認中':'CSVを取り込み中',detail:`${progress}。完成した分から表示を更新します。${keep}`};
  if(['DRIVE_RETRYABLE','DRIVE_TRANSPORT_ERROR'].includes(s.status))return {tone:'waiting',label:'Googleへの接続を再試行待ち',detail:'次の自動実行で再試行します。'+keep};
  return {tone:'warning',label:'取り込みの確認が必要です',detail:`Apps Scriptのレポートを確認してください（${s.errorCode||s.status}）。${keep}`};
}
