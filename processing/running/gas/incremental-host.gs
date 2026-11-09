// A bounded, isolated experiment. Never deploy this as the application's reader.
const MYPACE_PROBE_CONFIG = __MYPACE_PROBE_CONFIG__;
const MI_KEY = 'MYPACE_INCREMENTAL_V1', MI_HANDLER = 'myPaceIncrementalTick';
const MI_FIELDS = 'id,name,mimeType,size,md5Checksum,version,parents,trashed,ownedByMe,shared,appProperties';
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
function miConfig() {
  const c = MYPACE_PROBE_CONFIG;
  miAssert(c?.sources?.length === 3 && c.references?.length === MP_SYNC.syncStages().length && c.chunkBytes === 1048576, 'PRIVATE_INCREMENTAL_CONFIG_REQUIRED');
  miId(c.sourceFolder);
  for (const s of c.sources) { miId(s.id); miAssert(s.key && s.size > 0 && s.size <= 536870912 && s.chunks?.length === Math.ceil(s.size / c.chunkBytes), 'SOURCE_CONFIG_INVALID'); }
  return c;
}
function miYield() { if (Date.now() - mi.started >= 90000) throw Error('YIELD'); }
function miStop() { for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === MI_HANDLER) ScriptApp.deleteTrigger(t); }
function miSchedule() { if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === MI_HANDLER)) ScriptApp.newTrigger(MI_HANDLER).timeBased().everyMinutes(5).create(); }

