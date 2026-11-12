import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { bundleDiscoveryProbe } from '../scripts/build-running-gas-discovery.mjs';
import { buildIncrementalConfig, bundleIncrementalProbe } from '../scripts/build-running-gas-incremental.mjs';
import { prepareRunning } from '../processing/running/materialize.mjs';
import { hash, json } from '../processing/running/cache.mjs';
import { gasProbeHarness } from './helpers/gas-running-probe.mjs';

const KEY = 'MYPACE_NEW_CSV_V1_', OLD = 'MYPACE_INCREMENTAL_V1_', HANDLER = 'myPaceNewCsvTick';
const csv = (day, large = false) => 'time,latitude,longitude,other\n' + Array.from({ length: 70 }, (_, i) => `${new Date(Date.UTC(2026, 0, day, 0, 0, i * 2)).toISOString()},0,${i * .00002 + (day - 1) * .0005},${large ? 'x'.repeat(18000) : ''}`).join('\n');
const md5 = bytes => createHash('md5').update(bytes).digest('hex');
const prop = (h, key) => JSON.parse(h.properties.get(KEY + key) || 'null');
const oldProp = (h, key) => JSON.parse(h.properties.get(OLD + key) || 'null');
const state = h => JSON.parse(h.files.get(prop(h, 'ROOT').state).bytes);
const tick = h => { h.advance(300000); return h.invoke(HANDLER); };
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mypace-new-csv-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sources = [], sourceBytes = new Map();
  for (let i = 0; i < 3; i++) {
    const id = 'private-test-source-' + i, path = join(root, id + '.csv'), bytes = Buffer.from(csv(i + 1));
    await writeFile(path, bytes); sources.push({ id, path }); sourceBytes.set(id, bytes);
  }
  const { config } = await buildIncrementalConfig({ sourceFolder: 'private-test-folder', sources, output: root });
  const h = await gasProbeHarness(config, sourceBytes, { ...options, bundledCode: await bundleIncrementalProbe(config) });
  // Prepare the already-verified old environment only in local tests.
  h.invoke('startMyPaceIncrementalProbe');
  for (let i = 0; i < 100 && h.triggers.some(t => t.handler === 'myPaceIncrementalTick'); i++) {
    h.advance(300000); h.invoke('myPaceIncrementalTick');
  }
  assert.equal(oldProp(h, 'STATUS'), 'FUNCTIONAL_PASS');
  h.invoke('stopMyPaceIncrementalProbe');
  // Match the older Google version: no newly-introduced completion properties.
  h.properties.delete(OLD + 'OUTCOME_FUNCTIONAL');
  const old = structuredClone({ files: [...h.files], properties: [...h.properties] });
  const newConfig = { previousConfigHash: hash(config) };
  h.replaceCode(await bundleDiscoveryProbe(newConfig));
  return { h, root, config, old, newConfig };
}
function inject(h, day = 9, large = false) {
  const id = 'unknown-upload', bytes = Buffer.from(csv(day, large));
  const meta = { id, name: 'new.csv', mimeType: 'text/csv', parents: [oldProp(h, 'ROOT').raw], ownedByMe: true, shared: false,
    trashed: false, version: '1', size: String(bytes.length), md5Checksum: md5(bytes) };
  h.files.set(id, { bytes, meta }); return h.files.get(id);
}
function finish(h) {
  for (let i = 0; i < 30 && h.triggers.some(t => t.handler === HANDLER); i++) tick(h);
  const report = h.invoke('showMyPaceNewCsvReport');
  assert.equal(report.status, 'NEW_CSV_PASS', JSON.stringify(report)); return report;
}
function oldUnchanged(h, old) {
  for (const [id, value] of old.files) {
    assert.deepEqual(h.files.get(id).meta, value.meta);
    assert.deepEqual(h.files.get(id).bytes, Buffer.from(value.bytes));
  }
  assert.deepEqual([...h.properties].filter(([key]) => key.startsWith(OLD)), old.properties);
}

