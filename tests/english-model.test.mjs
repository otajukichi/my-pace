import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGLISH_AREAS, ENGLISH_MODES, DEFAULT_CATALOG, ENGLISH_STORAGE_KEY,
  validateCatalog, validatePracticeRecord, normalizeFolderId, activeCatalog,
  createEnglishStore, progressFor, modeAvailable, buildStartText, EnglishStorageError,
} from '../lib/english-model.js';

const iso = '2026-11-20T12:00:00.000Z';
const folderId = 'test-private-folder-id';
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const values = new Map();
  let failed = false;
  let serial = 0;
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { if (failed) throw new Error('quota'); values.set(key, value); },
  };
  return {
    values, storage, fail: value => { failed = value; },
    options: { storage, now: () => new Date(iso), uuid: () => `test-session-${++serial}` },
  };
}
function record(themeId, index, extra = {}) {
  const theme = DEFAULT_CATALOG.materials.find(item => item.id === themeId);
  return { schema: 1, sessionId: `session-${index}`, performedAt: iso, kind: theme.kind, areaId: theme.areaId, themeId, modeId: theme.kind === 'reading' ? 'reading' : 'scene', origin: 'manual', ...extra };
}

test('eight independent areas, all modes and metadata-only reading examples', () => {
  assert.deepEqual(ENGLISH_AREAS.map(area => area.id), ['people', 'daily', 'culture', 'services', 'travel', 'ideas', 'problems', 'work']);
  assert.equal(DEFAULT_CATALOG.sample, true);
  assert.deepEqual(validateCatalog(DEFAULT_CATALOG), DEFAULT_CATALOG);
  for (const area of ENGLISH_AREAS) assert.equal(DEFAULT_CATALOG.materials.filter(item => item.areaId === area.id).length, 3);
  assert.equal(DEFAULT_CATALOG.materials.filter(item => item.kind === 'reading').length, 5);
  assert.deepEqual(progressFor([]).unlockedModes, ['scene']);
  assert.equal(modeAvailable('reading', []), true);
  assert.equal(modeAvailable('unknown', []), false);
});

test('catalog import rejects scenario bodies, arbitrary keys, invalid IDs and unsafe prototypes', () => {
  const material = clone(DEFAULT_CATALOG.materials[0]);
  const catalog = { schema: 1, materials: [material] };
  assert.equal(validateCatalog(catalog).sample, false);
  assert.throws(() => validateCatalog({ ...catalog, body: 'hidden content' }));
  assert.throws(() => validateCatalog({ ...catalog, materials: [{ ...material, scenario: 'Do not show this' }] }));
  assert.throws(() => validateCatalog({ ...catalog, materials: [{ ...material, id: '../another-file' }] }));
  assert.throws(() => validateCatalog({ ...catalog, materials: [{ ...material, description: 'a'.repeat(201) }] }));
  assert.throws(() => validateCatalog({ ...catalog, materials: [{ ...material, fileId: 'https://example.com/file' }] }));
  assert.throws(() => validateCatalog({ ...catalog, materials: [{ ...material, kind: 'reading' }] }));
  assert.throws(() => validateCatalog({ ...catalog, materials: [material, material] }));
  assert.throws(() => validateCatalog(JSON.parse('{"schema":1,"materials":[],"__proto__":{}}')));
  const withGetter = { ...material };
  Object.defineProperty(withGetter, 'description', { get: () => { throw new Error('must not run'); } });
  assert.throws(() => validateCatalog({ ...catalog, materials: [withGetter] }), /英会話データ/);
});

test('catalog can grow without code edits but remains bounded', () => {
  const material = DEFAULT_CATALOG.materials[0];
  const materials = Array.from({ length: 5000 }, (_, index) => ({ ...material, id: `theme-${index}` }));
  assert.equal(validateCatalog({ schema: 1, materials }).materials.length, 5000);
  assert.throws(() => validateCatalog({ schema: 1, materials: [...materials, { ...material, id: 'one-too-many' }] }));
  assert.throws(() => validateCatalog(' '.repeat(3000001)));
});