function miFetch(path, options) {
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
function miOwned(meta, role, parent, allowTrashed) {
  miAssert(meta && meta.ownedByMe === true && meta.shared === false && (allowTrashed || !meta.trashed), 'OUTPUT_NOT_OWNER_PRIVATE');
  miAssert(meta.appProperties?.mypaceIncremental === mi.root.job && meta.appProperties?.role === role, 'OUTPUT_MARKER_CHANGED');
  if (parent) miAssert(meta.parents?.length === 1 && meta.parents[0] === parent, 'OUTPUT_PARENT_CHANGED');
}
function miMetadata(id, name, role, parent, extra) {
  return { id, name, mimeType: role === 'folder' ? 'application/vnd.google-apps.folder' : role === 'fixture' ? 'text/csv' : 'application/json',
    ...(parent ? { parents: [parent] } : {}), appProperties: { mypaceIncremental: mi.root.job, role, ...extra } };
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
function miSave() { miWrite(mi.root.state, 'checkpoint.json', mi.state, 'state', mi.root.system, false); }
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

/** List every page before accepting the snapshot. No CSV or checkpoint body is
 * fetched by this function; the same code is used for idle measurement. */
function miInventory() {
  const began = Date.now(), priorCategory = mi.category; mi.category = 'poll';
  try {
    const folder = miMeta(mi.root.raw); miOwned(folder, 'folder', mi.root.folder);
    const files = {}, pages = new Set(); let token;
    do {
      miYield(); miAssert(!pages.has(token), 'DRIVE_PAGE_LOOP'); pages.add(token);
      const page = miApi('files?q=' + encodeURIComponent("'" + mi.root.raw + "' in parents and trashed = false")
        + '&spaces=drive&pageSize=1000&fields=' + encodeURIComponent('nextPageToken,incompleteSearch,files(' + MI_FIELDS + ')')
        + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
      miAssert(!page.incompleteSearch && Array.isArray(page.files), 'DRIVE_INCOMPLETE_INVENTORY');
      for (const file of page.files) {
        miOwned(file, 'fixture', mi.root.raw);
        miAssert(!files[file.id] && /\.csv$/i.test(file.name) && file.appProperties.key && !file.mimeType.startsWith('application/vnd.google-apps.'), 'UNEXPECTED_INPUT_FILE');
        MP_SYNC.contentStamp(file); files[file.id] = file;
      }
      token = page.nextPageToken;
    } while (token);
    miCount('polls'); miCount('pollMs', Date.now() - began); return files;
  } finally { mi.category = priorCategory; }
}
function miSpec(key, variant) {
  if (key === 'control') return miConfig().control[variant === 'open' ? 'open' : 'closed'];
  const source = miConfig().sources.find(s => s.key === key); miAssert(source, 'UNKNOWN_SOURCE_KEY'); return source;
}
function miCheckExpected(files, stage) {
  const keys = Object.values(files).map(f => f.appProperties.key).sort();
  miAssert(JSON.stringify(keys) === JSON.stringify([...stage.active].sort()), 'FIXTURE_INVENTORY_MISMATCH');
  for (const f of Object.values(files)) {
    const spec = miSpec(f.appProperties.key, stage.variant);
    miAssert(Number(f.size) === spec.size && f.md5Checksum === spec.md5, 'FIXTURE_CONTENT_MISMATCH');
  }
}
function miMutateFixture(stage) {
  if (stage.action === 'none') return;
  miOwned(miMeta(mi.root.raw), 'folder', mi.root.folder); miOwned(miMeta(mi.root.parked), 'folder', mi.root.folder);
  const key = stage.key, id = miAllocate('fixture-' + key), source = miSpec(key, stage.variant);
  let meta = miMeta(id, true);
  if (stage.action === 'add') {
    if (!meta) {
      const metadata = miMetadata(id, key + '.csv', 'fixture', mi.root.raw, { key });
      if (key === 'control') meta = miCreate(metadata, MP_SYNC.controlCsv(false));
      else {
        const original = miMeta(source.id);
        const config = miConfig(), diagnosis = MP_SYNC.originalSourceDiagnostics(original, source, config.sourceFolder, config.sources.indexOf(source));
        if (!diagnosis.passesOriginalGuard) {
          const error = Error('ORIGINAL_SOURCE_CHANGED'); error.sourceDiagnostics = diagnosis; throw error;
        }
        meta = miApi('files/' + miId(source.id) + '/copy?ignoreDefaultVisibility=true&fields=' + encodeURIComponent(MI_FIELDS), 'post', metadata);
      }
    }
    miOwned(meta, 'fixture', mi.root.raw);
    miAssert(meta.md5Checksum === source.md5 && Number(meta.size) === source.size, 'FIXTURE_COPY_MISMATCH'); return;
  }
  miOwned(meta, 'fixture', null, true);
  miAssert(meta.parents?.length === 1 && [mi.root.raw, mi.root.parked].includes(meta.parents[0]) && meta.appProperties.key === key, 'FIXTURE_PARENT_CHANGED');
  const path = 'files/' + id, fields = '&fields=' + encodeURIComponent(MI_FIELDS);
  if (stage.action === 'edit') {
    const content = MP_SYNC.controlCsv(true);
    if (meta.md5Checksum !== source.md5) meta = miApi(path + '?uploadType=media' + fields, 'patch', content, true);
    miAssert(meta.md5Checksum === source.md5, 'FIXTURE_EDIT_MISMATCH');
  } else if (stage.action === 'rename') {
    if (meta.name !== 'renamed-source.csv') miApi(path + '?fields=' + encodeURIComponent(MI_FIELDS), 'patch', { name: 'renamed-source.csv' });
  } else if (stage.action === 'move_out' || stage.action === 'move_back') {
    const target = stage.action === 'move_out' ? mi.root.parked : mi.root.raw;
    if (meta.parents[0] !== target) miApi(path + '?addParents=' + target + '&removeParents=' + meta.parents[0] + fields, 'patch', {});
  } else if (stage.action === 'trash' || stage.action === 'restore') {
    const trashed = stage.action === 'trash';
    if (!!meta.trashed !== trashed) miApi(path + '?fields=' + encodeURIComponent(MI_FIELDS), 'patch', { trashed });
  } else throw Error('UNKNOWN_FIXTURE_ACTION');
}

function miNormalize() {
  const s = mi.state, job = s.job, file = job.files[job.queue[job.next]], key = file.appProperties.key;
  const signature = mpHash({ id: file.id, content: MP_SYNC.contentStamp(file), algorithm: MP_DERIVE.ALGORITHM });
  if (s.normalized[signature]) { job.next++; job.parser = null; job.offset = 0; miCount('normalizedReused'); miSave(); return; }
  const spec = miSpec(key, MP_SYNC.syncStages()[s.stage].variant);
  if (!job.parser?.finished) {
    const from = job.offset, to = Math.min(Number(file.size), from + miConfig().chunkBytes) - 1;
    if (from === 0) {
      const current = miMeta(file.id); miOwned(current, 'fixture', mi.root.raw);
      miAssert(MP_SYNC.contentStamp(current) === MP_SYNC.contentStamp(file), 'SOURCE_CHANGED_DURING_READ');
    }
    miCount('rawBytesRequested', to - from + 1);
    const response = miFetch('https://www.googleapis.com/drive/v3/files/' + file.id + '?alt=media', { headers: { Range: 'bytes=' + from + '-' + to } });
    const headers = response.getAllHeaders(), rangeKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-range');
    miAssert(response.getResponseCode() === 206 && headers[rangeKey] === 'bytes ' + from + '-' + to + '/' + file.size, 'RANGE_NOT_HONORED');
    const bytes = response.getBlob().getBytes();
    miAssert(bytes.length === to - from + 1 && miDigest(Utilities.DigestAlgorithm.SHA_256, bytes) === spec.chunks[Math.floor(from / miConfig().chunkBytes)], 'SOURCE_CHUNK_MISMATCH');
    job.parser = MP_CORE.parseChunk(job.parser, bytes, to + 1 === Number(file.size)); job.offset = to + 1; miSave(); miCount('csvChunks'); return;
  }
  const current = miMeta(file.id); miOwned(current, 'fixture', mi.root.raw);
  miAssert(MP_SYNC.contentStamp(current) === MP_SYNC.contentStamp(file), 'SOURCE_CHANGED_DURING_READ');
  const parsed = job.parser.finished, value = { key, start: parsed.start, end: parsed.end,
    gpsHash: mpHash({ start: parsed.start, end: parsed.end, fixes: parsed.fixes }), runs: MP_DERIVE.deriveSource(parsed) };
  const id = miAllocate('normalized-' + signature);
  miWrite(id, 'normalized-' + signature + '.json', value, 'normalized', mi.root.system, true);
  s.normalized[signature] = id; job.next++; job.parser = null; job.offset = 0; miSave(); miCount('normalizedComputed');
}
function miAssemble() {
  const s = mi.state, job = s.job;
  const resultKey = { algorithm: MP_DERIVE.ALGORITHM, input: MP_SYNC.inventorySignature(job.files) };
  const cachedResult = s.cache[mpHash({ kind: 'assembled', key: resultKey })];
  if (cachedResult) {
    const previous = miRead(cachedResult, 'cache');
    miAssert(mpHash(previous.catalogContent) === miConfig().references[s.stage], 'REFERENCE_CATALOG_MISMATCH');
    job.result = cachedResult; job.phase = 'objects'; job.objectIndex = 0; miCount('assembledReused'); miSave(); return;
  }
  const values = Object.values(job.files).map(f => miRead(s.normalized[mpHash({ id: f.id, content: MP_SYNC.contentStamp(f), algorithm: MP_DERIVE.ALGORITHM })], 'normalized'));
  const runs = MP_SYNC.normalizedRuns(values, mpHash), descriptions = MP_INCREMENTAL.describeRuns(runs);
  const cached = (kind, key, compute) => miUnit(kind, key, compute);
  const fresh = MP_INCREMENTAL.incrementalFresh(descriptions, cached);
  const stats = { explorationCellVisits: 0 }, mask = MP_MASK.incrementalMask(descriptions, cached, stats);
  const result = miUnit('assembled', resultKey, () => MP_CORE.assembleProbeArtifacts(runs, fresh, mask, { hash: mpHash, byteLength: x => miBytes(x).length, cached }));
  miAssert(mpHash(result.catalogContent) === miConfig().references[s.stage], 'REFERENCE_CATALOG_MISMATCH');
  job.result = s.cache[mpHash({ kind: 'assembled', key: resultKey })]; job.phase = 'objects'; job.objectIndex = 0; miSave();
}
function miResult() {
  if (!mi.result) mi.result = miRead(mi.state.job.result, 'cache'); return mi.result;
}
function miRecordStage(unchanged) {
  const s = mi.state, stage = MP_SYNC.syncStages()[s.stage], metrics = miGet('METRICS', {});
  const delta = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, v - (s.stageStart.metrics[k] || 0)]));
  if (['unchanged', 'rename', 'final_unchanged', 'move_out', 'move_back', 'trash', 'restore'].includes(stage.name)) miAssert(!delta.rawBytesRequested, 'UNCHANGED_SOURCE_WAS_DOWNLOADED');
  if (unchanged) miAssert(!delta.normalizedComputed && !delta.displayComputed && !delta.freshComputed && !delta.corridorComputed, 'UNCHANGED_DATA_WAS_RECOMPUTED');
  s.results.push({ name: stage.name, matched: true, unchanged, changes: s.diff, elapsedSeconds: Math.ceil((Date.now() - s.stageStart.time) / 1000), ...delta });
  s.stage++; s.phase = s.stage === MP_SYNC.syncStages().length ? 'done' : 'action'; s.job = null; s.stageStart = null; miSave();
}
function miStep() {
  const s = mi.state, stage = MP_SYNC.syncStages()[s.stage];
  if (s.phase === 'action') {
    if (!s.stageStart) { s.stageStart = { time: Date.now(), metrics: miGet('METRICS', {}) }; miSave(); }
    mi.category = 'fixture'; miMutateFixture(stage); mi.category = 'processing';
    s.phase = 'observe'; s.observed = null; miSave(); throw Error('YIELD'); // Discover on a later cold invocation.
  }
  if (s.phase === 'observe') {
    const files = miInventory(); miCheckExpected(files, stage);
    const signature = mpHash(MP_SYNC.inventorySignature(files));
    if (s.observed !== signature) { s.observed = signature; miSave(); throw Error('YIELD'); }
    const diff = MP_SYNC.inventoryDiff(s.committed, files);
    s.diff = Object.fromEntries(['added', 'changed', 'removed', 'renamed'].map(k => [k, diff[k].length]));
    if (!diff.contentChanged && s.catalogHash) {
      miAssert(s.catalogHash === miConfig().references[s.stage], 'REFERENCE_CATALOG_MISMATCH'); s.committed = files; miRecordStage(true); return;
    }
    s.job = { files, phase: 'normalize', queue: Object.keys(files).sort(), next: 0, offset: 0, parser: null };
    s.phase = 'process'; miSave(); return;
  }
  if (s.phase === 'process') {
    const job = s.job;
    if (job.phase === 'normalize') {
      if (job.next < job.queue.length) { miNormalize(); return; }
      job.phase = 'compute'; miSave(); return;
    }
    if (job.phase === 'compute') { miAssemble(); return; }
    const result = miResult();
    if (job.phase === 'objects') {
      if (job.objectIndex < result.objects.length) {
        const object = result.objects[job.objectIndex], name = object.path.slice(8), id = miAllocate('artifact-' + name);
        if (!s.artifacts[name]) {
          miWrite(id, name, object.content, 'artifact', mi.root.derived, true); s.artifacts[name] = id; miCount('objectsCreated');
        } else miCount('objectsReused');
        job.objectIndex++; miSave(); return;
      }
      job.phase = 'verify'; job.verifyIndex = 0; miSave(); return;
    }
    if (job.phase === 'verify') {
      mi.category = 'verification';
      if (job.verifyIndex < result.objects.length) {
        const object = result.objects[job.verifyIndex], name = object.path.slice(8);
        miAssert(mpHash(miRead(s.artifacts[name], 'artifact', mi.root.derived)) === name.slice(0, -5), 'ARTIFACT_READBACK_MISMATCH');
        job.verifyIndex++; miSave(); return;
      }
      const current = miInventory(); miCheckExpected(current, stage);
      miAssert(mpHash(MP_SYNC.inventorySignature(current)) === mpHash(MP_SYNC.inventorySignature(job.files)), 'SOURCE_CHANGED_BEFORE_PUBLICATION');
      miWrite(mi.root.catalog, 'index.json', result.catalogContent, 'catalog', mi.root.derived, false);
      miAssert(mpHash(miRead(mi.root.catalog, 'catalog', mi.root.derived)) === miConfig().references[s.stage], 'CATALOG_READBACK_MISMATCH');
      s.committed = current; s.catalogHash = miConfig().references[s.stage]; miRecordStage(false); return;
    }
  }
  miAssert(s.phase === 'done', 'UNKNOWN_PHASE');
}

