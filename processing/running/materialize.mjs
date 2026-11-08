import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rm, lstat, realpath } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { CsvParser, SensorGpsReader } from './csv.js';
import { ALGORITHM, POLICY, deriveSource, displayRoute, listEntry } from './derive.js';
import { MASK_ZOOM, MASK_SIZE, MASK_BLOCK_TILES } from './exploration.js';
import { computationCache, json, hash, atomic } from './cache.mjs';
import { describeRuns, incrementalFresh } from './incremental.mjs';
import { incrementalMask } from './mask.mjs';
import { acquireLock } from './lock.mjs';

export const MAX_OBJECT_BYTES = 128 * 1024;
const inside = (parent, child) => { const path = relative(parent, child); return path === '' || path !== '..' && !path.startsWith('../') && !path.startsWith('/'); };
const stamp = stat => [stat.size, stat.mtimeNs.toString(), stat.ctimeNs.toString(), stat.ino.toString()].join(':');
const sum = runs => ({ runs: runs.length, days: new Set(runs.map(r => r.date)).size,
  distanceMeters: Math.round(runs.reduce((n, r) => n + r.summary.distanceMeters, 0) * 1000) / 1000,
  durationSeconds: Math.round(runs.reduce((n, r) => n + r.summary.durationSeconds, 0) * 1000) / 1000 });

