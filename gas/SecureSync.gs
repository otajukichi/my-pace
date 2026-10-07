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
 if(['run','habit','event'].includes(kind)&&/^[A-Za-z0-9_-]{1,100}$/.test(id)&&!['constructor','prototype','__proto__'].includes(id)&&date===undefined)return {kind,id};
 if(kind==='habitLog'&&/^[A-Za-z0-9_-]{1,100}$/.test(id)&&!['constructor','prototype','__proto__'].includes(id)&&isDateKey(date))return {kind,id,date};
 if((kind==='settings'&&id==='wakeTarget'||kind==='garden'&&id==='preferences')&&date===undefined)return {kind,id};
 throw Error('ENTITY_KEY_INVALID');
}
function stateToEntities(raw){const s=validateState(raw),out={};for(const [d,v] of Object.entries(s.wake))out['wake:'+d]=v;for(const k of ['run','habit','event'])for(const v of s[k==='run'?'runs':k==='habit'?'habits':'events'])out[k+':'+v.id]=v;for(const [id,days] of Object.entries(s.habitLogs))for(const [d,v]of Object.entries(days))out['habitLog:'+id+':'+d]=v;for(const [d,v]of Object.entries(s.diary))out['diary:'+d]=v;out['settings:wakeTarget']=s.settings.wakeTarget;out['garden:preferences']=s.garden;return out;}
function entitiesToState(entities){const s=createInitialState();for(const [key,value]of Object.entries(entities)){const {kind,id,date}=parseKey(key);if(kind==='wake'||kind==='diary')s[kind][id]=clone(value);else if(kind==='run'||kind==='habit'||kind==='event')s[kind==='run'?'runs':kind==='habit'?'habits':'events'].push(clone(value));else if(kind==='habitLog'){if(s.habitLogs[id]===null||s.habitLogs[id]===undefined)s.habitLogs[id]={};s.habitLogs[id][date]=value;}else if(kind==='settings')s.settings.wakeTarget=value;else s.garden=clone(value);}for(const id of Object.keys(s.habitLogs))if(!s.habits.some(h=>h.id===id))delete s.habitLogs[id];return validateState(s);}
function validateEntity(key,value,habit){const p=parseKey(key),s=createInitialState();if(p.kind==='habitLog'){s.habits=[habit];s.habitLogs[p.id]={[p.date]:value};}else if(p.kind==='wake'||p.kind==='diary')s[p.kind][p.id]=value;else if(p.kind==='run'||p.kind==='habit'||p.kind==='event'){if(value?.id!==p.id)throw Error('ENTITY_ID_MISMATCH');s[p.kind==='run'?'runs':p.kind==='habit'?'habits':'events']=[value];}else if(p.kind==='settings')s.settings.wakeTarget=value;else s.garden=value;return stateToEntities(s)[key];}
function diffEntities(before,after){const a=stateToEntities(before),b=stateToEntities(after);return [...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>canonical(a[k]===undefined?null:a[k])!==canonical(b[k]===undefined?null:b[k])||Object.prototype.hasOwnProperty.call(a,k)!==Object.prototype.hasOwnProperty.call(b,k)).map(key=>({key,deleted:!Object.prototype.hasOwnProperty.call(b,key),value:Object.prototype.hasOwnProperty.call(b,key)?b[key]:null}));}

