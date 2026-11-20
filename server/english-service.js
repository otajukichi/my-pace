import { validateCatalog, validatePracticeRecord } from '../lib/english-model.js';

const BODY_LIMIT = 8192;
const SCOPE = 'english:practice:append';
const PROTOCOLS = ['2025-06-18', '2025-03-26'];
const RECEIPT_KEYS = ['schema', 'sessionId', 'performedAt', 'kind', 'areaId', 'themeId', 'modeId'];

export const practiceReceiptSchema = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    schema: { type: 'integer', const: 1 },
    sessionId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$' },
    performedAt: { type: 'string', format: 'date-time', maxLength: 24 },
    kind: { type: 'string', enum: ['conversation', 'reading'] },
    areaId: { type: ['string', 'null'], maxLength: 80 },
    themeId: { type: 'string', minLength: 1, maxLength: 80 },
    modeId: { type: 'string', enum: ['scene', 'topic', 'free', 'reading'] },
  },
  required: RECEIPT_KEYS,
});

const tool = {
  name: 'record_practice', title: '英語の練習を記録',
  description: '実施した英会話・音読の記録を1件追加します。利用者が練習の終了を確認してから使ってください。音声・会話本文・採点・任意ファイル操作は受け付けません。同じセッションIDの再送は重複登録されません。',
  inputSchema: practiceReceiptSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

class EnglishError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const header = (req, name) => req.headers?.[name.toLowerCase()];
function reply(res, status, body, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Vary': 'Authorization, Origin',
    ...extra,
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
function failure(res, error) {
  const known = error instanceof EnglishError;
  reply(res, known ? error.status : 503, { error: known ? error.code : 'ENGLISH_STORAGE_UNAVAILABLE' },
    known && error.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="my-pace-english"' } : {});
}
function rpc(res, id, result) { reply(res, 200, { jsonrpc: '2.0', id, result }); }
function rpcError(res, id, code, message) { reply(res, 200, { jsonrpc: '2.0', id, error: { code, message } }); }

async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(header(req, 'content-type') || '')) throw new EnglishError(415, 'JSON_REQUIRED');
  if (Number(header(req, 'content-length')) > BODY_LIMIT) throw new EnglishError(413, 'RECEIPT_TOO_LARGE');
  let text;
  if (req.body !== undefined) {
    try { text = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body); }
    catch { throw new EnglishError(400, 'INVALID_JSON'); }
  } else {
    const chunks = []; let length = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk); length += bytes.length;
      if (length > BODY_LIMIT) throw new EnglishError(413, 'RECEIPT_TOO_LARGE');
      chunks.push(bytes);
    }
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (typeof text !== 'string') throw new EnglishError(400, 'INVALID_JSON');
  if (Buffer.byteLength(text) > BODY_LIMIT) throw new EnglishError(413, 'RECEIPT_TOO_LARGE');
  try { return JSON.parse(text); } catch { throw new EnglishError(400, 'INVALID_JSON'); }
}

/**
 * The deployed default deliberately has NO OAuth verifier or persistent store.
 * Supplying environment variables or a running-login cookie cannot enable it.
 *
 * Future adapters must be provided together, from trusted server code:
 * - authenticate(req): verify a dedicated OAuth token (issuer, signature,
 *   expiry, audience and scope), returning {subject,audience,scopes,expiresAt}.
 * - storage: already bound to ownerSubject and the private English history
 *   destination; appendOnce(sessionId, record) must ATOMICALLY return
 *   'created', 'duplicate' (identical receipt) or 'conflict' (different receipt).
 *   A list-then-create Drive call or process-local Map is NOT sufficient.
 *   Ownership/ancestry/sharing must be rechecked by that adapter; callers never
 *   choose a folder or path. No such production adapter is shipped here.
 * - catalog: the owner's validated public metadata, never scenario bodies.
 *
 * This is a stateless JSON response MCP foundation, not an OAuth server or a
 * claim of ChatGPT/mobile connectivity. Test doubles live only in the tests.
 */
