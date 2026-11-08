import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CsvParser, SensorGpsReader } from '../processing/running/csv.js';
import { deriveSource, displayRoute, activityDate } from '../processing/running/derive.js';
import { distance, perpendicular, simplify, thumbnail } from '../processing/running/geometry.js';
import { explorationTiles, MASK_ZOOM, MASK_SIZE } from '../processing/running/exploration.js';
import { prepareRunning, MAX_OBJECT_BYTES } from '../processing/running/materialize.mjs';
import { createRunningRepository, decodeRoute, decodeMask } from '../lib/running-artifacts.js';
import { build } from '../scripts/build.mjs';

const START = Date.parse('2026-01-01T00:00:00Z');
const DEGREE = 180 / Math.PI / 6371008.8;
const iso = seconds => new Date(START + seconds * 1000).toISOString();
function csv(points, { repeats = 1, offset = 0 } = {}) {
  return '\uFEFF# sensor: synthetic\r\ntime,ax,latitude,longitude,label\r\n' + points.flatMap((p, i) =>
    Array.from({ length: repeats }, (_, r) => `${iso(offset + i + r / repeats)},9.8,${p[0]},${p[1]},"synthetic, multiline\nvalue"`)).join('\r\n');
}
function parsed(text, chunk = 8192) {
  const reader = new SensorGpsReader(), parser = new CsvParser();
  for (let i = 0; i < text.length; i += chunk) parser.write(text.slice(i, i + chunk), row => reader.row(row));
  parser.write('', row => reader.row(row), true); return reader.finish();
}
const line = (count = 81, meters = 3) => Array.from({ length: count }, (_, i) => [0, i * meters * DEGREE]);

test('CSV chunk boundaries, escaped quotes, BOM and CRLF preserve complete records', () => {
  const text = csv(line(5), { repeats: 20 }), expected = parsed(text);
  for (const width of [1, 2, 3, 7, 137]) assert.deepEqual(parsed(text, width), expected);
  assert.equal(expected.counts.rows, 100); assert.equal(expected.fixes.length, 5);
  const rows = [], parser = new CsvParser(); parser.write('a,"b""c",d\r\n"e\nf",g,h', r => rows.push(r), true);
  assert.deepEqual(rows, [['a', 'b"c', 'd'], ['e\nf', 'g', 'h']]);
  for (const text of ['a,"unfinished', 'a,"done"garbage', 'a,un"quoted']) assert.throws(() => new CsvParser().write(text, () => {}, true), /CSV_/);
  assert.throws(() => new CsvParser({ maxField: 3 }).write('abcd', () => {}), /CSV_FIELD_LIMIT/);
});

test('100 Hz held GPS does not become 100 Hz travel or implausible spike speeds', () => {
  const source = parsed(csv(line(3), { repeats: 100 })), [run] = deriveSource(source);
  assert.equal(source.counts.rows, 300); assert.equal(source.counts.repeatedGpsRows, 297);
  assert(Math.abs(run.summary.distanceMeters - 6) < .001);
  assert.equal(run.summary.durationSeconds, 2.99);
  assert.equal(run.summary.observedSeconds, 2.99);
  assert.equal(run.quality.rejectedEdges, 0);
  for (const speed of decodeRoute(displayRoute({ ...run, id: 'synthetic' })).segments.flatMap(s => s.speedsKmh)) assert(Math.abs(speed - 10.8) <= .05);
  assert(Math.abs(run.summary.paceSecondsPerKm - 2.99 / 6 * 1000) < .001);
});

