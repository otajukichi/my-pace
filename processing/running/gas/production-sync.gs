function prStamp(file) { return MP_SYNC.contentStamp(file); }
function prNormalKey(file) { return mpHash({ kind: 'normalized', key: { algorithm: MP_DERIVE.ALGORITHM, content: prStamp(file) } }); }
function prSignature(files) { return mpHash(MP_SYNC.inventorySignature(files)); }
function prScanStart() { pr.state.scan = { queue: [{ id: pr.root.source, depth: 0 }], at: 0, token: null, tokens: [], files: {}, seen: [pr.root.source] }; prSave(); }
function prScanStep() {
  const scan = pr.state.scan, folder = scan.queue[scan.at];
  prPrivate(prMeta(folder.id), folder.parent, PR_FOLDER); prYield();
  const page = prApi('files?q=' + encodeURIComponent("'" + folder.id + "' in parents and trashed = false")
    + '&spaces=drive&pageSize=1000&fields=' + encodeURIComponent('files(' + PR_FIELDS + '),nextPageToken,incompleteSearch')
    + (scan.token ? '&pageToken=' + encodeURIComponent(scan.token) : ''));
  prAssert(!page.incompleteSearch && Array.isArray(page.files), 'INCOMPLETE_SOURCE_LIST');
  for (const file of page.files) {
    if (file.mimeType === PR_FOLDER) {
      prPrivate(file, folder.id, PR_FOLDER); prAssert(folder.depth < 16 && !scan.seen.includes(file.id), 'SOURCE_FOLDER_CYCLE_OR_DEPTH');
      scan.queue.push({ id: file.id, parent: folder.id, depth: folder.depth + 1 }); scan.seen.push(file.id);
    } else if (/\.csv$/i.test(file.name || '') && file.mimeType !== 'application/vnd.google-apps.shortcut') {
      prPrivate(file, folder.id); prStamp(file); prAssert(!scan.files[file.id], 'DUPLICATE_SOURCE'); scan.files[file.id] = file;
    }
  }
  if (page.nextPageToken) {
    prAssert(!scan.tokens.includes(page.nextPageToken), 'DRIVE_PAGE_LOOP'); scan.tokens.push(page.nextPageToken); scan.token = page.nextPageToken;
  } else { scan.at++; scan.token = null; scan.tokens = []; }
  if (scan.at === scan.queue.length) { pr.state.inventory = scan.files; pr.state.scan = null; prCount('polls'); }
  prSave();
}
function prCheckSource(file) {
  let now;
  try { now = prMeta(file.id); } catch (error) { if (error.message === 'DRIVE_HTTP_404') throw Error('SOURCE_CHANGED_DURING_READ'); throw error; }
  prSource(now);
  prAssert(prStamp(now) === prStamp(file) && now.version === file.version, 'SOURCE_CHANGED_DURING_READ');
}
function prNormalize() {
  const s = pr.state, job = s.job, file = job.files[job.queue[job.next]], key = prNormalKey(file);
  if (prUnitRead(key) !== undefined) { job.next++; job.parser = null; job.offset = 0; job.digest = null; prCount('normalizedReused'); prSave(); return; }
  if (!job.parser?.finished) {
    prCheckSource(file);
    const from = job.offset, to = Math.min(Number(file.size), from + 1048576) - 1;
    prCount('rawBytesRequested', to - from + 1);
    const r = prFetch('https://www.googleapis.com/drive/v3/files/' + prId(file.id) + '?alt=media', { headers: { Range: 'bytes=' + from + '-' + to } });
    const headers = r.getAllHeaders(), range = Object.keys(headers).find(k => k.toLowerCase() === 'content-range');
    prAssert(r.getResponseCode() === 206 && headers[range] === 'bytes ' + from + '-' + to + '/' + file.size, 'RANGE_NOT_HONORED');
    const bytes = r.getBlob().getBytes(); prAssert(bytes.length === to - from + 1, 'SOURCE_RANGE_TRUNCATED');
    job.digest = MP_MD5.md5Update(job.digest, bytes); job.parser = MP_CORE.parseChunk(job.parser, bytes, to + 1 === Number(file.size));
    job.offset = to + 1; prCount('csvChunks'); prSave(); return;
  }
  prCheckSource(file); prAssert(job.digest.length === Number(file.size) && MP_MD5.md5Finish(job.digest) === file.md5Checksum, 'SOURCE_CHECKSUM_MISMATCH');
  const parsed = job.parser.finished, gpsHash = mpHash({ start: parsed.start, end: parsed.end, fixes: parsed.fixes });
  prUnitPut(key, { key: gpsHash, gpsHash, start: parsed.start, end: parsed.end, runs: MP_DERIVE.deriveSource(parsed) });
  job.next++; job.parser = null; job.offset = 0; job.digest = null; prCount('normalizedComputed'); prSave();
}
function prPlan() {
  const s = pr.state, inventory = s.inventory, signature = prSignature(inventory);
  const diff = MP_SYNC.inventoryDiff(s.committed, inventory);
  s.sourceCount = Object.keys(inventory).length; s.sourceBytes = Object.values(inventory).reduce((n, f) => n + Number(f.size), 0);
  s.pending = diff.added.length + diff.changed.length;
  if (!diff.contentChanged && !s.needPublish) { s.committed = inventory; s.observed = null; prSave(); return 'WATCHING'; }
  if (s.observed !== signature) { s.observed = signature; prSave(); return 'SETTLING'; }
  // New uploads take priority; publish small complete generations while older
  // history is still queued. The inventory is always complete before deletions.
  const selected = [...diff.changed, ...diff.added].sort((a, b) => (inventory[b].modifiedTime || '').localeCompare(inventory[a].modifiedTime || '') || a.localeCompare(b)).slice(0, 3);
  const files = {};
  for (const id of Object.keys(s.committed)) if (inventory[id]) files[id] = selected.includes(id) ? inventory[id] : s.committed[id];
  for (const id of selected) files[id] = inventory[id];
  s.job = { phase: 'normalize', files, queue: Object.keys(files).sort(), next: 0, parser: null, digest: null, offset: 0,
    observed: signature, objectAt: 0 };
  prSave(); return 'PROCESSING';
}
function prAssemble() {
  if (pr.result) return pr.result;
  const s = pr.state, values = Object.values(s.job.files).map(f => {
    const value = prUnitRead(prNormalKey(f)); prAssert(value, 'NORMALIZED_CACHE_MISSING'); return value;
  });
  const runs = MP_SYNC.normalizedRuns(values, mpHash), descriptions = MP_INCREMENTAL.describeRuns(runs);
  const cached = (kind, key, compute) => prUnit(kind, key, compute);
  const fresh = MP_INCREMENTAL.incrementalFresh(descriptions, cached);
  const mask = MP_MASK.incrementalMask(descriptions, cached, { explorationCellVisits: 0 });
  // No monolithic assembled-result checkpoint: individual 128 KiB display
  // objects are written before the small catalog, using the existing format.
  pr.result = MP_CORE.assembleProbeArtifacts(runs, fresh, mask, { hash: mpHash, byteLength: text => prBytes(text).length, cached });
  return pr.result;
}
function prObject(object) {
  const name = object.path.slice(8), s = pr.state;
  prAssert(/^[a-f0-9]{64}\.json$/.test(name) && object.bytes <= 131072 && mpHash(object.content) === name.slice(0, -5), 'ARTIFACT_INVALID');
  let id = s.artifacts[name];
  if (!id) id = prAllocate('artifact-' + name);
  const meta = prMeta(id, true);
  if (meta) {
    prPrivate(meta, pr.root.derived, 'application/json');
    prAssert(meta.name === name && Number(meta.size) === object.bytes && meta.md5Checksum === prDigest(Utilities.DigestAlgorithm.MD5, prBytes(object.content)), 'ARTIFACT_CHANGED');
  } else prWrite(id, name, object.content, pr.root.derived);
  s.artifacts[name] = id;
}
function prPublicationStep() {
  const s = pr.state, job = s.job;
  if (job.phase === 'normalize') {
    if (job.next < job.queue.length) { prNormalize(); return 'PROCESSING'; }
    job.phase = 'objects'; prSave();
  }
  if (job.phase === 'objects') {
    const result = prAssemble(); prYield();
    if (job.objectAt < result.objects.length) {
      prObject(result.objects[job.objectAt]); job.objectAt++; prSave(); return 'PROCESSING';
    }
    job.catalog = result.catalogContent; job.hash = mpHash(job.catalog); job.phase = 'confirm';
    prScanStart(); return 'PROCESSING';
  }
  if (job.phase === 'confirm') {
    if (s.scan) { prScanStep(); return 'PROCESSING'; }
    // A changed source cancels only this generation; normalized/cache units
    // remain reusable and the app retains the last successfully published view.
    if (prSignature(s.inventory) !== job.observed) {
      s.job = null; s.observed = null; pr.result = null; prSave(); return 'INPUT_CHANGED_RETRY';
    }
    const id = prAllocate('catalog-' + job.hash);
    prWrite(id, 'catalog-' + job.hash + '.json', job.catalog, pr.root.system);
    job.backup = id; job.phase = 'publish'; prSave(); return 'PROCESSING';
  }
  prAssert(job.phase === 'publish', 'UNKNOWN_PHASE');
  // Root checks happen on every invocation; only this registered index is mutable.
  prWrite(pr.root.catalog, 'index.json', job.catalog, pr.root.derived, { expected: s.catalogHash });
  s.previous = s.current; s.current = { id: job.backup, hash: job.hash };
  s.catalogHash = job.hash; s.committed = job.files; s.job = null; s.observed = null; s.needPublish = false;
  s.pending = MP_SYNC.inventoryDiff(s.committed, s.inventory).added.length + MP_SYNC.inventoryDiff(s.committed, s.inventory).changed.length;
  s.lastPublishedAt = Date.now(); prCount('publications'); prSave(); return 'UPDATED';
}
