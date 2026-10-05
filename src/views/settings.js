import  {
  e,icon,sectionHead
}
from '../lib/ui.js';
export function renderSettings( {
  state
}
)  {
  const count=Object.keys(state.wake).length+state.runs.length+Object.values(state.habitLogs).reduce((sum,logs)=>sum+Object.keys(logs).length,0);
  return `<section class="card settings-card">${sectionHead('データの保存','このブラウザーに、記録を保存しています。')}<div class="storage-info"><span class="storage-icon">${icon('lock',28)}</span><div><strong>ブラウザー内に保存</strong><p>${count}件の記録 · ${state.habits.length}個の習慣</p></div><span class="status-pill">ローカル</span></div><p class="settings-description">別のブラウザーや端末には自動で同期されません。ブラウザーデータの削除、シークレットモードの終了で記録が消えることがあります。大切な記録は、定期的にバックアップしてください。</p><div class="row-actions"><button class="btn primary" data-action="backup-export">${icon('download',18)} JSON を保存</button><button class="btn secondary" data-action="backup-import">${icon('upload',18)} JSON を復元</button></div><p class="hint">バックアップには習慣・起床時間・ランニングの位置情報が含まれます。安全な場所に保管してください。復元前に内容を確認できます。</p></section>
  <section class="card settings-card">${sectionHead('これからのつながり','今は、端末の中だけで動く試作版です。')}<div class="integration-row"><div><strong>Google Drive</strong><p>ファイル保存・スマートフォンと PC の同期</p></div><span class="planned">未実装</span></div><div class="integration-row"><div><strong>Google ログイン</strong><p>個人アカウントとの接続</p></div><span class="planned">未実装</span></div><div class="integration-row"><div><strong>LINE</strong><p>通知・記録の連携</p></div><span class="planned">未実装</span></div><p class="hint">アカウント接続、外部への送信、通知は行っていません。</p></section>
  <section class="card about-card"><img src="./favicon.svg" alt="" width="42" height="42"><div><h2>マイペース</h2><p>自分のペースで、少しずつ。</p><span>Starter 0.1.0 · 個人用ローカル試作</span></div></section>`;
}