async function directory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('OUTPUT_DIRECTORY_REQUIRED');
}
async function normalize(source, cacheRoot, counters) {
  if (!source || typeof source.id !== 'string' || !source.id || typeof source.path !== 'string') throw Error('SOURCE_DESCRIPTOR_REQUIRED');
  const stat = await lstat(source.path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('SOURCE_REGULAR_FILE_REQUIRED');
  if (stat.size > 512n * 1024n * 1024n) throw Error('SOURCE_SIZE_LIMIT');
  const fingerprint = hash({ path: resolve(source.path), revision: source.revision ?? null, stamp: stamp(stat), algorithm: ALGORITHM });
  const cachePath = join(cacheRoot, hash(source.id) + '.json');
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8'));
    if (cached.fingerprint === fingerprint && cached.hash === hash(cached.value)) { counters.reusedSources++; return cached.value; }
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const csv = new CsvParser(), reader = new SensorGpsReader(), decoder = new TextDecoder('utf-8', { fatal: true }), digest = createHash('sha256');
  const emit = row => {
    reader.row(row);
    if (reader.columns && !csv.selectedColumns) csv.selectedColumns = new Set([0, ...reader.columns]);
  };
  for await (const chunk of createReadStream(source.path, { highWaterMark: 256 * 1024 })) {
    counters.rawBytesRead += chunk.length; digest.update(chunk); csv.write(decoder.decode(chunk, { stream: true }), emit);
  }
  csv.write(decoder.decode(), emit, true);
  const parsed = reader.finish(), after = await lstat(source.path, { bigint: true });
  if (stamp(after) !== stamp(stat)) throw Error('SOURCE_CHANGED_DURING_READ');
  const value = { contentHash: digest.digest('hex'), gpsHash: hash({ start: parsed.start, end: parsed.end, fixes: parsed.fixes }),
    sourceBytes: Number(stat.size), counts: parsed.counts, start: parsed.start, end: parsed.end, runs: deriveSource(parsed) };
  await atomic(cachePath, json({ fingerprint, hash: hash(value), value })); counters.processedSources++;
  return value;
}

/** Incremental materializer. Source snapshots and triggering belong to the
 * worker; publication switches one index only after every object is complete. */
export async function prepareRunning({ sources, output, cache, beforePublish, onProgress = () => {} }) {
  if (!Array.isArray(sources) || !sources.length || new Set(sources.map(s => s.id)).size !== sources.length) throw Error('NONEMPTY_UNIQUE_SOURCE_LIST_REQUIRED');
  output = resolve(output); cache = resolve(cache);
  if (inside(output, cache) || inside(cache, output)) throw Error('CACHE_AND_OUTPUT_MUST_BE_SEPARATE');
  await directory(output); await directory(cache);
  output = await realpath(output); cache = await realpath(cache);
  if (inside(output, cache) || inside(cache, output)) throw Error('CACHE_AND_OUTPUT_MUST_BE_SEPARATE');
  for (const source of sources) if (inside(output, await realpath(source.path)) || inside(cache, await realpath(source.path))) throw Error('SOURCE_MUST_BE_OUTSIDE_OUTPUT');
  const lock = join(output, '.prepare.lock');
  const release = await acquireLock(join(output, '.prepare.guard'), 'PREPARATION_ALREADY_RUNNING');
  try {
    try {
      const pid = (await readFile(lock, 'utf8')).trim();
      if (!/^\d+$/.test(pid)) throw Error('PREPARATION_ALREADY_RUNNING');
      let alive = true;
      try { process.kill(Number(pid), 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw Error('PREPARATION_ALREADY_RUNNING');
      await rm(lock);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) { await release(); throw error; }
  const counters = { rawBytesRead: 0, processedSources: 0, reusedSources: 0, duplicateSources: 0, createdObjects: 0, reusedObjects: 0,
    displayComputed: 0, displayReused: 0, freshComputed: 0, freshReused: 0, corridorComputed: 0, corridorReused: 0,
    enclosureComputed: 0, enclosureReused: 0, maskTileComputed: 0, maskTileReused: 0, explorationCellVisits: 0 };
  const cached = computationCache(cache, counters);
  const objects = new Map(), references = new Map();
  try {
    await directory(join(output, 'objects'));
    const normalized = [], seen = new Set(), ordered = [...sources].sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < ordered.length; i++) {
      const source = ordered[i], value = await normalize(source, cache, counters);
      onProgress({ phase: 'source', completed: i + 1, total: sources.length, ...counters });
      if (seen.has(value.gpsHash)) { counters.duplicateSources++; continue; }
      seen.add(value.gpsHash); normalized.push({ id: source.id, value });
    }
    normalized.sort((a, b) => a.value.start - b.value.start || a.id.localeCompare(b.id));
    for (let i = 1; i < normalized.length; i++) {
      if (normalized[i].value.start < normalized[i - 1].value.end) throw Error('OVERLAPPING_SOURCES_REQUIRE_SELECTION');
    }
    const runs = normalized.flatMap(({ id, value }) => value.runs.map(run => ({ ...run, id: 'r_' + hash(id).slice(0, 24) + '_' + run.date })));
    const descriptions = describeRuns(runs), fresh = await incrementalFresh(descriptions, cached);
    async function put(value) {
      const content = json(value), bytes = Buffer.byteLength(content);
      if (bytes > MAX_OBJECT_BYTES) throw Error('ARTIFACT_SIZE_LIMIT');
      const digest = hash(content), path = `objects/${digest}.json`;
      if (references.has(path)) return references.get(path);
      try {
        const stat = await lstat(join(output, path));
        if (!stat.isFile() || stat.isSymbolicLink() || hash(await readFile(join(output, path))) !== digest) throw Error('ARTIFACT_CORRUPT');
        counters.reusedObjects++;
      }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await atomic(join(output, path), content); counters.createdObjects++;
      }
      const ref = { path, bytes }; references.set(path, ref); objects.set(path, value); return ref;
    }
    async function pages(kind, base, field, entries) {
      const refs = []; let batch = [], bytes = Buffer.byteLength(json({ schema: 1, kind, ...base, [field]: [] }));
      for (const entry of entries) {
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (batch.length && bytes + size > MAX_OBJECT_BYTES - 64) {
          refs.push(await put({ schema: 1, kind, ...base, [field]: batch })); batch = []; bytes = Buffer.byteLength(json({ schema: 1, kind, ...base, [field]: [] }));
        }
        batch.push(entry); bytes += size;
      }
      if (batch.length) refs.push(await put({ schema: 1, kind, ...base, [field]: batch }));
      return refs;
    }
    function pieces(route) {
      const segments = [];
      for (const encoded of route.segments) {
        const segment = encoded.data;
        if (segment.length <= 1025) { segments.push(encoded); continue; }
        let origin = [...segment[0]];
        for (let offset = 1; offset < segment.length; offset += 1024) {
          const steps = segment.slice(offset, offset + 1024); segments.push({ chain: encoded.chain, part: (offset - 1) / 1024, data: [[...origin], ...steps] });
          for (const step of steps) { origin[0] += step[0]; origin[1] = ((origin[1] + step[1] + 540000000) % 360000000) - 180000000; }
        }
      }
      return segments;
    }
    const entries = new Map(), overviews = new Map();
    for (const run of runs) {
      const display = await cached('display', { algorithm: ALGORITHM, run }, () => {
        const route = displayRoute(run), overview = displayRoute(run, true);
        return { route: { ...route, segments: pieces(route) },
          analysis: { schema: 1, kind: 'analysis', id: run.id, summary: run.summary,
            paceSamples: run.paceSamples.map(p => [p.elapsedSeconds, p.paceSecondsPerKm, p.coverage]),
            splits: run.splits.map(s => [s.kilometer, s.distanceMeters, s.durationSeconds, s.paceSecondsPerKm, s.coverage, !!s.partial]) },
          entry: listEntry(run, {}, null), overview: pieces(overview).map(segment => ({ ...overview, segments: [segment] })) };
      });
      const { segments, ...base } = display.route;
      const routeRefs = await pages('route', base, 'segments', segments), analysis = await put(display.analysis);
      entries.set(run.id, { ...display.entry, route: routeRefs, analysis,
        freshMeters: run.segments.length ? Math.round((fresh.get(run.id)?.fresh ?? 0) * 1000) / 1000 : null });
      overviews.set(run.id, display.overview);
    }
    const years = {}, months = [...new Set(runs.map(r => r.date.slice(0, 7)))].sort();
    for (const year of [...new Set(months.map(m => m.slice(0, 4)))]) {
      const yearRuns = runs.filter(r => r.date.startsWith(year)), monthEntries = [];
      for (const month of months.filter(m => m.startsWith(year))) {
        const monthRuns = yearRuns.filter(r => r.date.startsWith(month));
        const lists = await pages('month', { month }, 'runs', monthRuns.map(r => entries.get(r.id)));
        const overview = await pages('overview', { month }, 'routes', monthRuns.flatMap(r => overviews.get(r.id)));
        monthEntries.push({ month, summary: sum(monthRuns), lists, overview });
      }
      const dates = [...new Set(yearRuns.map(r => r.date))].sort();
      years[year] = await put({ schema: 1, kind: 'year', year, summary: sum(yearRuns), months: monthEntries,
        days: dates.map(date => { const selected = yearRuns.filter(r => r.date === date), total = sum(selected); return [date, total.distanceMeters, total.durationSeconds, selected.length]; }) });
    }
    onProgress({ phase: 'exploration', ...counters });
    const mask = await incrementalMask(descriptions, cached, counters), groups = new Map(), blocks = {};
    for (const tile of mask.tiles) {
      const block = `${Math.floor(tile.x / MASK_BLOCK_TILES)}/${Math.floor(tile.y / MASK_BLOCK_TILES)}`;
      if (!groups.has(block)) groups.set(block, []); groups.get(block).push(tile);
    }
    for (const [block, tiles] of groups) blocks[block] = await pages('exploration', { block, zoom: MASK_ZOOM, size: MASK_SIZE }, 'tiles', tiles);
    const catalog = { schema: 1, kind: 'catalog', algorithm: ALGORITHM, policy: POLICY, years,
      latest: runs.length ? { id: runs.at(-1).id, date: runs.at(-1).date } : null,
      exploration: { zoom: MASK_ZOOM, size: MASK_SIZE, blockTiles: MASK_BLOCK_TILES, blocks } };
    if (Buffer.byteLength(json(catalog)) > MAX_OBJECT_BYTES) throw Error('CATALOG_SIZE_LIMIT');
    // Test hook also models a worker dying before the single publication step.
    const catalogContent = json(catalog);
    let previousCatalog = null;
    try { previousCatalog = await readFile(join(output, 'index.json'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const catalogChanged = previousCatalog !== catalogContent;
    await beforePublish?.(catalog);
    if (catalogChanged) await atomic(join(output, 'index.json'), catalogContent);
    const stats = { ...counters, catalogChanged, sourceFiles: sources.length, runs: runs.length,
      sourceBytes: normalized.reduce((n, x) => n + x.value.sourceBytes, 0), sourceRows: normalized.reduce((n, x) => n + x.value.counts.rows, 0),
      gpsFixes: normalized.reduce((n, x) => n + x.value.counts.gpsFixes, 0),
      artifactFiles: references.size + 1, artifactBytes: [...references.values()].reduce((n, ref) => n + ref.bytes, Buffer.byteLength(json(catalog))),
      catalogBytes: Buffer.byteLength(json(catalog)), maskTiles: mask.tiles.length, enclosedRegions: mask.regionCount };
    // This report is private and does not belong in a public deployment.
    await atomic(join(cache, 'last-report.json'), json(stats));
    return { catalog, stats, objects, entries, runs };
  } finally { try { await rm(lock, { force: true }); } finally { await release(); } }
}
