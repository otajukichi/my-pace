/** Pure, dependency-free domain rules. Calendar keys always use the device's local day. */
export const STATE_VERSION = 2;
export const LIMITS = Object.freeze({
  backupChars: 12 * 1024 * 1024,
  backupBytes: 12 * 1024 * 1024,
  wakeDays: 36600,
  habits: 100,
  habitDays: 100000,
  runs: 5000,
  pointsPerRun: 20000,
  totalPoints: 100000,
  events: 20000,
  eventTitle: 120,
  eventNote: 2000,
  diaryDays: 36600,
  diaryText: 8000,
});
export const DIARY_MOODS = Object.freeze(['bright', 'calm', 'tired', 'low']);
export const GARDEN_PLANTS = Object.freeze([
  Object.freeze({ id: 'cosmos', label: 'コスモス', unlockAt: 0 }),
  Object.freeze({ id: 'sunflower', label: 'ひまわり', unlockAt: 7 }),
  Object.freeze({ id: 'hydrangea', label: 'あじさい', unlockAt: 21 }),
]);
export const GARDEN_THEMES = Object.freeze([
  Object.freeze({ id: 'day', label: '昼の庭' }),
  Object.freeze({ id: 'dusk', label: '夕暮れの庭' }),
  Object.freeze({ id: 'night', label: '夜の庭' }),
]);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DATE_RE = /^(19\d{2}|20\d{2}|21\d{2}|2200)-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const pad = (n) => String(n).padStart(2, '0');
const fail = (message) => { throw new Error(message); };
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function createInitialState() {
  return { version: STATE_VERSION, settings: { wakeTarget: null }, wake: {}, runs: [], habits: [], habitLogs: {},
    events: [], diary: {}, garden: { plant: 'cosmos', theme: 'day' } };
}

export function isDateKey(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  const date = new Date(y, m - 1, d, 12);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

export function localDateKey(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail('日付が正しくありません。');
  const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (!isDateKey(key)) fail('日付は1900〜2200年の範囲で入力してください。');
  return key;
}
export const dateKey = localDateKey;
export const todayKey = () => localDateKey();

export function addDays(key, count) {
  if (!isDateKey(key) || !Number.isInteger(count) || Math.abs(count) > 36600) fail('日付の計算ができません。');
  const [year, month, day] = key.split('-').map(Number);
  // Noon avoids DST midnight transitions; setDate advances a calendar day, not 24 hours.
  const date = new Date(year, month - 1, day, 12);
  date.setDate(date.getDate() + count);
  return localDateKey(date);
}

export function trailingDateKeys(days, anchor = todayKey()) {
  if (!Number.isInteger(days) || days < 1 || days > 36600 || !isDateKey(anchor)) fail('集計期間が正しくありません。');
  const result = [anchor];
  while (result.length < days && result[0] !== '1900-01-01') result.unshift(addDays(result[0], -1));
  return result;
}
export const recentDates = trailingDateKeys;

export function timeToMinutes(time) {
  const match = typeof time === 'string' && TIME_RE.exec(time);
  if (!match) fail('時刻はHH:mm形式で入力してください。');
  return Number(match[1]) * 60 + Number(match[2]);
}
export function minutesToTime(minutes) {
  if (!Number.isFinite(minutes)) return '—';
  const value = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds), hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60), remaining = total % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(remaining)}` : `${minutes}:${pad(remaining)}`;
}
export function formatPace(distanceKm, durationSec) {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0 || !Number.isFinite(durationSec) || durationSec <= 0) return '—';
  return formatDuration(durationSec / distanceKm);
}
export function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function record(value, path, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path}の形式が正しくありません。`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(`${path}の形式が正しくありません。`);
  for (const key of Object.keys(value)) {
    if (BAD_KEYS.has(key) || (allowed && !allowed.includes(key))) fail(`${path}に未対応の項目があります。`);
  }
  return value;
}
function list(value, maximum, path) {
  if (!Array.isArray(value) || value.length > maximum) fail(`${path}の件数または形式が正しくありません。`);
  return value;
}
function text(value, max, path, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) fail(`${path}が正しくありません。`);
  return value;
}
// Journal limits count Unicode code points, so an emoji gets the same capacity as a Japanese character.
function journalText(value, max, path, allowEmpty = true) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) fail(`${path}が正しくありません。`);
  let count = 0;
  for (const character of value) {
    if (++count > max) fail(`${path}が正しくありません。`);
  }
  return value;
}
function identifier(value, path) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value) || BAD_KEYS.has(value)) fail(`${path}が正しくありません。`);
  return value;
}
function number(value, min, max, path, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`${path}が正しくありません。`);
  return value;
}
function date(value, path) {
  if (!isDateKey(value)) fail(`${path}が正しくありません。`);
  return value;
}
function time(value, path) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) fail(`${path}が正しくありません。`);
  return value;
}

