// Isolated integration verification; no application reader or public endpoint.
const MYPACE_PROBE_CONFIG = __MYPACE_PROBE_CONFIG__;
const MYPACE_BUILD_ID = __MYPACE_BUILD_ID__;
const MI_KEY = 'MYPACE_DISCOVERY_V1', MI_HANDLER = 'myPaceDiscoveryTick', MI_MARKER = 'mypaceDiscovery';
const MI_FIELDS = 'id,name,mimeType,size,md5Checksum,version,parents,trashed,ownedByMe,shared,appProperties';
function miConfig() {
  const c = MYPACE_PROBE_CONFIG;
  miAssert(c?.sources?.length === 3 && c.references?.length === 12 && c.chunkBytes === 1048576, 'PRIVATE_DISCOVERY_CONFIG_REQUIRED');
  miId(c.sourceFolder);
  for (const s of c.sources) { miId(s.id); MP_SYNC.contentStamp({ size: s.size, md5Checksum: s.md5 }); }
  return c;
}
function miRequestGuard(url, options) {
  const method = (options.method || 'get').toLowerCase();
  if (method === 'get') return;
  // Defense in depth: no source mutation and no permission/deletion endpoint.
  miAssert(!url.includes('/permissions') && method !== 'delete', 'WRITE_FORBIDDEN');
  const match = url.match(/\/files\/([\w-]+)([^?]*)/);
  if (match && miConfig().sources.some(s => s.id === match[1]))
    miAssert(method === 'post' && match[2] === '/copy' && mi.category === 'fixture', 'ORIGINAL_WRITE_FORBIDDEN');
}
function mdSetup() {
  if (!mi.root) {
    const ids = miApi('files/generateIds?count=8&space=drive&type=files').ids;
    miAssert(ids?.length === 8, 'RESERVED_IDS_REQUIRED');
    mi.root = { job: Utilities.getUuid(), script: ScriptApp.getScriptId(), config: mpHash(miConfig()), buildId: MYPACE_BUILD_ID, started: Date.now(),
      folder: ids[0], raw: ids[1], derived: ids[2], system: ids[3], parked: ids[4], state: ids[5], catalog: ids[6] }; miSet('ROOT', mi.root);
  }
  const r = mi.root;
  for (const [key, name, parent] of [['folder', 'MyPace 継続同期検証 ' + r.job.slice(0, 8), null], ['raw', 'inbox', r.folder],
    ['derived', 'derived', r.folder], ['system', 'system', r.folder], ['parked', 'parked', r.folder]]) {
    miOwned(miMeta(r[key], true) || miCreate(miMetadata(r[key], name, 'folder', parent)), 'folder', parent);
  }
  if (!miMeta(r.state, true)) {
    mi.state = { stage: 0, phase: 'action', committed: {}, catalogHash: null, generations: [], pool: [], ids: {}, cache: {}, normalized: {}, artifacts: {}, results: [] }; miSave();
  }
}
function mdLoad() {
  miOwned(miMeta(mi.root.folder), 'folder'); miOwned(miMeta(mi.root.system), 'folder', mi.root.folder);
  miOwned(miMeta(mi.root.derived), 'folder', mi.root.folder); mi.state = miRead(mi.root.state, 'state');
}
function mdRecord(result) {
  const s = mi.state, stage = MP_SYNC.syncStages()[s.stage];
  miAssert(s.catalogHash === miConfig().references[s.stage], 'REFERENCE_CATALOG_MISMATCH');
  const metrics = miGet('METRICS', {}), delta = Object.fromEntries(Object.entries(metrics).map(([k, n]) => [k, n - (s.stageStart.metrics[k] || 0)]));
  if (['unchanged', 'rename', 'final_unchanged', 'move_out', 'move_back', 'trash', 'restore'].includes(stage.name)) miAssert(!delta.rawBytesRequested, 'UNCHANGED_SOURCE_WAS_DOWNLOADED');
  if (result === 'UNCHANGED') miAssert(!delta.normalizedComputed && !delta.displayComputed && !delta.freshComputed && !delta.corridorComputed, 'UNCHANGED_DATA_WAS_RECOMPUTED');
  s.results.push({ name: stage.name, matched: true, changes: s.diff, ...delta });
  s.stage++; s.phase = s.stage === 12 ? 'done' : 'action'; s.stageStart = null; miSave();
}
function mdScenarioStep() {
  const s = mi.state;
  if (s.phase === 'action') {
    if (!s.stageStart) { s.stageStart = { metrics: miGet('METRICS', {}) }; miSave(); }
    mi.category = 'fixture'; miMutateFixture(MP_SYNC.syncStages()[s.stage]); mi.category = 'processing';
    s.phase = 'sync'; s.observed = null; miSave(); throw Error('YIELD');
  }
  const result = msSyncStep();
  if (result === 'SETTLING') throw Error('YIELD');
  if (['SYNCED', 'UNCHANGED'].includes(result)) mdRecord(result);
}
function mdFastSignature(files) { return mpHash(Object.keys(files).sort().map(id => [id, MP_SYNC.contentStamp(files[id]), files[id].name])); }
function mdWatch() {
  const watch = miGet('WATCH');
  if (Date.now() - watch.started >= 86400000) {
    const pending = !!miGet('SUMMARY', {}).pendingUpdate;
    watch.finished = true; watch.completed = !pending; watch.finishedAt = Date.now(); miSet('WATCH', watch); miStop();
    return pending ? 'WATCH_INCOMPLETE' : 'WATCH_COMPLETE';
  }
  mi.inventory = msInventory(); watch.polls++; miSet('WATCH', watch);
  const signature = mdFastSignature(mi.inventory), fast = miGet('FAST', null);
  if (fast === signature) return 'WATCHING'; // No checkpoint/media/Drive writes.
  miSet('FAST', null); mdLoad();
  // A corrected/removed/replaced input invalidates only the pending generation.
  // Completed artifacts and the currently published catalog stay available.
  if (mi.state.job && (msSignature(mi.state.job.files) !== msSignature(mi.inventory)
      || Object.keys(mi.inventory).some(id => mi.inventory[id].version !== mi.state.job.files[id]?.version))) {
    mi.state.job = null; mi.state.observed = null; miSave(); miCount('abandonedGenerations');
  }
  while (true) {
    miYield(); const result = msSyncStep();
    if (result === 'SETTLING') return 'WATCHING';
    if (['SYNCED', 'UNCHANGED'].includes(result)) {
      miSet('FAST', mdFastSignature(mi.state.committed));
      if (result === 'SYNCED') { watch.updates++; watch.lastPublishedAt = Date.now(); miSet('WATCH', watch); }
      return 'WATCHING';
    }
  }
}
function mdReport() {
  const b = miGet('BUDGET', {}), m = miGet('METRICS', {}), watch = miGet('WATCH', null);
  return { schema: 1, kind: 'running-discovery-probe', buildId: MYPACE_BUILD_ID, scope: 'ISOLATED_DISCOVERY_PROBE',
    environment: miConfig().environment || 'apps-script', status: miGet('STATUS', 'NOT_STARTED'),
    ...miGet('SUMMARY', { completedStages: 0, stageCount: 12 }), completedOutcome: miGet('OUTCOME', null),
    metrics: { polls: m.polls || 0, requests: m.requests || 0, rawBytesRequested: m.rawBytesRequested || 0, csvChunks: m.csvChunks || 0,
      normalizedComputed: m.normalizedComputed || 0, normalizedReused: m.normalizedReused || 0, publications: m.publications || 0,
      abandonedGenerations: m.abandonedGenerations || 0, retryableErrors: m.retryableErrors || 0 },
    measuredMinutes: +((b.measuredMs || 0) / 60000).toFixed(2), accountedMinutes: +((b.totalMs || 0) / 60000).toFixed(2),
    maximumExecutionSeconds: Math.ceil((b.maximumMs || 0) / 1000), interruptedInvocations: miGet('INTERRUPTIONS', 0),
    watch: watch ? { completed: watch.completed, polls: watch.polls, updates: watch.updates, lastPublishedAt: watch.lastPublishedAt || null,
      elapsedHours: +(((watch.finishedAt || Date.now()) - watch.started) / 3600000).toFixed(2),
      rawBytesRequested: (m.rawBytesRequested || 0) - watch.startBytes } : null,
    lastError: miGet('LAST_ERROR', null), includesOtherScripts: false };
}
function mdRun(command) {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) return { status: 'BUSY' };
  mi = { props: PropertiesService.getScriptProperties(), started: Date.now(), memory: new Map(), category: 'setup' };
  let status;
  try {
    miConfig(); mi.root = miGet('ROOT', null);
    if (mi.root) miAssert(mi.root.script === ScriptApp.getScriptId() && mi.root.config === mpHash(miConfig()) && mi.root.buildId === MYPACE_BUILD_ID, 'PROJECT_OR_CONFIG_CHANGED');
    if (command === 'stop') { miStop(); status = 'USER_STOPPED'; }
    else if (command === 'start' && miGet('OUTCOME', null)) status = miGet('MODE') === 'watch' ? miGet('STATUS') : 'ALREADY_COMPLETED';
    else if (command === 'tick' && ['DISCOVERY_PASS', 'DISCOVERY_TIMING_MISSED', 'ALREADY_COMPLETED', 'USER_STOPPED', 'WATCH_COMPLETE', 'WATCH_INCOMPLETE'].includes(miGet('STATUS'))) status = miGet('STATUS');
    else {
      miBudgetBegin(); miCount('invocations');
      if (command === 'start') { mdSetup(); miSet('MODE', 'scenario'); miSchedule(); status = 'SCHEDULED'; }
      else {
        miAssert(mi.root, 'START_REQUIRED');
        if (command === 'watch') {
          miAssert(miGet('OUTCOME', null)?.status === 'DISCOVERY_PASS', 'DISCOVERY_PASS_REQUIRED');
          miAssert(!miGet('WATCH', null)?.finished, 'WATCH_ALREADY_COMPLETED');
          if (!miGet('WATCH', null)) miSet('WATCH', { started: Date.now(), completed: false, polls: 0, updates: 0, startBytes: miGet('METRICS', {}).rawBytesRequested || 0 });
          const watch = miGet('WATCH'); delete watch.finishedAt; miSet('WATCH', watch);
          miSet('MODE', 'watch'); miSchedule(); status = 'WATCHING';
        } else if (miGet('MODE') === 'watch') status = mdWatch();
        else {
          miAssert(Date.now() - mi.root.started < 86400000, 'SCENARIO_DEADLINE_MISSED'); mdLoad();
          while (mi.state.phase !== 'done') { miYield(); mdScenarioStep(); }
          status = 'DISCOVERY_PASS'; miStop();
        }
      }
    }
  } catch (error) {
    status = miCode(error);
    if (status === 'YIELD') { status = miGet('MODE') === 'watch' ? 'WATCHING' : 'IN_PROGRESS'; miCount('scheduledResumes'); }
    else {
      miSet('LAST_ERROR', { code: status, driveReasons: error.driveReasons || [],
        ...(error.sourceDiagnostics ? { sourceDiagnostics: error.sourceDiagnostics } : {}) });
      if (['DRIVE_RETRYABLE', 'DRIVE_TRANSPORT_ERROR'].includes(status)) miCount('retryableErrors');
      else miStop();
    }
  } finally {
    try {
      if (mi.state) {
        for (let i = 0; i < mi.state.results.length; i++) miSet('RESULT_' + i, mi.state.results[i]);
        miSet('SUMMARY', { completedStages: mi.state.results.length, stageCount: 12, currentStage: MP_SYNC.syncStages()[mi.state.stage]?.name || 'done',
          publishedSources: Object.keys(mi.state.committed).length, retainedGenerations: mi.state.generations.length,
          pendingUpdate: !!(mi.state.job || mi.state.observed), processingPhase: mi.state.job?.phase || null });
      }
      miBudgetEnd();
      if (status === 'DISCOVERY_PASS') {
        if (miGet('BUDGET').maximumMs > 240000 || miGet('INTERRUPTIONS', 0)) status = 'DISCOVERY_TIMING_MISSED';
        if (!miGet('OUTCOME', null)) miSet('OUTCOME', { status, completedAt: Date.now(), buildId: MYPACE_BUILD_ID, completedStages: 12 });
      }
      if (['USER_STOPPED', 'WATCH_COMPLETE'].includes(status) && miGet('WATCH', null)) { const w = miGet('WATCH'); w.finishedAt = Date.now(); miSet('WATCH', w); }
      miSet('STATUS', status || 'STOPPED'); console.log(JSON.stringify(mdReport()));
    } finally { mi = null; lock.releaseLock(); }
  }
  return { status };
}
function startMyPaceDiscoveryProbe() { return mdRun('start'); }
function myPaceDiscoveryTick() { return mdRun('tick'); }
function startMyPaceDiscoveryWatch() { return mdRun('watch'); }
function stopMyPaceDiscoveryProbe() { return mdRun('stop'); }
function mdView(details) {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) return { status: 'BUSY' };
  mi = { props: PropertiesService.getScriptProperties() };
  try {
    const report = mdReport(); console.log(JSON.stringify(report));
    if (details) for (let i = 0; i < (report.completedStages || 0); i++) console.log(JSON.stringify(miGet('RESULT_' + i, {})));
    return report;
  } catch (e) { const report = { status: miCode(e) }; console.log(JSON.stringify(report)); return report; }
  finally { mi = null; lock.releaseLock(); }
}
function showMyPaceDiscoveryReport() { return mdView(false); }
function showMyPaceDiscoveryDetails() { return mdView(true); }
