import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleDrive, loadGoogle, validateGoogleConfig, EXPECTED_FOLDER_ID, GOOGLE_PROJECT_NUMBER,
  DRIVE_SCOPE, MAX_SNAPSHOT_BYTES, MAX_UPLOAD_BYTES, SNAPSHOT_MARKER } from '../src/lib/google-drive.js';

// Synthetic public credentials and a fake bearer string. No Google SDK or API is contacted.
const CONFIG = { clientId: `${GOOGLE_PROJECT_NUMBER}-testclient.apps.googleusercontent.com`, apiKey: `AIza${'x'.repeat(35)}` };
const FOLDER = { id: EXPECTED_FOLDER_ID, name: 'My Pace', mimeType: 'application/vnd.google-apps.folder', ownedByMe: true, shared: false,
  trashed: false, capabilities: { canAddChildren: true } };
const bytes = text => new TextEncoder().encode(text).byteLength;
const file = (id = 'file_1', text = '{}', changes = {}) => ({ id, name: `mypace-${id}.json`, mimeType: 'application/json',
  size: String(bytes(text)), ownedByMe: true, shared: false, trashed: false, parents: [EXPECTED_FOLDER_ID], appProperties: { ...SNAPSHOT_MARKER }, ...changes });
const json = (value, status = 200, headers) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const code = expected => error => error.code === expected;
const dataCalls = calls => calls.filter(call => new URL(call.url).pathname !== `/drive/v3/files/${EXPECTED_FOLDER_ID}`);

function fixture(overrides = {}) {
  const calls = [], oauthConfigs = [], dialogs = [], views = [], sleeps = [], notifications = [];
  const state = { auth: { access_token: 'fake-memory-only-token', expires_in: 3600, scope: DRIVE_SCOPE },
    popupError: null, pick: { action: 'picked', docs: [{ id: EXPECTED_FOLDER_ID }] }, folder: FOLDER,
    responses: [], onFetch: null, now: 1_000_000, oauthPending: false };
  class DocsView {
    constructor(id) { this.id = id; views.push(this); }
    setIncludeFolders(value) { this.includeFolders = value; return this; }
    setSelectFolderEnabled(value) { this.selectFolderEnabled = value; return this; }
    setMimeTypes(value) { this.mimeTypes = value; return this; }
    setMode(value) { this.mode = value; return this; }
  }
  class PickerBuilder {
    addView(value) { this.view = value; return this; }
    setOAuthToken(value) { this.oauth = value; return this; }
    setDeveloperKey(value) { this.key = value; return this; }
    setAppId(value) { this.app = value; return this; }
    setOrigin(value) { this.origin = value; return this; }
    setCallback(value) { this.callback = value; return this; }
    build() {
      const builder = this;
      const dialog = { visible: false, disposed: false,
        setVisible(value) { this.visible = value; if (value && state.pick) queueMicrotask(() => builder.callback(state.pick)); },
        dispose() { this.disposed = true; } };
      dialogs.push({ builder, dialog });
      return dialog;
    }
  }
  const win = { location: { origin: 'https://example.test' }, google: {
    accounts: { oauth2: { initTokenClient(config) {
      oauthConfigs.push(config);
      return { requestAccessToken(request) {
        state.request = request;
        if (!state.oauthPending) queueMicrotask(() => state.popupError ? config.error_callback(state.popupError) : config.callback(state.auth));
      } };
    }, hasGrantedAllScopes: (response, scope) => response.scope?.split(' ').includes(scope) } },
    picker: { DocsView, PickerBuilder, ViewId: { FOLDERS: 'folders' }, DocsViewMode: { LIST: 'list' },
      Response: { ACTION: 'action', DOCUMENTS: 'docs' }, Action: { PICKED: 'picked', CANCEL: 'cancel' }, Document: { ID: 'id' } },
  } };
  const adapter = createGoogleDrive({ window: win, now: () => state.now,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (state.onFetch) return state.onFetch(url, options);
      if (new URL(url).pathname === `/drive/v3/files/${EXPECTED_FOLDER_ID}`) return json(state.folder);
      if (!state.responses.length) throw new Error('Unexpected mocked request');
      const response = state.responses.shift();
      if (response instanceof Error) throw response;
      return response;
    }, sleep: async (ms, signal) => { sleeps.push(ms); assert.equal(signal.aborted, false); }, random: () => 0,
    onDisconnect: reason => notifications.push(reason), ...overrides });
  return { adapter, state, win, calls, oauthConfigs, dialogs, views, sleeps, notifications,
    async ready() { await adapter.connect(CONFIG); await adapter.selectFolder(); calls.length = 0; } };
}

