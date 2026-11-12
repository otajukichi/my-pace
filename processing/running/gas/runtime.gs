// Shared bounded Drive I/O and durable budget. Host supplies configuration,
// marker, property namespace, trigger handler and application state machine.
let mi;
function miJson(x) { return JSON.stringify(x) + '\n'; }
function miBytes(x) { return Utilities.newBlob(x).getBytes(); }
function miDigest(algorithm, bytes) { return Utilities.computeDigest(algorithm, bytes).map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join(''); }
function mpHash(x) { return miDigest(Utilities.DigestAlgorithm.SHA_256, miBytes(typeof x === 'string' ? x : miJson(x))); }
function miAssert(ok, code) { if (!ok) throw Error(code); }
function miId(id) { miAssert(typeof id === 'string' && /^[\w-]+$/.test(id), 'INVALID_FILE_ID'); return id; }
function miCode(e) { return /^[A-Z][A-Z0-9_]+$/.test(e?.message || '') ? e.message : 'UNEXPECTED_ERROR'; }
function miGet(key, fallback) { const text = mi.props.getProperty(MI_KEY + '_' + key); return text === null ? fallback : JSON.parse(text); }
function miSet(key, value) { mi.props.setProperty(MI_KEY + '_' + key, JSON.stringify(value)); }
function miCount(key, n) { const m = miGet('METRICS', {}); m[key] = (m[key] || 0) + (n === undefined ? 1 : n); miSet('METRICS', m); }
function miYield() { if (Date.now() - mi.started >= 90000) throw Error('YIELD'); }
function miStop() { for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === MI_HANDLER) ScriptApp.deleteTrigger(t); }
function miSchedule() { if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === MI_HANDLER)) ScriptApp.newTrigger(MI_HANDLER).timeBased().everyMinutes(5).create(); }

function miFetch(path, options) {
  if (typeof miRequestGuard === 'function') miRequestGuard(path, options || {});
  miAssert(/^https:\/\/www\.googleapis\.com\/(?:upload\/)?drive\/v3\//.test(path), 'INVALID_REQUEST');
  const m = miGet('METRICS', {}); miAssert((m.requests || 0) < 6000, 'REQUEST_BUDGET_REACHED');
  miCount('requests'); miCount((mi.category || 'processing') + 'Requests');
  let response;
  try { response = UrlFetchApp.fetch(path, { muteHttpExceptions: true, followRedirects: false, ...options,
    headers: { ...options?.headers, Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }); }
  catch { throw Error('DRIVE_TRANSPORT_ERROR'); }
  const status = response.getResponseCode();
  if (status === 429 || status >= 500) throw Error('DRIVE_RETRYABLE');
  if (status < 200 || status >= 300) {
    let reasons = [];
    try { reasons = (JSON.parse(response.getContentText('UTF-8')).error?.errors || []).map(e => e.reason).filter(r => typeof r === 'string' && /^[A-Za-z0-9_]+$/.test(r)).slice(0, 8); } catch { /* Never log response text or URLs. */ }
    const error = Error(status === 403 && reasons.some(r => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(r)) ? 'DRIVE_RETRYABLE' : 'DRIVE_HTTP_' + status);
    error.driveReasons = reasons; throw error;
  }
  return response;
}
function miApi(path, method, data, upload) {
  return JSON.parse(miFetch('https://www.googleapis.com/' + (upload ? 'upload/' : '') + 'drive/v3/' + path,
    { method: method || 'get', ...(data === undefined ? {} : { contentType: 'application/json', payload: typeof data === 'string' ? data : JSON.stringify(data) }) }).getContentText('UTF-8'));
}
function miMeta(id, optional) {
  try { return miApi('files/' + miId(id) + '?fields=' + encodeURIComponent(MI_FIELDS)); }
  catch (e) { if (optional && e.message === 'DRIVE_HTTP_404') return null; throw e; }
}
function miSourceAncestor(id) {
  const key = 'source-ancestor:' + miId(id);
  if (!mi.memory.has(key)) {
    miYield();
    mi.memory.set(key, miApi('files/' + id + '?fields=mimeType,parents,trashed'));
  }
  return mi.memory.get(key);
}
function miOwned(meta, role, parent, allowTrashed) {
  miAssert(meta && meta.ownedByMe === true && meta.shared === false && (allowTrashed || !meta.trashed), 'OUTPUT_NOT_OWNER_PRIVATE');
  miAssert(meta.appProperties?.[MI_MARKER] === mi.root.job && meta.appProperties?.role === role, 'OUTPUT_MARKER_CHANGED');
  if (parent) miAssert(meta.parents?.length === 1 && meta.parents[0] === parent, 'OUTPUT_PARENT_CHANGED');
}
function miMetadata(id, name, role, parent, extra) {
  return { id, name, mimeType: role === 'folder' ? 'application/vnd.google-apps.folder' : role === 'fixture' ? 'text/csv' : 'application/json',
    ...(parent ? { parents: [parent] } : {}), appProperties: { [MI_MARKER]: mi.root.job, role, ...extra } };
}
function miCreate(metadata, content) {
  if (content === undefined) return miApi('files?ignoreDefaultVisibility=true&fields=' + encodeURIComponent(MI_FIELDS), 'post', metadata);
  const boundary = 'mypace_incremental_' + mi.root.job.replace(/-/g, '');
  const payload = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata)
    + '\r\n--' + boundary + '\r\nContent-Type: ' + metadata.mimeType + '; charset=UTF-8\r\n\r\n' + content + '\r\n--' + boundary + '--\r\n';
  return JSON.parse(miFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&ignoreDefaultVisibility=true&fields=' + encodeURIComponent(MI_FIELDS),
    { method: 'post', contentType: 'multipart/related; boundary=' + boundary, payload }).getContentText('UTF-8'));
}
function miRead(id, role, parent) {
  const meta = miMeta(id); miOwned(meta, role, parent || mi.root.system);
  if (role === 'state') mi.stateMeta = meta;
  miAssert(Number(meta.size) <= 4194304, 'CHECKPOINT_SIZE_LIMIT');
  const response = miFetch('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media');
  const bytes = response.getBlob().getBytes();
  miAssert(bytes.length === Number(meta.size) && miDigest(Utilities.DigestAlgorithm.MD5, bytes) === meta.md5Checksum, 'CHECKPOINT_INTEGRITY');
  return JSON.parse(response.getContentText('UTF-8'));
}
function miWrite(id, name, value, role, parent, immutable) {
  const text = typeof value === 'string' ? value : miJson(value), bytes = miBytes(text), md5 = miDigest(Utilities.DigestAlgorithm.MD5, bytes);
  miAssert(bytes.length <= 4194304, 'CHECKPOINT_SIZE_LIMIT');
  // A checkpoint is owned/validated when loaded each invocation. Reuse that
  // metadata within this locked invocation; validate every write response too.
  const before = role === 'state' && mi.stateMeta ? mi.stateMeta : miMeta(id, true);
  if (before) {
    miOwned(before, role, parent);
    if (before.md5Checksum === md5 && Number(before.size) === bytes.length) return;
    miAssert(!immutable, 'IMMUTABLE_CONTENT_MISMATCH');
  }
  const after = before ? miApi('files/' + id + '?uploadType=media&fields=' + encodeURIComponent(MI_FIELDS), 'patch', text, true)
    : miCreate(miMetadata(id, name, role, parent), text);
  miOwned(after, role, parent); miAssert(after.md5Checksum === md5 && Number(after.size) === bytes.length, 'WRITE_INTEGRITY');
  if (role === 'state') mi.stateMeta = after;
}
function miSave() { miWrite(mi.root.state, mi.root.stateName || 'checkpoint.json', mi.state, 'state', mi.root.system, false); }
function miAllocate(key) {
  const s = mi.state;
  if (!s.ids[key]) {
    if (!s.pool.length) {
      s.pool = miApi('files/generateIds?count=50&space=drive&type=files').ids;
      miAssert(s.pool?.length, 'RESERVED_IDS_REQUIRED'); miSave();
    }
    // Allocation is deterministic from the durable pool until the caller saves
    // completion. A lost create response therefore retries the very same ID.
    s.ids[key] = s.pool.shift();
  }
  return s.ids[key];
}
function miUnit(kind, key, compute) {
  const name = mpHash({ kind, key });
  if (mi.memory.has(name)) return mi.memory.get(name);
  const s = mi.state;
  if (s.cache[name]) {
    const value = miRead(s.cache[name], 'cache'); mi.memory.set(name, value); miCount(kind + 'Reused'); return value;
  }
  miYield(); const began = Date.now(), value = compute(); miCount(kind + 'ComputeMs', Date.now() - began);
  const id = miAllocate('cache-' + name);
  miWrite(id, kind + '-' + name + '.json', value, 'cache', mi.root.system, true);
  s.cache[name] = id; miSave(); mi.memory.set(name, value); miCount(kind + 'Computed'); return value;
}

