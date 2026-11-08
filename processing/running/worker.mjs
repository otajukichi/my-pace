import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, lstat, readdir, rename, open, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { atomic, hash, json } from './cache.mjs';
import { ALGORITHM } from './derive.js';
import { prepareRunning } from './materialize.mjs';
import { contentRevision } from './drive.mjs';
import { acquireLock } from './lock.mjs';

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
const stamp = st => [st.size, st.mtimeNs.toString(), st.ctimeNs.toString(), st.ino.toString()].join(':');
const selected = (f, folder) => f && !f.trashed && f.parents?.includes(folder) && /\.csv$/i.test(f.name || '') && !f.mimeType?.startsWith('application/vnd.google-apps.');
async function md5(path) {
  const digest = createHash('md5');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}

/** Verify full pages before changing durable inventory. Obtain the initial
 * cursor before listing, then replay changes to close the listing race. */
export async function driveInventory(client, folder, previous, { rescan = false } = {}) {
  const parent = await client.metadata(folder);
  if (parent.trashed || parent.mimeType !== 'application/vnd.google-apps.folder') throw Error('DRIVE_SOURCE_FOLDER_UNAVAILABLE');
  let token = previous?.cursor, files = { ...previous?.files };
  if (!token || rescan) {
    token = await client.startToken(); files = {};
    for (const file of await client.folder(folder)) if (selected(file, folder)) files[file.id] = file;
  }
  let pageToken = token; const pages = new Set();
  for (;;) {
    if (pages.has(pageToken)) throw Error('DRIVE_PAGE_LOOP'); pages.add(pageToken);
    let page;
    try { page = await client.changes(pageToken); }
    catch (error) {
      if (error.status === 410 && !rescan) return driveInventory(client, folder, null, { rescan: true });
      throw error;
    }
    if (!Array.isArray(page.changes)) throw Error('DRIVE_CHANGE_PAGE_INVALID');
    for (const change of page.changes) {
      if (!change.fileId) throw Error('DRIVE_CHANGE_PAGE_INVALID');
      if (change.removed) delete files[change.fileId];
      else {
        if (!change.file || change.file.id !== change.fileId) throw Error('DRIVE_CHANGE_PAGE_INVALID');
        if (selected(change.file, folder)) files[change.fileId] = change.file;
        else delete files[change.fileId];
      }
    }
    if (page.nextPageToken) pageToken = page.nextPageToken;
    else {
      if (!page.newStartPageToken) throw Error('DRIVE_CHANGE_CURSOR_MISSING');
      return { files, cursor: page.newStartPageToken };
    }
  }
}

/** Chunk checkpoints are per 8 MiB, not per sensor row. Source revisions,
 * byte ranges, final checksum and folder membership all have to agree. */
