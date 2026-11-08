import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseChunk, decodeUtf8 } from '../processing/running/probe-core.js';
import { CsvParser, SensorGpsReader } from '../processing/running/csv.js';
import { prepareRunning } from '../processing/running/materialize.mjs';
import { hash, json } from '../processing/running/cache.mjs';
import { gasProbeHarness } from './helpers/gas-running-probe.mjs';

const csv = (day, count = 80) => '\uFEFF# 合成データ\r\ntime,latitude,longitude,other\r\n' + Array.from({ length: count }, (_, i) =>
  `${new Date(Date.UTC(2026, 0, day, 0, 0, i)).toISOString()},0,${i * .00002},"音声🌱,\nquoted"`).join('\r\n');

test('Apps Script byte checkpoints preserve UTF-8, quotes and repeated GPS across arbitrary boundaries', () => {
  const text = csv(1), bytes = Buffer.from(text), parser = new CsvParser(), reader = new SensorGpsReader();
  parser.write(text, row => reader.row(row), true); const expected = reader.finish();
  for (const size of [1, 2, 3, 7, 37, 1024]) {
    let checkpoint;
    for (let offset = 0; offset < bytes.length; offset += size) {
      checkpoint = parseChunk(checkpoint, bytes.subarray(offset, offset + size), offset + size >= bytes.length);
      checkpoint = JSON.parse(JSON.stringify(checkpoint));
    }
    assert.deepEqual(checkpoint.finished, expected);
  }
  for (const bytes of [[0xff], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe3]]) assert.throws(() => decodeUtf8(bytes, [], true), /UTF8/);
});

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mypace-gas-probe-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sources = [], sourceBytes = new Map();
  for (let i = 0; i < 3; i++) {
    const id = 'synthetic-' + i, bytes = Buffer.from(csv(i + 1, options.rows || 80)), path = join(root, id + '.csv');
    await writeFile(path, bytes); sources.push({ id, path }); sourceBytes.set(id, bytes);
  }
  const result = await prepareRunning({ sources, output: join(root, 'reference'), cache: join(root, 'cache') });
  const config = { sourceFolder: 'source', chunkBytes: 1024 * 1024, expectedCatalogHash: hash(json(result.catalog)), sources: sources.map(s => {
    const bytes = sourceBytes.get(s.id), chunks = [];
    for (let i = 0; i < bytes.length; i += 1024 * 1024) chunks.push(hash(bytes.subarray(i, i + 1024 * 1024)));
    return { id: s.id, size: bytes.length, md5: createHash('md5').update(bytes).digest('hex'), chunks };
  }) };
  return { root, result, config, sourceBytes, harness: await gasProbeHarness(config, sourceBytes, options) };
}
function finish(harness) {
  for (let tick = 0; tick < 100; tick++) {
    harness.advance(300000); harness.invoke('myPaceProbeTick');
    if (harness.report?.phase === 'done') return harness.invoke('showMyPaceThreeCsvProbeReport');
    if (!harness.triggers.some(t => t.handler === 'myPaceProbeTick')) throw Error(JSON.stringify(harness.logs.at(-1)));
  }
  throw Error('TEST_DID_NOT_COMPLETE');
}

test('cold Apps Script invocations produce the exact local catalog and every artifact, including exploration', async t => {
  const f = await fixture(t, { requestMs: 1200 }), h = f.harness;
  h.invoke('startMyPaceThreeCsvProbe'); assert.equal(h.state.source, 0);
  const report = finish(h);
  assert.equal(report.environment, 'simulation'); assert.equal(report.status, 'TARGET_MET');
  assert.equal(report.completedSources, 3); assert.equal(report.matchesLocalReference, true);
  assert(report.invocations > 1); assert(report.requests < 1000);
  for (const file of h.files.values()) if (file.meta.appProperties?.role === 'artifact') {
    assert.equal(hash(file.bytes), file.meta.name.slice(0, -5));
    assert.deepEqual(file.bytes, await readFile(join(f.root, 'reference/objects', file.meta.name)));
  }
  assert(h.triggers.some(t => t.handler === 'unrelatedExistingTestHandler'));
  assert(!h.triggers.some(t => t.handler === 'myPaceProbeTick'));
  assert(!h.requests.some(r => ['post', 'patch'].includes(r.method) && r.path.startsWith('files/synthetic-')));
  assert(!h.logs.some(log => /synthetic-[012]|latitude|longitude|OAuthToken/.test(JSON.stringify(log))));
});

