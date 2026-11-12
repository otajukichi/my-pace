// One new CSV on top of the already-passed incremental experiment.
// The old checkpoint, catalog and completion properties remain read-only.
const MYPACE_PROBE_CONFIG = __MYPACE_PROBE_CONFIG__;
const MYPACE_BUILD_ID = __MYPACE_BUILD_ID__;
const MI_KEY = 'MYPACE_NEW_CSV_V1', MI_HANDLER = 'myPaceNewCsvTick', MI_MARKER = 'mypaceIncremental';
const MI_FIELDS = 'id,name,mimeType,size,md5Checksum,version,parents,trashed,ownedByMe,shared,appProperties';
function miConfig() {
  miAssert(/^[a-f0-9]{64}$/.test(MYPACE_PROBE_CONFIG?.previousConfigHash || ''), 'PREVIOUS_CONFIG_REQUIRED');
  return MYPACE_PROBE_CONFIG;
}
function mnPrevious(key) {
  const value = mi.props.getProperty('MYPACE_INCREMENTAL_V1_' + key);
  return value ? JSON.parse(value) : null;
}
function miRequestGuard(url, options) {
  const method = (options.method || 'get').toLowerCase(), id = url.match(/\/files\/([\w-]+)/)?.[1];
  if (method === 'get') {
    miAssert(!(mi.baselineIds?.has(id) && (url.includes('alt=media') || options.headers?.Range)), 'EXISTING_CSV_READ_FORBIDDEN');
  } else {
    miAssert(method !== 'delete' && !url.includes('/copy') && !url.includes('/permissions'), 'WRITE_FORBIDDEN');
    miAssert(!id || ![mi.root?.previousState, mi.root?.previousCatalog, ...Object.keys(mi.state?.check?.baseline || {})].includes(id), 'PREVIOUS_DATA_WRITE_FORBIDDEN');
  }
}
function mnLoad() {
  miOwned(miMeta(mi.root.folder), 'folder'); miOwned(miMeta(mi.root.system), 'folder', mi.root.folder);
  miOwned(miMeta(mi.root.derived), 'folder', mi.root.folder);
  mi.state = miRead(mi.root.state, 'state'); mi.baselineIds = new Set(Object.keys(mi.state.check.baseline));
}
function mnSetup() {
  if (!mi.root) {
    const previous = mnPrevious('ROOT');
    miAssert(previous && previous.script === ScriptApp.getScriptId() && previous.config === miConfig().previousConfigHash, 'PASSED_PROJECT_REQUIRED');
    miAssert(!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'myPaceIncrementalTick'), 'PREVIOUS_PROBE_RUNNING');
    mi.root = previous;
    miOwned(miMeta(previous.folder), 'folder'); miOwned(miMeta(previous.system), 'folder', previous.folder);
    miOwned(miMeta(previous.derived), 'folder', previous.folder);
    const old = miRead(previous.state, 'state');
    miAssert(old.phase === 'done' && old.results?.length === 12 && old.results.every(r => r.matched), 'PASSED_CHECKPOINT_REQUIRED');
    const catalog = miRead(previous.catalog, 'catalog', previous.derived);
    miAssert(mpHash(catalog) === old.catalogHash, 'BASELINE_CATALOG_CHANGED');
    for (const file of Object.values(old.committed)) miAssert(old.normalized[msNormalizedKey(file)], 'BASELINE_CACHE_MISSING');
    const ids = miApi('files/generateIds?count=2&space=drive&type=files').ids;
    miAssert(ids?.length === 2, 'RESERVED_IDS_REQUIRED');
    mi.root = { ...previous, state: ids[0], catalog: ids[1], previousState: previous.state, previousCatalog: previous.catalog,
      stateName: 'new-csv-checkpoint.json', catalogName: 'new-csv-index.json', baselineSignature: msSignature(old.committed),
      config: mpHash(miConfig()), buildId: MYPACE_BUILD_ID, started: Date.now() };
    miSet('ROOT', mi.root); mi.stateMeta = null;
    // Existing processing/cache IDs and record identities are retained.
    mi.state = { ...old, phase: 'wait', job: null, observed: null, generations: [{ id: previous.catalog, hash: old.catalogHash }],
      check: { baseline: old.committed, baselineCatalog: old.catalogHash } }; miSave();
  } else if (!miMeta(mi.root.state, true)) {
    // A lost create response is retried using the same reserved IDs.
    const old = miRead(mi.root.previousState, 'state'); mi.stateMeta = null;
    mi.state = { ...old, phase: 'wait', job: null, observed: null, generations: [{ id: mi.root.previousCatalog, hash: old.catalogHash }],
      check: { baseline: old.committed, baselineCatalog: old.catalogHash } }; miSave();
  }
}
function mnStep() {
  const s = mi.state, check = s.check;
  mi.inventory = mi.inventory || msInventory();
  const diff = MP_SYNC.inventoryDiff(check.baseline, mi.inventory);
  miAssert(!diff.changed.length && !diff.removed.length, 'BASELINE_INPUT_CHANGED');
  miAssert(diff.added.length <= 1, 'ADD_ONE_CSV_ONLY');
  if (!diff.added.length) return 'WAITING_FOR_CSV';
  if (s.phase === 'check') {
    miAssert(msSignature(mi.inventory) === msSignature(s.committed), 'INPUT_CHANGED_AFTER_IMPORT');
    miAssert((miGet('METRICS', {}).rawBytesRequested || 0) === check.bytesAfterImport, 'CSV_WAS_READ_AGAIN');
    miSet('SUMMARY', { imported: true, catalogChanged: true, existingCsvReread: false, unchangedPollPassed: true });
    return 'NEW_CSV_PASS';
  }
  // Publication may have completed before its final phase save was acknowledged.
  if (!s.job && s.catalogHash !== check.baselineCatalog && msSignature(mi.inventory) === msSignature(s.committed)) {
    s.phase = 'check'; check.bytesAfterImport = miGet('METRICS', {}).rawBytesRequested || 0; miSave();
    return 'CHECKING_NO_REREAD';
  }
  // A changed upload invalidates the unfinished generation, not completed caches.
  if (s.job && (msSignature(s.job.files) !== msSignature(mi.inventory)
      || Object.keys(mi.inventory).some(id => mi.inventory[id].version !== s.job.files[id]?.version))) {
    s.job = null; s.observed = null; mi.result = null; miSave();
  }
  s.phase = 'process';
  while (true) {
    miYield(); const result = msSyncStep();
    if (result === 'SETTLING') return 'CONFIRMING_CSV';
    if (result === 'SYNCED') {
      miAssert(s.catalogHash !== check.baselineCatalog, 'DUPLICATE_CSV');
      s.phase = 'check'; check.bytesAfterImport = miGet('METRICS', {}).rawBytesRequested || 0; miSave();
      miSet('SUMMARY', { imported: true, catalogChanged: true, existingCsvReread: false, unchangedPollPassed: false });
      return 'CHECKING_NO_REREAD';
    }
    miAssert(result !== 'UNCHANGED', 'IMPORT_STATE_MISMATCH');
  }
}
function mnReport() {
  const m = miGet('METRICS', {}), b = miGet('BUDGET', {}), start = miGet('START_BUDGET', {});
  return { schema: 1, kind: 'one-new-csv-check', buildId: MYPACE_BUILD_ID, status: miGet('STATUS', 'NOT_STARTED'),
    ...miGet('SUMMARY', {}), completedOutcome: miGet('OUTCOME', null),
    rawBytesRequested: m.rawBytesRequested || 0, requests: m.requests || 0, csvChunks: m.csvChunks || 0,
    measuredMinutes: +(((b.measuredMs || 0) - (start.measuredMs || 0)) / 60000).toFixed(2),
    accountedMinutes: +(((b.totalMs || 0) - (start.totalMs || 0)) / 60000).toFixed(2), lastError: miGet('LAST_ERROR', null) };
}
function mnRun(command) {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) return { status: 'BUSY' };
  mi = { props: PropertiesService.getScriptProperties(), started: Date.now(), memory: new Map() };
  let status;
  try {
    miConfig(); mi.root = miGet('ROOT', null);
    if (mi.root) miAssert(mi.root.script === ScriptApp.getScriptId() && mi.root.config === mpHash(miConfig()) && mi.root.buildId === MYPACE_BUILD_ID, 'PROJECT_OR_CONFIG_CHANGED');
    if (command === 'stop') { miStop(); status = 'USER_STOPPED'; }
    else if (miGet('OUTCOME', null)) { miStop(); status = 'NEW_CSV_PASS'; }
    else if (command === 'tick' && miGet('STATUS') === 'USER_STOPPED') status = 'USER_STOPPED';
    else {
      if (!miGet('BUDGET', null)) {
        // Reuse the existing rolling time budget; do not reset today's allowance.
        const old = mnPrevious('BUDGET');
        if (old) miSet('BUDGET', old);
        miSet('START_BUDGET', { measuredMs: old?.measuredMs || 0, totalMs: old?.totalMs || 0 });
      }
      miBudgetBegin();
      if (command === 'start') miSchedule();
      if (command === 'start' || !mi.root) mnSetup();
      miAssert(mi.root, 'START_REQUIRED');
      miAssert(Date.now() - mi.root.started < 14400000, 'CHECK_WINDOW_ENDED');
      if (command === 'tick' && miGet('STATUS') === 'WAITING_FOR_CSV') mi.inventory = msInventory();
      if (mi.inventory && msSignature(mi.inventory) === mi.root.baselineSignature) status = 'WAITING_FOR_CSV';
      else { mnLoad(); miSchedule(); status = mnStep(); }
      if (status === 'NEW_CSV_PASS') { miSet('OUTCOME', { status, completedAt: Date.now(), buildId: MYPACE_BUILD_ID }); miStop(); }
    }
  } catch (error) {
    status = miCode(error);
    if (status === 'YIELD') status = 'PROCESSING';
    else {
      miSet('LAST_ERROR', { code: status, driveReasons: error.driveReasons || [] });
      if (!['DRIVE_RETRYABLE', 'DRIVE_TRANSPORT_ERROR'].includes(status)) miStop();
    }
  } finally {
    try { miBudgetEnd(); miSet('STATUS', status || 'STOPPED'); console.log(JSON.stringify(mnReport())); }
    finally { mi = null; lock.releaseLock(); }
  }
  return { status };
}
function startMyPaceNewCsvCheck() { return mnRun('start'); }
function myPaceNewCsvTick() { return mnRun('tick'); }
function stopMyPaceNewCsvCheck() { return mnRun('stop'); }
function showMyPaceNewCsvReport() {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) return { status: 'BUSY' };
  mi = { props: PropertiesService.getScriptProperties() };
  try { const report = mnReport(); console.log(JSON.stringify(report)); return report; }
  finally { mi = null; lock.releaseLock(); }
}