test('invalid fixes, recording gaps, impossible jumps and non-UTC times are explicit', () => {
  const text = 'time,latitude,longitude\n' + [
    [iso(0), 0, 0], [iso(1), 0, 3 * DEGREE], [iso(2), '', ''], [iso(3), 0, 9 * DEGREE],
    [iso(4), 40, 100], [iso(5), 0, 15 * DEGREE], [iso(40), 0, 18 * DEGREE],
  ].map(row => row.join(',')).join('\n');
  const source = parsed(text), [run] = deriveSource(source);
  assert.equal(source.counts.invalidGpsRows, 1); assert.equal(source.counts.rowGaps, 1);
  assert.equal(run.quality.rejectedEdges, 4);
  assert(Math.abs(run.summary.distanceMeters - 3) < .001);
  assert.equal(run.summary.durationSeconds, 40);
  assert.equal(run.quality.missingSeconds, 39);
  assert(run.paceSamples.every(p => p.coverage < .5));
  for (const s of run.segments) for (let i = 1; i < s.points.length; i++) assert(distance(s.points[i - 1], s.points[i]) <= 250);
  assert.throws(() => parsed('time,latitude,longitude\n12:00:00,0,0'), /UTC_TIME_REQUIRED/);
  assert.throws(() => parsed('time,latitude,longitude\n2026-02-30T00:00:00Z,0,0'), /TIME_INVALID/);
  assert.throws(() => parsed('time,latitude,longitude\n' + iso(2) + ',0,0\n' + iso(1) + ',0,0'), /TIME_ORDER/);
});

test('JST 03:00 divides distance and elapsed time without changing totals', () => {
  const a = Date.parse('2026-01-01T17:59:59Z'), b = a + 2000;
  const source = { start: a, end: b, fixes: [{ t: a, lastT: a, lat: 0, lon: 0 }, { t: b, lastT: b, lat: 0, lon: 6 * DEGREE }] };
  const runs = deriveSource(source);
  assert.deepEqual(runs.map(r => r.date), ['2026-01-01', '2026-01-02']);
  assert.deepEqual(runs.map(r => r.summary.durationSeconds), [1, 1]);
  assert.equal(runs.reduce((n, r) => n + r.summary.distanceMeters, 0), 6);
  assert.equal(activityDate(b), '2026-01-02');
});

test('distance and kilometer splits are independent of display simplification', () => {
  const [run] = deriveSource(parsed(csv(line(1001))));
  assert(Math.abs(run.summary.distanceMeters - 3000) < .001);
  assert.equal(run.splits.filter(s => !s.partial).length, 3);
  assert(Math.abs(run.splits.reduce((n, s) => n + s.distanceMeters, 0) - 3000) < .001);
  const detailed = decodeRoute(displayRoute({ ...run, id: 'test' }));
  const overview = decodeRoute(displayRoute({ ...run, id: 'test' }, true));
  assert(detailed.segments[0].points.length < run.segments[0].points.length / 10);
  assert(overview.segments[0].points.length <= detailed.segments[0].points.length);
  assert.equal(run.summary.distanceMeters, 3000);
  for (const split of run.splits.filter(s => !s.partial)) assert(Math.abs(split.paceSecondsPerKm - 1000 / 3) < .002);
});

test('geometry and speed bounds preserve a corner and a short fast interval', () => {
  const points = Array.from({ length: 101 }, (_, i) => i <= 50 ? [0, i * 2 * DEGREE] : [(i - 50) * 2 * DEGREE, 100 * DEGREE]);
  const seconds = points.slice(1).map((_, i) => i >= 20 && i < 25 ? .4 : 1);
  const segment = { points, seconds, distances: points.slice(1).map((p, i) => distance(points[i], p)) };
  const simplified = simplify(segment);
  assert(simplified.points.some(p => distance(p, points[50]) < .01));
  assert(simplified.speedsKmh.some(s => s > 17));
  assert(simplified.maxErrorMeters <= 2); assert(simplified.maxSpeedErrorKmh <= .5);
  const packed = decodeRoute({ schema: 1, kind: 'route', id: 'x', encoding: 'delta-e6-speed10', ...displayRoute({ id: 'x', date: '2026-01-01', segments: [segment], quality: {} }) });
  for (const p of points) {
    const path = packed.segments[0].points;
    assert(Math.min(...path.slice(1).map((b, i) => perpendicular(p, path[i], b))) <= 2.09);
  }
  const outline = thumbnail([segment]); assert(outline[0].length < 10); assert.deepEqual(outline[0][0], [160, 460]);
});

