import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { GoogleDriveError } from '../src/lib/google-drive.js';
import { createInitialState, upsertDiary } from '../src/lib/domain.js';
import { DriveSyncCoordinator, DriveSyncError, SYNC_FORMAT, SYNC_LIMITS, SYNC_STORAGE_PREFIX,
  hashState, createSnapshotEnvelope, parseSnapshot, analyzeSnapshots, snapshotAppProperties, parseSnapshotMetadata } from '../src/lib/drive-sync.js';

class MemoryStorage {
  constructor() { this.values = new Map(); this.failWrite = false; this.failRemove = false; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.failWrite) throw new Error('QuotaExceededError'); this.values.set(key, String(value)); }
  removeItem(key) { if (this.failRemove) throw new Error('Storage error'); this.values.delete(key); }
}
class Locks {
  constructor() { this.queues = new Map(); }
  request(name, options, callback) {
    assert.equal(options.mode, 'exclusive');
    const result = (this.queues.get(name) ?? Promise.resolve()).then(callback);
    this.queues.set(name, result.catch(() => {})); return result;
  }
}
class Timers {
  constructor() { this.jobs = new Map(); this.sequence = 0; }
  set = (fn) => { const id = ++this.sequence; this.jobs.set(id, fn); return id; };
  clear = (id) => this.jobs.delete(id);
  async run() { const jobs = [...this.jobs.values()]; this.jobs.clear(); for (const fn of jobs) await fn(); }
}
class FakeDrive {
  constructor() { this.files = new Map(); this.generated = 0; this.creates = []; this.reads = []; this.onCreate = null; this.onRead = null; this.onList = null; }
  async listSnapshots() {
    if (this.onList) await this.onList();
    return [...this.files].map(([id, f]) => ({ id, name: f.name, appProperties: f.appProperties, size: String(new TextEncoder().encode(f.text).byteLength) }));
  }
  async readSnapshot(id) { this.reads.push(id); if (this.onRead) await this.onRead(id); const file = this.files.get(id); if (!file) throw Object.assign(new Error('Missing'), { status: 404 }); return file.text; }
  async generateId() { return `drive-${++this.generated}`; }
  async createSnapshot(input) {
    this.creates.push(input);
    if (this.onCreate) await this.onCreate(input);
    if (this.files.has(input.id)) throw Object.assign(new Error('Conflict'), { status: 409 });
    this.files.set(input.id, { ...input }); return { id: input.id };
  }
  add(envelope, id = `remote-${envelope.commitId}`) {
    this.files.set(id, { text: JSON.stringify(envelope), name: `mypace-${envelope.commitId}.json`,
      appProperties: snapshotAppProperties(envelope) }); return id;
  }
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const writtenState = (text = '日記') => upsertDiary(createInitialState(), '2026-10-06', { text, mood: 'calm' });
const envelope = (commitId = 'root', parents = [], state = writtenState(), datasetId = 'dataset') => createSnapshotEnvelope({ datasetId, commitId, parentCommitIds: parents, deviceId: 'device', state, createdAt: '2026-10-06T00:00:00.000Z' }, { crypto: webcrypto });
const outboxKey = `${SYNC_STORAGE_PREFIX}:outbox:folder`;
const metaKey = `${SYNC_STORAGE_PREFIX}:meta:folder`;
function fixture(options = {}) {
  const api = options.api ?? new FakeDrive(), storage = options.storage ?? new MemoryStorage(), timers = options.timers ?? new Timers();
  let state = options.state ?? createInitialState();
  const coordinator = new DriveSyncCoordinator({ api, storage, getState: () => state, applyState(candidate) { state = candidate; return true; },
    locks: options.locks === null ? null : options.locks ?? new Locks(), crypto: webcrypto,
    setTimer: timers.set, clearTimer: timers.clear, now: () => new Date('2026-10-06T01:00:00.000Z'), ...options });
  coordinator.connectFolder('folder'); coordinator.setReady(true);
  return { api, storage, timers, coordinator, get state() { return state; }, edit(next, notify = true) { state = next; if (notify) coordinator.notifyLocalChange(); } };
}
const code = (expected) => (error) => { assert.equal(error.code, expected); return true; };

test('strict envelope round-trip uses state SHA-256 independent of object key order', async () => {
  const source = writtenState(), e = await envelope('root', [], source);
  assert.equal(e.hash.length, 64); assert.equal(e.hash, await hashState({ ...source, wake: {} }, webcrypto));
  assert.deepEqual(await parseSnapshot(JSON.stringify(e), { crypto: webcrypto }), e);
  assert.equal(e.syncFormat, SYNC_FORMAT);
});

test('rejects altered content, extra envelope fields, malformed IDs, parent duplication, invalid state, and invalid dates', async () => {
  const e = await envelope();
  for (const changed of [
    { ...e, state: writtenState('改ざん') }, { ...e, accessToken: 'should-never-be-stored' }, { ...e, commitId: '../bad' },
    { ...e, parentCommitIds: ['a', 'a'] }, { ...e, parentCommitIds: ['root'] },
    { ...e, state: { ...e.state, unknown: true } }, { ...e, state: { ...e.state, version: 1 } },
    { ...e, createdAt: '2026-02-31T00:00:00.000Z' }, { ...e, hash: 'x'.repeat(64) },
  ]) await assert.rejects(parseSnapshot(JSON.stringify(changed), { crypto: webcrypto }));
  await assert.rejects(parseSnapshot('{broken', { crypto: webcrypto }), code('INVALID_SNAPSHOT'));
  await assert.rejects(parseSnapshot(' '.repeat(SYNC_LIMITS.snapshotBytes + 1), { crypto: webcrypto }), code('SNAPSHOT_TOO_LARGE'));
});

test('graph detects missing ancestors, duplicate commit IDs, duplicates, cycles, and mixed datasets', async () => {
  const root = await envelope('root'), child = await envelope('child', ['root']);
  const records = (items) => items.map((e, i) => ({ fileId: `file-${i}`, envelope: e }));
  assert.equal(analyzeSnapshots(records([root, child])).status, 'ready');
  assert.deepEqual(analyzeSnapshots(records([root, child])).heads, ['child']);
  assert.equal(analyzeSnapshots(records([child])).issues[0].code, 'MISSING_PARENT');
  assert.equal(analyzeSnapshots(records([root, root])).issues[0].code, 'DUPLICATE_COMMIT');
  assert.equal(analyzeSnapshots([{ fileId: 'same', envelope: root }, { fileId: 'same', envelope: child }]).issues[0].code, 'DUPLICATE_FILE');
  const a = await envelope('a', ['b']), b = await envelope('b', ['a']);
  assert.ok(analyzeSnapshots(records([a, b])).issues.some((issue) => issue.code === 'CYCLE'));
  const other = await envelope('other', [], writtenState(), 'unrelated');
  assert.equal(analyzeSnapshots(records([root, other])).issues[0].code, 'MULTIPLE_DATASETS');
});

test('two heads stay conflicting regardless of creation timestamps', async () => {
  const root = await envelope('root'), a = await envelope('a', ['root']), b = { ...await envelope('b', ['root']), createdAt: '2099-01-01T00:00:00.000Z' };
  const graph = analyzeSnapshots([root, a, b].map((e) => ({ fileId: e.commitId, envelope: e })));
  assert.equal(graph.status, 'conflict'); assert.deepEqual(graph.heads, ['a', 'b']);
});

test('empty startup never uploads; autosave requires manual save/readback then explicit opt-in', async () => {
  const f = fixture();
  assert.equal((await f.coordinator.inspect()).status, 'empty');
  f.coordinator.notifyLocalChange(); await f.timers.run(); assert.equal(f.api.creates.length, 0);
  assert.throws(() => f.coordinator.setAutosave(true), code('AUTOSAVE_NOT_READY'));
  await assert.rejects(f.coordinator.save({ explicit: false }), code('AUTOSAVE_DISABLED'));
  const result = await f.coordinator.save();
  assert.equal(result.verified, true); assert.equal(result.dirty, false); assert.equal(f.api.creates.length, 1);
  assert.equal(f.coordinator.getStatus().autosave, false);
  f.coordinator.setAutosave(true); assert.equal(f.coordinator.getStatus().autosave, true);
});

test('nonempty remote with unknown baseline requires an explicit choice; exact-head resolution retains old history', async () => {
  const f = fixture(); f.api.add(await envelope('existing'));
  assert.equal((await f.coordinator.inspect()).status, 'choice-required');
  await assert.rejects(f.coordinator.save(), code('CHOICE_REQUIRED')); assert.equal(f.api.creates.length, 0);
  await assert.rejects(f.coordinator.save({ resolution: true, expectedHeads: [] }), code('REMOTE_CHANGED'));
  const saved = await f.coordinator.save({ resolution: true, expectedHeads: ['existing'] });
  assert.equal(f.api.files.size, 2);
  assert.deepEqual(JSON.parse(f.api.files.get(saved.fileId).text).parentCommitIds, ['existing']);
});

test('all known heads are parents of explicit conflict resolution and no history is deleted', async () => {
  const f = fixture();
  for (const e of [await envelope('root'), await envelope('a', ['root']), await envelope('b', ['root'])]) f.api.add(e);
  assert.equal((await f.coordinator.inspect()).status, 'conflict');
  await assert.rejects(f.coordinator.save(), code('CHOICE_REQUIRED'));
  const saved = await f.coordinator.save({ resolution: true, expectedHeads: ['b', 'a'] });
  assert.equal(f.api.files.size, 4); assert.deepEqual(JSON.parse(f.api.files.get(saved.fileId).text).parentCommitIds, ['a', 'b']);
  assert.equal((await f.coordinator.inspect()).status, 'ready');
});

test('missing parents and unrelated datasets prevent even explicit resolution', async () => {
  for (const items of [[await envelope('missing-child', ['not-there'])], [await envelope('a'), await envelope('b', [], writtenState(), 'other-dataset')]]) {
    const f = fixture(); items.forEach((e) => f.api.add(e));
    const graph = await f.coordinator.inspect(); assert.equal(graph.status, 'invalid');
    await assert.rejects(f.coordinator.save({ resolution: true, expectedHeads: graph.heads }), code('INVALID_HISTORY')); assert.equal(f.api.creates.length, 0);
  }
});

test('generated Drive ID and exact snapshot are durable before create; failed upload survives reload', async () => {
  const f = fixture({ state: writtenState() });
  f.api.onCreate = async (input) => { const queued = JSON.parse(f.storage.getItem(outboxKey)); assert.equal(queued.fileId, input.id); assert.equal(queued.text, input.text); throw new Error('offline'); };
  await assert.rejects(f.coordinator.save(), /offline/);
  const pending = JSON.parse(f.storage.getItem(outboxKey)); assert.equal(f.api.generated, 1); assert.equal(f.coordinator.getStatus().pendingCount, 1);
  f.api.onCreate = null;
  const reloaded = fixture({ state: f.state, api: f.api, storage: f.storage });
  const saved = await reloaded.coordinator.save();
  assert.equal(saved.retried, true); assert.equal(saved.fileId, pending.fileId); assert.equal(f.api.generated, 1);
  assert.equal(f.storage.getItem(outboxKey), null); assert.equal(f.api.files.size, 1);
});

test('ambiguous success retries same ID, accepts 409 only after exact readback, no duplicate file', async () => {
  const f = fixture({ state: writtenState() }); let first = true;
  f.api.onCreate = async (input) => { if (first) { first = false; f.api.files.set(input.id, { ...input }); throw new Error('connection lost after creation'); } };
  await assert.rejects(f.coordinator.save(), /connection lost/);
  const saved = await f.coordinator.save();
  assert.equal(saved.retried, true); assert.equal(f.api.generated, 1); assert.equal(f.api.creates.length, 2); assert.equal(f.api.files.size, 1);
  assert.equal(f.api.creates[0].text, f.api.creates[1].text);
});

test('409 with mismatching existing content never overwrites or clears the queue', async () => {
  const f = fixture();
  f.api.onCreate = async (input) => { f.api.files.set(input.id, { ...input, text: JSON.stringify(await envelope('unrelated')) }); throw Object.assign(new Error('collision'), { status: 409 }); };
  await assert.rejects(f.coordinator.save(), code('READBACK_MISMATCH'));
  assert.ok(f.storage.getItem(outboxKey)); assert.equal(f.coordinator.getStatus().verified, false);
  assert.equal(JSON.parse(f.api.files.get('drive-1').text).commitId, 'unrelated');
});

test('failed readback and failed post-save listing keep the exact queued record', async () => {
  for (const phase of ['readback', 'list']) {
    const f = fixture();
    if (phase === 'readback') f.api.onRead = async () => { throw new Error('readback unavailable'); };
    else f.api.onList = async () => { if (f.api.files.size) throw new Error('listing unavailable'); };
    await assert.rejects(f.coordinator.save());
    assert.ok(f.storage.getItem(outboxKey)); assert.equal(f.coordinator.getStatus().verified, false);
    f.api.onRead = null; f.api.onList = null;
    await f.coordinator.save(); assert.equal(f.api.generated, 1); assert.equal(f.api.files.size, 1);
  }
});

test('local quota/storage errors prevent remote creation and preserve existing queued retries', async () => {
  const f = fixture(); f.storage.failWrite = true;
  await assert.rejects(f.coordinator.save(), code('STORAGE_WRITE_FAILED')); assert.equal(f.api.creates.length, 0);
  f.storage.failWrite = false;
  f.api.onCreate = async () => { f.storage.failWrite = true; };
  await assert.rejects(f.coordinator.save(), code('STORAGE_WRITE_FAILED'));
  assert.ok(f.storage.getItem(outboxKey)); assert.equal(f.api.files.size, 1); assert.equal(f.coordinator.getStatus().verified, false);
  f.storage.failWrite = false; f.api.onCreate = null; await f.coordinator.save(); assert.equal(f.api.files.size, 1);
});

test('a corrupt pending record or metadata never gets replaced or treated as permission to upload', async () => {
  for (const [key, raw] of [[outboxKey, '{broken'], [metaKey, '{"version":1,"accessToken":"bad"}']]) {
    const f = fixture(); f.storage.setItem(key, raw);
    for (let i = 0; i < 2; i++) await assert.rejects(f.coordinator.save());
    assert.equal(f.storage.getItem(key), raw); assert.equal(f.api.creates.length, 0);
  }
});

test('older upload completion leaves newer local changes dirty and never replaces local state', async () => {
  const f = fixture({ state: writtenState('before') }), started = deferred(), release = deferred();
  f.api.onCreate = async () => { started.resolve(); await release.promise; };
  const saving = f.coordinator.save(); await started.promise;
  f.edit(writtenState('after')); release.resolve(); const result = await saving;
  assert.equal(result.dirty, true); assert.equal(f.coordinator.getStatus().dirty, true); assert.equal(f.state.diary['2026-10-06'].text, 'after');
  assert.equal(JSON.parse(f.api.files.get(result.fileId).text).state.diary['2026-10-06'].text, 'before');
  f.api.onCreate = null; const newer = await f.coordinator.save();
  assert.equal(newer.dirty, false); assert.deepEqual(JSON.parse(f.api.files.get(newer.fileId).text).parentCommitIds, [result.commitId]);
});

test('queued old save retries without claiming newer content is saved', async () => {
  const f = fixture({ state: writtenState('queued') }); f.api.onCreate = async () => { throw new Error('offline'); };
  await assert.rejects(f.coordinator.save()); f.edit(writtenState('newer')); f.api.onCreate = null;
  const saved = await f.coordinator.save(); assert.equal(saved.retried, true); assert.equal(saved.dirty, true);
  assert.equal(JSON.parse(f.api.files.get(saved.fileId).text).state.diary['2026-10-06'].text, 'queued');
});

test('local changes during final history inspection are never marked clean even without notification', async () => {
  const f = fixture({ state: writtenState('before') });
  f.api.onList = async () => { if (f.api.files.size) f.edit(writtenState('after'), false); };
  const saved = await f.coordinator.save(); assert.equal(saved.dirty, true);
});

test('restore validates selection, atomically persists local state, retains Drive history, and leaves autosave off', async () => {
  const f = fixture(); f.api.add(await envelope('remote'));
  const before = await hashState(f.state, webcrypto), loaded = await f.coordinator.load('remote', { expectedLocalHash: before, expectedHeads: ['remote'] });
  assert.deepEqual(f.state, writtenState()); assert.equal(loaded.dirty, false); assert.equal(f.api.creates.length, 0);
  assert.equal(f.api.files.size, 1); assert.equal(f.coordinator.getStatus().autosave, false);
  assert.throws(() => f.coordinator.setAutosave(true), code('AUTOSAVE_NOT_READY'));
});

test('restore aborts if local state changes during the network read', async () => {
  const f = fixture(), started = deferred(), release = deferred(); f.api.add(await envelope('remote'));
  f.api.onRead = async () => { started.resolve(); await release.promise; };
  const loading = f.coordinator.load('remote'); await started.promise; f.edit(writtenState('new local')); release.resolve();
  await assert.rejects(loading, code('LOCAL_CHANGED')); assert.equal(f.state.diary['2026-10-06'].text, 'new local');
  assert.equal(f.storage.getItem(metaKey), null);
});

test('restore failed local persistence leaves baseline untouched', async () => {
  const f = fixture({ applyState: () => false }); f.api.add(await envelope('remote'));
  await assert.rejects(f.coordinator.load('remote'), code('LOCAL_SAVE_FAILED'));
  assert.equal(f.storage.getItem(metaKey), null); assert.equal(f.coordinator.getStatus().dirty, true);
});

test('restoring an older version requires explicit resolution before ordinary saving', async () => {
  const f = fixture(); f.api.add(await envelope('root')); f.api.add(await envelope('new', ['root'], writtenState('new')));
  await f.coordinator.load('root'); await assert.rejects(f.coordinator.save(), code('CONFLICT'));
  const saved = await f.coordinator.save({ resolution: true, expectedHeads: ['new'] });
  assert.deepEqual(JSON.parse(f.api.files.get(saved.fileId).text).parentCommitIds, ['new']); assert.equal(f.api.files.size, 3);
});

test('expected local hash guards manual sends and restores before any external write', async () => {
  const f = fixture(); const confirmed = await hashState(f.state, webcrypto); f.edit(writtenState());
  await assert.rejects(f.coordinator.save({ expectedLocalHash: confirmed }), code('LOCAL_CHANGED')); assert.equal(f.api.creates.length, 0);
  f.api.add(await envelope('remote'));
  await assert.rejects(f.coordinator.load('remote', { expectedLocalHash: confirmed }), code('LOCAL_CHANGED'));
});

test('changes while waiting for an origin lock or preflight invalidate a confirmed manual send', async () => {
  const locks = new Locks(), gate = deferred(), entered = deferred();
  const held = locks.request(`${SYNC_STORAGE_PREFIX}:lock:folder`, { mode: 'exclusive' }, async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  const f = fixture({ locks }); const confirmed = await hashState(f.state, webcrypto);
  const saving = f.coordinator.save({ expectedLocalHash: confirmed }); f.edit(writtenState('after confirmation')); gate.resolve(); await held;
  await assert.rejects(saving, code('LOCAL_CHANGED')); assert.equal(f.api.creates.length, 0);
  const g = fixture(); const current = await hashState(g.state, webcrypto); g.api.onList = async () => g.edit(writtenState('after list'));
  await assert.rejects(g.coordinator.save({ expectedLocalHash: current }), code('LOCAL_CHANGED')); assert.equal(g.api.creates.length, 0);
});

test('another remote head arriving after confirmation blocks ordinary or resolution save', async () => {
  const f = fixture(); const root = await f.coordinator.save(); f.edit(writtenState('edit'));
  const existing = JSON.parse(f.api.files.get(root.fileId).text);
  f.api.add(await envelope('external', [root.commitId], writtenState('external'), existing.datasetId));
  await assert.rejects(f.coordinator.save(), code('CONFLICT'));
  await assert.rejects(f.coordinator.save({ resolution: true, expectedHeads: [root.commitId] }), code('REMOTE_CHANGED'));
  assert.equal(f.api.creates.length, 1);
});

test('concurrent immutable remote create is detected after readback, preserving both branches', async () => {
  const f = fixture(); const root = await f.coordinator.save(); f.edit(writtenState('local'));
  const datasetId = JSON.parse(f.api.files.get(root.fileId).text).datasetId;
  f.api.onCreate = async () => f.api.add(await envelope('external', [root.commitId], writtenState('external'), datasetId));
  const result = await f.coordinator.save(); assert.equal(result.conflict, true); assert.equal(f.api.files.size, 3);
  assert.equal(f.coordinator.getStatus().state, 'conflict'); assert.equal(f.coordinator.getStatus().autosave, false);
});

test('two tabs serialize by folder and cannot silently adopt another tab baseline', async () => {
  const api = new FakeDrive(), storage = new MemoryStorage(), locks = new Locks();
  const a = fixture({ api, storage, locks }); const root = await a.coordinator.save();
  const b = fixture({ api, storage, locks }); assert.equal((await b.coordinator.inspect()).status, 'ready');
  a.edit(writtenState('tab A')); b.edit(writtenState('tab B'));
  const saved = await a.coordinator.save(); assert.notEqual(saved.commitId, root.commitId);
  await assert.rejects(b.coordinator.save(), code('CONFLICT')); assert.equal(api.files.size, 2);
});

test('reload reuses baseline only when local contents match; autosave permission never persists', async () => {
  const f = fixture({ state: writtenState() }); await f.coordinator.save(); f.coordinator.setAutosave(true);
  const same = fixture({ state: f.state, api: f.api, storage: f.storage });
  assert.equal((await same.coordinator.inspect()).status, 'ready'); assert.equal(same.coordinator.getStatus().autosave, false); assert.equal(same.coordinator.getStatus().verified, false);
  const changed = fixture({ state: writtenState('unsaved different state'), api: f.api, storage: f.storage });
  assert.equal((await changed.coordinator.inspect()).status, 'choice-required'); await assert.rejects(changed.coordinator.save(), code('CHOICE_REQUIRED'));
});

test('without Web Locks uploads/autosave are blocked but explicit inspected restore is available', async () => {
  const f = fixture({ locks: null }); f.api.add(await envelope('remote'));
  assert.equal((await f.coordinator.inspect()).status, 'choice-required');
  await assert.rejects(f.coordinator.save(), code('LOCKS_REQUIRED'));
  await f.coordinator.load('remote'); assert.deepEqual(f.state, writtenState()); assert.equal(f.storage.getItem(metaKey), null);
  assert.throws(() => f.coordinator.setAutosave(true), code('AUTOSAVE_NOT_READY'));
});

test('disconnect during create retains durable queue and prevents late clean/baseline update', async () => {
  const f = fixture(), started = deferred(), release = deferred();
  f.api.onCreate = async () => { started.resolve(); await release.promise; };
  const saving = f.coordinator.save(); await started.promise; f.coordinator.disconnect(); release.resolve();
  await assert.rejects(saving, code('ABORTED')); assert.ok(f.storage.getItem(outboxKey)); assert.equal(f.storage.getItem(metaKey), null);
  assert.equal(f.coordinator.getStatus().connected, false); assert.equal(f.coordinator.getStatus().verified, false);
  f.api.onCreate = null; f.coordinator.connectFolder('folder'); f.coordinator.setReady(true);
  const result = await f.coordinator.save(); assert.equal(result.retried, true); assert.equal(f.api.files.size, 1);
});

test('disconnect during restore prevents applying remote state', async () => {
  const f = fixture(), started = deferred(), release = deferred(); f.api.add(await envelope('remote'));
  f.api.onRead = async () => { started.resolve(); await release.promise; };
  const loading = f.coordinator.load('remote'); await started.promise; f.coordinator.disconnect(); release.resolve();
  await assert.rejects(loading, code('ABORTED')); assert.deepEqual(f.state, createInitialState());
});

test('history cap fails closed without truncation or writes', async () => {
  const f = fixture(); f.api.listSnapshots = async () => new Array(SYNC_LIMITS.snapshots + 1).fill({ id: 'x' });
  await assert.rejects(f.coordinator.inspect(), code('HISTORY_LIMIT'));
  await assert.rejects(f.coordinator.save(), code('HISTORY_LIMIT')); assert.equal(f.api.creates.length, 0);
});

test('malformed snapshot metadata or corrupted state blocks the entire history', async () => {
  const f = fixture(); const file = f.api.add(await envelope('remote'));
  f.api.files.get(file).appProperties.commitId = 'different';
  assert.equal((await f.coordinator.inspect()).issues[0].code, 'METADATA_MISMATCH');
  await assert.rejects(f.coordinator.save({ resolution: true, expectedHeads: [] }), code('INVALID_HISTORY'));
  await assert.rejects(f.coordinator.load('remote'), code('INVALID_HISTORY'));
});

test('autosave debounces local edits, skips unchanged snapshots, and retains session-only opt-in', async () => {
  const f = fixture(); await f.coordinator.save(); f.coordinator.setAutosave(true);
  f.edit(writtenState('first')); f.edit(writtenState('second'));
  assert.equal(f.timers.jobs.size, 1); await f.timers.run(); assert.equal(f.api.files.size, 2);
  assert.equal(f.coordinator.getStatus().dirty, false); assert.equal(f.coordinator.getStatus().autosave, true);
  f.coordinator.notifyLocalChange(); await f.timers.run(); assert.equal(f.api.files.size, 2);
  assert.equal(f.timers.jobs.size, 0);
});

test('first manual readback of an already-loaded identical head permits opt-in without duplicate upload', async () => {
  const f = fixture(); f.api.add(await envelope('remote')); await f.coordinator.load('remote');
  const result = await f.coordinator.save(); assert.equal(result.unchanged, true); assert.equal(f.api.creates.length, 0);
  f.coordinator.setAutosave(true); assert.equal(f.coordinator.getStatus().autosave, true);
});

test('offline autosave keeps outbox and opt-in; online/resume retries once and then flushes newer edits', async () => {
  const f = fixture(); await f.coordinator.save(); f.coordinator.setAutosave(true);
  f.api.onCreate = async () => { throw new TypeError('Failed to fetch'); };
  f.edit(writtenState('offline snapshot')); await f.timers.run();
  assert.ok(f.storage.getItem(outboxKey)); assert.equal(f.coordinator.getStatus().autosave, true); assert.equal(f.timers.jobs.size, 0);
  f.edit(writtenState('newer while offline')); f.api.onCreate = null;
  await f.timers.run(); assert.equal(f.coordinator.getStatus().dirty, true); assert.equal(f.timers.jobs.size, 1);
  await f.timers.run(); assert.equal(f.coordinator.getStatus().dirty, false); assert.equal(f.api.files.size, 3);
});

test('autosave never starts when hidden/offline, and cancellation clears scheduled work', async () => {
  let visible = false, online = true; const f = fixture({ isVisible: () => visible, isOnline: () => online });
  await f.coordinator.save(); f.coordinator.setAutosave(true); f.edit(writtenState()); assert.equal(f.timers.jobs.size, 0);
  visible = true; online = false; f.coordinator.notifyLocalChange(); assert.equal(f.timers.jobs.size, 0);
  online = true; f.coordinator.notifyLocalChange(); assert.equal(f.timers.jobs.size, 1);
  f.coordinator.setAutosave(false); assert.equal(f.timers.jobs.size, 0);
  f.coordinator.setAutosave(true); assert.equal(f.timers.jobs.size, 1); f.coordinator.disconnect(); assert.equal(f.timers.jobs.size, 0);
});

test('authentication failures and remote conflicts stop autosave', async () => {
  const f = fixture(); await f.coordinator.save(); f.coordinator.setAutosave(true);
  f.api.onCreate = async () => { throw Object.assign(new Error('unauthorized'), { status: 401 }); };
  f.edit(writtenState()); await f.timers.run(); assert.equal(f.coordinator.getStatus().autosave, false); assert.ok(f.storage.getItem(outboxKey));
});

test('oversized upload is blocked before ID allocation/outbox while state remains valid for local backup', async () => {
  const f = fixture(); let state = createInitialState();
  for (let i = 0; i < 640; i++) { const date = new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10); state.diary[date] = { text: 'a'.repeat(8000), mood: null }; }
  f.edit(state);
  await assert.rejects(f.coordinator.save(), code('UPLOAD_TOO_LARGE'));
  assert.equal(f.api.generated, 0); assert.equal(f.api.creates.length, 0); assert.equal(f.storage.getItem(outboxKey), null);
});

test('only strict token-free metadata is persisted and local storage key for domain data stays untouched', async () => {
  const f = fixture(); f.storage.setItem('rhythm.personal.v1', 'sentinel'); await f.coordinator.save();
  const meta = JSON.parse(f.storage.getItem(metaKey));
  assert.deepEqual(Object.keys(meta).sort(), ['version', 'folderId', 'deviceId', 'datasetId', 'baselineCommitId', 'baselineHash'].sort());
  assert.equal(f.storage.getItem('rhythm.personal.v1'), 'sentinel');
  assert.equal([...f.storage.values].some(([key, value]) => key.includes('token') || value.includes('accessToken')), false);
});

test('metadata header mirrors envelope within Google 30-property / 124-byte limits', async () => {
  const e = await envelope('merge', Array.from({ length: 64 }, (_, i) => `parent-${String(i).padStart(3, '0')}-${'a'.repeat(25)}`));
  const props = snapshotAppProperties(e);
  assert.ok(Object.keys(props).length <= 30);
  for (const [key, value] of Object.entries(props)) assert.ok(new TextEncoder().encode(key + value).byteLength <= 124);
  const record = parseSnapshotMetadata({ id: 'file', name: 'mypace-merge.json', appProperties: props });
  assert.deepEqual(record.parentCommitIds, e.parentCommitIds); assert.equal(record.hash, e.hash);
  assert.equal(record.createdAt, e.createdAt);
});

test('metadata rejects missing/extra chunks, noncanonical parents, invalid hashes and oversized properties', async () => {
  const e = await envelope('head', ['parent']); const good = snapshotAppProperties(e);
  for (const bad of [
    { ...good, p01: 'extra' }, { ...good, parentParts: '2' }, { ...good, parentParts: 1 },
    { ...good, stateHash: 'a' }, { ...good, accessToken: 'bad' }, { ...good, p00: '[ "parent" ]' },
    { ...good, datasetId: 'a'.repeat(124) }, { ...good, createdAt: 'yesterday' },
  ]) assert.throws(() => parseSnapshotMetadata({ id: 'file', name: 'mypace-head.json', appProperties: bad }));
  assert.throws(() => snapshotAppProperties({ ...e, parentCommitIds: Array.from({ length: 40 }, (_, i) => `${i}-${'a'.repeat(190)}`) }), code('METADATA_TOO_LARGE'));
});

test('long metadata DAG inspection downloads only active head, selected historical preview/load fetch on demand', async () => {
  const f = fixture(), root = await envelope('c-0');
  for (let i = 0; i < 500; i++) f.api.add({ ...root, commitId: `c-${i}`, parentCommitIds: i ? [`c-${i - 1}`] : [] });
  const graph = await f.coordinator.inspect();
  assert.equal(graph.historyCount, 500); assert.equal(graph.history.length, 500); assert.equal(graph.snapshots.length, 1);
  assert.deepEqual(f.api.reads, ['remote-c-499']);
  f.api.reads.length = 0;
  const chosen = await f.coordinator.preview('c-17', { expectedHeads: ['c-499'] });
  assert.equal(chosen.envelope.commitId, 'c-17'); assert.deepEqual(chosen.heads, ['c-499']);
  assert.deepEqual(f.api.reads, ['remote-c-499', 'remote-c-17']);
  f.api.reads.length = 0;
  await f.coordinator.load('c-17', { expectedHeads: ['c-499'] });
  assert.deepEqual(f.api.reads, ['remote-c-499', 'remote-c-17']); assert.equal(f.api.files.size, 500);
});

test('archived metadata problems invalidate graph without bulk body downloads', async () => {
  const f = fixture(); f.api.add(await envelope('root')); f.api.add(await envelope('head', ['root']));
  f.api.files.get('remote-root').appProperties.p00 = '["missing"]';
  const graph = await f.coordinator.inspect(); assert.equal(graph.status, 'invalid');
  assert.ok(graph.issues.some((issue) => issue.code === 'MISSING_PARENT')); assert.equal(f.api.reads.length, 0);
});

test('selected historical content is revalidated against complete metadata before restore', async () => {
  const f = fixture(); f.api.add(await envelope('root')); f.api.add(await envelope('head', ['root']));
  const root = f.api.files.get('remote-root'); root.text = JSON.stringify(await envelope('root', [], writtenState('tampered historical')));
  assert.equal((await f.coordinator.inspect()).status, 'choice-required');
  await assert.rejects(f.coordinator.preview('root'), code('METADATA_MISMATCH'));
  await assert.rejects(f.coordinator.load('root'), code('METADATA_MISMATCH'));
  assert.deepEqual(f.state, createInitialState());
});

test('head envelope must agree with header ancestry and hash, regardless of valid inner state', async () => {
  const f = fixture(); const record = await envelope('head'); const id = f.api.add(record);
  f.api.files.get(id).text = JSON.stringify({ ...record, createdAt: '2026-10-07T00:00:00.000Z' });
  const graph = await f.coordinator.inspect(); assert.equal(graph.status, 'invalid'); assert.equal(graph.issues[0].code, 'METADATA_MISMATCH');
  await assert.rejects(f.coordinator.save({ resolution: true, expectedHeads: ['head'] }), code('INVALID_HISTORY'));
});

test('10,000-entry topology validation does not overflow stack or truncate history', () => {
  const snapshots = Array.from({ length: SYNC_LIMITS.snapshots }, (_, i) => ({ fileId: `file-${i}`,
    envelope: { commitId: `commit-${i}`, datasetId: 'dataset', parentCommitIds: i ? [`commit-${i - 1}`] : [] } }));
  const graph = analyzeSnapshots(snapshots); assert.equal(graph.status, 'ready'); assert.deepEqual(graph.heads, ['commit-9999']);
  assert.equal(graph.snapshots.length, 10000);
});

test('preview rejects changed heads and never mutates local or remote data', async () => {
  const f = fixture(); f.api.add(await envelope('root'));
  await assert.rejects(f.coordinator.preview('root', { expectedHeads: [] }), code('REMOTE_CHANGED'));
  assert.deepEqual(f.state, createInitialState()); assert.equal(f.api.creates.length, 0);
});

test('restore consent is tied to selected state hash even if commit ID and heads are unchanged', async () => {
  const f = fixture(); const original = await envelope('selected'); f.api.add(original);
  const preview = await f.coordinator.preview('selected');
  f.api.add(await envelope('selected', [], writtenState('changed after preview')));
  await assert.rejects(f.coordinator.load('selected', { expectedHeads: preview.heads, expectedSnapshotHash: preview.envelope.hash }), code('REMOTE_CHANGED'));
  assert.deepEqual(f.state, createInitialState()); assert.equal(f.api.creates.length, 0);
});

test('two devices bootstrapping an empty folder use one dataset and preserve resolvable first-save fork', async () => {
  const api = new FakeDrive(), release = deferred(); let arrivals = 0;
  api.onCreate = async () => { if (++arrivals === 2) release.resolve(); await release.promise; };
  // Separate storage/locks model separate browser profiles or devices.
  const a = fixture({ api, state: writtenState('device A') }), b = fixture({ api, state: writtenState('device B') });
  const [savedA, savedB] = await Promise.all([a.coordinator.save(), b.coordinator.save()]);
  const ea = JSON.parse(api.files.get(savedA.fileId).text), eb = JSON.parse(api.files.get(savedB.fileId).text);
  assert.equal(ea.datasetId, eb.datasetId); assert.equal(ea.datasetId.startsWith('folder-'), true);
  assert.deepEqual(ea.parentCommitIds, []); assert.deepEqual(eb.parentCommitIds, []);
  const graph = await a.coordinator.inspect(); assert.equal(graph.status, 'conflict'); assert.equal(graph.heads.length, 2);
  api.onCreate = null;
  const resolved = await a.coordinator.save({ resolution: true, expectedHeads: graph.heads });
  assert.deepEqual(JSON.parse(api.files.get(resolved.fileId).text).parentCommitIds, graph.heads);
  assert.equal(api.files.size, 3); assert.equal((await a.coordinator.inspect()).status, 'ready');
});

test('definitive adapter CONTENT_CONFLICT is never converted into success by matching body bytes', async () => {
  const f = fixture();
  f.api.onCreate = async (input) => {
    f.api.files.set(input.id, { ...input, appProperties: { ...input.appProperties, stateHash: '0'.repeat(64) } });
    throw Object.assign(new Error('metadata mismatch'), { status: 409, code: 'CONTENT_CONFLICT' });
  };
  await assert.rejects(f.coordinator.save(), code('CONTENT_CONFLICT'));
  assert.ok(f.storage.getItem(outboxKey)); assert.equal(f.coordinator.getStatus().verified, false); assert.equal(f.api.reads.length, 0);
});

test('invalid graph after create/readback keeps queued data and never reports first verified save', async () => {
  const f = fixture();
  f.api.onCreate = async () => { f.api.files.set('corrupt', { name: 'corrupt.json', text: '{}', appProperties: { myPaceSync: SYNC_FORMAT } }); };
  await assert.rejects(f.coordinator.save(), code('INVALID_HISTORY'));
  assert.ok(f.storage.getItem(outboxKey)); assert.equal(f.coordinator.getStatus().verified, false); assert.equal(f.api.files.size, 2);
});

test('another tab can finish durable retry but cannot adopt its differing content as local ancestry', async () => {
  const api = new FakeDrive(), storage = new MemoryStorage(), locks = new Locks();
  const a = fixture({ api, storage, locks }); await a.coordinator.save();
  const b = fixture({ api, storage, locks }); await b.coordinator.save(); b.coordinator.setAutosave(true);
  a.edit(writtenState('tab A queued')); api.onCreate = async () => { throw new Error('offline'); };
  await assert.rejects(a.coordinator.save());
  b.edit(writtenState('tab B differing')); api.onCreate = null;
  const result = await b.coordinator.save();
  assert.equal(result.retried, true); assert.equal(result.conflict, true); assert.equal(result.dirty, true);
  assert.equal(b.coordinator.getStatus().autosave, false);
  await assert.rejects(b.coordinator.save(), code('CONFLICT'));
  assert.equal(api.files.size, 2); assert.equal(b.state.diary['2026-10-06'].text, 'tab B differing');
});

test('reload with queued snapshot and divergent local content requires a choice after retry', async () => {
  const f = fixture({ state: writtenState('queued') }); f.api.onCreate = async () => { throw new Error('offline'); };
  await assert.rejects(f.coordinator.save()); f.api.onCreate = null;
  const g = fixture({ state: writtenState('new after reload'), api: f.api, storage: f.storage });
  const result = await g.coordinator.save(); assert.equal(result.retried, true); assert.equal(result.conflict, true);
  assert.equal(g.coordinator.getStatus().state, 'choice-required');
  await assert.rejects(g.coordinator.save(), code('CHOICE_REQUIRED'));
});

test('actual adapter timeout/rate-limit codes preserve opt-in, while auth/forbidden stop it', async () => {
  for (const [error, retains] of [
    [new GoogleDriveError('NETWORK_TIMEOUT', 'timed out'), true],
    [new GoogleDriveError('RATE_LIMIT', 'retry later', 403), true],
    [new GoogleDriveError('RATE_LIMIT', 'retry later', 429), true],
    [new GoogleDriveError('FORBIDDEN', 'permission denied', 403), false],
    [new GoogleDriveError('AUTH_REQUIRED', 'expired', 401), false],
  ]) {
    const f = fixture(); await f.coordinator.save(); f.coordinator.setAutosave(true);
    f.api.onCreate = async () => { throw error; }; f.edit(writtenState()); await f.timers.run();
    assert.equal(f.coordinator.getStatus().autosave, retains, `${error.code}/${error.status}`);
    assert.ok(f.storage.getItem(outboxKey)); assert.equal(f.timers.jobs.size, 0);
  }
});

test('an autosave timer firing during restore cannot queue a stale save or replace restore status', async () => {
  const f = fixture(); const root = await f.coordinator.save(); f.coordinator.setAutosave(true); f.edit(writtenState('unsaved'));
  const started = deferred(), release = deferred();
  f.api.onRead = async () => { started.resolve(); await release.promise; };
  const restoring = f.coordinator.load(root.commitId); await started.promise;
  await f.timers.run(); release.resolve(); await restoring;
  assert.equal(f.coordinator.getStatus().state, 'ready'); assert.equal(f.coordinator.getStatus().autosave, false);
  assert.equal(f.coordinator.getStatus().busy, false); assert.equal(f.api.creates.length, 1); assert.equal(f.timers.jobs.size, 0);
});