return {clone,canonical,parseKey,stateToEntities,entitiesToState,validateEntity,diffEntities};})();
const m2=(function(){
const {canonical,parseKey,validateEntity}=m1;
const fail=code=>{const e=Error(code);e.code=code;throw e;};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.split(',').sort().join(',');
const HEAD='app/catalog/head';const node=key=>'app/catalog/'+key;const data=key=>'app/data/'+key;
function createAppDomain({writer,locked,digest}){
 if(!writer||typeof locked!=='function'||typeof digest!=='function')fail('DOMAIN_CONFIG');
 return {
 command(c){return locked(()=>{
  if(!exact(c,'operationId,epoch,generation,store,key,expectedVersion,deleted,value,recreate')||!/^[-a-zA-Z0-9_]{16,100}$/.test(c.operationId)||!/^[-a-zA-Z0-9_]{1,100}$/.test(c.epoch)||typeof c.store!=='string'||typeof c.generation!=='string'||!Number.isSafeInteger(c.expectedVersion)||c.expectedVersion<0||typeof c.deleted!=='boolean'||typeof c.recreate!=='boolean')fail('COMMAND_INVALID');
  const parsed=parseKey(c.key);writer.recoveryBarrier();const hash=digest(canonical(c));
  // Receipt replay MUST precede generation/version/domain-state checks.
  const prior=writer.getReceipt(c.operationId,c.epoch);if(prior){if(prior.digest!==hash)fail('OP_ID_REUSED');return prior;}
  const status=writer.status();if(c.store!==status.storeId)fail('STORE_ID_MISMATCH');if(c.generation!==status.datasetGeneration)fail('DATASET_GENERATION_MISMATCH');
  if(!status.acceptedEpochs.includes(c.epoch))fail('OPERATION_EPOCH_EXPIRED');
  const old=writer.getEntity(data(c.key));if((old?.version??0)!==c.expectedVersion)fail('ENTITY_VERSION_CONFLICT');
  if(c.deleted&&(c.value!==null||!old||old.deleted))fail('ENTITY_MISSING');
  if(c.deleted&&['settings','garden','habit'].includes(parsed.kind))fail('ENTITY_DELETE_FORBIDDEN'); // Archive habits; preserves historical log types.
  let value=null;
  if(!c.deleted){const habit=parsed.kind==='habitLog'?writer.getEntity(data('habit:'+parsed.id)):null;if(parsed.kind==='habitLog'&&(!habit||habit.deleted))fail('HABIT_MISSING');value=validateEntity(c.key,c.value,habit?.value);if(parsed.kind==='habit'&&old&&!old.deleted&&old.value.type!==value.type)fail('HABIT_TYPE_IMMUTABLE');}
  const changes=[{key:data(c.key),expectedVersion:c.expectedVersion,deleted:c.deleted,value,...(c.recreate?{recreate:true}:{})}];
  if(!old){const head=writer.getEntity(HEAD);changes.push({key:node(c.key),expectedVersion:0,value:{key:c.key,next:head?.value.first??null}},{key:HEAD,expectedVersion:head?.version??0,value:{first:c.key}});}
  return writer.transact({operationId:c.operationId,epoch:c.epoch,datasetGeneration:c.generation,digest:hash,changes,result:{key:c.key,version:c.expectedVersion+1,deleted:c.deleted}});
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

return {createAppDomain};})();
const m3=(function(){
const {canonical}=m1;
const fail=code=>{const e=Error(code);e.code=code;throw e;};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===(keys?keys.split(','):[]).sort().join(',');
function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
function createSignedDispatcher({owner,store,secret,hmac,byteLength,now=()=>Date.now(),createServices}){
 if(owner!=='yakitorihanbagu0412@gmail.com'||!/^[-a-zA-Z0-9_]{1,128}$/.test(store)||typeof secret!=='string'||secret.length<32||typeof hmac!=='function'||typeof byteLength!=='function'||typeof createServices!=='function')fail('DISPATCHER_CONFIG');
 return raw=>{try{
  if(typeof raw!=='string'||byteLength(raw)>220000)fail('BODY_TOO_LARGE');let e;try{e=JSON.parse(raw);}catch{fail('INVALID_JSON');}
  if(!exact(e,'v,ts,nonce,owner,store,action,payload,signature')||e.v!==1||!Number.isSafeInteger(e.ts)||Math.abs(now()-e.ts)>120000||!/^[-A-Za-z0-9_]{43}$/.test(e.nonce)||e.owner!==owner||e.store!==store||!['command','snapshot','imports','route','importStatus'].includes(e.action)||!/^[-A-Za-z0-9_]{43}$/.test(e.signature))fail('REQUEST_FORBIDDEN');
  const {signature,...unsigned}=e;if(!equal(hmac(canonical(unsigned),secret),signature))fail('SIGNATURE_INVALID');
  // No Drive access, runtime or service construction occurs before authentication.
  if(e.action==='snapshot'||e.action==='imports'){if(!exact(e.payload,'cursor,revision'))fail('PAYLOAD_INVALID');}else if(e.action==='route'){if(!exact(e.payload,'runId,cursor,revision'))fail('PAYLOAD_INVALID');}else if(e.action==='importStatus'){if(!exact(e.payload,''))fail('PAYLOAD_INVALID');}
  const services=createServices();if(typeof services[e.action]!=='function')fail('ACTION_UNAVAILABLE');
  return {ok:true,result:services[e.action](e.payload)};
 }catch(error){const code=error.code||error.message;return {ok:false,error:/^[A-Z][A-Z0-9_]{1,80}$/.test(code)?code:'VALIDATION_FAILED',retryable:error.retryable===true};}};
}
function createCursorCodec({secret,hmac,encode,decode,now=()=>Date.now()}){
 return {
 sealCursor(value){const text=encode(canonical({value,exp:now()+600000}));return text+'.'+hmac('cursor:'+text,secret);},
 openCursor(token){if(typeof token!=='string'||token.length>8192)fail('CURSOR_INVALID');const [text,sig,...rest]=token.split('.');if(rest.length||!equal(hmac('cursor:'+text,secret),sig))fail('CURSOR_INVALID');let p;try{p=JSON.parse(decode(text));}catch{fail('CURSOR_INVALID');}if(!exact(p,'value,exp')||!Number.isSafeInteger(p.exp)||p.exp<=now()||p.exp>now()+600000)fail('CURSOR_EXPIRED');return p.value;}
 };
}

return {createSignedDispatcher,createCursorCodec};})();
return Object.assign({},m2,m3);})();
