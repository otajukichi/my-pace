import {e,icon,dayLabel} from './lib/ui.js';
import {dialogShell} from './dialogs.js';
const buttons=extra=>`<div class="dialog-actions">${extra||''}<button class="btn secondary" type="button" data-action="dialog-close">キャンセル</button><button class="btn primary" type="submit">保存する</button></div>`;
export function eventDialog(event,date) {
  return dialogShell(event?'予定を編集':'予定をメモ',`<form data-form="event"><input type="hidden" name="id" value="${e(event?.id||'')}"><label class="field">タイトル<input name="title" maxlength="240" value="${e(event?.title||'')}" placeholder="例：夕方、少し散歩する" required autofocus></label><div class="form-grid"><label class="field">日付<input name="date" type="date" min="1900-01-01" max="2200-12-31" value="${e(event?.date||date)}" required></label><label class="field">時刻（任意）<input name="time" type="time" value="${e(event?.time||'')}"></label></div><label class="field">メモ（任意）<textarea name="note" maxlength="4000" rows="4" placeholder="場所や、覚えておきたいこと。">${e(event?.note||'')}</textarea></label><p class="hint">通知はありません。予定はこのブラウザー内に保存されます。</p>${buttons(event?'<button class="text-link danger" type="button" data-action="event-delete">削除</button>':'')}</form>`);
}
export function diaryDialog(entry,date) {
  const moods=[['','選ばない'],['bright','晴れやか'],['calm','穏やか'],['tired','おつかれ'],['low','しずかな日']];
  return dialogShell('今日のことを、少し。',`<form data-form="diary"><label class="field">気分（任意）<select name="mood">${moods.map(([key,label])=>`<option value="${key}" ${(entry?.mood||'')===key?'selected':''}>${label}</option>`).join('')}</select></label><label class="field diary-field">日記<textarea name="text" maxlength="16000" rows="9" placeholder="よかったこと、考えたこと。ひとことだけでも。" autofocus>${e(entry?.text||'')}</textarea></label><p class="hint">8,000文字以内。保存するまでは記録に反映されません。</p>${buttons(entry?'<button class="text-link danger" type="button" data-action="diary-delete">削除</button>':'')}</form>`,'',dayLabel(date));
}
