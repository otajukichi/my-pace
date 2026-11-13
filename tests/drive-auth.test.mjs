import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDriveService, seal, unseal } from '../server/drive-auth.js';

const env = { MYPACE_ORIGIN: 'https://mypace.example', GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', MYPACE_SESSION_SECRET: 'synthetic-session-secret-32-characters-long', MYPACE_DRIVE_FOLDER_ID: 'synthetic-folder' };
function response() {
  return { headers: {}, status: 0, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body = '') { this.body = body; } };
}
function cookies(res) { return res.headers['Set-Cookie'].map(c => c.split(';')[0]).join('; '); }
function harness() {
  const reads = [], catalog = JSON.stringify({ schema: 1, kind: 'catalog', years: {}, latest: null });
  const object = JSON.stringify({ schema: 1, kind: 'month', month: '2026-01', runs: [] }) + '\n', digest = createHash('sha256').update(object).digest('hex');
  let authOptions, owned = true, shared = false, corrupt = false, refreshed = 0, failRefresh = false, duplicate = false, futureExpiry = Date.now() + 3600000;
  const oauth = {
    async generateCodeVerifierAsync() { return { codeVerifier: 'verifier', codeChallenge: 'challenge' }; },
    generateAuthUrl(options) { authOptions = options; return 'https://accounts.google.com/o/oauth2/v2/auth?state=' + options.state; },
    async getToken(options) { assert.equal(options.codeVerifier, 'verifier'); return { tokens: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', id_token: 'synthetic-id', expiry_date: futureExpiry } }; },
    async verifyIdToken(options) { assert.equal(options.audience, env.GOOGLE_CLIENT_ID); return { getPayload: () => ({ nonce: authOptions.nonce, email_verified: true, sub: 'synthetic-sub' }) }; },
    setCredentials() {}, async refreshAccessToken() { refreshed++; if (failRefresh) throw Error('private provider details'); return { credentials: { access_token: 'refreshed', expiry_date: Date.now() + 3600000 } }; },
  };
  const service = createDriveService({ env, oauthFactory: () => oauth, fetchImpl: async (url, options) => {
    reads.push({ path: url.pathname, query: url.searchParams, token: options.headers.Authorization });
    if (url.pathname.endsWith('/synthetic-folder')) return Response.json({ ownedByMe: owned, shared, trashed: false, mimeType: 'application/vnd.google-apps.folder' });
    if (url.pathname.endsWith('/files')) {
      const f = { id: url.searchParams.get('q').includes('new-csv-index.json') ? 'catalog' : 'object', size: '100', ownedByMe: owned, shared, mimeType: 'application/json' };
      return Response.json({ files: duplicate ? [f, f] : [f] });
    }
    assert.equal(url.searchParams.get('alt'), 'media');
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
  return { service, login, read, reads, digest, catalog, get refreshed() { return refreshed; }, get options() { return authOptions; }, set owned(x) { owned = x; }, set shared(x) { shared = x; }, set corrupt(x) { corrupt = x; }, set duplicate(x) { duplicate = x; }, set futureExpiry(x) { futureExpiry = x; }, set failRefresh(x) { failRefresh = x; } };
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
  assert.equal(done.status, 303); assert.equal(done.headers.Location, env.MYPACE_ORIGIN + '/?source=drive#records');
  assert(h.options.scope.includes('https://www.googleapis.com/auth/drive.readonly')); assert.equal(h.options.code_challenge_method, 'S256');
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
  assert(h.reads.some(r => r.query.get('q')?.includes("'synthetic-folder' in parents")));
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
