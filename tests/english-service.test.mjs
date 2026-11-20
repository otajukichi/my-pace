import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnglishService } from '../server/english-service.js';
import productionHandler from '../api/english.js';

const NOW = Date.parse('2026-11-20T10:00:00.000Z');
const ORIGIN = 'https://my-pace.example';
const catalog = { schema: 1, materials: [
  { id: 'people-hello', kind: 'conversation', areaId: 'people', title: 'Self introduction', description: 'A short introduction.', durationMinutes: 5 },
  { id: 'reading-short', kind: 'reading', areaId: null, title: 'Short reading', description: 'A short reading.', durationMinutes: 3, format: 'phrases' },
] };
const receipt = {
  schema: 1, sessionId: 'session-test-001', performedAt: '2026-11-20T09:00:00.000Z',
  kind: 'conversation', areaId: 'people', themeId: 'people-hello', modeId: 'scene',
};
function response() {
  return { headers: {}, status: 0, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body = '') { this.body = body; } };
}
function req(value = receipt, action = 'record', headers = {}) {
  return { method: 'POST', url: '/api/english?action=' + action, headers: {
    authorization: 'Bearer verified-test-token', 'content-type': 'application/json', origin: ORIGIN, ...headers,
  }, body: value };
}
async function call(service, request) {
  const res = response(); await (typeof service === 'function' ? service : service.handle)(request, res);
  return { ...res, json: res.body ? JSON.parse(res.body) : null };
}
function harness(overrides = {}) {
  const stored = new Map(); let authCalls = 0, appendCalls = 0;
  const principal = { subject: 'test-owner', audience: ORIGIN + '/api/english', scopes: ['english:practice:append'], expiresAt: NOW + 60000 };
  const options = {
    ownerSubject: 'test-owner', audience: principal.audience, origin: ORIGIN, catalog, now: () => NOW,
    authenticate: async request => { authCalls++; return request.headers.authorization === 'Bearer verified-test-token' ? principal : null; },
    // TEST ONLY. The check + insert below is atomic within this one JS process.
    // A real multi-instance Drive adapter must provide durable atomicity instead.
    storage: {
      ownerSubject: 'test-owner',
      async appendOnce(id, record) {
        appendCalls++; await new Promise(resolve => setImmediate(resolve));
        const previous = stored.get(id), serialized = JSON.stringify(record);
        if (previous !== undefined) return previous === serialized ? 'duplicate' : 'conflict';
        stored.set(id, serialized); return 'created';
      },
    },
    ...overrides,
  };
  return { service: createEnglishService(options), stored, options, principal, get authCalls() { return authCalls; }, get appendCalls() { return appendCalls; } };
}
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

test('deployed English API only reveals unavailable status and cannot store records', async () => {
  const status = await call(productionHandler, { method: 'GET', url: '/api/english', headers: {} });
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, { configured: false, recording: 'unconfigured', voiceIntegration: 'unverified' });
  for (const request of [req(), req(rpc('tools/list'), 'mcp'), req(rpc('tools/call', { name: 'record_practice', arguments: receipt }), 'mcp')]) {
    const result = await call(productionHandler, request);
    assert.equal(result.status, 503); assert.equal(result.json.error, 'ENGLISH_UNCONFIGURED');
  }
  assert.equal(status.headers['Cache-Control'], 'private, no-store');
  assert.equal(status.headers['Vercel-CDN-Cache-Control'], 'no-store');
});

test('partial adapter wiring and unbound storage remain closed', async () => {
  for (const overrides of [{ authenticate: undefined }, { catalog: undefined }, { catalog: { ...catalog, scenario: 'not metadata' } }, { ownerSubject: undefined }, { audience: undefined }, { origin: undefined }, { storage: { ownerSubject: 'other-owner', appendOnce() { throw Error('must not run'); } } }]) {
    const h = harness(overrides), result = await call(h.service, req());
    assert.equal(result.status, 503); assert.equal(h.appendCalls, 0);
  }
});

test('writes require separate authenticated OAuth principal, scope, audience, owner and expiry', async () => {
  for (const headers of [{ authorization: undefined }, { authorization: 'Bearer wrong-test-token' }, { authorization: undefined, cookie: '__Host-mypace-session=running-cookie' }]) {
    const h = harness(), result = await call(h.service, req(receipt, 'record', headers));
    assert.equal(result.status, 401); assert.equal(h.appendCalls, 0); assert.match(result.headers['WWW-Authenticate'], /^Bearer /);
  }
  for (const patch of [{ subject: 'another-owner' }, { audience: 'https://another.example' }, { expiresAt: NOW }, { expiresAt: undefined }]) {
    const h = harness(); Object.assign(h.principal, patch);
    assert.equal((await call(h.service, req())).status, 401); assert.equal(h.appendCalls, 0);
  }
  const h = harness(); h.principal.scopes = ['running:read'];
  assert.equal((await call(h.service, req())).status, 403); assert.equal(h.appendCalls, 0);
  const broken = harness({ authenticate: async () => { throw Error('private token or provider details'); } });
  const result = await call(broken.service, req()); assert.equal(result.status, 401); assert(!result.body.includes('private'));
});

