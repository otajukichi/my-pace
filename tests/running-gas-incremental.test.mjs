import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIncrementalConfig, bundleIncrementalProbe } from '../scripts/build-running-gas-incremental.mjs';
import { inventoryDiff, syncStages } from '../processing/running/sync-probe.js';
import { gasProbeHarness } from './helpers/gas-running-probe.mjs';

const KEY = 'MYPACE_INCREMENTAL_V1_', HANDLER = 'myPaceIncrementalTick';
const csv = (day, large = false) => 'time,latitude,longitude,other\n' + Array.from({ length: 70 }, (_, i) => `${new Date(Date.UTC(2026, 0, day, 0, 0, i * 2)).toISOString()},0,${i * .00002 + (day - 1) * .0005},${large ? 'x'.repeat(18000) : ''}`).join('\n');
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mypace-incremental-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sources = [], sourceBytes = new Map();
  for (let i = 0; i < 3; i++) {
    const id = 'private-test-source-' + i, path = join(root, id + '.csv'), bytes = Buffer.from(csv(i + 1, options.large && i === 0));
    await writeFile(path, bytes); sources.push({ id, path }); sourceBytes.set(id, bytes);
  }
  const { config } = await buildIncrementalConfig({ sourceFolder: 'private-test-folder', sources, output: root });
  config.environment = 'simulation';
  const h = await gasProbeHarness(config, sourceBytes, { ...options, bundledCode: await bundleIncrementalProbe(config) });
  return { h, config, sourceBytes };
}
const status = h => JSON.parse(h.properties.get(KEY + 'STATUS') || 'null');
function tick(h) { h.advance(300000); h.invoke(HANDLER); }
function finish(h) {
  for (let i = 0; i < 150; i++) {
    if (!h.triggers.some(t => t.handler === HANDLER)) {
      assert.equal(status(h), 'FUNCTIONAL_PASS', JSON.stringify(h.logs.at(-1))); return h.invoke('showMyPaceIncrementalProbeReport');
    }
    tick(h);
  }
  throw Error('TEST_DID_NOT_FINISH');
}

test('metadata comparison distinguishes content changes, rename, add and removal without reading CSV', () => {
  const f = (name, md5 = 'a'.repeat(32)) => ({ name, size: '100', md5Checksum: md5 });
  const d = inventoryDiff({ a: f('before'), b: f('b'), c: f('c') }, { a: f('after'), b: f('b', 'b'.repeat(32)), d: f('d') });
  assert.deepEqual(d, { added: ['d'], changed: ['b'], removed: ['c'], renamed: ['a'], contentChanged: true });
});

test('isolated cloud lifecycle matches independent full rebuilds through all twelve stages', async t => {
  const { h, sourceBytes } = await fixture(t, { requestMs: 700, listPageSize: 1 });
  h.invoke('startMyPaceIncrementalProbe'); const report = finish(h);
  assert.equal(report.completedStages, syncStages().length); assert.equal(report.functionalPassed, true);
  assert.equal(report.results.every(r => r.matched), true);
  assert(report.results.every(r => r.measuredWorkSeconds > 0 && r.measuredWorkSeconds < r.elapsedSeconds));
  for (const r of report.results.filter(r => ['unchanged', 'rename', 'final_unchanged', 'move_out', 'move_back', 'trash', 'restore'].includes(r.name))) assert.equal(r.rawBytesRequested, 0, r.name);
  const renamed = report.results.find(r => r.name === 'rename'); assert.equal(renamed.changes.renamed, 1); assert(renamed.unchanged);
  const append = report.results.find(r => r.name === 'append'); assert.equal(append.normalizedComputed, 1); assert.equal(append.displayComputed, 1);
  assert(report.results.find(r => r.name === 'backfill').freshComputed >= 1);
  for (const [id, bytes] of sourceBytes) assert.deepEqual(h.files.get(id).bytes, bytes);
  assert(!h.requests.some(r => ['post', 'patch'].includes(r.method) && /^files\/private-test-source-\d$/.test(r.path)));
  assert(h.triggers.some(t => t.handler === 'unrelatedExistingTestHandler'));
  assert(!/private-test-source|latitude|longitude|Bearer/.test(JSON.stringify(h.logs)));
});

