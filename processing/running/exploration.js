import { explorationPaths, projectExploration } from '../../lib/exploration.js';
import { enclosedExploration } from '../../lib/exploration-regions.js';

export const MASK_ZOOM = 16;
export const MASK_SIZE = 64;
export const MASK_BLOCK_TILES = 16;
const CELLS_PER_WORLD = 2 ** MASK_ZOOM * MASK_SIZE;

/** Precompute a theme-neutral union mask, not the complete route history.
 * Repeated visits add no mask size. Enclosures are solved across all days,
 * before tiling, so a lake crossing a tile boundary is still revealed. */
export function explorationTiles(runs, { maxTiles = 20000, maxCellVisits = 50000000 } = {}) {
  const paths = explorationPaths(runs), projected = projectExploration(paths, MASK_ZOOM), tiles = new Map();
  let visits = 0;
  const set = (x, y, alpha) => {
    if (++visits > maxCellVisits) throw Error('EXPLORATION_WORK_LIMIT');
    if (y < 0 || y >= CELLS_PER_WORLD || alpha <= 0) return;
    x = ((x % CELLS_PER_WORLD) + CELLS_PER_WORLD) % CELLS_PER_WORLD;
    const tx = Math.floor(x / MASK_SIZE), ty = Math.floor(y / MASK_SIZE), key = `${tx}/${ty}`;
    let tile = tiles.get(key);
    if (!tile) {
      if (tiles.size >= maxTiles) throw Error('EXPLORATION_TILE_LIMIT');
      tile = { x: tx, y: ty, cells: new Uint8Array(MASK_SIZE * MASK_SIZE) }; tiles.set(key, tile);
    }
    const index = (y % MASK_SIZE) * MASK_SIZE + x % MASK_SIZE;
    tile.cells[index] = Math.max(tile.cells[index], alpha);
  };
  for (const path of projected) for (let i = 0; i < Math.max(1, path.points.length - 1); i++) {
    const p = path.points[i], q = path.points[i + 1] || p;
    const a = { x: p.x / 4, y: p.y / 4 }, b = { x: q.x / 4, y: q.y / 4 };
    const groundMeters = 40075016.686 / CELLS_PER_WORLD / Math.cosh(Math.PI * (1 - (a.y + b.y) / CELLS_PER_WORLD));
    const radius = 60 / groundMeters, dx = b.x - a.x, dy = b.y - a.y;
    const x0 = Math.floor(Math.min(a.x, b.x) - radius), x1 = Math.ceil(Math.max(a.x, b.x) + radius);
    const y0 = Math.floor(Math.min(a.y, b.y) - radius), y1 = Math.ceil(Math.max(a.y, b.y) + radius);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > maxCellVisits - visits) throw Error('EXPLORATION_WORK_LIMIT');
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const t = dx || dy ? Math.max(0, Math.min(1, ((x + .5 - a.x) * dx + (y + .5 - a.y) * dy) / (dx * dx + dy * dy))) : 0;
      const meters = Math.hypot(x + .5 - a.x - t * dx, y + .5 - a.y - t * dy) * groundMeters;
      const f = Math.max(0, Math.min(1, (60 - meters) / 21.6));
      set(x, y, Math.round(255 * (.5 - .5 * Math.cos(Math.PI * f))));
    }
  }
  const regions = enclosedExploration(paths), scale = 2 ** MASK_ZOOM / 4;
  for (const region of regions) {
    const points = region.points.map(p => ({ x: p.x * scale, y: p.y * scale }));
    const low = Math.floor(region.minY * scale), high = Math.ceil(region.maxY * scale);
    if (high - low > maxCellVisits - visits) throw Error('EXPLORATION_WORK_LIMIT');
    for (let y = low; y <= high; y++) {
      const intersections = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        if ((a.y > y + .5) !== (b.y > y + .5)) intersections.push(a.x + (y + .5 - a.y) / (b.y - a.y) * (b.x - a.x));
      }
      intersections.sort((a, b) => a - b);
      for (let i = 0; i + 1 < intersections.length; i += 2) {
        const start = Math.ceil(intersections[i] - .5), end = Math.floor(intersections[i + 1] - .5);
        if (end - start + 1 > maxCellVisits - visits) throw Error('EXPLORATION_WORK_LIMIT');
        for (let x = start; x <= end; x++) set(x, y, 255);
      }
    }
  }
  const result = [...tiles.values()].sort((a, b) => a.x - b.x || a.y - b.y).map(tile => {
    const rle = []; let previous = tile.cells[0], count = 0;
    for (const value of tile.cells) {
      if (value === previous) count++;
      else { rle.push(count, previous); previous = value; count = 1; }
    }
    rle.push(count, previous);
    return { x: tile.x, y: tile.y, rle };
  });
  return { tiles: result, regionCount: regions.length, cellVisits: visits };
}
