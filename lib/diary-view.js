import { diaryDraft, writeDiaryEntry } from './diary.js';
import { localDate, addDays } from './state.js';
import { esc, dayLabel, icon } from './ui.js';

export function createDiaryController({ dialog, openDialog, getState, updateState, status }) {
  const drafts = new Map();
  let current = null, timer;

  function renderStatus(message) {
    const label = dialog.querySelector('#diary-status');
    if (label) label.textContent = message;
  }
  function flush() {
    clearTimeout(timer);
    if (!current?.dirty) return;
    try {
      updateState(state => writeDiaryEntry(state, current));
      current.dirty = !status().available;
      renderStatus(current.dirty ? '未保存 · この画面内に保持しています' : '保存しました');
    } catch {
      renderStatus('保存できませんでした · 入力はこの画面内に残っています');
    }
  }
  function queueSave(event) {
    if (event.target.id !== 'diary-text' || !current) return;
    current.text = event.target.value;
    current.dirty = true;
    clearTimeout(timer);
    renderStatus('編集中…');
    if (!event.isComposing) timer = setTimeout(flush, 600);
  }
  dialog.addEventListener('input', queueSave);
  dialog.addEventListener('compositionend', queueSave);
  dialog.addEventListener('submit', event => {
    if (event.target.id !== 'diary-form') return;
    event.preventDefault();
    flush();
  });
  dialog.addEventListener('close', flush);
  dialog.addEventListener('cancel', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  return {
    open(date = localDate()) {
      flush();
      addDays(date, 0);
      if (date > localDate()) return;
      const title = date === localDate() ? '今日の日記' : `${dayLabel(date)}の日記`;
      // Pin the editing date until the window closes, including across midnight.
      if (!drafts.has(date)) drafts.set(date, { ...diaryDraft(getState(), date), dirty: false });
      current = drafts.get(date);
      openDialog(title, `<form id="diary-form" class="diary-form">
        <div class="diary-date"><span>${icon('calendar')}<time datetime="${date}">${date.slice(0, 4)}年 ${dayLabel(date)}</time></span><small>ひとことから、自由に。</small></div>
        <textarea id="diary-text" name="diary" maxlength="20000" aria-label="${esc(title)}" placeholder="今日あったこと、考えたこと。">${esc(current.text)}</textarea>
        <div class="diary-footer"><div><span id="diary-status" role="status">${current.dirty ? '未保存 · この画面内に保持しています' : '入力すると自動で保存'}</span><small>このブラウザに保存</small></div><button class="button secondary" type="submit">保存する ${icon('check')}</button></div>
      </form>`);
      dialog.classList.add('diary-dialog');
    },
  };
}
