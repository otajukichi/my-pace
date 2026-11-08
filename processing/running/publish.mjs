import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { hash, json, atomic } from './cache.mjs';
import { MAX_OBJECT_BYTES } from './materialize.mjs';

const md5 = bytes => createHash('md5').update(bytes).digest('hex');
async function maybeMetadata(client, id) {
  try { return await client.metadata(id); }
  catch (error) { if (error.status === 404) return null; throw error; }
}

/** Enumerate only objects reachable from the completed catalog, and check
 * their hashes. Staged/orphaned objects never become a published generation. */
export async function collectArtifacts(output, catalog) {
  const objects = new Map(), pending = [];
  const scan = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.path === 'string' && value.path.startsWith('objects/')) pending.push(value);
    else for (const item of Object.values(value)) scan(item);
  };
  scan(catalog);
  while (pending.length) {
    const ref = pending.pop();
    if (!/^objects\/[a-f0-9]{64}\.json$/.test(ref.path) || !Number.isInteger(ref.bytes) || ref.bytes > MAX_OBJECT_BYTES) throw Error('ARTIFACT_REFERENCE_INVALID');
    if (objects.has(ref.path)) continue;
    const bytes = await readFile(join(output, ref.path));
    if (bytes.length !== ref.bytes || hash(bytes) !== ref.path.slice(8, -5)) throw Error('ARTIFACT_CORRUPT');
    objects.set(ref.path, bytes); scan(JSON.parse(bytes));
  }
  return objects;
}

/** A single local worker owns a newly created, owner-only Drive folder.
 * This is not a distributed lease/CAS protocol. Never run copies on two PCs. */
export function drivePublisher(client, stateDirectory, { now = Date.now } = {}) {
  return async ({ output, catalog }) => {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const path = join(stateDirectory, 'publication.json');
    let state;
    try { state = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!state) {
      state = { folder: await client.newId(), index: await client.newId(), objects: {} };
      await atomic(path, json(state));
    }
    const content = Buffer.from(json(catalog)), digest = hash(content);
    if (content.length > MAX_OBJECT_BYTES) throw Error('CATALOG_SIZE_LIMIT');
    if (state.catalogHash === digest && now() - state.verifiedAt < 86400000) return { status: 'unchanged' };
    const parent = await maybeMetadata(client, state.folder);
    if (!parent) await client.createFolder({ id: state.folder, name: 'MyPace running display', mimeType: 'application/vnd.google-apps.folder',
      appProperties: { mypace: 'running-display-v2' } });
    else if (parent.trashed || parent.mimeType !== 'application/vnd.google-apps.folder') throw Error('DRIVE_OUTPUT_FOLDER_INVALID');
    await client.assertPrivate(state.folder);
    const inventory = new Map((await client.folder(state.folder)).map(f => [f.id, f]));
    const artifacts = await collectArtifacts(output, catalog);
    let uploaded = 0, reused = 0;
    for (const [name, bytes] of artifacts) {
      if (!state.objects[name]) {
        state.objects[name] = await client.newId(); await atomic(path, json(state));
      }
      const fileId = state.objects[name], existing = inventory.get(fileId);
      if (existing) {
        if (existing.md5Checksum !== md5(bytes) || Number(existing.size) !== bytes.length || existing.name !== name.slice(8)) throw Error('DRIVE_IMMUTABLE_OBJECT_CHANGED');
        reused++; continue;
      }
      const elsewhere = await maybeMetadata(client, fileId);
      if (elsewhere) throw Error('DRIVE_OUTPUT_OBJECT_MOVED');
      const created = await client.create({ id: fileId, name: name.slice(8), parents: [state.folder], mimeType: 'application/json' }, bytes);
      if (created.md5Checksum !== md5(bytes)) throw Error('DRIVE_UPLOAD_CHECKSUM_MISMATCH');
      uploaded++;
    }
    // No references become visible until every immutable object is available.
    await client.assertPrivate(state.folder);
    const existing = await maybeMetadata(client, state.index);
    if (existing && (!existing.parents?.includes(state.folder) || existing.trashed)) throw Error('DRIVE_CATALOG_MOVED');
    if (existing) await client.assertPrivate(state.index);
    if (existing?.md5Checksum !== md5(content)) {
      const published = existing ? await client.replace(state.index, content)
        : await client.create({ id: state.index, name: 'index.json', parents: [state.folder], mimeType: 'application/json' }, content);
      if (published.md5Checksum !== md5(content)) throw Error('DRIVE_UPLOAD_CHECKSUM_MISMATCH');
    }
    await atomic(path, json({ ...state, catalogHash: digest, verifiedAt: now() }));
    return { status: 'published', uploaded, reused };
  };
}