test('construction and validation make no network calls or token persistence', async () => {
  const f = fixture();
  assert.equal(f.adapter.connected, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.oauthConfigs.length, 0);
  assert.deepEqual(validateGoogleConfig(CONFIG), { ...CONFIG, projectNumber: GOOGLE_PROJECT_NUMBER, expectedFolderId: EXPECTED_FOLDER_ID });
  for (const value of [{ ...CONFIG, clientSecret: 'do-not-accept' }, { ...CONFIG, apiKey: 'GOCSPX-secret' },
    { ...CONFIG, clientId: 'another-project.apps.googleusercontent.com' }, { ...CONFIG, projectNumber: '123' },
    { ...CONFIG, expectedFolderId: 'wrong' }]) assert.throws(() => validateGoogleConfig(value), code('CONFIG'));
  await assert.rejects(f.adapter.listSnapshots(EXPECTED_FOLDER_ID), code('NOT_CONNECTED'));
});

test('OAuth starts synchronously, requests only drive.file, exposes no token, and makes no Drive calls', async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect());
  const promise = f.adapter.connect(CONFIG);
  assert.equal(f.oauthConfigs.length, 1);
  assert.deepEqual(f.state.request, { prompt: 'select_account' });
  const result = await promise;
  assert.deepEqual(result, { expiresAt: f.state.now + 3600000 });
  assert.equal(f.oauthConfigs[0].scope, DRIVE_SCOPE);
  assert.equal(f.oauthConfigs[0].include_granted_scopes, false);
  assert.equal(f.adapter.connected, true);
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.stringify(f.adapter).includes('fake-memory-only-token'), false);
  await assert.rejects(f.adapter.verifyFolder(), code('FOLDER_REQUIRED'));
  await assert.rejects(f.adapter.listSnapshots(EXPECTED_FOLDER_ID), code('FOLDER_REQUIRED'));
});

for (const [type, expected] of [['popup_closed', 'POPUP_CLOSED'], ['popup_failed_to_open', 'POPUP_BLOCKED'], ['unknown', 'AUTH_ERROR']]) {
  test(`OAuth handles ${type} without leaking Google error details`, async () => {
    const f = fixture(); f.state.popupError = { type, message: 'fake-secret-bearing-url' };
    await assert.rejects(f.adapter.connect(CONFIG), error => error.code === expected && !error.message.includes('fake-secret'));
    assert.equal(f.adapter.isConnected(), false);
  });
}
for (const scope of ['', 'openid', `${DRIVE_SCOPE} https://www.googleapis.com/auth/drive`]) {
  test(`OAuth rejects missing or broader scope ${scope || '(empty)'}`, async () => {
    const f = fixture(); f.state.auth.scope = scope;
    await assert.rejects(f.adapter.connect(CONFIG), code('SCOPE_REQUIRED'));
    assert.equal(f.adapter.isConnected(), false);
  });
}

test('OAuth denial and malformed expiry never establish a connection', async () => {
  const f = fixture(); f.state.auth = { error: 'access_denied', error_description: 'private details' };
  await assert.rejects(f.adapter.connect(CONFIG), code('AUTH_DENIED'));
  f.state.auth = { access_token: 'test', scope: DRIVE_SCOPE, expires_in: 'invalid' };
  await assert.rejects(f.adapter.connect(CONFIG), code('AUTH_RESPONSE'));
});

test('disconnect cancels pending OAuth and ignores its late success', async () => {
  const f = fixture(); f.state.oauthPending = true;
  const pending = f.adapter.connect(CONFIG);
  f.adapter.disconnect();
  await assert.rejects(pending, code('ABORTED'));
  f.oauthConfigs[0].callback(f.state.auth);
  assert.equal(f.adapter.connected, false);
});

test('auth timeout ignores a late token callback', async () => {
  const timers = [];
  const f = fixture({ setTimer: callback => { timers.push(callback); return timers.length; }, clearTimer() {} });
  f.state.oauthPending = true;
  const pending = f.adapter.connect(CONFIG); timers[0]();
  await assert.rejects(pending, code('AUTH_TIMEOUT'));
  f.oauthConfigs[0].callback(f.state.auth);
  assert.equal(f.adapter.connected, false);
});

