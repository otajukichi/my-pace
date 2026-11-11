import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildDiscoveryConfig, bundleDiscoveryProbe } from '../scripts/build-running-gas-discovery.mjs';
import { prepareRunning } from '../processing/running/materialize.mjs';
import { hash, json } from '../processing/running/cache.mjs';
import { gasProbeHarness } from './helpers/gas-running-probe.mjs';

const KEY = 'MYPACE_DISCOVERY_V1_', HANDLER = 'myPaceDiscoveryTick';
const csv = (day, large = false) => 'time,latitude,longitude,other\n' + Array.from({ length: 70 }, (_, i) => `${new Date(Date.UTC(2026, 0, day, 0, 0, i * 2)).toISOString()},0,${i * .00002 + (day - 1) * .0005},${large ? 'x'.repeat(18000) : ''}`).join('\n');
const md5 = bytes => createHash('md5').update(bytes).digest('hex');
const prop = (h, key) => JSON.parse(h.properties.get(KEY + key) || 'null');
const status = h => prop(h, 'STATUS');
const tick = h => { h.advance(300000); h.invoke(HANDLER); };
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mypace-discovery-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sources = [], sourceBytes = new Map();
  for (let i = 0; i < 3; i++) {
    const id = 'private-test-source-' + i, path = join(root, id + '.csv'), bytes = Buffer.from(csv(i + 1, options.large && i === 0));
    await writeFile(path, bytes); sources.push({ id, path }); sourceBytes.set(id, bytes);
  }
  const { config } = await buildDiscoveryConfig({ sourceFolder: 'private-test-folder', sources, output: root });
  config.environment = 'simulation';
  const h = await gasProbeHarness(config, sourceBytes, { ...options, bundledCode: await bundleDiscoveryProbe(config) });
  return { root, h, config, sourceBytes };
}
function finish(h) {
  h.invoke('startMyPaceDiscoveryProbe');
  for (let i = 0; i < 150 && h.triggers.some(t => t.handler === HANDLER); i++) tick(h);
  assert.equal(status(h), 'DISCOVERY_PASS', JSON.stringify(h.logs.at(-1)));
  return h.invoke('showMyPaceDiscoveryReport');
}
function inject(h, id = 'unknown-upload', bytes = Buffer.from(csv(9))) {
  const meta = { id, name: id + '.csv', mimeType: 'text/csv', parents: [prop(h, 'ROOT').raw], ownedByMe: true, shared: false,
    trashed: false, version: '1', size: String(bytes.length), md5Checksum: md5(bytes) };
  h.files.set(id, { bytes, meta }); return h.files.get(id);
}

test('generic worker matches twelve independent rebuilds; sources and permissions remain intact; completion survives stop', async t => {
  const { h, config, sourceBytes } = await fixture(t, { listPageSize: 1 });
  const report = finish(h);
  assert.equal(report.completedStages, 12); assert.equal(report.retainedGenerations, 2);
  for (let i = 0; i < 12; i++) assert.equal(prop(h, 'RESULT_' + i).matched, true);
  for (const source of config.sources) {
    assert.deepEqual(h.files.get(source.id).bytes, sourceBytes.get(source.id));
    assert.deepEqual(h.files.get(source.id).meta.parents, [config.sourceFolder]);
    assert(!h.requests.some(r => r.method !== 'get' && r.path === 'files/' + source.id));
    assert(!JSON.stringify(h.logs).includes(source.id)); assert(!JSON.stringify(h.logs).includes(source.md5));
    assert.equal(source.chunks, undefined);
  }
  const outcome = JSON.stringify(report.completedOutcome), before = h.requests.length;
  h.invoke('stopMyPaceDiscoveryProbe');
  const stopped = h.invoke('showMyPaceDiscoveryReport');
  assert.equal(stopped.status, 'USER_STOPPED'); assert.equal(JSON.stringify(stopped.completedOutcome), outcome);
  h.invoke('startMyPaceDiscoveryProbe'); assert.equal(status(h), 'ALREADY_COMPLETED');
  assert.equal(h.requests.length, before); assert.deepEqual(h.triggers, [{ handler: 'unrelatedExistingTestHandler' }]);
  assert(h.logs.every(item => JSON.stringify(item).length < 4000));
});

