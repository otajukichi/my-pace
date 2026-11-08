import { CsvParser, SensorGpsReader } from './csv.js';
import { ALGORITHM, POLICY, displayRoute, listEntry } from './derive.js';
import { MASK_ZOOM, MASK_SIZE, MASK_BLOCK_TILES } from './exploration.js';

/** Strict, restartable UTF-8 decoder. Apps Script has no TextDecoder and blob
 * decoding can silently replace a character split by a byte-range boundary. */
export function decodeUtf8(bytes, pending = [], final = false) {
  const input = pending.concat(Array.from(bytes, b => b & 255)), parts = []; let text = '', i = 0;
  while (i < input.length) {
    const a = input[i], length = a < 128 ? 1 : a >= 194 && a <= 223 ? 2 : a >= 224 && a <= 239 ? 3 : a >= 240 && a <= 244 ? 4 : 0;
    if (!length) throw Error('CSV_INVALID_UTF8');
    if (i + length > input.length) break;
    let point = length === 1 ? a : a & (127 >> length);
    for (let k = 1; k < length; k++) {
      const next = input[i + k]; if ((next & 192) !== 128) throw Error('CSV_INVALID_UTF8');
      point = (point << 6) | (next & 63);
    }
    if (length > 1 && point < [0, 0, 128, 2048, 65536][length] || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw Error('CSV_INVALID_UTF8');
    text += String.fromCodePoint(point); i += length;
    if (text.length >= 8192) { parts.push(text); text = ''; }
  }
  const tail = input.slice(i);
  if (final && tail.length) throw Error('CSV_INVALID_UTF8');
  parts.push(text); return { text: parts.join(''), pending: tail };
}

export function parseChunk(checkpoint, bytes, final = false) {
  const parser = Object.assign(new CsvParser(), checkpoint?.parser || {});
  if (parser.selectedColumns) parser.selectedColumns = new Set(parser.selectedColumns);
  const reader = Object.assign(new SensorGpsReader(), checkpoint?.reader || {});
  const decoded = decodeUtf8(bytes, checkpoint?.utf8 || [], final);
  parser.write(decoded.text, row => {
    reader.row(row);
    if (reader.columns && !parser.selectedColumns) parser.selectedColumns = new Set([0, ...reader.columns]);
  }, final);
  return { parser: { ...parser, selectedColumns: parser.selectedColumns ? [...parser.selectedColumns] : null }, reader: { ...reader }, utf8: decoded.pending,
    finished: final ? reader.finish() : null };
}

const sum = runs => ({ runs: runs.length, days: new Set(runs.map(r => r.date)).size,
  distanceMeters: Math.round(runs.reduce((n, r) => n + r.summary.distanceMeters, 0) * 1000) / 1000,
  durationSeconds: Math.round(runs.reduce((n, r) => n + r.summary.durationSeconds, 0) * 1000) / 1000 });

/** Three-source benchmark assembler. Geometry/statistics come from the same
 * modules as the local converter; tests compare every emitted content hash.
 * This is not a replacement for a sharded, lifetime-history cloud worker. */
export function assembleProbeArtifacts(runs, fresh, mask, { hash, byteLength }) {
  const objects = new Map(), limit = 128 * 1024, json = x => JSON.stringify(x) + '\n';
  function put(value) {
    const content = json(value), bytes = byteLength(content);
    if (bytes > limit) throw Error('ARTIFACT_SIZE_LIMIT');
    const path = `objects/${hash(content)}.json`; objects.set(path, { path, content, bytes }); return { path, bytes };
  }
  function pages(kind, base, field, entries) {
    const refs = []; let batch = [], bytes = byteLength(json({ schema: 1, kind, ...base, [field]: [] }));
    for (const entry of entries) {
      const size = byteLength(JSON.stringify(entry)) + 1;
      if (batch.length && bytes + size > limit - 64) {
        refs.push(put({ schema: 1, kind, ...base, [field]: batch })); batch = []; bytes = byteLength(json({ schema: 1, kind, ...base, [field]: [] }));
      }
      batch.push(entry); bytes += size;
    }
    if (batch.length) refs.push(put({ schema: 1, kind, ...base, [field]: batch })); return refs;
  }
  function pieces(route) {
    const segments = [];
    for (const encoded of route.segments) {
      const segment = encoded.data;
      if (segment.length <= 1025) { segments.push(encoded); continue; }
      let origin = [...segment[0]];
      for (let offset = 1; offset < segment.length; offset += 1024) {
        const steps = segment.slice(offset, offset + 1024);
        segments.push({ chain: encoded.chain, part: (offset - 1) / 1024, data: [[...origin], ...steps] });
        for (const step of steps) { origin[0] += step[0]; origin[1] = ((origin[1] + step[1] + 540000000) % 360000000) - 180000000; }
      }
    }
    return segments;
  }
  const entries = new Map(), overviews = new Map();
  for (const run of runs) {
    const route = displayRoute(run), { segments, ...base } = route;
    const routeRefs = pages('route', base, 'segments', pieces(route));
    const analysis = put({ schema: 1, kind: 'analysis', id: run.id, summary: run.summary,
      paceSamples: run.paceSamples.map(p => [p.elapsedSeconds, p.paceSecondsPerKm, p.coverage]),
      splits: run.splits.map(s => [s.kilometer, s.distanceMeters, s.durationSeconds, s.paceSecondsPerKm, s.coverage, !!s.partial]) });
    entries.set(run.id, listEntry(run, { route: routeRefs, analysis }, run.segments.length ? fresh.get(run.id)?.fresh ?? null : null));
    const overview = displayRoute(run, true);
    overviews.set(run.id, pieces(overview).map(segment => ({ ...overview, segments: [segment] })));
  }
  const years = {}, months = [...new Set(runs.map(r => r.date.slice(0, 7)))].sort();
  for (const year of [...new Set(months.map(m => m.slice(0, 4)))]) {
    const yearRuns = runs.filter(r => r.date.startsWith(year)), monthEntries = [];
    for (const month of months.filter(m => m.startsWith(year))) {
      const selected = yearRuns.filter(r => r.date.startsWith(month));
      monthEntries.push({ month, summary: sum(selected), lists: pages('month', { month }, 'runs', selected.map(r => entries.get(r.id))),
        overview: pages('overview', { month }, 'routes', selected.flatMap(r => overviews.get(r.id))) });
    }
    years[year] = put({ schema: 1, kind: 'year', year, summary: sum(yearRuns), months: monthEntries,
      days: [...new Set(yearRuns.map(r => r.date))].sort().map(date => { const total = sum(yearRuns.filter(r => r.date === date)); return [date, total.distanceMeters, total.durationSeconds, total.runs]; }) });
  }
  const groups = new Map(), blocks = {};
  for (const tile of mask.tiles) {
    const block = `${Math.floor(tile.x / MASK_BLOCK_TILES)}/${Math.floor(tile.y / MASK_BLOCK_TILES)}`;
    if (!groups.has(block)) groups.set(block, []); groups.get(block).push(tile);
  }
  for (const [block, tiles] of groups) blocks[block] = pages('exploration', { block, zoom: MASK_ZOOM, size: MASK_SIZE }, 'tiles', tiles);
  const catalog = { schema: 1, kind: 'catalog', algorithm: ALGORITHM, policy: POLICY, years,
    latest: runs.length ? { id: runs.at(-1).id, date: runs.at(-1).date } : null,
    exploration: { zoom: MASK_ZOOM, size: MASK_SIZE, blockTiles: MASK_BLOCK_TILES, blocks } };
  const content = json(catalog);
  if (byteLength(content) > limit) throw Error('CATALOG_SIZE_LIMIT');
  return { catalog, catalogContent: content, objects: [...objects.values()], entries: [...entries.values()] };
}
