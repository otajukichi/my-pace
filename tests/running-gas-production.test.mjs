import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareRunning } from '../processing/running/materialize.mjs';
import { hash, json } from '../processing/running/cache.mjs';
import { bundleRunningProduction } from '../scripts/build-running-gas-production.mjs';
import { productionFixture, prepare, start, until, prop, state, tick, put, folder, replaceBytes, csv, unchangedOriginals, PREFIX, TICK } from './helpers/running-production.mjs';

async function independent(fixture) {
  const { h, temp } = fixture, sources = [];
  // The old three source keys are intentionally retained; unknown uploads use GPS hashes.
  for (const file of Object.values(state(h).committed)) {
    const path = join(temp, file.id + '.csv'); await writeFile(path, h.files.get(file.id).bytes);
    let id = /^original-[0-2]$/.test(file.id) ? 'source-' + file.id.slice(-1) : null;
    if (!id) {
      const cache = join(temp, 'single-' + file.id);
      await prepareRunning({ sources: [{ id: 'single', path }], cache, output: cache + '-output' });
      id = JSON.parse(await readFile(join(cache, hash('single') + '.json'), 'utf8')).value.gpsHash;
    }
    sources.push({ id, path });
  }
  const result = await prepareRunning({ sources, cache: join(temp, 'full-cache'), output: join(temp, 'full-output') });
  assert.equal(state(h).catalogHash, hash(json(result.catalog)));
  const actual = JSON.parse(h.files.get('production-index').bytes);
  assert.deepEqual(actual, result.catalog);
  // The catalog addresses every display object by its content hash. Verify
  // the actual Drive bodies as well as the index, including exploration.
  for (const [name, id] of Object.entries(state(h).artifacts)) {
    assert.equal(hash(h.files.get(id).bytes), name.slice(0, -5));
  }
}

test('production adopts the uploaded view and passed caches, reads no original CSV, then publishes the independently rebuilt real history', async t => {
  const f = await productionFixture(t), { h, before, index, baseline } = f;
  prepare(h);
  assert.deepEqual(h.files.get('production-index').bytes, index);
  assert.equal(prop(h, 'METRICS').rawBytesRequested || 0, 0);
  assert.equal(Object.keys(state(h).committed).length, 4);
  assert(state(h).cacheImported > 4); assert(!h.triggers.some(t => t.handler === TICK));
  unchangedOriginals(h, baseline);
  start(h); assert.equal(prop(h, 'METRICS').rawBytesRequested || 0, 0);
  assert.equal(Object.keys(state(h).committed).length, 4); await independent(f);
  unchangedOriginals(h, baseline);
  const beforeRequests = h.requests.length, beforeMetrics = prop(h, 'METRICS'); tick(h);
  assert.equal(prop(h, 'STATUS'), 'WATCHING'); assert.equal(prop(h, 'METRICS').rawBytesRequested || 0, 0);
  assert.equal(prop(h, 'METRICS').publications, beforeMetrics.publications);
  assert(h.requests.slice(beforeRequests).every(r => !r.range));
  assert(!h.requests.slice(before).some(r => r.method === 'delete' || r.path.endsWith('/copy')));
  assert(!/original-folder|original-fourth|management-root|latitude|longitude/.test(JSON.stringify(h.logs.slice(-6))));
});

test('new and backfilled CSV, content edit, rename and removal update the existing view and exploration together', async t => {
  const f = await productionFixture(t), { h, baseline } = f; prepare(h); start(h);
  folder(h, 'nested', 'original-folder');
  put(h, 'added', 'added.csv', 'nested', Buffer.from(csv(10)), 'text/csv');
  tick(h); until(h, ['WATCHING']);
  assert.equal(Object.keys(state(h).committed).length, 5); await independent(f);
  const bytes = prop(h, 'METRICS').rawBytesRequested;
  put(h, 'backfilled', 'old.csv', 'nested', Buffer.from(csv(-1)), 'text/csv');
  tick(h); until(h, ['WATCHING']); await independent(f);
  assert.equal(prop(h, 'METRICS').rawBytesRequested - bytes, h.files.get('backfilled').bytes.length);
  const beforeRename = prop(h, 'METRICS'); h.files.get('added').meta.name = 'renamed.csv'; h.files.get('added').meta.version = '2';
  tick(h); until(h, ['WATCHING']); assert.equal(prop(h, 'METRICS').rawBytesRequested, beforeRename.rawBytesRequested);
  replaceBytes(h, 'added', Buffer.from(csv(11))); tick(h); until(h, ['WATCHING']); await independent(f);
  h.files.get('backfilled').meta.trashed = true; tick(h); until(h, ['WATCHING']); await independent(f);
  unchangedOriginals(h, baseline);
});