test('connect never waits for network to load the SDK and lose user activation', async () => {
  const f = fixture(); delete f.win.google.picker;
  await assert.rejects(f.adapter.connect(CONFIG), code('SDK_NOT_READY'));
  assert.equal(f.calls.length, 0); assert.equal(f.oauthConfigs.length, 0);
});

test('Picker requires exact folder and verifies ownership/write capability', async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect());
  await f.adapter.connect(CONFIG);
  const result = await f.adapter.selectFolder();
  assert.equal(result.id, EXPECTED_FOLDER_ID);
  assert.equal(f.views[0].id, 'folders'); assert.equal(f.views[0].includeFolders, true);
  assert.equal(f.views[0].selectFolderEnabled, true); assert.equal(f.views[0].mode, 'list');
  assert.equal(f.dialogs[0].builder.app, GOOGLE_PROJECT_NUMBER);
  assert.equal(f.dialogs[0].dialog.disposed, true);
  assert.equal(f.calls.length, 1);
  assert.match(new URL(f.calls[0].url).searchParams.get('fields'), /ownedByMe/);
});

for (const [pick, expected] of [[{ action: 'cancel' }, 'PICKER_CANCELLED'], [{ action: 'picked', docs: [{ id: 'wrong' }] }, 'WRONG_FOLDER']]) {
  test(`Picker ${expected} does not read any Drive files`, async t => {
    const f = fixture(); t.after(() => f.adapter.disconnect()); f.state.pick = pick;
    await f.adapter.connect(CONFIG);
    await assert.rejects(f.adapter.selectFolder(), code(expected)); assert.equal(f.calls.length, 0);
  });
}
for (const change of [{ id: 'wrong' }, { mimeType: 'application/json' }, { ownedByMe: false }, { shared: true }, { shared: undefined }, { trashed: true }, { capabilities: { canAddChildren: false } }]) {
  test(`folder verification rejects ${JSON.stringify(change)}`, async t => {
    const f = fixture(); t.after(() => f.adapter.disconnect()); f.state.folder = { ...FOLDER, ...change };
    await f.adapter.connect(CONFIG);
    await assert.rejects(f.adapter.selectFolder(), code('FOLDER_INVALID'));
    await assert.rejects(f.adapter.listSnapshots(EXPECTED_FOLDER_ID), code('FOLDER_REQUIRED'));
  });
}

test('pagination restricts query to marker JSON files in selected folder, carries pages, never sends token in URL', async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready();
  f.state.responses.push(json({ files: [file('a')], nextPageToken: 'second' }), json({ files: [file('b')] }));
  assert.deepEqual((await f.adapter.listSnapshots(EXPECTED_FOLDER_ID)).map(item => item.id), ['a', 'b']);
  const first = new URL(f.calls[0].url), second = new URL(f.calls[1].url);
  assert.match(first.searchParams.get('q'), new RegExp(EXPECTED_FOLDER_ID));
  assert.match(first.searchParams.get('q'), /myPaceSync.*my-pace-drive-v1/);
  assert.match(first.searchParams.get('q'), /mimeType = 'application\/json'/);
  assert.equal(second.searchParams.get('pageToken'), 'second');
  for (const { url, options } of f.calls) {
    assert.equal(url.includes('fake-memory-only-token'), false);
    assert.equal(options.headers.Authorization, 'Bearer fake-memory-only-token');
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
  }
});

test('incomplete or cyclic pagination fails rather than using a partial snapshot list', async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready();
  f.state.responses.push(json({ files: [], incompleteSearch: true }));
  await assert.rejects(f.adapter.listSnapshots(EXPECTED_FOLDER_ID), code('INCOMPLETE_LIST'));
  f.state.responses.push(json({ files: [], nextPageToken: 'same' }), json({ files: [], nextPageToken: 'same' }));
  await assert.rejects(f.adapter.listSnapshots(EXPECTED_FOLDER_ID), code('INVALID_PAGINATION'));
});