test('lost checkpoint-write acknowledgement resumes persisted work and creates no duplicate artifacts', async t => {
  let dropped = false;
  const f = await fixture(t, { afterRequest({ method, path, files }) {
    if (!dropped && method === 'patch' && files.get(path.slice(6))?.meta.appProperties?.role === 'state') { dropped = true; throw Error('simulated lost response'); }
  } });
  const h = f.harness; h.invoke('startMyPaceThreeCsvProbe');
  const report = finish(h); assert(dropped); assert.equal(report.status, 'TARGET_MET');
  const names = [...h.files.values()].filter(f => f.meta.appProperties?.role === 'artifact').map(f => f.meta.name);
  assert.equal(new Set(names).size, names.length);
});

test('bad source bytes stop the benchmark before publication and keep source files intact', async t => {
  const f = await fixture(t), h = f.harness; h.invoke('startMyPaceThreeCsvProbe');
  h.files.get('synthetic-0').bytes[0] ^= 1;
  h.invoke('myPaceProbeTick');
  assert.equal(h.logs.at(-1).status, 'SOURCE_CHUNK_MISMATCH');
  assert(![...h.files.values()].some(f => f.meta.appProperties?.role === 'catalog'));
  assert(!h.triggers.some(t => t.handler === 'myPaceProbeTick'));
});

test('budget exhaustion stops its own trigger without silently extending the 24-hour experiment', async t => {
  const f = await fixture(t), h = f.harness; h.invoke('startMyPaceThreeCsvProbe');
  h.properties.set('MYPACE_RUNNING_THREE_CSV_V1_TOTAL_MS', String(3500000));
  const result = h.invoke('myPaceProbeTick'); assert.equal(result.status, 'BENCHMARK_BUDGET_REACHED');
  assert(!h.triggers.some(t => t.handler === 'myPaceProbeTick'));
  assert(h.triggers.some(t => t.handler === 'unrelatedExistingTestHandler'));
  assert(![...h.files.values()].some(f => f.meta.appProperties?.role === 'catalog'));
});

test('an interrupted invocation keeps its six-minute reservation and is reported on the next trigger', async t => {
  const f = await fixture(t), h = f.harness; h.invoke('startMyPaceThreeCsvProbe');
  const before = Number(h.properties.get('MYPACE_RUNNING_THREE_CSV_V1_TOTAL_MS'));
  h.properties.set('MYPACE_RUNNING_THREE_CSV_V1_TOTAL_MS', String(before + 360000));
  h.properties.set('MYPACE_RUNNING_THREE_CSV_V1_ACTIVE', '1');
  const report = finish(h);
  assert.equal(report.interruptedInvocations, 1); assert(report.chargedExecutionSeconds >= 360);
  assert.equal(report.status, 'TARGET_MET');
});

test('sharing the test output folder stops processing before any raw GPS is fetched', async t => {
  const f = await fixture(t), h = f.harness; h.invoke('startMyPaceThreeCsvProbe');
  const folder = [...h.files.values()].find(f => f.meta.appProperties?.role === 'folder'); folder.meta.shared = true;
  h.invoke('myPaceProbeTick');
  assert.equal(h.logs.at(-1).status, 'OUTPUT_NOT_OWNER_PRIVATE');
  assert(!h.requests.some(r => r.range));
  assert(!h.triggers.some(t => t.handler === 'myPaceProbeTick'));
});

test('stopping and resuming retains progress, original start time and quota counters', async t => {
  const f = await fixture(t), h = f.harness; h.invoke('startMyPaceThreeCsvProbe');
  const root = h.properties.get('MYPACE_RUNNING_THREE_CSV_V1'), used = Number(h.properties.get('MYPACE_RUNNING_THREE_CSV_V1_TOTAL_MS'));
  h.invoke('stopMyPaceThreeCsvProbe'); assert(!h.triggers.some(t => t.handler === 'myPaceProbeTick'));
  h.invoke('startMyPaceThreeCsvProbe'); assert.equal(h.properties.get('MYPACE_RUNNING_THREE_CSV_V1'), root);
  assert(Number(h.properties.get('MYPACE_RUNNING_THREE_CSV_V1_TOTAL_MS')) >= used);
  assert.equal(finish(h).status, 'TARGET_MET');
});