test('a lost index response resumes the same generation and rollback restores the exact working four-record view', async t => {
  let armed = false, lost = false;
  const { h, baseline, index } = await productionFixture(t, { afterRequest({ method, path }) {
    if (armed && !lost && method === 'patch' && path === 'files/production-index') { lost = true; throw Error('private response'); }
  } });
  prepare(h); armed = true; start(h); assert(lost);
  assert.equal([...h.files.values()].filter(f => f.meta.name === 'index.json' && f.meta.parents?.includes('production-derived')).length, 1);
  h.invoke('rollbackMyPaceRunningToInitial'); assert.equal(prop(h, 'STATUS'), 'ROLLED_BACK');
  assert.deepEqual(h.files.get('production-index').bytes, index); unchangedOriginals(h, baseline);
  assert.deepEqual(h.triggers, [{ handler: 'unrelatedExistingTestHandler' }]);
  const count = h.requests.length; h.invoke(TICK); assert.equal(h.requests.length, count);
  start(h); assert.equal(prop(h, 'STATUS'), 'WATCHING');
});

test('daily budget exhaustion pauses and resumes automatically without discarding state or spinning every five minutes', async t => {
  const { h } = await productionFixture(t); prepare(h); start(h);
  const budget = prop(h, 'BUDGET'); const hour = Math.max(...Object.keys(budget.hours).map(Number)); budget.hours = { [hour]: 85 * 60000 };
  h.properties.set(PREFIX + 'BUDGET', JSON.stringify(budget));
  tick(h); assert.equal(prop(h, 'STATUS'), 'BUDGET_WAIT');
  assert(h.triggers.some(t => t.handler === 'myPaceRunningWake')); assert(!h.triggers.some(t => t.handler === TICK));
  const calls = h.requests.length; tick(h); assert.equal(h.requests.length, calls);
  h.advance(26 * 3600000); h.invoke('myPaceRunningWake');
  assert.equal(prop(h, 'STATUS'), 'WATCHING'); assert(h.triggers.some(t => t.handler === TICK));
  assert(!h.triggers.some(t => t.handler === 'myPaceRunningWake'));
  h.invoke('stopMyPaceRunningProduction'); assert.deepEqual(h.triggers, [{ handler: 'unrelatedExistingTestHandler' }]);
  h.invoke('prepareMyPaceRunningProduction'); assert.equal(prop(h, 'STATUS'), 'ALREADY_STARTED');
  assert.equal(prop(h, 'ENABLED'), false); assert.deepEqual(h.triggers, [{ handler: 'unrelatedExistingTestHandler' }]);
});

test('large CSV resumes after a range failure, preserving original data and the previous index until complete', async t => {
  let armed = false, lost = false;
  const { h, index } = await productionFixture(t, { beforeRequest({ path, options }) {
    if (armed && !lost && path === 'files/large' && /^bytes=1048576-/.test(options.headers?.Range || '')) { lost = true; return { status: 503 }; }
  } });
  prepare(h); start(h); const previous = Buffer.from(h.files.get('production-index').bytes);
  put(h, 'large', 'large.csv', 'original-folder', Buffer.from(csv(12, true)), 'text/csv'); armed = true;
  tick(h); until(h, ['DRIVE_RETRYABLE']); assert.deepEqual(h.files.get('production-index').bytes, previous);
  assert.equal(state(h).job.digest.length, 1048576); const at = h.requests.length;
  tick(h); until(h, ['WATCHING']); assert(lost);
  assert.match(h.requests.slice(at).find(r => r.range).range, /^bytes=1048576-/);
  assert.notDeepEqual(h.files.get('production-index').bytes, index);
});

