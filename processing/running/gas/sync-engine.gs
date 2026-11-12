// General synchronizer: it knows only the inbox, metadata and durable state.
// No scenario keys, seed manifest, known chunk hashes or reference catalogs.
function msInput(meta) {
  miAssert(meta && meta.ownedByMe === true && meta.shared === false && !meta.trashed, 'INPUT_NOT_OWNER_PRIVATE');
  miAssert(meta.parents?.length === 1 && meta.parents[0] === mi.root.raw, 'INPUT_PARENT_CHANGED');
  miAssert(/\.csv$/i.test(meta.name || '') && !meta.mimeType?.startsWith('application/vnd.google-apps.'), 'INPUT_TYPE_CHANGED');
  MP_SYNC.contentStamp(meta);
}
function msInventory() {
  miOwned(miMeta(mi.root.raw), 'folder', mi.root.folder);
  const files = {}, seen = new Set(); let token;
  do {
    miYield(); miAssert(!seen.has(token), 'DRIVE_PAGE_LOOP'); seen.add(token);
    const page = miApi('files?q=' + encodeURIComponent("'" + mi.root.raw + "' in parents and trashed = false")
      + '&spaces=drive&pageSize=1000&fields=' + encodeURIComponent('nextPageToken,incompleteSearch,files(' + MI_FIELDS + ')')
      + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
    miAssert(!page.incompleteSearch && Array.isArray(page.files), 'DRIVE_INCOMPLETE_INVENTORY');
    for (const file of page.files) {
      if (!/\.csv$/i.test(file.name || '')) continue;
      msInput(file); miAssert(!files[file.id], 'DRIVE_DUPLICATE_FILE'); files[file.id] = file;
    }
    miAssert(Object.keys(files).length <= 25, 'PROBE_SOURCE_COUNT_LIMIT');
    token = page.nextPageToken;
  } while (token);
  miCount('polls'); return files;
}
function msSignature(files) { return mpHash(MP_SYNC.inventorySignature(files)); }
function msNormalizedKey(file) { return mpHash({ id: file.id, content: MP_SYNC.contentStamp(file), algorithm: MP_DERIVE.ALGORITHM }); }
function msCheckRevision(file) {
  const current = miMeta(file.id); msInput(current);
  miAssert(MP_SYNC.contentStamp(current) === MP_SYNC.contentStamp(file) && current.version === file.version, 'SOURCE_CHANGED_DURING_READ');
}
function msNormalize() {
  const s = mi.state, job = s.job, file = job.files[job.queue[job.next]], key = msNormalizedKey(file);
  if (s.normalized[key]) { job.next++; job.parser = null; job.offset = 0; job.digest = null; miCount('normalizedReused'); miSave(); return; }
  if (!job.parser?.finished) {
    if (job.offset === 0) msCheckRevision(file);
    const from = job.offset, to = Math.min(Number(file.size), from + 1048576) - 1;
    miCount('rawBytesRequested', to - from + 1);
    const response = miFetch('https://www.googleapis.com/drive/v3/files/' + file.id + '?alt=media', { headers: { Range: 'bytes=' + from + '-' + to } });
    const headers = response.getAllHeaders(), range = Object.keys(headers).find(k => k.toLowerCase() === 'content-range');
    miAssert(response.getResponseCode() === 206 && headers[range] === 'bytes ' + from + '-' + to + '/' + file.size, 'RANGE_NOT_HONORED');
    const bytes = response.getBlob().getBytes(); miAssert(bytes.length === to - from + 1, 'SOURCE_RANGE_TRUNCATED');
    job.digest = MP_MD5.md5Update(job.digest, bytes);
    job.parser = MP_CORE.parseChunk(job.parser, bytes, to + 1 === Number(file.size)); job.offset = to + 1;
    miSave(); miCount('csvChunks'); return;
  }
  miAssert(job.digest.length === Number(file.size) && MP_MD5.md5Finish(job.digest) === file.md5Checksum, 'SOURCE_CHECKSUM_MISMATCH');
  msCheckRevision(file);
  const parsed = job.parser.finished, gpsHash = mpHash({ start: parsed.start, end: parsed.end, fixes: parsed.fixes });
  // Content-derived identity also makes duplicate exports and renames stable.
  const value = { key: gpsHash, gpsHash, start: parsed.start, end: parsed.end, runs: MP_DERIVE.deriveSource(parsed) };
  const id = miAllocate('normalized-' + key); miWrite(id, 'normalized-' + key + '.json', value, 'normalized', mi.root.system, true);
  s.normalized[key] = id; job.next++; job.parser = null; job.offset = 0; job.digest = null;
  miCount('normalizedComputed'); miSave();
}
function msAssemble() {
  const s = mi.state, job = s.job, key = { algorithm: MP_DERIVE.ALGORITHM, input: MP_SYNC.inventorySignature(job.files) };
  const cachedResult = s.cache[mpHash({ kind: 'assembled', key })];
  if (cachedResult) { job.result = cachedResult; job.phase = 'objects'; job.objectIndex = 0; miCount('assembledReused'); miSave(); return; }
  const values = Object.values(job.files).map(f => miRead(s.normalized[msNormalizedKey(f)], 'normalized'));
  const runs = MP_SYNC.normalizedRuns(values, mpHash), descriptions = MP_INCREMENTAL.describeRuns(runs);
  const cached = (kind, cacheKey, compute) => miUnit(kind, cacheKey, compute);
  const fresh = MP_INCREMENTAL.incrementalFresh(descriptions, cached);
  const mask = MP_MASK.incrementalMask(descriptions, cached, { explorationCellVisits: 0 });
  miUnit('assembled', key, () => MP_CORE.assembleProbeArtifacts(runs, fresh, mask, { hash: mpHash, byteLength: text => miBytes(text).length, cached }));
  job.result = s.cache[mpHash({ kind: 'assembled', key })]; job.phase = 'objects'; job.objectIndex = 0; miSave();
}
function msResult() {
  if (!mi.result) mi.result = miRead(mi.state.job.result, 'cache'); return mi.result;
}
function msSyncStep() {
  const s = mi.state;
  if (!s.job) {
    const files = mi.inventory || msInventory(), signature = msSignature(files);
    miAssert(Object.keys(files).length > 0, 'EMPTY_INVENTORY_REQUIRES_REVIEW');
    const diff = MP_SYNC.inventoryDiff(s.committed, files);
    s.diff = Object.fromEntries(['added', 'changed', 'removed', 'renamed'].map(k => [k, diff[k].length]));
    if (!diff.contentChanged && s.catalogHash) { s.committed = files; s.observed = null; miSave(); return 'UNCHANGED'; }
    if (s.observed !== signature) { s.observed = signature; miSave(); return 'SETTLING'; }
    s.job = { files, phase: 'normalize', queue: Object.keys(files).sort(), next: 0, offset: 0, parser: null, digest: null };
    miSave();
  }
  const job = s.job;
  if (job.phase === 'normalize') {
    if (job.next < job.queue.length) { msNormalize(); return 'IN_PROGRESS'; }
    job.phase = 'compute'; miSave(); return 'IN_PROGRESS';
  }
  if (job.phase === 'compute') { msAssemble(); return 'IN_PROGRESS'; }
  const result = msResult();
  if (job.phase === 'objects') {
    if (job.objectIndex < result.objects.length) {
      const object = result.objects[job.objectIndex], name = object.path.slice(8), id = miAllocate('artifact-' + name);
      if (!s.artifacts[name]) { miWrite(id, name, object.content, 'artifact', mi.root.derived, true); s.artifacts[name] = id; miCount('objectsCreated'); }
      else miCount('objectsReused');
      job.objectIndex++; miSave(); return 'IN_PROGRESS';
    }
    job.phase = 'verify'; job.verifyIndex = 0; miSave(); return 'IN_PROGRESS';
  }
  miAssert(job.phase === 'verify', 'UNKNOWN_SYNC_PHASE');
  if (job.verifyIndex < result.objects.length) {
    const object = result.objects[job.verifyIndex], name = object.path.slice(8);
    miAssert(mpHash(miRead(s.artifacts[name], 'artifact', mi.root.derived)) === name.slice(0, -5), 'ARTIFACT_READBACK_MISMATCH');
    job.verifyIndex++; miSave(); return 'IN_PROGRESS';
  }
  const current = msInventory();
  miAssert(msSignature(current) === msSignature(job.files), 'SOURCE_CHANGED_BEFORE_PUBLICATION');
  const digest = mpHash(result.catalogContent), generation = miAllocate('generation-' + digest);
  miWrite(generation, 'generation-' + digest + '.json', result.catalogContent, 'generation', mi.root.derived, true);
  miAssert(mpHash(miRead(generation, 'generation', mi.root.derived)) === digest, 'CATALOG_READBACK_MISMATCH');
  // Only a fully verified catalog replaces the current view. The previous
  // catalog remains immutable and all referenced objects are retained.
  miWrite(mi.root.catalog, mi.root.catalogName || 'index.json', result.catalogContent, 'catalog', mi.root.derived, false);
  miAssert(mpHash(miRead(mi.root.catalog, 'catalog', mi.root.derived)) === digest, 'CATALOG_READBACK_MISMATCH');
  if (s.catalogHash !== digest) s.generations = [...s.generations, { id: generation, hash: digest }].slice(-2);
  s.catalogHash = digest; s.committed = current; s.job = null; s.observed = null; mi.result = null;
  miCount('publications'); miSave(); return 'SYNCED';
}