for (const size of [undefined, 'invalid', '0', String(MAX_SNAPSHOT_BYTES + 1)]) {
  test(`unknown or oversized metadata (${size}) is rejected before media download`, async t => {
    const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready();
    f.state.responses.push(json(file('a', '{}', { size })));
    await assert.rejects(f.adapter.readSnapshot('a'), code('TOO_LARGE'));
    assert.equal(f.calls.length, 1); assert.equal(new URL(f.calls[0].url).searchParams.has('alt'), false);
  });
}

test('snapshot metadata cannot authorize CSV, another folder, or unmarked content', async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready();
  for (const changes of [{ mimeType: 'text/csv' }, { parents: ['wrong'] }, { appProperties: {} }, { ownedByMe: false }, { trashed: true }]) {
    f.state.responses.push(json(file('a', '{}', changes)));
    await assert.rejects(f.adapter.readSnapshot('a'), code('SNAPSHOT_INVALID'));
  }
  assert.equal(f.calls.every(call => !new URL(call.url).searchParams.has('alt')), true);
});

test('snapshot read accepts UTF-8 and validates metadata byte size', async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready(); const text = '{"日記":"朝🌿"}';
  f.state.responses.push(json(file('a', text)), new Response(text));
  assert.equal(await f.adapter.readSnapshot('a'), text);
  f.state.responses.push(json(file('a', '{}')), new Response('changed'));
  await assert.rejects(f.adapter.readSnapshot('a'), code('SNAPSHOT_CHANGED'));
});

test('stream and Content-Length limits reject oversized media', async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready();
  f.state.responses.push(json(file('a')), new Response('{}', { headers: { 'Content-Length': String(MAX_SNAPSHOT_BYTES + 1) } }));
  await assert.rejects(f.adapter.readSnapshot('a'), code('TOO_LARGE'));
  f.state.responses.push(json(file('a')), new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(MAX_SNAPSHOT_BYTES + 1)); controller.close();
  } })));
  await assert.rejects(f.adapter.readSnapshot('a'), code('TOO_LARGE'));
});

test('401 discards token, cancels session, and cannot silently reconnect', async () => {
  const f = fixture(); await f.ready(); f.state.responses.push(json({ error: {} }, 401));
  await assert.rejects(f.adapter.listSnapshots(EXPECTED_FOLDER_ID), code('UNAUTHORIZED'));
  assert.equal(f.adapter.connected, false); assert.deepEqual(f.notifications, ['unauthorized']);
  await assert.rejects(f.adapter.generateId(), code('NOT_CONNECTED'));
  assert.equal(f.calls.length, 1);
});

test('offline fetch failure is sanitized and does not retry an uncertain write', async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready();
  f.state.responses.push(new Error('https://private.example/?token=do-not-show'));
  await assert.rejects(f.adapter.generateId(), error => error.code === 'NETWORK' && !error.message.includes('private.example'));
  assert.equal(f.calls.length, 1);
});

test('429, transient 403, and 5xx use bounded backoff; permission 403 never retries', async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready();
  f.state.responses.push(json({}, 429), json({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }, 403), json({}, 503), json({ ids: ['generated_1'] }));
  assert.equal(await f.adapter.generateId(), 'generated_1'); assert.deepEqual(f.sleeps, [500, 1000, 2000]);
  f.state.responses.push(json({ error: { errors: [{ reason: 'insufficientFilePermissions' }] } }, 403));
  await assert.rejects(f.adapter.generateId(), code('FORBIDDEN')); assert.equal(f.sleeps.length, 3);
  f.state.responses.push(...Array.from({ length: 4 }, () => json({}, 429)));
  await assert.rejects(f.adapter.generateId(), code('RATE_LIMIT')); assert.equal(f.calls.length, 9);
});

test('Retry-After is respected within the bounded delay', async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready();
  f.state.responses.push(json({}, 429, { 'Retry-After': '2' }), json({ ids: ['next'] }));
  await f.adapter.generateId(); assert.deepEqual(f.sleeps, [2000]);
});

test('create uses immutable multipart POST with supplied ID and JSON marker', async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready();
  const text = '{"data":"朝"}', metadata = file('generated_1', text);
  f.state.responses.push(json(metadata));
  assert.equal((await f.adapter.createSnapshot({ id: metadata.id, folderId: EXPECTED_FOLDER_ID, name: metadata.name, text,
    appProperties: { ...SNAPSHOT_MARKER, commitId: 'commit_1' } })).id, metadata.id);
  const request = dataCalls(f.calls)[0]; assert.equal(request.options.method, 'POST');
  assert.match(request.url, /\/upload\/drive\/v3\/files\?/); assert.match(request.url, /uploadType=multipart/);
  assert.match(request.options.body, /"id":"generated_1"/); assert.match(request.options.body, /"myPaceSync":"my-pace-drive-v1"/);
  assert.match(request.options.body, new RegExp(EXPECTED_FOLDER_ID)); assert.equal(request.options.body.includes(text), true);
});