test('incomplete inventory and sharing changes fail closed; production cannot write a CSV even with broad OAuth scope', async t => {
  let incomplete = false;
  const { h, baseline } = await productionFixture(t, { transformList(page, { folder }) { return incomplete && folder === 'original-folder' ? { ...page, incompleteSearch: true } : page; } });
  prepare(h); start(h); const index = Buffer.from(h.files.get('production-index').bytes);
  incomplete = true; tick(h); assert.equal(prop(h, 'STATUS'), 'INCOMPLETE_SOURCE_LIST');
  assert.deepEqual(h.files.get('production-index').bytes, index); assert(!prop(h, 'ENABLED'));
  incomplete = false; h.files.get('management-root').meta.shared = true;
  h.invoke('startMyPaceRunningProduction'); assert.equal(prop(h, 'STATUS'), 'OWNER_PRIVATE_REQUIRED');
  h.files.get('management-root').meta.shared = false;
  const code = h.code;
  h.replaceCode(code + '\nfunction forbiddenTest() { pr = { root: ' + JSON.stringify(prop(h, 'ROOT')) + ' }; prWrite("original-0", "original-0.csv", "bad", "original-folder"); }');
  assert.throws(() => h.invoke('forbiddenTest'), /WRITE_PARENT_FORBIDDEN/); h.replaceCode(code);
  unchangedOriginals(h, baseline);
});

test('more than 25 sources are imported in small generations; every intermediate view stays readable', async t => {
  const f = await productionFixture(t, { listPageSize: 7 }), { h } = f;
  for (let i = 15; i < 39; i++) put(h, 'history-' + i, 'history-' + i + '.csv', 'original-folder', Buffer.from(csv(i)), 'text/csv');
  prepare(h); assert.equal(state(h).sourceCount, 28); assert.equal(state(h).pending, 24);
  h.invoke('startMyPaceRunningProduction');
  let maximum = 4, generations = 0;
  for (let i = 0; i < 150 && prop(h, 'STATUS') !== 'WATCHING'; i++) {
    tick(h);
    assert(prop(h, 'ENABLED'), JSON.stringify(h.invoke('showMyPaceRunningReport')));
    if (prop(h, 'STATUS') === 'UPDATED') {
      const count = Object.keys(state(h).committed).length;
      assert(count - maximum <= 3); maximum = count; generations++;
      const catalog = JSON.parse(h.files.get('production-index').bytes);
      const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (value.path) assert(state(h).artifacts[value.path.slice(8)]);
        else Object.values(value).forEach(visit);
      }; visit(catalog);
    }
  }
  assert.equal(prop(h, 'STATUS'), 'WATCHING'); assert.equal(maximum, 28); assert.equal(generations, 8);
  const expectedBytes = [...h.files.values()].filter(f => /^history-/.test(f.meta.id)).reduce((n, f) => n + f.bytes.length, 0);
  assert.equal(prop(h, 'METRICS').rawBytesRequested, expectedBytes); await independent(f);
});

test('a chunked import progresses across repeated time slices, even before its source count increases', async t => {
  let slow = false;
  const { h } = await productionFixture(t, { beforeRequest({ path, options }) {
    if (slow && path === 'files/sliced' && options.headers?.Range) h.advance(91000);
  } });
  prepare(h); start(h);
  const bytes = Buffer.from(csv(20, true).replaceAll('x'.repeat(18000), 'x'.repeat(60000)));
  put(h, 'sliced', 'sliced.csv', 'original-folder', bytes, 'text/csv'); slow = true;
  tick(h); until(h, ['WATCHING']);
  assert.equal(prop(h, 'METRICS').rawBytesRequested, bytes.length);
  assert.equal(Object.keys(state(h).committed).length, 5);
});