export async function downloadSnapshot(client, file, folder, root, { chunkBytes = 8 * 1024 * 1024, afterChunk } = {}) {
  const revision = contentRevision(file), size = Number(file.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > 512 * 1024 * 1024) throw Error('SOURCE_SIZE_LIMIT');
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > 8 * 1024 * 1024) throw Error('DOWNLOAD_CHUNK_LIMIT');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const base = join(root, hash(file.id)), path = `${base}-${file.md5Checksum}.csv`, verified = path + '.verified.json';
  try {
    const st = await lstat(path, { bigint: true }), record = await readJson(verified);
    if (!st.isFile() || st.isSymbolicLink()) throw Error('SOURCE_REGULAR_FILE_REQUIRED');
    if (record?.revision === revision && record.stamp === stamp(st)) return { id: file.id, revision, path };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const partial = base + '.part', progress = base + '.download.json';
  let saved = await readJson(progress), offset = 0;
  if (saved?.revision === revision) {
    try {
      const st = await lstat(partial);
      if (!st.isFile() || st.isSymbolicLink()) throw Error('SOURCE_REGULAR_FILE_REQUIRED');
      if (st.size >= saved.offset && Number.isSafeInteger(saved.offset) && saved.offset >= 0 && saved.offset <= size) offset = saved.offset;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Never follow a symlink left at a work path, including a stale revision.
  try { if ((await lstat(partial)).isSymbolicLink()) throw Error('SOURCE_REGULAR_FILE_REQUIRED'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const handle = await open(partial, offset ? 'r+' : 'w', 0o600);
  try {
    await handle.truncate(offset);
    while (offset < size) {
      const end = Math.min(size - 1, offset + chunkBytes - 1), bytes = await client.range(file.id, offset, end, size);
      if (bytes.length !== end - offset + 1) throw Error('DRIVE_RANGE_TRUNCATED');
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written, offset + written);
        if (!result.bytesWritten) throw Error('DOWNLOAD_WRITE_FAILED'); written += result.bytesWritten;
      }
      offset = end + 1; await handle.sync();
      await atomic(progress, json({ revision, offset })); await afterChunk?.({ offset });
    }
  } finally { await handle.close(); }
  if (await md5(partial) !== file.md5Checksum) {
    await rm(progress, { force: true }); throw Error('DRIVE_CHECKSUM_MISMATCH');
  }
  const after = await client.metadata(file.id);
  if (!selected(after, folder) || contentRevision(after) !== revision) throw Error('DRIVE_SOURCE_CHANGED_DURING_DOWNLOAD');
  await rename(partial, path);
  await atomic(verified, json({ revision, stamp: stamp(await lstat(path, { bigint: true })) }));
  await rm(progress, { force: true });
  return { id: file.id, revision, path };
}

export async function localInventory(input) {
  const folder = resolve(input), sources = [];
  for (const file of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/\.csv$/i.test(file.name)) continue;
    if (!file.isFile() || file.isSymbolicLink()) throw Error('SOURCE_REGULAR_FILE_REQUIRED');
    const path = join(folder, file.name), stat = await lstat(path, { bigint: true });
    sources.push({ id: file.name, path, revision: stamp(stat) });
  }
  return sources;
}

/** One process owns each work/output directory. Failed attempts retain the
 * published catalog and cursor; completed computation/download units survive. */
export async function runWorkerOnce({ input, drive, sourceFolder, output, cache, state, publisher, settleMs = 2000, now = Date.now, hooks = {} }) {
  if (!!input === !!drive) throw Error('ONE_WORKER_SOURCE_REQUIRED');
  state = resolve(state);
  await mkdir(state, { recursive: true, mode: 0o700 });
  if ((await lstat(state)).isSymbolicLink()) throw Error('WORKER_DIRECTORY_REQUIRED');
  const release = await acquireLock(join(state, '.worker.guard'), 'WORKER_ALREADY_RUNNING');
  try {
    const statePath = join(state, 'committed.json'), previous = await readJson(statePath);
    const identity = hash({ algorithm: ALGORITHM, input: input ? resolve(input) : null, sourceFolder, output: resolve(output), cache: resolve(cache) });
    const prior = previous?.identity === identity ? previous : null;
    let inventory, sources, manifest;
    if (drive) {
      inventory = await driveInventory(drive, sourceFolder, prior?.inventory, { rescan: !prior || now() - (prior.lastRescan || 0) >= 86400000 });
      manifest = Object.values(inventory.files).sort((a, b) => a.id.localeCompare(b.id)).map(file => ({ id: file.id, revision: contentRevision(file) }));
    } else { sources = await localInventory(input); manifest = sources; }
    if (!manifest.length) throw Error('EMPTY_INVENTORY_REQUIRES_REVIEW');
    const signature = hash(manifest), catalogPath = join(output, 'index.json');
    const currentCatalog = await readJson(catalogPath);
    const auditDue = !prior || now() - (prior.lastAudit || 0) >= 86400000;
    if (!auditDue && prior?.signature === signature && currentCatalog && prior.catalogHash === hash(currentCatalog)) {
      // Metadata-only changes/renames can advance the cursor without CSV reads.
      await publisher?.({ output, catalog: currentCatalog });
      await atomic(statePath, json({ ...prior, inventory, lastChecked: now(), lastRescan: !prior || now() - prior.lastRescan >= 86400000 ? now() : prior.lastRescan }));
      return { status: 'unchanged', rawBytesRead: 0, computedRuns: 0, downloadBytes: 0 };
    }
    const observationPath = join(state, 'observed.json'), observed = await readJson(observationPath);
    if (settleMs > 0 && (observed?.identity !== identity || observed.signature !== signature)) {
      await atomic(observationPath, json({ identity, signature, since: now() })); return { status: 'settling' };
    }
    if (settleMs > 0 && now() - observed.since < settleMs) return { status: 'settling' };
    if (drive) {
      sources = [];
      for (const file of Object.values(inventory.files).sort((a, b) => a.id.localeCompare(b.id)))
        sources.push(await downloadSnapshot(drive, file, sourceFolder, join(state, 'snapshots'), hooks));
    }
    const validate = async () => {
      if (drive) {
        for (const source of sources) {
          const file = await drive.metadata(source.id);
          if (!selected(file, sourceFolder) || contentRevision(file) !== source.revision) throw Error('DRIVE_SNAPSHOT_CHANGED');
        }
      } else if (hash(await localInventory(input)) !== signature) throw Error('SOURCE_INVENTORY_CHANGED');
    };
    const result = await prepareRunning({ sources, output, cache, beforePublish: async catalog => { await validate(); await hooks.beforePublish?.(catalog); } });
    await publisher?.({ output, catalog: result.catalog });
    await hooks.beforeCommit?.();
    await atomic(statePath, json({ identity, signature, inventory, catalogHash: hash(result.catalog), lastChecked: now(), lastAudit: now(),
      lastRescan: !prior || now() - prior.lastRescan >= 86400000 ? now() : prior.lastRescan }));
    return { status: 'updated', ...result.stats };
  } finally { await release(); }
}