test('24h idle verification reads only folder metadata and the listing, with no CSV, checkpoint, or Drive writes', async t => {
  const { h } = await fixture(t); h.invoke('startMyPaceIncrementalProbe'); finish(h);
  const before = h.requests.length; h.invoke('startMyPaceIdleProbe');
  for (let i = 0; i < 290 && h.triggers.some(t => t.handler === HANDLER); i++) tick(h);
  const report = h.invoke('showMyPaceIncrementalProbeReport'), requests = h.requests.slice(before);
  assert.equal(report.status, 'IDLE_PASS'); assert(report.idle.polls >= 288); assert.equal(report.idle.rawBytesRequested, 0);
  assert(requests.every(r => r.method === 'get' && !r.media));
  assert.equal(requests.length, (report.idle.polls + 1) * 2);
  assert(!h.triggers.some(t => t.handler === HANDLER));
});

test('lost copy and publication acknowledgements retry the same IDs without duplicate runs', async t => {
  let copyLost = false, publishLost = false;
  const { h } = await fixture(t, { afterRequest({ method, path, files }) {
    if (!copyLost && path.endsWith('/copy')) { copyLost = true; throw Error('transport'); }
    if (!publishLost && method === 'patch' && files.get(path.slice(6))?.meta.appProperties?.role === 'catalog') { publishLost = true; throw Error('transport'); }
  } });
  h.invoke('startMyPaceIncrementalProbe'); const report = finish(h);
  assert(copyLost && publishLost); assert.equal(report.metrics.retryableErrors, 2);
  assert.equal([...h.files.values()].filter(f => f.meta.appProperties?.role === 'fixture').length, 4);
  assert.equal(report.results.length, 12);
});

test('an incomplete listing preserves the published catalog and never interprets a partial page as deletion', async t => {
  let broken = false;
  const { h } = await fixture(t, { transformList(page) { return broken ? { ...page, incompleteSearch: true } : page; } });
  h.invoke('startMyPaceIncrementalProbe');
  while (!h.state?.catalogHash) tick(h);
  const catalog = [...h.files.values()].find(f => f.meta.appProperties?.role === 'catalog'), previous = Buffer.from(catalog.bytes);
  broken = true;
  for (let i = 0; i < 5 && h.triggers.some(t => t.handler === HANDLER); i++) tick(h);
  assert.equal(status(h), 'DRIVE_INCOMPLETE_INVENTORY'); assert.deepEqual(catalog.bytes, previous);
});

test('manual stop/resume keeps the inventory, publication and cache, and does not reset the budget', async t => {
  const { h } = await fixture(t); h.invoke('startMyPaceIncrementalProbe'); tick(h); tick(h);
  const state = h.state, budget = JSON.parse(h.properties.get(KEY + 'BUDGET')).totalMs;
  h.invoke('stopMyPaceIncrementalProbe'); assert(!h.triggers.some(t => t.handler === HANDLER));
  h.invoke('startMyPaceIncrementalProbe'); assert.deepEqual(h.state, state);
  assert(JSON.parse(h.properties.get(KEY + 'BUDGET')).totalMs > budget); finish(h);
});

test('a saved mid-CSV checkpoint resumes at the next byte range after a lost acknowledgement and manual stop', async t => {
  let dropped = false;
  const { h } = await fixture(t, { large: true, afterRequest({ method, path, files }) {
    const f = files.get(path.slice(6));
    if (!dropped && method === 'patch' && f?.meta.appProperties?.role === 'state' && JSON.parse(f.bytes).job?.offset === 1048576) {
      dropped = true; throw Error('transport');
    }
  } });
  h.invoke('startMyPaceIncrementalProbe');
  while (!dropped) tick(h);
  assert.equal(h.state.job.offset, 1048576); assert.equal(h.state.job.next, 0);
  h.invoke('stopMyPaceIncrementalProbe'); h.invoke('startMyPaceIncrementalProbe'); finish(h);
  const sourceId = h.state.ids['fixture-source-0'];
  const ranges = h.requests.filter(r => r.path === 'files/' + sourceId && r.range).map(r => r.range);
  assert.equal(ranges.length, 2); assert(ranges[0].startsWith('bytes=0-')); assert(ranges[1].startsWith('bytes=1048576-'));
});