test('an unseen upload with no fixture marker is discovered, matches a new independent reference, and idles without media or Drive writes', async t => {
  const { h, root } = await fixture(t); finish(h); h.invoke('startMyPaceDiscoveryWatch');
  inject(h); const prior = prop(h, 'METRICS').rawBytesRequested;
  for (let i = 0; i < 30 && !prop(h, 'WATCH').updates; i++) tick(h);
  assert.equal(prop(h, 'WATCH').updates, 1, JSON.stringify(h.logs.at(-1)));
  assert.equal(prop(h, 'METRICS').rawBytesRequested - prior, h.files.get('unknown-upload').bytes.length);
  // Independent Node normalization and full rebuild, using all current inputs.
  const sources = [], inbox = prop(h, 'ROOT').raw;
  for (const [id, file] of h.files) if (file.meta.parents?.[0] === inbox && !file.meta.trashed) {
    const path = join(root, 'oracle-' + id + '.csv'); await writeFile(path, file.bytes); sources.push({ id, path });
  }
  const cache = join(root, 'new-oracle-cache');
  await prepareRunning({ sources, cache, output: join(root, 'new-oracle-order') });
  const identified = [];
  for (const source of sources) identified.push({ path: source.path, id: JSON.parse(await readFile(join(cache, hash(source.id) + '.json'), 'utf8')).value.gpsHash });
  const expected = await prepareRunning({ sources: identified, cache: join(root, 'new-oracle-full-cache'), output: join(root, 'new-oracle-full') });
  assert.equal(h.state.catalogHash, hash(json(expected.catalog)));
  const start = h.requests.length;
  for (let i = 0; i < 10; i++) tick(h);
  const idle = h.requests.slice(start);
  assert.equal(idle.length, 20); assert(idle.every(r => r.method === 'get' && !r.media && !r.range));
  const watch = prop(h, 'WATCH'); h.advance(86400000); tick(h);
  assert.equal(status(h), 'WATCH_COMPLETE'); assert.equal(prop(h, 'WATCH').updates, watch.updates);
  assert(!h.triggers.some(t => t.handler === HANDLER));
});

test('unknown corrupt bytes cannot replace the last catalog; fixing the copy and resuming succeeds', async t => {
  let corrupt = false;
  const { h } = await fixture(t, { beforeRequest({ path, options, files }) {
    if (corrupt && path === 'files/unknown-upload' && options.headers?.Range) {
      const bytes = files.get('unknown-upload').bytes; bytes[bytes.indexOf(',0,') + 1] = 49; corrupt = false;
    }
  } });
  finish(h); const original = h.state.catalogHash; h.invoke('startMyPaceDiscoveryWatch'); inject(h); corrupt = true;
  tick(h); tick(h);
  assert.equal(status(h), 'SOURCE_CHECKSUM_MISMATCH', JSON.stringify(h.logs.at(-1)));
  assert.equal(h.state.catalogHash, original);
  const f = inject(h, 'unknown-upload', Buffer.from(csv(10))); f.meta.version = '2';
  h.invoke('startMyPaceDiscoveryWatch');
  for (let i = 0; i < 10 && !prop(h, 'WATCH').updates; i++) tick(h);
  assert.equal(prop(h, 'WATCH').updates, 1); assert.notEqual(h.state.catalogHash, original);
  assert.equal(prop(h, 'OUTCOME').status, 'DISCOVERY_PASS');
});

test('interrupted range reads resume from a persisted digest and byte offset', async t => {
  let fail = false;
  const { h } = await fixture(t, { large: true, beforeRequest({ options }) {
    if (fail && /^bytes=1048576-/.test(options.headers?.Range || '')) { fail = false; return { status: 503 }; }
  } });
  h.invoke('startMyPaceDiscoveryProbe'); fail = true;
  for (let i = 0; i < 10 && status(h) !== 'DRIVE_RETRYABLE'; i++) tick(h);
  assert.equal(status(h), 'DRIVE_RETRYABLE'); assert.equal(h.state.job.digest.length, 1048576);
  const before = h.requests.length; h.invoke('stopMyPaceDiscoveryProbe'); fail = false; finish(h);
  const range = h.requests.slice(before).find(r => r.range);
  assert.match(range.range, /^bytes=1048576-/);
});

test('partial listings and shared inputs preserve the existing publication and stop safely', async t => {
  let incomplete = false;
  const { h } = await fixture(t, { transformList: page => incomplete ? { ...page, incompleteSearch: true } : page });
  finish(h); const original = h.state.catalogHash; h.invoke('startMyPaceDiscoveryWatch'); incomplete = true; tick(h);
  assert.equal(status(h), 'DRIVE_INCOMPLETE_INVENTORY'); assert.equal(h.state.catalogHash, original);
  incomplete = false; inject(h).meta.shared = true;
  h.invoke('startMyPaceDiscoveryWatch'); const before = h.requests.length; tick(h);
  assert.equal(status(h), 'INPUT_NOT_OWNER_PRIVATE'); assert.equal(h.state.catalogHash, original);
  assert(!h.requests.slice(before).some(r => r.range));
});

