// A bounded, isolated experiment. Never deploy this as the application's reader.
const MYPACE_PROBE_CONFIG = __MYPACE_PROBE_CONFIG__;
const MYPACE_BUILD_ID = __MYPACE_BUILD_ID__;
const MI_KEY = 'MYPACE_INCREMENTAL_V1', MI_HANDLER = 'myPaceIncrementalTick';
const MI_FIELDS = 'id,name,mimeType,size,md5Checksum,version,parents,trashed,ownedByMe,shared,appProperties';
const MI_MARKER = 'mypaceIncremental';
function miConfig() {
  const c = MYPACE_PROBE_CONFIG;
  miAssert(c?.sources?.length === 3 && c.references?.length === MP_SYNC.syncStages().length && c.chunkBytes === 1048576, 'PRIVATE_INCREMENTAL_CONFIG_REQUIRED');
  miId(c.sourceFolder);
  for (const s of c.sources) { miId(s.id); miAssert(s.key && s.size > 0 && s.size <= 536870912 && s.chunks?.length === Math.ceil(s.size / c.chunkBytes), 'SOURCE_CONFIG_INVALID'); }
  return c;
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
function miReport(status, compact) {
  const budget = miGet('BUDGET', { totalMs: 0, maximumMs: 0 }), metrics = miGet('METRICS', {}), stage = miGet('SUMMARY', {}), idle = miGet('IDLE', null);
  if (idle) {
    idle.measuredExecutionSeconds = Math.ceil(((idle.endMeasuredMs ?? budget.measuredMs ?? 0) - idle.startMeasuredMs) / 1000);
    idle.accountedExecutionSeconds = Math.ceil(((idle.endAccountedMs ?? budget.totalMs ?? 0) - idle.startAccountedMs) / 1000);
    delete idle.baseline; delete idle.metricsStart; delete idle.startMeasuredMs; delete idle.startAccountedMs;
  }
  if (compact && idle) {
    for (const key of ['pollDurationsMs', 'endMeasuredMs', 'endAccountedMs', 'totalPollMs', 'maximumPollMs']) delete idle[key];
  }
  return { schema: 1, kind: 'running-incremental-benchmark', buildId: MYPACE_BUILD_ID, environment: miConfig().environment || 'apps-script',
    status: status || miGet('STATUS', 'NOT_STARTED'), scope: 'ISOLATED_INCREMENTAL_AND_IDLE_PROBE',
    ...stage, ...(!compact ? { results: Array.from({ length: stage.completedStages || 0 }, (_, i) => ({ ...miGet('RESULT_' + i, {}), measuredWorkSeconds: Math.ceil(miGet('WORK_' + i, 0) / 1000) })) } : {}),
    completedOutcomes: { functional: miGet('OUTCOME_FUNCTIONAL', null), idle: miGet('OUTCOME_IDLE', null) },
    metrics, accountedExecutionSeconds: Math.ceil((budget.totalMs || 0) / 1000),
    measuredExecutionSeconds: Math.ceil((budget.measuredMs || 0) / 1000), maximumExecutionSeconds: Math.ceil((budget.maximumMs || 0) / 1000),
    interruptedInvocations: miGet('INTERRUPTIONS', 0), lastError: miGet('LAST_ERROR', null), idle, includesOtherScripts: false };
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
        if (['FUNCTIONAL_PASS', 'FUNCTIONAL_TIMING_MISSED', 'IDLE_PASS', 'IDLE_TIMING_MISSED', 'IDLE_CADENCE_MISSED'].includes(status)) {
          const key = status.startsWith('FUNCTIONAL_') ? 'OUTCOME_FUNCTIONAL' : 'OUTCOME_IDLE';
          if (!miGet(key, null)) miSet(key, { status, completedAt: Date.now(), buildId: MYPACE_BUILD_ID });
        }
        console.log(JSON.stringify(miReport(status, true)));
      }
    } finally { lock.releaseLock(); mi = null; }
  }
  return { status };
}
function startMyPaceIncrementalProbe() { return miRun('start'); }
function myPaceIncrementalTick() { return miRun('tick'); }
function startMyPaceIdleProbe() { return miRun('idle'); }
function stopMyPaceIncrementalProbe() { return miRun('stop'); }
function miViewReport(mode) {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) return { status: 'BUSY' };
  mi = { props: PropertiesService.getScriptProperties() };
  try {
    miConfig(); const root = miGet('ROOT', null);
    if (root) miAssert(root.script === ScriptApp.getScriptId() && root.config === mpHash(miConfig()), 'PROJECT_OR_CONFIG_CHANGED');
    const report = miReport(null, mode !== 'details');
    if (mode === 'details') {
      for (const stage of report.results) console.log(JSON.stringify({ kind: 'running-incremental-stage', ...stage }));
    } else if (mode === 'idle') {
      const idle = report.idle;
      const minutes = idle ? { completed: idle.completed, polls: idle.polls, elapsedHours: idle.elapsedSeconds === undefined ? null : +(idle.elapsedSeconds / 3600).toFixed(2),
        measuredMinutes: +(idle.measuredExecutionSeconds / 60).toFixed(2), accountedMinutes: +(idle.accountedExecutionSeconds / 60).toFixed(2), rawBytesRequested: idle.rawBytesRequested,
        completedOutcome: report.completedOutcomes.idle } : { status: 'IDLE_NOT_STARTED' };
      console.log(JSON.stringify(minutes)); return minutes;
    } else console.log(JSON.stringify(report));
    // Keep the programmatic full report compatible; the emitted log is short.
    return mode === 'summary' ? miReport() : report;
  } catch (error) { const report = { status: miCode(error) }; console.log(JSON.stringify(report)); return report; }
  finally { mi = null; lock.releaseLock(); }
}
function showMyPaceIncrementalProbeReport() { return miViewReport('summary'); }
function showMyPaceIncrementalProbeDetails() { return miViewReport('details'); }
function showMyPaceIdleMinutes() { return miViewReport('idle'); }

