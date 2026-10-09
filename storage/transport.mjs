// GAS V8-compatible source reads only. Inject existing authorized services; this module
// neither creates grants nor installs services/triggers. Keep these methods server-internal.
// Official contracts: https://developers.google.com/workspace/drive/api/guides/manage-downloads
// https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
// https://developers.google.com/workspace/drive/api/reference/rest/v3/files
// https://developers.google.com/apps-script/reference/url-fetch/http-response
// https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app
// https://developers.google.com/workspace/drive/api/guides/handle-errors
// https://www.rfc-editor.org/rfc/rfc9110.html#section-14
export const SOURCE_FOLDER_ID = '1xam56gYF-jcBU5XzXBKtMxqhyJYwiNE1';
export const MAX_RANGE_BYTES = 1024 * 1024;
export const SOURCE_FIELDS = 'id,name,mimeType,parents,trashed,size,version,md5Checksum,capabilities(canDownload)';
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const DIGITS = /^(?:0|[1-9][0-9]*)$/;

export class TransportError extends Error {
  constructor(code, details = {}) {
    super(code); this.name = 'TransportError'; this.code = code;
    // Never attach Google error text, a token, source filename, URL or source bytes.
    for (const key of ['status', 'retryAfterMs', 'restartScan']) {
      if (details[key] !== undefined) this[key] = details[key];
    }
  }
}
const fail = (code, details) => { throw new TransportError(code, details); };
function integer(value, min, max, code = 'TRANSPORT_CONFIG_INVALID') {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}
function decimal(value, code) {
  if (typeof value !== 'string' || value.length > 20 || !DIGITS.test(value)) fail(code);
  return value;
}
function inFolder(file, membership) {
  return file && file.trashed === false && typeof file.name === 'string' &&
    /\.csv$/i.test(file.name) && typeof file.mimeType === 'string' &&
    file.mimeType.length > 0 && !file.mimeType.startsWith('application/vnd.google-apps.') &&
    Array.isArray(file.parents) && (typeof membership === 'function' ? membership(file) === true : file.parents.includes(SOURCE_FOLDER_ID));
}
// A full, serializable identity is required, never a bare client-supplied file ID.
// Fresh metadata still rechecks membership before ANY media request on resume.
export function validateSourceIdentity(file, membership) {
  if (!inFolder(file, membership)) fail('SOURCE_OUT_OF_SCOPE');
  if (typeof file.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(file.id) ||
      file.name.length > 4096 || file.mimeType.length > 256 || file.parents.length > 32 ||
      file.parents.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) ||
      typeof file.md5Checksum !== 'string' || !/^[a-fA-F0-9]{32}$/.test(file.md5Checksum)) {
    fail('SOURCE_IDENTITY_REQUIRED');
  }
  const version = decimal(file.version, 'SOURCE_IDENTITY_REQUIRED');
  const size = decimal(file.size, 'SOURCE_IDENTITY_REQUIRED');
  integer(Number(size), 0, Number.MAX_SAFE_INTEGER, 'SOURCE_SIZE_UNSUPPORTED');
  if (file.capabilities && file.capabilities.canDownload === false) fail('SOURCE_DOWNLOAD_FORBIDDEN');
  return Object.freeze({id: file.id, name: file.name, mimeType: file.mimeType,
    parents: Object.freeze(file.parents.slice()), trashed: false,
    version, size, md5Checksum: file.md5Checksum.toLowerCase()});
}
function header(headers, target, required = false) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) fail('RANGE_HEADERS_INVALID');
  const keys = Object.keys(headers).filter(key => key.toLowerCase() === target);
  if (keys.length > 1) fail('RANGE_HEADERS_INVALID');
  if (!keys.length) { if (required) fail('RANGE_HEADERS_INVALID'); return null; }
  let value = headers[keys[0]];
  if (Array.isArray(value)) { if (value.length !== 1) fail('RANGE_HEADERS_INVALID'); value = value[0]; }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string' || value.length > 1024 || /[\r\n]/.test(value)) fail('RANGE_HEADERS_INVALID');
  return value.trim();
}
// Apps Script Byte[] can contain signed bytes. Reject non-bytes rather than coercing.
export function normalizeGasBytes(raw, expectedLength) {
  if (!raw || !Number.isSafeInteger(raw.length) || raw.length !== expectedLength ||
      expectedLength < 0 || expectedLength > MAX_RANGE_BYTES) fail('RANGE_LENGTH_MISMATCH');
  const bytes = new Uint8Array(expectedLength);
  for (let i = 0; i < expectedLength; i++) {
    const value = raw[i];
    if (!Number.isInteger(value) || value < -128 || value > 255) fail('RANGE_BYTES_INVALID');
    bytes[i] = value & 255;
  }
  return bytes;
}
function statusFromError(error) {
  // Advanced-service exception details are not reliably structured in every runtime.
  // Unknown exceptions fail closed; never regex-match human text into an auth retry.
  const status = error && (error.code ?? error.details?.code ?? error.error?.code);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}