function miBudgetBegin() {
  const now = Date.now(), hour = Math.floor(now / 3600000), b = miGet('BUDGET', { hours: {}, totalMs: 0, measuredMs: 0, maximumMs: 0 });
  // Whole hourly buckets keep up to 25 hours, conservatively covering any 24h window.
  for (const h of Object.keys(b.hours)) if (Number(h) < hour - 24) delete b.hours[h];
  if (miGet('ACTIVE', null)) {
    miSet('INTERRUPTIONS', miGet('INTERRUPTIONS', 0) + 1); b.maximumMs = Math.max(b.maximumMs, 360000);
    miSet('ACTIVE', null); miSet('BUDGET', b);
  }
  miAssert(Object.values(b.hours).reduce((a, n) => a + n, 0) + 360000 <= 3600000, 'EXECUTION_BUDGET_REACHED');
  b.hours[hour] = (b.hours[hour] || 0) + 360000; b.totalMs += 360000; miSet('BUDGET', b); miSet('ACTIVE', { hour }); mi.reserved = hour;
}
function miBudgetEnd() {
  if (mi.reserved === undefined) return;
  const measured = Date.now() - mi.started, accounted = measured + 1000, b = miGet('BUDGET');
  b.hours[mi.reserved] += accounted - 360000; b.totalMs += accounted - 360000;
  b.measuredMs += measured; b.maximumMs = Math.max(b.maximumMs, accounted); miSet('BUDGET', b); miSet('ACTIVE', null);
  const idle = miGet('IDLE', null);
  if (idle && miGet('MODE') === 'idle' && idle.endMeasuredMs === undefined) {
    idle.maximumExecutionMs = Math.max(idle.maximumExecutionMs || 0, accounted);
    if (idle.completed) { idle.endMeasuredMs = b.measuredMs; idle.endAccountedMs = b.totalMs; }
    miSet('IDLE', idle);
  }
}
