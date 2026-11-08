import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { prepareRunning } from '../processing/running/materialize.mjs';
import { describeRuns, incrementalFresh } from '../processing/running/incremental.mjs';
import { computationCache } from '../processing/running/cache.mjs';
import { explorationByRun } from '../lib/exploration.js';
import { runWorkerOnce, downloadSnapshot, driveInventory } from '../processing/running/worker.mjs';
import { createDriveClient } from '../processing/running/drive.mjs';
import { drivePublisher, collectArtifacts } from '../processing/running/publish.mjs';
import { decodeMask } from '../lib/running-artifacts.js';

const DEG = 180 / Math.PI / 6371008.8;
const line = (latitude = 0, longitude = 0) => Array.from({ length: 61 }, (_, i) => [latitude, longitude + i * 3 * DEG]);
const csv = (day, points = line()) => 'time,latitude,longitude\n' + points.map((p, i) => `${new Date(Date.UTC(2026, 0, day, 0, 0, i * 15)).toISOString()},${p[0]},${p[1]}`).join('\n');
const digest = bytes => createHash('md5').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mypace-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'raw'); await mkdir(input);
  const sources = [], options = { sources, output: join(root, 'display'), cache: join(root, 'cache') };
  async function add(id, day, points) {
    const source = { id, path: join(input, id + '.csv') }; await writeFile(source.path, csv(day, points)); sources.push(source); return source;
  }
  return { root, input, options, add, index: () => readFile(join(options.output, 'index.json'), 'utf8'),
    worker: { input, output: options.output, cache: options.cache, state: join(root, 'state'), settleMs: 0 } };
}

test('append recalculates one display/fresh result; unchanged and repeat geometry require no raster work', async t => {
  const f = await fixture(t); await f.add('a', 1); await f.add('b', 2, line(.01));
  await prepareRunning(f.options);
  const idle = await prepareRunning(f.options);
  for (const key of ['displayComputed', 'freshComputed', 'corridorComputed', 'enclosureComputed', 'maskTileComputed', 'explorationCellVisits']) assert.equal(idle.stats[key], 0, key);
  const nextSource = await f.add('c', 3);
  const next = await prepareRunning(f.options);
  assert.equal(next.stats.rawBytesRead, (await readFile(nextSource.path)).length);
  assert.equal(next.stats.displayComputed, 1); assert.equal(next.stats.freshComputed, 1);
  assert.equal(next.stats.corridorComputed, 0); assert.equal(next.stats.explorationCellVisits, 0);
  assert.equal(next.stats.enclosureComputed, 0); assert.equal(next.stats.maskTileComputed, 0);
  assert.equal([...next.entries.values()].at(-1).freshMeters, 0);
});

test('backfill/edit/delete recalculates later nearby fresh distance and matches a cold rebuild', async t => {
  const f = await fixture(t); const a = await f.add('a', 2), b = await f.add('b', 3); await f.add('far', 4, line(.1));
  await prepareRunning(f.options);
  const backfill = await f.add('older', 1);
  let result = await prepareRunning(f.options);
  assert.equal(result.stats.freshComputed, 0, 'identical footprints and dependency sets reuse existing results even after backfill');
  const first = [...result.entries.values()][0]; assert(first.freshMeters > 170);
  assert([...result.entries.values()].filter(e => e.date === '2026-01-02')[0].freshMeters < 1);
  await writeFile(backfill.path, csv(1, line(.05)));
  await writeFile(a.path, csv(2, line(.03)));
  result = await prepareRunning(f.options);
  assert([...result.entries.values()].find(e => e.date === '2026-01-03').freshMeters > 170);
  f.options.sources = [b, f.options.sources.find(s => s.id === 'far')];
  const deleted = await prepareRunning(f.options);
  const rebuilt = await prepareRunning({ ...f.options, output: join(f.root, 'cold'), cache: join(f.root, 'cold-cache') });
  assert.deepEqual(deleted.catalog, rebuilt.catalog);
  assert.deepEqual([...deleted.entries], [...rebuilt.entries]);
});