test('corrupt or changing CSV content leaves the previous complete catalog available', async t => {
  let corrupted = false;
  const { h } = await fixture(t, { beforeRequest({ path, options, files }) {
    const file = files.get(path.slice(6));
    if (!corrupted && options.headers?.Range && file?.meta.appProperties?.key === 'source-2') { file.bytes[0] ^= 1; corrupted = true; }
  } });
  h.invoke('startMyPaceIncrementalProbe');
  while (!h.state?.catalogHash) tick(h);
  const original = Buffer.from([...h.files.values()].find(f => f.meta.appProperties?.role === 'catalog').bytes);
  while (h.triggers.some(t => t.handler === HANDLER)) tick(h);
  assert(corrupted); assert.equal(status(h), 'SOURCE_CHUNK_MISMATCH');
  assert.deepEqual([...h.files.values()].find(f => f.meta.appProperties?.role === 'catalog').bytes, original);
});

test('sharing the raw destination stops before copying or changing any fixture', async t => {
  const { h } = await fixture(t); h.invoke('startMyPaceIncrementalProbe');
  const root = JSON.parse(h.properties.get(KEY + 'ROOT')); h.files.get(root.raw).meta.shared = true;
  tick(h); assert.equal(status(h), 'OUTPUT_NOT_OWNER_PRIVATE'); assert(!h.requests.some(r => r.path.endsWith('/copy')));
});

test('rolling runtime budget blocks new work; interrupted invocations remain conservatively counted', async t => {
  const { h } = await fixture(t); h.invoke('startMyPaceIncrementalProbe');
  const budget = JSON.parse(h.properties.get(KEY + 'BUDGET')), hour = Object.keys(budget.hours)[0];
  budget.hours[hour] = 3500000; budget.totalMs = 3500000;
  h.properties.set(KEY + 'BUDGET', JSON.stringify(budget)); h.properties.set(KEY + 'ACTIVE', JSON.stringify({ hour }));
  const before = h.requests.length; tick(h);
  assert.equal(status(h), 'EXECUTION_BUDGET_REACHED'); assert.equal(h.requests.length, before);
  assert.equal(h.invoke('showMyPaceIncrementalProbeReport').interruptedInvocations, 1);
});

test('copy authorization failures report a reason code without logging private response details', async t => {
  const { h } = await fixture(t, { beforeRequest({ path }) {
    if (path.endsWith('/copy')) return { status: 403, body: { error: { message: 'private-server-body-do-not-log', errors: [{ reason: 'appNotAuthorizedToFile' }] } } };
  } });
  h.invoke('startMyPaceIncrementalProbe'); tick(h);
  const report = h.invoke('showMyPaceIncrementalProbeReport');
  assert.equal(report.status, 'DRIVE_HTTP_403'); assert.equal(report.lastError.driveReasons[0], 'appNotAuthorizedToFile');
  assert(!JSON.stringify(h.logs).includes('private-server-body-do-not-log')); assert(!h.triggers.some(t => t.handler === HANDLER));
});

test('an interruption during idle cannot produce a passing timing result', async t => {
  const { h } = await fixture(t); h.invoke('startMyPaceIncrementalProbe'); finish(h); h.invoke('startMyPaceIdleProbe');
  const b = JSON.parse(h.properties.get(KEY + 'BUDGET')), hour = Object.keys(b.hours).at(-1);
  b.hours[hour] += 360000; b.totalMs += 360000;
  h.properties.set(KEY + 'BUDGET', JSON.stringify(b)); h.properties.set(KEY + 'ACTIVE', JSON.stringify({ hour }));
  for (let i = 0; i < 290 && h.triggers.some(t => t.handler === HANDLER); i++) tick(h);
  assert.equal(status(h), 'IDLE_TIMING_MISSED');
  h.invoke('startMyPaceIdleProbe'); assert.equal(status(h), 'IDLE_TIMING_MISSED');
});