test('external index changes fail closed, and a manual rollback works during budget wait', async t => {
  const { h, index } = await productionFixture(t); prepare(h); start(h);
  const before = Buffer.from(h.files.get('production-index').bytes);
  replaceBytes(h, 'production-index', Buffer.from('{}\n'));
  put(h, 'after-external', 'new.csv', 'original-folder', Buffer.from(csv(21)), 'text/csv');
  tick(h); until(h, ['CATALOG_CHANGED_EXTERNALLY']);
  assert.equal(h.files.get('production-index').bytes.toString(), '{}\n');
  replaceBytes(h, 'production-index', before);
  const b = prop(h, 'BUDGET'), hour = Math.max(...Object.keys(b.hours).map(Number)); b.hours = { [hour]: 90 * 60000 }; b.requests = 19800;
  h.properties.set(PREFIX + 'BUDGET', JSON.stringify(b));
  h.invoke('startMyPaceRunningProduction'); assert.equal(prop(h, 'STATUS'), 'BUDGET_WAIT');
  h.invoke('rollbackMyPaceRunningToInitial'); assert.equal(prop(h, 'STATUS'), 'ROLLED_BACK');
  assert.deepEqual(h.files.get('production-index').bytes, index); assert.deepEqual(h.triggers, [{ handler: 'unrelatedExistingTestHandler' }]);
});

test('incorrect roots or an unpassed starting catalog stop before creating any production files', async t => {
  const { h, settings, before } = await productionFixture(t), size = h.files.size;
  h.replaceCode(await bundleRunningProduction({ ...settings, sourceFolderId: settings.rootFolderId }));
  h.invoke('prepareMyPaceRunningProduction'); assert.equal(prop(h, 'STATUS'), 'ROOT_ONLY_CONFIG_REQUIRED'); assert.equal(h.files.size, size);
  h.replaceCode(await bundleRunningProduction(settings)); replaceBytes(h, 'production-index', Buffer.from('{}\n'));
  h.invoke('prepareMyPaceRunningProduction'); assert.equal(prop(h, 'STATUS'), 'CATALOG_SCHEMA'); assert.equal(h.files.size, size);
  assert(h.requests.slice(before).every(r => r.method === 'get')); assert.equal(prop(h, 'ENABLED'), false);
});

test('a waking worker that still lacks budget replaces its consumed one-shot trigger', async t => {
  const { h } = await productionFixture(t); prepare(h); start(h);
  const b = prop(h, 'BUDGET'), hour = Math.max(...Object.keys(b.hours).map(Number));
  b.hours = { [hour]: 60000, [hour + 1]: 85 * 60000 };
  h.properties.set(PREFIX + 'BUDGET', JSON.stringify(b)); tick(h);
  const oldWake = h.triggers.find(t => t.handler === 'myPaceRunningWake'); assert(oldWake);
  h.advance(25 * 3600000); h.invoke('myPaceRunningWake');
  assert.equal(prop(h, 'STATUS'), 'BUDGET_WAIT');
  const next = h.triggers.filter(t => t.handler === 'myPaceRunningWake'); assert.equal(next.length, 1); assert.notEqual(next[0], oldWake);
  h.advance(2 * 3600000); h.invoke('myPaceRunningWake'); assert.equal(prop(h, 'STATUS'), 'WATCHING');
});

test('one root resolves seven raw CSVs and ignores CSVs and shortcuts in output or unrelated folders', async t => {
  const f = await productionFixture(t), { h } = f;
  folder(h, 'existing-system', 'production-running', 'system');
  folder(h, 'raw-year', 'original-folder');
  put(h, 'raw-five', 'five.csv', 'original-folder', Buffer.from(csv(12)), 'text/csv');
  put(h, 'raw-six', 'six.csv', 'raw-year', Buffer.from(csv(13)), 'text/csv');
  put(h, 'raw-seven', 'seven.csv', 'raw-year', Buffer.from(csv(14)), 'text/csv');
  for (const [i, parent] of ['management-root', 'production-running', 'production-derived', 'existing-system'].entries()) {
    put(h, 'excluded-' + i, 'excluded.csv', parent, Buffer.from(csv(20 + i)), 'text/csv');
  }
  put(h, 'shortcut', 'shortcut.csv', 'original-folder', undefined, 'application/vnd.google-apps.shortcut');
  h.files.get('shortcut').meta.shortcutDetails = { targetId: 'production-derived' };
  const baseline = structuredClone([...h.files]), at = h.requests.length;
  // The old overlap failure happens before ROOT/checkpoint creation. It must
  // not require deleting properties or replaying the passed experiments.
  h.properties.set(PREFIX + 'STATUS', JSON.stringify('INPUT_OUTPUT_OVERLAP'));
  prepare(h); assert.equal(state(h).sourceCount, 7); assert.equal(state(h).pending, 3);
  assert.equal(prop(h, 'ROOT').system, 'existing-system'); assert.equal(prop(h, 'METRICS').rawBytesRequested || 0, 0);
  start(h); assert.equal(Object.keys(state(h).committed).length, 7); await independent(f);
  const reads = h.requests.slice(at).filter(r => r.range);
  assert.deepEqual([...new Set(reads.map(r => r.path))].sort(), ['files/raw-five', 'files/raw-seven', 'files/raw-six']);
  assert(!h.requests.slice(at).some(r => r.media && /excluded-|shortcut/.test(r.path)));
  for (const request of h.requests.slice(at).filter(r => r.method !== 'get')) {
    assert(['post', 'patch'].includes(request.method));
    if (request.path.startsWith('files/')) assert(['production-derived', 'existing-system'].includes(h.files.get(request.path.slice(6)).meta.parents[0]));
  }
  unchangedOriginals(h, baseline);
});

