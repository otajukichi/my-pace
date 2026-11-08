// Reader boundary for the new prepared data. The current UI switches to this
// only after authenticated transport is wired; no raw CSV is ever a fallback.
export function decodeRoute(value) {
  if (value?.schema !== 1 || value.kind !== 'route' || value.encoding !== 'delta-e6-speed10' || !Array.isArray(value.segments)) throw Error('RUN_ROUTE_SCHEMA');
  const segments = value.segments.map(record => {
    if (!record || !Number.isSafeInteger(record.chain) || record.chain < 0 || !Number.isSafeInteger(record.part) || record.part < 0) throw Error('RUN_ROUTE_CHAIN');
    const encoded = record.data;
    if (!Array.isArray(encoded) || !encoded.length || encoded[0].length !== 2 || !encoded[0].every(Number.isSafeInteger)) throw Error('RUN_ROUTE_COORDINATE');
    let [lat, lon] = encoded[0];
    const point = () => { if (Math.abs(lat) > 90000000 || Math.abs(lon) > 180000000) throw Error('RUN_ROUTE_COORDINATE'); return [lat / 1e6, lon / 1e6]; };
    const points = [point()], speedsKmh = [];
    for (const step of encoded.slice(1)) {
      if (step.length !== 3 || !step.slice(0, 2).every(Number.isSafeInteger) || !(step[2] === null || Number.isSafeInteger(step[2]) && step[2] >= 0)) throw Error('RUN_ROUTE_STEP');
      lat += step[0]; lon = ((lon + step[1] + 540000000) % 360000000) - 180000000;
      points.push(point()); speedsKmh.push(step[2] === null ? null : step[2] / 10);
    }
    return { chain: record.chain, part: record.part, points, speedsKmh };
  });
  return { id: value.id, date: value.date, segments, quality: value.quality };
}

/** Join transport chunks only when the explicit chain and part numbers agree.
 * Two GPS pieces that happen to meet at one coordinate remain separate. */
export function joinRouteParts(parts) {
  if (!parts.length) return { segments: [] };
  const first = parts[0], chains = new Map();
  for (const route of parts) {
    if (route.id !== first.id || route.date !== first.date) throw Error('RUN_ROUTE_ID_MISMATCH');
    for (const segment of route.segments) {
      const previous = chains.get(segment.chain);
      if (!previous) {
        if (segment.part !== 0) throw Error('RUN_ROUTE_PART_MISSING');
        chains.set(segment.chain, { points: segment.points.slice(), speedsKmh: segment.speedsKmh.slice(), part: 0 });
      } else {
        const end = previous.points.at(-1), start = segment.points[0];
        if (segment.part !== previous.part + 1 || end[0] !== start[0] || end[1] !== start[1]) throw Error('RUN_ROUTE_PART_MISMATCH');
        previous.points.push(...segment.points.slice(1)); previous.speedsKmh.push(...segment.speedsKmh); previous.part++;
      }
    }
  }
  return { id: first.id, date: first.date, quality: first.quality,
    segments: [...chains].sort(([a], [b]) => a - b).map(([, { points, speedsKmh }]) => ({ points, speedsKmh })) };
}

export function decodeMask(rle, size = 64) {
  if (!Array.isArray(rle) || rle.length % 2) throw Error('RUN_MASK_SCHEMA');
  const cells = new Uint8Array(size * size); let offset = 0;
  for (let i = 0; i < rle.length; i += 2) {
    const [length, alpha] = rle.slice(i, i + 2);
    if (!Number.isInteger(length) || length <= 0 || offset + length > cells.length || !Number.isInteger(alpha) || alpha < 0 || alpha > 255) throw Error('RUN_MASK_SCHEMA');
    cells.fill(alpha, offset, offset + length); offset += length;
  }
  if (offset !== cells.length) throw Error('RUN_MASK_LENGTH');
  return cells;
}

/** Caller supplies an authenticated fetch transport. Objects are immutable;
 * the mutable catalog is explicitly refreshed. A bounded in-memory cache
 * coalesces repeat reads without retaining the whole history on the device. */
export function createRunningRepository({ fetchJson, cacheSize = 32 }) {
  if (typeof fetchJson !== 'function') throw TypeError('RUN_TRANSPORT_REQUIRED');
  const cache = new Map();
  async function object(ref, kind) {
    if (!ref || !/^objects\/[a-f0-9]{64}\.json$/.test(ref.path) || !Number.isInteger(ref.bytes) || ref.bytes > 131072) throw Error('RUN_REFERENCE_INVALID');
    let pending = cache.get(ref.path);
    if (!pending) {
      pending = Promise.resolve().then(() => fetchJson(ref.path)).then(value => {
        if (value?.schema !== 1 || value.kind !== kind) throw Error('RUN_OBJECT_SCHEMA');
        return value;
      }).catch(error => { if (cache.get(ref.path) === pending) cache.delete(ref.path); throw error; });
      cache.set(ref.path, pending);
      if (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    } else { cache.delete(ref.path); cache.set(ref.path, pending); }
    return pending;
  }
  return {
    async catalog() { const x = await fetchJson('index.json'); if (x?.schema !== 1 || x.kind !== 'catalog') throw Error('RUN_CATALOG_SCHEMA'); return x; },
    year: ref => object(ref, 'year'),
    month: ref => object(ref, 'month'),
    async route(refs) { return joinRouteParts((await Promise.all(refs.map(ref => object(ref, 'route')))).map(decodeRoute)); },
    analysis: ref => object(ref, 'analysis'),
    overview: refs => Promise.all(refs.map(ref => object(ref, 'overview'))),
    exploration: refs => Promise.all(refs.map(ref => object(ref, 'exploration'))),
    clear() { cache.clear(); },
  };
}
