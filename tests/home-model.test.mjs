import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHomeMonth, HOME_ACTIVITIES, toggleHabit } from '../lib/home-model.js';
import { createStore } from '../lib/state.js';

const run = (id, date, distanceMeters = 2500, durationSeconds = 900) => ({ id, date, summary: { distanceMeters, durationSeconds } });
const practice = (sessionId, performedAt, kind = 'conversation') => ({
  schema: 1, sessionId, performedAt, kind,
  areaId: kind === 'reading' ? null : 'people', themeId: 'first-hello',
  modeId: kind === 'reading' ? 'reading' : 'scene', origin: 'manual',
});
const note = (id, date, text, other = {}) => ({ id, date, text, mood: '', ...other });
const workspace = () => ({ habits: [{ id: 'read', name: '読書', icon: 'book' }, { id: 'stretch', name: 'ストレッチ', icon: 'stretch' }], checks: {}, notes: [] });
const build = options => buildHomeMonth({ month: '2026-11', today: '2026-11-21', workspace: workspace(), ...options });

test('empty month keeps independent zero-valued activities and complete Monday-first weeks', () => {
  const value = build();
  assert.deepEqual(HOME_ACTIVITIES.map(activity => activity.id), ['running', 'english', 'habits']);
  assert.equal(value.cells.length, 42);
  assert.equal(value.weeks, 6);
  assert.equal(value.cells[0].date, '2026-10-26');
  assert.equal(value.cells.at(-1).date, '2026-12-06');
  assert.equal(value.cells.filter(day => day.inMonth).length, 30);
  assert.equal(new Set(value.cells.map(day => day.date)).size, value.cells.length);
  assert.deepEqual(value.days.get('2026-11-21').ratios, { running: 0, english: 0, habits: 0 });
  assert.equal(value.days.get('2026-11-21').habits.total, 2);
  assert.deepEqual(Object.values(value.summary), [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(value.cells.find(day => day.date === '2026-11-22').future, true);
});

test('calendar retains leap days, five-row short months, and year boundaries', () => {
  const leap = build({ month: '2024-02', today: '2024-03-01' });
  assert.equal(leap.cells.filter(day => day.inMonth).length, 29);
  assert.equal(leap.days.has('2024-02-29'), true);
  assert.equal(leap.cells[0].date, '2024-01-29');
  const short = build({ month: '2021-02', today: '2021-03-01' });
  assert.equal(short.weeks, 5);
  assert.equal(short.cells.length, 35);
  assert.equal(short.cells[0].date, '2021-02-01');
  const january = build({ month: '2027-01', today: '2027-01-05' });
  assert.equal(january.cells[0].date, '2026-12-28');
  assert.throws(() => build({ month: '2026-13' }));
  assert.throws(() => build({ today: '2026-02-30' }));
});

test('same-day runs sum their original units, deduplicate IDs, and retain the source day', () => {
  const one = run('run-one', '2026-11-07');
  const value = build({ runs: [one, structuredClone(one), run('run-two', '2026-11-07', 1750, 650), run('run-three', '2026-11-08', 50, 0), run('previous', '2026-10-31', 900)] });
  assert.deepEqual(value.days.get('2026-11-07').running, { count: 2, distanceMeters: 4250, durationSeconds: 1550 });
  assert.equal(value.days.get('2026-11-07').ratios.running, 1);
  assert.equal(value.days.get('2026-11-08').ratios.running, 1);
  assert.equal(value.summary.runningDays, 2);
  assert.equal(value.summary.distanceMeters, 4300);
  assert.equal(value.days.get('2026-10-31').running.distanceMeters, 900);
  assert.equal(value.summary.activeDays, 2);
});

test('English uses Japan dates and only counts completed, valid, unique practice records', () => {
  const before = practice('session-before', '2026-11-06T14:59:59.000Z');
  const after = practice('session-after', '2026-11-06T15:00:00.000Z');
  const reading = practice('session-reading', '2026-11-07T01:00:00.000Z', 'reading');
  const pending = { sessionId: 'pending-session', startedAt: '2026-11-07T00:00:00.000Z', materialId: 'first-hello', kind: 'conversation', areaId: 'people', modeId: 'scene' };
  const value = build({ englishRecords: [before, after, structuredClone(after), reading, pending] });
  assert.equal(value.days.get('2026-11-06').english.count, 1);
  assert.deepEqual(value.days.get('2026-11-07').english, { count: 2, conversationCount: 1, readingCount: 1 });
  assert.equal(value.summary.englishSessions, 3);
  assert.equal(value.summary.englishDays, 2);
  assert.deepEqual(value.days.get('2026-11-07').ratios, { running: 0, english: 1, habits: 0 });
});

test('invalid, missing, future and non-positive records cannot invent activity', () => {
  const value = build({
    runs: [null, run('future', '2026-11-22'), run('invalid', '2026-02-30'), run('zero', '2026-11-07', 0), run('bad-duration', '2026-11-07', 500, -1), run('bad-distance', '2026-11-07', NaN), run('', '2026-11-07')],
    englishRecords: [null, practice('session-invalid', 'bad-date'), practice('session-future', '2026-11-21T15:00:00.000Z'), { ...practice('session-bad-kind', '2026-11-07T00:00:00.000Z'), kind: 'pending' }],
    workspace: { ...workspace(), checks: { '2026-11-22': ['read'] }, notes: [note('future-note', '2026-11-22', '未来の記録')] },
  });
  assert.equal(value.summary.activeDays, 0);
  assert.equal(value.summary.diaryDays, 0);
  assert.equal(value.days.get('2026-11-22').activeCount, 0);
  assert.equal(value.days.get('2026-11-22').diary.hasEntry, false);
});

test('habit fractions use unique current habits and never infer checks from activity records', () => {
  const state = workspace();
  state.habits.push({ ...state.habits[0] });
  state.checks = { '2026-11-07': ['read', 'read', 'removed-habit'], '2026-11-08': ['read', 'stretch'], '2026-11-09': ['removed-habit'] };
  const original = structuredClone(state);
  const value = build({ workspace: state, runs: [run('run-one', '2026-11-07')], englishRecords: [practice('session-one', '2026-11-07T00:00:00.000Z')] });
  assert.deepEqual(value.days.get('2026-11-07').habits, { completed: 1, total: 2, ids: ['read'] });
  assert.deepEqual(value.days.get('2026-11-07').ratios, { running: 1, english: 1, habits: .5 });
  assert.equal(value.days.get('2026-11-07').activeCount, 3);
  assert.equal(value.days.get('2026-11-08').ratios.habits, 1);
  assert.equal(value.days.get('2026-11-09').activeCount, 0);
  assert.equal(value.summary.habitChecks, 3);
  assert.equal(value.summary.activeDays, 2);
  assert.deepEqual(state, original);
  assert.equal(build({ workspace: { ...state, habits: [] } }).days.get('2026-11-07').ratios.habits, 0);
});

test('diary is independent, canonical entries win, and legacy run notes stay out', () => {
  const state = workspace();
  state.notes = [
    note('run-note', '2026-11-05', 'ラン専用メモ', { runId: 'run-one' }),
    note('first-note', '2026-11-06', '以前のノート'),
    note('last-note', '2026-11-06', '最後のノート'),
    note('diary:2026-11-07', '2026-11-07', '今日のこと'),
    note('later-note', '2026-11-07', '他のノート'),
    note('old-note', '2026-11-08', '消す前の内容'),
    note('diary:2026-11-08', '2026-11-08', ''),
    note('white-space', '2026-11-09', ' \n '),
  ];
  const value = build({ workspace: state });
  assert.equal(value.days.get('2026-11-05').diary.hasEntry, false);
  assert.equal(value.days.get('2026-11-06').diary.text, '最後のノート');
  assert.equal(value.days.get('2026-11-07').diary.text, '今日のこと');
  assert.equal(value.days.get('2026-11-08').diary.hasEntry, false);
  assert.equal(value.days.get('2026-11-09').diary.hasEntry, false);
  assert.equal(value.summary.diaryDays, 2);
  assert.equal(value.summary.activeDays, 0);
});

test('habit toggling persists through the workspace store and unknown/future edits are no-ops', () => {
  let saved = null;
  const storage = { getItem: () => saved, setItem: (_, value) => { saved = value; } };
  const store = createStore({ storage, today: '2026-11-21' });
  const options = { today: '2026-11-21' };
  store.update(state => assert.equal(toggleHabit(state, '2026-11-20', 'read', options), true));
  assert.deepEqual(createStore({ storage }).get().checks['2026-11-20'], ['read']);
  const before = store.get();
  store.update(state => { assert.equal(toggleHabit(state, '2026-11-20', 'unknown', options), false); assert.equal(toggleHabit(state, '2026-11-22', 'read', options), false); });
  assert.deepEqual(store.get(), before);
  store.update(state => assert.equal(toggleHabit(state, '2026-11-20', 'read', options), false));
  assert.equal(Object.hasOwn(store.get().checks, '2026-11-20'), false);
  assert.throws(() => store.update(state => toggleHabit(state, '2026-02-30', 'read', options)));
});
