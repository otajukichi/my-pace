import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { configuration, createDriveService, seal, unseal } from '../server/drive-auth.js';

const env = { MYPACE_ORIGIN: 'https://mypace.example', GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', MYPACE_SESSION_SECRET: 'synthetic-session-secret-32-characters-long', MYPACE_ROOT_FOLDER_ID: 'synthetic-root' };
function response() {
  return { headers: {}, status: 0, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body = '') { this.body = body; } };
}
function cookies(res) { return res.headers['Set-Cookie'].map(c => c.split(';')[0]).join('; '); }
function harness() {
  const reads = [], catalog = JSON.stringify({ schema: 1, kind: 'catalog', years: {}, latest: null });
  const object = JSON.stringify({ schema: 1, kind: 'month', month: '2026-01', runs: [] }) + '\n', digest = createHash('sha256').update(object).digest('hex');
  const config = { ...env }, entries = new Map();
  const folder = (id, name, parent) => ({ id, name, parents: [parent], ownedByMe: true, shared: false, trashed: false, mimeType: 'application/vnd.google-apps.folder' });
  entries.set('synthetic-root', folder('synthetic-root', 'MyPace', 'my-drive'));
  entries.set('synthetic-running', folder('synthetic-running', 'running', 'synthetic-root'));
  entries.set('synthetic-derived', folder('synthetic-derived', 'derived', 'synthetic-running'));
  for (const [id, name] of [['catalog', 'index.json'], ['object', digest + '.json']]) entries.set(id, { ...folder(id, name, 'synthetic-derived'), size: '100', mimeType: 'application/json' });
  // Same names elsewhere must never be read, including a catalog at the root.
  entries.set('outside-derived', folder('outside-derived', 'derived', 'elsewhere'));
  entries.set('root-catalog', { ...entries.get('catalog'), id: 'root-catalog', parents: ['synthetic-root'] });
  let authOptions, corrupt = false, refreshed = 0, failRefresh = false, duplicate = false, futureExpiry = Date.now() + 3600000, listing = result => result;
  const oauth = {
    async generateCodeVerifierAsync() { return { codeVerifier: 'verifier', codeChallenge: 'challenge' }; },
    generateAuthUrl(options) { authOptions = options; return 'https://accounts.google.com/o/oauth2/v2/auth?state=' + options.state; },
    async getToken(options) { assert.equal(options.codeVerifier, 'verifier'); return { tokens: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', id_token: 'synthetic-id', expiry_date: futureExpiry } }; },
    async verifyIdToken(options) { assert.equal(options.audience, env.GOOGLE_CLIENT_ID); return { getPayload: () => ({ nonce: authOptions.nonce, email_verified: true, sub: 'synthetic-sub' }) }; },
    setCredentials() {}, async refreshAccessToken() { refreshed++; if (failRefresh) throw Error('private provider details'); return { credentials: { access_token: 'refreshed', expiry_date: Date.now() + 3600000 } }; },
  };
  const service = createDriveService({ env: config, oauthFactory: () => oauth, fetchImpl: async (url, options) => {
    reads.push({ path: url.pathname, query: url.searchParams, token: options.headers.Authorization });
    assert.equal(url.origin, 'https://www.googleapis.com');
    if (url.pathname.endsWith('/files')) {
      const query = url.searchParams.get('q').match(/^'([\w-]+)' in parents and name = '([\w.-]+)' and trashed = false$/);
      assert(query, 'Every list query must specify a parent and exact filename');
      const [, parent, name] = query;
      const files = [...entries.values()].filter(f => f.parents.includes(parent) && f.name === name && !f.trashed);
      if (duplicate && name.endsWith('.json')) files.push(...files);
      return Response.json(listing({ files }, name));
    }
    const id = url.pathname.split('/').at(-1);
    if (!url.searchParams.has('alt')) return entries.has(id) ? Response.json(entries.get(id)) : new Response('', { status: 404 });
    assert.equal(url.searchParams.get('alt'), 'media');
    assert(['catalog', 'object'].includes(id), 'Only authorized prepared files may reach media');
    return new Response(url.pathname.endsWith('/catalog') ? catalog : corrupt ? '{}' : object);
  } });
  async function login({ badState = false } = {}) {
    const start = response(); await service.auth({ method: 'GET', url: '/api/google-auth?start=1', headers: {} }, start);
    const done = response(); await service.auth({ method: 'GET', url: '/api/google-auth?code=synthetic-code&state=' + (badState ? 'wrong' : authOptions.state), headers: { cookie: cookies(start) } }, done);
    return done;
  }
  async function read(cookie, path = 'index.json', origin = env.MYPACE_ORIGIN) {
    const res = response(); await service.artifact({ method: 'POST', url: '/api/running-drive', headers: { origin, cookie, 'content-type': 'application/json' }, body: { path } }, res); return res;
  }
  return { service, login, read, reads, digest, catalog, config, entries, set listing(x) { listing = x; }, get refreshed() { return refreshed; }, get options() { return authOptions; }, set owned(x) { entries.get('synthetic-root').ownedByMe = x; }, set shared(x) { entries.get('synthetic-root').shared = x; }, set corrupt(x) { corrupt = x; }, set duplicate(x) { duplicate = x; }, set futureExpiry(x) { futureExpiry = x; }, set failRefresh(x) { failRefresh = x; } };
}
test('encrypted session rejects tampering, expiry and different cookie purpose', () => {
  const v = { expires: Date.now() + 60000, token: 'not-in-plaintext' }, token = seal(v, env.MYPACE_SESSION_SECRET, 'session');
  assert.deepEqual(unseal(token, env.MYPACE_SESSION_SECRET, 'session'), v);
  assert(!token.includes(v.token)); assert.equal(unseal(token, env.MYPACE_SESSION_SECRET, 'oauth'), null);
  assert.equal(unseal(token.slice(0, -10) + 'aaaaaaaaaa', env.MYPACE_SESSION_SECRET, 'session'), null);
  assert.equal(unseal(seal({ expires: 0 }, env.MYPACE_SESSION_SECRET, 'session'), env.MYPACE_SESSION_SECRET, 'session'), null);
});
test('OAuth uses PKCE/state/nonce and private folder ownership; browser gets no tokens', async () => {
  const h = harness(), alias = response();
  await h.service.auth({method:'GET',url:'/api/google-auth?start=1',headers:{host:'preview.example'}},alias);
  assert.equal(alias.headers.Location,env.MYPACE_ORIGIN+'/api/google-auth?start=1');assert(!alias.headers['Set-Cookie']);
  const done = await h.login();
  assert.equal(done.status, 303); assert.equal(done.headers.Location, env.MYPACE_ORIGIN + '/#records');
  assert.deepEqual(h.options.scope, ['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly']); assert.equal(h.options.code_challenge_method, 'S256');
  assert.match(cookies(done), /__Host-mypace-session=/); assert(!cookies(done).includes('synthetic-access'));
  assert(done.headers['Set-Cookie'].every(c => c.includes('HttpOnly') && c.includes('SameSite=Lax') && c.includes('Secure')));
  const status = response(); await h.service.auth({ method: 'GET', url: '/api/google-auth', headers: { cookie: cookies(done) } }, status);
  assert.deepEqual(JSON.parse(status.body), { configured: true, authenticated: true });
  const bad = harness(); const denied = await bad.login({ badState: true }); assert.equal(bad.reads.length, 0); assert(!cookies(denied).includes('mypace-session='));
  for (const mode of ['owned', 'shared']) { const h = harness(); h[mode] = mode === 'shared'; const r = await h.login(); assert.match(r.headers.Location, /OWNER_ONLY/); assert(!cookies(r).includes('mypace-session=')); }
});
test('unauthenticated, cross-origin, CSV and arbitrary Drive IDs cannot reach media', async () => {
  const h = harness(); assert.equal((await h.read('')).status, 401); assert.equal(h.reads.length, 0);
  const login = await h.login(), cookie = cookies(login); h.reads.length = 0;
  assert.equal((await h.read(cookie, 'index.json', 'https://elsewhere.example')).status, 403);
  for (const path of ['private.csv', '../index.json', 'drive-id', 'objects/not-a-hash.json']) assert.equal((await h.read(cookie, path)).status, 400);
  assert.equal(h.reads.length, 0);
  const r = await h.read(cookie); assert.equal(r.status, 200); assert.equal(r.body, h.catalog);
  assert.match(r.headers['Cache-Control'], /private, no-store/); assert.equal(r.headers['Vercel-CDN-Cache-Control'], 'no-store');
  assert.equal(h.reads.filter(r => r.query.get('alt') === 'media').length, 1);
  assert.equal(h.reads.length, 5, 'root + two folder lookups + file metadata + small JSON');
  assert.deepEqual(h.reads.filter(r => r.query.has('q')).map(r => r.query.get('q')), [
    "'synthetic-root' in parents and name = 'running' and trashed = false",
    "'synthetic-running' in parents and name = 'derived' and trashed = false",
    "'synthetic-derived' in parents and name = 'index.json' and trashed = false",
  ]);
});
test('expired access token refreshes, immutable objects verify, errors hide provider details', async () => {
  const h = harness(); h.futureExpiry = 0; const cookie = cookies(await h.login());
  const path = `objects/${h.digest}.json`, ok = await h.read(cookie, path); assert.equal(ok.status, 200); assert.equal(h.refreshed, 1);
  h.corrupt = true; assert.equal((await h.read(cookie, path)).status, 422);
  h.failRefresh = true; const failed = await h.read(cookie); assert.equal(failed.status, 401); assert(!failed.body.includes('private provider details'));
});
test('changed sharing and duplicate filenames fail closed; logout expires the browser cookie', async () => {
  const h = harness(), cookie = cookies(await h.login());
  h.shared = true; assert.equal((await h.read(cookie)).status, 403);
  h.shared = false; h.duplicate = true; assert.equal((await h.read(cookie)).status, 422);
  const res = response(); await h.service.auth({ method: 'POST', url: '/api/google-auth', headers: { cookie, origin: env.MYPACE_ORIGIN, 'content-type': 'application/json' }, body: { action: 'logout' } }, res);
  assert.equal(res.status, 200); assert(res.headers['Set-Cookie'][0].includes('Max-Age=0'));
});
test('unconfigured deployment keeps private APIs closed', async () => {
  const service = createDriveService({ env: {} }), r = response(); await service.auth({ method: 'GET', url: '/api/google-auth', headers: {} }, r);
  assert.equal(r.status, 503); assert.equal(JSON.parse(r.body).configured, false);
});
test('root configuration replaces the derived ID; old cookies and changed roots require login', async () => {
  const legacy = { ...env, MYPACE_ROOT_FOLDER_ID: '', MYPACE_DRIVE_FOLDER_ID: 'synthetic-derived' };
  assert.equal(configuration(legacy), null, 'Never silently reinterpret an old derived ID as a root');
  assert.equal(configuration({ ...env, MYPACE_DRIVE_FOLDER_ID: 'ignored-old-folder' }).rootFolder, env.MYPACE_ROOT_FOLDER_ID);
  assert.throws(() => configuration({ ...env, MYPACE_ROOT_FOLDER_ID: "invalid'folder" }), /CONFIGURATION/);
  const h = harness(), cookie = cookies(await h.login()); h.reads.length = 0;
  h.config.MYPACE_ROOT_FOLDER_ID = 'replacement-root';
  assert.equal((await h.read(cookie)).status, 401); assert.equal(h.reads.length, 0);
  h.config.MYPACE_ROOT_FOLDER_ID = env.MYPACE_ROOT_FOLDER_ID;
  for (const prefix of [[], ['root-v1']]) {
    const legacyContext = createHash('sha256').update([...prefix, env.MYPACE_ORIGIN, env.GOOGLE_CLIENT_ID, env.MYPACE_ROOT_FOLDER_ID, 'new-csv-index.json'].join('\n')).digest('hex');
    const old = '__Host-mypace-session=' + seal({ expires: Date.now() + 60000, context: legacyContext }, env.MYPACE_SESSION_SECRET, 'session');
    assert.equal((await h.read(old)).status, 401); assert.equal(h.reads.length, 0);
  }
});
test('catalog is always index.json, regardless of retired settings or experiment files', async () => {
  const h = harness(), cookie = cookies(await h.login());
  h.entries.set('experiment', { ...h.entries.get('catalog'), id: 'experiment', name: 'new-csv-index.json' });
  for (const retiredValue of ['new-csv-index.json', 'other-index.json', "../invalid'path"]) {
    h.config.MYPACE_DRIVE_CATALOG = retiredValue;
    assert.deepEqual(configuration(h.config), configuration(env));
    h.reads.length = 0;
    assert.equal((await h.read(cookie)).body, h.catalog);
    assert(h.reads.some(r => r.query.get('q') === "'synthetic-derived' in parents and name = 'index.json' and trashed = false"));
    assert.equal(h.reads.filter(r => r.query.get('alt') === 'media').length, 1);
  }
  h.reads.length = 0;
  assert.equal((await h.read(cookie, 'new-csv-index.json')).status, 400);
  assert.equal(h.reads.length, 0);
  h.entries.delete('catalog');
  assert.equal((await h.read(cookie)).status, 422, 'Missing index must not fall back to a test catalog');
  assert(!h.reads.some(r => r.query.get('alt') === 'media'));
});
test('every folder must remain private and owned; incomplete metadata and shortcuts fail closed', async () => {
  for (const id of ['synthetic-root', 'synthetic-running', 'synthetic-derived']) {
    for (const patch of [{ ownedByMe: false }, { shared: true }, { shared: undefined }, { trashed: true }, { mimeType: 'application/vnd.google-apps.shortcut' }]) {
      const h = harness(), cookie = cookies(await h.login());
      assert.equal((await h.read(cookie)).status, 200);
      Object.assign(h.entries.get(id), patch); h.reads.length = 0;
      const res = await h.read(cookie);
      assert([403, 422].includes(res.status), `${id}: ${JSON.stringify(patch)}`);
      assert(!h.reads.some(r => r.query.get('alt') === 'media'), `${id} must block content reads immediately`);
      assert(!res.body.includes(id), 'Do not disclose Drive IDs');
    }
  }
});
test('missing, renamed, moved or duplicate feature folders never fall back to an old ID or another location', async () => {
  for (const id of ['synthetic-running', 'synthetic-derived']) {
    for (const change of ['delete', 'rename', 'move', 'duplicate']) {
      const h = harness(), cookie = cookies(await h.login());
      assert.equal((await h.read(cookie)).status, 200);
      const f = h.entries.get(id);
      if (change === 'delete') h.entries.delete(id);
      if (change === 'rename') f.name += '-old';
      if (change === 'move') f.parents = ['elsewhere'];
      if (change === 'duplicate') h.entries.set('duplicate-folder', { ...f, id: 'duplicate-folder' });
      h.reads.length = 0; const res = await h.read(cookie);
      assert.equal(JSON.parse(res.body).error.code, change === 'duplicate' ? 'DRIVE_FOLDER_AMBIGUOUS' : 'DRIVE_FOLDER_MISSING', `${id}: ${change}`);
      assert(!h.reads.some(r => r.query.get('alt') === 'media'));
    }
  }
  const h = harness(); h.entries.delete('synthetic-running');
  assert.equal((await h.login()).headers.Location, env.MYPACE_ORIGIN + '/#records', 'Account login belongs to MyPace, independent of individual features');
});
test('ambiguous or stale Drive list metadata cannot authorize an out-of-tree file', async () => {
  for (const name of ['running', 'derived', 'index.json']) {
    for (const change of ['pagination', 'incomplete', 'parent', 'name']) {
      const h = harness(), cookie = cookies(await h.login()); h.reads.length = 0;
      h.listing = (result, queriedName) => {
        if (name !== queriedName) return result;
        if (change === 'pagination') return { ...result, nextPageToken: 'another-page' };
        if (change === 'incomplete') return { ...result, incompleteSearch: true };
        return { files: result.files.map(f => ({ ...f, ...(change === 'parent' ? { parents: ['elsewhere'] } : { name: 'unexpected' }) })) };
      };
      assert.equal((await h.read(cookie)).status, 422, `${name}: ${change}`);
      assert(!h.reads.some(r => r.query.get('alt') === 'media'));
    }
  }
});
test('a prepared file must itself be private, owned and in derived, with a bounded size', async () => {
  for (const patch of [{ ownedByMe: false }, { shared: true }, { trashed: true }, { mimeType: 'application/vnd.google-apps.shortcut' }, { size: '131073' }, { parents: ['elsewhere'] }]) {
    const h = harness(), cookie = cookies(await h.login());
    Object.assign(h.entries.get('catalog'), patch); h.reads.length = 0;
    assert.equal((await h.read(cookie)).status, 422, JSON.stringify(patch));
    assert(!h.reads.some(r => r.query.get('alt') === 'media'));
  }
});
