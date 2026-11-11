import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleProbe } from './build-running-gas-probe.mjs';
import { privatePath } from '../processing/running/private-path.mjs';
import { prepareRunning } from '../processing/running/materialize.mjs';
import { hash, json } from '../processing/running/cache.mjs';
import { controlCsv, syncStages } from '../processing/running/sync-probe.js';

export const bundleIncrementalProbe = config => bundleProbe(config, {
  hostPaths: ['processing/running/gas/runtime.gs', 'processing/running/gas/fixtures.gs', 'processing/running/gas/incremental-host.gs'], extraRoots: { MP_SYNC: 'processing/running/sync-probe.js' },
});

export async function describeSource(path, chunkBytes = 1048576) {
  const md5 = createHash('md5'), sha = createHash('sha256'), chunks = []; let size = 0, pending = Buffer.alloc(0);
  for await (const bytes of createReadStream(path, { highWaterMark: chunkBytes })) {
    size += bytes.length; md5.update(bytes); sha.update(bytes); pending = Buffer.concat([pending, bytes]);
    while (pending.length >= chunkBytes) { chunks.push(hash(pending.subarray(0, chunkBytes))); pending = pending.subarray(chunkBytes); }
  }
  if (pending.length) chunks.push(hash(pending));
  return { size, md5: md5.digest('hex'), sha256: sha.digest('hex'), chunks };
}

/** Full Node rebuilds in independent caches are the reference, not the GAS
 * incremental algorithm replaying itself. Real data stays in the private kit. */
export async function buildIncrementalConfig({ sourceFolder, sources, output, contentIdentity = false }) {
  const order = await prepareRunning({ sources, output: join(output, 'ordering-reference'), cache: join(output, 'ordering-cache') });
  const sorted = [];
  for (const source of sources) {
    const normalized = JSON.parse(await readFile(join(output, 'ordering-cache', hash(source.id) + '.json'), 'utf8')).value;
    const metadata = await describeSource(source.path);
    if (metadata.sha256 !== normalized.contentHash) throw Error('SOURCE_CHANGED_DURING_KIT_BUILD');
    sorted.push({ ...source, metadata, start: normalized.start, gpsHash: normalized.gpsHash });
  }
  sorted.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const config = { sourceFolder, chunkBytes: 1048576, environment: 'apps-script', sources: sorted.map((s, i) => ({ key: 'source-' + i, id: s.id, ...s.metadata })),
    control: {}, references: [] };
  const paths = new Map(sorted.map((s, i) => ['source-' + i, s.path]));
  for (const variant of ['closed', 'open']) {
    const path = join(output, 'control-' + variant + '.csv'); await writeFile(path, controlCsv(variant === 'open'), { mode: 0o600 });
    config.control[variant] = await describeSource(path); paths.set('control-' + variant, path);
  }
  const identities = new Map(sorted.map((s, i) => ['source-' + i, s.gpsHash]));
  if (contentIdentity) for (const variant of ['closed', 'open']) {
    const key = 'control-' + variant, cache = join(output, key + '-identity');
    await prepareRunning({ sources: [{ id: key, path: paths.get(key) }], output: join(output, key + '-identity-view'), cache });
    identities.set(key, JSON.parse(await readFile(join(cache, hash(key) + '.json'), 'utf8')).value.gpsHash);
  }
  const references = new Map();
  for (const stage of syncStages()) {
    const selected = stage.active.map(key => {
      const entry = key === 'control' ? 'control-' + (stage.variant || 'closed') : key;
      return { id: contentIdentity ? identities.get(entry) : key, path: paths.get(entry) };
    });
    const signature = hash(selected);
    if (!references.has(signature)) {
      const result = await prepareRunning({ sources: selected, output: join(output, 'reference-' + stage.name), cache: join(output, 'cache-' + stage.name) });
      references.set(signature, hash(json(result.catalog)));
    }
    config.references.push(references.get(signature));
  }
  return { config, counts: { sources: 3, sourceBytes: order.stats.sourceBytes, stages: syncStages().length } };
}

export async function createIncrementalKit({ manifest, output = 'data/running-gas-incremental' }) {
  manifest = await privatePath(manifest); output = await privatePath(output, { directory: true });
  const selected = JSON.parse(await readFile(manifest, 'utf8'));
  if (!selected.sourceFolder || selected.sources?.length !== 3 || new Set(selected.sources.map(s => s.id)).size !== 3) throw Error('THREE_SOURCE_MANIFEST_REQUIRED');
  const sources = [];
  for (const source of selected.sources) sources.push({ id: source.id, path: await privatePath(source.path) });
  const { config, counts } = await buildIncrementalConfig({ sourceFolder: selected.sourceFolder, sources, output });
  await writeFile(join(output, 'Code.gs'), await bundleIncrementalProbe(config), { mode: 0o600 });
  await writeFile(join(output, 'config.json'), json(config), { mode: 0o600 });
  await copyFile(new URL('../processing/running/gas/appsscript.json', import.meta.url), join(output, 'appsscript.json'));
  return counts;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) options[args[i]] = args[i + 1];
  if (!options['--manifest']) throw Error('Usage: npm run prepare:gas-incremental -- --manifest data/running-gas-selection.json');
  console.log(JSON.stringify(await createIncrementalKit({ manifest: options['--manifest'], output: options['--output'] })));
}
