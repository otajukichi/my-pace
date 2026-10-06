import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATE_VERSION, LIMITS, DIARY_MOODS, GARDEN_PLANTS, GARDEN_THEMES, createInitialState,
  validateState, parseBackup, serializeBackup, upsertEvent, removeEvent, upsertDiary, removeDiary,
} from '../src/lib/domain.js';
import { readState, writeState, STORAGE_KEY } from '../src/lib/storage.js';

const event = (patch = {}) => ({ id: 'event-1', date: '2026-10-06', time: '09:30', title: '散歩の約束', note: '公園で会う', ...patch });
const legacy = () => ({ version: 1, settings: { wakeTarget: '07:00' }, wake: { '2026-10-05': '06:45' },
  runs: [{ id: 'run-1', date: '2026-10-04', distanceKm: 2.5, durationSec: 1200, note: '川沿い', points: [{ lat: 35, lon: 139, segment: 0, time: '2026-10-04T07:00:00.000Z' }] }],
  habits: [{ id: 'water', name: '水を飲む', type: 'number', unit: '杯', target: 3, archived: true }],
  habitLogs: { water: { '2026-10-03': 0, '2026-10-04': 2, '2026-10-05': 3 } } });

test('v1 migrates in memory to v2 without mutating or dropping any legacy records', () => {
  const before = legacy(), snapshot = structuredClone(before), migrated = validateState(before);
  assert.equal(STATE_VERSION, 2);
  assert.equal(migrated.version, 2);
  for (const key of ['settings', 'wake', 'runs', 'habits', 'habitLogs']) assert.deepEqual(migrated[key], before[key]);
  assert.deepEqual(migrated.events, []);
  assert.deepEqual(migrated.diary, {});
  assert.deepEqual(migrated.garden, { plant: 'cosmos', theme: 'day' });
  migrated.runs[0].points[0].lat = 0;
  migrated.habitLogs.water['2026-10-05'] = 99;
  assert.deepEqual(before, snapshot);
});

test('v1 storage key stays unchanged and loading never rewrites an original', () => {
  const original = JSON.stringify(legacy());
  let saved = original, writes = 0;
  const storage = { getItem(key) { assert.equal(key, 'rhythm.personal.v1'); return saved; }, setItem(key, value) { assert.equal(key, STORAGE_KEY); saved = value; writes++; } };
  const loaded = readState(storage);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.state.version, 2);
  assert.equal(writes, 0);
  assert.equal(saved, original);
  assert.equal(writeState(loaded.state, storage).ok, true);
  assert.equal(writes, 1);
  assert.equal(JSON.parse(saved).version, 2);
});

test('unreadable and malformed originals are not overwritten while loading or validating a failed save', () => {
  for (const original of ['{broken', JSON.stringify({ ...legacy(), events: [] }), JSON.stringify({ ...createInitialState(), garden: { plant: 'cosmos', theme: 'day', points: 1000 } })]) {
    let saved = original;
    const storage = { getItem: () => saved, setItem: (_, value) => { saved = value; } };
    assert.equal(readState(storage).ok, false);
    assert.equal(saved, original);
    assert.equal(writeState({ version: 2 }, storage).ok, false);
    assert.equal(saved, original);
  }
});

test('old backups are accepted and newly exported backups are fully versioned v2', () => {
  const imported = parseBackup(JSON.stringify(legacy()));
  const exported = JSON.parse(serializeBackup(imported));
  assert.equal(exported.version, 2);
  assert.deepEqual(parseBackup(JSON.stringify(exported)), imported);
});

test('strict version boundaries reject unknown fields rather than silently dropping them', () => {
  for (const key of ['events', 'diary', 'garden', 'extra']) assert.throws(() => validateState({ ...legacy(), [key]: key === 'events' ? [] : {} }));
  assert.throws(() => validateState({ ...createInitialState(), version: 3 }));
  for (const key of ['events', 'diary', 'garden']) {
    const state = createInitialState();
    delete state[key];
    assert.throws(() => validateState(state));
  }
  assert.throws(() => validateState({ ...createInitialState(), calendarEvents: [] }));
});

test('a date supports multiple independent events and immutable editing and deletion', () => {
  const original = createInitialState();
  const first = upsertEvent(original, event());
  const second = upsertEvent(first, event({ id: 'event-2', time: null, title: '本を返す' }));
  assert.deepEqual(original.events, []);
  assert.equal(second.events.length, 2);
  const edited = upsertEvent(second, event({ title: '変更した約束', date: '2026-10-07' }));
  assert.equal(edited.events.length, 2);
  assert.equal(second.events[0].title, '散歩の約束');
  assert.equal(edited.events.find((item) => item.id === 'event-1').date, '2026-10-07');
  const removed = removeEvent(edited, 'event-1');
  assert.deepEqual(removed.events.map((item) => item.id), ['event-2']);
  assert.equal(edited.events.length, 2);
});

test('events canonicalize optional time and note and allow future planning through 2200', () => {
  const state = upsertEvent(createInitialState(), { id: 'future', date: '2200-12-31', title: '未来の予定' });
  assert.deepEqual(state.events[0], { id: 'future', date: '2200-12-31', time: null, title: '未来の予定', note: '' });
  assert.throws(() => upsertEvent(state, event({ date: '2201-01-01' })));
});