/** Validate the complete object before replacing data. Returns a detached canonical copy. */
export function validateState(raw) {
  record(raw, 'バックアップ');
  if (raw.version !== 1 && raw.version !== STATE_VERSION) fail('このバックアップのバージョンには対応していません。');
  const legacy = raw.version === 1;
  record(raw, 'バックアップ', ['version', 'settings', 'wake', 'runs', 'habits', 'habitLogs',
    ...(legacy ? [] : ['events', 'diary', 'garden'])]);
  record(raw.settings, '設定', ['wakeTarget']);
  const output = createInitialState();
  output.settings.wakeTarget = raw.settings.wakeTarget === null ? null : time(raw.settings.wakeTarget, '目標時刻');
  record(raw.wake, '起床記録');
  if (Object.keys(raw.wake).length > LIMITS.wakeDays) fail('起床記録の件数が多すぎます。');
  for (const [key, value] of Object.entries(raw.wake)) output.wake[date(key, '起床日')] = time(value, '起床時刻');
  const habitIds = new Set();
  output.habits = list(raw.habits, LIMITS.habits, '習慣').map((item) => {
    record(item, '習慣', ['id', 'name', 'type', 'unit', 'target', 'archived']);
    const id = identifier(item.id, '習慣ID');
    if (habitIds.has(id)) fail('習慣IDが重複しています。');
    habitIds.add(id);
    if (!['check', 'number', 'time'].includes(item.type)) fail('習慣の種類が正しくありません。');
    if (item.archived !== undefined && typeof item.archived !== 'boolean') fail('習慣の非表示設定が正しくありません。');
    let target = item.target ?? null;
    if (item.type === 'check') {
      if (target !== null && target !== 1) fail('チェック習慣の目標が正しくありません。');
      target = 1;
    } else number(target, 0.001, 1000000, '習慣の目標');
    return { id, name: text(item.name, 80, '習慣名', false), type: item.type,
      unit: text(item.unit ?? (item.type === 'time' ? '分' : ''), 20, '単位'), target, archived: item.archived ?? false };
  });
  record(raw.habitLogs, '習慣記録');
  const definitions = new Map(output.habits.map((habit) => [habit.id, habit]));
  let logCount = 0;
  for (const [id, logs] of Object.entries(raw.habitLogs)) {
    identifier(id, '習慣ID');
    if (!definitions.has(id)) fail('存在しない習慣の記録が含まれています。');
    record(logs, '日々の習慣記録');
    output.habitLogs[id] = {};
    for (const [key, value] of Object.entries(logs)) {
      if (++logCount > LIMITS.habitDays) fail('習慣記録の件数が多すぎます。');
      date(key, '習慣の記録日');
      if (definitions.get(id).type === 'check') {
        if (typeof value !== 'boolean') fail('チェックの記録は真偽値にしてください。');
      } else number(value, 0, 1000000, '習慣の記録');
      output.habitLogs[id][key] = value;
    }
  }
  const runIds = new Set();
  let pointCount = 0;
  output.runs = list(raw.runs, LIMITS.runs, 'ランニング記録').map((item) => {
    record(item, 'ランニング記録', ['id', 'date', 'distanceKm', 'durationSec', 'note', 'points']);
    const id = identifier(item.id, 'ランニングID');
    if (runIds.has(id)) fail('ランニングIDが重複しています。');
    runIds.add(id);
    const points = list(item.points ?? [], LIMITS.pointsPerRun, 'ルート').map((point) => {
      if (++pointCount > LIMITS.totalPoints) fail('ルートの合計点数が多すぎます。');
      record(point, 'ルートの座標', ['lat', 'lon', 'segment', 'time']);
      const copy = { lat: number(point.lat, -90, 90, '緯度'), lon: number(point.lon, -180, 180, '経度'),
        segment: number(point.segment ?? 0, 0, LIMITS.pointsPerRun, '区間', true) };
      if (point.time !== undefined) {
        if (typeof point.time !== 'string' || point.time.length > 40 || !Number.isFinite(Date.parse(point.time))) fail('ルートの時刻が正しくありません。');
        copy.time = new Date(point.time).toISOString();
      }
      return copy;
    });
    return { id, date: date(item.date, 'ランニング日'), distanceKm: number(item.distanceKm, 0.001, 10000, '距離'),
      durationSec: number(item.durationSec, 1, 31 * 24 * 3600, '所要時間', true), note: text(item.note ?? '', 2000, 'メモ'), points };
  });
  if (!legacy) {
    const eventIds = new Set();
    output.events = list(raw.events, LIMITS.events, '予定').map((item) => {
      record(item, '予定', ['id', 'date', 'time', 'title', 'note']);
      const id = identifier(item.id, '予定ID');
      if (eventIds.has(id)) fail('予定IDが重複しています。');
      eventIds.add(id);
      return { id, date: date(item.date, '予定の日付'),
        time: item.time == null ? null : time(item.time, '予定の時刻'),
        title: journalText(item.title, LIMITS.eventTitle, '予定のタイトル', false),
        note: journalText(item.note ?? '', LIMITS.eventNote, '予定のメモ') };
    });
    record(raw.diary, '日記');
    if (Object.keys(raw.diary).length > LIMITS.diaryDays) fail('日記の件数が多すぎます。');
    for (const [key, entry] of Object.entries(raw.diary)) {
      date(key, '日記の日付');
      record(entry, '日記', ['text', 'mood']);
      if (entry.mood != null && !DIARY_MOODS.includes(entry.mood)) fail('日記の気分が正しくありません。');
      output.diary[key] = { text: journalText(entry.text, LIMITS.diaryText, '日記の本文'), mood: entry.mood ?? null };
    }
    record(raw.garden, '庭の設定', ['plant', 'theme']);
    if (!GARDEN_PLANTS.some((item) => item.id === raw.garden.plant)) fail('庭の植物が正しくありません。');
    if (!GARDEN_THEMES.some((item) => item.id === raw.garden.theme)) fail('庭のテーマが正しくありません。');
    // Selection is retained even after deleting an earning record. Visibility is derived separately.
    output.garden = { plant: raw.garden.plant, theme: raw.garden.theme };
  }
  return output;
}

