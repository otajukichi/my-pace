import { copyFile, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleProbe } from './build-running-gas-probe.mjs';
import { privatePath } from '../processing/running/private-path.mjs';

export async function bundleRunningProduction(config = { rootFolderId: '' }) {
  const code = await bundleProbe(config, {
    hostPaths: ['processing/running/gas/production-runtime.gs', 'processing/running/gas/production-sync.gs', 'processing/running/gas/production-host.gs'],
    extraRoots: { MP_SYNC: 'processing/running/sync-probe.js', MP_MD5: 'processing/running/md5.js' },
  });
  return code.replace('// Generated MyPace three-CSV experiment.', '// Generated MyPace continuous running worker.');
}
export async function createProductionKit({ config, output = 'data/running-gas-production' } = {}) {
  const settings = config ? JSON.parse(await readFile(await privatePath(config), 'utf8')) : { rootFolderId: '' };
  if (!settings || Array.isArray(settings) || typeof settings !== 'object' || Object.keys(settings).some(k => k !== 'rootFolderId')) throw Error('UNKNOWN_PRODUCTION_SETTING');
  output = await privatePath(output, { directory: true });
  const code = await bundleRunningProduction(settings);
  await writeFile(join(output, 'Code.gs'), code, { mode: 0o600 });
  await copyFile(new URL('../processing/running/gas/production-appsscript.json', import.meta.url), join(output, 'appsscript.json'));
  const buildId = code.match(/const MYPACE_BUILD_ID = "([a-z0-9-]+)";/)[1];
  await writeFile(join(output, 'build-info.json'), JSON.stringify({ buildId, scope: 'RUNNING_PRODUCTION' }) + '\n', { mode: 0o600 });
  return { buildId, configured: !!settings.rootFolderId, writesToDrive: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) options[args[i]] = args[i + 1];
  console.log(JSON.stringify(await createProductionKit({ config: options['--config'], output: options['--output'] })));
}
