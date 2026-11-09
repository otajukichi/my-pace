/** Shared, deterministic experiment scenarios. Coordinates below are artificial;
 * no owner's recordings or Drive identifiers belong in this module. */
export function controlCsv(open = false) {
  const points = [[0, 0], [0, .001], [.001, .001], [.001, 0], [0, 0]];
  if (open) points.pop();
  const rows = ['time,latitude,longitude'];
  for (let edge = 0; edge < points.length - 1; edge++) for (let step = 0; step < 30; step++) {
    const a = points[edge], b = points[edge + 1], f = step / 30;
    rows.push(`${new Date(Date.UTC(2001, 0, 1, 0, 0, (edge * 30 + step) * 2)).toISOString()},${a[0] + (b[0] - a[0]) * f},${a[1] + (b[1] - a[1]) * f}`);
  }
  const end = points.at(-1);
  rows.push(`${new Date(Date.UTC(2001, 0, 1, 0, 0, (points.length - 1) * 60)).toISOString()},${end[0]},${end[1]}`);
  return rows.join('\n') + '\n';
}

export function syncStages() {
  const all = ['source-0', 'source-1', 'source-2'];
  return [
    { name: 'baseline', action: 'add', key: 'source-0', active: ['source-0'] },
    { name: 'append', action: 'add', key: 'source-2', active: ['source-0', 'source-2'] },
    { name: 'backfill', action: 'add', key: 'source-1', active: all },
    { name: 'unchanged', action: 'none', active: all },
    { name: 'rename', action: 'rename', key: 'source-2', active: all },
    { name: 'add_control', action: 'add', key: 'control', active: [...all, 'control'] },
    { name: 'edit_content', action: 'edit', key: 'control', variant: 'open', active: [...all, 'control'] },
    { name: 'move_out', action: 'move_out', key: 'source-1', variant: 'open', active: ['source-0', 'source-2', 'control'] },
    { name: 'move_back', action: 'move_back', key: 'source-1', variant: 'open', active: [...all, 'control'] },
    { name: 'trash', action: 'trash', key: 'control', variant: 'open', active: all },
    { name: 'restore', action: 'restore', key: 'control', variant: 'open', active: [...all, 'control'] },
    { name: 'final_unchanged', action: 'none', variant: 'open', active: [...all, 'control'] },
  ];
}

export function contentStamp(file) {
  if (!Number.isSafeInteger(Number(file.size)) || Number(file.size) <= 0 || Number(file.size) > 512 * 1024 * 1024 || !/^[a-f0-9]{32}$/.test(file.md5Checksum || '')) throw Error('SOURCE_METADATA_INVALID');
  return `${file.size}:${file.md5Checksum}`;
}

/** Export only predicate results, never metadata values (including hashes,
 * names, sizes, parents or owner identities). Preserve the existing guard's
 * boolean semantics; missing fields are reported separately, not guessed. */
export function originalSourceDiagnostics(meta, expected, folder, index) {
  const validators = {
    ownedByMe: value => typeof value === 'boolean',
    shared: value => typeof value === 'boolean',
    trashed: value => typeof value === 'boolean',
    parents: value => Array.isArray(value) && value.every(id => typeof id === 'string'),
    size: value => (typeof value === 'string' && /^\d+$/.test(value) || typeof value === 'number') && Number.isSafeInteger(Number(value)) && Number(value) >= 0,
    md5Checksum: value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value),
  };
  const checks = {
    ownedByMe: !!meta.ownedByMe,
    notShared: !meta.shared,
    notTrashed: !meta.trashed,
    parentMatches: Array.isArray(meta.parents) && meta.parents.includes(folder),
    sizeMatches: Number(meta.size) === expected.size,
    md5Matches: meta.md5Checksum === expected.md5,
  };
  const missingFields = Object.keys(validators).filter(key => meta[key] === undefined || meta[key] === null);
  const invalidFields = Object.keys(validators).filter(key => !missingFields.includes(key) && !validators[key](meta[key]));
  return { source: index + 1, checks, failedChecks: Object.keys(checks).filter(key => !checks[key]),
    missingFields, invalidFields, passesOriginalGuard: Object.values(checks).every(Boolean) };
}

/** Keys are real Drive IDs; ordering, renames, and metadata versions are not
 * content changes. Publication can still retain the updated names. */
export function inventoryDiff(previous, current) {
  const added = [], changed = [], removed = [], renamed = [];
  for (const [id, file] of Object.entries(current)) {
    const before = previous[id];
    if (!before) added.push(id);
    else if (contentStamp(before) !== contentStamp(file)) changed.push(id);
    else if (before.name !== file.name) renamed.push(id);
  }
  for (const id of Object.keys(previous)) if (!current[id]) removed.push(id);
  return { added, changed, removed, renamed, contentChanged: !!(added.length || changed.length || removed.length) };
}

export function inventorySignature(files) {
  return Object.keys(files).sort().map(id => [id, contentStamp(files[id])]);
}

export function normalizedRuns(values, hash) {
  const seen = new Set(), sources = [];
  for (const item of [...values].sort((a, b) => a.key.localeCompare(b.key))) {
    if (seen.has(item.gpsHash)) continue;
    seen.add(item.gpsHash); sources.push(item);
  }
  sources.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
  for (let i = 1; i < sources.length; i++) if (sources[i].start < sources[i - 1].end) throw Error('OVERLAPPING_SOURCES_REQUIRE_SELECTION');
  return sources.flatMap(s => s.runs.map(run => ({ ...run, id: 'r_' + hash(s.key).slice(0, 24) + '_' + run.date })));
}
