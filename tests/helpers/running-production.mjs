import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { bundleDiscoveryProbe } from '../../scripts/build-running-gas-discovery.mjs';
import { buildIncrementalConfig, bundleIncrementalProbe } from '../../scripts/build-running-gas-incremental.mjs';
import { bundleRunningProduction } from '../../scripts/build-running-gas-production.mjs';
import { hash } from '../../processing/running/cache.mjs';
import { gasProbeHarness } from './gas-running-probe.mjs';

export const PREFIX = 'MYPACE_RUNNING_V1_', TICK = 'myPaceRunningTick';
export const md5 = bytes => createHash('md5').update(bytes).digest('hex');
export const csv = (day, large = false) => 'time,latitude,longitude,other\n' + Array.from({ length: 70 }, (_, i) => `${new Date(Date.UTC(2026, 0, day, 0, 0, i * 2)).toISOString()},0,${i * .00002 + (day - 1) * .0005},${large ? 'x'.repeat(18000) : ''}`).join('\n');
export const prop = (h, key, prefix = PREFIX) => JSON.parse(h.properties.get(prefix + key) || 'null');
export const state = h => JSON.parse(h.files.get(prop(h, 'ROOT').state).bytes);
export const tick = h => { h.advance(300000); return h.invoke(TICK); };
export function put(h, id, name, parent, bytes = Buffer.alloc(0), mime = 'application/json') {
  const meta = { id, name, mimeType: mime, parents: parent ? [parent] : [], ownedByMe: true, shared: false, trashed: false,
    size: String(bytes.length), md5Checksum: md5(bytes), version: '1', modifiedTime: '2026-01-01T00:00:00Z' };
  h.files.set(id, { meta, bytes: Buffer.from(bytes) }); return meta;
}
export const folder = (h, id, parent, name = id) => put(h, id, name, parent, undefined, 'application/vnd.google-apps.folder');
export function replaceBytes(h, id, bytes) {
  const f = h.files.get(id); f.bytes = Buffer.from(bytes); f.meta.md5Checksum = md5(f.bytes); f.meta.size = String(f.bytes.length); f.meta.version = String(+f.meta.version + 1);
}
export function until(h, target, max = 120) {
  for (let i = 0; i < max; i++) {
    if (target.includes(prop(h, 'STATUS'))) return prop(h, 'STATUS');
    assert.equal(prop(h, 'ENABLED'), true, JSON.stringify(h.invoke('showMyPaceRunningReport')));
    tick(h);
  }
  assert.fail('No completion: ' + JSON.stringify(h.invoke('showMyPaceRunningReport')));
}
export async function productionFixture(t, options = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'mypace-production-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const sources = [], sourceBytes = new Map();
  for (let i = 0; i < 3; i++) {
    const id = 'original-' + i, path = join(temp, id + '.csv'), bytes = Buffer.from(csv(i + 1));
    await writeFile(path, bytes); sources.push({ id, path }); sourceBytes.set(id, bytes);
  }
  const { config } = await buildIncrementalConfig({ sourceFolder: 'original-folder', sources, output: temp });
  const h = await gasProbeHarness(config, sourceBytes, { ...options, bundledCode: await bundleIncrementalProbe(config) });
  h.invoke('startMyPaceIncrementalProbe');
  for (let i = 0; i < 100 && h.triggers.some(t => t.handler === 'myPaceIncrementalTick'); i++) { h.advance(300000); h.invoke('myPaceIncrementalTick'); }
  assert.equal(prop(h, 'STATUS', 'MYPACE_INCREMENTAL_V1_'), 'FUNCTIONAL_PASS');
  h.invoke('stopMyPaceIncrementalProbe');
  const old = prop(h, 'ROOT', 'MYPACE_INCREMENTAL_V1_');
  h.replaceCode(await bundleDiscoveryProbe({ previousConfigHash: hash(config) }));
  h.invoke('startMyPaceNewCsvCheck');
  put(h, 'fourth-copy', 'fourth.csv', old.raw, Buffer.from(csv(9)), 'text/csv');
  for (let i = 0; i < 50 && h.triggers.some(t => t.handler === 'myPaceNewCsvTick'); i++) { h.advance(300000); h.invoke('myPaceNewCsvTick'); }
  assert.equal(prop(h, 'STATUS', 'MYPACE_NEW_CSV_V1_'), 'NEW_CSV_PASS');
  const passedRoot = prop(h, 'ROOT', 'MYPACE_NEW_CSV_V1_');
  const passedState = JSON.parse(h.files.get(passedRoot.state).bytes);
  put(h, 'original-fourth', 'fourth.csv', config.sourceFolder, Buffer.from(csv(9)), 'text/csv');
  folder(h, 'management-root'); folder(h, 'production-running', 'management-root', 'running'); folder(h, 'production-derived', 'production-running', 'derived');
  for (const [id, file] of [...h.files]) if (file.meta.parents?.includes(passedRoot.derived)) {
    if (/^[a-f0-9]{64}\.json$/.test(file.meta.name)) put(h, 'uploaded-' + id, file.meta.name, 'production-derived', file.bytes);
    if (file.meta.name === 'new-csv-index.json') put(h, 'production-index', 'index.json', 'production-derived', file.bytes);
  }
  assert(h.files.has('production-index'));
  const settings = { rootFolderId: 'management-root', sourceFolderId: config.sourceFolder };
  h.replaceCode(await bundleRunningProduction(settings)); h.advance(26 * 3600000);
  const baseline = structuredClone([...h.files]), before = h.requests.length, index = Buffer.from(h.files.get('production-index').bytes);
  return { h, temp, settings, baseline, before, index, passedState };
}
export function prepare(h) { h.invoke('prepareMyPaceRunningProduction'); until(h, ['READY']); }
export function start(h) { h.invoke('startMyPaceRunningProduction'); until(h, ['WATCHING']); }
export function unchangedOriginals(h, baseline) {
  for (const [id, file] of baseline) if (id !== 'production-index') {
    assert.deepEqual(h.files.get(id)?.meta, file.meta, id); assert.deepEqual(h.files.get(id)?.bytes, Buffer.from(file.bytes), id);
  }
}