test('prepared exploration fills cross-day loops and is unchanged by repeat visits', () => {
  const points = [[0, 0], [0, .002], [.002, .002], [.002, 0], [0, 0]];
  const runs = [{ segments: [{ points: points.slice(0, 3) }] }, { segments: [{ points: points.slice(2) }] }];
  const result = explorationTiles(runs), repeated = explorationTiles([...runs, ...runs]);
  assert(result.regionCount > 0); assert.deepEqual(repeated.tiles, result.tiles);
  const sample = ([lat, lon]) => {
    const n = 2 ** MASK_ZOOM, x = (lon + 180) / 360 * n, sine = Math.sin(lat * Math.PI / 180), y = (.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * n;
    const tile = result.tiles.find(t => t.x === Math.floor(x) && t.y === Math.floor(y));
    return tile ? decodeMask(tile.rle)[Math.floor((y % 1) * MASK_SIZE) * MASK_SIZE + Math.floor((x % 1) * MASK_SIZE)] : 0;
  };
  assert.equal(sample([.001, .001]), 255); assert.equal(sample([.005, .005]), 0);
  assert.throws(() => explorationTiles(runs, { maxCellVisits: 1 }), /WORK_LIMIT/);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'my-pace-preparation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'raw'); await mkdir(input);
  const sources = [];
  async function add(id, offset = 0, points = line()) {
    const path = join(input, id + '.csv'); await writeFile(path, csv(points, { offset }));
    const source = { id, path }; sources.push(source); return source;
  }
  const options = { sources, output: join(root, 'display'), cache: join(root, 'cache') };
  return { root, options, add, index: () => readFile(join(options.output, 'index.json'), 'utf8') };
}

test('unchanged sources read zero CSV bytes; new data leaves old per-run objects reusable', async t => {
  const f = await fixture(t); await f.add('first');
  const first = await prepareRunning(f.options), previous = [...first.entries.values()][0];
  const initialIndex = await f.index(), again = await prepareRunning(f.options);
  assert.equal(again.stats.rawBytesRead, 0); assert.equal(again.stats.processedSources, 0);
  assert.equal(again.stats.catalogChanged, false);
  assert.equal(again.stats.createdObjects, 0); assert.equal(await f.index(), initialIndex);
  const added = await f.add('second', 86400);
  const next = await prepareRunning(f.options);
  assert.equal(next.stats.rawBytesRead, Buffer.byteLength(await readFile(added.path)));
  assert.equal(next.stats.reusedSources, 1); assert.equal(next.stats.processedSources, 1);
  assert.deepEqual(next.entries.get(previous.id).route, previous.route);
  for (const [path, value] of next.objects) {
    const bytes = await readFile(join(f.options.output, path));
    assert(bytes.length <= MAX_OBJECT_BYTES); assert.deepEqual(JSON.parse(bytes), value);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), path.slice(8, -5));
  }
});

test('failed CSV, interrupted publication and overlapping sources preserve the prior catalog', async t => {
  const f = await fixture(t); await f.add('first'); await prepareRunning(f.options);
  const previous = await f.index(), second = await f.add('second', 86400);
  await assert.rejects(prepareRunning({ ...f.options, beforePublish: () => { throw Error('SIMULATED_FAILURE'); } }), /SIMULATED_FAILURE/);
  assert.equal(await f.index(), previous);
  const resumed = await prepareRunning(f.options); assert.equal(resumed.stats.rawBytesRead, 0);
  const valid = await f.index();
  await writeFile(second.path, 'time,latitude,longitude\n"broken');
  await assert.rejects(prepareRunning(f.options), /UNCLOSED_QUOTE/); assert.equal(await f.index(), valid);
  await writeFile(second.path, csv(line(5), { offset: 10 }));
  await assert.rejects(prepareRunning(f.options), /OVERLAPPING_SOURCES/); assert.equal(await f.index(), valid);
  await assert.rejects(prepareRunning({ ...f.options, sources: [] }), /NONEMPTY/); assert.equal(await f.index(), valid);
});

test('identical GPS exports are deduplicated deterministically and revised sources replace the same run ID', async t => {
  const f = await fixture(t), a = await f.add('a'), b = await f.add('b');
  const first = await prepareRunning(f.options); assert.equal(first.stats.runs, 1); assert.equal(first.stats.duplicateSources, 1);
  const index = await f.index();
  await prepareRunning({ ...f.options, sources: [...f.options.sources].reverse() }); assert.equal(await f.index(), index);
  const before = [...first.entries.values()][0];
  await writeFile(a.path, csv(line(81, 4)));
  const changed = await prepareRunning({ ...f.options, sources: [a] }), after = [...changed.entries.values()][0];
  assert.equal(before.id, after.id); assert.notDeepEqual(before.route, after.route);
  assert(after.summary.distanceMeters > before.summary.distanceMeters);
});

