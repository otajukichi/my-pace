import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createWeatherArea, createWeatherApiHandler } from '../scripts/weather-area.mjs';

test('weather location is coarse, uses the latest valid record, and resets to public on restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mypace-weather-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data'));
  const file = join(root, 'data/running.json');
  await writeFile(file, JSON.stringify({ days: [
    { date: '2026-10-01', segments: [{ points: [[0, 0]] }] },
    { date: '2026-10-15', segments: [{ points: [null, [91, 181], [35.681236, 139.767125]] }] },
  ] }));
  const area = createWeatherArea({ root });
  assert.equal((await area.get()).mode, 'demo');
  const selected = await area.set(true);
  assert.deepEqual(selected, { mode: 'recorded', areaName: '記録の周辺', center: { lat: 35.7, lon: 139.8 } });
  assert.deepEqual(await area.get(), selected);
  assert.equal((await createWeatherArea({ root }).get()).mode, 'demo');
  await assert.rejects(() => area.set('true'), { status: 400 });
  await area.set(false);
  await writeFile(file, '{broken');
  await assert.rejects(() => area.set(true), { status: 503 });
  assert.equal((await area.get()).mode, 'demo', 'failed changes preserve the previous selection');
});

async function request(handler, { path = '/api/weather-area', method = 'GET', body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [body]);
  Object.assign(req, { url: path, method, headers: { host: 'localhost:4173', ...headers }, socket: { localPort: 4173 } });
  const result = {};
  const handled = await handler(req, {
    writeHead(status, responseHeaders) { result.status = status; result.headers = responseHeaders; },
    end(text) { result.body = JSON.parse(text); },
  });
  return { ...result, handled };
}
const localPost = { method: 'POST', headers: { origin: 'http://localhost:4173', 'content-type': 'application/json' } };

test('retired planning APIs return 404 and never execute a service', async () => {
  const handler = createWeatherApiHandler({ weatherArea: { get: assert.fail, set: assert.fail } });
  for (const path of ['/api/places', '/api/route', '/api/area', '/api/ai/status', '/api/ai/connect', '/api/ai/disconnect', '/api/ai/suggest']) {
    for (const method of ['GET', 'POST']) assert.equal((await request(handler, { ...localPost, path, method, body: '{}' })).status, 404);
  }
  assert.equal((await request(handler, { path: '/app.js' })).handled, false);
});

test('weather preference can change locally but rejects cross-site, non-JSON and malformed writes', async () => {
  const changes = [];
  const handler = createWeatherApiHandler({ weatherArea: { get: () => ({ mode: 'demo' }), set: value => { changes.push(value); return { mode: value ? 'recorded' : 'demo' }; } } });
  assert.equal((await request(handler)).status, 200);
  assert.equal((await request(handler, { ...localPost, body: '{"useRecordedLocation":true}' })).status, 200);
  assert.deepEqual(changes, [true]);
  for (const headers of [{}, { origin: 'https://other.example' }, { origin: 'http://localhost:4173', 'sec-fetch-site': 'cross-site' }, { host: 'public.example:4173' }, { host: 'localhost:4321' }]) {
    assert.equal((await request(handler, { method: 'POST', body: '{"useRecordedLocation":false}', headers })).status, 403);
  }
  assert.equal((await request(handler, { method: 'POST', headers: { origin: 'http://localhost:4173' }, body: '{}' })).status, 415);
  for (const body of ['null', '[]', '{}', '{', '{"useRecordedLocation":"true"}', '{"useRecordedLocation":true,"extra":1}']) {
    assert.equal((await request(handler, { ...localPost, body })).status, 400);
  }
  assert.equal((await request(handler, { ...localPost, body: ' '.repeat(1025) })).status, 413);
  assert.equal((await request(handler, { method: 'DELETE' })).status, 405);
  assert.deepEqual(changes, [true]);
});
