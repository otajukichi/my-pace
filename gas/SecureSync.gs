// Local-only candidate. One owner-authorized Apps Script writer.
var MyPaceSecureSync=(function(){
"use strict";
const m0=(function(){
/** Pure, dependency-free domain rules. Calendar keys always use the device's local day. */
const STATE_VERSION = 2;
const LIMITS = Object.freeze({
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
const DIARY_MOODS = Object.freeze(['bright', 'calm', 'tired', 'low']);
const GARDEN_PLANTS = Object.freeze([
  Object.freeze({ id: 'cosmos', label: 'コスモス', unlockAt: 0 }),
  Object.freeze({ id: 'sunflower', label: 'ひまわり', unlockAt: 7 }),
  Object.freeze({ id: 'hydrangea', label: 'あじさい', unlockAt: 21 }),
]);
const GARDEN_THEMES = Object.freeze([
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

function createInitialState() {
  return { version: STATE_VERSION, settings: { wakeTarget: null }, wake: {}, runs: [], habits: [], habitLogs: {},
    events: [], diary: {}, garden: { plant: 'cosmos', theme: 'day' } };
}

function isDateKey(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  const date = new Date(y, m - 1, d, 12);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function localDateKey(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail('日付が正しくありません。');
  const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (!isDateKey(key)) fail('日付は1900〜2200年の範囲で入力してください。');
  return key;
}
const dateKey = localDateKey;
const todayKey = () => localDateKey();

function addDays(key, count) {
  if (!isDateKey(key) || !Number.isInteger(count) || Math.abs(count) > 36600) fail('日付の計算ができません。');
  const [year, month, day] = key.split('-').map(Number);
  // Noon avoids DST midnight transitions; setDate advances a calendar day, not 24 hours.
  const date = new Date(year, month - 1, day, 12);
  date.setDate(date.getDate() + count);
  return localDateKey(date);
}

function trailingDateKeys(days, anchor = todayKey()) {
  if (!Number.isInteger(days) || days < 1 || days > 36600 || !isDateKey(anchor)) fail('集計期間が正しくありません。');
  const result = [anchor];
  while (result.length < days && result[0] !== '1900-01-01') result.unshift(addDays(result[0], -1));
  return result;
}
const recentDates = trailingDateKeys;

function timeToMinutes(time) {
  const match = typeof time === 'string' && TIME_RE.exec(time);
  if (!match) fail('時刻はHH:mm形式で入力してください。');
  return Number(match[1]) * 60 + Number(match[2]);
}
function minutesToTime(minutes) {
  if (!Number.isFinite(minutes)) return '—';
  const value = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds), hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60), remaining = total % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(remaining)}` : `${minutes}:${pad(remaining)}`;
}
function formatPace(distanceKm, durationSec) {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0 || !Number.isFinite(durationSec) || durationSec <= 0) return '—';
  return formatDuration(durationSec / distanceKm);
}
function makeId() {
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
function validateState(raw) {
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

// UTF-8 length with the same lone-surrogate replacement behavior as TextEncoder.
// Pure ECMAScript: Apps Script has no browser Encoding API.
function utf8ByteLength(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
             text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

function parseBackup(json) {
  if (typeof json !== 'string' || json.length > LIMITS.backupChars || utf8ByteLength(json) > LIMITS.backupBytes) fail('バックアップは12MiB以下のJSONにしてください。');
  let parsed;
  try { parsed = JSON.parse(json); } catch { fail('JSONファイルを読み取れませんでした。'); }
  return validateState(parsed);
}
function serializeBackup(state) {
  const result = JSON.stringify(validateState(state), null, 2);
  if (result.length > LIMITS.backupChars || utf8ByteLength(result) > LIMITS.backupBytes) fail('バックアップの容量が12MiBを超えています。');
  return result;
}

/** Current streak includes today when completed, otherwise allows yesterday. Future keys are ignored. */
function streak(dates, anchor = todayKey()) {
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
function wakeStreak(state, anchor = todayKey()) { return streak(Object.keys(state.wake), anchor); }
function wakeStats(state, days = 7, anchor = todayKey()) {
  const values = recentDates(days, anchor).filter((key) => has(state.wake, key)).map((key) => timeToMinutes(state.wake[key]));
  const averageMinutes = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const target = state.settings.wakeTarget == null ? null : timeToMinutes(state.settings.wakeTarget);
  const onTimeCount = target === null ? null : values.filter((value) => value <= target).length;
  return { count: values.length, averageMinutes, averageTime: averageMinutes === null ? null : minutesToTime(averageMinutes),
    earliest: values.length ? minutesToTime(Math.min(...values)) : null, latest: values.length ? minutesToTime(Math.max(...values)) : null,
    streak: wakeStreak(state, anchor), onTimeCount, targetRate: values.length && target !== null ? onTimeCount / values.length : null };
}
function isHabitComplete(habit, value) {
  if (habit.type === 'check') return value === true;
  return typeof value === 'number' && Number.isFinite(value) && (habit.target == null ? value > 0 : value >= habit.target);
}
function habitStreak(state, habitId, anchor = todayKey()) {
  const habit = state.habits.find((item) => item.id === habitId);
  if (!habit) return 0;
  return streak(Object.entries(state.habitLogs[habitId] ?? {}).filter(([, value]) => isHabitComplete(habit, value)).map(([key]) => key), anchor);
}
function habitStats(state, habitId, days = 7, anchor = todayKey()) {
  const habit = state.habits.find((item) => item.id === habitId);
  if (!habit) fail('習慣が見つかりません。');
  const logs = state.habitLogs[habitId] ?? {};
  const values = recentDates(days, anchor).filter((key) => has(logs, key)).map((key) => logs[key]);
  const total = values.reduce((sum, value) => sum + Number(value), 0);
  return { count: values.length, completed: values.filter((value) => isHabitComplete(habit, value)).length,
    total, average: values.length ? total / values.length : null, streak: habitStreak(state, habitId, anchor) };
}
function upsertWake(state, key, value) {
  return validateState({ ...state, wake: { ...state.wake, [key]: value } });
}
function upsertHabitLog(state, habitId, key, value) {
  return validateState({ ...state, habitLogs: { ...state.habitLogs, [habitId]: { ...state.habitLogs[habitId], [key]: value } } });
}

/** Immutable journal edits always pass the same strict validation as backup imports. */
function upsertEvent(state, event) {
  const current = validateState(state);
  return validateState({ ...current, events: [...current.events.filter((item) => item.id !== event?.id), event] });
}
function removeEvent(state, id) {
  identifier(id, '予定ID');
  const current = validateState(state);
  return validateState({ ...current, events: current.events.filter((item) => item.id !== id) });
}
function upsertDiary(state, key, entry) {
  date(key, '日記の日付');
  const current = validateState(state);
  return validateState({ ...current, diary: { ...current.diary, [key]: entry } });
}
function removeDiary(state, key) {
  date(key, '日記の日付');
  const current = validateState(state);
  delete current.diary[key];
  return current;
}

return {STATE_VERSION,LIMITS,DIARY_MOODS,GARDEN_PLANTS,GARDEN_THEMES,createInitialState,isDateKey,localDateKey,dateKey,todayKey,addDays,trailingDateKeys,recentDates,timeToMinutes,minutesToTime,formatDuration,formatPace,makeId,validateState,utf8ByteLength,parseBackup,serializeBackup,streak,wakeStreak,wakeStats,isHabitComplete,habitStreak,habitStats,upsertWake,upsertHabitLog,upsertEvent,removeEvent,upsertDiary,removeDiary};})();
const m1=(function(){
const {createInitialState,validateState,isDateKey}=m0;
const clone=x=>JSON.parse(JSON.stringify(x));
function canonical(x){if(x===null||typeof x==='boolean'||typeof x==='string')return JSON.stringify(x);if(typeof x==='number'&&Number.isFinite(x))return JSON.stringify(x);if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';if(x&&typeof x==='object'&&Object.getPrototypeOf(x)===Object.prototype)return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';throw Error('INVALID_JSON');}
function parseKey(key){
 if(typeof key!=='string'||key.length>240)throw Error('ENTITY_KEY_INVALID');
 const [kind,id,date,...rest]=key.split(':');if(rest.length)throw Error('ENTITY_KEY_INVALID');
 if(['wake','diary'].includes(kind)&&isDateKey(id)&&date===undefined)return {kind,id};
 if(['run','habit','event'].includes(kind)&&typeof id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(id)&&!['constructor','prototype','__proto__'].includes(id)&&date===undefined)return {kind,id};
 if(kind==='habitLog'&&typeof id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(id)&&!['constructor','prototype','__proto__'].includes(id)&&isDateKey(date))return {kind,id,date};
 if((kind==='settings'&&id==='wakeTarget'||kind==='garden'&&id==='preferences')&&date===undefined)return {kind,id};
 throw Error('ENTITY_KEY_INVALID');
}
function stateToEntities(raw){const s=validateState(raw),out={};for(const [d,v] of Object.entries(s.wake))out['wake:'+d]=v;for(const k of ['run','habit','event'])for(const v of s[k==='run'?'runs':k==='habit'?'habits':'events'])out[k+':'+v.id]=v;for(const [id,days] of Object.entries(s.habitLogs))for(const [d,v]of Object.entries(days))out['habitLog:'+id+':'+d]=v;for(const [d,v]of Object.entries(s.diary))out['diary:'+d]=v;out['settings:wakeTarget']=s.settings.wakeTarget;out['garden:preferences']=s.garden;return out;}
function entitiesToState(entities){const s=createInitialState();for(const [key,value]of Object.entries(entities)){const {kind,id,date}=parseKey(key);if(kind==='wake'||kind==='diary')s[kind][id]=clone(value);else if(kind==='run'||kind==='habit'||kind==='event')s[kind==='run'?'runs':kind==='habit'?'habits':'events'].push(clone(value));else if(kind==='habitLog'){if(!Object.prototype.hasOwnProperty.call(s.habitLogs,id))s.habitLogs[id]={};s.habitLogs[id][date]=value;}else if(kind==='settings')s.settings.wakeTarget=value;else s.garden=clone(value);}for(const id of Object.keys(s.habitLogs))if(!s.habits.some(h=>h.id===id))delete s.habitLogs[id];return validateState(s);}
function validateEntity(key,value,habit){const p=parseKey(key),s=createInitialState();if(p.kind==='habitLog'){s.habits=[habit];s.habitLogs[p.id]={[p.date]:value};}else if(p.kind==='wake'||p.kind==='diary')s[p.kind][p.id]=value;else if(p.kind==='run'||p.kind==='habit'||p.kind==='event'){if(value?.id!==p.id)throw Error('ENTITY_ID_MISMATCH');s[p.kind==='run'?'runs':p.kind==='habit'?'habits':'events']=[value];}else if(p.kind==='settings')s.settings.wakeTarget=value;else s.garden=value;return stateToEntities(s)[key];}
function diffEntities(before,after){const a=stateToEntities(before),b=stateToEntities(after);return [...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>canonical(a[k]===undefined?null:a[k])!==canonical(b[k]===undefined?null:b[k])||Object.prototype.hasOwnProperty.call(a,k)!==Object.prototype.hasOwnProperty.call(b,k)).map(key=>({key,deleted:!Object.prototype.hasOwnProperty.call(b,key),value:Object.prototype.hasOwnProperty.call(b,key)?b[key]:null}));}

return {clone,canonical,parseKey,stateToEntities,entitiesToState,validateEntity,diffEntities};})();
const m2=(function(){
// Shared data contract. This module performs no IO and never activates a store.
const SYNC_APP_CHANGE_HEAD='app/change-head';
const SYNC_APP_CHANGE_CAPACITY=1024;
function syncAppChangeSlot(seq){return 'app/change-slot/'+(seq%SYNC_APP_CHANGE_CAPACITY);}
function initialSyncAppChangeHead(){return {protocol:2,seq:0,floor:1,capacity:SYNC_APP_CHANGE_CAPACITY};}
function validateSyncAppChangeHead(entity){
 const fail=()=>{const e=Error('APP_JOURNAL_CORRUPT');e.code=e.message;throw e;};
 if(!entity||entity.deleted)fail();const h=entity.value;
 if(!h||typeof h!=='object'||Array.isArray(h)||Object.keys(h).sort().join(',')!=='capacity,floor,protocol,seq'||h.protocol!==2||!Number.isSafeInteger(h.seq)||h.seq<0||h.capacity!==SYNC_APP_CHANGE_CAPACITY||h.floor!==Math.max(1,h.seq-SYNC_APP_CHANGE_CAPACITY+1))fail();
 return h;
}

return {SYNC_APP_CHANGE_HEAD,SYNC_APP_CHANGE_CAPACITY,syncAppChangeSlot,initialSyncAppChangeHead,validateSyncAppChangeHead};})();
const m3=(function(){
/**
 * Resumable application-command expansion over an engine-verified immutable
 * parent. The engine owns authentication, receipt-first replay, parent/root
 * validation, durable cursor publication and the final reserved-slot commit.
 *
 * Each advance performs at most one derived-key entity lookup. Cursor state is
 * compact metadata only: the original command is retained once by the engine,
 * and large ordinary values are normalized again locally when expansion ends.
 */
const {canonical,parseKey,validateEntity}=m1;
const {utf8ByteLength}=m0;
const {SYNC_APP_CHANGE_HEAD,SYNC_APP_CHANGE_CAPACITY,syncAppChangeSlot,validateSyncAppChangeHead}=m2;

const HEAD='app/catalog/head',KIND='mypace-prepared-app-command',VERSION=1;
const PHASES=['validate','business','parent','catalog-node','catalog-head','journal-head','journal-slot','ready'];
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===keys.split(',').sort().join(',');
const integer=value=>Number.isSafeInteger(value)&&value>=0;
// The writer authenticates the digest against the exact descriptor command.
// A cursor never carries or re-hashes a duplicate large application value.
const identity=value=>typeof value==='string'&&/^[-A-Za-z0-9_]{1,128}$/.test(value);
const fail=code=>{const error=Error(code);error.code=code;throw error;};
const rejected=error=>({kind:'rejected',error});
const valueError=error=>/^[A-Z][A-Z0-9_]{1,80}$/.test(error?.code||error?.message)?error.code||error.message:'VALIDATION_FAILED';
const copy=value=>JSON.parse(canonical(value));

function checkedEntity(entity,key,code){
 if(entity===null||entity===undefined)return null;
 if(!exact(entity,'key,version,deleted,value')||entity.key!==key||!Number.isSafeInteger(entity.version)||entity.version<1||typeof entity.deleted!=='boolean'||entity.deleted&&entity.value!==null)fail(code);
 return entity;
}
function checkedDomainKey(key,code){try{parseKey(key);}catch{fail(code);}return key;}

function createPreparedAppCommand({command,digest,base}={}){
 if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest)||!exact(base,'storeId,datasetGeneration,acceptedEpochs,writerFence')||!identity(base.storeId)||!identity(base.datasetGeneration)||!Array.isArray(base.acceptedEpochs)||base.acceptedEpochs.length<1||base.acceptedEpochs.length>4||!base.acceptedEpochs.every(identity)||new Set(base.acceptedEpochs).size!==base.acceptedEpochs.length||![0,2].includes(base.writerFence))fail('APP_PREPARATION_CONFIG_INVALID');
 const boundBase=copy(base),binding=canonical(boundBase);let c,commandError,parsed;
 try{c=copy(command);}catch(error){commandError=valueError(error);}
 if(!commandError){
  if(!exact(c,'operationId,epoch,generation,store,key,expectedVersion,deleted,value,recreate')||typeof c.operationId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(c.operationId)||typeof c.epoch!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(c.epoch)||typeof c.store!=='string'||typeof c.generation!=='string'||!integer(c.expectedVersion)||typeof c.deleted!=='boolean'||typeof c.recreate!=='boolean')commandError='COMMAND_INVALID';
  else try{parsed=parseKey(c.key);}catch(error){commandError=valueError(error);}
 }
 const initialState=()=>({kind:KIND,version:VERSION,digest,binding,phase:'validate',business:null,catalog:null,journal:null,logValue:null});
 function checkState(state){
  if(!exact(state,'kind,version,digest,binding,phase,business,catalog,journal,logValue')||state.kind!==KIND||state.version!==VERSION||state.digest!==digest||state.binding!==binding||!PHASES.includes(state.phase))fail('APP_PREPARATION_STATE_INVALID');
  if(commandError&&state.phase!=='validate')fail('APP_PREPARATION_STATE_INVALID');
  const business=state.business,catalog=state.catalog,journal=state.journal;
  if(business!==null&&(!exact(business,'exists,version')||typeof business.exists!=='boolean'||!integer(business.version)||business.exists!==(business.version>0)||business.version!==c.expectedVersion))fail('APP_PREPARATION_STATE_INVALID');
  if(['validate','business'].includes(state.phase)?business!==null:business===null)fail('APP_PREPARATION_STATE_INVALID');
  if(catalog!==null&&(!exact(catalog,'nodeChecked,headVersion,first')||catalog.nodeChecked!==true||!(catalog.headVersion===null||integer(catalog.headVersion))||!(catalog.first===null||typeof catalog.first==='string')))fail('APP_PREPARATION_STATE_INVALID');
  if(catalog?.first!==null&&catalog?.first!==undefined)checkedDomainKey(catalog.first,'APP_PREPARATION_STATE_INVALID');
  if(catalog!==null&&business?.exists!==false)fail('APP_PREPARATION_STATE_INVALID');
  if(journal!==null&&(!exact(journal,'headVersion,seq,slotVersion')||!Number.isSafeInteger(journal.headVersion)||journal.headVersion<1||!Number.isSafeInteger(journal.seq)||journal.seq<1||!(journal.slotVersion===null||integer(journal.slotVersion))))fail('APP_PREPARATION_STATE_INVALID');
  if(journal!==null&&boundBase.writerFence!==2)fail('APP_PREPARATION_STATE_INVALID');
  const scalar=typeof state.logValue==='boolean'||typeof state.logValue==='number'&&Number.isFinite(state.logValue)&&state.logValue>=0&&state.logValue<=1000000;
  if(state.logValue!==null&&(!scalar||parsed?.kind!=='habitLog'||c.deleted||state.logValue!==c.value))fail('APP_PREPARATION_STATE_INVALID');
  if(['validate','business','parent'].includes(state.phase)&&state.logValue!==null)fail('APP_PREPARATION_STATE_INVALID');
  if(!['validate','business','parent'].includes(state.phase)&&parsed?.kind==='habitLog'&&!c.deleted&&!scalar)fail('APP_PREPARATION_STATE_INVALID');
  if(['validate','business','parent','catalog-node'].includes(state.phase)&&catalog!==null)fail('APP_PREPARATION_STATE_INVALID');
  if(['validate','business','parent','catalog-node','catalog-head','journal-head'].includes(state.phase)&&journal!==null)fail('APP_PREPARATION_STATE_INVALID');
  if(state.phase==='parent'&&(parsed?.kind!=='habitLog'||c.deleted)||['catalog-node','catalog-head'].includes(state.phase)&&business?.exists!==false)fail('APP_PREPARATION_STATE_INVALID');
  if(state.phase==='catalog-head'&&(!catalog||catalog.headVersion!==null||catalog.first!==null))fail('APP_PREPARATION_STATE_INVALID');
  if(['journal-head','journal-slot','ready'].includes(state.phase)&&business?.exists===false&&(!catalog||!integer(catalog.headVersion)))fail('APP_PREPARATION_STATE_INVALID');
  if(state.phase==='journal-head'&&journal!==null||state.phase==='journal-slot'&&(!journal||journal.slotVersion!==null))fail('APP_PREPARATION_STATE_INVALID');
  if(['journal-head','journal-slot'].includes(state.phase)&&boundBase.writerFence!==2)fail('APP_PREPARATION_STATE_INVALID');
  if(catalog&&catalog.first===c?.key)fail('APP_PREPARATION_STATE_INVALID');
  if(state.phase==='ready'&&boundBase.writerFence===2&&(!journal||!integer(journal.slotVersion)))fail('APP_PREPARATION_STATE_INVALID');
  return copy(state);
 }
 const progress=(state,phase,patch={})=>({kind:'progress',state:{...state,...patch,phase}});
 const afterValue=state=>state.business.exists?(boundBase.writerFence===2?'journal-head':'ready'):'catalog-node';
 const afterCatalog=()=>boundBase.writerFence===2?'journal-head':'ready';
 function normalize(habit){try{const value=validateEntity(c.key,c.value,habit);if(utf8ByteLength(canonical(value))>128*1024)return {error:'WRITER_VALUE_TOO_LARGE'};return {value};}catch(error){return {error:valueError(error)};}}
 function ready(state){
  let value=null;
  if(!c.deleted){if(parsed.kind==='habitLog')value=state.logValue;else{const normalized=normalize();if(normalized.error)return rejected(normalized.error);value=normalized.value;}}
  const changes=[{key:'app/data/'+c.key,expectedVersion:c.expectedVersion,deleted:c.deleted,value,...(c.recreate?{recreate:true}:{})}];
  if(!state.business.exists){changes.push({key:'app/catalog/'+c.key,expectedVersion:0,value:{key:c.key,next:state.catalog.first}},{key:HEAD,expectedVersion:state.catalog.headVersion,value:{first:c.key}});}
  const result={key:c.key,version:c.expectedVersion+1,deleted:c.deleted};
  if(boundBase.writerFence===2){const seq=state.journal.seq;changes.push({key:syncAppChangeSlot(seq),expectedVersion:state.journal.slotVersion,value:{seq,key:c.key,version:c.expectedVersion+1,deleted:c.deleted}},{key:SYNC_APP_CHANGE_HEAD,expectedVersion:state.journal.headVersion,value:{protocol:2,seq,floor:Math.max(1,seq-SYNC_APP_CHANGE_CAPACITY+1),capacity:SYNC_APP_CHANGE_CAPACITY}});result.appSeq=seq;}
  return {kind:'ready',changes,result};
 }
 function advance(input,readEntity){
  if(typeof readEntity!=='function')fail('APP_PREPARATION_CONFIG_INVALID');
  const state=checkState(input);
  if(state.phase==='validate'){
   if(commandError)return rejected(commandError);
   if(c.store!==boundBase.storeId)return rejected('STORE_ID_MISMATCH');
   if(c.generation!==boundBase.datasetGeneration)return rejected('DATASET_GENERATION_MISMATCH');
   if(!boundBase.acceptedEpochs.includes(c.epoch))return rejected('OPERATION_EPOCH_EXPIRED');
   return progress(state,'business');
  }
  if(state.phase==='business'){
   const old=checkedEntity(readEntity('app/data/'+c.key),'app/data/'+c.key,'APP_ENTITY_CORRUPT');
   if((old?.version??0)!==c.expectedVersion)return rejected('ENTITY_VERSION_CONFLICT');
   if(c.expectedVersion===Number.MAX_SAFE_INTEGER)fail('APP_ENTITY_VERSION_EXHAUSTED');
   if(c.deleted&&(c.value!==null||!old||old.deleted))return rejected('ENTITY_MISSING');
   if(c.deleted&&['settings','garden','habit'].includes(parsed.kind))return rejected('ENTITY_DELETE_FORBIDDEN');
   if(!c.deleted&&old?.deleted&&!c.recreate)return rejected('ENTITY_TOMBSTONED');
   const business={exists:!!old,version:old?.version??0},next={...state,business};
   if(!c.deleted&&parsed.kind==='habitLog')return progress(next,'parent');
   if(!c.deleted){const normalized=normalize();if(normalized.error)return rejected(normalized.error);if(parsed.kind==='habit'&&old&&!old.deleted){if(!old.value||!['check','number','time'].includes(old.value.type))fail('APP_ENTITY_CORRUPT');if(old.value.type!==normalized.value.type)return rejected('HABIT_TYPE_IMMUTABLE');}}
   return progress(next,afterValue(next));
  }
  if(state.phase==='parent'){
   const key='app/data/habit:'+parsed.id,habit=checkedEntity(readEntity(key),key,'APP_ENTITY_CORRUPT');
   if(!habit||habit.deleted)return rejected('HABIT_MISSING');
   let definition;try{definition=validateEntity('habit:'+parsed.id,habit.value);}catch{fail('APP_ENTITY_CORRUPT');}
   const normalized=normalize(definition);if(normalized.error)return rejected(normalized.error);
   return progress(state,afterValue(state),{logValue:normalized.value});
  }
  if(state.phase==='catalog-node'){
   const key='app/catalog/'+c.key,node=checkedEntity(readEntity(key),key,'CATALOG_CORRUPT');
   if(node!==null)fail('CATALOG_CORRUPT');
   return progress(state,'catalog-head',{catalog:{nodeChecked:true,headVersion:null,first:null}});
  }
  if(state.phase==='catalog-head'){
   const head=checkedEntity(readEntity(HEAD),HEAD,'CATALOG_CORRUPT');
   if(head&&(head.deleted||!exact(head.value,'first')||head.value.first!==null&&typeof head.value.first!=='string'))fail('CATALOG_CORRUPT');
   const first=head?.value.first??null;if(first!==null)checkedDomainKey(first,'CATALOG_CORRUPT');if(first===c.key)fail('CATALOG_CORRUPT');
   if(head?.version===Number.MAX_SAFE_INTEGER)fail('APP_CATALOG_VERSION_EXHAUSTED');
   return progress(state,afterCatalog(),{catalog:{nodeChecked:true,headVersion:head?.version??0,first}});
  }
  if(state.phase==='journal-head'){
   const entity=checkedEntity(readEntity(SYNC_APP_CHANGE_HEAD),SYNC_APP_CHANGE_HEAD,'APP_JOURNAL_CORRUPT'),head=validateSyncAppChangeHead(entity),seq=head.seq+1;
   if(!Number.isSafeInteger(seq))fail('APP_SEQUENCE_EXHAUSTED');
   return progress(state,'journal-slot',{journal:{headVersion:entity.version,seq,slotVersion:null}});
  }
  if(state.phase==='journal-slot'){
   const seq=state.journal.seq,key=syncAppChangeSlot(seq),slot=checkedEntity(readEntity(key),key,'APP_JOURNAL_CORRUPT');
   if(seq>SYNC_APP_CHANGE_CAPACITY&&!slot||slot&&(slot.deleted||!exact(slot.value,'seq,key,version,deleted')||slot.value.seq!==seq-SYNC_APP_CHANGE_CAPACITY||!Number.isSafeInteger(slot.value.version)||slot.value.version<1||typeof slot.value.deleted!=='boolean'))fail('APP_JOURNAL_CORRUPT');
   if(slot)checkedDomainKey(slot.value.key,'APP_JOURNAL_CORRUPT');
   if(slot?.version===Number.MAX_SAFE_INTEGER)fail('APP_JOURNAL_VERSION_EXHAUSTED');
   return progress(state,'ready',{journal:{...state.journal,slotVersion:slot?.version??0}});
  }
  if(state.phase==='ready')return ready(state);
  fail('APP_PREPARATION_STATE_INVALID');
 }
 return Object.freeze({initialState,advance});
}

return {createPreparedAppCommand};})();
const m4=(function(){
const {canonical,parseKey,validateEntity}=m1;
const {SYNC_APP_CHANGE_HEAD,SYNC_APP_CHANGE_CAPACITY,syncAppChangeSlot,validateSyncAppChangeHead}=m2;
const fail=(code,retryable=false)=>{const e=Error(code);e.code=code;if(retryable)e.retryable=true;throw e;};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.split(',').sort().join(',');
function appReceipt(receipt){
 if(receipt?.result&&Object.prototype.hasOwnProperty.call(receipt.result,'preparationError')){
  if(!exact(receipt.result,'preparationError')||typeof receipt.result.preparationError!=='string'||!/^[A-Z][A-Z0-9_]{1,80}$/.test(receipt.result.preparationError))fail('APP_RECEIPT_INVALID');
  fail(receipt.result.preparationError);
 }
 return receipt;
}
const HEAD='app/catalog/head';const node=key=>'app/catalog/'+key;const data=key=>'app/data/'+key;
const APP_CHANGE_HEAD=SYNC_APP_CHANGE_HEAD;
const APP_CHANGE_CAPACITY=SYNC_APP_CHANGE_CAPACITY;
const appChangeSlot=syncAppChangeSlot;
// Only explicit owner activation initializes the shared head with the fence.
function appChangeHead(entity){return validateSyncAppChangeHead(entity);}
function createAppDomain({writer,locked,digest}){
 if(!writer||typeof locked!=='function'||typeof digest!=='function')fail('DOMAIN_CONFIG');
 return {
 command(c){return locked(()=>{
  if(!exact(c,'operationId,epoch,generation,store,key,expectedVersion,deleted,value,recreate')||typeof c.operationId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(c.operationId)||typeof c.epoch!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(c.epoch)||typeof c.store!=='string'||typeof c.generation!=='string'||!Number.isSafeInteger(c.expectedVersion)||c.expectedVersion<0||typeof c.deleted!=='boolean'||typeof c.recreate!=='boolean')fail('COMMAND_INVALID');
  const parsed=parseKey(c.key),hash=digest(canonical(c));
  // Keep the original client-command digest. Server-generated catalog/journal
  // metadata is rebuilt only after a verified unrelated reserved-slot winner.
  for(let attempt=0;attempt<=4;attempt++){
   writer.recoveryBarrier();
   const status=writer.status();
   // The prepared engine owns receipt-first replay and exact-parent pending
   // descriptor evidence. Do not repeat its deep negative receipt lookup here.
   if(typeof writer.prepareAppCommand==='function'&&status.nextPreparationId)return appReceipt(writer.prepareAppCommand(c,hash));
   // Legacy receipts replay before generation/version/domain-state checks.
   // Receipts without appSeq are returned byte-for-byte as originally recorded.
   const prior=writer.getReceipt(c.operationId,c.epoch);if(prior){if(prior.digest!==hash)fail('OP_ID_REUSED');return appReceipt(prior);}
   if(c.store!==status.storeId)fail('STORE_ID_MISMATCH');if(c.generation!==status.datasetGeneration)fail('DATASET_GENERATION_MISMATCH');
   if(!status.acceptedEpochs.includes(c.epoch))fail('OPERATION_EPOCH_EXPIRED');
   const old=writer.getEntity(data(c.key));if((old?.version??0)!==c.expectedVersion)fail('ENTITY_VERSION_CONFLICT');
   if(c.deleted&&(c.value!==null||!old||old.deleted))fail('ENTITY_MISSING');
   if(c.deleted&&['settings','garden','habit'].includes(parsed.kind))fail('ENTITY_DELETE_FORBIDDEN'); // Archive habits; preserves historical log types.
   let value=null;
   if(!c.deleted){const habit=parsed.kind==='habitLog'?writer.getEntity(data('habit:'+parsed.id)):null;if(parsed.kind==='habitLog'&&(!habit||habit.deleted))fail('HABIT_MISSING');value=validateEntity(c.key,c.value,habit?.value);if(parsed.kind==='habit'&&old&&!old.deleted&&old.value.type!==value.type)fail('HABIT_TYPE_IMMUTABLE');}
   // At exhaustion still recover/replay and verify the actual business version
   // above. Never label metadata-only contention as a conflict in the user's data.
   if(attempt===4)fail('DOMAIN_CONTENTION',true);
   const changes=[{key:data(c.key),expectedVersion:c.expectedVersion,deleted:c.deleted,value,...(c.recreate?{recreate:true}:{})}];
   if(!old){const head=writer.getEntity(HEAD);if(head&&(head.deleted||!exact(head.value,'first')))fail('CATALOG_CORRUPT');changes.push({key:node(c.key),expectedVersion:0,value:{key:c.key,next:head?.value.first??null}},{key:HEAD,expectedVersion:head?.version??0,value:{first:c.key}});}
   const result={key:c.key,version:c.expectedVersion+1,deleted:c.deleted};
   // Unfenced stores retain the legacy mutation/result contract. Login, pull,
   // and ordinary commands cannot authorize the irreversible format fence.
   if(status.writerFence===2){
    const head=writer.getEntity(APP_CHANGE_HEAD),journal=appChangeHead(head),seq=journal.seq+1;
    if(!Number.isSafeInteger(seq))fail('APP_SEQUENCE_EXHAUSTED');
    const slot=writer.getEntity(appChangeSlot(seq));
    if(seq>APP_CHANGE_CAPACITY&&!slot||slot&&(slot.deleted||!exact(slot.value,'seq,key,version,deleted')||slot.value.seq!==seq-APP_CHANGE_CAPACITY||!Number.isSafeInteger(slot.value.version)||slot.value.version<1||typeof slot.value.deleted!=='boolean'))fail('APP_JOURNAL_CORRUPT');
    changes.push({key:appChangeSlot(seq),expectedVersion:slot?.version??0,value:{seq,key:c.key,version:c.expectedVersion+1,deleted:c.deleted}},{key:APP_CHANGE_HEAD,expectedVersion:head.version,value:{protocol:2,seq,floor:Math.max(1,seq-APP_CHANGE_CAPACITY+1),capacity:APP_CHANGE_CAPACITY}});
    result.appSeq=seq;
   }
   try{return writer.transact({operationId:c.operationId,epoch:c.epoch,datasetGeneration:c.generation,digest:hash,changes,result});}
   catch(error){if((error.code||error.message)!=='ENTITY_VERSION_CONFLICT')throw error;}
  }
 });},
 snapshot(p){return locked(()=>{
  if(!exact(p,'cursor,revision')||(p.cursor!==null&&typeof p.cursor!=='string')||(p.revision!==null&&!Number.isSafeInteger(p.revision)))fail('SNAPSHOT_INVALID');
  writer.recoveryBarrier();const s=writer.status();if(p.revision!==null&&p.revision!==s.revision)fail('SNAPSHOT_CHANGED');
  if(p.cursor!==null){parseKey(p.cursor);if(p.revision===null)fail('SNAPSHOT_INVALID');}
  let key=p.cursor??writer.getEntity(HEAD)?.value.first??null;const entities=[],seen=new Set();let bytes=0;
  while(key!==null&&entities.length<24&&bytes<131072){if(seen.has(key))fail('CATALOG_CORRUPT');seen.add(key);const n=writer.getEntity(node(key)),e=writer.getEntity(data(key));if(!n||n.deleted||n.value.key!==key||!e)fail('CATALOG_CORRUPT');parseKey(key);entities.push({key,version:e.version,deleted:e.deleted,value:e.value});bytes+=canonical(e).length;key=n.value.next;if(key!==null)parseKey(key);}
  return {store:s.storeId,generation:s.datasetGeneration,revision:s.revision,epoch:s.acceptedEpochs[s.acceptedEpochs.length-1],entities,cursor:key};
 });}
 };
}

return {APP_CHANGE_HEAD,APP_CHANGE_CAPACITY,appChangeSlot,appChangeHead,createAppDomain};})();
const m5=(function(){
// Incremental application reads share the existing immutable writer transaction
// boundary. Signed continuations select a verified, frozen COW root, never a
// client-supplied raw Drive ID and never a freshly recovered mutable read view.
const {parseKey}=m1;
const {utf8ByteLength}=m0;
const {APP_CHANGE_HEAD,appChangeHead,appChangeSlot}=m4;
const fail=(code,retryable=false,resetReason=null)=>{const e=Error(code);e.code=code;if(retryable)e.retryable=true;if(resetReason)e.resetReason=resetReason;throw e;};
const reset=reason=>fail('RESET_REQUIRED',false,reason);
const requireFence=view=>{if(view.writerFence!==2){const e=Error('SYNC_V2_MIGRATION_REQUIRED');e.code=e.message;e.requiresOwnerAction=true;throw e;}};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.split(',').sort().join(',');
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const id=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(s);
const hash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const ref=r=>r===null||exact(r,'id,hash')&&id(r.id)&&hash(r.hash);
const APP_CURSOR_KIND='mypace-app-sync';
const MAX_CURSOR_BYTES=8192,MAX_PAGE_BYTES=262144,MAX_PAGE_UNITS=24,MAX_SNAPSHOT_UNITS=128;
const DELTA_CURSOR_TTL=15*60*1000,SNAPSHOT_CURSOR_TTL=24*60*60*1000;
const cursorTtl=mode=>mode==='snapshot'?SNAPSHOT_CURSOR_TTL:DELTA_CURSOR_TTL;
const snapshotPosition=p=>p===null||exact(p,'path,offset')&&typeof p.path==='string'&&/^[0-9a-f]{0,64}$/.test(p.path)&&integer(p.offset)&&p.offset<=512;
// This includes the maximum ASCII signed token, the small response envelope,
// and the signed-dispatcher wrapper. One 128 KiB writer value still fits.
const PAGE_HEADROOM=16384;
const budgetError=e=>['STORE_YIELD','OWNER_BUDGET_YIELD','IMPORT_YIELD','SYNC_BUDGET_YIELD'].includes(e?.code||e?.message);
function domainKey(key,code){try{parseKey(key);}catch(_){fail(code);}return key;}
function acknowledgement(a){return a===null||exact(a,'store,generation,revision,hash')&&id(a.store)&&id(a.generation)&&integer(a.revision)&&hash(a.hash);}
function checkpoint(c){return c===null||exact(c,'store,generation,seq')&&id(c.store)&&id(c.generation)&&integer(c.seq);}
function readView(v){return exact(v,'anchorId,anchorHash,storeId,datasetGeneration,revision,stateRoot,receiptRoot,acceptedEpochs,headId,headHash,writerScriptId,schemaVersion,writerFence')&&id(v.anchorId)&&hash(v.anchorHash)&&id(v.storeId)&&id(v.datasetGeneration)&&integer(v.revision)&&ref(v.stateRoot)&&ref(v.receiptRoot)&&id(v.headId)&&hash(v.headHash)&&id(v.writerScriptId)&&integer(v.schemaVersion)&&v.schemaVersion>0&&[0,2].includes(v.writerFence)&&Array.isArray(v.acceptedEpochs)&&v.acceptedEpochs.length>0&&v.acceptedEpochs.length<=4&&v.acceptedEpochs.every(id)&&new Set(v.acceptedEpochs).size===v.acceptedEpochs.length;}
function businessEntity(e,key,code){
 if(!e||e.key!=='app/data/'+key||!integer(e.version)||e.version===0||typeof e.deleted!=='boolean'||e.deleted&&e.value!==null)fail(code);
 return {key,version:e.version,deleted:e.deleted,value:e.value};
}
function createAppSyncV2({writer,locked,sealCursor,openCursor,now=()=>Date.now(),canContinue=()=>true}){
 if(!writer||['captureReadView','readEntityAtRoot','scanEntitiesAtRoot','validateReadView','assertMinimumAtReadView','recoveryBarrier'].some(k=>typeof writer[k]!=='function')||[locked,sealCursor,openCursor,now,canContinue].some(f=>typeof f!=='function'))fail('SYNC_CONFIG');
 const read=(view,key)=>writer.readEntityAtRoot(view.stateRoot,key);
 function open(encoded,time){
  if(typeof encoded!=='string'||encoded.length===0||utf8ByteLength(encoded)>MAX_CURSOR_BYTES)fail('SYNC_CURSOR_INVALID');
  let c;try{c=openCursor(encoded);}catch(error){if((error.code||error.message)==='CURSOR_EXPIRED')reset('cursor-expired');fail('SYNC_CURSOR_INVALID');}
  if(!exact(c,'kind,protocol,mode,view,targetSeq,position,issuedAt,expiresAt')||c.kind!==APP_CURSOR_KIND||c.protocol!==2||!['snapshot','delta'].includes(c.mode)||!readView(c.view)||!integer(c.targetSeq)||!integer(c.issuedAt)||!integer(c.expiresAt)||c.expiresAt-c.issuedAt!==cursorTtl(c.mode)||c.issuedAt>time)fail('SYNC_CURSOR_INVALID');
  if(c.expiresAt<=time)reset('cursor-expired');
  if(c.view.anchorId!==writer.anchorId||c.view.storeId!==writer.storeId||c.view.writerScriptId!==writer.writerScriptId||c.view.schemaVersion!==writer.schemaVersion)reset('identity-changed');
  requireFence(c.view);
  if(c.mode==='delta'){if(!integer(c.position)||c.position>c.targetSeq)fail('SYNC_CURSOR_INVALID');}
  else if(c.position===null||!snapshotPosition(c.position))fail('SYNC_CURSOR_INVALID');
  return c;
 }
 function seal(c){
  const value=sealCursor(c);
  // The existing codec produces ASCII base64url + HMAC. Limiting the alphabet
  // also makes the pre-reserved JSON byte headroom a strict bound.
  if(typeof value!=='string'||!/^[-A-Za-z0-9_.]+$/.test(value)||value.length>MAX_CURSOR_BYTES)fail('SYNC_CURSOR_INVALID');
  return value;
 }
 function identity(view,bound){if(bound&&(bound.store!==view.storeId||bound.generation!==view.datasetGeneration))reset('identity-changed');}
 function minimum(view,ack){if(ack&&!writer.assertMinimumAtReadView(view,{revision:ack.revision,hash:ack.hash}))fail('SYNC_CUT_BEHIND',true);}
 function initial(p,time){
  // Establish identity before evaluating a client proof. A proof for a different
  // store/generation must request a safe rebootstrap, not deadlock recovery.
  writer.recoveryBarrier();
  const view=writer.captureReadView();if(!readView(view))fail('SYNC_READ_VIEW_INVALID');requireFence(view);
  identity(view,p.since);identity(view,p.minimumAcknowledged);minimum(view,p.minimumAcknowledged);
  const head=appChangeHead(read(view,APP_CHANGE_HEAD));
  if(p.since&&p.since.seq>head.seq)fail('SYNC_CHECKPOINT_AHEAD');
  if(p.since&&p.since.seq+1<head.floor)reset('retention-floor');
  const mode=p.since?'delta':'snapshot',position=p.since?.seq??null;
  return {kind:APP_CURSOR_KIND,protocol:2,mode,view,targetSeq:head.seq,position,issuedAt:time,expiresAt:time+cursorTtl(mode)};
 }
 return Object.freeze({pull(p){return locked(()=>{
  if(!exact(p,'cursor,since,minimumAcknowledged')||p.cursor!==null&&typeof p.cursor!=='string'||!checkpoint(p.since)||!acknowledgement(p.minimumAcknowledged)||p.cursor!==null&&p.since!==null)fail('SYNC_PAYLOAD_INVALID');
  const time=now();if(!integer(time)||!Number.isSafeInteger(time+SNAPSHOT_CURSOR_TTL))fail('SYNC_CLOCK_INVALID');
  const c=p.cursor===null?initial(p,time):open(p.cursor,time),v=c.view;
  if(p.cursor!==null){
   try{writer.validateReadView(v);}catch(error){if((error.code||error.message)==='WRITER_READ_VIEW_INVALID')reset('identity-changed');throw error;}
   identity(v,p.minimumAcknowledged);minimum(v,p.minimumAcknowledged);
  }
  const fromSeq=c.mode==='delta'?c.position:null,entries=new Map();let position=c.position,more=false;
  if(c.mode==='snapshot'){
   // Scan each immutable radix leaf once, rather than two key lookups for every
   // catalog record. A page may contain no app data while still advancing over
   // internal import/catalog/journal entries; that is valid bounded progress.
   const scan=writer.scanEntitiesAtRoot(v.stateRoot,{position,prefix:'app/data/',limit:MAX_SNAPSHOT_UNITS,maxBytes:229376,scanLimit:2048,canContinue});
   if(!scan||!Array.isArray(scan.entries)||scan.entries.length>MAX_SNAPSHOT_UNITS||typeof scan.done!=='boolean'||!snapshotPosition(scan.position)||scan.done!==(scan.position===null)||!integer(scan.scanned)||!integer(scan.bytes))fail('SYNC_SCAN_INVALID');
   const start=position??{path:'',offset:0};
   if(!scan.done&&scan.position.path===start.path&&scan.position.offset===start.offset)fail('SYNC_BUDGET_YIELD',true);
   for(const entity of scan.entries){
    if(typeof entity?.key!=='string'||!entity.key.startsWith('app/data/'))fail('SYNC_SCAN_INVALID');
    const key=domainKey(entity.key.slice(9),'SYNC_SCAN_INVALID');if(entries.has(key))fail('SYNC_SCAN_INVALID');
    entries.set(key,businessEntity(entity,key,'SYNC_SCAN_INVALID'));
   }
   position=scan.position;more=!scan.done;
  }else{
   let units=0,bytes=2;
   while(position<c.targetSeq&&units<MAX_PAGE_UNITS){
    if(!canContinue()){if(!units)fail('SYNC_BUDGET_YIELD',true);break;}
    let key,entry,next;
    try{
     next=position+1;const event=read(v,appChangeSlot(next));
     if(!event||event.deleted||!exact(event.value,'seq,key,version,deleted')||event.value.seq!==next||!integer(event.value.version)||event.value.version===0||typeof event.value.deleted!=='boolean')fail('APP_JOURNAL_GAP');
     key=domainKey(event.value.key,'APP_JOURNAL_CORRUPT');
     entry=entries.get(key)||businessEntity(read(v,'app/data/'+key),key,'APP_JOURNAL_CORRUPT');
     if(entry.version<event.value.version||entry.version===event.value.version&&entry.deleted!==event.value.deleted)fail('APP_JOURNAL_CORRUPT');
    }catch(error){if(!budgetError(error))throw error;if(!units)fail('SYNC_BUDGET_YIELD',true);break;}
    const additional=entries.has(key)?0:utf8ByteLength(JSON.stringify(entry))+(entries.size?1:0);
    if(bytes+additional>MAX_PAGE_BYTES-PAGE_HEADROOM){if(!units)fail('SYNC_ENTITY_TOO_LARGE');break;}
    // Advance only after a complete event was validated and byte-admitted.
    entries.set(key,entry);bytes+=additional;units++;position=next;
   }
   more=position<c.targetSeq;
  }
  const result={protocol:2,mode:c.mode,store:v.storeId,generation:v.datasetGeneration,epoch:v.acceptedEpochs[v.acceptedEpochs.length-1],revision:v.revision,headHash:v.headHash,fromSeq,targetSeq:c.targetSeq,throughSeq:c.mode==='delta'?position:more?null:c.targetSeq,entries:[...entries.values()],nextCursor:more?seal({...c,position}):null,checkpoint:more?null:{store:v.storeId,generation:v.datasetGeneration,seq:c.targetSeq}};
  if(utf8ByteLength(JSON.stringify(result))>MAX_PAGE_BYTES)fail('SYNC_PAGE_TOO_LARGE');
  return result;
 });}});
}

return {createAppSyncV2};})();
const m6=(function(){
// Authenticated service composition. Record snapshots are independent of the
// optional CSV overview, which shares the same verified lock phase when cheap.
const codeOf=e=>typeof e?.code==='string'?e.code:typeof e?.message==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(e.message)?e.message:'SERVICE_UNAVAILABLE';
function safeRecoveryProgress(progress){
 if(!progress||!['frames','index','checkpoint','preparation'].includes(progress.phase)||progress.cursorPersisted!==true||progress.cursorAdvanced!==true)return null;
 const field={frames:'revision',index:'indexLinks',checkpoint:'revision',preparation:'ordinal'}[progress.phase];
 if(!field||!Number.isSafeInteger(progress[field])||progress[field]<1)return null;
 return {phase:progress.phase,...(progress.phase==='preparation'?{ordinal:progress.ordinal}:{...(Number.isSafeInteger(progress.revision)&&progress.revision>=0?{revision:progress.revision}:{}),...(Number.isSafeInteger(progress.indexLinks)&&progress.indexLinks>=0?{indexLinks:progress.indexLinks}:{})}),cursorPersisted:true,cursorAdvanced:true};
}
function createPublicServices({runtime,domain,reader,appSync,deadlineMs,now=()=>Date.now()}){
 if(!runtime?.writer||typeof runtime.locked!=='function'||!domain||!reader||!appSync||!Number.isSafeInteger(deadlineMs)||typeof now!=='function')throw Error('PUBLIC_SERVICES_CONFIG');
 const maintenanceView=()=>{const s=runtime.writer.status();return {due:s.replayFrames>=16,replayFrames:s.replayFrames,softLimit:16,hardLimit:64};};
 const ready=()=>{const s=runtime.writer.status();return {protocol:2,ready:true,store:s.storeId,generation:s.datasetGeneration,revision:s.revision,headHash:s.headHash,writerFence:s.writerFence,maintenance:maintenanceView()};};
 const optionalTime=()=>deadlineMs-now()>=8000;
 const ancillaryError=e=>({ok:false,error:codeOf(e),retryable:e?.retryable===true||['STORE_YIELD','WRITER_BUSY','IMPORT_STATUS_DEFERRED'].includes(codeOf(e))});
 function metadata(result,first){
  if(!first)return result;
  const deferred=()=>({ok:false,error:'IMPORT_STATUS_DEFERRED',retryable:true});
  let imports=deferred(),importStatus=deferred();
  if(optionalTime())try{imports={ok:true,result:reader.listImportedRuns({cursor:null,revision:result.revision})};}catch(e){imports=ancillaryError(e);}
  // Do not run another cold recovery after the preceding advisory failure.
  if(imports.ok&&optionalTime())try{importStatus={ok:true,result:reader.status({revision:result.revision})};}catch(e){importStatus=ancillaryError(e);}
  return {...result,syncMeta:{format:1,imports,importStatus,storageMaintenance:maintenanceView()}};
 }
 function guarded(action){return runtime.locked(()=>{try{return action();}catch(error){
  let progress=safeRecoveryProgress(error?.recovery);
  if(!progress&&error?.phase==='preparation')progress=safeRecoveryProgress(error);
  if(!progress&&error?.cursorPersisted===true&&Number.isSafeInteger(error.indexLinks)&&error.scannedLinks>0)progress={phase:'index',indexLinks:error.indexLinks,cursorPersisted:true,cursorAdvanced:true};
  else if(!progress&&error?.cursorPersisted===true&&error.cursorAdvanced===true&&Number.isSafeInteger(error.recoveredRevision))progress={phase:'frames',revision:error.recoveredRevision,cursorPersisted:true,cursorAdvanced:true};
  else if(!progress&&error?.retryable===true)try{progress=runtime.writer.continuationProgress();}catch(_){}
  progress=safeRecoveryProgress(progress);
  if(progress&&error?.retryable===true){error.code='WRITER_RECOVERY_PENDING';error.message=error.code;error.recovery=progress;}
  throw error;
 }});}
 const command=payload=>guarded(()=>domain.command(payload));
 return {
  command,commandV2:command,
  maintain:payload=>guarded(()=>{
   if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length)throw Error('STATUS_INVALID');
   runtime.writer.recoveryBarrier({persistFrameProgress:true});
   // Optional maintenance owns no record edits, identities or permissions. A
   // prepared checkpoint uses the existing immutable same-ID recovery path.
   if(runtime.writer.status().replayFrames>=16){runtime.writer._automaticCheckpoint();runtime.writer.recoveryBarrier({persistFrameProgress:true});}
   return ready();
  }),
  recover:payload=>guarded(()=>{
   if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('STATUS_INVALID');
   if(Object.keys(payload).join(',')==='pull'){
    const p=payload.pull;
    if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).sort().join(',')!=='cursor,minimumAcknowledged,since'||p.cursor!==null)throw Error('STATUS_INVALID');
    // Return one complete bounded protocol page, never a "ready" signal that
    // forces a second cold recovery. appSync enforces the identical proof,
    // identity, payload, byte and stable-cut rules used by an ordinary pull.
    return metadata(appSync.pull(p),true);
   }
   if(Object.keys(payload).length)throw Error('STATUS_INVALID');
   runtime.writer.recoveryBarrier({persistFrameProgress:true});const s=runtime.writer.status();return {protocol:2,ready:true,store:s.storeId,generation:s.datasetGeneration,revision:s.revision,headHash:s.headHash,writerFence:s.writerFence};
  }),
  snapshot:payload=>guarded(()=>metadata(domain.snapshot(payload),payload?.cursor===null)),
  pull:payload=>guarded(()=>metadata(appSync.pull(payload),payload?.cursor===null)),
  imports:payload=>guarded(()=>reader.listImportedRuns(payload)),
  route:payload=>guarded(()=>reader.readRoutePage(payload)),
  importStatus:payload=>guarded(()=>{if(!payload||Object.keys(payload).length)throw Error('STATUS_INVALID');return reader.status();})
 };
}

return {safeRecoveryProgress,createPublicServices};})();
const m7=(function(){
const {safeRecoveryProgress}=m6;
const {canonical}=m1;
const fail=code=>{const e=Error(code);e.code=code;throw e;};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===(keys?keys.split(','):[]).sort().join(',');
function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
function createSignedDispatcher({owner,store,secret,hmac,byteLength,now=()=>Date.now(),createServices}){
 if(owner!=='yakitorihanbagu0412@gmail.com'||!/^[-a-zA-Z0-9_]{1,128}$/.test(store)||typeof secret!=='string'||secret.length<32||typeof hmac!=='function'||typeof byteLength!=='function'||typeof createServices!=='function')fail('DISPATCHER_CONFIG');
 return raw=>{try{
  if(typeof raw!=='string'||byteLength(raw)>220000)fail('BODY_TOO_LARGE');let e;try{e=JSON.parse(raw);}catch{fail('INVALID_JSON');}
  if(!exact(e,'v,ts,nonce,owner,store,action,payload,signature')||e.v!==1||!Number.isSafeInteger(e.ts)||Math.abs(now()-e.ts)>120000||!/^[-A-Za-z0-9_]{43}$/.test(e.nonce)||e.owner!==owner||e.store!==store||!['command','commandV2','recover','maintain','snapshot','pull','imports','route','importStatus'].includes(e.action)||!/^[-A-Za-z0-9_]{43}$/.test(e.signature))fail('REQUEST_FORBIDDEN');
  const {signature,...unsigned}=e;if(!equal(hmac(canonical(unsigned),secret),signature))fail('SIGNATURE_INVALID');
  // No Drive access, runtime or service construction occurs before authentication.
  if(e.action==='pull'){if(!exact(e.payload,'cursor,since,minimumAcknowledged'))fail('PAYLOAD_INVALID');}else if(e.action==='snapshot'||e.action==='imports'){if(!exact(e.payload,'cursor,revision'))fail('PAYLOAD_INVALID');}else if(e.action==='route'){if(!exact(e.payload,'runId,cursor,revision'))fail('PAYLOAD_INVALID');}else if((e.action==='importStatus'||e.action==='maintain')){if(!exact(e.payload,''))fail('PAYLOAD_INVALID');}else if(e.action==='recover'){
   // The longer authenticated recovery slice can finish a first-page read in
   // that SAME lock phase. It is not an arbitrary action or continuation route.
   if(!exact(e.payload,'')&&!(exact(e.payload,'pull')&&exact(e.payload.pull,'cursor,since,minimumAcknowledged')&&e.payload.pull.cursor===null))fail('PAYLOAD_INVALID');
  }
  const services=createServices(e.action);if(typeof services[e.action]!=='function')fail('ACTION_UNAVAILABLE');
  return {ok:true,result:services[e.action](e.payload)};
 }catch(error){const code=error.code||error.message;return {ok:false,error:/^[A-Z][A-Z0-9_]{1,80}$/.test(code)?code:'VALIDATION_FAILED',retryable:error.retryable===true,...(error.requiresOwnerAction===true?{requiresOwnerAction:true}:{}),...(['identity-changed','retention-floor','cursor-expired'].includes(error.resetReason)?{resetReason:error.resetReason}:{}),...(safeRecoveryProgress(error.recovery)?{recovery:safeRecoveryProgress(error.recovery)}:{})};}};
}
function createCursorCodec({secret,hmac,encode,decode,now=()=>Date.now(),ttlMs=600000,domain=''}){
 if(!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>86400000||typeof domain!=='string'||!/^[A-Za-z0-9_-]{0,40}$/.test(domain))fail('CURSOR_CONFIG');
 const scope=domain?'cursor/'+domain+':':'cursor:';
 return {
 sealCursor(value){const exp=Number.isSafeInteger(value?.expiresAt)?Math.min(now()+ttlMs,value.expiresAt):now()+ttlMs;if(exp<=now())fail('CURSOR_EXPIRED');const text=encode(canonical({value,exp}));return text+'.'+hmac(scope+text,secret);},
 openCursor(token){if(typeof token!=='string'||token.length>8192)fail('CURSOR_INVALID');const [text,sig,...rest]=token.split('.');if(rest.length||!equal(hmac(scope+text,secret),sig))fail('CURSOR_INVALID');let p;try{p=JSON.parse(decode(text));}catch{fail('CURSOR_INVALID');}if(!exact(p,'value,exp')||!Number.isSafeInteger(p.exp)||p.exp<=now()||p.exp>now()+ttlMs)fail('CURSOR_EXPIRED');return p.value;}
 };
}

return {createSignedDispatcher,createCursorCodec};})();
return Object.assign({},m3,m4,m5,m6,m7);})();