test('folder settings accept known Drive folder URLs and reject unrelated origins', () => {
  assert.equal(normalizeFolderId(folderId), folderId);
  assert.equal(normalizeFolderId(`https://drive.google.com/drive/u/1/folders/${folderId}?usp=sharing`), folderId);
  assert.equal(normalizeFolderId('  '), '');
  assert.throws(() => normalizeFolderId(`https://drive.google.com.evil.invalid/drive/folders/${folderId}`));
  assert.throws(() => normalizeFolderId(`https://user:pass@drive.google.com/drive/folders/${folderId}`));
  assert.throws(() => normalizeFolderId('../private'));
});

test('pending, copy and cancel do not add practice; completion is factual and idempotent', () => {
  const { options, values } = fixture();
  const store = createEnglishStore(options);
  assert.equal(activeCatalog(store.get()), DEFAULT_CATALOG);
  store.configure({ folderId });
  const pending = store.start({ materialId: 'first-hello', mode: 'scene' });
  assert.equal(progressFor(store.get().records).totalSessions, 0);
  assert.deepEqual(store.start({ materialId: 'first-hello', mode: 'scene' }), pending);
  const prompt = buildStartText({ session: pending, material: DEFAULT_CATALOG.materials[0], folderId });
  assert.ok(prompt.includes(pending.sessionId));
  assert.equal(store.get().records.length, 0);
  const completed = store.complete(pending.sessionId);
  assert.deepEqual(store.complete(pending.sessionId), completed);
  assert.equal(store.get().records.length, 1);
  assert.equal(completed.origin, 'manual');
  assert.equal(store.status().scope, 'local');
  assert.equal(store.get().pending, null);
  const reading = store.start({ materialId: 'reading-research', mode: 'reading' });
  assert.equal(store.cancel(reading.sessionId), true);
  assert.equal(store.cancel(reading.sessionId), false);
  assert.equal(store.get().records.length, 1);
  assert.deepEqual([...values.keys()], [ENGLISH_STORAGE_KEY]);
  assert.deepEqual(createEnglishStore(options).get(), store.get());
});

test('revisits are allowed; repeating one theme and reading cannot farm conversation modes', () => {
  const repeated = Array.from({ length: 20 }, (_, index) => record('first-hello', index));
  const reading = Array.from({ length: 20 }, (_, index) => record('reading-phrases', index + 20));
  const progress = progressFor([...repeated, ...reading]);
  assert.equal(progress.totalSessions, 40);
  assert.equal(progress.conversationSessions, 20);
  assert.equal(progress.readingSessions, 20);
  assert.equal(progress.distinctThemes, 1);
  assert.equal(progress.distinctAreas, 1);
  assert.deepEqual(progress.unlockedModes, ['scene']);
  assert.equal(progress.modes[1].remaining.themes, 2);
  assert.equal(progress.perArea.people.sessions, 20);
  assert.equal(progress.perArea.people.distinctThemes, 1);
  assert.equal(progress.distinctDays, 1);
});

test('varied practice unlocks additional modes and keeps lower modes accessible', () => {
  const themes = ['first-hello', 'weekend-stories', 'favorite-film', 'cafe-order', 'hotel-checkin', 'different-view', 'ask-for-help', 'explain-research'];
  const records = themes.map((theme, index) => record(theme, index));
  assert.deepEqual(progressFor(records.slice(0, 3)).unlockedModes, ['scene', 'topic']);
  assert.deepEqual(progressFor(records).unlockedModes, ['scene', 'topic', 'free']);
  const alternate = clone(ENGLISH_MODES);
  alternate[1].requirements.sessions = 10;
  assert.equal(modeAvailable('topic', records, alternate), false);
  assert.equal(progressFor([...records, records[0]]).totalSessions, 8);
  assert.throws(() => progressFor([...records, { ...records[0], themeId: 'another-theme' }]));
});

test('store enforces mode access and keeps pending practice independent from catalog edits', () => {
  const { options } = fixture();
  const store = createEnglishStore(options);
  assert.throws(() => store.start({ materialId: 'first-hello', mode: 'free' }), /解放/);
  assert.throws(() => store.start({ materialId: 'first-hello', mode: 'reading' }));
  const pending = store.start({ materialId: 'first-hello', mode: 'scene' });
  store.setCatalog({ schema: 1, materials: [] });
  store.complete(pending.sessionId);
  assert.equal(store.get().records[0].themeId, 'first-hello');
  assert.throws(() => store.start({ materialId: 'first-hello', mode: 'scene' }), /見つかりません/);
});

