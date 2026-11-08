const R = 6371008.8;
const rad = x => x * Math.PI / 180;
export const wrap = x => ((x + 540) % 360) - 180;
export function distance(a, b) {
  const dlat = rad(b[0] - a[0]), dlon = rad(wrap(b[1] - a[1]));
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dlon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(Math.min(1, h)), Math.sqrt(Math.max(0, 1 - h)));
}
export function interpolate(a, b, f) { return [a[0] + (b[0] - a[0]) * f, wrap(a[1] + wrap(b[1] - a[1]) * f)]; }
export function perpendicular(p, a, b) {
  const scale = R * Math.PI / 180, cos = Math.cos(rad(p[0]));
  const ax = wrap(a[1] - p[1]) * scale * cos, ay = (a[0] - p[0]) * scale;
  const bx = ax + wrap(b[1] - a[1]) * scale * cos, by = (b[0] - p[0]) * scale;
  const dx = bx - ax, dy = by - ay, t = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Bounded-window RDP. Geometry error, speed range and maximum chord length
 * constrain removal separately; numerical summaries never use this result. */
export function simplify(segment, { meters = 2, speedErrorKmh = .5, maxChordMeters = 200, window = 512 } = {}) {
  const { points, seconds, distances } = segment;
  if (points.length < 2) return { points: points.slice(), speedsKmh: [], maxErrorMeters: 0, maxSpeedErrorKmh: 0 };
  const prefixD = [0], prefixT = [0];
  for (let i = 0; i < distances.length; i++) { prefixD.push(prefixD.at(-1) + distances[i]); prefixT.push(prefixT.at(-1) + seconds[i]); }
  const kept = new Set([0, points.length - 1]); let maxErrorMeters = 0, maxSpeedError = 0;
  const stack = [];
  for (let start = 0; start < points.length - 1; start += window) {
    const end = Math.min(points.length - 1, start + window); kept.add(start); kept.add(end); stack.push([start, end]);
  }
  while (stack.length) {
    const [start, end] = stack.pop();
    if (end - start < 2) continue;
    const speed = (prefixD[end] - prefixD[start]) / (prefixT[end] - prefixT[start]) * 3.6;
    let worst = 0, split = -1, geometryError = 0, speedError = 0;
    for (let i = start + 1; i < end; i++) {
      const error = perpendicular(points[i], points[start], points[end]); geometryError = Math.max(geometryError, error);
      if (error / meters > worst) { worst = error / meters; split = i; }
    }
    for (let i = start; i < end; i++) {
      const error = Math.abs(distances[i] / seconds[i] * 3.6 - speed); speedError = Math.max(speedError, error);
      if (error / speedErrorKmh > worst) { worst = error / speedErrorKmh; split = Math.min(end - 1, Math.max(start + 1, i)); }
    }
    if (distance(points[start], points[end]) > maxChordMeters) { worst = 2; split = Math.floor((start + end) / 2); }
    if (worst > 1) { kept.add(split); stack.push([start, split], [split, end]); }
    else { maxErrorMeters = Math.max(maxErrorMeters, geometryError); maxSpeedError = Math.max(maxSpeedError, speedError); }
  }
  const indices = [...kept].sort((a, b) => a - b);
  return { points: indices.map(i => points[i]), speedsKmh: indices.slice(1).map((end, n) => {
    const start = indices[n]; return (prefixD[end] - prefixD[start]) / (prefixT[end] - prefixT[start]) * 3.6;
  }), maxErrorMeters, maxSpeedErrorKmh: maxSpeedError };
}

// Integer deltas avoid repeated long decimal coordinates and color strings.
// E6 rounding has <=0.08m positional error; speed rounding adds <=0.05km/h.
export function packSegment({ points, speedsKmh = [] }) {
  if (!points.length) return null;
  const q = points.map(p => p.map(n => Math.round(n * 1e6)));
  return [q[0], ...q.slice(1).map((p, i) => [p[0] - q[i][0], Math.round(wrap((p[1] - q[i][1]) / 1e6) * 1e6), Number.isFinite(speedsKmh[i]) ? Math.round(speedsKmh[i] * 10) : null])];
}

export function thumbnail(segments) {
  const all = segments.flatMap(s => s.points);
  if (!all.length) return [];
  const origin = all[0], cos = Math.cos(rad(origin[0]));
  const paths = segments.map(s => s.points.map(p => [wrap(p[1] - origin[1]) * cos, -(p[0] - origin[0])]));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const path of paths) for (const [x, y] of path) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const scale = Math.min(600 / Math.max(1e-12, maxX - minX), 400 / Math.max(1e-12, maxY - minY));
  const tx = (720 - (maxX - minX) * scale) / 2, ty = (520 - (maxY - minY) * scale) / 2;
  return paths.map(path => {
    const points = path.map(([x, y]) => [Math.round(tx + (x - minX) * scale), Math.round(ty + (y - minY) * scale)]);
    const kept = new Set([0, points.length - 1]), stack = [[0, points.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop(); let worst = 4, split = -1;
      const [ax, ay] = points[s], [bx, by] = points[e], dx = bx - ax, dy = by - ay;
      for (let i = s + 1; i < e; i++) {
        const [x, y] = points[i], t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0;
        const error = Math.hypot(x - ax - t * dx, y - ay - t * dy);
        if (error > worst) { worst = error; split = i; }
      }
      if (split >= 0) { kept.add(split); stack.push([s, split], [split, e]); }
    }
    return [...kept].sort((a, b) => a - b).map(i => points[i]);
  });
}