test('repository loads calendar/list without routes; selected route, analysis and region are independent reads', async t => {
  const f = await fixture(t); await f.add('first'); await f.add('second', 86400);
  const result = await prepareRunning(f.options), requests = [];
  const repository = createRunningRepository({ fetchJson: async path => { requests.push(path); return JSON.parse(await readFile(join(f.options.output, path))); } });
  const index = await repository.catalog(), year = await repository.year(index.years['2026']);
  const list = await repository.month(year.months[0].lists[0]);
  assert.equal(requests.length, 3); assert.equal(list.runs.length, 2);
  for (const run of list.runs) for (const ref of [...run.route, run.analysis]) assert(!requests.includes(ref.path));
  const selected = list.runs[0]; await Promise.all([repository.route(selected.route), repository.route(selected.route)]);
  assert.equal(requests.length, 3 + selected.route.length);
  assert(!requests.includes(selected.analysis.path)); assert(!requests.includes(list.runs[1].route[0].path));
  await repository.analysis(selected.analysis); assert.equal(requests.at(-1), selected.analysis.path);
  await repository.exploration(Object.values(index.exploration.blocks)[0]);
  await assert.rejects(repository.year({ path: '../raw/first.csv', bytes: 100 }), /REFERENCE_INVALID/);
});

test('a large, speed-varying route is split into bounded objects with continuous joins', async t => {
  const f = await fixture(t); let angle = 0;
  const points = Array.from({ length: 12001 }, (_, i) => {
    angle += i % 2 ? .013 : .033;
    return [150 * Math.sin(angle) * DEGREE, 150 * Math.cos(angle) * DEGREE];
  });
  await f.add('long-synthetic-run', 0, points);
  const result = await prepareRunning(f.options), entry = [...result.entries.values()][0];
  assert(entry.route.length >= 2, 'route must exceed a single transport object');
  const decoded = [];
  for (const ref of entry.route) {
    assert(ref.bytes <= MAX_OBJECT_BYTES);
    const data = JSON.parse(await readFile(join(f.options.output, ref.path)));
    for (const segment of decodeRoute(data).segments) {
      if (decoded.length) assert.deepEqual(segment.points[0], decoded.at(-1));
      decoded.push(...segment.points.slice(decoded.length ? 1 : 0));
    }
  }
  assert.equal(decoded.length, points.length, 'alternating speed changes must remain observable');
  assert(distance(decoded[0], points[0]) <= .08); assert(distance(decoded.at(-1), points.at(-1)) <= .08);
});

test('invalid UTF-8 and a held preparation lock cannot publish or overwrite valid artifacts', async t => {
  const f = await fixture(t), source = await f.add('first'); await prepareRunning(f.options);
  const initial = await f.index();
  await writeFile(join(f.options.output, '.prepare.lock'), 'other-worker');
  await assert.rejects(prepareRunning(f.options), /ALREADY_RUNNING/); assert.equal(await f.index(), initial);
  await rm(join(f.options.output, '.prepare.lock'));
  await writeFile(source.path, Buffer.from([0xff, 0xfe, 0x00]));
  await assert.rejects(prepareRunning(f.options)); assert.equal(await f.index(), initial);
});

test('prepared GPS, caches and source files cannot enter a public build', async t => {
  const f = await fixture(t); await f.add('first'); await prepareRunning(f.options);
  const root = join(f.root, 'app'); await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<title>app</title>'); await writeFile(join(root, 'app.js'), ''); await writeFile(join(root, 'styles.css'), '');
  await writeFile(join(root, 'data/running.json'), '{"privateGps":true}');
  await writeFile(join(root, 'data/index.json'), await f.index());
  const result = await build({ root, publicBuild: true });
  assert.deepEqual(JSON.parse(await readFile(join(result.output, 'data/running.json'))), { days: [] });
  assert.deepEqual(await readdir(join(result.output, 'data')), ['running.json']);
});
