import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleProbe } from './build-running-gas-probe.mjs';
import { privatePath } from '../processing/running/private-path.mjs';
import { hash, json } from '../processing/running/cache.mjs';

export const bundleDiscoveryProbe = config => bundleProbe(config, {
  hostPaths: ['processing/running/gas/runtime.gs', 'processing/running/gas/sync-engine.gs', 'processing/running/gas/discovery-host.gs'],
  extraRoots: { MP_SYNC: 'processing/running/sync-probe.js', MP_MD5: 'processing/running/md5.js' },
});
export async function createDiscoveryKit({ previousConfig = 'data/running-gas-incremental/config.json', output = 'data/running-gas-discovery' } = {}) {
  previousConfig = await privatePath(previousConfig); output = await privatePath(output, { directory: true });
  const previous = JSON.parse(await readFile(previousConfig, 'utf8'));
  if (previous.sources?.length !== 3 || previous.references?.length !== 12) throw Error('PREVIOUS_INCREMENTAL_CONFIG_REQUIRED');
  // The kit needs no source IDs, GPS, new-source hashes or reference catalogs.
  const config = { previousConfigHash: hash(previous) }, code = await bundleDiscoveryProbe(config);
  await writeFile(join(output, 'Code.gs'), code, { mode: 0o600 });
  await writeFile(join(output, 'config.json'), json(config), { mode: 0o600 });
  const buildId = code.match(/const MYPACE_BUILD_ID = "([a-z0-9-]+)";/)[1];
  await writeFile(join(output, 'build-info.json'), json({ buildId, scope: 'ONE_NEW_CSV_ON_EXISTING_CACHE' }), { mode: 0o600 });
  return { buildId, previousResultsReused: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) options[args[i]] = args[i + 1];
  console.log(JSON.stringify(await createDiscoveryKit({ previousConfig: options['--previous-config'], output: options['--output'] })));
}
