import { addDays } from './state.js';

// A daily entry belongs to the person, independently of any activity.
export function diaryDraft(state, date) {
  addDays(date, 0);
  const eligible = state.notes.filter(note => note.date === date && !Object.hasOwn(note, 'runId'));
  const canonical = `diary:${date}`;
  const existing = eligible.find(note => note.id === canonical) || eligible.at(-1);
  if (existing) return { id: existing.id, date, text: existing.text };
  let id = canonical, suffix = 1;
  while (state.notes.some(note => note.id === id)) id = `${canonical}:${suffix++}`;
  return { id, date, text: '' };
}

export function writeDiaryEntry(state, entry) {
  addDays(entry.date, 0);
  if (typeof entry.text !== 'string' || entry.text.length > 20000) throw new TypeError('日記は20,000文字までです。');
  const previous = state.notes.find(note => note.id === entry.id);
  if (previous) {
    if (previous.date !== entry.date || Object.hasOwn(previous, 'runId')) throw new Error('別の記録は上書きできません。');
    previous.text = entry.text;
  } else if (entry.text.trim()) {
    state.notes.push({ id: entry.id, date: entry.date, text: entry.text, mood: '' });
  }
}
