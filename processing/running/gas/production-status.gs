// A small, independent heartbeat: never part of the immutable display catalog.
// No IDs, filenames, coordinates, tokens, or provider error text leave this file.
function prBudgetView() {
  const b = pr.budget || prGet('BUDGET', {}), hour = Math.floor(Date.now() / 3600000);
  let used = Object.entries(b.hours || {}).filter(([h]) => +h >= hour - 24).reduce((n, [, ms]) => n + ms, 0);
  if (pr.hour !== undefined && !pr.budgetSettled) used += Date.now() - pr.started + 5000 - PR_RESERVE_MS;
  return { limitMinutes: PR_DAILY_MS / 60000, usedMinutes: +(Math.max(0, used) / 60000).toFixed(2),
    reserveMinutes: PR_RESERVE_MS / 60000, requestLimit: PR_REQUEST_LIMIT, requests: b.requests || 0 };
}
function prStatusValue() {
  const summary = prGet('SUMMARY', {}), s = pr.state, job = s?.job;
  return { schema: 1, kind: 'running-sync-status', updatedAt: Date.now(), status: prGet('STATUS', 'NOT_PREPARED'),
    enabled: prGet('ENABLED', false), phase: job?.phase || summary.phase || null,
    sources: summary.sources || 0, importedSources: summary.importedSources || 0, pendingSources: summary.pendingSources || 0,
    nextRunAt: prGet('NEXT_AT'), waitReason: prGet('STATUS') === 'BUDGET_WAIT' ? prGet('WAIT_REASON') : null,
    lastSuccessfulUpdate: prGet('LAST_PUBLICATION')?.at || null, catalogHash: s?.catalogHash || prGet('CATALOG_HASH'),
    budget: prBudgetView(), errorCode: prGet('LAST_ERROR')?.code || null };
}
function prPublishStatus() {
  if (!pr.root || !pr.root.catalog || pr.root.script !== ScriptApp.getScriptId() || !pr.root.config || pr.root.config !== mpHash(prConfig())) return;
  // Failed validation may not write even a status file. The UI will report an
  // access error or a stale heartbeat instead of presenting it as healthy.
  pr.saving = true;
  try {
    if (!pr.rootsChecked) prCheckRoots();
    if (!pr.root.status) {
      prAssert(!prChild(pr.root.derived, 'sync-status.json', true), 'UNREGISTERED_STATUS_FILE');
      pr.root.status = prReserve(1)[0]; prSet('ROOT', pr.root);
    }
    prWrite(pr.root.status, 'sync-status.json', prJson(prStatusValue()), pr.root.derived);
    prSet('STATUS_WRITE_ERROR', null);
  } finally { pr.saving = false; }
}