test('storage failure leaves records and pending state unchanged and reports failure honestly', () => {
  const env = fixture();
  const store = createEnglishStore(env.options);
  const pending = store.start({ materialId: 'first-hello', mode: 'scene' });
  const saved = env.values.get(ENGLISH_STORAGE_KEY);
  env.fail(true);
  assert.throws(() => store.complete(pending.sessionId), EnglishStorageError);
  assert.equal(store.get().records.length, 0);
  assert.equal(store.get().pending.sessionId, pending.sessionId);
  assert.equal(env.values.get(ENGLISH_STORAGE_KEY), saved);
  assert.equal(store.status().persistent, false);
  assert.match(store.status().error, /変更は記録されていません/);
  env.fail(false);
  store.complete(pending.sessionId);
  assert.equal(store.status().persistent, true);
  assert.equal(store.get().records.length, 1);
});

test('corrupt local data is preserved instead of silently overwritten', () => {
  const env = fixture();
  env.values.set(ENGLISH_STORAGE_KEY, '{broken');
  const store = createEnglishStore(env.options);
  assert.equal(store.status().readOnly, true);
  assert.throws(() => store.configure({ folderId }), EnglishStorageError);
  assert.equal(env.values.get(ENGLISH_STORAGE_KEY), '{broken');
  assert.equal(createEnglishStore({ storage: null }).status().persistent, false);
});

test('history backup merges idempotently without replacing folder or unrelated app storage', () => {
  const env = fixture();
  const store = createEnglishStore(env.options);
  store.configure({ folderId });
  const pending = store.start({ materialId: 'first-hello', mode: 'scene' });
  store.complete(pending.sessionId);
  const backup = store.exportJSON();
  assert.ok(!backup.includes(folderId));
  assert.deepEqual(store.importJSON(backup), { added: 0, total: 1 });
  const imported = JSON.parse(backup);
  imported.records[0].themeId = 'conflicting-theme';
  assert.throws(() => store.importJSON(JSON.stringify(imported)), /conflicting/);
  assert.equal(store.get().records[0].themeId, 'first-hello');
  assert.equal(store.get().settings.folderId, folderId);
  assert.throws(() => store.importJSON(JSON.stringify({ ...JSON.parse(backup), settings: { folderId: 'different-folder-id' } })));
  const target = createEnglishStore(fixture().options);
  assert.deepEqual(target.importJSON(backup), { added: 1, total: 1 });
});

test('receipts are minimal, mode-checked and optionally verified against known metadata', () => {
  const receipt = record('first-hello', 1);
  assert.deepEqual(validatePracticeRecord(receipt, { catalog: DEFAULT_CATALOG }), receipt);
  assert.throws(() => validatePracticeRecord({ ...receipt, transcript: 'private conversation' }));
  assert.throws(() => validatePracticeRecord({ ...receipt, themeId: 'unknown-theme' }, { catalog: DEFAULT_CATALOG }));
  assert.throws(() => validatePracticeRecord({ ...receipt, areaId: 'work' }, { catalog: DEFAULT_CATALOG }));
  assert.throws(() => validatePracticeRecord({ ...receipt, modeId: 'reading' }));
  assert.throws(() => validatePracticeRecord({ ...receipt, performedAt: '2026-02-31T12:00:00.000Z' }));
  assert.throws(() => validatePracticeRecord({ ...receipt, origin: 'google-drive-saved' }));
});

test('starter references private materials without including their metadata prose or claiming access', () => {
  const store = createEnglishStore(fixture().options);
  const session = store.start({ materialId: 'first-hello', mode: 'scene' });
  const material = { ...DEFAULT_CATALOG.materials[0], fileId: 'example-material-file-id' };
  const text = buildStartText({ session, material, folderId });
  assert.ok(text.includes('example-material-file-id'));
  assert.ok(text.includes('読めたふり'));
  assert.ok(text.includes('記録を保存したとは言わない'));
  assert.ok(text.includes('前回の会話を覚えているふりはしない'));
  assert.ok(!text.includes(material.description));
  assert.ok(!text.includes(material.title));
  assert.throws(() => buildStartText({ session, material, folderId: '' }), /設定/);
  assert.throws(() => buildStartText({ session, material: DEFAULT_CATALOG.materials[1], folderId }));
});