for (const match of [true, false]) {
  test(`409 ${match ? 'duplicate returns existing metadata' : 'mismatched content fails without overwriting'}`, async t => {
    const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready();
    const text = '{"x":1}', remoteText = match ? text : '{"x":2}', metadata = file('existing', remoteText);
    f.state.responses.push(json({}, 409), json(metadata), new Response(remoteText));
    const promise = f.adapter.createSnapshot({ id: 'existing', folderId: EXPECTED_FOLDER_ID, name: metadata.name, text });
    if (match) assert.deepEqual(await promise, metadata); else await assert.rejects(promise, code('CONTENT_CONFLICT'));
    assert.deepEqual(dataCalls(f.calls).map(call => call.options.method), ['POST', 'GET', 'GET']);
  });
}

test('retry after uncertain server result reuses identical body and pregenerated ID', async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready(); const metadata = file('existing');
  f.state.responses.push(json({}, 503), json({}, 409), json(metadata), new Response('{}'));
  await f.adapter.createSnapshot({ id: 'existing', folderId: EXPECTED_FOLDER_ID, name: metadata.name, text: '{}' });
  assert.equal(dataCalls(f.calls)[0].options.body, dataCalls(f.calls)[1].options.body);
  assert.deepEqual(dataCalls(f.calls).map(call => call.options.method), ['POST', 'POST', 'GET', 'GET']);
});