function forbiddenError(error) {
  const reasons = error?.errors ?? error?.details?.errors ?? error?.error?.errors;
  // Only a bounded, unambiguous structured rate-limit error permits a 403 retry.
  if (Array.isArray(reasons) && reasons.length > 0 && reasons.length <= 8 &&
      reasons.every(item => item && ['rateLimitExceeded', 'userRateLimitExceeded'].includes(item.reason))) {
    return new TransportError('RATE_LIMITED', {status: 403});
  }
  return new TransportError('FORBIDDEN', {status: 403});
}
function serviceError(error, pageToken = null) {
  if (error instanceof TransportError) return error;
  const status = statusFromError(error);
  if (status === 401) return new TransportError('AUTH_REQUIRED', {status});
  if (status === 403) return forbiddenError(error);
  if (status === 404) return new TransportError('SOURCE_NOT_FOUND', {status});
  if (status === 400 && pageToken) return new TransportError('PAGE_TOKEN_REJECTED', {status, restartScan: true});
  return new TransportError('DRIVE_REQUEST_FAILED', {status});
}

/**
 * Synchronous GAS methods are also await-compatible. Supply the SAME absolute
 * deadlineMs across a scheduler invocation; defaults only bound an individual call.
 * UrlFetch has no documented per-request timeout/body streaming limit: a server
 * ignoring Range may buffer internally before we reject 200 without getContent().
 * This is a verified response contract, not a claim of hard platform memory/runtime limits.
 */