test('initial setup rejects shared, unowned, nested, duplicate, missing and shortcut siblings without writes', async t => {
  const { h } = await productionFixture(t); folder(h, 'existing-system', 'production-running', 'system');
  const cases = [
    ['raw shared', 'original-folder', { shared: true }],
    ['raw unowned', 'original-folder', { ownedByMe: false }],
    ['derived under raw', 'production-derived', { parents: ['original-folder'] }],
    ['raw under derived', 'original-folder', { parents: ['production-derived'] }],
    ['raw renamed', 'original-folder', { name: 'outside' }],
    ['raw shortcut', 'original-folder', { mimeType: 'application/vnd.google-apps.shortcut' }],
    ['system shared', 'existing-system', { shared: true }],
    ['derived unowned', 'production-derived', { ownedByMe: false }],
  ];
  for (const [label, id, change] of cases) {
    const meta = structuredClone(h.files.get(id).meta), at = h.requests.length;
    Object.assign(h.files.get(id).meta, change); h.invoke('prepareMyPaceRunningProduction');
    assert.equal(prop(h, 'ENABLED'), false, label); assert.equal(prop(h, 'ROOT'), null, label);
    assert(h.requests.slice(at).every(r => r.method === 'get' && !r.media), label);
    h.files.get(id).meta = meta;
  }
  folder(h, 'duplicate-raw', 'production-running', 'raw');
  const at = h.requests.length; h.invoke('prepareMyPaceRunningProduction');
  assert.equal(prop(h, 'STATUS'), 'FOLDER_OR_FILE_NOT_UNIQUE'); assert(h.requests.slice(at).every(r => r.method === 'get' && !r.media));
  h.files.delete('duplicate-raw'); prepare(h); assert.equal(prop(h, 'STATUS'), 'READY');
});

test('every resumed invocation revalidates sibling identity, parent, ownership and privacy before reading the checkpoint', async t => {
  const { h } = await productionFixture(t); prepare(h); start(h);
  const root = prop(h, 'ROOT'), index = Buffer.from(h.files.get(root.catalog).bytes);
  const cases = [
    ['raw moved outside', root.source, { parents: ['management-root'] }],
    ['raw moved into derived', root.source, { parents: [root.derived] }],
    ['raw shared', root.source, { shared: true }],
    ['raw unowned', root.source, { ownedByMe: false }],
    ['raw trashed', root.source, { trashed: true }],
    ['derived moved into raw', root.derived, { parents: [root.source] }],
    ['system moved into raw', root.system, { parents: [root.source] }],
    ['system shared', root.system, { shared: true }],
    ['derived unowned', root.derived, { ownedByMe: false }],
    ['running moved', root.running, { parents: [root.source] }],
    ['root shared', root.folder, { shared: true }],
  ];
  for (const [label, id, change] of cases) {
    const meta = structuredClone(h.files.get(id).meta), at = h.requests.length;
    Object.assign(h.files.get(id).meta, change); h.properties.set(PREFIX + 'ENABLED', 'true'); tick(h);
    assert.equal(prop(h, 'ENABLED'), false, label);
    assert(h.requests.slice(at).every(r => r.method === 'get' && !r.media), label);
    assert.deepEqual(h.files.get(root.catalog).bytes, index, label); h.files.get(id).meta = meta;
  }
  // Replacing raw with a new folder of the same name must not silently switch input.
  h.files.get(root.source).meta.name = 'old-raw'; folder(h, 'replacement-raw', root.running, 'raw');
  h.properties.set(PREFIX + 'ENABLED', 'true'); const at = h.requests.length; tick(h);
  assert.equal(prop(h, 'STATUS'), 'FOLDER_LOCATION_CHANGED'); assert(h.requests.slice(at).every(r => r.method === 'get' && !r.media));
  h.files.delete('replacement-raw'); h.files.get(root.source).meta.name = 'raw'; start(h);
  assert.equal(prop(h, 'STATUS'), 'WATCHING');
});

