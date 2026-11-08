import { projectExploration } from '../../lib/exploration.js';
import { innerContours } from '../../lib/exploration-regions.js';
import { decodeMask } from '../../lib/running-artifacts.js';
import { MASK_ZOOM, MASK_SIZE } from './exploration.js';
import { hash } from './cache.mjs';

const WORLD = 2 ** MASK_ZOOM * MASK_SIZE;
const wrap = x => ((x % WORLD) + WORLD) % WORLD;
const key = (x, y) => y * WORLD + wrap(x);

function encode(cells) {
  const rle = []; let count = 0, previous = cells[0];
  for (const value of cells) {
    if (value === previous) count++;
    else { rle.push(count, previous); previous = value; count = 1; }
  }
  rle.push(count, previous); return rle;
}
function tileWriter(maxTiles) {
  const tiles = new Map();
  return {
    set(x, y, alpha) {
      if (y < 0 || y >= WORLD || !alpha) return;
      x = wrap(x);
      const tx = Math.floor(x / MASK_SIZE), ty = Math.floor(y / MASK_SIZE), name = `${tx}/${ty}`;
      if (!tiles.has(name)) {
        if (tiles.size >= maxTiles) throw Error('EXPLORATION_TILE_LIMIT');
        tiles.set(name, { x: tx, y: ty, cells: new Uint8Array(MASK_SIZE ** 2) });
      }
      const cells = tiles.get(name).cells, i = (y % MASK_SIZE) * MASK_SIZE + x % MASK_SIZE;
      cells[i] = Math.max(cells[i], alpha);
    },
    finish() { return [...tiles.values()].sort((a, b) => a.x - b.x || a.y - b.y).map(t => ({ x: t.x, y: t.y, rle: encode(t.cells) })); },
  };
}

function corridor(paths, { maxTiles, maxCellVisits }) {
  const writer = tileWriter(maxTiles), occupied = new Set(); let visits = 0;
  for (const path of projectExploration(paths, MASK_ZOOM)) for (let i = 0; i < Math.max(1, path.points.length - 1); i++) {
    const p = path.points[i], q = path.points[i + 1] || p;
    const a = { x: p.x / 4, y: p.y / 4 }, b = { x: q.x / 4, y: q.y / 4 };
    const meters = 40075016.686 / WORLD / Math.cosh(Math.PI * (1 - (a.y + b.y) / WORLD));
    const radius = 60 / meters, dx = b.x - a.x, dy = b.y - a.y;
    const lowX = Math.floor(Math.min(a.x, b.x) - radius), highX = Math.ceil(Math.max(a.x, b.x) + radius);
    const lowY = Math.floor(Math.min(a.y, b.y) - radius), highY = Math.ceil(Math.max(a.y, b.y) + radius);
    visits += (highX - lowX + 1) * (highY - lowY + 1);
    if (visits > maxCellVisits) throw Error('EXPLORATION_WORK_LIMIT');
    for (let y = lowY; y <= highY; y++) for (let x = lowX; x <= highX; x++) {
      const t = dx || dy ? Math.max(0, Math.min(1, ((x + .5 - a.x) * dx + (y + .5 - a.y) * dy) / (dx * dx + dy * dy))) : 0;
      const d = Math.hypot(x + .5 - a.x - t * dx, y + .5 - a.y - t * dy) * meters;
      const f = Math.max(0, Math.min(1, (60 - d) / 21.6));
      writer.set(x, y, Math.round(255 * (.5 - .5 * Math.cos(Math.PI * f))));
      if (d <= 20 && y >= 0 && y < WORLD) occupied.add(key(x, y));
    }
  }
  return { tiles: writer.finish(), occupied: [...occupied].sort((a, b) => a - b), cellVisits: visits };
}

/** Connected cells, not historical GPS edges, determine enclosed land.
 * Unwrap a component across the date line before tracing its boundaries. */