test('one unknown CSV reuses the passed checkpoint, adds no folders, reads no old CSV, and matches an independent rebuild', async t => {
  const { h, root, old } = await fixture(t); const before = h.requests.length;
  h.invoke('startMyPaceNewCsvCheck');
  assert.equal(prop(h, 'STATUS'), 'WAITING_FOR_CSV'); assert.equal(prop(h, 'METRICS').rawBytesRequested || 0, 0);
  const uploaded = inject(h); const report = finish(h);
  assert.equal(report.rawBytesRequested, uploaded.bytes.length); assert.equal(report.unchangedPollPassed, true);
  assert.equal(report.catalogChanged, true); assert.equal(report.existingCsvReread, false);
  oldUnchanged(h, old);
  assert.equal([...h.files.values()].filter(f => f.meta.mimeType === 'application/vnd.google-apps.folder').length,
    old.files.filter(([, f]) => f.meta.mimeType === 'application/vnd.google-apps.folder').length);
  const reads = h.requests.slice(before).filter(r => r.range);
  assert(reads.every(r => r.path === 'files/unknown-upload'));
  assert(!h.requests.slice(before).some(r => r.path.endsWith('/copy')));
  // Keep existing run IDs from the passed converter, derive only the new ID.
  const prior = JSON.parse(Buffer.from(old.files.find(([id]) => id === oldProp(h, 'ROOT').state)[1].bytes)), sources = [];
  for (const [id, meta] of Object.entries(prior.committed)) {
    const path = join(root, id + '.csv'); await writeFile(path, h.files.get(id).bytes); sources.push({ id: meta.appProperties.key, path });
  }
  const path = join(root, 'new.csv'), cache = join(root, 'new-id-cache'); await writeFile(path, uploaded.bytes);
  await prepareRunning({ sources: [{ id: 'unknown', path }], cache, output: join(root, 'new-id-output') });
  sources.push({ id: JSON.parse(await readFile(join(cache, hash('unknown') + '.json'), 'utf8')).value.gpsHash, path });
  const expected = await prepareRunning({ sources, cache: join(root, 'independent-cache'), output: join(root, 'independent-output') });
  assert.equal(state(h).catalogHash, hash(json(expected.catalog)));
  assert.deepEqual(h.triggers, [{ handler: 'unrelatedExistingTestHandler' }]);
  const outcome = prop(h, 'OUTCOME'); h.invoke('stopMyPaceNewCsvCheck');
  assert.deepEqual(prop(h, 'OUTCOME'), outcome);
  const props = [...h.properties], count = h.requests.length; h.invoke('showMyPaceNewCsvReport');
  assert.deepEqual([...h.properties], props); assert.equal(h.requests.length, count);
});

test('waiting and the final no-reread check require no CSV; without an upload the check ends automatically', async t => {
  const { h, old } = await fixture(t); h.invoke('startMyPaceNewCsvCheck');
  const start = h.requests.length; tick(h); tick(h);
  assert.equal(prop(h, 'STATUS'), 'WAITING_FOR_CSV');
  assert.equal(h.requests.length - start, 4);
  assert(h.requests.slice(start).every(r => r.method === 'get' && !r.media && !r.range)); oldUnchanged(h, old);
  h.advance(14400000); tick(h);
  assert.equal(prop(h, 'STATUS'), 'CHECK_WINDOW_ENDED'); assert(!h.triggers.some(t => t.handler === HANDLER));
});

test('the previous USER_STOPPED report and missing new outcome fields do not require repeating the old experiment', async t => {
  const { h, old } = await fixture(t);
  assert.equal(oldProp(h, 'STATUS'), 'USER_STOPPED');
  assert.equal(oldProp(h, 'OUTCOME_FUNCTIONAL'), null);
  h.advance(3 * 86400000); // The previous experiment's deadline has already passed.
  h.invoke('startMyPaceNewCsvCheck'); inject(h); finish(h); oldUnchanged(h, old);
});