function miDiagnosticMeta(id, fields) {
  let response;
  try {
    response = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + miId(id) + '?fields=' + encodeURIComponent(fields),
      { method: 'get', muteHttpExceptions: true, followRedirects: false, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
  } catch { throw Error('METADATA_TRANSPORT_ERROR'); }
  const status = response.getResponseCode();
  if (status !== 200) { const error = Error('METADATA_HTTP_ERROR'); error.httpStatus = status; throw error; }
  try {
    const meta = JSON.parse(response.getContentText('UTF-8'));
    miAssert(meta && typeof meta === 'object' && !Array.isArray(meta), 'METADATA_RESPONSE_INVALID'); return meta;
  } catch { throw Error('METADATA_RESPONSE_INVALID'); }
}

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
    const report = { schema: 2, kind: 'original-source-diagnostic', metadataOnly: true, configurationMatchesRun, sources: [] };
    if (configurationMatchesRun === false) return emit({ ...report, status: 'DIAGNOSTIC_CONFIG_MISMATCH' });
    const fields = 'ownedByMe,shared,trashed,parents,size,md5Checksum';
    const ancestors = new Map(), readFolder = id => {
      if (!ancestors.has(id)) ancestors.set(id, miDiagnosticMeta(id, 'mimeType,parents,trashed'));
      return ancestors.get(id);
    };
    for (let index = 0; index < config.sources.length; index++) {
      const source = config.sources[index]; let meta;
      try {
        meta = miDiagnosticMeta(source.id, fields);
        report.sources.push({ metadataReadable: true, ...MP_SYNC.originalSourceDiagnostics(meta, source, config.sourceFolder, index, readFolder) });
      } catch (error) {
        report.sources.push({ source: index + 1, metadataReadable: !!meta, ...(meta ? { folderMetadataReadable: false } : {}),
          error: ['METADATA_HTTP_ERROR', 'METADATA_TRANSPORT_ERROR', 'METADATA_RESPONSE_INVALID'].includes(error.message) ? error.message : 'METADATA_RESPONSE_INVALID',
          ...(error.message === 'METADATA_HTTP_ERROR' ? { httpStatus: error.httpStatus } : {}) });
      }
    }
    report.status = report.sources.some(s => !s.metadataReadable || s.folderMetadataReadable === false) ? 'DIAGNOSTIC_INCOMPLETE'
      : report.sources.some(s => !s.passesOriginalGuard) ? 'ORIGINAL_SOURCE_CHECK_FAILED'
      : report.sources.some(s => s.missingFields.length || s.invalidFields.length) ? 'METADATA_FIELDS_INCOMPLETE' : 'ORIGINAL_SOURCE_CHECKS_PASSED';
    return emit(report);
  } catch { return emit({ schema: 2, kind: 'original-source-diagnostic', status: 'DIAGNOSTIC_SETUP_INVALID' }); }
  finally { lock.releaseLock(); }
}