function miSetup() {
  if (!mi.root) {
    const ids = miApi('files/generateIds?count=8&space=drive&type=files').ids;
    miAssert(ids?.length === 8, 'RESERVED_IDS_REQUIRED');
    mi.root = { job: Utilities.getUuid(), script: ScriptApp.getScriptId(), config: mpHash(miConfig()), started: Date.now(),
      folder: ids[0], raw: ids[1], derived: ids[2], system: ids[3], parked: ids[4], state: ids[5], catalog: ids[6], report: ids[7] }; miSet('ROOT', mi.root);
  }
  const root = mi.root;
  for (const [key, name, parent] of [['folder', 'MyPace 差分更新検証 ' + root.job.slice(0, 8), null], ['raw', 'raw', root.folder],
    ['derived', 'derived', root.folder], ['system', 'system', root.folder], ['parked', 'parked', root.folder]]) {
    const meta = miMeta(root[key], true) || miCreate(miMetadata(root[key], name, 'folder', parent)); miOwned(meta, 'folder', parent);
  }
  if (!miMeta(root.state, true)) {
    mi.state = { phase: 'action', stage: 0, committed: {}, catalogHash: null, pool: [], ids: {}, cache: {}, normalized: {}, artifacts: {}, results: [] }; miSave();
  }
}
function miReport(status) {
  const budget = miGet('BUDGET', { totalMs: 0, maximumMs: 0 }), metrics = miGet('METRICS', {}), stage = miGet('SUMMARY', {}), idle = miGet('IDLE', null);
  if (idle) {
    idle.measuredExecutionSeconds = Math.ceil(((idle.endMeasuredMs ?? budget.measuredMs ?? 0) - idle.startMeasuredMs) / 1000);
    idle.accountedExecutionSeconds = Math.ceil(((idle.endAccountedMs ?? budget.totalMs ?? 0) - idle.startAccountedMs) / 1000);
    delete idle.baseline; delete idle.metricsStart; delete idle.startMeasuredMs; delete idle.startAccountedMs;
  }
  return { schema: 1, kind: 'running-incremental-benchmark', environment: miConfig().environment || 'apps-script',
    status: status || miGet('STATUS', 'NOT_STARTED'), scope: 'ISOLATED_INCREMENTAL_AND_IDLE_PROBE',
    ...stage, results: Array.from({ length: stage.completedStages || 0 }, (_, i) => ({ ...miGet('RESULT_' + i, {}), measuredWorkSeconds: Math.ceil(miGet('WORK_' + i, 0) / 1000) })),
    metrics, accountedExecutionSeconds: Math.ceil((budget.totalMs || 0) / 1000),
    measuredExecutionSeconds: Math.ceil((budget.measuredMs || 0) / 1000), maximumExecutionSeconds: Math.ceil((budget.maximumMs || 0) / 1000),
    interruptedInvocations: miGet('INTERRUPTIONS', 0), lastError: miGet('LAST_ERROR', null), idle, includesOtherScripts: false };
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

function miIdle(start) {
  let idle = miGet('IDLE', null);
  if (start && !idle) {
    miAssert(miGet('SUMMARY', {}).functionalPassed === true, 'FUNCTIONAL_PROBE_REQUIRED');
    const files = miInventory(), budget = miGet('BUDGET'); idle = { started: Date.now(), deadline: Date.now() + 86400000, polls: 0, baseline: mpHash(MP_SYNC.inventorySignature(files)),
      startMeasuredMs: budget.measuredMs, startAccountedMs: budget.totalMs - 360000,
      startInterruptions: miGet('INTERRUPTIONS', 0),
      metricsStart: miGet('METRICS', {}), pollDurationsMs: [], completed: false }; miSet('IDLE', idle); miSet('MODE', 'idle');
  }
  miAssert(idle, 'IDLE_START_REQUIRED');
  if (idle.completed) return idle.passesCadence ? 'IDLE_PASS' : 'IDLE_CADENCE_MISSED';
  if (Date.now() - idle.started > 108000000) throw Error('IDLE_DEADLINE_MISSED');
  const began = Date.now(), files = miInventory();
  miAssert(mpHash(MP_SYNC.inventorySignature(files)) === idle.baseline, 'IDLE_INPUT_CHANGED');
  idle.polls++; idle.pollDurationsMs.push(Date.now() - began);
  // Bounded at 300 observations. Large gaps are retained in the wall clock report.
  miAssert(idle.pollDurationsMs.length <= 300, 'IDLE_POLL_LIMIT');
  const m = miGet('METRICS', {});
  idle.requests = (m.requests || 0) - (idle.metricsStart.requests || 0);
  idle.rawBytesRequested = (m.rawBytesRequested || 0) - (idle.metricsStart.rawBytesRequested || 0);
  miAssert(idle.rawBytesRequested === 0, 'IDLE_RAW_DATA_READ');
  if (Date.now() >= idle.deadline) {
    idle.completed = true; idle.elapsedSeconds = Math.ceil((Date.now() - idle.started) / 1000);
    idle.totalPollMs = idle.pollDurationsMs.reduce((a, n) => a + n, 0);
    idle.maximumPollMs = Math.max(...idle.pollDurationsMs); idle.completedAt = Date.now();
    idle.passesCadence = idle.polls >= 240; miStop();
  }
  miSet('IDLE', idle); return idle.completed ? (idle.passesCadence ? 'IDLE_PASS' : 'IDLE_CADENCE_MISSED') : 'IDLE_RUNNING';
}
function miRun(command) {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) return { status: 'BUSY' };
  mi = { props: PropertiesService.getScriptProperties(), started: Date.now(), memory: new Map(), category: 'setup' };
  let status;
  try {
    miConfig(); mi.root = miGet('ROOT', null);
    if (mi.root) miAssert(mi.root.script === ScriptApp.getScriptId() && mi.root.config === mpHash(miConfig()), 'PROJECT_OR_CONFIG_CHANGED');
    if (command === 'stop') { miStop(); status = 'USER_STOPPED'; return { status }; }
    if (command === 'report') { const report = miReport(); console.log(JSON.stringify(report)); return report; }
    miBudgetBegin(); miCount('invocations');
    if (command === 'start') { miSetup(); miSet('MODE', miGet('MODE', 'functional')); miSchedule(); status = 'SCHEDULED'; return { status }; }
    miAssert(mi.root, 'START_REQUIRED');
    if (command === 'idle' || miGet('MODE') === 'idle') {
      status = miIdle(command === 'idle'); if (status === 'IDLE_RUNNING') miSchedule(); return { status };
    }
    miAssert(Date.now() - mi.root.started < 86400000, 'FUNCTIONAL_DEADLINE_MISSED');
    mi.category = 'processing';
    miOwned(miMeta(mi.root.folder), 'folder'); miOwned(miMeta(mi.root.system), 'folder', mi.root.folder); miOwned(miMeta(mi.root.derived), 'folder', mi.root.folder);
    mi.state = miRead(mi.root.state, 'state');
    while (mi.state.phase !== 'done') {
      miYield(); const stage = mi.state.stage, began = Date.now();
      try { miStep(); } finally { miSet('WORK_' + stage, miGet('WORK_' + stage, 0) + Date.now() - began); }
    }
    status = 'FUNCTIONAL_PASS'; miStop();
  } catch (error) {
    status = miCode(error);
    if (status !== 'YIELD') miSet('LAST_ERROR', { code: status, driveReasons: error.driveReasons || [], observedAt: Date.now(),
      ...(error.sourceDiagnostics ? { sourceDiagnostics: error.sourceDiagnostics } : {}) });
    if (status === 'YIELD') { status = 'IN_PROGRESS'; miCount('scheduledResumes'); }
    else if (['DRIVE_RETRYABLE', 'DRIVE_TRANSPORT_ERROR'].includes(status)) miCount('retryableErrors');
    else miStop();
  } finally {
    try {
      if (command !== 'report') {
        miSet('STATUS', status || 'STOPPED');
        if (mi.state) {
          for (let i = 0; i < mi.state.results.length; i++) miSet('RESULT_' + i, mi.state.results[i]);
          miSet('SUMMARY', { completedStages: mi.state.results.length, stageCount: MP_SYNC.syncStages().length,
            currentStage: MP_SYNC.syncStages()[mi.state.stage]?.name || 'done', functionalPassed: status === 'FUNCTIONAL_PASS' });
        }
        miBudgetEnd();
        if (status === 'IDLE_PASS') {
          const idle = miGet('IDLE');
          if (idle.endAccountedMs - idle.startAccountedMs > 1800000 || idle.maximumExecutionMs > 240000 || miGet('INTERRUPTIONS', 0) > idle.startInterruptions) { status = 'IDLE_TIMING_MISSED'; miSet('STATUS', status); }
        }
        if (status === 'FUNCTIONAL_PASS' && (miGet('BUDGET').maximumMs > 240000 || miGet('INTERRUPTIONS', 0))) { status = 'FUNCTIONAL_TIMING_MISSED'; miSet('STATUS', status); const s = miGet('SUMMARY'); s.functionalPassed = false; miSet('SUMMARY', s); }
        console.log(JSON.stringify(miReport(status)));
      }
    } finally { lock.releaseLock(); mi = null; }
  }
  return { status };
}
function startMyPaceIncrementalProbe() { return miRun('start'); }
function myPaceIncrementalTick() { return miRun('tick'); }
function startMyPaceIdleProbe() { return miRun('idle'); }
function stopMyPaceIncrementalProbe() { return miRun('stop'); }
function showMyPaceIncrementalProbeReport() { return miRun('report'); }

