import { projectExploration } from './exploration.js';

const WORLD = 256, CIRCUMFERENCE = 40075016.686;
const CELL_METERS = 8, JOIN_METERS = 20;
const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const key = (x, y) => `${x}:${y}`;
const overlaps = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
const metersPerUnit = y => CIRCUMFERENCE / WORLD / Math.cosh(Math.PI * (1 - 2 * y / WORLD));

// Separate distant outings before choosing a local, metre-sized grid. A loop
// made on several days joins the same group; no path is implicitly closed.
function nearbyGroups(paths) {
  const projected = projectExploration(paths, 0), groups = [];
  for (const path of projected) {
    const margin = JOIN_METERS / Math.min(metersPerUnit(path.minY), metersPerUnit(path.maxY));
    const group = { paths: [path.points], minX: path.minX - margin, maxX: path.maxX + margin, minY: path.minY - margin, maxY: path.maxY + margin };
    // A new bounding box can connect several earlier groups, transitively.
    for (let i = 0; i < groups.length;) {
      const other = groups[i];
      // Align each neighbouring group locally, even if an earlier, unrelated
      // outing was on the opposite side of the world.
      const shift = Math.round(((group.minX + group.maxX) - (other.minX + other.maxX)) / 2 / WORLD) * WORLD;
      const shifted = { ...other, minX: other.minX + shift, maxX: other.maxX + shift };
      if (!overlaps(group, shifted)) { i++; continue; }
      for (const points of other.paths) group.paths.push(shift ? points.map(p => ({ x: p.x + shift, y: p.y })) : points);
      group.minX = Math.min(group.minX, shifted.minX); group.maxX = Math.max(group.maxX, shifted.maxX);
      group.minY = Math.min(group.minY, other.minY); group.maxY = Math.max(group.maxY, other.maxY);
      groups.splice(i, 1); i = 0;
    }
    groups.push(group);
  }
  return groups;
}

function occupiedCells(group, cell) {
  const rows = new Map(), radius = JOIN_METERS / CELL_METERS;
  const origin = { x: Math.floor(group.minX / cell) * cell, y: Math.floor(group.minY / cell) * cell };
  for (const path of group.paths) {
    const points = path.map(p => ({ x: (p.x - origin.x) / cell, y: (p.y - origin.y) / cell }));
    for (let i = 0; i < Math.max(1, points.length - 1); i++) {
      const a = points[i], b = points[i + 1] || a, dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy;
      for (let y = Math.floor(Math.min(a.y, b.y) - radius); y <= Math.ceil(Math.max(a.y, b.y) + radius); y++) {
        for (let x = Math.floor(Math.min(a.x, b.x) - radius); x <= Math.ceil(Math.max(a.x, b.x) + radius); x++) {
          const t = lengthSquared ? Math.max(0, Math.min(1, ((x + .5 - a.x) * dx + (y + .5 - a.y) * dy) / lengthSquared)) : 0;
          if ((x + .5 - a.x - t * dx) ** 2 + (y + .5 - a.y - t * dy) ** 2 > radius ** 2) continue;
          if (!rows.has(y)) rows.set(y, new Set());
          rows.get(y).add(x);
        }
      }
    }
  }
  return { rows, origin };
}

// Trace only cell boundaries: cost follows the recorded corridors, not the
// area of a mountain/lake inside them. Occupied cells stay on the right.
function innerContours(rows) {
  const edges = new Map(), holes = [];
  const add = (x, y, direction) => { const k = key(x, y); edges.set(k, (edges.get(k) || 0) | (1 << direction)); };
  for (const [y, row] of rows) for (const x of row) {
    if (!rows.get(y - 1)?.has(x)) add(x, y, 0);
    if (!row.has(x + 1)) add(x + 1, y, 1);
    if (!rows.get(y + 1)?.has(x)) add(x + 1, y + 1, 2);
    if (!row.has(x - 1)) add(x, y + 1, 3);
  }
  while (edges.size) {
    const [start, mask] = edges.entries().next().value;
    let [x, y] = start.split(':').map(Number), direction = [0, 1, 2, 3].find(d => mask & (1 << d));
    let area = 0, closed = false;
    const points = [{ x, y }];
    while (true) {
      const k = key(x, y), remaining = edges.get(k) & ~(1 << direction);
      if (remaining) edges.set(k, remaining); else edges.delete(k);
      const [dx, dy] = directions[direction], nx = x + dx, ny = y + dy;
      area += x * ny - nx * y; x = nx; y = ny;
      if (key(x, y) === start) { closed = true; break; }
      const available = edges.get(key(x, y)) || 0;
      // At diagonal contact, turn around the occupied cell. An open diagonal
      // channel must not accidentally become an enclosed region.
      const next = [1, 0, 3, 2].map(turn => (direction + turn) % 4).find(d => available & (1 << d));
      if (next === undefined) break;
      if (next !== direction) points.push({ x, y });
      direction = next;
    }
    // Negative winding bounds an unoccupied interior. Outer boundaries of
    // an open route or an out-and-back are deliberately discarded.
    if (closed && area < 0 && points.length >= 3) holes.push(points);
  }
  return holes;
}

/** Zoom-independent interior rings in Leaflet's zoom-0 world coordinates.
 * The 20m join tolerance sits inside the existing fully revealed corridor,
 * absorbing GPS drift without joining broad gaps or drawing shortcut edges. */
export function enclosedExploration(paths) {
  const regions = [];
  for (const group of nearbyGroups(paths)) {
    const cell = CELL_METERS / metersPerUnit((group.minY + group.maxY) / 2);
    const { rows, origin } = occupiedCells(group, cell);
    for (const contour of innerContours(rows)) {
      const points = contour.map(p => ({ x: origin.x + p.x * cell, y: origin.y + p.y * cell }));
      const region = { points, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      for (const p of points) {
        region.minX = Math.min(region.minX, p.x); region.maxX = Math.max(region.maxX, p.x);
        region.minY = Math.min(region.minY, p.y); region.maxY = Math.max(region.maxY, p.y);
      }
      regions.push(region);
    }
  }
  return regions;
}