test('disconnect aborts in-flight fetch and token expiry requires an explicit connection', async () => {
  const f = fixture(); await f.ready(); let pendingSignal;
  f.state.onFetch = (_, options) => new Promise((resolve, reject) => {
    pendingSignal = options.signal;
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const pending = f.adapter.generateId(); f.adapter.disconnect();
  await assert.rejects(pending, code('ABORTED')); assert.equal(pendingSignal.aborted, true);
  assert.equal(f.adapter.connected, false);
  f.state.onFetch = null; await f.ready(); f.state.now += 3600001;
  assert.equal(f.adapter.connected, false); assert.equal(f.notifications.at(-1), 'expired');
});

test('disconnect closes Picker and clears its pending selection', async () => {
  const f = fixture(); await f.adapter.connect(CONFIG); f.state.pick = null;
  const pending = f.adapter.selectFolder(); f.adapter.disconnect();
  await assert.rejects(pending, code('ABORTED'));
  assert.equal(f.dialogs[0].dialog.visible, false); assert.equal(f.dialogs[0].dialog.disposed, true);
});

function fakeDocument(append) {
  const nodes = [];
  return { nodes, head: { appendChild(node) { nodes.push(node); append?.(node); } },
    createElement() { return { remove() { this.removed = true; } }; } };
}

test('explicit SDK loader loads only official scripts and then Picker without global callbacks', async () => {
  const win = {}, doc = fakeDocument(node => queueMicrotask(() => {
    if (node.src.includes('accounts.google.com')) win.google = { ...win.google, accounts: { oauth2: { initTokenClient() {} } } };
    else win.gapi = { load(name, callbacks) { assert.equal(name, 'picker'); win.google.picker = { PickerBuilder() {} }; callbacks.callback(); } };
    node.onload();
  }));
  await loadGoogle({ window: win, document: doc });
  assert.deepEqual(doc.nodes.map(node => node.src).sort(), ['https://accounts.google.com/gsi/client', 'https://apis.google.com/js/api.js']);
  assert.equal(doc.nodes.every(node => node.removed && node.onload === null && node.onerror === null), true);
  await loadGoogle({ window: win, document: doc }); assert.equal(doc.nodes.length, 2);
});

test('script cancellation cleans callbacks and rejects rather than leaving a global queue', async () => {
  const controller = new AbortController(), doc = fakeDocument();
  const pending = loadGoogle({ window: {}, document: doc, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, code('ABORTED'));
  assert.equal(doc.nodes.length, 2); assert.equal(doc.nodes.every(node => node.removed && node.onload === null), true);
});

test('failed script loads cancel the sibling and allow another explicit attempt', async () => {
  const doc = fakeDocument(); const pending = loadGoogle({ window: {}, document: doc });
  doc.nodes[0].onerror(); await assert.rejects(pending, code('SDK_LOAD'));
  assert.equal(doc.nodes.every(node => node.removed), true);
});

test('SDK timeout is bounded and cleans all script handlers', async () => {
  const timers = [], doc = fakeDocument();
  const pending = loadGoogle({ window: {}, document: doc, setTimer: callback => { timers.push(callback); return timers.length; }, clearTimer() {} });
  timers[0](); await assert.rejects(pending, code('SDK_TIMEOUT'));
  assert.equal(doc.nodes.every(node => node.removed && node.onerror === null), true);
});

test('disconnect interrupts backoff before any retry', async () => {
  let delayStarted;
  const started = new Promise(resolve => { delayStarted = resolve; });
  const f = fixture({ sleep: (_, signal) => new Promise((resolve, reject) => {
    delayStarted(); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) });
  await f.ready(); f.state.responses.push(json({}, 429));
  const pending = f.adapter.generateId(); await started; f.adapter.disconnect();
  await assert.rejects(pending); assert.equal(f.calls.length, 1); assert.equal(f.adapter.connected, false);
});

test('request timeout aborts network without exposing request URLs', async t => {
  const scheduled = new Map(); let nextId = 0;
  const f = fixture({ setTimer(callback, ms) { scheduled.set(++nextId, { callback, ms }); return nextId; }, clearTimer(id) { scheduled.delete(id); } });
  t.after(() => f.adapter.disconnect()); await f.ready();
  f.state.onFetch = (_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('request token secret')), { once: true }));
  const pending = f.adapter.generateId();
  [...scheduled.values()].find(timer => timer.ms === 30000).callback();
  await assert.rejects(pending, error => error.code === 'NETWORK_TIMEOUT' && !error.message.includes('secret'));
});

test('successful token expiry timer disconnects immediately without needing another API call', async () => {
  const scheduled = new Map(); let nextId = 0;
  const f = fixture({ setTimer(callback, ms) { scheduled.set(++nextId, { callback, ms }); return nextId; }, clearTimer(id) { scheduled.delete(id); } });
  await f.adapter.connect(CONFIG);
  [...scheduled.values()].find(timer => timer.ms === 3600000).callback();
  assert.equal(f.adapter.connected, false); assert.deepEqual(f.notifications, ['expired']);
});


test('cloud multipart limit is exactly 5,000,000 UTF-8 bytes and oversize makes no upload request', async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready();
  assert.equal(MAX_UPLOAD_BYTES, 5_000_000);
  const text = 'x'.repeat(MAX_UPLOAD_BYTES), metadata = file('boundary', text);
  f.state.responses.push(json(metadata));
  await f.adapter.createSnapshot({ id: 'boundary', folderId: EXPECTED_FOLDER_ID, name: metadata.name, text });
  assert.equal(dataCalls(f.calls).length, 1); f.calls.length = 0;
  await assert.rejects(f.adapter.createSnapshot({ id: 'too_large', folderId: EXPECTED_FOLDER_ID, name: 'large.json', text: text + 'a' }), code('UPLOAD_TOO_LARGE'));
  await assert.rejects(f.adapter.createSnapshot({ id: 'too_large', folderId: EXPECTED_FOLDER_ID, name: 'large.json', text: 'あ'.repeat(Math.ceil(MAX_UPLOAD_BYTES / 3)) }), code('UPLOAD_TOO_LARGE'));
  assert.equal(f.calls.length, 0);
});


test('upload retains graph chunks and accepts 30 bounded private properties', async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready();
  const properties = { ...SNAPSHOT_MARKER, datasetId: 'dataset', commitId: 'commit', stateHash: 'a'.repeat(64), parentParts: '24' };
  for (let i = 0; i < 24; i++) properties[`p${String(i).padStart(2, '0')}`] = 'x'.repeat(120);
  properties.extra = 'allowed-thirtieth-property';
  assert.equal(Object.keys(properties).length, 30);
  const metadata = file('graph', '{}', { appProperties: properties });
  f.state.responses.push(json(metadata));
  await f.adapter.createSnapshot({ id: 'graph', folderId: EXPECTED_FOLDER_ID, name: metadata.name, text: '{}', appProperties: properties });
  for (const [key, value] of Object.entries(properties)) assert.equal(dataCalls(f.calls)[0].options.body.includes(JSON.stringify(key) + ':' + JSON.stringify(value)), true);
  f.calls.length = 0;
  await assert.rejects(f.adapter.createSnapshot({ id: 'graph', folderId: EXPECTED_FOLDER_ID, name: metadata.name, text: '{}', appProperties: { ...properties, extra31: 'rejected' } }), code('SNAPSHOT_INVALID'));
  assert.equal(f.calls.length, 0);
});