function* components(occupied) {
  const remaining = new Set(occupied);
  while (remaining.size) {
    const start = remaining.values().next().value, queue = [[start % WORLD, Math.floor(start / WORLD)]], ids = [];
    remaining.delete(start);
    const rows = new Map();
    for (let at = 0; at < queue.length; at++) {
      const [x, y] = queue[at]; ids.push(key(x, y));
      if (!rows.has(y)) rows.set(y, new Set()); rows.get(y).add(x);
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (ny < 0 || ny >= WORLD) continue;
        if (remaining.delete(key(nx, ny))) queue.push([nx, ny]);
      }
    }
    yield { ids: ids.sort((a, b) => a - b), rows };
  }
}

function fillContours(rows, limits) {
  const contours = innerContours(rows), writer = tileWriter(limits.maxTiles); let visits = 0;
  for (const points of contours) {
    let low = Infinity, high = -Infinity;
    for (const p of points) { low = Math.min(low, p.y); high = Math.max(high, p.y); }
    for (let y = low; y < high; y++) {
      const crossings = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        if ((a.y > y + .5) !== (b.y > y + .5)) crossings.push(a.x + (y + .5 - a.y) / (b.y - a.y) * (b.x - a.x));
      }
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const first = Math.ceil(crossings[i] - .5), last = Math.floor(crossings[i + 1] - .5);
        visits += last - first + 1;
        if (visits > limits.maxCellVisits) throw Error('EXPLORATION_WORK_LIMIT');
        for (let x = first; x <= last; x++) writer.set(x, y, 255);
      }
    }
  }
  return { tiles: writer.finish(), regionCount: contours.length, cellVisits: visits };
}

export async function incrementalMask(descriptions, cached, stats, options = {}) {
  const limits = { maxTiles: 20000, maxCellVisits: 50000000, maxOccupiedCells: 2000000, ...options };
  const occupied = new Set(), contributions = new Map(); let regionCount = 0;
  const addTiles = tiles => {
    for (const tile of tiles) {
      const name = `${tile.x}/${tile.y}`;
      if (!contributions.has(name)) {
        if (contributions.size >= limits.maxTiles) throw Error('EXPLORATION_TILE_LIMIT');
        contributions.set(name, new Map());
      }
      contributions.get(name).set(hash(tile.rle), tile);
    }
  };
  // One geometric footprint can serve any number of repeat recordings.
  for (const item of new Map(descriptions.map(d => [d.geometry, d])).values()) {
    const value = await cached('corridor', { version: 1, geometry: item.geometry }, () => {
      const next = corridor(item.paths, limits); stats.explorationCellVisits += next.cellVisits; return next;
    });
    addTiles(value.tiles);
    for (const cell of value.occupied) occupied.add(cell);
    if (occupied.size > limits.maxOccupiedCells) throw Error('EXPLORATION_AREA_LIMIT');
  }
  for (const component of components(occupied)) {
    const value = await cached('enclosure', { version: 1, cells: component.ids }, () => {
      const next = fillContours(component.rows, limits); stats.explorationCellVisits += next.cellVisits; return next;
    });
    regionCount += value.regionCount; addTiles(value.tiles);
  }
  const tiles = [];
  for (const [name, parts] of [...contributions].sort(([a], [b]) => a.localeCompare(b))) {
    const rle = await cached('maskTile', { version: 1, parts: [...parts.keys()].sort() }, () => {
      const cells = new Uint8Array(MASK_SIZE ** 2);
      for (const tile of parts.values()) {
        const values = decodeMask(tile.rle);
        for (let i = 0; i < cells.length; i++) cells[i] = Math.max(cells[i], values[i]);
      }
      return encode(cells);
    });
    const [x, y] = name.split('/').map(Number); tiles.push({ x, y, rle });
  }
  tiles.sort((a, b) => a.x - b.x || a.y - b.y);
  stats.explorationOccupiedCells = occupied.size;
  return { tiles, regionCount };
}
