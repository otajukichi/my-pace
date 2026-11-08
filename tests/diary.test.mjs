import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, localDate } from '../lib/state.js';
import { diaryDraft, writeDiaryEntry } from '../lib/diary.js';

function fixture() {
  let value = null, fail = false;
  const storage = {
    getItem: () => value,
    setItem: (_, next) => { if (fail) throw new Error('quota'); value = next; },
  };
  const store = createStore({ storage });
  store.update(state => {
    state.notes = [
      { id: 'run-note', runId: 'run-a', date: '2026-11-08', text: 'ランの感想', mood: '軽かった' },
      { id: 'older', date: '2026-11-07', text: '昨日のこと', mood: '' },
      { id: 'first', date: '2026-11-08', text: '今日の別のメモ', mood: '集中' },
      { id: 'latest', date: '2026-11-08', text: '研究が進んだ', mood: 'うれしい' },
    ];
    state.runMeta['run-a'] = { note: 'ランの感想', mood: '軽かった' };
  });
  return { store, storage, fail: next => { fail = next; } };
}

test('daily edits reuse a standalone note and preserve run notes, other dates, moods and extra same-day notes', () => {
  const { store, storage } = fixture(), before = store.get();
  const draft = diaryDraft(before, '2026-11-08');
  assert.equal(draft.id, 'latest');
  draft.text = '研究も英語も。\n<script>literal text</script>';
  store.update(state => writeDiaryEntry(state, draft));
  const reloaded = createStore({ storage }).get();
  assert.deepEqual(reloaded.notes.slice(0, 3), before.notes.slice(0, 3));
  assert.deepEqual(reloaded.runMeta, before.runMeta);
  assert.equal(reloaded.notes[3].mood, 'うれしい');
  assert.equal(diaryDraft(reloaded, draft.date).text, draft.text);
  draft.text = '';
  store.update(state => writeDiaryEntry(state, draft));
  assert.equal(store.get().notes[3].text, '');
  assert.equal(store.get().notes.length, 4);
});

test('a daily entry works without runs, skips empty drafts and never overwrites an ID collision', () => {
  const { store } = fixture();
  store.update(state => { state.notes = [{ id: 'diary:2026-11-09', date: '2026-11-07', text: '保持', mood: '' }]; });
  const before = store.get(), draft = diaryDraft(before, '2026-11-09');
  assert.equal(draft.id, 'diary:2026-11-09:1');
  store.update(state => writeDiaryEntry(state, draft));
  assert.deepEqual(store.get(), before);
  draft.text = '走らない日の記録';
  store.update(state => writeDiaryEntry(state, draft));
  assert.equal(store.get().notes[0].text, '保持');
  assert.equal(store.get().notes[1].runId, undefined);
  assert.throws(() => store.update(state => writeDiaryEntry(state, { ...draft, id: 'diary:2026-11-09' })));
  assert.throws(() => diaryDraft(before, '2026-02-30'));
});

test('failed local persistence keeps edits in memory and can be retried without duplicating notes', () => {
  const { store, storage, fail } = fixture();
  const draft = { ...diaryDraft(store.get(), '2026-11-08'), text: '消えない下書き' };
  fail(true);
  store.update(state => writeDiaryEntry(state, draft));
  assert.equal(store.status().available, false);
  assert.equal(diaryDraft(store.get(), draft.date).text, draft.text);
  assert.equal(diaryDraft(createStore({ storage }).get(), draft.date).text, '研究が進んだ');
  fail(false);
  store.update(state => writeDiaryEntry(state, draft));
  assert.equal(store.status().available, true);
  assert.equal(diaryDraft(createStore({ storage }).get(), draft.date).text, draft.text);
  assert.equal(store.get().notes.length, 4);
});

test('an open diary stays on its original JST date while a later new diary uses the next day', () => {
  const { store } = fixture();
  const draft = diaryDraft(store.get(), localDate(new Date('2026-11-08T14:59:59Z')));
  const next = diaryDraft(store.get(), localDate(new Date('2026-11-08T15:00:00Z')));
  draft.text = '日付をまたいで書いた';
  next.text = '翌日の記録';
  store.update(state => { writeDiaryEntry(state, draft); writeDiaryEntry(state, next); });
  assert.equal(diaryDraft(store.get(), '2026-11-08').text, draft.text);
  assert.equal(diaryDraft(store.get(), '2026-11-09').text, next.text);
});
