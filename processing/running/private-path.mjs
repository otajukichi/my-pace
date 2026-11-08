import { lstat, mkdir } from 'node:fs/promises';
import { resolve, relative, join, dirname } from 'node:path';

/** CLI secrets, downloaded snapshots and artifacts must stay in ignored data/.
 * Refuse symlink ancestors before creating any output directories. */
export async function privatePath(value, { directory = false } = {}) {
  const base = resolve('data'), target = resolve(value), local = relative(base, target);
  if (!local || local === '..' || local.startsWith('../') || local.startsWith('/')) throw Error('PRIVATE_PATH_MUST_BE_INSIDE_DATA');
  let current = base;
  const parts = relative(base, directory ? target : dirname(target)).split('/').filter(Boolean);
  for (const part of ['', ...parts]) {
    if (part) current = join(current, part);
    try {
      const st = await lstat(current);
      if (!st.isDirectory() || st.isSymbolicLink()) throw Error('PRIVATE_DIRECTORY_REQUIRED');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  if (!directory) {
    try { const st = await lstat(target); if (!st.isFile() || st.isSymbolicLink()) throw Error('PRIVATE_FILE_REQUIRED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