test('resuming an unfinished setup checks raw before creating the reserved system folder', async t => {
  let fail = false;
  const { h } = await productionFixture(t, { beforeRequest({ method, options, path }) {
    if (fail && method === 'post' && path === 'files' && options.contentType === 'application/json') {
      fail = false; return { status: 503 };
    }
  } });
  fail = true; h.invoke('prepareMyPaceRunningProduction'); assert.equal(prop(h, 'STATUS'), 'DRIVE_RETRYABLE');
  const root = prop(h, 'ROOT'); assert(root); assert(!h.files.has(root.system));
  h.files.get(root.source).meta.parents = [root.derived]; const at = h.requests.length; tick(h);
  assert.equal(prop(h, 'ENABLED'), false); assert(!h.files.has(root.system));
  assert(h.requests.slice(at).every(r => r.method === 'get' && !r.media));
  h.files.get(root.source).meta.parents = [root.running]; prepare(h); assert.equal(prop(h, 'STATUS'), 'READY');
});

test('a saved scan cannot follow a descendant whose ancestor moved outside raw while paused', async t => {
  let pause = false, scanLists = [];
  const { h } = await productionFixture(t, { beforeRequest({ method, path, uri }) {
    if (method === 'get' && path === 'files') {
      const q = uri.searchParams.get('q'); scanLists.push(q);
      if (pause && q.startsWith("'deep-input'")) { pause = false; return { status: 503 }; }
    }
  } });
  prepare(h); start(h); folder(h, 'input-year', 'original-folder'); folder(h, 'deep-input', 'input-year');
  put(h, 'outside-after-move', 'next.csv', 'deep-input', Buffer.from(csv(15)), 'text/csv');
  pause = true; tick(h); assert.equal(prop(h, 'STATUS'), 'DRIVE_RETRYABLE');
  assert.equal(state(h).scan.queue[state(h).scan.at].id, 'deep-input');
  const root = prop(h, 'ROOT'), index = Buffer.from(h.files.get(root.catalog).bytes);
  h.files.get('input-year').meta.name = 'derived'; scanLists = [];
  tick(h); assert.equal(prop(h, 'STATUS'), 'OUTPUT_FOLDER_IN_RAW');
  assert(!scanLists.some(q => q.startsWith("'deep-input'")));
  h.files.get('input-year').meta.name = 'input-year'; h.properties.set(PREFIX + 'ENABLED', 'true');
  h.files.get('input-year').meta.parents = [root.derived]; scanLists = []; const at = h.requests.length; tick(h);
  assert.equal(prop(h, 'STATUS'), 'INPUT_CHANGED_RETRY');
  assert(!scanLists.some(q => q.startsWith("'deep-input'") || q.startsWith("'input-year'")));
  assert(!h.requests.slice(at).some(r => r.range)); assert.deepEqual(h.files.get(root.catalog).bytes, index);
  tick(h); until(h, ['WATCHING']); assert.equal(Object.keys(state(h).committed).length, 4);
});