export function parseBackup(json) {
  if (typeof json !== 'string' || json.length > LIMITS.backupChars || new TextEncoder().encode(json).byteLength > LIMITS.backupBytes) fail('バックアップは12MiB以下のJSONにしてください。');
  let parsed;
  try { parsed = JSON.parse(json); } catch { fail('JSONファイルを読み取れませんでした。'); }
  return validateState(parsed);
}
export function serializeBackup(state) {
  const result = JSON.stringify(validateState(state), null, 2);
  if (result.length > LIMITS.backupChars || new TextEncoder().encode(result).byteLength > LIMITS.backupBytes) fail('バックアップの容量が12MiBを超えています。');
  return result;
}

/** Current streak includes today when completed, otherwise allows yesterday. Future keys are ignored. */
export function streak(dates, anchor = todayKey()) {
  if (!isDateKey(anchor)) fail('基準日が正しくありません。');
  const completed = new Set(Array.isArray(dates) || dates instanceof Set ? dates : Object.keys(dates ?? {}));
  let cursor = anchor;
  if (!completed.has(cursor)) {
    if (cursor === '1900-01-01') return 0;
    cursor = addDays(cursor, -1);
  }
  let count = 0;
  while (completed.has(cursor)) {
    count++;
    if (cursor === '1900-01-01' || count >= LIMITS.wakeDays) break;
    cursor = addDays(cursor, -1);
  }
  return count;
}
export function wakeStreak(state, anchor = todayKey()) { return streak(Object.keys(state.wake), anchor); }
export function wakeStats(state, days = 7, anchor = todayKey()) {
  const values = recentDates(days, anchor).filter((key) => has(state.wake, key)).map((key) => timeToMinutes(state.wake[key]));
  const averageMinutes = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const target = state.settings.wakeTarget == null ? null : timeToMinutes(state.settings.wakeTarget);
  const onTimeCount = target === null ? null : values.filter((value) => value <= target).length;
  return { count: values.length, averageMinutes, averageTime: averageMinutes === null ? null : minutesToTime(averageMinutes),
    earliest: values.length ? minutesToTime(Math.min(...values)) : null, latest: values.length ? minutesToTime(Math.max(...values)) : null,
    streak: wakeStreak(state, anchor), onTimeCount, targetRate: values.length && target !== null ? onTimeCount / values.length : null };
}
export function isHabitComplete(habit, value) {
  if (habit.type === 'check') return value === true;
  return typeof value === 'number' && Number.isFinite(value) && (habit.target == null ? value > 0 : value >= habit.target);
}
export function habitStreak(state, habitId, anchor = todayKey()) {
  const habit = state.habits.find((item) => item.id === habitId);
  if (!habit) return 0;
  return streak(Object.entries(state.habitLogs[habitId] ?? {}).filter(([, value]) => isHabitComplete(habit, value)).map(([key]) => key), anchor);
}
export function habitStats(state, habitId, days = 7, anchor = todayKey()) {
  const habit = state.habits.find((item) => item.id === habitId);
  if (!habit) fail('習慣が見つかりません。');
  const logs = state.habitLogs[habitId] ?? {};
  const values = recentDates(days, anchor).filter((key) => has(logs, key)).map((key) => logs[key]);
  const total = values.reduce((sum, value) => sum + Number(value), 0);
  return { count: values.length, completed: values.filter((value) => isHabitComplete(habit, value)).length,
    total, average: values.length ? total / values.length : null, streak: habitStreak(state, habitId, anchor) };
}
export function upsertWake(state, key, value) {
  return validateState({ ...state, wake: { ...state.wake, [key]: value } });
}
export function upsertHabitLog(state, habitId, key, value) {
  return validateState({ ...state, habitLogs: { ...state.habitLogs, [habitId]: { ...state.habitLogs[habitId], [key]: value } } });
}

/** Immutable journal edits always pass the same strict validation as backup imports. */
export function upsertEvent(state, event) {
  const current = validateState(state);
  return validateState({ ...current, events: [...current.events.filter((item) => item.id !== event?.id), event] });
}
export function removeEvent(state, id) {
  identifier(id, '予定ID');
  const current = validateState(state);
  return validateState({ ...current, events: current.events.filter((item) => item.id !== id) });
}
export function upsertDiary(state, key, entry) {
  date(key, '日記の日付');
  const current = validateState(state);
  return validateState({ ...current, diary: { ...current.diary, [key]: entry } });
}
export function removeDiary(state, key) {
  date(key, '日記の日付');
  const current = validateState(state);
  delete current.diary[key];
  return current;
}