export function createDriveSourceTransport(globals, options = {}) {
  const {Drive, UrlFetchApp, ScriptApp, Utilities} = globals || {};
  const now = globals?.now || (() => Date.now());
  const random = globals?.random || (() => Math.random());
  if (!Drive?.Files || typeof Drive.Files.list !== 'function' || typeof Drive.Files.get !== 'function' ||
      typeof UrlFetchApp?.fetch !== 'function' || typeof ScriptApp?.getOAuthToken !== 'function' ||
      typeof now !== 'function' || typeof random !== 'function') fail('GAS_SERVICES_REQUIRED');
  if ('folderId' in options && options.folderId !== SOURCE_FOLDER_ID) fail('SOURCE_FOLDER_FIXED');
  const membership = options.membership;
  if (membership !== undefined && typeof membership !== 'function') fail('SOURCE_SCOPE_INVALID');
  const validate = file => validateSourceIdentity(file, membership);
  const pageSize = integer(options.pageSize ?? 100, 1, 100);
  const maxRangeBytes = integer(options.maxRangeBytes ?? MAX_RANGE_BYTES, 1, MAX_RANGE_BYTES);
  const maxAttempts = integer(options.maxAttempts ?? 3, 1, 3);
  const baseDelayMs = integer(options.baseDelayMs ?? 250, 1, 1000);
  const maxDelayMs = integer(options.maxDelayMs ?? 2000, baseDelayMs, 5000);
  const maxSleepMs = integer(options.maxSleepMs ?? 2000, 0, 2000);
  const reserveMs = integer(options.reserveMs ?? 5000, 0, 30000);
  const maxCalls = integer(options.maxCalls ?? 20, 1, 32);
  function context(args) {
    const start = now();
    if (!Number.isSafeInteger(start)) fail('CLOCK_INVALID');
    const deadlineMs = args?.deadlineMs ?? (start + 120000);
    integer(deadlineMs, 0, Number.MAX_SAFE_INTEGER, 'DEADLINE_INVALID');
    // A later caller-supplied deadline cannot increase this operation's work window.
    return {deadlineMs: Math.min(deadlineMs, start + 120000), calls: 0, slept: 0};
  }
  function check(ctx, extraMs = 0) {
    const time = now();
    if (!Number.isSafeInteger(time)) fail('CLOCK_INVALID');
    if (time + reserveMs + extraMs >= ctx.deadlineMs) fail('TRANSPORT_YIELD', {retryAfterMs: extraMs});
  }
  function call(ctx, fn) {
    check(ctx);
    if (ctx.calls >= maxCalls) fail('TRANSPORT_YIELD', {retryAfterMs: 0});
    ctx.calls++;
    const result = fn();
    check(ctx);
    return result;
  }
  function backoff(ctx, attempt, error) {
    if (attempt + 1 >= maxAttempts) fail('RETRY_EXHAUSTED', {status: error.status});
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) fail('RANDOM_INVALID');
    const delay = Math.max(error.retryAfterMs || 0,
      Math.min(maxDelayMs, baseDelayMs * (2 ** attempt) + Math.floor(sample * baseDelayMs)));
    if (delay > maxDelayMs || ctx.slept + delay > maxSleepMs || typeof Utilities?.sleep !== 'function') {
      fail('TRANSPORT_YIELD', {status: error.status, retryAfterMs: delay});
    }
    check(ctx, delay);
    Utilities.sleep(delay);
    ctx.slept += delay;
    check(ctx);
  }
  function driveCall(ctx, fn, pageToken = null) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try { return call(ctx, fn); }
      catch (raw) {
        const error = serviceError(raw, pageToken);
        if (error.code !== 'RATE_LIMITED' && (!TRANSIENT.has(error.status) || error.code !== 'DRIVE_REQUEST_FAILED')) throw error;
        backoff(ctx, attempt, error);
      }
    }
  }
  function expectedSource(expected, ctx) {
    const actual = driveCall(ctx, () => Drive.Files.get(expected.id, {fields: SOURCE_FIELDS, supportsAllDrives: true}));
    if (!inFolder(actual, membership)) fail('SOURCE_CHANGED');
    const current = validate(actual);
    if (['id', 'version', 'md5Checksum', 'size'].some(key => current[key] !== expected[key])) fail('SOURCE_CHANGED');
    return current;
  }
  function tokenValue(value) {
    if (value == null) return null;
    if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || /[\r\n\0]/.test(value)) fail('PAGE_TOKEN_INVALID');
    return value;
  }
  function listPage(args = {}) {
    const pageToken = tokenValue(args.pageToken);
    const ctx = context(args);
    const request = {q: "'" + SOURCE_FOLDER_ID + "' in parents and trashed = false",
      fields: 'nextPageToken,incompleteSearch,files(' + SOURCE_FIELDS + ')',
      pageSize, spaces: 'drive', corpora: 'user', supportsAllDrives: true};
    if (pageToken) request.pageToken = pageToken;
    const page = driveCall(ctx, () => Drive.Files.list(request), pageToken);
    if (!page || !Array.isArray(page.files) || page.files.length > pageSize ||
        (page.incompleteSearch !== undefined && typeof page.incompleteSearch !== 'boolean')) fail('LIST_RESPONSE_INVALID');
    if (page.incompleteSearch === true) fail('LIST_INCOMPLETE');
    const nextPageToken = tokenValue(page.nextPageToken);
    if (nextPageToken && nextPageToken === pageToken) fail('PAGE_TOKEN_STALLED');
    // At most one API page; no unbounded seen-ID set. Caller persists cursor, dedups
    // by content identity, restarts rejected cursors and periodically starts new scans.
    for (const file of page.files) {
      if (!file || typeof file.name !== 'string' || typeof file.mimeType !== 'string' ||
          !Array.isArray(file.parents) || typeof file.trashed !== 'boolean') fail('LIST_RESPONSE_INVALID');
    }
    const files = page.files.filter(inFolder).map(validateSourceIdentity);
    check(ctx);
    return {files, nextPageToken, done: nextPageToken === null};
  }
  function getSource(expected, args = {}) {
    return expectedSource(validate(expected), context(args));
  }
  function retryAfter(headers) {
    const raw = header(headers, 'retry-after');
    if (raw === null) return 0;
    if (/^[0-9]+$/.test(raw)) {
      const ms = Number(raw) * 1000;
      if (!Number.isSafeInteger(ms)) fail('RANGE_HEADERS_INVALID');
      return ms;
    }
    const date = Date.parse(raw);
    if (!Number.isFinite(date)) fail('RANGE_HEADERS_INVALID');
    return Math.max(0, date - now());
  }
  function mediaForbidden(response) {
    // Do not getContentText() an unbounded error response. A missing, malformed or
    // large declared body is simply FORBIDDEN; no auth or quota guess is made.
    const headers = response.getAllHeaders();
    const length = header(headers, 'content-length');
    const type = header(headers, 'content-type');
    if (!length || !DIGITS.test(length) || Number(length) > 8192 ||
        !type || !/^application\/json(?:\s*;|$)/i.test(type)) return forbiddenError(null);
    try {
      const bytes = normalizeGasBytes(response.getContent(), Number(length));
      let json = '';
      // Relevant JSON reason keys are ASCII. Non-ASCII message text is ignored.
      for (const byte of bytes) json += String.fromCharCode(byte);
      return forbiddenError(JSON.parse(json));
    } catch (_) { return forbiddenError(null); }
  }
  function readRange(expectedInput, start, length = maxRangeBytes, args = {}) {
    const expected = validate(expectedInput);
    const size = Number(expected.size);
    integer(start, 0, Math.max(0, size - 1), 'RANGE_REQUEST_INVALID');
    integer(length, 1, maxRangeBytes, 'RANGE_REQUEST_INVALID');
    if (size === 0 || start >= size) fail('RANGE_REQUEST_INVALID');
    const count = Math.min(length, size - start);
    const end = start + count - 1;
    const ctx = context(args);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      expectedSource(expected, ctx);
      let token;
      try { token = ScriptApp.getOAuthToken(); }
      catch (_) { fail('AUTH_REQUIRED'); }
      if (typeof token !== 'string' || !token || token.length > 8192 || /[\s\x00-\x1f\x7f]/.test(token)) fail('AUTH_REQUIRED');
      let response, fetchError;
      try {
        response = call(ctx, () => UrlFetchApp.fetch(
          'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(expected.id) + '?alt=media',
          {method: 'get', headers: {Authorization: 'Bearer ' + token,
            Range: 'bytes=' + start + '-' + end, 'Accept-Encoding': 'identity'},
          followRedirects: false, validateHttpsCertificates: true, muteHttpExceptions: true}));
      } catch (error) { fetchError = error; }
      token = null;
      // No response bytes are exposed until a post-read freshness check succeeds.
      // If the deadline has elapsed, this check yields and the unverified body is discarded.
      expectedSource(expected, ctx);
      if (fetchError) {
        if (fetchError instanceof TransportError) throw fetchError;
        const status = statusFromError(fetchError);
        if (status === 401) fail('AUTH_REQUIRED', {status});
        const error = status === 403 ? forbiddenError(fetchError) : new TransportError('MEDIA_REQUEST_FAILED', {status});
        if (error.code === 'FORBIDDEN') throw error;
        if (error.code !== 'RATE_LIMITED' && !TRANSIENT.has(status)) throw error;
        backoff(ctx, attempt, error);
        continue;
      }
      if (!response || typeof response.getResponseCode !== 'function' ||
          typeof response.getAllHeaders !== 'function' || typeof response.getContent !== 'function') fail('RANGE_RESPONSE_INVALID');
      const status = response.getResponseCode();
      if (!Number.isInteger(status) || status < 100 || status > 599) fail('RANGE_RESPONSE_INVALID');
      if (status === 401) fail('AUTH_REQUIRED', {status});
      if (status === 403) {
        const error = mediaForbidden(response);
        if (error.code !== 'RATE_LIMITED') throw error;
        error.retryAfterMs = retryAfter(response.getAllHeaders());
        backoff(ctx, attempt, error);
        continue;
      }
      if (status === 404) fail('SOURCE_NOT_FOUND', {status});
      if (TRANSIENT.has(status)) {
        backoff(ctx, attempt, new TransportError('MEDIA_REQUEST_FAILED', {status,
          retryAfterMs: retryAfter(response.getAllHeaders())}));
        continue;
      }
      // In particular, never accept full-file 200, redirects, 304, or 416.
      if (status !== 206) fail('RANGE_STATUS_INVALID', {status});
      const headers = response.getAllHeaders();
      const range = header(headers, 'content-range', true);
      const match = /^bytes (0|[1-9][0-9]*)-(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)$/.exec(range);
      if (!match || match[1] !== String(start) || match[2] !== String(end) || match[3] !== expected.size) fail('RANGE_CONTENT_RANGE_INVALID');
      const contentLength = header(headers, 'content-length');
      if (contentLength !== null && contentLength !== String(count)) fail('RANGE_LENGTH_MISMATCH');
      const encoding = header(headers, 'content-encoding');
      if (encoding !== null && encoding.toLowerCase() !== 'identity') fail('RANGE_ENCODING_INVALID');
      const contentType = header(headers, 'content-type');
      if (contentType !== null && /^multipart\//i.test(contentType)) fail('RANGE_MULTIPART_INVALID');
      let raw;
      try { raw = response.getContent(); }
      catch (_) { fail('MEDIA_BODY_UNAVAILABLE'); }
      const bytes = normalizeGasBytes(raw, count);
      check(ctx);
      return bytes;
    }
  }
  return Object.freeze({listPage, getSource, readRange, folderId: SOURCE_FOLDER_ID, maxRangeBytes});
}