/** Read-only diagnosis, independent of miRun/miFetch: no Drive writes, media
 * downloads, checkpoint/property updates, budget resets or trigger changes.
 * Run in the same stopped project, using the unchanged private configuration. */
function diagnoseMyPaceOriginalSources() {
  const lock = LockService.getScriptLock(), emit = value => { console.log(JSON.stringify(value, null, 2)); return value; };
  if (!lock.tryLock(1000)) return emit({ kind: 'original-source-diagnostic', status: 'BUSY' });
  try {
    const config = miConfig(), props = PropertiesService.getScriptProperties();
    const saved = props.getProperty(MI_KEY + '_ROOT'), root = saved ? JSON.parse(saved) : null;
    const configurationMatchesRun = root ? root.script === ScriptApp.getScriptId() && root.config === mpHash(config) : null;
    const report = { schema: 1, kind: 'original-source-diagnostic', metadataOnly: true, configurationMatchesRun, sources: [] };
    if (configurationMatchesRun === false) return emit({ ...report, status: 'DIAGNOSTIC_CONFIG_MISMATCH' });
    const fields = 'ownedByMe,shared,trashed,parents,size,md5Checksum';
    for (let index = 0; index < config.sources.length; index++) {
      const source = config.sources[index]; let response;
      try {
        response = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + miId(source.id) + '?fields=' + encodeURIComponent(fields),
          { method: 'get', muteHttpExceptions: true, followRedirects: false, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
      } catch {
        report.sources.push({ source: index + 1, metadataReadable: false, error: 'METADATA_TRANSPORT_ERROR' }); continue;
      }
      const status = response.getResponseCode();
      if (status !== 200) { report.sources.push({ source: index + 1, metadataReadable: false, error: 'METADATA_HTTP_ERROR', httpStatus: status }); continue; }
      try {
        const meta = JSON.parse(response.getContentText('UTF-8'));
        miAssert(meta && typeof meta === 'object' && !Array.isArray(meta), 'METADATA_RESPONSE_INVALID');
        report.sources.push({ metadataReadable: true, ...MP_SYNC.originalSourceDiagnostics(meta, source, config.sourceFolder, index) });
      } catch { report.sources.push({ source: index + 1, metadataReadable: false, error: 'METADATA_RESPONSE_INVALID' }); }
    }
    report.status = report.sources.some(s => !s.metadataReadable) ? 'DIAGNOSTIC_INCOMPLETE'
      : report.sources.some(s => !s.passesOriginalGuard) ? 'ORIGINAL_SOURCE_CHECK_FAILED'
      : report.sources.some(s => s.missingFields.length || s.invalidFields.length) ? 'METADATA_FIELDS_INCOMPLETE' : 'ORIGINAL_SOURCE_CHECKS_PASSED';
    return emit(report);
  } catch { return emit({ schema: 1, kind: 'original-source-diagnostic', status: 'DIAGNOSTIC_SETUP_INVALID' }); }
  finally { lock.releaseLock(); }
}
