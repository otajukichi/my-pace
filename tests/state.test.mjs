import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, createStore, localDate, weekDates, weekStart } from '../lib/state.js';

const KEY = 'mypace.studio.v1';
function memoryStorage(entries = []) {
  const data = new Map(entries);
  const reads = [];
  const writes = [];
  return {
    data, reads, writes,
    getItem(key) { reads.push(key); return data.get(key) ?? null; },
    setItem(key, value) { writes.push(key); data.set(key, String(value)); },
  };
}

test('JST dates and Monday weeks cross UTC, month, year, and leap-day boundaries', () => {
  assert.equal(localDate(new Date('2026-11-06T14:59:59.999Z')), '2026-11-06');
  assert.equal(localDate(new Date('2026-11-06T15:00:00.000Z')), '2026-11-07');
  assert.equal(localDate(new Date('2025-12-31T15:00:00.000Z')), '2026-01-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  assert.equal(weekStart('2026-01-04'), '2025-12-29');
  assert.equal(weekStart('2026-01-05'), '2026-01-05');
  assert.deepEqual(weekDates('2026-01-01'), [
    '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04',
  ]);
  assert.throws(() => addDays('2025-02-29', 1));
  assert.throws(() => addDays('2026-11-07', 0.5));
  assert.throws(() => localDate(new Date('invalid')));
});

test('reload restores plans, notes, checks, preferences, and literal user text', () => {
  const storage = memoryStorage();
  const store = createStore({ storage });
  const text = '<script>alert("hello")</script> & 雨のラン 🏃';
  store.update(state => {
    state.goals.weeklyRuns = 4;
    state.plans.push({ id: 'p1', date: '2026-11-07', title: '朝のラン', minutes: 20, kind: 'run', completed: false });
    state.notes.push({ id: 'n1', date: '2026-11-07', text, mood: 'good', runId: 'run-1' });
    state.checks['2026-11-07'] = ['stretch'];
    state.runMeta['run-1'] = { favorite: true, mood: 'good', note: text };
    state.settings.mapStyle = 'street';
  });
  const reloaded = createStore({ storage });
  assert.deepEqual(reloaded.get(), store.get());
  assert.equal(reloaded.get().notes[0].text, text);
  assert.deepEqual(JSON.parse(store.exportJSON()), store.get());
  assert.deepEqual(reloaded.status(), { available: true, error: null });
});

test('reads and writes only the selected namespace, never legacy keys', () => {
  const storage = memoryStorage([['mypace', '{"legacy":true}'], ['my-pace.v1', 'precious old data']]);
  const store = createStore({ storage });
  assert.deepEqual(storage.reads, [KEY]);
  assert.deepEqual(storage.writes, []);
  store.update(state => { state.profile.name = 'New'; });
  assert.deepEqual(storage.writes, [KEY]);
  assert.equal(storage.data.get('mypace'), '{"legacy":true}');
  assert.equal(storage.data.get('my-pace.v1'), 'precious old data');
  const second = createStore({ storage, key: 'mypace.studio.test' });
  second.update(state => { state.profile.name = 'Other'; });
  assert.equal(createStore({ storage }).get().profile.name, 'New');
});

test('unknown and corrupt persisted schemas stay untouched despite memory edits', () => {
  const valid = createStore({ storage: memoryStorage() }).get();
  const cases = [
    '{broken', '', 'null', JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, futureFeature: true }),
    JSON.stringify({ ...valid, goals: { weeklyRuns: -1, monthlyKm: 30 } }),
    JSON.stringify({ ...valid, notes: [{ id: 'n1', date: '2026-02-30', text: 'x', mood: '' }] }),
  ];
  for (const raw of cases) {
    const storage = memoryStorage([[KEY, raw]]);
    const store = createStore({ storage });
    assert.equal(store.status().available, false);
    assert.ok(store.status().error);
    store.update(state => { state.profile.name = 'Memory only'; });
    assert.equal(store.get().profile.name, 'Memory only');
    assert.equal(storage.data.get(KEY), raw);
    assert.deepEqual(storage.writes, []);
    assert.equal(JSON.parse(store.exportJSON()).profile.name, 'Memory only');
  }
});

