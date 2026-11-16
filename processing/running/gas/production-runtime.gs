// Production I/O is separate from the passed experiments. No Drive deletion,
// sharing, parent changes, CSV writes, or writes to the old experiment exist.
const MYPACE_PRODUCTION_CONFIG = __MYPACE_PROBE_CONFIG__;
const MYPACE_BUILD_ID = __MYPACE_BUILD_ID__;
const PR_KEY = 'MYPACE_RUNNING_V1_', PR_TICK = 'myPaceRunningTick', PR_WAKE = 'myPaceRunningWake';
const PR_FIELDS = 'id,name,mimeType,size,md5Checksum,version,modifiedTime,parents,trashed,ownedByMe,shared,appProperties';
const PR_FOLDER = 'application/vnd.google-apps.folder', PR_LIMIT = 4194304;
let pr;
function prAssert(ok, code) { if (!ok) throw Error(code); }
function prJson(value) { return JSON.stringify(value) + '\n'; }
function prBytes(value) { return Utilities.newBlob(value).getBytes(); }
function prDigest(algorithm, bytes) { return Utilities.computeDigest(algorithm, bytes).map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join(''); }
function mpHash(value) { return prDigest(Utilities.DigestAlgorithm.SHA_256, prBytes(typeof value === 'string' ? value : prJson(value))); }
function prId(id) { prAssert(typeof id === 'string' && /^[\w-]+$/.test(id), 'INVALID_FOLDER_ID'); return id; }
function prGet(key, fallback = null) { const value = pr.props.getProperty(PR_KEY + key); return value === null ? fallback : JSON.parse(value); }
function prSet(key, value) { pr.props.setProperty(PR_KEY + key, JSON.stringify(value)); }
function prConfig() {
  const c = MYPACE_PRODUCTION_CONFIG;
  prAssert(c && c.rootFolderId && c.sourceFolderId, 'SET_ROOT_AND_SOURCE_FOLDERS');
  prId(c.rootFolderId); prId(c.sourceFolderId); prAssert(c.rootFolderId !== c.sourceFolderId, 'INPUT_OUTPUT_OVERLAP');
  return { rootFolderId: c.rootFolderId, sourceFolderId: c.sourceFolderId };
}
function prYield() { if (Date.now() - pr.started >= 90000) throw Error('YIELD'); }
function prCount(key, n = 1) { pr.metrics[key] = (pr.metrics[key] || 0) + n; }
function prPrivate(meta, parent, mime) {
  prAssert(meta && meta.ownedByMe === true && meta.shared === false && !meta.trashed, 'OWNER_PRIVATE_REQUIRED');
  if (parent) prAssert(meta.parents?.length === 1 && meta.parents[0] === parent, 'FOLDER_LOCATION_CHANGED');
  if (mime) prAssert(meta.mimeType === mime, 'FILE_TYPE_CHANGED');
  return meta;
}
function prFetch(path, options = {}) {
  const method = (options.method || 'get').toLowerCase();
  prAssert(/^https:\/\/www\.googleapis\.com\/(?:upload\/)?drive\/v3\//.test(path), 'INVALID_REQUEST');
  // All writes require a short-lived permit created AFTER ownership/location
  // validation, with the exact payload. Never accept a caller-supplied URL.
  if (method !== 'get') prAssert(pr.writePermit === path + '\n' + method + '\n' + options.payload, 'WRITE_FORBIDDEN');
  if (pr.budget && pr.budget.requests >= 12000 && !pr.saving && !pr.recovery) throw Error('REQUEST_BUDGET_WAIT');
  if (pr.budget) { pr.budget.requests++; prPersistBudget(); }
  prCount('requests');
  let response;
  try { response = UrlFetchApp.fetch(path, { ...options, muteHttpExceptions: true, followRedirects: false,
    headers: { ...options.headers, Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }); }
  catch { throw Error('DRIVE_TRANSPORT_ERROR'); }
  const status = response.getResponseCode();
  if (status === 429 || status >= 500) throw Error('DRIVE_RETRYABLE');
  if (status < 200 || status >= 300) {
    let reasons = [];
    try { reasons = (JSON.parse(response.getContentText()).error?.errors || []).map(e => e.reason).filter(x => /^[A-Za-z0-9_]+$/.test(x)).slice(0, 6); } catch {}
    const retry = status === 403 && reasons.some(x => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(x));
    throw Object.assign(Error(retry ? 'DRIVE_RETRYABLE' : 'DRIVE_HTTP_' + status), { driveReasons: reasons });
  }
  return response;
}
function prApi(path) { return JSON.parse(prFetch('https://www.googleapis.com/drive/v3/' + path).getContentText('UTF-8')); }
function prMeta(id, optional = false) {
  try { return prApi('files/' + prId(id) + '?fields=' + encodeURIComponent(PR_FIELDS)); }
  catch (e) { if (optional && e.message === 'DRIVE_HTTP_404') return null; throw e; }
}
function prList(parent) {
  const result = []; let token; const seen = new Set();
  do {
    prYield(); prAssert(!seen.has(token), 'DRIVE_PAGE_LOOP'); seen.add(token);
    const page = prApi('files?q=' + encodeURIComponent("'" + prId(parent) + "' in parents and trashed = false")
      + '&spaces=drive&pageSize=1000&fields=' + encodeURIComponent('files(' + PR_FIELDS + '),nextPageToken,incompleteSearch')
      + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
    prAssert(!page.incompleteSearch && Array.isArray(page.files), 'INCOMPLETE_FOLDER_LIST'); result.push(...page.files); token = page.nextPageToken;
  } while (token);
  return result;
}
function prChild(parent, name, optional = false) {
  const matches = prList(parent).filter(f => f.name === name);
  prAssert(matches.length === 1 || optional && !matches.length, 'FOLDER_OR_FILE_NOT_UNIQUE');
  return matches[0] || null;
}
function prRead(meta, parent, limit = PR_LIMIT) {
  prPrivate(meta, parent, 'application/json');
  prAssert(Number(meta.size) > 0 && Number(meta.size) <= limit, 'JSON_SIZE_LIMIT');
  const response = prFetch('https://www.googleapis.com/drive/v3/files/' + prId(meta.id) + '?alt=media');
  const bytes = response.getBlob().getBytes();
  prAssert(bytes.length === Number(meta.size) && prDigest(Utilities.DigestAlgorithm.MD5, bytes) === meta.md5Checksum, 'JSON_INTEGRITY');
  return response.getContentText('UTF-8');
}
function prValue(id, parent) { return JSON.parse(prRead(prMeta(id), parent)); }
function prValidateRoots() {
  const c = prConfig(); prPrivate(prMeta(c.rootFolderId), null, PR_FOLDER);
  const running = prPrivate(prChild(c.rootFolderId, 'running'), c.rootFolderId, PR_FOLDER);
  const derived = prPrivate(prChild(running.id, 'derived'), running.id, PR_FOLDER);
  const source = prPrivate(prMeta(c.sourceFolderId), null, PR_FOLDER);
  function inside(meta, ancestor) {
    return MP_SYNC.sourceFolderLocation(meta, ancestor, id => prPrivate(prMeta(id), null, PR_FOLDER)).withinConfiguredFolder;
  }
  prAssert(!inside(source, c.rootFolderId) && !inside(prMeta(c.rootFolderId), c.sourceFolderId), 'INPUT_OUTPUT_OVERLAP');
  return { folder: c.rootFolderId, running: running.id, derived: derived.id, source: source.id };
}
function prCheckRoots() {
  const r = pr.root;
  prPrivate(prMeta(r.folder), null, PR_FOLDER);
  for (const [id, parent, name] of [[r.running, r.folder, 'running'], [r.derived, r.running, 'derived'], [r.system, r.running, 'system']]) {
    prAssert(prPrivate(prMeta(id), parent, PR_FOLDER).name === name, 'OUTPUT_NAME_CHANGED');
  }
  prPrivate(prMeta(r.source), null, PR_FOLDER);
}
function prSource(meta) {
  prPrivate(meta); prAssert(/\.csv$/i.test(meta.name || '') && !meta.mimeType?.startsWith('application/vnd.google-apps.'), 'SOURCE_TYPE_CHANGED');
  MP_SYNC.contentStamp(meta);
  const location = MP_SYNC.sourceFolderLocation(meta, pr.root.source, id => {
    if (!pr.folders.has(id)) pr.folders.set(id, prPrivate(prMeta(id), null, PR_FOLDER)); return pr.folders.get(id);
  });
  prAssert(location.withinConfiguredFolder, 'SOURCE_MOVED_OUTSIDE');
}
function prWrite(id, name, text, parent, { folder = false, expected } = {}) {
  const r = pr.root;
  prAssert(parent === r.system || parent === r.derived || folder && parent === r.running && name === 'system', 'WRITE_PARENT_FORBIDDEN');
  prPrivate(prMeta(parent), null, PR_FOLDER);
  const before = prMeta(id, true), mimeType = folder ? PR_FOLDER : 'application/json';
  const content = text === undefined ? '' : typeof text === 'string' ? text : prJson(text);
  prAssert(prBytes(content).length <= PR_LIMIT, 'JSON_SIZE_LIMIT');
  if (before) {
    prPrivate(before, parent, mimeType); prAssert(before.name === name, 'OUTPUT_NAME_CHANGED');
    if (folder) return before;
    if (expected) { const current = mpHash(prRead(before, parent)); prAssert(current === expected || current === mpHash(content), 'CATALOG_CHANGED_EXTERNALLY'); }
    if (before.md5Checksum === prDigest(Utilities.DigestAlgorithm.MD5, prBytes(content))) return before;
    // Only the checkpoint, cache pages and the one registered catalog mutate.
    prAssert(id === r.state || /^unit-page-\d+\.json$/.test(name) && parent === r.system || id === r.catalog && name === 'index.json', 'IMMUTABLE_CHANGED');
  }
  const metadata = { id, name, mimeType, parents: [parent], appProperties: { mypaceRunning: r.job, role: folder ? 'folder' : 'managed' } };
  const boundary = 'mypace_running_' + r.job;
  const payload = before ? content : folder ? JSON.stringify(metadata) : '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'
    + JSON.stringify(metadata) + '\r\n--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + content + '\r\n--' + boundary + '--\r\n';
  const path = before ? 'https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media&fields=' + encodeURIComponent(PR_FIELDS)
    : 'https://www.googleapis.com/' + (folder ? '' : 'upload/') + 'drive/v3/files?ignoreDefaultVisibility=true' + (folder ? '' : '&uploadType=multipart') + '&fields=' + encodeURIComponent(PR_FIELDS);
  const method = before ? 'patch' : 'post';
  pr.writePermit = path + '\n' + method + '\n' + payload;
  let after;
  try { after = JSON.parse(prFetch(path, { method, payload, contentType: before || folder ? 'application/json' : 'multipart/related; boundary=' + boundary }).getContentText('UTF-8')); }
  finally { pr.writePermit = null; }
  prPrivate(after, parent, mimeType);
  if (!folder) prAssert(after.md5Checksum === prDigest(Utilities.DigestAlgorithm.MD5, prBytes(content)), 'WRITE_INTEGRITY');
  return after;
}
function prReserve(count) { const ids = prApi('files/generateIds?count=' + count + '&space=drive&type=files').ids; prAssert(ids?.length === count, 'RESERVED_IDS_REQUIRED'); return ids; }
function prSave() {
  pr.saving = true;
  try { prWrite(pr.root.state, 'checkpoint.json', pr.state, pr.root.system); }
  finally { pr.saving = false; }
}
function prAllocate(key) {
  const s = pr.state;
  if (!s.ids[key]) {
    if (!s.pool.length) { s.pool = prReserve(50); prSave(); }
    s.ids[key] = s.pool.shift(); // The saved pool is replayable after a lost write.
  }
  return s.ids[key];
}
// Cache units are packed: replay reads a page, not two Drive requests per tile.
// The page write precedes its checkpoint index, making interrupted appends safe.
function prUnitRead(key) {
  const page = pr.state.units[key]; if (page === undefined) return undefined;
  if (!pr.pages.has(page)) pr.pages.set(page, prValue(pr.state.pages[page], pr.root.system));
  const values = pr.pages.get(page); prAssert(Object.prototype.hasOwnProperty.call(values, key), 'UNIT_MISSING'); return values[key];
}
function prUnitPut(key, value) {
  const s = pr.state; let page = s.pages.length - 1, values = page >= 0 ? (pr.pages.get(page) || prValue(s.pages[page], pr.root.system)) : {};
  if (page < 0 || prBytes(prJson({ ...values, [key]: value })).length > 524288) {
    page = s.pages.length; const id = prAllocate('unit-page-' + page); s.pages.push(id); values = {};
  }
  values[key] = value; pr.pages.set(page, values);
  prWrite(s.pages[page], 'unit-page-' + page + '.json', values, pr.root.system);
  s.units[key] = page; prSave(); return value;
}
function prUnit(kind, key, compute) {
  const hash = mpHash({ kind, key }), existing = prUnitRead(hash);
  if (existing !== undefined) { prCount(kind + 'Reused'); return existing; }
  prYield(); const value = compute(); prUnitPut(hash, value); prCount(kind + 'Computed'); return value;
}
function prPersistBudget() { prSet('BUDGET', pr.budget); }
function prBudgetBegin(recovery = false) {
  const now = Date.now(), old = prGet('BUDGET');
  const b = old || { since: now, hours: {}, requests: 0, measuredMs: 0, accountedMs: 0 };
  if (!old) {
    const previous = JSON.parse(pr.props.getProperty('MYPACE_NEW_CSV_V1_BUDGET') || 'null');
    b.hours = previous?.hours || {};
    if (Object.keys(b.hours).some(h => +h >= Math.floor(now / 3600000) - 24)) {
      const metrics = JSON.parse(pr.props.getProperty('MYPACE_NEW_CSV_V1_METRICS') || '{}'); b.requests = metrics.requests || 0;
    }
  }
  if (now - b.since >= 25 * 3600000) { b.since = now; b.requests = 0; }
  for (const h of Object.keys(b.hours)) if (+h < Math.floor(now / 3600000) - 24) delete b.hours[h];
  pr.budget = b;
  const used = Object.values(b.hours).reduce((a, n) => a + n, 0);
  // Manual rollback restores one small catalog outside the worker's internal
  // budget. It still cannot bypass Google's actual quota.
  if (!recovery && (used + 360000 > 45 * 60000 || b.requests >= 12000)) {
    const next = b.requests >= 12000 ? b.since + 25 * 3600000 : (Math.min(...Object.keys(b.hours).map(Number)) + 25) * 3600000;
    prSet('NEXT_AT', Math.max(now + 300000, next)); prPersistBudget(); throw Error('BUDGET_WAIT');
  }
  const hour = Math.floor(now / 3600000); b.hours[hour] = (b.hours[hour] || 0) + 360000;
  pr.hour = hour; pr.recovery = recovery; prPersistBudget();
}
function prBudgetEnd() {
  if (pr.hour === undefined) return;
  const measured = Date.now() - pr.started, accounted = Math.max(measured + 5000, 5000);
  pr.budget.hours[pr.hour] += accounted - 360000; pr.budget.measuredMs += measured; pr.budget.accountedMs += accounted; prPersistBudget();
}
function prDeleteTriggers(handler) { for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t); }
function prSchedule() {
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === PR_TICK)) ScriptApp.newTrigger(PR_TICK).timeBased().everyMinutes(5).create();
  prDeleteTriggers(PR_WAKE); prSet('NEXT_AT', null);
}
function prSleepUntil(time) {
  // A currently executing one-shot may still appear in getProjectTriggers().
  // Always replace it; otherwise a second budget wait could have no wake-up.
  const old = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === PR_WAKE);
  ScriptApp.newTrigger(PR_WAKE).timeBased().after(Math.max(60000, time - Date.now())).create();
  for (const trigger of old) ScriptApp.deleteTrigger(trigger);
  prDeleteTriggers(PR_TICK);
}
