import { explorationPaths, projectExploration, footprintIndex, measureExploration } from '../../lib/exploration.js';
import { hash } from './cache.mjs';

const WORLD = 256, METERS = 40075016.686;
const scale = y => METERS / WORLD / Math.cosh(Math.PI * (1 - 2 * y / WORLD));

export function describeRuns(runs) {
  return runs.map(run => {
    const paths = explorationPaths([run]), projected = projectExploration(paths, 0);
    return { run, paths, geometry: hash(paths), bounds: projected.map(p => {
      // Conservative 35 m margin, including latitude distortion and sample rounding.
      const margin = 35 / Math.min(scale(p.minY), scale(p.maxY));
      return { minX: p.minX - margin, maxX: p.maxX + margin, minY: p.minY - margin, maxY: p.maxY + margin };
    }) };
  });
}

function nearby(a, b) {
  return a.bounds.some(x => b.bounds.some(y => {
    const shift = Math.round(((x.minX + x.maxX) - (y.minX + y.maxX)) / (2 * WORLD)) * WORLD;
    return x.minX <= y.maxX + shift && x.maxX >= y.minX + shift && x.minY <= y.maxY && x.maxY >= y.minY;
  }));
}

/** A backfill/edit/removal changes only later, nearby dependency keys. Same-day
 * runs remain independent, and route distance keeps the existing 30 m policy. */
export async function incrementalFresh(descriptions, cached) {
  const result = new Map();
  for (const current of descriptions) {
    const earlier = descriptions.filter(other => other.run.date < current.run.date && other.paths.length);
    const dependencies = [...new Map(earlier.filter(other => nearby(current, other)).map(other => [other.geometry, other])).values()]
      .sort((a, b) => a.geometry.localeCompare(b.geometry));
    const value = await cached('fresh', { version: 1, geometry: current.geometry,
      dependencies: dependencies.map(d => d.geometry), first: !earlier.length }, () => {
      const index = footprintIndex();
      for (const dependency of dependencies) index.add(dependency.paths);
      return { ...measureExploration(current.run, index), first: !earlier.length };
    });
    result.set(current.run.id, value);
  }
  return result;
}