test('read-only reports do not write or restart; public build identifier ignores private configuration', async t => {
  const { h, config } = await fixture(t); finish(h);
  const props = [...h.properties], requests = h.requests.length;
  h.invoke('showMyPaceDiscoveryReport'); h.invoke('showMyPaceDiscoveryDetails');
  assert.deepEqual([...h.properties], props); assert.equal(h.requests.length, requests);
  const other = await bundleDiscoveryProbe({ ...config, sourceFolder: 'other-private-folder' });
  const build = code => code.match(/const MYPACE_BUILD_ID = "([a-z0-9-]+)";/)[1];
  assert.equal(build(h.code), build(other));
});

test('lost copy and catalog responses do not duplicate sources or publish incomplete objects', async t => {
  let copyLost = false, publishLost = false;
  const { h } = await fixture(t, { afterRequest({ method, path, files }) {
    if (!copyLost && path.endsWith('/copy')) { copyLost = true; throw Error('private transport detail'); }
    if (!publishLost && method === 'patch' && files.get(path.slice(6))?.meta.appProperties?.role === 'catalog') {
      publishLost = true; throw Error('private transport detail');
    }
  } });
  const report = finish(h);
  assert(copyLost && publishLost); assert.equal(report.metrics.retryableErrors, 2);
  assert.equal([...h.files.values()].filter(f => f.meta.appProperties?.role === 'fixture').length, 4);
  for (const generation of h.state.generations) assert.equal(hash(h.files.get(generation.id).bytes), generation.hash);
  assert(!JSON.stringify(h.logs).includes('private transport detail'));
});

test('metadata revision changes during a download cannot publish a mixed generation', async t => {
  let change = false;
  const { h } = await fixture(t, { afterRequest({ path, options, files }) {
    if (change && path === 'files/unknown-upload' && options.headers?.Range) { files.get('unknown-upload').meta.version = '2'; change = false; }
  } });
  finish(h); const old = h.state.catalogHash; h.invoke('startMyPaceDiscoveryWatch'); inject(h); change = true;
  tick(h); tick(h); assert.equal(status(h), 'SOURCE_CHANGED_DURING_READ'); assert.equal(h.state.catalogHash, old);
  h.invoke('startMyPaceDiscoveryWatch');
  for (let i = 0; i < 5 && !prop(h, 'WATCH').updates; i++) tick(h);
  assert.equal(prop(h, 'WATCH').updates, 1);
});

test('empty inventories never erase the last view, and expired pending work is not reported complete', async t => {
  const { h } = await fixture(t); finish(h); h.invoke('startMyPaceDiscoveryWatch');
  const old = h.state.catalogHash, inbox = prop(h, 'ROOT').raw;
  for (const f of h.files.values()) if (f.meta.parents?.[0] === inbox) f.meta.trashed = true;
  tick(h); assert.equal(status(h), 'EMPTY_INVENTORY_REQUIRES_REVIEW'); assert.equal(h.state.catalogHash, old);
  inject(h); h.invoke('startMyPaceDiscoveryWatch'); tick(h);
  assert.equal(prop(h, 'SUMMARY').pendingUpdate, true);
  h.advance(86400000); tick(h);
  assert.equal(status(h), 'WATCH_INCOMPLETE'); assert.equal(prop(h, 'WATCH').completed, false);
  assert.equal(h.state.catalogHash, old); assert(!h.triggers.some(t => t.handler === HANDLER));
});

test('rolling budget exhaustion stops before requests and does not erase completion evidence', async t => {
  const { h } = await fixture(t); finish(h); h.invoke('startMyPaceDiscoveryWatch');
  const b = prop(h, 'BUDGET'), hour = Object.keys(b.hours).at(-1); b.hours[hour] = 3600000;
  h.properties.set(KEY + 'BUDGET', JSON.stringify(b)); const before = h.requests.length;
  tick(h); assert.equal(status(h), 'EXECUTION_BUDGET_REACHED'); assert.equal(h.requests.length, before);
  assert.equal(prop(h, 'OUTCOME').status, 'DISCOVERY_PASS'); assert(!h.triggers.some(t => t.handler === HANDLER));
});