test('state snapshots cannot mutate stored state and a failed observer cannot make a save fail', () => {
  const store = createEnglishStore(fixture().options);
  const state = store.get();
  state.settings.folderId = 'mutated-folder-id';
  assert.equal(store.get().settings.folderId, '');
  const unsubscribe = store.subscribe(() => { throw new Error('observer'); });
  assert.doesNotThrow(() => store.configure({ folderId }));
  unsubscribe();
  assert.equal(store.get().settings.folderId, folderId);
});

test('stale stores cannot overwrite records written by another tab or same-window store', () => {
  const env = fixture();
  const first = createEnglishStore(env.options);
  const stale = createEnglishStore(env.options);
  first.complete(first.start({ materialId: 'first-hello', mode: 'scene' }).sessionId);
  const saved = env.values.get(ENGLISH_STORAGE_KEY);
  assert.throws(() => stale.configure({ folderId }), /別の画面/);
  assert.equal(env.values.get(ENGLISH_STORAGE_KEY), saved);
  assert.equal(stale.status().readOnly, true);
  assert.equal(stale.status().persistent, false);
  assert.throws(() => stale.start({ materialId: 'weekend-stories', mode: 'scene' }), EnglishStorageError);
  const fresh = createEnglishStore(env.options);
  assert.equal(fresh.get().records.length, 1);
  fresh.configure({ folderId });
  assert.equal(fresh.get().records.length, 1);
  assert.equal(fresh.get().settings.folderId, folderId);
  assert.equal(fresh.status().persistent, true);
});

test('every mutating API rejects stale snapshots, including idempotent shortcuts', () => {
  for (const name of ['configure', 'setCatalog', 'start', 'complete', 'cancel', 'importJSON']) {
    const env = fixture();
    const original = createEnglishStore(env.options);
    const pending = original.start({ materialId: 'first-hello', mode: 'scene' });
    const stale = createEnglishStore(env.options);
    original.complete(pending.sessionId);
    const saved = env.values.get(ENGLISH_STORAGE_KEY);
    const actions = {
      configure: () => stale.configure({ folderId }),
      setCatalog: () => stale.setCatalog(DEFAULT_CATALOG),
      start: () => stale.start({ materialId: 'first-hello', mode: 'scene' }),
      complete: () => stale.complete(pending.sessionId),
      cancel: () => stale.cancel(pending.sessionId),
      importJSON: () => stale.importJSON(stale.exportJSON()),
    };
    assert.throws(actions[name], EnglishStorageError, name);
    assert.equal(env.values.get(ENGLISH_STORAGE_KEY), saved, name);
    assert.equal(createEnglishStore(env.options).get().records.length, 1, name);
  }
});

test('the immediate prewrite guard catches a change made during session creation', () => {
  const env = fixture();
  const other = createEnglishStore(env.options);
  const store = createEnglishStore({
    ...env.options,
    uuid() {
      other.configure({ folderId });
      return 'callback-session';
    },
  });
  assert.throws(() => store.start({ materialId: 'first-hello', mode: 'scene' }), /別の画面/);
  const persisted = createEnglishStore(env.options).get();
  assert.equal(persisted.settings.folderId, folderId);
  assert.equal(persisted.pending, null);
});

test('a read failure before writing preserves saved data and can be retried', () => {
  const env = fixture();
  const store = createEnglishStore(env.options);
  store.configure({ folderId });
  const saved = env.values.get(ENGLISH_STORAGE_KEY), read = env.storage.getItem;
  env.storage.getItem = () => { throw new Error('temporarily blocked'); };
  assert.throws(() => store.configure({ folderId: 'new-example-folder' }), EnglishStorageError);
  assert.equal(env.values.get(ENGLISH_STORAGE_KEY), saved);
  assert.equal(store.status().readOnly, false);
  env.storage.getItem = read;
  store.configure({ folderId: 'new-example-folder' });
  assert.equal(store.get().settings.folderId, 'new-example-folder');
  assert.equal(store.status().persistent, true);
});
