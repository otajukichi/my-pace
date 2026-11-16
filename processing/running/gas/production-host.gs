function prLegacy() {
  const get = key => JSON.parse(pr.props.getProperty('MYPACE_NEW_CSV_V1_' + key) || 'null');
  const root = get('ROOT'), outcome = get('OUTCOME');
  prAssert(root && outcome?.status === 'NEW_CSV_PASS' && root.script === ScriptApp.getScriptId(), 'PASSED_NEW_CSV_STATE_REQUIRED');
  prPrivate(prMeta(root.folder), null, PR_FOLDER); prPrivate(prMeta(root.system), root.folder, PR_FOLDER);
  const meta = prMeta(root.state); prLegacyMeta(meta, root, 'state');
  const state = JSON.parse(prRead(meta, root.system));
  prAssert(state.committed && state.normalized && state.cache && state.catalogHash, 'PASSED_CACHE_REQUIRED');
  return { root, state };
}
function prLegacyMeta(meta, root, role) {
  prPrivate(meta, root.system, 'application/json');
  prAssert(meta.appProperties?.mypaceIncremental === root.job && meta.appProperties?.role === role, 'LEGACY_CACHE_CHANGED');
}
function prSetup() {
  if (!pr.root) {
    const folders = prValidateRoots(), legacy = prLegacy();
    const catalog = prPrivate(prChild(folders.derived, 'index.json'), folders.derived, 'application/json');
    const content = prRead(catalog, folders.derived, 131072), value = JSON.parse(content);
    prAssert(value.schema === 1 && value.kind === 'catalog' && value.algorithm === MP_DERIVE.ALGORITHM, 'CATALOG_SCHEMA');
    prAssert(mpHash(content) === legacy.state.catalogHash, 'CURRENT_CATALOG_DIFFERS_FROM_PASSED_DATA');
    const system = prChild(folders.running, 'system', true);
    if (system) { prPrivate(system, folders.running, PR_FOLDER); prAssert(!prChild(system.id, 'checkpoint.json', true), 'EXISTING_PRODUCTION_STATE'); }
    const ids = prReserve(3);
    pr.root = { ...folders, system: system?.id || ids[0], state: ids[1], initial: ids[2], initialHash: mpHash(content), catalog: catalog.id,
      job: Utilities.getUuid().replace(/-/g, ''), script: ScriptApp.getScriptId(), config: mpHash(prConfig()), createdAt: Date.now(), legacy: legacy.root };
    prSet('ROOT', pr.root); // Reserved IDs survive a lost creation response.
  }
  const r = pr.root;
  prWrite(r.system, 'system', undefined, r.running, { folder: true });
  const existing = prMeta(r.state, true);
  if (existing) { pr.state = JSON.parse(prRead(existing, r.system)); return; }
  const content = prRead(prMeta(r.catalog), r.derived, 131072); prAssert(mpHash(content) === r.initialHash, 'CATALOG_CHANGED_DURING_SETUP');
  prWrite(r.initial, 'initial-index.json', content, r.system);
  const files = prList(r.derived).filter(f => /^[a-f0-9]{64}\.json$/.test(f.name));
  prAssert(new Set(files.map(f => f.name)).size === files.length, 'DUPLICATE_ARTIFACT');
  pr.state = { schema: 1, phase: 'adopt', ids: {}, pool: [], units: {}, pages: [], artifacts: {}, committed: {}, catalogHash: r.initialHash,
    current: { id: r.initial, hash: r.initialHash }, previous: null, needPublish: true, job: null, scan: null,
    adoption: { queue: files.map(f => ({ id: f.id, name: f.name })), next: 0 }, sourceCount: 0, pending: 0, cacheImported: 0 };
  prSave();
}
function prAdopt() {
  const s = pr.state, a = s.adoption;
  if (a.next < a.queue.length) {
    const file = a.queue[a.next], meta = prMeta(file.id), content = prRead(meta, pr.root.derived, 131072);
    prAssert(meta.name === file.name && mpHash(content) === file.name.slice(0, -5), 'ARTIFACT_CHANGED');
    s.artifacts[file.name] = file.id; a.next++; prSave(); return;
  }
  // Verify the entire catalog reference graph without reading any raw CSV.
  const check = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.path === 'string') {
      prAssert(/^objects\/[a-f0-9]{64}\.json$/.test(value.path) && s.artifacts[value.path.slice(8)], 'CATALOG_OBJECT_MISSING');
    } else for (const item of Object.values(value)) check(item);
  };
  if (!a.checked) {
    check(prValue(pr.root.initial, pr.root.system)); a.checked = 0; a.stage = 'references';
  }
  if (a.stage === 'references' && a.checked < a.queue.length) {
    const f = a.queue[a.checked++]; check(JSON.parse(prRead(prMeta(f.id), pr.root.derived, 131072))); prSave(); return;
  }
  delete s.adoption; s.phase = 'inventory'; prScanStart();
}
function prSeedPlan() {
  const s = pr.state, legacy = prLegacy(), byStamp = new Map();
  for (const file of Object.values(legacy.state.committed)) {
    const key = mpHash({ id: file.id, content: prStamp(file), algorithm: MP_DERIVE.ALGORITHM }), id = legacy.state.normalized[key];
    if (id) byStamp.set(prStamp(file), { id, key });
  }
  const queue = [], seen = new Set();
  for (const file of Object.values(s.inventory)) {
    const previous = byStamp.get(prStamp(file)); if (!previous) continue;
    s.committed[file.id] = file;
    const key = prNormalKey(file); if (seen.has(key)) continue; seen.add(key);
    queue.push({ kind: 'normalized', id: previous.id, key });
  }
  for (const [key, id] of Object.entries(legacy.state.cache)) queue.push({ kind: 'cache', key, id });
  s.seed = { queue, next: 0 }; s.phase = 'seed'; s.sourceCount = Object.keys(s.inventory).length;
  s.sourceBytes = Object.values(s.inventory).reduce((n, f) => n + Number(f.size), 0);
  s.pending = MP_SYNC.inventoryDiff(s.committed, s.inventory).added.length; prSave();
}
function prSeed() {
  const s = pr.state, seed = s.seed;
  if (seed.next >= seed.queue.length) { delete s.seed; s.phase = 'ready'; prSave(); return 'READY'; }
  const item = seed.queue[seed.next];
  if (prUnitRead(item.key) === undefined) {
    const meta = prMeta(item.id); prLegacyMeta(meta, pr.root.legacy, item.kind);
    // The old assembled bundles include the artificial test run and are not
    // a production generation. Reuse normalized, geometry and display units.
    if (!meta.name.startsWith('assembled-')) {
      const value = JSON.parse(prRead(meta, pr.root.legacy.system));
      prUnitPut(item.key, value); s.cacheImported++;
    }
  }
  seed.next++; prSave(); return 'PREPARING';
}
function prReport() {
  const summary = prGet('SUMMARY', {}), budget = prGet('BUDGET', {});
  return { schema: 1, kind: 'running-production', buildId: MYPACE_BUILD_ID, status: prGet('STATUS', 'NOT_PREPARED'),
    enabled: prGet('ENABLED', false), ...summary, nextRunAt: prGet('NEXT_AT'),
    measuredMinutes: +((budget.measuredMs || 0) / 60000).toFixed(2), accountedMinutes: +((budget.accountedMs || 0) / 60000).toFixed(2),
    lastError: prGet('LAST_ERROR'), lastSuccessfulUpdate: prGet('LAST_PUBLICATION') };
}
function prRollback() {
  const s = pr.state, body = prRead(prMeta(pr.root.initial), pr.root.system, 131072);
  prAssert(mpHash(body) === pr.root.initialHash, 'INITIAL_CATALOG_CHANGED');
  const current = mpHash(prRead(prMeta(pr.root.catalog), pr.root.derived, 131072));
  prAssert([s.catalogHash, s.job?.hash, pr.root.initialHash].includes(current), 'CATALOG_CHANGED_EXTERNALLY');
  prWrite(pr.root.catalog, 'index.json', body, pr.root.derived, { expected: current });
  s.catalogHash = pr.root.initialHash; s.needPublish = true; s.job = null; s.scan = null; s.current = { id: pr.root.initial, hash: pr.root.initialHash };
  s.phase = 'ready'; prSave(); return 'ROLLED_BACK';
}
function prRun(command) {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) return { status: 'BUSY' };
  pr = { props: PropertiesService.getScriptProperties(), started: Date.now(), pages: new Map(), folders: new Map(), metrics: {}, writePermit: null };
  let status, beforeProgress;
  try {
    pr.root = prGet('ROOT'); pr.metrics = prGet('METRICS', {});
    if (command === 'stop') {
      prSet('ENABLED', false); prDeleteTriggers(PR_TICK); prDeleteTriggers(PR_WAKE); prSet('NEXT_AT', null); status = 'STOPPED';
    } else if (command === 'prepare' && prGet('SUMMARY', {}).phase === 'watch') status = 'ALREADY_STARTED';
    else if (command === 'tick' && !prGet('ENABLED', false)) return { status: prGet('STATUS', 'STOPPED') };
    else {
      prConfig();
      if (pr.root) prAssert(pr.root.script === ScriptApp.getScriptId() && pr.root.config === mpHash(prConfig()), 'PROJECT_OR_CONFIG_CHANGED');
      prAssert(!ScriptApp.getProjectTriggers().some(t => ['myPaceIncrementalTick', 'myPaceNewCsvTick'].includes(t.getHandlerFunction())), 'PREVIOUS_PROBE_RUNNING');
      if (command === 'rollback') { prSet('ENABLED', false); prDeleteTriggers(PR_TICK); prDeleteTriggers(PR_WAKE); prSet('NEXT_AT', null); }
      if (command === 'prepare' || command === 'start') { prSet('ENABLED', true); prSchedule(); }
      const next = prGet('NEXT_AT');
      if (command === 'tick' && next && Date.now() < next) { status = 'BUDGET_WAIT'; }
      else {
        prBudgetBegin(command === 'rollback');
        if (!pr.root || !prMeta(pr.root.state, true)) {
          prAssert(command === 'prepare' || command === 'tick', 'PREPARE_FIRST'); prSetup();
        } else pr.state = prValue(pr.root.state, pr.root.system);
        prCheckRoots();
        const s = pr.state;
        beforeProgress = prProgress(s);
        if (command === 'rollback') status = prRollback();
        else {
          prSchedule();
          if (command === 'start') { prAssert(['ready', 'watch'].includes(s.phase), 'PREPARATION_NOT_FINISHED'); s.phase = 'watch'; prSave(); }
          while (!status) {
            prYield();
            if (s.phase === 'adopt') prAdopt();
            else if (s.phase === 'inventory') { if (s.scan) prScanStep(); else prSeedPlan(); }
            else if (s.phase === 'seed') { const value = prSeed(); if (value === 'READY') status = value; }
            else if (s.phase === 'ready') status = 'READY';
            else if (s.job) { const value = prPublicationStep(); if (value !== 'PROCESSING') status = value; }
            else if (s.scan) { prScanStep(); if (!s.scan) status = prPlan(); }
            else { prScanStart(); }
          }
          if (status === 'READY') { prSet('ENABLED', false); prDeleteTriggers(PR_TICK); prDeleteTriggers(PR_WAKE); }
        }
      }
    }
  } catch (error) {
    status = /^[A-Z][A-Z0-9_]+$/.test(error.message || '') ? error.message : 'UNEXPECTED_ERROR';
    if (status === 'YIELD') status = pr.state?.phase === 'watch' ? 'PROCESSING' : 'PREPARING';
    else if (['BUDGET_WAIT', 'REQUEST_BUDGET_WAIT'].includes(status)) {
      if (status === 'REQUEST_BUDGET_WAIT') prSet('NEXT_AT', pr.budget.since + 25 * 3600000);
      status = 'BUDGET_WAIT'; if (prGet('ENABLED', false)) prSleepUntil(prGet('NEXT_AT'));
    } else if (['SOURCE_CHANGED_DURING_READ', 'SOURCE_MOVED_OUTSIDE'].includes(status) && pr.state?.phase === 'watch') {
      pr.state.job = null; pr.state.scan = null; pr.state.observed = null; prSave(); status = 'INPUT_CHANGED_RETRY';
    } else {
      prSet('LAST_ERROR', { code: status, driveReasons: error.driveReasons || [] });
      if (!['DRIVE_RETRYABLE', 'DRIVE_TRANSPORT_ERROR'].includes(status)) { prSet('ENABLED', false); prDeleteTriggers(PR_TICK); prDeleteTriggers(PR_WAKE); }
    }
  } finally {
    try {
      prBudgetEnd(); prSet('METRICS', pr.metrics);
      if (pr.state) {
        const s = pr.state;
        prSet('SUMMARY', { phase: s.phase, sources: s.sourceCount || 0, sourceBytes: s.sourceBytes || 0,
          importedSources: Object.keys(s.committed).length, pendingSources: s.pending || 0, cacheImported: s.cacheImported,
          rawBytesRequested: pr.metrics.rawBytesRequested || 0, requests: pr.metrics.requests || 0, publications: pr.metrics.publications || 0,
          prepared: ['ready', 'watch'].includes(s.phase), legacyCacheCopied: !s.seed && ['ready', 'watch'].includes(s.phase) });
        if (status === 'UPDATED') { prSet('LAST_PUBLICATION', { at: s.lastPublishedAt, sources: Object.keys(s.committed).length }); prSet('LAST_ERROR', null); }
        const progress = prProgress(s);
        if (['PROCESSING', 'PREPARING'].includes(status)) {
          const stalled = progress === beforeProgress ? prGet('STALLED', 0) + 1 : 0; prSet('STALLED', stalled);
          if (stalled >= 3) { status = 'PROCESSING_UNIT_TOO_LARGE'; prSet('LAST_ERROR', { code: status }); prSet('ENABLED', false); prDeleteTriggers(PR_TICK); prDeleteTriggers(PR_WAKE); }
        } else prSet('STALLED', 0);
      }
      if (status) prSet('STATUS', status); console.log(JSON.stringify(prReport()));
    } finally { pr = null; lock.releaseLock(); }
  }
  return { status };
}
function prProgress(s) {
  return JSON.stringify([s.phase, s.adoption?.next, s.adoption?.checked, s.seed?.next,
    s.job?.phase, s.job?.next, s.job?.offset, s.job?.objectAt, Object.keys(s.units).length, s.scan?.at, s.scan?.token]);
}
function prepareMyPaceRunningProduction() { return prRun('prepare'); }
function startMyPaceRunningProduction() { return prRun('start'); }
function myPaceRunningTick() { return prRun('tick'); }
function myPaceRunningWake() { return prRun('tick'); }
function stopMyPaceRunningProduction() { return prRun('stop'); }
function rollbackMyPaceRunningToInitial() { return prRun('rollback'); }
function showMyPaceRunningReport() {
  pr = { props: PropertiesService.getScriptProperties() };
  try { const report = prReport(); console.log(JSON.stringify(report)); return report; } finally { pr = null; }
}
