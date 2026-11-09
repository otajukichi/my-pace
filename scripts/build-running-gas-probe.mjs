import { readFile, writeFile, stat, copyFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRunning } from '../processing/running/materialize.mjs';
import { hash, json } from '../processing/running/cache.mjs';
import { privatePath } from '../processing/running/private-path.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Narrow bundle of audited repository modules, not an arbitrary JS compiler.
 * Synchronous Apps Script storage replaces the two async cache boundaries. */
export async function bundleProbe(config = null, { hostPath = 'processing/running/gas/probe-host.gs', extraRoots = {} } = {}) {
  const modules = new Map(), code = [];
  async function include(file) {
    file = resolve(file);
    if (modules.has(file)) return modules.get(file);
    const name = 'mp_module_' + modules.size; modules.set(file, name);
    if (file === join(ROOT, 'processing/running/cache.mjs')) {
      code.push(`const ${name} = { hash: mpHash };`); return name;
    }
    let source = await readFile(file, 'utf8');
    const bindings = [];
    for (const match of source.matchAll(/^import \{([^}]+)\} from ['"]([^'"]+)['"];?$/gm)) {
      if (!match[2].startsWith('.')) throw Error('NONPORTABLE_PROBE_IMPORT');
      const dependency = await include(resolve(dirname(file), match[2]));
      bindings.push(`const {${match[1]}} = ${dependency};`);
    }
    source = source.replace(/^import .*$/gm, '');
    const exports = [...source.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const)\s+(\w+)/g)].map(m => m[1]);
    if (['incremental.mjs', 'mask.mjs'].some(s => file.endsWith('/' + s))) source = source.replace(/\basync\s+/g, '').replace(/\bawait\s+/g, '');
    source = source.replace(/\bexport\s+/g, '');
    if (/\bBuffer\b|\bprocess\.|\bnode:|\brequire\(/.test(source)) throw Error('NONPORTABLE_PROBE_MODULE');
    code.push(`// ${relative(ROOT, file)}\nconst ${name} = (() => {\n${bindings.join('\n')}\n${source}\nreturn {${exports.join(',')}};\n})();`);
    return name;
  }
  const roots = { MP_CORE: 'processing/running/probe-core.js', MP_DERIVE: 'processing/running/derive.js',
    MP_INCREMENTAL: 'processing/running/incremental.mjs', MP_MASK: 'processing/running/mask.mjs', ...extraRoots };
  for (const [alias, path] of Object.entries(roots)) code.push(`const ${alias} = ${await include(join(ROOT, path))};`);
  const host = (await readFile(join(ROOT, hostPath), 'utf8')).replace('__MYPACE_PROBE_CONFIG__', JSON.stringify(config));
  return '// Generated MyPace three-CSV experiment. Keep the configured version private.\n'
    + 'if (!Array.prototype.at) Object.defineProperty(Array.prototype,"at",{value:function(i){i=Math.trunc(i)||0;return this[i<0?this.length+i:i];}});\n'
    + code.join('\n\n') + '\n\n' + host;
}

export async function createProbeKit({ manifest, output }) {
  manifest = await privatePath(manifest); output = await privatePath(output, { directory: true });
  const selection = JSON.parse(await readFile(manifest, 'utf8'));
  if (!selection.sourceFolder || selection.sources?.length !== 3) throw Error('THREE_SOURCE_MANIFEST_REQUIRED');
  const sources = [];
  for (const source of selection.sources) sources.push({ id: source.id, path: await privatePath(source.path) });
  const reference = await prepareRunning({ sources, output: join(output, 'reference'), cache: join(output, 'reference-cache') });
  const config = { sourceFolder: selection.sourceFolder, chunkBytes: 1024 * 1024, sources: [],
    expectedCatalogHash: hash(json(reference.catalog)), environment: 'apps-script' };
  for (const source of sources) {
    const md5 = createHash('md5'), sha256 = createHash('sha256'), chunks = []; let pending = Buffer.alloc(0), size = 0;
    for await (const bytes of createReadStream(source.path, { highWaterMark: config.chunkBytes })) {
      md5.update(bytes); sha256.update(bytes); size += bytes.length; pending = Buffer.concat([pending, bytes]);
      while (pending.length >= config.chunkBytes) { chunks.push(hash(pending.subarray(0, config.chunkBytes))); pending = pending.subarray(config.chunkBytes); }
    }
    if (pending.length) chunks.push(hash(pending));
    if (size !== (await stat(source.path)).size) throw Error('SOURCE_CHANGED_DURING_KIT_BUILD');
    const normalized = JSON.parse(await readFile(join(output, 'reference-cache', hash(source.id) + '.json'), 'utf8'));
    if (sha256.digest('hex') !== normalized.value.contentHash) throw Error('SOURCE_CHANGED_DURING_KIT_BUILD');
    config.sources.push({ id: source.id, size, md5: md5.digest('hex'), chunks });
  }
  await writeFile(join(output, 'Code.gs'), await bundleProbe(config), { mode: 0o600 });
  await writeFile(join(output, 'config.json'), json(config), { mode: 0o600 });
  await copyFile(join(ROOT, 'processing/running/gas/appsscript.json'), join(output, 'appsscript.json'));
  return { sources: 3, bytes: config.sources.reduce((n, s) => n + s.size, 0), expectedOutputBytes: reference.stats.artifactBytes,
    expectedOutputFiles: reference.stats.artifactFiles, expectedRows: reference.stats.sourceRows, expectedGpsFixes: reference.stats.gpsFixes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) options[args[i]] = args[i + 1];
  if (!options['--manifest']) throw Error('Usage: npm run prepare:gas-probe -- --manifest data/running-gas-selection.json');
  console.log(JSON.stringify(await createProbeKit({ manifest: options['--manifest'], output: options['--output'] || 'data/running-gas-probe' })));
}
