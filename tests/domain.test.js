import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  createInitialState, validateState, parseBackup, serializeBackup, isDateKey, localDateKey,
  addDays, recentDates, timeToMinutes, minutesToTime, formatDuration, formatPace,
  streak, wakeStats, upsertWake, upsertHabitLog, habitStats, habitStreak, isHabitComplete, makeId,
} from '../src/lib/domain.js';
import { readState, writeState, STORAGE_KEY } from '../src/lib/storage.js';

const initial = () => createInitialState();
const withHabit = (type = 'check', target = 1) => ({ ...initial(), habits: [{ id: 'read', name: '読書', type, target, unit: type === 'time' ? '分' : '', archived: false }] });
const run = () => ({ id: 'run-1', date: '2026-10-05', distanceKm: 5, durationSec: 1800, note: '朝のラン', points: [] });
const rejected = (mutate) => { const state = initial(); mutate(state); assert.throws(() => validateState(state)); };

test('initial state is empty, detached, and valid', () => {
  const a = initial(), b = initial();
  assert.deepEqual(validateState(a), a);
  assert.deepEqual(a.habits, []);
  a.settings.wakeTarget = '07:00';
  assert.equal(b.settings.wakeTarget, null);
});
test('calendar dates validate leap years and reject rollover', () => {
  assert.equal(isDateKey('2024-02-29'), true);
  for (const value of ['2025-02-29', '2026-04-31', '2026-13-01', '26-10-05', '2026-1-05', '1899-12-31', null]) assert.equal(isDateKey(value), false);
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(recentDates(3, '2026-10-05'), ['2026-10-03', '2026-10-04', '2026-10-05']);
  assert.deepEqual(recentDates(30, '1900-01-01'), ['1900-01-01']);
  assert.deepEqual(recentDates(7, '1900-01-02'), ['1900-01-01', '1900-01-02']);
  assert.throws(() => recentDates(0));
  assert.throws(() => localDateKey(new Date('invalid')));
});
test('local calendar semantics work across UTC boundary and DST', () => {
  const moduleUrl = new URL('../src/lib/domain.js', import.meta.url).href;
  const source = `import {localDateKey, addDays} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify([localDateKey(new Date('2026-10-04T22:30:00Z')),addDays('2026-03-08',1),addDays('2026-11-01',1)]));`;
  for (const [tz, expected] of [['Asia/Tokyo', '2026-10-05'], ['America/New_York', '2026-10-04']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [expected, '2026-03-09', '2026-11-02']);
  }
});
test('wake stores only exact daily HH:mm and upserts immutably', () => {
  const before = initial();
  const state = upsertWake(before, '2026-10-05', '07:15');
  assert.deepEqual(before.wake, {});
  assert.equal(upsertWake(state, '2026-10-05', '07:20').wake['2026-10-05'], '07:20');
  for (const time of ['7:15', '24:00', '07:60', '07:15:00', 435, null]) assert.throws(() => upsertWake(state, '2026-10-05', time));
  assert.throws(() => upsertWake(state, '2026-02-30', '07:00'));
  assert.equal(timeToMinutes('00:00'), 0);
  assert.equal(timeToMinutes('23:59'), 1439);
  assert.equal(minutesToTime(435), '07:15');
});
test('seven and thirty day wake stats exclude future and older dates', () => {
  const state = initial();
  state.wake = { '2026-09-07': '05:00', '2026-09-28': '04:00', '2026-09-29': '06:00', '2026-10-04': '07:00', '2026-10-05': '08:00', '2026-10-06': '23:00' };
  state.settings.wakeTarget = '07:00';
  assert.deepEqual(wakeStats(state, 7, '2026-10-05'), { count: 3, averageMinutes: 420, averageTime: '07:00', earliest: '06:00', latest: '08:00', streak: 2, onTimeCount: 2, targetRate: 2 / 3 });
  assert.equal(wakeStats(state, 30, '2026-10-05').count, 5);
  assert.equal(wakeStats(initial(), 7, '2026-10-05').averageTime, null);
});
test('streak handles today unfinished, breaks, future dates, and lower boundary', () => {
  assert.equal(streak(['2026-10-03', '2026-10-04'], '2026-10-05'), 2);
  assert.equal(streak(['2026-10-02', '2026-10-04', '2026-10-05', '2026-10-06'], '2026-10-05'), 2);
  assert.equal(streak(['2026-10-03'], '2026-10-05'), 0);
  assert.equal(streak([], '1900-01-01'), 0);
  assert.equal(streak(['1900-01-01'], '1900-01-01'), 1);
});
test('number and time habits keep zero, count thresholds, and keep past archived logs', () => {
  let state = withHabit('time', 20);
  state = upsertHabitLog(state, 'read', '2026-10-03', 0);
  state = upsertHabitLog(state, 'read', '2026-10-04', 20);
  state = upsertHabitLog(state, 'read', '2026-10-05', 30);
  assert.deepEqual(habitStats(state, 'read', 7, '2026-10-05'), { count: 3, completed: 2, total: 50, average: 50 / 3, streak: 2 });
  state.habits[0].archived = true;
  assert.equal(validateState(state).habitLogs.read['2026-10-03'], 0);
  assert.equal(habitStreak(state, 'missing', '2026-10-05'), 0);
  assert.equal(isHabitComplete({ type: 'number', target: null }, 1), true);
  assert.equal(isHabitComplete({ type: 'number', target: null }, 0), false);
});
test('check habit values must be booleans, numeric values must be finite nonnegative', () => {
  const checked = upsertHabitLog(withHabit(), 'read', '2026-10-05', true);
  assert.equal(habitStats(checked, 'read', 7, '2026-10-05').completed, 1);
  assert.throws(() => upsertHabitLog(withHabit(), 'read', '2026-10-05', 1));
  for (const value of [-1, Infinity, NaN, '20', null]) assert.throws(() => upsertHabitLog(withHabit('number', 1), 'read', '2026-10-05', value));
  assert.throws(() => upsertHabitLog(initial(), 'unknown', '2026-10-05', true));
});
test('backup round trips all fields and validation returns a deep detached copy', () => {
  const state = withHabit('time', 20);
  state.wake['2026-10-05'] = '06:30';
  state.habitLogs.read = { '2026-10-05': 25 };
  state.runs = [{ ...run(), points: [{ lat: 35, lon: 139, segment: 0, time: '2026-10-05T06:00:00+09:00' }] }];
  const canonical = validateState(state);
  const restored = parseBackup(serializeBackup(state));
  assert.deepEqual(restored, canonical);
  restored.runs[0].points[0].lat = 0;
  assert.equal(state.runs[0].points[0].lat, 35);
  assert.equal(canonical.runs[0].points[0].time, '2026-10-04T21:00:00.000Z');
});
test('backup rejects unknown versions, keys, duplicate identifiers and malformed full state', () => {
  rejected((s) => { s.version = 3; });
  rejected((s) => { s.settings.wakeTarget = '9:00'; });
  rejected((s) => { s.extra = 'surprise'; });
  rejected((s) => { s.runs = [run(), run()]; });
  rejected((s) => { s.habits = [withHabit().habits[0], withHabit().habits[0]]; });
  rejected((s) => { s.habitLogs = { missing: {} }; });
  assert.throws(() => parseBackup('{broken}'));
  assert.throws(() => parseBackup('[]'));
  assert.throws(() => parseBackup('{"version":1}'));
  assert.throws(() => parseBackup(' '.repeat(12 * 1024 * 1024 + 1)));
});
test('backup rejects prototype pollution keys at every user-keyed layer', () => {
  const source = serializeBackup(initial());
  assert.throws(() => parseBackup(source.replace('"wake": {}', '"wake": {"__proto__":{"polluted":true}}')));
  assert.throws(() => parseBackup(source.replace('"habitLogs": {}', '"habitLogs": {"constructor":{}}')));
  rejected((s) => { s.habits = [{ id: '__proto__', name: 'x', type: 'check' }]; });
  assert.equal({}.polluted, undefined);
});
test('notes and names are data, not HTML, and remain lossless for rendering through textContent', () => {
  const state = withHabit();
  state.habits[0].name = '<img src=x onerror=alert(1)>';
  state.runs = [{ ...run(), note: '<script>alert("x")</script>' }];
  assert.equal(parseBackup(serializeBackup(state)).runs[0].note, state.runs[0].note);
});
test('run validation rejects coercion, nonfinite data, invalid coordinates and unbounded input', () => {
  for (const patch of [ {distanceKm: 0}, {distanceKm:'5'}, {durationSec:0}, {durationSec:1.5}, {durationSec:NaN}, {date:'2026-02-29'}, {points:[{lat:91,lon:0}]}, {points:[{lat:0,lon:181}]}, {points:[{lat:0,lon:0,segment:-1}]}, {note:'x'.repeat(2001)} ]) {
    rejected((s) => { s.runs = [{ ...run(), ...patch }]; });
  }
  rejected((s) => { s.habits = [{ id: 'test', name: ' ', type: 'check' }]; });
  rejected((s) => { s.habits = [{ id: 'test', name: 'test', type: 'time', target: 0 }]; });
  rejected((s) => { s.habits = [{ id: 'test', name: 'test', type: 'time', target: null }]; });
});
test('formatters handle long times, pace rounding and unset data', () => {
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(formatPace(5, 1800), '6:00');
  assert.equal(formatPace(0, 100), '—');
  assert.equal(formatDuration(NaN), '—');
  assert.match(makeId(), /^[A-Za-z0-9_-]{1,100}$/);
});
test('storage loads, validates, and saves without leaking exceptions', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.deepEqual(readState(storage), { ok: true, state: initial() });
  const state = upsertWake(initial(), '2026-10-05', '07:00');
  assert.deepEqual(writeState(state, storage), { ok: true });
  assert.deepEqual(readState(storage).state, state);
  values.set(STORAGE_KEY, '{broken');
  assert.equal(readState(storage).ok, false);
  assert.equal(values.get(STORAGE_KEY), '{broken');
  assert.equal(writeState({version: 2}, storage).ok, false);
  assert.equal(values.get(STORAGE_KEY), '{broken');
});
test('storage quota/security failures are returned for visible UI handling', () => {
  const storage = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  assert.equal(readState(storage).error, 'SecurityError');
  assert.equal(writeState(initial(), storage).error, 'QuotaExceededError');
});

test('backup limit measures UTF-8 bytes, including multibyte JSON', () => {
  assert.throws(() => parseBackup('あ'.repeat(5 * 1024 * 1024)), /12MiB/);
});

test('habit target minimum matches the editable UI contract', () => {
  const state = createInitialState();
  state.habits = [{id:'minimum', name:'読書', type:'number', unit:'ページ', target:0.001, archived:false}];
  assert.equal(validateState(state).habits[0].target,0.001);
  state.habits[0].target = 0.0001;
  assert.throws(() => validateState(state));
});