test('wrong project/configuration or missing baseline cache stops before creating output', async t => {
  const { h, newConfig } = await fixture(t); const size = h.files.size;
  h.replaceCode(await bundleDiscoveryProbe({ ...newConfig, previousConfigHash: '0'.repeat(64) }));
  h.invoke('startMyPaceNewCsvCheck'); assert.equal(prop(h, 'STATUS'), 'PASSED_PROJECT_REQUIRED'); assert.equal(h.files.size, size);
  h.replaceCode(await bundleDiscoveryProbe(newConfig));
  const f = h.files.get(oldProp(h, 'ROOT').state), s = JSON.parse(f.bytes); s.normalized = {};
  f.bytes = Buffer.from(json(s)); f.meta.size = String(f.bytes.length); f.meta.md5Checksum = md5(f.bytes);
  h.invoke('startMyPaceNewCsvCheck'); assert.equal(prop(h, 'STATUS'), 'BASELINE_CACHE_MISSING'); assert.equal(h.files.size, size);
  assert(!h.triggers.some(t => t.handler === HANDLER));
});

test('new large CSV resumes its serialized digest after a transient range failure', async t => {
  let fail = false;
  const { h, old } = await fixture(t, { beforeRequest({ path, options }) {
    if (fail && path === 'files/unknown-upload' && /^bytes=1048576-/.test(options.headers?.Range || '')) { fail = false; return { status: 503 }; }
  } });
  h.invoke('startMyPaceNewCsvCheck'); inject(h, 9, true); fail = true;
  tick(h); tick(h); assert.equal(prop(h, 'STATUS'), 'DRIVE_RETRYABLE'); assert.equal(state(h).job.digest.length, 1048576);
  const before = h.requests.length; finish(h);
  assert.match(h.requests.slice(before).find(r => r.range).range, /^bytes=1048576-/); oldUnchanged(h, old);
});

test('corrupted new CSV bytes preserve the previous view and expose only an error code', async t => {
  let corrupt = false;
  const { h, old } = await fixture(t, { beforeRequest({ path, options, files }) {
    if (corrupt && path === 'files/unknown-upload' && options.headers?.Range) {
      const b = files.get('unknown-upload').bytes; b[b.indexOf(',0,') + 1] = 49; corrupt = false;
    }
  } });
  h.invoke('startMyPaceNewCsvCheck'); inject(h); corrupt = true; tick(h); tick(h);
  assert.equal(prop(h, 'STATUS'), 'SOURCE_CHECKSUM_MISMATCH'); oldUnchanged(h, old);
  assert(!h.triggers.some(t => t.handler === HANDLER));
  assert(!/private-test-source|private-test-folder|unknown-upload|latitude|longitude/.test(JSON.stringify(h.logs)));
});

test('lost publication and final-phase responses retry without touching the old catalog', async t => {
  let armed = false, lost = false, phaseLost = false;
  const { h, old } = await fixture(t, { afterRequest({ method, path, files }) {
    const f = files.get(path.slice(6));
    if (armed && !lost && method === 'post' && path === 'files' && [...files.values()].some(f => f.meta.name === 'new-csv-index.json')) {
      lost = true; throw Error('private response detail');
    }
    if (armed && !phaseLost && method === 'patch' && f?.meta.name === 'new-csv-checkpoint.json' && JSON.parse(f.bytes).phase === 'check') {
      phaseLost = true; throw Error('private response detail');
    }
  } });
  h.invoke('startMyPaceNewCsvCheck'); inject(h); armed = true; finish(h);
  assert(lost && phaseLost); oldUnchanged(h, old);
  assert.equal([...h.files.values()].filter(f => f.meta.name === 'new-csv-index.json').length, 1);
});
