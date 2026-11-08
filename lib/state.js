const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const STATE_KEYS = ['version', 'profile', 'goals', 'plans', 'habits', 'checks', 'notes', 'runMeta', 'settings'];
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function localDate(date = new Date()) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
}

function dateValue(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new TypeError('日付は YYYY-MM-DD で指定してください。');
  const value = new Date(`${iso}T00:00:00.000Z`);
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== iso) throw new RangeError('存在しない日付です。');
  return value;
}

export function addDays(iso, n) {
  const value = dateValue(iso);
  if (!Number.isInteger(n)) throw new TypeError('日数は整数で指定してください。');
  value.setUTCDate(value.getUTCDate() + n);
  if (!Number.isFinite(value.getTime())) throw new RangeError('日付の範囲を超えました。');
  const result = value.toISOString().slice(0, 10);
  dateValue(result);
  return result;
}

export function weekStart(iso) {
  const value = dateValue(iso);
  return addDays(iso, -((value.getUTCDay() + 6) % 7));
}

export function weekDates(iso) {
  const start = weekStart(iso);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

function defaults() {
  return {
    version: 1,
    profile: { name: '' },
    goals: { weeklyRuns: 3, monthlyKm: 30 },
    plans: [],
    habits: [
      { id: 'stretch', name: 'ストレッチ', icon: 'stretch' },
      { id: 'read', name: '読書を10分', icon: 'book' },
      { id: 'english', name: '英語に触れる', icon: 'headphones' },
    ],
    checks: {},
    notes: [],
    runMeta: {},
    settings: { mapStyle: 'route', weather: false },
  };
}

function invalid(path) { throw new TypeError(`保存データの形式が正しくありません: ${path}`); }

function record(value, path, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key) || (allowed && !allowed.includes(key))) invalid(`${path}.${String(key)}`);
  }
  if (required) for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`);
}

function string(value, path, max = 200, min = 0) {
  if (typeof value !== 'string' || value.length < min || value.length > max) invalid(path);
}

function id(value, path) {
  string(value, path, 128, 1);
  if (FORBIDDEN_KEYS.has(value)) invalid(path);
}

function number(value, path, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) invalid(path);
}

function boolean(value, path) { if (typeof value !== 'boolean') invalid(path); }

function array(value, path, max, validate, uniqueIds = false) {
  if (!Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) invalid(path);
  const ids = new Set();
  for (let index = 0; index < value.length; index++) {
    validate(value[index], `${path}[${index}]`);
    if (uniqueIds) {
      if (ids.has(value[index].id)) invalid(`${path}[${index}].id`);
      ids.add(value[index].id);
    }
  }
}

function validate(state) {
  record(state, 'state', STATE_KEYS);
  if (state.version !== 1) invalid('version');
  record(state.profile, 'profile', ['name']);
  string(state.profile.name, 'profile.name', 100);
  record(state.goals, 'goals', ['weeklyRuns', 'monthlyKm']);
  number(state.goals.weeklyRuns, 'goals.weeklyRuns', 0, 21, true);
  number(state.goals.monthlyKm, 'goals.monthlyKm', 0, 10000);
  array(state.plans, 'plans', 10000, (plan, path) => {
    record(plan, path, ['id', 'date', 'title', 'minutes', 'kind', 'completed']);
    id(plan.id, `${path}.id`);
    dateValue(plan.date);
    string(plan.title, `${path}.title`, 300, 1);
    number(plan.minutes, `${path}.minutes`, 0, 1440);
    if (!['run', 'walk', 'rest'].includes(plan.kind)) invalid(`${path}.kind`);
    boolean(plan.completed, `${path}.completed`);
  }, true);
  array(state.habits, 'habits', 100, (habit, path) => {
    record(habit, path, ['id', 'name', 'icon']);
    id(habit.id, `${path}.id`);
    string(habit.name, `${path}.name`, 200, 1);
    string(habit.icon, `${path}.icon`, 64, 1);
  }, true);
  record(state.checks, 'checks');
  if (Object.keys(state.checks).length > 36600) invalid('checks');
  for (const [date, checks] of Object.entries(state.checks)) {
    dateValue(date);
    array(checks, `checks.${date}`, 100, id);
    if (new Set(checks).size !== checks.length) invalid(`checks.${date}`);
  }
  array(state.notes, 'notes', 10000, (note, path) => {
    record(note, path, ['id', 'date', 'text', 'mood', 'runId'], ['id', 'date', 'text', 'mood']);
    id(note.id, `${path}.id`);
    dateValue(note.date);
    string(note.text, `${path}.text`, 20000);
    string(note.mood, `${path}.mood`, 80);
    if (Object.hasOwn(note, 'runId')) id(note.runId, `${path}.runId`);
  }, true);
  record(state.runMeta, 'runMeta');
  if (Object.keys(state.runMeta).length > 10000) invalid('runMeta');
  for (const [runId, meta] of Object.entries(state.runMeta)) {
    id(runId, 'runMeta.id');
    record(meta, `runMeta.${runId}`, ['favorite', 'mood', 'note'], []);
    if (Object.hasOwn(meta, 'favorite')) boolean(meta.favorite, `runMeta.${runId}.favorite`);
    if (Object.hasOwn(meta, 'mood')) string(meta.mood, `runMeta.${runId}.mood`, 80);
    if (Object.hasOwn(meta, 'note')) string(meta.note, `runMeta.${runId}.note`, 20000);
  }
  record(state.settings, 'settings', ['mapStyle', 'weather']);
  string(state.settings.mapStyle, 'settings.mapStyle', 40, 1);
  boolean(state.settings.weather, 'settings.weather');
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

/** A separate, browser-local workspace. Failed saves never discard the in-memory edit. */
export function createStore(options = {}) {
  const { today = localDate(), key = 'mypace.studio.v1' } = options;
  dateValue(today);
  string(key, 'storage key', 200, 1);
  let storage;
  let state = defaults();
  let available = false;
  let error = null;
  let readOnly = false;
  const listeners = new Set();

  try {
    storage = options.storage === undefined ? globalThis.localStorage : options.storage;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      throw new Error('Storage unavailable');
    }
    const raw = storage.getItem(key);
    if (raw !== null) {
      try {
        if (typeof raw !== 'string' || raw.length > 5000000) invalid('storage');
        const parsed = JSON.parse(raw);
        validate(parsed);
        state = clone(parsed);
      } catch {
        readOnly = true;
        error = '既存の保存データを安全に読み込めませんでした。上書きせず、この画面内だけで編集しています。';
      }
    }
    available = !readOnly;
  } catch {
    readOnly = true;
    error = 'ブラウザの保存領域を利用できません。この画面内だけで編集しています。';
  }

  const get = () => clone(state);
  const status = () => ({ available, error });

  return {
    get,
    status,
    update(mutator) {
      if (typeof mutator !== 'function') throw new TypeError('更新関数を指定してください。');
      const draft = get();
      mutator(draft);
      validate(draft);
      state = clone(draft);
      if (!readOnly) {
        try {
          storage.setItem(key, JSON.stringify(state));
          available = true;
          error = null;
        } catch {
          available = false;
          error = '変更をブラウザに保存できませんでした。この画面内には保持しています。必要なら書き出して保存してください。';
        }
      }
      for (const listener of [...listeners]) {
        try { listener(get(), status()); }
        catch (listenerError) { globalThis.console?.error('MyPace store subscriber failed:', listenerError); }
      }
      return get();
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('購読関数を指定してください。');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exportJSON() { return JSON.stringify(state, null, 2); },
  };
}