test('overlapping saved source/output IDs are refused instead of trusting the checkpoint', async t => {
  const { h } = await productionFixture(t); prepare(h);
  const root = prop(h, 'ROOT'); h.properties.set(PREFIX + 'ROOT', JSON.stringify({ ...root, source: root.derived }));
  const at = h.requests.length; h.invoke('startMyPaceRunningProduction');
  assert.equal(prop(h, 'STATUS'), 'INPUT_OUTPUT_OVERLAP'); assert.equal(prop(h, 'ENABLED'), false);
  assert(h.requests.slice(at).every(r => r.method === 'get' && !r.media));
});

test('unregistered output folders misplaced inside raw are not explored as CSV inputs', async t => {
  const { h, index } = await productionFixture(t);
  folder(h, 'misplaced-system', 'original-folder', 'system');
  put(h, 'misplaced-csv', 'unexpected.csv', 'misplaced-system', Buffer.from(csv(20)), 'text/csv');
  const at = h.requests.length;
  h.invoke('prepareMyPaceRunningProduction'); until(h, ['OUTPUT_FOLDER_IN_RAW']);
  assert.equal(prop(h, 'ENABLED'), false); assert.equal(prop(h, 'METRICS').rawBytesRequested || 0, 0);
  assert(!h.requests.slice(at).some(r => r.path === 'files/misplaced-csv'));
  assert.deepEqual(h.files.get('production-index').bytes, index);
});

function displayedStatus(h){return JSON.parse(h.files.get(prop(h,'ROOT').status).bytes);}
test('prepared checkpoints upgrade without reimporting, and 45 minutes no longer prevents starting',async t=>{
 const {h,settings,index}=await productionFixture(t);prepare(h);
 const root=prop(h,'ROOT'),cacheCount=state(h).cacheImported;
 // The prepared v1 schema predates the optional status ID. Simulate that state.
 h.files.delete(root.status);delete root.status;h.properties.set(PREFIX+'ROOT',JSON.stringify(root));
 const b=prop(h,'BUDGET'),hour=Math.max(...Object.keys(b.hours).map(Number));b.hours={[hour]:45*60000};
 h.properties.set(PREFIX+'BUDGET',JSON.stringify(b));h.replaceCode(await bundleRunningProduction(settings));
 assert.deepEqual(h.files.get('production-index').bytes,index);start(h);
 assert.equal(prop(h,'STATUS'),'WATCHING');assert.equal(state(h).cacheImported,cacheCount);assert.equal(prop(h,'METRICS').rawBytesRequested||0,0);
 const report=h.invoke('showMyPaceRunningReport');
 assert.equal(report.budget.usedMinutes,+(Object.values(prop(h,'BUDGET').hours).reduce((a,b)=>a+b,0)/60000).toFixed(2));
 const status=displayedStatus(h);assert.equal(status.budget.limitMinutes,90);assert.equal(status.budget.reserveMinutes,6);assert.equal(status.budget.requestLimit,19800);
 assert(!/original-|management-root|latitude|longitude/.test(JSON.stringify(status)));
});
test('starting from READY during budget wait preserves start intent and publishes a wait notice without replacing the index',async t=>{
 const {h,index}=await productionFixture(t);prepare(h);
 const b=prop(h,'BUDGET'),hour=Math.max(...Object.keys(b.hours).map(Number));b.hours={[hour]:85*60000};
 h.properties.set(PREFIX+'BUDGET',JSON.stringify(b));h.invoke('startMyPaceRunningProduction');
 let s=displayedStatus(h);assert.equal(s.status,'BUDGET_WAIT');assert.equal(s.waitReason,'EXECUTION_BUDGET');assert(s.nextRunAt);assert.equal(s.importedSources,4);
 assert.deepEqual(h.files.get('production-index').bytes,index);
 h.advance(26*3600000);h.invoke('myPaceRunningWake');until(h,['WATCHING']);
 assert.equal(prop(h,'ENABLED'),true);assert.equal(state(h).phase,'watch');assert.equal(displayedStatus(h).status,'WATCHING');
});
test('request budget waits publish a heartbeat and status-write failure leaves the catalog usable',async t=>{
 let fail=false;
 const {h}=await productionFixture(t,{beforeRequest({method,path}){if(fail&&method==='patch'&&h.files.get(path.slice(6))?.meta.name==='sync-status.json')return {status:503};}});
 prepare(h);start(h);const index=Buffer.from(h.files.get('production-index').bytes);
 let b=prop(h,'BUDGET');b.requests=19800;h.properties.set(PREFIX+'BUDGET',JSON.stringify(b));tick(h);
 assert.equal(displayedStatus(h).waitReason,'REQUEST_BUDGET');assert.deepEqual(h.files.get('production-index').bytes,index);
 h.advance(26*3600000);h.invoke('myPaceRunningWake');until(h,['WATCHING']);
 fail=true;tick(h);assert.equal(prop(h,'STATUS_WRITE_ERROR'),'DRIVE_RETRYABLE');assert(prop(h,'ENABLED'));assert.deepEqual(h.files.get('production-index').bytes,index);
 fail=false;tick(h);assert.equal(prop(h,'STATUS_WRITE_ERROR'),null);assert.equal(displayedStatus(h).status,'WATCHING');
 h.invoke('stopMyPaceRunningProduction');assert.equal(displayedStatus(h).status,'STOPPED');assert.equal(displayedStatus(h).enabled,false);
});