export function createEnglishService({ authenticate, storage, catalog, ownerSubject, audience, origin, now = () => Date.now() } = {}) {
  let validatedCatalog;
  try { if (catalog) validatedCatalog = validateCatalog(catalog); } catch { /* Invalid server metadata keeps writes closed. */ }
  const configured = typeof authenticate === 'function' && typeof storage?.appendOnce === 'function'
    && typeof ownerSubject === 'string' && ownerSubject.length > 0 && storage.ownerSubject === ownerSubject
    && typeof audience === 'string' && audience.length > 0
    && typeof origin === 'string' && origin.length > 0 && !!validatedCatalog;

  async function authorize(req) {
    if (!configured) throw new EnglishError(503, 'ENGLISH_UNCONFIGURED');
    const requestOrigin = header(req, 'origin');
    if (requestOrigin !== undefined && requestOrigin !== origin) throw new EnglishError(403, 'ORIGIN_NOT_ALLOWED');
    // Running's browser cookie is intentionally not an English write grant.
    if (!/^Bearer [A-Za-z0-9._~+/-]+=*$/.test(header(req, 'authorization') || '')) throw new EnglishError(401, 'ENGLISH_AUTH_REQUIRED');
    let principal;
    try { principal = await authenticate(req); } catch { throw new EnglishError(401, 'ENGLISH_AUTH_REQUIRED'); }
    if (!principal || principal.subject !== ownerSubject || principal.audience !== audience
      || !Number.isFinite(principal.expiresAt) || principal.expiresAt <= now()) throw new EnglishError(401, 'ENGLISH_AUTH_REQUIRED');
    if (!Array.isArray(principal.scopes) || !principal.scopes.includes(SCOPE)) throw new EnglishError(403, 'ENGLISH_SCOPE_REQUIRED');
  }

  async function append(value) {
    // Reject, rather than silently drop, full text, scores or destination IDs.
    if (!onlyKeys(value, RECEIPT_KEYS) || !RECEIPT_KEYS.every(key => Object.hasOwn(value, key))) throw new EnglishError(400, 'INVALID_PRACTICE_RECORD');
    let record;
    try { record = validatePracticeRecord(value, { catalog: validatedCatalog }); }
    catch { throw new EnglishError(400, 'INVALID_PRACTICE_RECORD'); }
    if (!record || typeof record !== 'object') throw new EnglishError(400, 'INVALID_PRACTICE_RECORD');
    // A different JSON key order is the same receipt for idempotent storage.
    const receipt = Object.freeze({ ...Object.fromEntries(RECEIPT_KEYS.map(key => [key, record[key]])), origin: 'connector' });
    let outcome;
    try { outcome = await storage.appendOnce(receipt.sessionId, receipt); }
    catch { throw new EnglishError(503, 'ENGLISH_STORAGE_UNAVAILABLE'); }
    if (outcome === 'conflict') throw new EnglishError(409, 'SESSION_CONFLICT');
    if (outcome !== 'created' && outcome !== 'duplicate') throw new EnglishError(503, 'ENGLISH_STORAGE_UNAVAILABLE');
    return { sessionId: receipt.sessionId, recorded: true, duplicate: outcome === 'duplicate' };
  }

  async function status(req, res) {
    if (req.method !== 'GET') return reply(res, 405, { error: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET' });
    // No owner, catalogue, material reference, history or folder ID is exposed.
    reply(res, 200, { configured, recording: configured ? 'authentication-required' : 'unconfigured', voiceIntegration: 'unverified' });
  }

  async function record(req, res) {
    if (req.method !== 'POST') return reply(res, 405, { error: 'METHOD_NOT_ALLOWED' }, { Allow: 'POST' });
    try {
      await authorize(req);
      const result = await append(await body(req));
      reply(res, result.duplicate ? 200 : 201, result);
    } catch (error) { failure(res, error); }
  }

  async function mcp(req, res) {
    try {
      await authorize(req);
      if (req.method !== 'POST') return reply(res, 405, { error: 'METHOD_NOT_ALLOWED' }, { Allow: 'POST' });
      const version = header(req, 'mcp-protocol-version');
      if (version !== undefined && !PROTOCOLS.includes(version)) throw new EnglishError(400, 'UNSUPPORTED_MCP_VERSION');
      const message = await body(req);
      const validId = typeof message?.id === 'string' && message.id.length <= 128 || Number.isSafeInteger(message?.id);
      const id = validId ? message.id : null;
      if (!onlyKeys(message, ['jsonrpc', 'id', 'method', 'params']) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(res, id, -32600, 'Invalid Request');
      if (!Object.hasOwn(message, 'id')) {
        if (message.method === 'notifications/initialized' && (message.params === undefined || onlyKeys(message.params, []))) return reply(res, 202);
        throw new EnglishError(400, 'UNSUPPORTED_NOTIFICATION');
      }
      if (!validId) return rpcError(res, null, -32600, 'Invalid Request');
      if (message.method === 'initialize') {
        const p = message.params;
        if (!onlyKeys(p, ['protocolVersion', 'capabilities', 'clientInfo']) || typeof p.protocolVersion !== 'string' || !object(p.capabilities)
          || !object(p.clientInfo) || typeof p.clientInfo.name !== 'string' || typeof p.clientInfo.version !== 'string') return rpcError(res, id, -32602, 'Invalid params');
        return rpc(res, id, {
          protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'my-pace-english', version: '0.1.0' },
        });
      }
      if (message.method === 'tools/list') {
        if (message.params !== undefined && !onlyKeys(message.params, [])) return rpcError(res, id, -32602, 'Invalid params');
        return rpc(res, id, { tools: [tool] });
      }
      if (message.method === 'tools/call') {
        const p = message.params;
        if (!onlyKeys(p, ['name', 'arguments']) || p.name !== 'record_practice') return rpcError(res, id, -32602, 'Unknown tool or invalid params');
        try {
          const result = await append(p.arguments);
          return rpc(res, id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
        } catch (error) {
          const code = error instanceof EnglishError ? error.code : 'ENGLISH_STORAGE_UNAVAILABLE';
          return rpc(res, id, { content: [{ type: 'text', text: code }], isError: true });
        }
      }
      return rpcError(res, id, -32601, 'Method not found');
    } catch (error) { failure(res, error); }
  }

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'https://my-pace.invalid'); } catch { return failure(res, new EnglishError(400, 'INVALID_REQUEST')); }
    const action = url.searchParams.get('action') || (req.method === 'GET' ? 'status' : 'mcp');
    if ([...url.searchParams.keys()].some(key => key !== 'action') || url.searchParams.getAll('action').length > 1) return failure(res, new EnglishError(400, 'INVALID_REQUEST'));
    if (action === 'status') return status(req, res);
    if (action === 'record') return record(req, res);
    if (action === 'mcp') return mcp(req, res);
    return failure(res, new EnglishError(404, 'NOT_FOUND'));
  }
  return { handle, status, record, mcp };
}
