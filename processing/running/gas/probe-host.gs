// A separate, owner-only Apps Script experiment. No doGet/doPost/web deployment.
// Source IDs and expected hashes are inserted only in the ignored private kit.
const MYPACE_PROBE_CONFIG = __MYPACE_PROBE_CONFIG__;
const MP_KEY = 'MYPACE_RUNNING_THREE_CSV_V1';
const MP_HANDLER = 'myPaceProbeTick';
let mpContext;

function mpJson(value) { return JSON.stringify(value) + '\n'; }
function mpBytes(text) { return Utilities.newBlob(text).getBytes(); }
function mpHash(value) {
  return mpDigest(Utilities.DigestAlgorithm.SHA_256, typeof value === 'string' ? mpBytes(value) : mpBytes(mpJson(value)));
}
function mpDigest(algorithm, bytes) {
  return Utilities.computeDigest(algorithm, bytes).map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}
function mpAssert(condition, code) { if (!condition) throw Error(code); }
function mpId(value) { mpAssert(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), 'INVALID_FILE_ID'); return value; }
function mpCode(error) { return /^[A-Z][A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'UNEXPECTED_ERROR'; }
function mpConfig() {
  const c = MYPACE_PROBE_CONFIG;
  mpAssert(c && c.sources?.length === 3 && new Set(c.sources.map(s => s.id)).size === 3, 'PRIVATE_THREE_SOURCE_CONFIG_REQUIRED');
  mpAssert(c.chunkBytes === 1024 * 1024 && c.expectedCatalogHash?.length === 64, 'PRIVATE_REFERENCE_REQUIRED');
  mpId(c.sourceFolder);
  for (const source of c.sources) {
    mpId(source.id);
    mpAssert(source.size > 0 && source.size <= 512 * 1024 * 1024 && /^[a-f0-9]{32}$/.test(source.md5), 'SOURCE_CONFIG_INVALID');
    mpAssert(source.chunks.length === Math.ceil(source.size / c.chunkBytes) && source.chunks.every(h => /^[a-f0-9]{64}$/.test(h)), 'SOURCE_CHUNK_REFERENCE_REQUIRED');
  }
  return c;
}

function mpFetch(path, options) {
  const c = mpContext;
  mpAssert(c && /^https:\/\/www\.googleapis\.com\/(?:upload\/)?drive\/v3\//.test(path), 'INVALID_REQUEST');
  const count = Number(c.props.getProperty(MP_KEY + '_CALLS') || '0');
  mpAssert(count < 3000, 'REQUEST_BUDGET_REACHED');
  // Reserve before the service call, so timeout/lost acknowledgements count too.
  c.props.setProperty(MP_KEY + '_CALLS', String(count + 1));
  const began = Date.now();
  let response;
  try {
    response = UrlFetchApp.fetch(path, { muteHttpExceptions: true, followRedirects: false, ...options,
      headers: { ...(options?.headers || {}), Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
  } catch { throw Error('DRIVE_TRANSPORT_ERROR'); }
  c.networkMs += Date.now() - began;
  const status = response.getResponseCode();
  if (status === 404) throw Error('DRIVE_HTTP_404');
  if (status === 429 || status >= 500) throw Error('DRIVE_RETRYABLE');
  mpAssert(status >= 200 && status < 300, 'DRIVE_HTTP_' + status);
  return response;
}
function mpApi(path, method, data, upload) {
  const url = 'https://www.googleapis.com/' + (upload ? 'upload/' : '') + 'drive/v3/' + path;
  const response = mpFetch(url, { method: method || 'get', ...(data === undefined ? {} : { contentType: 'application/json', payload: typeof data === 'string' ? data : JSON.stringify(data) }) });
  return JSON.parse(response.getContentText('UTF-8'));
}
const MP_FIELDS = 'id,name,mimeType,size,md5Checksum,version,parents,trashed,ownedByMe,shared,appProperties';
function mpMetadata(id, optional) {
  try { return mpApi('files/' + mpId(id) + '?fields=' + encodeURIComponent(MP_FIELDS)); }
  catch (error) { if (optional && error.message === 'DRIVE_HTTP_404') return null; throw error; }
}
function mpSource(source, version) {
  const meta = mpMetadata(source.id);
  mpAssert(!meta.trashed && meta.ownedByMe === true && meta.shared === false && meta.parents?.includes(mpConfig().sourceFolder), 'SOURCE_ACCESS_OR_PARENT_CHANGED');
  mpAssert(Number(meta.size) === source.size && meta.md5Checksum === source.md5 && meta.version, 'SOURCE_CONTENT_CHANGED');
  if (version !== undefined) mpAssert(String(meta.version) === version, 'SOURCE_REVISION_CHANGED');
  return String(meta.version);
}
function mpOwned(meta, root, role) {
  mpAssert(meta && meta.ownedByMe === true && meta.shared === false && !meta.trashed, 'OUTPUT_NOT_OWNER_PRIVATE');
  mpAssert(meta.appProperties?.mypaceProbe === root.job && meta.appProperties?.role === role, 'OUTPUT_MARKER_CHANGED');
  if (role !== 'folder') mpAssert(meta.parents?.length === 1 && meta.parents[0] === root.folder, 'OUTPUT_PARENT_CHANGED');
}
function mpReserve(count) { return mpApi('files/generateIds?count=' + count + '&space=drive&type=files').ids; }
function mpCreate(id, name, content, root, role) {
  const metadata = { id, name, mimeType: role === 'folder' ? 'application/vnd.google-apps.folder' : 'application/json',
    appProperties: { mypaceProbe: root.job, role }, ...(role === 'folder' ? {} : { parents: [root.folder] }) };
  if (role === 'folder') return mpApi('files?ignoreDefaultVisibility=true&fields=' + encodeURIComponent(MP_FIELDS), 'post', metadata);
  const boundary = 'mypace_probe_' + root.job.replace(/-/g, '');
  const payload = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata)
    + '\r\n--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + content + '\r\n--' + boundary + '--\r\n';
  return JSON.parse(mpFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&ignoreDefaultVisibility=true&fields=' + encodeURIComponent(MP_FIELDS),
    { method: 'post', contentType: 'multipart/related; boundary=' + boundary, payload }).getContentText('UTF-8'));
}
function mpRead(id, root, role) {
  // IDs come only from this job's durable private state, not user requests.
  const metadata = mpMetadata(id); mpOwned(metadata, root, role);
  mpAssert(Number(metadata.size) <= 4 * 1024 * 1024, 'CHECKPOINT_SIZE_LIMIT');
  const response = mpFetch('https://www.googleapis.com/drive/v3/files/' + mpId(id) + '?alt=media');
  const bytes = response.getBlob().getBytes();
  mpAssert(bytes.length === Number(metadata.size) && mpDigest(Utilities.DigestAlgorithm.MD5, bytes) === metadata.md5Checksum, 'CHECKPOINT_INTEGRITY');
  return JSON.parse(response.getContentText('UTF-8'));
}
function mpWrite(id, name, value, root, role, immutable) {
  const text = typeof value === 'string' ? value : mpJson(value), bytes = mpBytes(text);
  mpAssert(bytes.length <= 4 * 1024 * 1024, 'CHECKPOINT_SIZE_LIMIT');
  const existing = mpMetadata(id, true), digest = mpDigest(Utilities.DigestAlgorithm.MD5, bytes);
  if (existing) {
    mpOwned(existing, root, role);
    if (existing.md5Checksum === digest && Number(existing.size) === bytes.length) return;
    mpAssert(!immutable, 'IMMUTABLE_CONTENT_MISMATCH');
  }
  const result = existing ? mpApi('files/' + id + '?uploadType=media&fields=' + encodeURIComponent(MP_FIELDS), 'patch', text, true)
    : mpCreate(id, name, text, root, role);
  mpOwned(result, root, role);
  mpAssert(result.md5Checksum === digest && Number(result.size) === bytes.length, 'WRITE_INTEGRITY');
}

function mpSave(state) { mpWrite(mpContext.root.state, 'checkpoint.json', state, mpContext.root, 'state', false); }
function mpYield() { if (Date.now() - mpContext.started > 90000) throw Error('YIELD'); }
function mpUnit(state, kind, key, compute) {
  const cacheKey = mpHash({ kind, key });
  if (mpContext.memory.has(cacheKey)) return mpContext.memory.get(cacheKey);
  if (state.cache[cacheKey]) {
    const value = mpRead(state.cache[cacheKey], mpContext.root, 'cache'); mpContext.memory.set(cacheKey, value); return value;
  }
  mpYield(); const began = Date.now(), value = compute();
  state.computeMs[kind] = (state.computeMs[kind] || 0) + Date.now() - began;
  // Each reserved slot is deterministic until its checkpoint commits. A retry
  // after a lost create response targets the same ID and verifies its content.
  mpAssert(state.slot < mpContext.root.ids.length, 'BENCHMARK_OBJECT_LIMIT');
  const id = mpContext.root.ids[state.slot++];
  mpWrite(id, kind + '-' + cacheKey + '.json', value, mpContext.root, 'cache', true);
  state.cache[cacheKey] = id; mpSave(state); mpContext.memory.set(cacheKey, value); return value;
}

function mpInitial() {
  return { phase: 'parse', source: 0, offset: 0, parser: null, versions: {}, normalized: [], cache: {}, slot: 0, artifacts: {},
    computeMs: {}, stats: { explorationCellVisits: 0 }, sourceRows: 0, gpsFixes: 0, verifiedChunks: 0, errors: 0 };
}
function mpStep(state) {
  const config = mpConfig(), root = mpContext.root;
  if (state.phase === 'parse') {
    const source = config.sources[state.source];
    if (!state.versions[source.id]) state.versions[source.id] = mpSource(source);
    const from = state.offset, to = Math.min(source.size, from + config.chunkBytes) - 1;
    const response = mpFetch('https://www.googleapis.com/drive/v3/files/' + mpId(source.id) + '?alt=media', { headers: { Range: 'bytes=' + from + '-' + to } });
    const headers = response.getAllHeaders(), rangeKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-range');
    mpAssert(response.getResponseCode() === 206 && headers[rangeKey] === 'bytes ' + from + '-' + to + '/' + source.size, 'RANGE_NOT_HONORED');
    const bytes = response.getBlob().getBytes();
    mpAssert(bytes.length === to - from + 1 && mpDigest(Utilities.DigestAlgorithm.SHA_256, bytes) === source.chunks[Math.floor(from / config.chunkBytes)], 'SOURCE_CHUNK_MISMATCH');
    const began = Date.now();
    state.parser = MP_CORE.parseChunk(state.parser, bytes, to + 1 === source.size);
    state.computeMs.csv = (state.computeMs.csv || 0) + Date.now() - began;
    state.offset = to + 1; state.verifiedChunks++;
    if (state.offset === source.size) state.phase = 'derive';
    mpSave(state); return;
  }
  if (state.phase === 'derive') {
    const source = config.sources[state.source]; mpSource(source, state.versions[source.id]);
    const parsed = state.parser.finished, began = Date.now();
    const value = { id: source.id, start: parsed.start, end: parsed.end, runs: MP_DERIVE.deriveSource(parsed) };
    state.computeMs.derive = (state.computeMs.derive || 0) + Date.now() - began;
    const id = root.ids[state.slot++]; mpAssert(id, 'BENCHMARK_OBJECT_LIMIT');
    mpWrite(id, 'normalized-' + state.source + '.json', value, root, 'normalized', true);
    state.normalized.push(id); state.sourceRows += parsed.counts.rows; state.gpsFixes += parsed.counts.gpsFixes;
    state.source++; state.offset = 0; state.parser = null;
    state.phase = state.source === config.sources.length ? 'compute' : 'parse'; mpSave(state); return;
  }
  if (state.phase === 'compute') {
    const normalized = state.normalized.map(id => mpRead(id, root, 'normalized')).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    for (let i = 1; i < normalized.length; i++) mpAssert(normalized[i].start >= normalized[i - 1].end, 'OVERLAPPING_SOURCES');
    const runs = normalized.flatMap(source => source.runs.map(run => ({ ...run, id: 'r_' + mpHash(source.id).slice(0, 24) + '_' + run.date })));
    const descriptions = MP_INCREMENTAL.describeRuns(runs);
    const cached = (kind, key, compute) => mpUnit(state, kind, key, compute);
    const fresh = MP_INCREMENTAL.incrementalFresh(descriptions, cached);
    const mask = MP_MASK.incrementalMask(descriptions, cached, state.stats);
    const assembled = mpUnit(state, 'assembled', MP_DERIVE.ALGORITHM, () => MP_CORE.assembleProbeArtifacts(runs, fresh, mask, { hash: mpHash, byteLength: x => mpBytes(x).length }));
    mpAssert(mpHash(assembled.catalogContent) === config.expectedCatalogHash, 'REFERENCE_CATALOG_MISMATCH');
    state.resultCache = state.cache[mpHash({ kind: 'assembled', key: MP_DERIVE.ALGORITHM })];
    state.artifactIndex = 0; state.phase = 'artifacts'; mpSave(state); return;
  }
  if (state.phase === 'artifacts') {
    const cacheKey = 'assembled-result';
    if (!mpContext.memory.has(cacheKey)) mpContext.memory.set(cacheKey, mpRead(state.resultCache, root, 'cache'));
    const result = mpContext.memory.get(cacheKey);
    if (state.artifactIndex < result.objects.length) {
      const object = result.objects[state.artifactIndex], id = root.ids[state.slot++]; mpAssert(id, 'BENCHMARK_OBJECT_LIMIT');
      mpWrite(id, object.path.slice(8), object.content, root, 'artifact', true);
      state.artifacts[object.path] = id; state.artifactIndex++; mpSave(state); return;
    }
    state.phase = 'verify'; mpSave(state); return;
  }
  if (state.phase === 'verify') {
    for (const source of config.sources) mpSource(source, state.versions[source.id]);
    const result = mpRead(state.resultCache, root, 'cache');
    // Final readback is bounded per object and is part of the measured work.
    state.verifyIndex = state.verifyIndex || 0;
    while (state.verifyIndex < result.objects.length) {
      mpYield();
      const object = result.objects[state.verifyIndex], value = mpRead(state.artifacts[object.path], root, 'artifact');
      mpAssert(mpHash(value) === object.path.slice(8, -5), 'ARTIFACT_READBACK_MISMATCH');
      state.verifyIndex++; mpSave(state);
    }
    mpOwned(mpMetadata(root.folder), root, 'folder');
    mpWrite(root.index, 'index.json', result.catalogContent, root, 'catalog', true);
    mpAssert(mpHash(mpRead(root.index, root, 'catalog')) === config.expectedCatalogHash, 'CATALOG_READBACK_MISMATCH');
    state.outputFiles = result.objects.length + 1;
    state.outputBytes = result.objects.reduce((n, o) => n + o.bytes, mpBytes(result.catalogContent).length);
    state.phase = 'done'; state.completedAt = Date.now(); mpSave(state); return;
  }
  mpAssert(state.phase === 'done', 'UNKNOWN_PHASE');
}

function mpStopTriggers() {
  for (const trigger of ScriptApp.getProjectTriggers()) if (trigger.getHandlerFunction() === MP_HANDLER) ScriptApp.deleteTrigger(trigger);
}
function mpReport(state, code) {
  const c = mpContext, root = c.root, charged = Number(c.props.getProperty(MP_KEY + '_TOTAL_MS') || '0');
  const maximumMs = Math.max(Number(c.props.getProperty(MP_KEY + '_MAX_MS') || '0'), Date.now() - c.started + 5000);
  const done = state.phase === 'done', elapsedMs = Date.now() - root.started;
  const met = done && elapsedMs <= 86400000 && charged <= 3600000 && maximumMs <= 240000;
  return { schema: 1, kind: 'running-three-csv-benchmark', environment: MYPACE_PROBE_CONFIG.environment || 'apps-script',
    status: done ? (met ? 'TARGET_MET' : 'TARGET_MISSED') : (code || 'IN_PROGRESS'), phase: state.phase,
    sourceFiles: 3, sourceBytes: mpConfig().sources.reduce((n, s) => n + s.size, 0), completedSources: state.source,
    sourceRows: state.sourceRows, gpsFixes: state.gpsFixes, verifiedChunks: state.verifiedChunks,
    invocations: Number(c.props.getProperty(MP_KEY + '_TICKS') || '0'),
    interruptedInvocations: Number(c.props.getProperty(MP_KEY + '_INTERRUPTIONS') || '0'),
    scheduledResumes: Number(c.props.getProperty(MP_KEY + '_YIELDS') || '0'),
    retryableErrors: Number(c.props.getProperty(MP_KEY + '_RETRIES') || '0'),
    requests: Number(c.props.getProperty(MP_KEY + '_CALLS') || '0'),
    chargedExecutionSeconds: Math.ceil(charged / 1000), maximumExecutionSeconds: Math.ceil(maximumMs / 1000),
    elapsedSeconds: Math.ceil(elapsedMs / 1000), computeMs: state.computeMs,
    outputFiles: state.outputFiles || 0, outputBytes: state.outputBytes || 0, matchesLocalReference: done,
    scope: 'THREE_SOURCE_COLD_BENCHMARK_ONLY', runtimeAccounting: 'wall time plus closing margin; interrupted ticks reserved at 360 seconds',
    includesOtherScripts: false };
}

/** Run once in the new project. It creates a new private test folder and a
 * five-minute trigger, then returns. Existing script projects are untouched. */
function startMyPaceThreeCsvProbe() { return mpRun(true); }
function myPaceProbeTick() { return mpRun(false); }

function mpRun(start) {
  const began = Date.now(), props = PropertiesService.getScriptProperties(), lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { status: 'BUSY' };
  let root, state, code, reserved = false, safeToReport = true;
  mpContext = { props, started: began, networkMs: 0, memory: new Map() };
  try {
    if (props.getProperty(MP_KEY + '_ACTIVE')) {
      props.setProperty(MP_KEY + '_INTERRUPTIONS', String(Number(props.getProperty(MP_KEY + '_INTERRUPTIONS') || '0') + 1));
      props.deleteProperty(MP_KEY + '_ACTIVE');
    }
    const config = mpConfig(), existing = props.getProperty(MP_KEY);
    root = existing ? JSON.parse(existing) : null;
    if (!root && !start) throw Error('START_REQUIRED');
    if (root) mpAssert(root.script === ScriptApp.getScriptId() && root.config === mpHash(config), 'PROJECT_OR_CONFIG_CHANGED');
    // Per-job conservative budget. A timeout leaves its full six-minute
    // reservation counted. This is not Google's account-wide quota meter.
    const charged = Number(props.getProperty(MP_KEY + '_TOTAL_MS') || '0');
    if (charged + 360000 > 3600000 || root && Date.now() - root.started >= 86400000) {
      code = 'BENCHMARK_BUDGET_REACHED'; props.setProperty(MP_KEY + '_STATUS', code);
      mpStopTriggers(); return { status: 'BENCHMARK_BUDGET_REACHED', chargedExecutionSeconds: Math.ceil(charged / 1000) };
    }
    props.setProperty(MP_KEY + '_TOTAL_MS', String(charged + 360000)); reserved = true;
    props.setProperty(MP_KEY + '_ACTIVE', '1');
    props.setProperty(MP_KEY + '_TICKS', String(Number(props.getProperty(MP_KEY + '_TICKS') || '0') + 1));
    if (!root) {
      const ids = mpReserve(200);
      mpAssert(ids?.length === 200, 'RESERVED_IDS_REQUIRED');
      root = { job: Utilities.getUuid(), script: ScriptApp.getScriptId(), config: mpHash(config), started: Date.now(),
        folder: ids[0], state: ids[1], index: ids[2], report: ids[3], ids: ids.slice(4) };
      // Bound every Script Property below 9 KiB even with long Drive IDs.
      for (let i = 0; i < 4; i++) props.setProperty(MP_KEY + '_IDS_' + i, JSON.stringify(root.ids.slice(i * 50, (i + 1) * 50)));
      const { ids: unused, ...smallRoot } = root; props.setProperty(MP_KEY, JSON.stringify(smallRoot));
    } else root.ids = [0, 1, 2, 3].flatMap(i => JSON.parse(props.getProperty(MP_KEY + '_IDS_' + i)));
    mpContext.root = root;
    let folder = mpMetadata(root.folder, true);
    if (!folder) folder = mpCreate(root.folder, 'MyPace ランニング処理検証 ' + root.job.slice(0, 8), null, root, 'folder');
    mpOwned(folder, root, 'folder');
    const parent = mpMetadata(config.sourceFolder);
    mpAssert(parent.mimeType === 'application/vnd.google-apps.folder' && parent.ownedByMe === true && !parent.trashed, 'SOURCE_FOLDER_INVALID');
    if (mpMetadata(root.state, true)) state = mpRead(root.state, root, 'state');
    else { state = mpInitial(); mpSave(state); }
    if (state.phase !== 'done' && !ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === MP_HANDLER))
      ScriptApp.newTrigger(MP_HANDLER).timeBased().everyMinutes(5).create();
    if (start) { code = 'SCHEDULED'; }
    else while (state.phase !== 'done') { mpYield(); mpStep(state); }
  } catch (error) {
    code = mpCode(error);
    if (code === 'YIELD') {
      code = 'IN_PROGRESS'; props.setProperty(MP_KEY + '_YIELDS', String(Number(props.getProperty(MP_KEY + '_YIELDS') || '0') + 1));
    }
    else if (!['DRIVE_RETRYABLE', 'DRIVE_TRANSPORT_ERROR'].includes(code)) mpStopTriggers();
    else props.setProperty(MP_KEY + '_RETRIES', String(Number(props.getProperty(MP_KEY + '_RETRIES') || '0') + 1));
    // Never save a half-mutated in-memory work unit after an error. Resume
    // from the last durable checkpoint and deterministic reserved IDs.
    state = null;
    if (root && mpContext.root && ['IN_PROGRESS', 'DRIVE_RETRYABLE', 'DRIVE_TRANSPORT_ERROR'].includes(code)) {
      try { state = mpRead(root.state, root, 'state'); } catch { safeToReport = false; }
    }
  } finally {
    try {
      props.setProperty(MP_KEY + '_STATUS', code || (state?.phase === 'done' ? 'COMPLETE' : 'STOPPED'));
      if (root && state && safeToReport) {
        const report = mpReport(state, code); mpWrite(root.report, 'report.json', report, root, 'report', false);
        if (state.phase === 'done') mpStopTriggers();
        console.log(JSON.stringify(report));
      } else console.log(JSON.stringify({ status: code || 'STOPPED', detail: 'See execution status; no source data included.' }));
    } finally {
      const measured = Date.now() - began + 5000;
      if (reserved) props.setProperty(MP_KEY + '_TOTAL_MS', String(Number(props.getProperty(MP_KEY + '_TOTAL_MS')) - 360000 + measured));
      props.setProperty(MP_KEY + '_MAX_MS', String(Math.max(Number(props.getProperty(MP_KEY + '_MAX_MS') || '0'), measured)));
      if (reserved) props.deleteProperty(MP_KEY + '_ACTIVE');
      lock.releaseLock(); mpContext = null;
    }
  }
  return { status: state?.phase === 'done' ? 'COMPLETE' : code };
}

/** Stops only this experiment's trigger; keeps its private results for review. */
function stopMyPaceThreeCsvProbe() {
  mpStopTriggers(); PropertiesService.getScriptProperties().setProperty(MP_KEY + '_STATUS', 'USER_STOPPED'); console.log('MY_PACE_PROBE_STOPPED');
}

/** Read the latest aggregate report without printing source IDs or GPS. */
function showMyPaceThreeCsvProbeReport() {
  const props = PropertiesService.getScriptProperties(), root = JSON.parse(props.getProperty(MP_KEY) || 'null');
  mpAssert(root, 'START_REQUIRED');
  mpContext = { props, root, networkMs: 0 };
  try {
    const last = props.getProperty(MP_KEY + '_STATUS');
    if (Number(props.getProperty(MP_KEY + '_CALLS') || '0') >= 3000) {
      const report = { status: last || 'REQUEST_BUDGET_REACHED', requests: Number(props.getProperty(MP_KEY + '_CALLS')) };
      console.log(JSON.stringify(report)); return report;
    }
    const report = mpRead(root.report, root, 'report');
    report.chargedExecutionSeconds = Math.ceil(Number(props.getProperty(MP_KEY + '_TOTAL_MS') || '0') / 1000);
    report.maximumExecutionSeconds = Math.ceil(Number(props.getProperty(MP_KEY + '_MAX_MS') || '0') / 1000);
    if (report.status === 'TARGET_MET' && (report.chargedExecutionSeconds > 3600 || report.maximumExecutionSeconds > 240)) report.status = 'TARGET_MISSED';
    if (last && !['COMPLETE', 'IN_PROGRESS', 'SCHEDULED'].includes(last)) report.status = last;
    console.log(JSON.stringify(report, null, 2)); return report;
  }
  finally { mpContext = null; }
}
