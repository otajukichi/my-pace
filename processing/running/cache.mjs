import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';

export const json = value => JSON.stringify(value) + '\n';
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value)).digest('hex');

export async function atomic(path, bytes) {
  const temporary = path + '.tmp-' + randomUUID();
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

/** Completed units survive interruption. A cache is disposable, never the published truth. */
export function computationCache(root, stats) {
  const folders = new Set();
  return async (kind, key, compute) => {
    const folder = join(root, kind);
    if (!folders.has(kind)) {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const st = await lstat(folder);
      if (!st.isDirectory() || st.isSymbolicLink()) throw Error('CACHE_DIRECTORY_REQUIRED');
      folders.add(kind);
    }
    const path = join(folder, hash(key) + '.json');
    try {
      const st = await lstat(path);
      if (!st.isFile() || st.isSymbolicLink()) throw Error('CACHE_FILE_REQUIRED');
      const record = JSON.parse(await readFile(path, 'utf8'));
      if (record.hash === hash(record.value)) {
        stats[`${kind}Reused`] = (stats[`${kind}Reused`] || 0) + 1;
        return record.value;
      }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    const value = await compute();
    await atomic(path, json({ hash: hash(value), value }));
    stats[`${kind}Computed`] = (stats[`${kind}Computed`] || 0) + 1;
    return value;
  };
}