test('a copied project identity cannot publish a status file, and fatal errors clear a pending start intent',async t=>{
 const {h}=await productionFixture(t);prepare(h);
 const root=prop(h,'ROOT'),snapshot=Buffer.from(h.files.get(root.status).bytes);
 h.properties.set(PREFIX+'ROOT',JSON.stringify({...root,script:'another-script'}));
 const before=h.requests.length;h.invoke('startMyPaceRunningProduction');
 assert.equal(prop(h,'STATUS'),'PROJECT_OR_CONFIG_CHANGED');assert.equal(prop(h,'ENABLED'),false);assert.equal(prop(h,'RUN_REQUESTED'),false);
 assert.equal(h.requests.length,before);assert.deepEqual(h.files.get(root.status).bytes,snapshot);
});

test('an unexpected native error is diagnosed without losing the catalog, and restart reuses the existing cache',async t=>{
 const {h}=await productionFixture(t);prepare(h);start(h);
 const root=prop(h,'ROOT'),index=Buffer.from(h.files.get(root.catalog).bytes),units=Object.keys(state(h).units).sort();
 const before=prop(h,'METRICS').rawBytesRequested||0;
 let fail=true;
 h.advance(300000);
 h.invoke('myPaceRunningTick',{ScriptApp:{
   getScriptId:()=> 'synthetic-probe-project',getOAuthToken:()=> 'synthetic-not-a-token',
   getProjectTriggers(){if(fail){fail=false;throw Error('A server error occurred. private@example.com secret-drive-id');}return h.triggers.map(item=>({item,getHandlerFunction:()=>item.handler}));},
   deleteTrigger:trigger=>h.triggers.splice(h.triggers.indexOf(trigger.item),1),
 }});
 assert.equal(prop(h,'STATUS'),'UNEXPECTED_ERROR');assert.equal(prop(h,'ENABLED'),false);
 assert(!h.triggers.some(trigger=>['myPaceRunningTick','myPaceRunningWake'].includes(trigger.handler)));
 const failure=prop(h,'LAST_FAILURE');assert.equal(failure.diagnostic.step,'trigger_check');assert.equal(failure.diagnostic.reason,'GOOGLE_SERVICE_ERROR');
 assert(!/secret-drive|private@/.test(JSON.stringify(h.logs)));
 assert.deepEqual(h.files.get(root.catalog).bytes,index);
 const requests=h.requests.length,properties=[...h.properties];
 const report=h.invoke('showMyPaceRunningReport');assert.deepEqual(JSON.parse(JSON.stringify(report.lastError)),failure);
 assert.equal(h.requests.length,requests);assert.deepEqual([...h.properties],properties);
 start(h);assert.equal(prop(h,'STATUS'),'WATCHING');assert.equal(prop(h,'ENABLED'),true);
 assert.equal(prop(h,'LAST_ERROR'),null);assert.deepEqual(prop(h,'LAST_FAILURE'),failure);
 assert.equal(prop(h,'METRICS').rawBytesRequested||0,before);assert.deepEqual(Object.keys(state(h).units).sort(),units);
 assert.deepEqual(h.files.get(root.catalog).bytes,index);
});