test('property combined key+value UTF-8 limit is 124 bytes, including multibyte text', async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready();
  const metadata = file('property_boundary');
  f.state.responses.push(json(metadata));
  await f.adapter.createSnapshot({ id: metadata.id, folderId: EXPECTED_FOLDER_ID, name: metadata.name, text: '{}', appProperties: { p00: 'x'.repeat(121) } });
  f.calls.length = 0;
  for (const properties of [{ p00: 'x'.repeat(122) }, { p00: 'あ'.repeat(41) }, { constructor: 'blocked' }]) {
    await assert.rejects(f.adapter.createSnapshot({ id: metadata.id, folderId: EXPECTED_FOLDER_ID, name: metadata.name, text: '{}', appProperties: properties }), code('SNAPSHOT_INVALID'));
  }
  assert.equal(f.calls.length, 0);
});

for (const change of ['extra', 'missing', 'different']) test(`409 rejects ${change} graph properties even when body matches`, async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready();
  const properties = { ...SNAPSHOT_MARKER, stateHash: 'a'.repeat(64), parentParts: '1', p00: '["parent"]' };
  const remoteProperties = { ...properties };
  if (change === 'extra') remoteProperties.p01 = 'unexpected';
  if (change === 'missing') delete remoteProperties.p00;
  if (change === 'different') remoteProperties.p00 = '["different"]';
  const metadata = file('same_body', '{}', { appProperties: remoteProperties });
  f.state.responses.push(json({}, 409), json(metadata));
  await assert.rejects(f.adapter.createSnapshot({ id: metadata.id, folderId: EXPECTED_FOLDER_ID, name: metadata.name, text: '{}', appProperties: properties }), code('CONTENT_CONFLICT'));
  assert.deepEqual(dataCalls(f.calls).map(call => call.options.method), ['POST', 'GET']);
});


for (const change of [{ shared: true }, { shared: undefined }, { ownedByMe: false }, { capabilities: { canAddChildren: false } }]) {
  test(`changed folder access blocks snapshot POST: ${JSON.stringify(change)}`, async t => {
    const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready();
    f.state.folder = { ...FOLDER, ...change };
    await assert.rejects(f.adapter.createSnapshot({ id: 'private_only', folderId: EXPECTED_FOLDER_ID, name: 'private.json', text: '{}' }), code('FOLDER_INVALID'));
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.method, 'GET');
    assert.match(new URL(f.calls[0].url).searchParams.get('fields'), /shared/);
    assert.equal(dataCalls(f.calls).length, 0);
  });
}

test('each upload retry rechecks folder sharing before repeating the POST', async t => {
  const f = fixture({ sleep: async () => { f.state.folder = { ...FOLDER, shared: true }; } });
  t.after(() => f.adapter.disconnect()); await f.ready(); f.state.responses.push(json({}, 503));
  await assert.rejects(f.adapter.createSnapshot({ id: 'private_only', folderId: EXPECTED_FOLDER_ID, name: 'private.json', text: '{}' }), code('FOLDER_INVALID'));
  assert.deepEqual(f.calls.map(call => call.options.method), ['GET', 'POST', 'GET']);
});

test('private folder is reverified immediately before successful upload', async t => {
  const f = fixture(); t.after(() => f.adapter.disconnect()); await f.ready();
  const metadata = file('private'); f.state.responses.push(json(metadata));
  await f.adapter.createSnapshot({ id: metadata.id, folderId: EXPECTED_FOLDER_ID, name: metadata.name, text: '{}' });
  assert.deepEqual(f.calls.map(call => call.options.method), ['GET', 'POST']);
  assert.equal(new URL(f.calls[0].url).pathname, `/drive/v3/files/${EXPECTED_FOLDER_ID}`);
});
