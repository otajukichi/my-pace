import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleProbe } from './build-running-gas-probe.mjs';
import { buildIncrementalConfig } from './build-running-gas-incremental.mjs';
import { privatePath } from '../processing/running/private-path.mjs';
import { json } from '../processing/running/cache.mjs';

export const bundleDiscoveryProbe = config => bundleProbe(config, {
  hostPaths: ['processing/running/gas/runtime.gs', 'processing/running/gas/fixtures.gs',
    'processing/running/gas/sync-engine.gs', 'processing/running/gas/discovery-host.gs'],
  extraRoots: { MP_SYNC: 'processing/running/sync-probe.js', MP_MD5: 'processing/running/md5.js' },
});
export async function buildDiscoveryConfig(options) {
  const result = await buildIncrementalConfig({ ...options, contentIdentity: true });
  // These metadata checks protect the original-to-copy operation only.
  // There are no precomputed chunk checksums in this kit.
  for (const source of [...result.config.sources, ...Object.values(result.config.control)]) {
    delete source.chunks; delete source.sha256;
  }
  return result;
}
export async function createDiscoveryKit({ manifest, output = 'data/running-gas-discovery' }) {
  manifest = await privatePath(manifest); output = await privatePath(output, { directory: true });
  const selected = JSON.parse(await readFile(manifest, 'utf8'));
  if (!selected.sourceFolder || selected.sources?.length !== 3 || new Set(selected.sources.map(s => s.id)).size !== 3) throw Error('THREE_SOURCE_MANIFEST_REQUIRED');
  const sources = [];
  for (const source of selected.sources) sources.push({ id: source.id, path: await privatePath(source.path) });
  const { config, counts } = await buildDiscoveryConfig({ sourceFolder: selected.sourceFolder, sources, output });
  const code = await bundleDiscoveryProbe(config);
  await writeFile(join(output, 'Code.gs'), code, { mode: 0o600 });
  await writeFile(join(output, 'config.json'), json(config), { mode: 0o600 });
  await copyFile(new URL('../processing/running/gas/appsscript.json', import.meta.url), join(output, 'appsscript.json'));
  const buildId = code.match(/const MYPACE_BUILD_ID = "([a-z0-9-]+)";/)[1];
  await writeFile(join(output, 'build-info.json'), json({ buildId, scope: 'ISOLATED_DISCOVERY_PROBE', ...counts }), { mode: 0o600 });
  return { buildId, ...counts };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) options[args[i]] = args[i + 1];
  if (!options['--manifest']) throw Error('Usage: npm run prepare:gas-discovery -- --manifest data/running-gas-selection.json');
  console.log(JSON.stringify(await createDiscoveryKit({ manifest: options['--manifest'], output: options['--output'] })));
}