test('cross-origin writes stop before authentication; server-to-server calls can omit Origin', async () => {
  const h = harness();
  const denied = await call(h.service, req(receipt, 'record', { origin: 'https://unrelated.example' }));
  assert.equal(denied.status, 403); assert.equal(h.authCalls, 0); assert.equal(h.appendCalls, 0);
  const accepted = await call(h.service, req(receipt, 'record', { origin: undefined }));
  assert.equal(accepted.status, 201);
});

test('only catalogue-linked metadata receipts are stored, server stamps connector origin', async () => {
  const h = harness(), result = await call(h.service, req());
  assert.equal(result.status, 201);
  assert.deepEqual(result.json, { sessionId: receipt.sessionId, recorded: true, duplicate: false });
  assert.deepEqual(JSON.parse(h.stored.get(receipt.sessionId)), { ...receipt, origin: 'connector' });
  const reading = { ...receipt, sessionId: 'session-reading-001', kind: 'reading', areaId: null, themeId: 'reading-short', modeId: 'reading' };
  assert.equal((await call(h.service, req(reading))).status, 201);
  assert(!result.body.includes('test-owner')); assert(!result.body.includes('verified-test-token'));
});

test('transcripts, scores, folder IDs, prototype keys and invalid metadata never reach storage', async () => {
  const invalid = [
    { ...receipt, transcript: 'private conversation' }, { ...receipt, audio: 'base64' }, { ...receipt, score: 100 },
    { ...receipt, folderId: 'arbitrary-folder' }, { ...receipt, path: '../running/index.json' }, { ...receipt, origin: 'manual' },
    { ...receipt, themeId: 'unknown-theme' }, { ...receipt, areaId: 'travel' }, { ...receipt, modeId: 'reading' },
    { ...receipt, schema: 2 }, { ...receipt, sessionId: 'short' }, { ...receipt, performedAt: '2026-02-30T09:00:00.000Z' },
    { ...receipt, performedAt: '2026-11-20' }, { ...receipt, performedAt: '2026-11-20T18:00:00+09:00' },
    { ...receipt, kind: 'reading', themeId: 'reading-short', areaId: 'people', modeId: 'reading' },
    { ...receipt, kind: 'reading', themeId: 'reading-short', areaId: null, modeId: 'free' },
    JSON.parse(JSON.stringify(receipt).slice(0, -1) + ',"__proto__":{"injected":true}}'),
    Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'performedAt')),
    null, [],
  ];
  const h = harness();
  for (const value of invalid) {
    const result = await call(h.service, req(value));
    assert.equal(result.status, 400, JSON.stringify(value)); assert.equal(result.json.error, 'INVALID_PRACTICE_RECORD');
  }
  assert.equal(h.appendCalls, 0);
});

test('concurrent retries commit one receipt and conflicting reuse cannot overwrite it', async () => {
  const h = harness();
  const results = await Promise.all(Array.from({ length: 20 }, () => call(h.service, req())));
  assert.equal(results.filter(result => result.status === 201).length, 1);
  assert.equal(results.filter(result => result.status === 200 && result.json.duplicate).length, 19);
  assert.equal(h.stored.size, 1);
  const reordered = Object.fromEntries(Object.entries(receipt).reverse());
  assert.equal((await call(h.service, req(reordered))).json.duplicate, true, 'JSON object key order is not a conflicting edit');
  const conflict = await call(h.service, req({ ...receipt, modeId: 'topic' }));
  assert.equal(conflict.status, 409); assert.equal(conflict.json.error, 'SESSION_CONFLICT');
  assert.equal(JSON.parse(h.stored.get(receipt.sessionId)).modeId, 'scene');
});

