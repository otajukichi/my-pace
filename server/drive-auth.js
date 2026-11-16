import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

const MAX_BYTES = 131072;
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly'];
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_FIELDS = 'id,name,mimeType,ownedByMe,shared,trashed,parents';
// Paths belong to server-side features, never to a browser-supplied Drive ID/path.
const RUNNING_FOLDERS = ['running', 'derived'];
export class AccessError extends Error {
  constructor(code, status = 403) { super(code); this.code = code; this.status = status; }
}
export function configuration(env = process.env) {
  const origin = env.MYPACE_ORIGIN;
  if (!origin || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.MYPACE_SESSION_SECRET || !env.MYPACE_ROOT_FOLDER_ID) return null;
  const url = new URL(origin);
  if (url.origin !== origin || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new AccessError('CONFIGURATION', 503);
  if (env.MYPACE_SESSION_SECRET.length < 32 || !/^[\w-]+$/.test(env.MYPACE_ROOT_FOLDER_ID)) throw new AccessError('CONFIGURATION', 503);
  const catalog = env.MYPACE_DRIVE_CATALOG || 'new-csv-index.json';
  if (!/^[a-z0-9-]+\.json$/.test(catalog)) throw new AccessError('CONFIGURATION', 503);
  return { origin, rootFolder: env.MYPACE_ROOT_FOLDER_ID, catalog, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET,
    secret: env.MYPACE_SESSION_SECRET, secure: url.protocol === 'https:' };
}
export function seal(value, secret, purpose) {
  const iv = randomBytes(12), key = createHash('sha256').update(secret).digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(purpose));
  return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64url');
}
export function unseal(token, secret, purpose) {
  try {
    if (!token || token.length > 3800) return null;
    const raw = Buffer.from(token, 'base64url'), decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(purpose)); decipher.setAuthTag(raw.subarray(-16));
    const value = JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]));
    return value.expires > Date.now() ? value : null;
  } catch { return null; }
}
function name(c, purpose) { return `${c.secure ? '__Host-' : ''}mypace-${purpose}`; }
function readCookie(req, c, purpose) {
  const prefix = name(c, purpose) + '=';
  const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(prefix))?.slice(prefix.length);
  return unseal(token, c.secret, purpose);
}
function cookie(res, c, purpose, value) {
  const token = value ? seal(value, c.secret, purpose) : '';
  if (token.length > 3700) throw new AccessError('SESSION_TOO_LARGE', 503);
  const prior = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...(Array.isArray(prior) ? prior : [prior]), `${name(c, purpose)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value ? Math.max(0, Math.floor((value.expires - Date.now()) / 1000)) : 0}${c.secure ? '; Secure' : ''}`]);
}
function context(c) { return createHash('sha256').update(['root-v1', c.origin, c.clientId, c.rootFolder, c.catalog].join('\n')).digest('hex'); }
function equal(a, b) { return typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
export function privateHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Vary', 'Cookie');
}
export function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function redirect(res, url) { res.writeHead(303, { Location: url }); res.end(); }
function sameOrigin(req, c) { if (req.headers.origin !== c.origin) throw new AccessError('ORIGIN'); }
export async function jsonBody(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new AccessError('BODY', 400);
  if (req.body !== undefined) {
    if (Buffer.byteLength(typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) > 512) throw new AccessError('BODY', 400);
    try { return typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch { throw new AccessError('BODY', 400); }
  }
  let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 512) throw new AccessError('BODY', 400); }
  try { return JSON.parse(body); } catch { throw new AccessError('BODY', 400); }
}
export function createDriveService({ env = process.env, fetchImpl = fetch, oauthFactory = c => new OAuth2Client(c.clientId, c.clientSecret, c.origin + '/api/google-auth') } = {}) {
  async function drive(token, path, params = {}, raw = false) {
    const url = new URL('https://www.googleapis.com/drive/v3/' + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new AccessError(r.status === 401 ? 'SIGN_IN' : r.status === 403 || r.status === 404 ? 'DRIVE_ACCESS' : 'DRIVE_UNAVAILABLE', r.status === 401 ? 401 : 503);
    // Prepared objects are bounded even if Drive metadata is stale.
    let length = 0; const chunks = [];
    for await (const part of r.body) { const b = Buffer.from(part); length += b.length; if (length > MAX_BYTES) throw new AccessError('DISPLAY_TOO_LARGE', 422); chunks.push(b); }
    const text = Buffer.concat(chunks).toString('utf8');
    try { return raw ? text : JSON.parse(text); } catch { throw new AccessError('DISPLAY_INVALID', 422); }
  }
  function privateFolder(f) {
    if (f.ownedByMe !== true || f.shared !== false) throw new AccessError('OWNER_ONLY');
    if (!/^[\w-]+$/.test(f.id || '') || f.trashed !== false || f.mimeType !== FOLDER_MIME) throw new AccessError('DRIVE_FOLDER_LAYOUT', 422);
    return f.id;
  }
  async function rootFolder(c, token) {
    const f = await drive(token, `files/${c.rootFolder}`, { fields: FOLDER_FIELDS });
    if (f.id !== c.rootFolder) throw new AccessError('DRIVE_FOLDER_LAYOUT', 422);
    return privateFolder(f);
  }
  async function runningFolder(c, token) {
    let parent = await rootFolder(c, token);
    // Two narrow metadata queries, not a recursive Drive scan. Resolve afresh so
    // renames, moves and sharing changes cannot leave an authorized ID cached.
    for (const child of RUNNING_FOLDERS) {
      const result = await drive(token, 'files', {
        q: `'${parent}' in parents and name = '${child}' and trashed = false`,
        fields: `files(${FOLDER_FIELDS}),nextPageToken,incompleteSearch`, pageSize: '2', spaces: 'drive',
      });
      if (result.incompleteSearch || result.nextPageToken || result.files?.length > 1) throw new AccessError('DRIVE_FOLDER_AMBIGUOUS', 422);
      if (result.files?.length !== 1) throw new AccessError('DRIVE_FOLDER_MISSING', 422);
      const f = result.files[0];
      if (f.name !== child || f.parents?.length !== 1 || f.parents[0] !== parent) throw new AccessError('DRIVE_FOLDER_LAYOUT', 422);
      parent = privateFolder(f);
    }
    return parent;
  }
  async function session(req, res, c) {
    const s = readCookie(req, c, 'session');
    if (!s || s.context !== context(c)) throw new AccessError('SIGN_IN', 401);
    if (s.tokenExpires < Date.now() + 60000) {
      try {
        const client = oauthFactory(c); client.setCredentials({ refresh_token: s.refresh });
        const { credentials } = await client.refreshAccessToken();
        s.access = credentials.access_token; s.tokenExpires = credentials.expiry_date;
        if (credentials.refresh_token) s.refresh = credentials.refresh_token;
        cookie(res, c, 'session', s);
      } catch { cookie(res, c, 'session', null); throw new AccessError('SIGN_IN', 401); }
    }
    return s;
  }
  async function auth(req, res) {
    privateHeaders(res);
    let c;
    try {
      c = configuration(env);
      const url = new URL(req.url, c?.origin || 'http://localhost');
      if (!c) return send(res, 503, { configured: false, authenticated: false, error: { code: 'NOT_CONFIGURED' } });
      if (req.method === 'POST') {
        sameOrigin(req, c); const b = await jsonBody(req);
        if (b?.action !== 'logout') throw new AccessError('BODY', 400);
        cookie(res, c, 'session', null); return send(res, 200, { authenticated: false });
      }
      if (req.method !== 'GET') throw new AccessError('METHOD', 405);
      if (url.searchParams.has('start')) {
        // Issue the state cookie on the same host used by Google's callback.
        if (req.headers.host && req.headers.host !== new URL(c.origin).host) return redirect(res, c.origin + '/api/google-auth?start=1');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new AccessError('ORIGIN');
        const client = oauthFactory(c), { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
        const state = randomBytes(24).toString('base64url'), nonce = randomBytes(24).toString('base64url');
        cookie(res, c, 'oauth', { state, nonce, verifier: codeVerifier, expires: Date.now() + 10 * 60000 });
        return redirect(res, client.generateAuthUrl({ scope: SCOPES, access_type: 'offline', prompt: 'consent', state, nonce, code_challenge: codeChallenge, code_challenge_method: 'S256' }));
      }
      if (url.searchParams.has('code') || url.searchParams.has('error')) {
        const pending = readCookie(req, c, 'oauth'); cookie(res, c, 'oauth', null);
        if (!pending || !equal(pending.state, url.searchParams.get('state')) || url.searchParams.has('error')) throw new AccessError('SIGN_IN_CANCELLED', 401);
        const client = oauthFactory(c);
        const { tokens } = await client.getToken({ code: url.searchParams.get('code'), codeVerifier: pending.verifier });
        const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: c.clientId }), identity = ticket.getPayload();
        if (!identity?.email_verified || !identity.sub || !equal(identity.nonce, pending.nonce) || !tokens.refresh_token || !tokens.access_token) throw new AccessError('IDENTITY');
        await rootFolder(c, tokens.access_token);
        cookie(res, c, 'session', { access: tokens.access_token, refresh: tokens.refresh_token, tokenExpires: tokens.expiry_date, sub: identity.sub, context: context(c), expires: Date.now() + 30 * 86400000 });
        return redirect(res, c.origin + '/#records');
      }
      try { await session(req, res, c); return send(res, 200, { configured: true, authenticated: true }); }
      catch (error) { if (error.code !== 'SIGN_IN') throw error; return send(res, 200, { configured: true, authenticated: false }); }
    } catch (error) {
      const code = error instanceof AccessError ? error.code : 'SIGN_IN_FAILED';
      if (c && /[?&](?:code|error)=/.test(req.url)) return redirect(res, c.origin + '/?authError=' + encodeURIComponent(code) + '#records');
      return send(res, error.status || 503, { error: { code } });
    }
  }
  async function artifact(req, res) {
    privateHeaders(res);
    try {
      const c = configuration(env); if (!c) throw new AccessError('NOT_CONFIGURED', 503);
      if (req.method !== 'POST') throw new AccessError('METHOD', 405);
      sameOrigin(req, c);
      const b = await jsonBody(req), path = b?.path;
      if (Object.keys(b || {}).length !== 1 || typeof path !== 'string' || !(path === 'index.json' || /^objects\/[a-f0-9]{64}\.json$/.test(path))) throw new AccessError('PATH', 400);
      const s = await session(req, res, c), derived = await runningFolder(c, s.access);
      const fileName = path === 'index.json' ? c.catalog : path.slice(8);
      const result = await drive(s.access, 'files', { q: `'${derived}' in parents and name = '${fileName}' and trashed = false`, fields: 'files(id,name,size,mimeType,ownedByMe,shared,trashed,parents),nextPageToken,incompleteSearch', pageSize: '2', spaces: 'drive' });
      if (result.incompleteSearch || result.nextPageToken || result.files?.length !== 1) throw new AccessError('DISPLAY_NOT_UNIQUE', 422);
      const f = result.files[0];
      if (!/^[\w-]+$/.test(f.id || '') || f.name !== fileName || f.parents?.length !== 1 || f.parents[0] !== derived || f.ownedByMe !== true || f.shared !== false || f.trashed !== false || f.mimeType !== 'application/json' || !(Number(f.size) > 0 && Number(f.size) <= MAX_BYTES)) throw new AccessError('DISPLAY_INVALID', 422);
      const body = await drive(s.access, `files/${encodeURIComponent(f.id)}`, { alt: 'media' }, true);
      if (path !== 'index.json' && createHash('sha256').update(body).digest('hex') !== fileName.slice(0, -5)) throw new AccessError('DISPLAY_HASH', 422);
      let value; try { value = JSON.parse(body); } catch { throw new AccessError('DISPLAY_INVALID', 422); }
      if (value.schema !== 1 || (path === 'index.json' ? value.kind !== 'catalog' : !['year', 'month', 'route', 'overview', 'analysis', 'exploration'].includes(value.kind))) throw new AccessError('DISPLAY_INVALID', 422);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(body);
    } catch (error) { send(res, error.status || 503, { error: { code: error instanceof AccessError ? error.code : 'DRIVE_UNAVAILABLE' } }); }
  }
  return { auth, artifact };
}
