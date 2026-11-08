import { distance, interpolate, simplify, packSegment, thumbnail } from './geometry.js';

export const ALGORITHM = 'running-display-v2';
export const POLICY = Object.freeze({ dayBoundaryHourJst: 3, maxFixGapSeconds: 120, maxEdgeMeters: 250, maxSpeedMps: 15, detailErrorMeters: 2, overviewErrorMeters: 6,
  explorationGrid: 'mercator-z16-64', explorationJoinMeters: 20, explorationRevealMeters: 60, freshRoadToleranceMeters: 30 });
const DAY = 86400000, OFFSET = 6 * 3600000;
export const activityDate = t => new Date(t + OFFSET).toISOString().slice(0, 10);
const dayStart = date => Date.parse(date + 'T00:00:00Z') - OFFSET;
const round = (n, digits = 3) => Number(n.toFixed(digits));

/** Aggregate unthinned, valid GPS edges. The derivative is reproducible from
 * raw data; gaps and impossible jumps never become straight shortcut lines. */
export function deriveSource(source) {
  const { start, end, fixes } = source, days = new Map();
  function day(date) {
    if (!days.has(date)) {
      const from = Math.max(start, dayStart(date)), to = Math.min(end, dayStart(date) + DAY);
      days.set(date, { date, start: from, end: to, segments: [], edges: [], quality: { rejectedEdges: 0 }, distanceMeters: 0 });
    }
    return days.get(date);
  }
  for (let t = start; t < end; t = dayStart(activityDate(t)) + DAY) day(activityDate(t));
  if (!days.size) day(activityDate(start));
  let active = null;
  for (let i = 0; i < fixes.length; i++) {
    const b = fixes[i], bp = [b.lat, b.lon], a = fixes[i - 1];
    if (!a) { const d = day(activityDate(b.t)); d.segments.push({ points: [bp], distances: [], seconds: [] }); active = { date: d.date, segment: d.segments.at(-1) }; continue; }
    const ap = [a.lat, a.lon], seconds = (b.t - a.t) / 1000, meters = distance(ap, bp);
    if (b.breakBefore || !(seconds > 0) || seconds > POLICY.maxFixGapSeconds || meters > POLICY.maxEdgeMeters || meters / seconds > POLICY.maxSpeedMps) {
      const d = day(activityDate(b.t)); d.quality.rejectedEdges++;
      d.segments.push({ points: [bp], distances: [], seconds: [] }); active = { date: d.date, segment: d.segments.at(-1) }; continue;
    }
    let t = a.t;
    while (t < b.t) {
      const date = activityDate(t), until = Math.min(b.t, dayStart(date) + DAY), d = day(date);
      const f0 = (t - a.t) / (b.t - a.t), f1 = (until - a.t) / (b.t - a.t);
      const from = interpolate(ap, bp, f0), to = interpolate(ap, bp, f1), spanD = meters * (f1 - f0), spanT = (until - t) / 1000;
      if (active?.date !== date) { d.segments.push({ points: [from], distances: [], seconds: [] }); active = { date, segment: d.segments.at(-1) }; }
      active.segment.points.push(to); active.segment.distances.push(spanD); active.segment.seconds.push(spanT);
      d.edges.push({ from: (t - d.start) / 1000, to: (until - d.start) / 1000, meters: spanD }); d.distanceMeters += spanD; t = until;
    }
  }
  // The final repeated readings establish elapsed time, not extra distance.
  const last = fixes.at(-1);
  if (last && last.lastT > last.t && last.lastT - last.t <= POLICY.maxFixGapSeconds * 1000) {
    for (let t = last.t; t < last.lastT;) {
      const d = day(activityDate(t)), until = Math.min(last.lastT, dayStart(d.date) + DAY);
      d.edges.push({ from: (t - d.start) / 1000, to: (until - d.start) / 1000, meters: 0 }); t = until;
    }
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(d => {
    const durationSeconds = (d.end - d.start) / 1000, observedSeconds = d.edges.reduce((n, e) => n + e.to - e.from, 0);
    const buckets = Array.from({ length: Math.ceil(durationSeconds / 60) }, (_, i) => ({ from: i * 60, to: Math.min(durationSeconds, (i + 1) * 60), meters: 0, observed: 0 }));
    let splitStart = 0, splitObserved = 0, splitDistance = 0;
    const splits = [];
    for (const e of d.edges) {
      for (let i = Math.floor(e.from / 60); i < buckets.length && buckets[i].from < e.to; i++) {
        const b = buckets[i], seconds = Math.max(0, Math.min(e.to, b.to) - Math.max(e.from, b.from));
        b.meters += e.meters * seconds / (e.to - e.from); b.observed += seconds;
      }
      let fraction = 0;
      while (fraction < 1) {
        const remaining = 1000 - splitDistance, df = e.meters > 0 ? Math.min(1 - fraction, remaining / e.meters) : 1;
        splitDistance += e.meters * df; splitObserved += (e.to - e.from) * df; fraction += df;
        // Below the stored millimetre precision, floating point geodesic noise
        // must not turn an exact kilometre into a spurious partial split.
        if (splitDistance >= 1000 - .0005) {
          const at = e.from + (e.to - e.from) * fraction, seconds = at - splitStart;
          splits.push({ kilometer: splits.length + 1, distanceMeters: 1000, durationSeconds: round(seconds), paceSecondsPerKm: round(seconds), coverage: round(Math.min(1, splitObserved / seconds)) });
          splitStart = at; splitDistance = 0; splitObserved = 0;
        }
      }
    }
    if (splitDistance > 1e-7) {
      const seconds = durationSeconds - splitStart;
      splits.push({ kilometer: splits.length + 1, partial: true, distanceMeters: round(splitDistance), durationSeconds: round(seconds), paceSecondsPerKm: round(seconds / (splitDistance / 1000)), coverage: round(Math.min(1, splitObserved / seconds)) });
    }
    const paceSamples = buckets.map(b => ({ elapsedSeconds: round((b.from + b.to) / 2), paceSecondsPerKm: b.meters > 0 ? round((b.to - b.from) / b.meters * 1000) : null, coverage: round(b.observed / (b.to - b.from)) }));
    return {
      date: d.date, start: d.start, end: d.end,
      summary: { distanceMeters: round(d.distanceMeters), durationSeconds: round(durationSeconds), paceSecondsPerKm: d.distanceMeters > 0 ? round(durationSeconds / d.distanceMeters * 1000) : null, observedSeconds: round(observedSeconds) },
      quality: { ...d.quality, missingSeconds: round(Math.max(0, durationSeconds - observedSeconds)), noGps: d.segments.length === 0 },
      segments: d.segments, paceSamples, splits,
    };
  });
}

export function displayRoute(run, overview = false) {
  const segments = run.segments.map(s => simplify(s, { meters: overview ? POLICY.overviewErrorMeters : POLICY.detailErrorMeters, speedErrorKmh: overview ? 1 : .5 }));
  return { schema: 1, kind: 'route', id: run.id, date: run.date, encoding: 'delta-e6-speed10', segments: segments.map((s, chain) => ({ chain, part: 0, data: packSegment(s) })),
    quality: { ...run.quality, maxSimplificationMeters: round(Math.max(0, ...segments.map(s => s.maxErrorMeters))), maxSpeedDeviationKmh: round(Math.max(0, ...segments.map(s => s.maxSpeedErrorKmh))), coordinateRoundingMeters: .08, speedRoundingKmh: .05 } };
}

export function listEntry(run, references, freshMeters) {
  return { id: run.id, date: run.date, start: new Date(run.start).toISOString(), summary: run.summary, quality: run.quality,
    freshMeters: freshMeters === null ? null : round(freshMeters), thumbnail: thumbnail(run.segments), ...references };
}