test('body parsing has a small cap and storage failures do not pretend success', async () => {
  const h = harness();
  assert.equal((await call(h.service, req('x'.repeat(9000)))).status, 413);
  assert.equal((await call(h.service, req('{'))).status, 400);
  assert.equal((await call(h.service, req(receipt, 'record', { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await call(h.service, req(receipt, 'record', { 'content-length': '9000' }))).status, 413);
  const streamed = req(); delete streamed.body;
  streamed[Symbol.asyncIterator] = async function* () { yield JSON.stringify(receipt); };
  assert.equal((await call(h.service, streamed)).status, 201);
  const tooLarge = req(); delete tooLarge.body;
  tooLarge[Symbol.asyncIterator] = async function* () { yield 'x'.repeat(5000); yield 'x'.repeat(5000); };
  assert.equal((await call(h.service, tooLarge)).status, 413);
  for (const appendOnce of [async () => { throw Error('secret Drive folder and token'); }, async () => ({ success: true })]) {
    const broken = harness({ storage: { ownerSubject: 'test-owner', appendOnce } });
    const result = await call(broken.service, req());
    assert.equal(result.status, 503); assert.equal(result.json.error, 'ENGLISH_STORAGE_UNAVAILABLE');
    assert(!result.body.includes('secret')); assert(!result.body.includes('recorded'));
  }
});

test('MCP authenticates initialize and exposes exactly the append-only record tool', async () => {
  const h = harness();
  const init = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1' } });
  assert.equal((await call(h.service, req(init, 'mcp', { authorization: undefined }))).status, 401);
  const initialized = await call(h.service, req(init, 'mcp'));
  assert.equal(initialized.json.result.protocolVersion, '2025-06-18');
  assert.deepEqual(initialized.json.result.capabilities, { tools: { listChanged: false } });
  const ready = await call(h.service, req({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'mcp'));
  assert.equal(ready.status, 202); assert.equal(ready.body, '');
  const listing = await call(h.service, req(rpc('tools/list'), 'mcp'));
  assert.deepEqual(listing.json.result.tools.map(tool => tool.name), ['record_practice']);
  const tool = listing.json.result.tools[0];
  assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.annotations.idempotentHint, true);
  assert(!JSON.stringify(tool).includes('folderId')); assert.equal(h.appendCalls, 0);
});

test('MCP records use the same validation and atomic dedup path as the receipt API', async () => {
  const h = harness(), message = rpc('tools/call', { name: 'record_practice', arguments: receipt });
  const result = await call(h.service, req(message, 'mcp'));
  assert.equal(result.json.result.isError, false); assert.equal(result.json.result.structuredContent.recorded, true);
  const duplicate = await call(h.service, req(message, 'mcp'));
  assert.equal(duplicate.json.result.structuredContent.duplicate, true); assert.equal(h.stored.size, 1);
  const invalid = await call(h.service, req(rpc('tools/call', { name: 'record_practice', arguments: { ...receipt, text: 'not permitted' } }), 'mcp'));
  assert.equal(invalid.json.result.isError, true); assert.equal(invalid.json.result.content[0].text, 'INVALID_PRACTICE_RECORD');
  const conflict = await call(h.service, req(rpc('tools/call', { name: 'record_practice', arguments: { ...receipt, modeId: 'free' } }), 'mcp'));
  assert.equal(conflict.json.result.isError, true); assert.equal(conflict.json.result.content[0].text, 'SESSION_CONFLICT');
});

test('MCP cannot list/read/delete files or accept batch calls and unsupported notifications', async () => {
  const h = harness();
  for (const method of ['resources/list', 'resources/read', 'files/delete', 'prompts/list']) {
    const result = await call(h.service, req(rpc(method), 'mcp')); assert.equal(result.json.error.code, -32601);
  }
  assert.equal((await call(h.service, req(rpc('tools/call', { name: 'delete_file', arguments: {} }), 'mcp'))).json.error.code, -32602);
  assert.equal((await call(h.service, req([rpc('tools/list')], 'mcp'))).json.error.code, -32600);
  assert.equal((await call(h.service, req({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'record_practice', arguments: receipt } }, 'mcp'))).status, 400);
  assert.equal((await call(h.service, req(rpc('tools/list'), 'mcp', { 'mcp-protocol-version': 'invalid' }))).status, 400);
  assert.equal(h.appendCalls, 0);
});

test('status and endpoint routing disclose no private data or arbitrary destination interface', async () => {
  const h = harness();
  const status = await call(h.service, { method: 'GET', url: '/api/english', headers: {} });
  assert.deepEqual(Object.keys(status.json).sort(), ['configured', 'recording', 'voiceIntegration']);
  assert.equal((await call(h.service, { ...req(), url: '/api/english?action=record&folderId=elsewhere' })).status, 400);
  assert.equal((await call(h.service, { ...req(), url: '/api/english?action=history' })).status, 404);
  assert.equal((await call(h.service, { ...req(), method: 'DELETE' })).status, 405);
  assert.equal((await call(h.service, { ...req(), method: 'GET', url: '/api/english?action=mcp' })).status, 405);
  assert.equal(h.appendCalls, 0);
});