test('incremental fresh policy matches existing calculation: same day, nearby offset, date line and distant runs', async t => {
  const f = await fixture(t);
  const runs = [
    { id: 'a', date: '2026-01-01', segments: [line()] },
    { id: 'b', date: '2026-01-01', segments: [line()] },
    { id: 'c', date: '2026-01-02', segments: [line(25 * DEG)] },
    { id: 'd', date: '2026-01-03', segments: [line(65 * DEG)] },
    { id: 'e', date: '2026-01-04', segments: [[[0, 179.999], [0, -179.999]]] },
    { id: 'f', date: '2026-01-05', segments: [[[0, -179.999], [0, 179.999]]] },
  ];
  const result = await incrementalFresh(describeRuns(runs), computationCache(join(f.root, 'fresh'), {}));
  assert.deepEqual(result, explorationByRun(runs));
});

async function maskAt(result, output, latitude, longitude) {
  const world = 2 ** 16 * 64, sine = Math.sin(latitude * Math.PI / 180);
  const x = Math.floor((longitude + 180) / 360 * world), y = Math.floor((.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * world);
  for (const ref of Object.values(result.catalog.exploration.blocks).flat()) {
    const object = JSON.parse(await readFile(join(output, ref.path)));
    const tile = object.tiles.find(t => t.x === Math.floor(x / 64) && t.y === Math.floor(y / 64));
    if (tile) return decodeMask(tile.rle)[(y % 64) * 64 + x % 64];
  }
  return 0;
}
test('loop closes across days/tiles and reopens after deletion; separate areas reuse enclosures', async t => {
  const f = await fixture(t), loop = [[0, 0], [0, .002], [.002, .002], [.002, 0], [0, 0]];
  await f.add('half', 1, loop.slice(0, 3));
  await f.add('far', 2, loop.map(([lat, lon]) => [lat + .1, lon + .1]));
  const open = await prepareRunning(f.options); assert.equal(await maskAt(open, f.options.output, .001, .001), 0);
  const closing = await f.add('closing', 3, loop.slice(2));
  const closed = await prepareRunning(f.options); assert.equal(await maskAt(closed, f.options.output, .001, .001), 255);
  assert.equal(closed.stats.enclosureComputed, 1); assert.equal(closed.stats.enclosureReused, 1);
  f.options.sources = f.options.sources.filter(s => s !== closing);
  const removed = await prepareRunning(f.options); assert.equal(await maskAt(removed, f.options.output, .001, .001), 0);
  assert.deepEqual(removed.catalog, open.catalog);
});

test('worker detects additions, settles incomplete writes, skips idle geometry and keeps old catalog on errors', async t => {
  const f = await fixture(t); const first = await f.add('first', 1); let clock = 1000;
  const worker = { ...f.worker, settleMs: 2000, now: () => clock };
  assert.equal((await runWorkerOnce(worker)).status, 'settling');
  clock += 2001; assert.equal((await runWorkerOnce(worker)).status, 'updated');
  assert.equal((await runWorkerOnce(worker)).status, 'unchanged');
  const prior = await f.index();
  await writeFile(first.path, 'incomplete'); clock += 100;
  assert.equal((await runWorkerOnce(worker)).status, 'settling'); assert.equal(await f.index(), prior);
  clock += 3000; await assert.rejects(runWorkerOnce(worker)); assert.equal(await f.index(), prior);
  await writeFile(first.path, csv(1)); await f.add('second', 2);
  const next = await runWorkerOnce(f.worker); assert.equal(next.runs, 2);
  await rm(first.path); await rm(join(f.input, 'second.csv'));
  await assert.rejects(runWorkerOnce(f.worker), /EMPTY_INVENTORY/);
  assert.equal(JSON.parse(await f.index()).latest.date, '2026-01-02');
});

class FakeDrive {
  constructor() { this.files = new Map(); this.events = []; this.downloads = []; this.serial = 0; this.created = []; this.private = true; }
  add(id, text, parent = 'source') {
    const bytes = Buffer.from(text), file = { id, name: id + '.csv', parents: [parent], mimeType: 'text/csv', size: String(bytes.length), md5Checksum: digest(bytes) };
    this.files.set(id, { file, bytes }); this.events.push({ fileId: id, file: structuredClone(file) }); return file;
  }
  async metadata(id) {
    if (id === 'source') return { id, mimeType: 'application/vnd.google-apps.folder' };
    if (!this.files.has(id)) throw Object.assign(Error('DRIVE_HTTP_404'), { status: 404 });
    return structuredClone(this.files.get(id).file);
  }
  async startToken() { return String(this.events.length); }
  async folder(id) { return [...this.files.values()].map(x => structuredClone(x.file)).filter(f => f.parents?.includes(id) && !f.trashed); }
  async changes(cursor) { return { changes: this.events.slice(Number(cursor)), newStartPageToken: String(this.events.length) }; }
  async range(id, start, end) { this.downloads.push({ id, start, end }); return this.files.get(id).bytes.subarray(start, end + 1); }
  async newId() { return 'generated-' + ++this.serial; }
  async assertPrivate() { if (!this.private) throw Error('DRIVE_OUTPUT_MUST_BE_OWNER_ONLY'); }
  async createFolder(file) { this.files.set(file.id, { file, bytes: Buffer.alloc(0) }); return file; }
  async create(file, bytes) {
    if (this.failCreate) throw Error('UPLOAD_INTERRUPTED');
    const value = { ...file, md5Checksum: digest(bytes), size: String(bytes.length) };
    this.files.set(file.id, { file: value, bytes }); this.created.push(file.name); return value;
  }
  async replace(id, bytes) { this.created.push('replace-index'); return this.create(this.files.get(id).file, bytes); }
}

test('Drive download resumes exact byte offset, rejects changed sources and verifies checksum', async t => {
  const f = await fixture(t), drive = new FakeDrive(), file = drive.add('run', csv(1));
  const root = join(f.root, 'downloads'); let once = false;
  await assert.rejects(downloadSnapshot(drive, file, 'source', root, { chunkBytes: 100, afterChunk: () => { if (!once) { once = true; throw Error('INTERRUPT'); } } }), /INTERRUPT/);
  assert.equal(drive.downloads.length, 1);
  const result = await downloadSnapshot(drive, file, 'source', root, { chunkBytes: 100 });
  assert.equal(drive.downloads[1].start, 100); assert.equal(await readFile(result.path, 'utf8'), csv(1));
  const count = drive.downloads.length; await downloadSnapshot(drive, file, 'source', root); assert.equal(drive.downloads.length, count);
  const bad = { ...drive.add('bad', csv(2)), md5Checksum: '0'.repeat(32) };
  await assert.rejects(downloadSnapshot(drive, bad, 'source', root), /CHECKSUM_MISMATCH/);
  const changing = drive.add('changing', csv(3));
  await assert.rejects(downloadSnapshot(drive, changing, 'source', root, { afterChunk: () => { drive.files.get('changing').file.parents = ['elsewhere']; } }), /SOURCE_CHANGED/);
});

test('Drive worker cursor commits only after complete preparation; renames avoid downloads; removals retract records', async t => {
  const f = await fixture(t), drive = new FakeDrive(); drive.add('first', csv(1));
  const options = { ...f.worker, input: undefined, drive, sourceFolder: 'source' };
  assert.equal((await runWorkerOnce(options)).status, 'updated');
  const statePath = join(options.state, 'committed.json'), committed = await readFile(statePath, 'utf8');
  drive.add('second', csv(2));
  await assert.rejects(runWorkerOnce({ ...options, hooks: { beforePublish: () => { throw Error('INTERRUPT'); } } }), /INTERRUPT/);
  assert.equal(await readFile(statePath, 'utf8'), committed);
  const count = drive.downloads.length;
  assert.equal((await runWorkerOnce(options)).runs, 2); assert.equal(drive.downloads.length, count);
  const renamed = drive.files.get('first').file; renamed.name = 'renamed.csv';
  drive.events.push({ fileId: 'first', file: structuredClone(renamed) });
  assert.equal((await runWorkerOnce(options)).status, 'unchanged'); assert.equal(drive.downloads.length, count);
  drive.files.delete('first'); drive.events.push({ fileId: 'first', removed: true });
  assert.equal((await runWorkerOnce(options)).runs, 1);
});

test('Drive pagination failure never yields a partial inventory; initial listing races are reconciled', async () => {
  const drive = new FakeDrive(); drive.add('a', csv(1));
  const list = drive.folder.bind(drive);
  drive.folder = async folder => { const files = await list(folder); drive.add('b', csv(2)); return files; };
  const complete = await driveInventory(drive, 'source', null); assert.equal(Object.keys(complete.files).length, 2);
  let calls = 0;
  drive.changes = async () => { if (++calls === 1) return { changes: [{ fileId: 'a', removed: true }], nextPageToken: 'next' }; throw Error('NETWORK_INTERRUPTED'); };
  await assert.rejects(driveInventory(drive, 'source', complete), /NETWORK_INTERRUPTED/);
  assert.equal(Object.keys(complete.files).length, 2);
});

test('Drive HTTP range validation, bounded retries and errors do not leak server text', async () => {
  let attempts = 0; const waits = [];
  const client = createDriveClient({ accessToken: async () => 'synthetic-token', wait: async ms => waits.push(ms),
    fetchImpl: async () => ++attempts === 1 ? new Response('secret metadata', { status: 429 })
      : new Response('abcd', { status: 206, headers: { 'Content-Range': 'bytes 0-3/4' } }) });
  assert.equal((await client.range('test', 0, 3, 4)).toString(), 'abcd'); assert.equal(attempts, 2); assert.equal(waits.length, 1);
  const ignored = createDriveClient({ accessToken: async () => 'fake', fetchImpl: async () => new Response('full body') });
  await assert.rejects(ignored.range('test', 0, 3, 4), /RANGE_NOT_HONORED/);
  const denied = createDriveClient({ accessToken: async () => 'fake', fetchImpl: async () => new Response('private details', { status: 403 }) });
  await assert.rejects(denied.metadata('test'), /^Error: DRIVE_HTTP_403$/);
});

test('private Drive publication writes catalog last, resumes without duplicate files, and refuses sharing', async t => {
  const f = await fixture(t); await f.add('a', 1); let result = await prepareRunning(f.options);
  const drive = new FakeDrive(), state = join(f.root, 'publication'), publish = drivePublisher(drive, state);
  await publish({ output: f.options.output, catalog: result.catalog });
  assert.equal(drive.created.at(-1), 'index.json');
  const old = JSON.parse(await readFile(join(state, 'publication.json'))), oldIndex = drive.files.get(old.index).bytes.toString();
  const firstFiles = drive.files.size;
  assert.equal((await publish({ output: f.options.output, catalog: result.catalog })).status, 'unchanged'); assert.equal(drive.files.size, firstFiles);
  await f.add('b', 2); result = await prepareRunning(f.options); drive.failCreate = true;
  await assert.rejects(publish({ output: f.options.output, catalog: result.catalog }), /UPLOAD_INTERRUPTED/);
  assert.equal(drive.files.get(old.index).bytes.toString(), oldIndex);
  drive.failCreate = false; drive.private = false;
  await assert.rejects(publish({ output: f.options.output, catalog: result.catalog }), /OWNER_ONLY/);
  drive.private = true; await publish({ output: f.options.output, catalog: result.catalog });
  assert.equal(drive.created.at(-1), 'index.json');
  const artifacts = await collectArtifacts(f.options.output, result.catalog);
  for (const [path, bytes] of artifacts) assert([...drive.files.values()].some(x => x.file.name === path.slice(8) && x.bytes.equals(bytes)));
});

test('SIGKILL releases OS locks and resumes completed units without replacing the prior catalog early', async t => {
  const f = await fixture(t); await f.add('a', 1); await runWorkerOnce(f.worker);
  const previous = await f.index(); await f.add('b', 2, line(.01));
  const moduleUrl = new URL('../processing/running/worker.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import {runWorkerOnce} from ${JSON.stringify(moduleUrl)};
     await runWorkerOnce({...${JSON.stringify(f.worker)}, hooks:{beforePublish:async()=>{
       process.send('ready'); await new Promise(()=>setInterval(()=>{},1000));
     }}});`], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('CHILD_TEST_TIMEOUT')), 10000);
    child.once('message', () => { clearTimeout(timeout); resolve(); });
    child.once('exit', () => { clearTimeout(timeout); reject(Error('CHILD_EXITED_EARLY')); });
    child.once('error', reject);
  });
  await assert.rejects(runWorkerOnce(f.worker), /WORKER_ALREADY_RUNNING/);
  assert.equal(await f.index(), previous);
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  let result;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { result = await runWorkerOnce(f.worker); break; }
    catch (error) { if (!/ALREADY_RUNNING/.test(error.message)) throw error; await sleep(25); }
  }
  assert(result); assert.equal(result.runs, 2); assert.equal(result.rawBytesRead, 0);
  assert.equal(result.displayComputed, 0); assert.equal(result.explorationCellVisits, 0);
});

test('hundreds of repeat runs do not accumulate exploration raster work; one append preserves old display objects', async t => {
  const f = await fixture(t);
  for (let day = 1; day <= 370; day++) await f.add('run-' + String(day).padStart(4, '0'), day, line().slice(0, 4));
  const initial = await prepareRunning(f.options);
  assert.equal(initial.stats.corridorComputed, 1); assert.equal(initial.stats.enclosureComputed, 1);
  await f.add('new-run', 371, line().slice(0, 4));
  const next = await prepareRunning(f.options);
  assert.equal(next.stats.processedSources, 1); assert.equal(next.stats.displayComputed, 1);
  assert.equal(next.stats.freshComputed, 0); assert.equal(next.stats.explorationCellVisits, 0);
  assert.equal(next.stats.maskTiles, initial.stats.maskTiles);
  assert.deepEqual(next.catalog.years['2026'], initial.catalog.years['2026']);
});

test('a loop across the date line encloses its interior without revealing the world between longitudes', async t => {
  const f = await fixture(t);
  await f.add('loop', 1, [[0, 179.999], [0, -179.999], [.002, -179.999], [.002, 179.999], [0, 179.999]]);
  const result = await prepareRunning(f.options);
  assert.equal(await maskAt(result, f.options.output, .001, 179.9999), 255);
  assert.equal(await maskAt(result, f.options.output, .001, -179.9999), 255);
  assert.equal(await maskAt(result, f.options.output, .001, 0), 0); assert(result.stats.maskTiles < 10);
});

test('a lost upload acknowledgement reuses its reserved ID; a failed publisher does not advance the worker cursor', async t => {
  const f = await fixture(t), drive = new FakeDrive(); drive.add('first', csv(1));
  const publish = drivePublisher(drive, join(f.root, 'publisher'));
  const options = { ...f.worker, input: undefined, drive, sourceFolder: 'source', publisher: publish };
  await runWorkerOnce(options);
  const before = await readFile(join(options.state, 'committed.json'), 'utf8');
  const create = drive.create.bind(drive); let interrupted = false;
  drive.create = async (...args) => {
    const result = await create(...args);
    if (!interrupted) { interrupted = true; throw Error('ACK_LOST'); }
    return result;
  };
  drive.add('second', csv(2));
  await assert.rejects(runWorkerOnce(options), /ACK_LOST/);
  assert.equal(await readFile(join(options.state, 'committed.json'), 'utf8'), before);
  const downloads = drive.downloads.length;
  await runWorkerOnce(options); assert.equal(drive.downloads.length, downloads);
  const names = [...drive.files.values()].filter(x => /^[a-f0-9]{64}\.json$/.test(x.file.name)).map(x => x.file.name);
  assert.equal(new Set(names).size, names.length, 'no duplicate immutable files after acknowledgement loss');
});

test('an expired change cursor reconciles the complete folder instead of losing or duplicating records', async () => {
  const drive = new FakeDrive(); drive.add('current', csv(2)); let first = true;
  const changes = drive.changes.bind(drive);
  drive.changes = async token => { if (first) { first = false; throw Object.assign(Error('EXPIRED'), { status: 410 }); } return changes(token); };
  const next = await driveInventory(drive, 'source', { files: { old: { id: 'old' } }, cursor: 'expired' });
  assert.deepEqual(Object.keys(next.files), ['current']);
});
