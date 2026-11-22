// Keep useful failure context without provider text, file IDs, names, URLs or GPS.
// A previous UNEXPECTED_ERROR cannot be reconstructed: this records future errors.
function prErrorCode(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(message) ? message : 'UNEXPECTED_ERROR';
}
function prFailure(error, code) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const type = ['Error', 'Exception', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(error?.name) ? error.name : 'Unknown';
  let reason = code === 'UNEXPECTED_ERROR' ? 'UNCLASSIFIED' : 'APPLICATION_CODE';
  // These are diagnostic categories only, not a reason to bypass a quota or
  // automatically retry an unknown failure. The original stop policy is kept.
  if (/Service using too much computer time for one day/i.test(message)) reason = 'GOOGLE_DAILY_RUNTIME_LIMIT';
  else if (/Exceeded maximum execution time/i.test(message)) reason = 'GOOGLE_EXECUTION_TIME_LIMIT';
  else if (/Service invoked too many times|Limit exceeded|quota exceeded|too many triggers|too many scripts running/i.test(message)) reason = 'GOOGLE_SERVICE_LIMIT';
  else if (/server error occurred|internal error|service unavailable/i.test(message)) reason = 'GOOGLE_SERVICE_ERROR';
  else if (['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(type)) reason = 'JAVASCRIPT_' + type.replace(/Error$/, '').toUpperCase() + '_ERROR';
  const allowed = new Set(['prRun','prConfig','prGet','prSet','prJson','prBytes','prDigest','mpHash','prAssert','prYield','prPrivate',
    'prFetch','prApi','prMeta','prList','prChild','prRead','prValue','prWrite','prReserve','prSave','prAllocate',
    'prValidateRoots','prCheckRoots','prDistinctRoots','prInputFolder','prInputAncestor','prSource',
    'prBudgetBegin','prBudgetEnd','prPersistBudget','prSchedule','prSleepUntil','prDeleteTriggers',
    'prSetup','prAdopt','prSeedPlan','prSeed','prLegacy','prLegacyMeta','prRollback',
    'prScanStart','prScanStep','prPlan','prNormalize','prCheckSource','prAssemble','prObject','prPublicationStep',
    'prUnitRead','prUnitPut','prUnit','prProgress','prPublishStatus','prStatusValue','prBudgetView']);
  const frames = [];
  for (const line of String(error?.stack || '').split('\n')) {
    const match = line.match(/\bat (\w+)\s*\((.+?):(\d+)(?::\d+)?\)\s*$/);
    if (match && allowed.has(match[1]) && Number(match[3]) > 0 && Number(match[3]) < 1e7) {
      frames.push({ function: match[1], line: Number(match[3]) });
      if (frames.length === 4) break;
    }
  }
  const steps = ['initializing','configuration','trigger_check','trigger_setup','budget','checkpoint_probe','folder_check','checkpoint_read',
    'prepare','start','adopt','inventory','seed','normalize','objects','confirm','publish','scan','plan','scan_start','rollback','stop'];
  // Drive reasons come from the validated API adapter, and remain bounded here.
  const driveReasons = Array.isArray(error?.driveReasons) ? error.driveReasons.filter(value => typeof value === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(value)).slice(0, 6) : [];
  return { code, driveReasons, diagnostic: { at: Date.now(), buildId: MYPACE_BUILD_ID,
    step: steps.includes(pr.step) ? pr.step : 'initializing', type, reason, frames } };
}
