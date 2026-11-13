import { paintPreparedMask } from './prepared-mask.js';
import { explorationPaths, projectExploration, REVEAL_METERS } from './exploration.js';
import { enclosedExploration } from './exploration-regions.js';

/** A local canvas tile. Erasing strokes share one path so overlapping runs do
 * not change the reveal radius. The same world coordinates give seamless edges. */
export function paintExplorationTile(ctx, projected, { x, y, z, ratio = 1, color = '#506B83', opacity = .28, regions = [], revealColor = '#D4E0E8', revealOpacity = 0 }) {
  const size = 256, world = size * 2 ** z;
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + .5) / 2 ** z)));
  const metersPerPixel = 40075016.686 * Math.cos(latitude) / world;
  const radius = Math.min(800, REVEAL_METERS / metersPerPixel);
  const offsetX = x * size, offsetY = y * size;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = opacity; ctx.fillStyle = color; ctx.fillRect(0, 0, size, size);
  // Enclosed land is revealed as one union, including loops assembled over
  // several runs. Rings are cached at zoom 0, independent of today's view.
  ctx.globalCompositeOperation = 'destination-out'; ctx.globalAlpha = 1;
  ctx.fillStyle = '#000'; ctx.beginPath();
  const scale = 2 ** z;
  for (const region of regions) {
    const shift = Math.round((offsetX + size / 2 - (region.minX + region.maxX) / 2 * scale) / world) * world;
    if (region.maxX * scale + shift < offsetX || region.minX * scale + shift > offsetX + size || region.maxY * scale < offsetY || region.minY * scale > offsetY + size) continue;
    region.points.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](p.x * scale + shift - offsetX, p.y * scale - offsetY));
    ctx.closePath();
  }
  ctx.fill();
  ctx.beginPath();
  let visible = 0;
  for (const path of projected) {
    const shift = Math.round((offsetX + size / 2 - (path.minX + path.maxX) / 2) / world) * world;
    if (path.maxX + shift < offsetX - radius || path.minX + shift > offsetX + size + radius || path.maxY < offsetY - radius || path.minY > offsetY + size + radius) continue;
    const first = path.points[0];
    ctx.moveTo(first.x + shift - offsetX, first.y - offsetY);
    if (path.points.length === 1) ctx.lineTo(first.x + shift - offsetX + .001, first.y - offsetY);
    else for (const p of path.points.slice(1)) ctx.lineTo(p.x + shift - offsetX, p.y - offsetY);
    visible++;
  }
  ctx.globalCompositeOperation = 'destination-out';
  ctx.strokeStyle = '#000'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  let erased = 0;
  for (let step = 1; step <= 24; step++) {
    const progress = step / 24, target = .5 - .5 * Math.cos(Math.PI * progress);
    ctx.lineWidth = Math.max(.1, radius * 2 * (1 - .36 * progress));
    ctx.globalAlpha = Math.min(1, (target - erased) / (1 - erased)); ctx.stroke(); erased = target;
  }
  // The production mask is opaque outside visited paths. Fill only its erased
  // area with a quiet night light, below the speed layer. The pane applies the
  // final opacity once, including the existing soft boundary of the reveal.
  if (revealOpacity > 0) {
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = revealColor; ctx.globalAlpha = Math.min(1, revealOpacity);
    ctx.fillRect(0, 0, size, size);
  }
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  return visible;
}

/** Leaflet owns pan/zoom/reuse of these tiles. No locations leave this module. */
export function mountExplorationLayer(map, L) {
  const doc = map.getContainer().ownerDocument, view = doc.defaultView;
  const pane = map.createPane('explorationFogPane');
  pane.style.zIndex = '350'; pane.style.pointerEvents = 'none';
  pane.setAttribute('aria-hidden', 'true');
  let history = null, paths = [], regions = [], color, opacity, revealColor, revealOpacity = 0, enabled = false;
  const projections = new Map();
  let maskTiles = null, onError = null, version = 0, destroyed = false;
  function paintTile(tile, coords) {
    if (maskTiles) {
      const current = version, request = (tile._paintVersion || 0) + 1; tile._paintVersion = request;
      const options = { ...coords, ratio: tile.width / 256, color, revealColor, revealOpacity };
      const ctx = tile.getContext('2d'), makeCanvas = () => doc.createElement('canvas');
      paintPreparedMask(ctx, [], options, makeCanvas);
      maskTiles(coords).then(tiles => {
        if (!destroyed && version === current && request === tile._paintVersion) paintPreparedMask(ctx, tiles, options, makeCanvas);
      }).catch(() => { if (!destroyed && version === current) onError?.(); });
      return;
    }
    let projected = projections.get(coords.z);
    if (!projected) {
      projected = projectExploration(paths, coords.z);
      if (projections.size > 3) projections.delete(projections.keys().next().value);
      projections.set(coords.z, projected);
    }
    paintExplorationTile(tile.getContext('2d'), projected, { ...coords, ratio: tile.width / 256, color, opacity: 1, regions, revealColor, revealOpacity });
  }
  const Fog = L.GridLayer.extend({
    createTile(coords) {
      const tile = doc.createElement('canvas'), ratio = Math.min(2, view.devicePixelRatio || 1);
      tile.width = tile.height = 256 * ratio;
      tile.className = 'exploration-fog-tile';
      tile.dataset.coords = `${coords.x},${coords.y},${coords.z}`;
      // Apply translucency to the whole pane once, so retained zoom levels
      // cannot double-darken the unvisited map while Leaflet swaps tiles.
      paintTile(tile, coords);
      return tile;
    },
  });
  const layer = new Fog({ pane: 'explorationFogPane', tileSize: 256, keepBuffer: 2, updateWhenZooming: false, updateWhenIdle: false, className: 'exploration-fog-grid' });
  return {
    update(next) {
      let changed = false;
      if (maskTiles !== next.maskTiles) { maskTiles = next.maskTiles; version++; changed = true; }
      onError = next.onError;
      if (history !== next.runs) { history = next.runs; paths = maskTiles ? [] : explorationPaths(history); regions = maskTiles ? [] : enclosedExploration(paths); projections.clear(); changed = true; }
      if (color !== next.color || opacity !== next.opacity) { color = next.color; opacity = next.opacity; changed = true; }
      if (revealColor !== next.revealColor || revealOpacity !== next.revealOpacity) { revealColor = next.revealColor; revealOpacity = next.revealOpacity || 0; changed = true; }
      pane.style.opacity = String(opacity);
      const wasEnabled = enabled; enabled = !!next.enabled;
      pane.dataset.runCount = String(history?.length || 0);
      pane.dataset.regionCount = String(regions.length);
      if (enabled && !wasEnabled) layer.addTo(map);
      else if (!enabled && wasEnabled) layer.remove();
      else if (enabled && changed) {
        // Keep Leaflet's existing integer tile coordinates. GridLayer.redraw()
        // adopts a fractional map zoom without refreshing its wrap range in
        // Leaflet 1.9.4, which can shift a custom tile across the world.
        for (const tile of layer.getContainer().querySelectorAll('.exploration-fog-tile')) {
          const [x, y, z] = tile.dataset.coords.split(',').map(Number);
          paintTile(tile, { x, y, z });
        }
      }
    },
    destroy() { destroyed = true; version++; layer.remove(); pane.remove(); projections.clear(); history = null; paths = []; regions = []; },
  };
}