test('invalid event dates, times, titles, identifiers, extras, and duplicates are rejected', () => {
  for (const patch of [{ date: '2026-02-29' }, { time: '9:30' }, { time: '24:00' }, { time: 930 }, { title: '' }, { title: '  ' }, { title: null }, { id: '__proto__' }, { id: 'a b' }, { note: 1 }, { repeat: true }]) {
    assert.throws(() => upsertEvent(createInitialState(), event(patch)));
  }
  assert.throws(() => validateState({ ...createInitialState(), events: [event(), event()] }));
  assert.throws(() => upsertEvent(createInitialState(), null));
});

test('event note and diary capacities count code points and preserve Japanese and emoji', () => {
  const exact = event({ title: '🌼'.repeat(LIMITS.eventTitle), note: '🌿'.repeat(LIMITS.eventNote) });
  let state = upsertEvent(createInitialState(), exact);
  state = upsertDiary(state, '2026-10-06', { text: '🌸'.repeat(LIMITS.diaryText), mood: 'bright' });
  assert.deepEqual(parseBackup(serializeBackup(state)), state);
  assert.throws(() => upsertEvent(state, event({ title: '🌼'.repeat(LIMITS.eventTitle + 1) })));
  assert.throws(() => upsertEvent(state, event({ note: 'あ'.repeat(LIMITS.eventNote + 1) })));
  assert.throws(() => upsertDiary(state, '2026-10-06', { text: '🌸'.repeat(LIMITS.diaryText + 1) }));
});

test('a full v2 journal still enforces serialized UTF-8 byte capacity', () => {
  const state = createInitialState();
  state.events = Array.from({ length: 2100 }, (_, i) => event({ id: `event-${i}`, note: 'あ'.repeat(2000) }));
  assert.equal(validateState(state).events.length, 2100);
  const compact = JSON.stringify(state);
  assert.ok(compact.length < LIMITS.backupChars);
  assert.ok(new TextEncoder().encode(compact).byteLength > LIMITS.backupBytes);
  assert.throws(() => serializeBackup(state), /12MiB/);
  assert.throws(() => parseBackup(compact), /12MiB/);
});

test('diary has one entry per date, updates losslessly, and can be removed or restored', () => {
  const text = '今日は静かに過ごした。\n<script>alert("x")</script>';
  const before = createInitialState();
  const first = upsertDiary(before, '2026-10-06', { text, mood: 'calm' });
  const edited = upsertDiary(first, '2026-10-06', { text: '追記', mood: 'tired' });
  assert.deepEqual(before.diary, {});
  assert.equal(Object.keys(edited.diary).length, 1);
  assert.equal(first.diary['2026-10-06'].text, text);
  assert.deepEqual(removeDiary(edited, '2026-10-06').diary, {});
  assert.equal(edited.diary['2026-10-06'].text, '追記');
  assert.deepEqual(parseBackup(serializeBackup(first)), first);
});

test('diary accepts optional mood and future dates, rejects unsupported mood and unknown fields', () => {
  assert.deepEqual(upsertDiary(createInitialState(), '2200-12-31', { text: '' }).diary['2200-12-31'], { text: '', mood: null });
  for (const mood of DIARY_MOODS) assert.equal(upsertDiary(createInitialState(), '2026-10-06', { text: '記録', mood }).diary['2026-10-06'].mood, mood);
  for (const entry of [{ text: 'x', mood: 'unknown' }, { text: 'x', mood: false }, { text: 'x', reward: 1 }, { text: 1 }, {}]) {
    assert.throws(() => upsertDiary(createInitialState(), '2026-10-06', entry));
  }
  assert.throws(() => upsertDiary(createInitialState(), '2026-02-30', { text: 'x' }));
});

test('journal unknown fields and prototype pollution keys are rejected at each nested layer', () => {
  const state = { ...createInitialState(), events: [event()], diary: { '2026-10-06': { text: '日記', mood: null } } };
  for (const mutate of [
    (s) => { s.events[0].extra = 'x'; },
    (s) => { s.diary['2026-10-06'].extra = 'x'; },
    (s) => { s.garden.totalDays = 100; },
  ]) {
    const invalid = structuredClone(state); mutate(invalid);
    assert.throws(() => validateState(invalid));
  }
  const source = serializeBackup(state);
  assert.throws(() => parseBackup(source.replace('"diary": {', '"diary": {"__proto__":{},')));
  assert.throws(() => parseBackup(source.replace('"garden": {', '"garden": {"constructor":{},')));
  assert.throws(() => parseBackup(source.replace('"title":', '"prototype":{},"title":')));
  assert.equal({}.polluted, undefined);
});

test('garden preferences are validated, detached, and preserve currently locked selections', () => {
  for (const plant of GARDEN_PLANTS) for (const theme of GARDEN_THEMES) {
    const state = { ...createInitialState(), garden: { plant: plant.id, theme: theme.id } };
    const copy = parseBackup(serializeBackup(state));
    assert.deepEqual(copy.garden, state.garden);
    copy.garden.theme = 'night';
    assert.equal(state.garden.theme, theme.id);
  }
  for (const garden of [{ plant: 'oak', theme: 'day' }, { plant: 'cosmos', theme: 'winter' }, { plant: 'cosmos', theme: 'day', rewards: 1 }, {}, null]) {
    assert.throws(() => validateState({ ...createInitialState(), garden }));
  }
});

test('journal collections have bounded counts', () => {
  assert.throws(() => validateState({ ...createInitialState(), events: Array.from({ length: LIMITS.events + 1 }, (_, i) => event({ id: `event-${i}` })) }));
  assert.throws(() => validateState({ ...createInitialState(), events: {} }));
  assert.throws(() => validateState({ ...createInitialState(), diary: [] }));
});
