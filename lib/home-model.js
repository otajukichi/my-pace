import { addDays, localDate, weekStart } from './state.js';
import { shiftMonth } from './running-calendar.js';
import { validatePracticeRecord } from './english-model.js';

// Activities keep their own units. A complete running/English arc means that
// a record exists that day, not that an invented daily goal has been reached.
export const HOME_ACTIVITIES = Object.freeze([
  { id: 'running', label: 'ランニング', icon: 'run', href: '#records' },
  { id: 'english', label: '英会話', icon: 'chat', href: '#english' },
  { id: 'habits', label: '習慣', icon: 'check' },
].map(Object.freeze));

const list = value => Array.isArray(value) ? value : [];
const validId = value => typeof value === 'string' && value.length > 0
  && value.length <= 128 && !['__proto__', 'prototype', 'constructor'].includes(value);
const currentHabitIds = workspace => new Set(list(workspace?.habits).map(habit => habit?.id).filter(validId));

function blankDay(date, total) {
  return {
    date,
    running: { count: 0, distanceMeters: 0, durationSeconds: 0 },
    english: { count: 0, conversationCount: 0, readingCount: 0 },
    habits: { completed: 0, total, ids: [] },
    diary: { hasEntry: false, text: '' },
    activeCount: 0,
    ratios: { running: 0, english: 0, habits: 0 },
  };
}

/** Read-only month projection from the existing activity and workspace stores. */
export function buildHomeMonth({ month, today = localDate(), runs = [], englishRecords = [], workspace = {} } = {}) {
  addDays(today, 0);
  month ??= today.slice(0, 7);
  shiftMonth(month, 0);
  const first = `${month}-01`, last = addDays(`${shiftMonth(month, 1)}-01`, -1);
  const start = weekStart(first);
  const weeks = Math.max(5, Math.ceil((Date.parse(last) - Date.parse(start) + 86400000) / (7 * 86400000)));
  const habitIds = currentHabitIds(workspace);
  const dates = Array.from({ length: weeks * 7 }, (_, index) => addDays(start, index));
  const days = new Map(dates.map(date => [date, blankDay(date, habitIds.size)]));
  const eligibleDay = date => typeof date === 'string' && date <= today ? days.get(date) : undefined;

  const seenRuns = new Set();
  for (const run of list(runs)) {
    const day = eligibleDay(run?.date), id = run?.id;
    const { distanceMeters, durationSeconds } = run?.summary ?? {};
    if (!day || !validId(id) || seenRuns.has(id) || !Number.isFinite(distanceMeters)
      || distanceMeters <= 0 || !Number.isFinite(durationSeconds) || durationSeconds < 0) continue;
    seenRuns.add(id);
    day.running.count++;
    day.running.distanceMeters += distanceMeters;
    day.running.durationSeconds += durationSeconds;
  }

  const seenSessions = new Set();
  for (const value of list(englishRecords)) {
    let record;
    try { record = validatePracticeRecord(value); } catch { continue; }
    if (seenSessions.has(record.sessionId)) continue;
    seenSessions.add(record.sessionId);
    const day = eligibleDay(localDate(new Date(record.performedAt)));
    if (!day) continue;
    day.english.count++;
    day.english[record.kind === 'reading' ? 'readingCount' : 'conversationCount']++;
  }

  // Mirror the diary editor's canonical-entry preference, including a cleared
  // canonical entry. Legacy run-specific notes never become a daily diary.
  const entries = new Map();
  for (const note of list(workspace?.notes)) {
    if (!note || Object.hasOwn(note, 'runId') || !eligibleDay(note.date)
      || !validId(note.id) || typeof note.text !== 'string' || note.text.length > 20000) continue;
    const previous = entries.get(note.date);
    if (!previous || previous.id !== `diary:${note.date}`) entries.set(note.date, note);
  }

  for (const day of days.values()) {
    if (day.date > today) continue;
    const stored = workspace?.checks && Object.hasOwn(workspace.checks, day.date) ? workspace.checks[day.date] : [];
    day.habits.ids = [...new Set(list(stored).filter(id => habitIds.has(id)))];
    day.habits.completed = day.habits.ids.length;
    const text = entries.get(day.date)?.text ?? '';
    day.diary = { hasEntry: Boolean(text.trim()), text };
    day.ratios = {
      running: Number(day.running.count > 0),
      english: Number(day.english.count > 0),
      habits: day.habits.total ? day.habits.completed / day.habits.total : 0,
    };
    day.activeCount = HOME_ACTIVITIES.filter(activity => day.ratios[activity.id] > 0).length;
  }

  const cells = dates.map((date, index) => ({
    ...days.get(date), dayNumber: Number(date.slice(8)), inMonth: date.startsWith(month),
    future: date > today, week: Math.floor(index / 7), weekday: index % 7,
  }));
  const summary = {
    activeDays: 0, runningDays: 0, distanceMeters: 0, englishDays: 0,
    englishSessions: 0, habitChecks: 0, diaryDays: 0,
  };
  for (const day of cells.filter(day => day.inMonth && !day.future)) {
    if (day.activeCount > 0) summary.activeDays++;
    if (day.running.count) summary.runningDays++;
    if (day.english.count) summary.englishDays++;
    summary.distanceMeters += day.running.distanceMeters;
    summary.englishSessions += day.english.count;
    summary.habitChecks += day.habits.completed;
    if (day.diary.hasEntry) summary.diaryDays++;
  }
  return { month, today, cells, days, weeks, summary };
}

/** Workspace-store mutator; returns the new checked state. Unknown IDs are no-ops. */
export function toggleHabit(state, date, habitId, { today = localDate() } = {}) {
  addDays(date, 0);
  addDays(today, 0);
  if (date > today || !currentHabitIds(state).has(habitId)) return false;
  const stored = state.checks && Object.hasOwn(state.checks, date) ? state.checks[date] : [];
  const checks = new Set(list(stored));
  const checked = !checks.has(habitId);
  if (checked) checks.add(habitId); else checks.delete(habitId);
  state.checks ??= {};
  if (checks.size) state.checks[date] = [...checks];
  else delete state.checks[date];
  return checked;
}
