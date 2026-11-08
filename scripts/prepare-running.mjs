import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { prepareRunning } from '../processing/running/materialize.mjs';
import { privatePath } from '../processing/running/private-path.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--input', '--manifest', '--output', '--cache'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Usage: npm run prepare:running -- --input data/raw [--output data/running-display] [--cache data/running-cache]');
  options[args[i]] = args[i + 1];
}
if (!!options['--input'] === !!options['--manifest']) throw Error('Specify exactly one of --input or --manifest');
const output = resolve(options['--output'] || 'data/running-display'), cache = resolve(options['--cache'] || 'data/running-cache');
// The local command intentionally refuses output outside the Git-ignored data
// directory. The processing module itself supports isolated temporary tests.
for (const target of [output, cache]) {
  const path = relative(resolve('data'), target);
  if (!path || path === '..' || path.startsWith('../') || path.startsWith('/')) throw Error('PRIVATE_OUTPUT_MUST_BE_INSIDE_DATA');
}
try {
  await privatePath(output, { directory: true }); await privatePath(cache, { directory: true });
  let sources;
  if (options['--manifest']) {
    sources = JSON.parse(await readFile(await privatePath(options['--manifest']), 'utf8')).sources;
    for (const source of sources) source.path = await privatePath(source.path);
  }
  else {
    const folder = await privatePath(options['--input'], { directory: true });
    sources = (await readdir(folder, { withFileTypes: true })).filter(p => p.isFile() && p.name.toLowerCase().endsWith('.csv')).sort((a, b) => a.name.localeCompare(b.name)).map(p => ({ id: p.name, path: join(folder, p.name) }));
  }
  const started = performance.now();
  const { stats } = await prepareRunning({ sources, output, cache,
    onProgress: value => console.log(JSON.stringify(value)) });
  console.log(JSON.stringify({ ...stats, elapsedSeconds: Math.round((performance.now() - started) / 10) / 100, peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
  console.log('PRIVATE LOCAL ARTIFACTS: do not upload data/ to GitHub or deploy it as public files.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