test('save failure keeps edits, notifies subscribers, and retries on a later update', () => {
  const storage = memoryStorage();
  const store = createStore({ storage });
  store.update(state => { state.profile.name = 'Saved'; });
  const setItem = storage.setItem.bind(storage);
  storage.setItem = () => { throw new Error('Quota exceeded'); };
  let notification;
  store.subscribe((state, status) => { notification = { state, status }; });
  const updated = store.update(state => { state.profile.name = 'Unsaved'; });
  assert.equal(updated.profile.name, 'Unsaved');
  assert.equal(store.get().profile.name, 'Unsaved');
  assert.equal(notification.state.profile.name, 'Unsaved');
  assert.equal(notification.status.available, false);
  assert.ok(notification.status.error);
  assert.equal(JSON.parse(storage.data.get(KEY)).profile.name, 'Saved');
  storage.setItem = setItem;
  store.update(state => { state.goals.monthlyKm = 45; });
  assert.deepEqual(store.status(), { available: true, error: null });
  assert.equal(JSON.parse(storage.data.get(KEY)).profile.name, 'Unsaved');
});

test('blocked storage and failed initial reads allow memory editing without overwriting', () => {
  for (const storage of [null, {
    getItem() { throw new Error('Access denied'); },
    setItem() { assert.fail('Must not overwrite after a failed initial read'); },
  }]) {
    const store = createStore({ storage });
    assert.equal(store.status().available, false);
    store.update(state => { state.goals.monthlyKm = 40; });
    assert.equal(store.get().goals.monthlyKm, 40);
    assert.ok(store.status().error);
  }
});

test('snapshots, drafts, subscribers, and exported JSON cannot mutate stored state', () => {
  const store = createStore({ storage: memoryStorage() });
  const first = store.get();
  first.habits[0].name = 'Changed outside';
  let retainedDraft;
  const result = store.update(state => { retainedDraft = state; state.profile.name = 'A'; });
  retainedDraft.profile.name = 'Changed draft';
  result.profile.name = 'Changed result';
  assert.equal(store.get().profile.name, 'A');
  assert.equal(store.get().habits[0].name, 'ストレッチ');
  let count = 0;
  const stop = store.subscribe(state => { state.profile.name = 'Changed listener'; count++; });
  store.update(state => { state.profile.name = 'B'; });
  stop();
  store.update(state => { state.profile.name = 'C'; });
  assert.equal(count, 1);
  assert.equal(store.get().profile.name, 'C');
});

test('invalid edits and prototype pollution fail atomically', () => {
  const storage = memoryStorage();
  const store = createStore({ storage });
  const before = store.get();
  const edits = [
    state => { state.goals.weeklyRuns = NaN; },
    state => { state.goals.monthlyKm = -1; },
    state => { state.runMeta.constructor = { favorite: true }; },
    state => { Object.setPrototypeOf(state.checks, { polluted: true }); },
    state => { state.notes.push({ id: '__proto__', date: '2026-11-07', text: '', mood: '' }); },
    state => { state.plans.push({ id: 'p1', date: '2026-11-07', title: 'Run', minutes: 20, kind: 'fly', completed: false }); },
    state => { state.habits.length = 4; },
  ];
  for (const edit of edits) {
    assert.throws(() => store.update(edit));
    assert.deepEqual(store.get(), before);
    assert.deepEqual(storage.writes, []);
  }
  const poisoned = JSON.stringify(before).replace('"checks":{}', '"checks":{"__proto__":{"polluted":true}}');
  const poisonedStorage = memoryStorage([[KEY, poisoned]]);
  const poisonedStore = createStore({ storage: poisonedStorage });
  assert.equal(poisonedStore.status().available, false);
  poisonedStore.update(state => { state.profile.name = 'Safe memory edit'; });
  assert.equal(poisonedStorage.data.get(KEY), poisoned);
  assert.equal({}.polluted, undefined);
});
