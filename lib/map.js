import { mountSpeedLayer } from './speed-layer.js';
import { mountExplorationLayer } from './exploration-layer.js';
const BLUE = '#3158e7';
const TRACK = '#b64b32';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const validPoint = (point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180;

/** Accept run segments, route.coordinates, or an array of coordinate arrays. */
export function mapSegments(source) {
  if (!source) return [];
  if (!Array.isArray(source)) return mapSegments(source.coordinates ?? source.segments ?? source.points);
  if (!source.length) return [];
  if (source.some((item) => validPoint(item))) {
    const segments = [];
    let segment = [];
    for (const point of source) {
      if (validPoint(point)) segment.push([point[0], point[1]]);
      else if (segment.length) { segments.push(segment); segment = []; }
    }
    if (segment.length) segments.push(segment);
    return segments;
  }
  return source.flatMap((item) => mapSegments(item));
}

function placePoint(place) {
  const point = [place?.lat ?? place?.latitude, place?.lon ?? place?.lng ?? place?.longitude];
  if (validPoint(point)) return point;
  return validPoint(place?.coordinates) ? place.coordinates : null;
}

const paths = {
  park: '<path d="m12 3 5 7h-3l4 6H6l4-6H7l5-7Zm0 13v5"/>',
  cafe: '<path d="M4 8h12v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Zm12 1h2a3 3 0 0 1 0 6h-2M7 3v2m5-2v2"/>',
  culture: '<path d="M12 6c-3-3-7-3-9-2v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 2Zm0 0v14"/>',
  water: '<path d="M12 3s-6 7-6 11a6 6 0 0 0 12 0c0-4-6-11-6-11Z"/>',
  viewpoint: '<path d="m2 19 7-12 4 7 3-5 6 10H2Z"/><circle cx="17" cy="5" r="2"/>',
  toilet: '<circle cx="8" cy="5" r="2"/><circle cx="16" cy="5" r="2"/><path d="M6 10h4v6H6v-6Zm2 6v5m6-11h4l2 7h-8l2-7Zm2 7v4"/>',
  track: '<rect x="3" y="5" width="18" height="14" rx="7"/><rect x="6" y="8" width="12" height="8" rx="4"/>',
  pin: '<path d="M18 10c0 5-6 11-6 11S6 15 6 10a6 6 0 1 1 12 0Z"/><circle cx="12" cy="10" r="2"/>',
  fit: '<path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4"/><circle cx="12" cy="12" r="2.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.pin}</svg>`;

/** A map-only view. Updates keep the current camera; fit() is explicit. */
export function mountMap(container, options = {}) {
  if (!container?.append) throw new TypeError('地図の表示先がありません。');
  const document = container.ownerDocument;
  const view = document.defaultView;
  let state = { runs: [], places: [], selectedRunId: null, selectedPlaceId: null, route: null, atlasIndex: null, freshSegments: [], fitPadding: {}, ...options };
  let map = null, tiles = null, overlays = null, destroyed = false, hasView = false, resizeFrame = null, loadedTiles = 0;
  const root = document.createElement('section');
  root.className = 'mp-map';
  root.setAttribute('aria-label', 'ランニングの地図');
  root.innerHTML = `<div class="mp-map__canvas" aria-label="ルートと立ち寄り先の地図"></div><div class="mp-map__controls" role="group" aria-label="地図の操作"><div class="mp-map__zoom"><button type="button" data-map-action="in" aria-label="地図を拡大" title="拡大">${icon('plus')}</button><button type="button" data-map-action="out" aria-label="地図を縮小" title="縮小">${icon('minus')}</button></div><button type="button" class="mp-map__fit" data-map-action="fit" aria-label="ルート全体を表示" title="全体を表示">${icon('fit')}</button></div><div class="mp-map__notice" role="status" hidden><span></span><button type="button">再試行</button></div>`;
  container.append(root);
  const canvas = root.querySelector('.mp-map__canvas');
  const notice = root.querySelector('.mp-map__notice');
  const noticeText = notice.querySelector('span');
  const retry = notice.querySelector('button');
  const controls = [...root.querySelectorAll('[data-map-action]')];
  const disposers = [];
  let markerDisposers = [];
  let speedLayer = null, explorationLayer = null;
  let colors = { route: BLUE, fresh: TRACK, context: '#94a4c4', halo: '#fff' };
  const listen = (element, event, handler, list = disposers) => { element.addEventListener(event, handler); list.push(() => element.removeEventListener(event, handler)); };
  const setNotice = (message = '', canRetry = false) => { noticeText.textContent = message; notice.hidden = !message; retry.hidden = !canRetry; };
  const runs = () => (Array.isArray(state.runs) ? [...state.runs] : []).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const selected = () => {
    const sorted = runs();
    const index = Number.isFinite(state.atlasIndex) && sorted.length ? clamp(Math.floor(state.atlasIndex), 0, sorted.length - 1) : null;
    return { visible: index === null ? sorted : sorted.slice(0, index + 1), run: index === null ? sorted.find((run) => run.id === state.selectedRunId) : sorted[index] };
  };

  function fit(allRuns = false) {
    if (!map || destroyed) return;
    const { visible, run } = selected();
    const atlas = Number.isFinite(state.atlasIndex);
    let points = allRuns || atlas ? runs().flatMap((item) => mapSegments(item).flat()) : mapSegments(state.route).flat();
    if (!points.length && !atlas) points = mapSegments(state.route).flat();
    if (!points.length && run) points = mapSegments(run).flat();
    if (!points.length) points = visible.flatMap((item) => mapSegments(item).flat());
    if (!points.length) points = (state.places || []).map(placePoint).filter(Boolean);
    map.invalidateSize({ pan: false });
    const padding = { top: 36, right: 62, bottom: 74, left: 42 };
    for (const edge of Object.keys(padding)) if (Number.isFinite(state.fitPadding?.[edge])) padding[edge] = Math.max(0, state.fitPadding[edge]);
    const size = map.getSize();
    for (const [start, end, available] of [['left', 'right', size.x], ['top', 'bottom', size.y]]) {
      const total = padding[start] + padding[end], limit = Math.max(0, available - (state.speedRoutes ? 40 : 80));
      if (total > limit) { padding[start] *= limit / total; padding[end] *= limit / total; }
    }
    map.options.zoomSnap = state.speedRoutes ? 0.1 : 0.5;
    if (points.length) map.fitBounds(view.L.latLngBounds(points), { paddingTopLeft: [padding.left, padding.top], paddingBottomRight: [padding.right, padding.bottom], maxZoom: state.speedRoutes ? 18 : 17, animate: false });
    else if (!hasView) map.setView([35.681236, 139.767125], 14, { animate: false });
    hasView = true;
    controls.forEach((button) => { button.disabled = false; });
  }

  function line(source, color, weight, opacity = 1, underlay = false) {
    for (const points of mapSegments(source)) {
      if (points.length < 2) continue;
      if (underlay) view.L.polyline(points, { color: colors.halo, weight: weight + 4, opacity: 0.96, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(overlays);
      view.L.polyline(points, { color, weight, opacity, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(overlays);
    }
  }

  function render() {
    if (!map || destroyed) return;
    if (!hasView) fit(true);
    root.classList.toggle('has-exploration',!!state.explorationEnabled);
    const css = view.getComputedStyle(root);
    colors = { route: css.getPropertyValue('--map-route').trim() || BLUE, fresh: css.getPropertyValue('--track').trim() || TRACK, context: css.getPropertyValue('--map-context').trim() || '#94a4c4', halo: css.getPropertyValue('--map-halo').trim() || '#fff' };
    explorationLayer?.update({runs:state.exploredRuns||[],enabled:state.explorationEnabled,color:css.getPropertyValue('--map-fog').trim()||'#506B83',opacity:Number(css.getPropertyValue('--map-fog-opacity').trim())||.28,revealColor:css.getPropertyValue('--map-reveal').trim()||'#D4E0E8',revealOpacity:Number(css.getPropertyValue('--map-reveal-opacity').trim())||0});
    const focusedPlaceId = document.activeElement?.dataset?.mapPlaceId;
    const noticeBottom = Number.isFinite(state.fitPadding?.bottom) ? Math.max(28, state.fitPadding.bottom) : 28;
    root.style.setProperty('--mp-map-notice-bottom', `${Math.min(noticeBottom, Math.max(28, root.clientHeight - 100))}px`);
    markerDisposers.forEach((remove) => remove()); markerDisposers = [];
    overlays.clearLayers();
    const { visible, run } = selected();
    const selectedIds = new Set(state.selectedRunIds || []);
    speedLayer?.setRuns(state.speedRoutes?visible:[]);
    if(!state.speedRoutes){
    visible.forEach((item) => {
      if (item === run || selectedIds.has(item.id)) return;
      line(item, colors.context, state.overview ? 3 : 2.2, state.overview ? .85 : .4, !!state.overview);
    });
    visible.filter(item => selectedIds.has(item.id) && item !== run).forEach(item => line(item, colors.route, 4.2, 1, true));
    if (run) line(run, colors.route, 4.2, 1, true);
    }
    if (state.route) line(state.route, colors.route, 5, 1, true);
    line(state.freshSegments, colors.fresh, 4.3, 1, true);
    const activePoints = mapSegments(state.route || run).flat();
    if (activePoints.length) {
      view.L.circleMarker(activePoints[0], { radius: 5, color: colors.halo, weight: 2.5, fillColor: colors.route, fillOpacity: 1, interactive: false }).addTo(overlays);
      if (activePoints.length > 1) view.L.circleMarker(activePoints.at(-1), { radius: 4, color: colors.route, weight: 2, fillColor: colors.halo, fillOpacity: 1, interactive: false }).addTo(overlays);
    }
    if (validPoint(state.route?.turnPoint)) {
      const marker=view.L.circleMarker(state.route.turnPoint,{radius:6,color:colors.halo,weight:2,fillColor:colors.route,fillOpacity:1,interactive:false}).addTo(overlays);
      const label=document.createElement('span');label.textContent='ここで折り返し';
      marker.bindTooltip(label,{permanent:true,direction:'top',offset:[0,-9],className:'mp-map__place-label'});
    }
    (Array.isArray(state.places) ? state.places : []).forEach((place, index) => {
      const point = placePoint(place);
      if (!point) return;
      const isSelected = place.id === state.selectedPlaceId;
      const content = document.createElement('span');
      content.className = `mp-map__place-dot${isSelected ? ' is-selected' : ''}`;
      if (isSelected) content.textContent = String(index + 1);
      else content.innerHTML = icon(place.kind || place.category || 'pin');
      const name = String(place.name || '立ち寄り先');
      const marker = view.L.marker(point, {
        title: name, alt: name, keyboard: true, riseOnHover: true, zIndexOffset: isSelected ? 500 : 0,
        icon: view.L.divIcon({ html: content, className: 'mp-map__place', iconSize: [36, 36], iconAnchor: [18, 18] }),
      }).addTo(overlays);
      const choose = () => { if (!destroyed && typeof state.onPlaceSelect === 'function') state.onPlaceSelect(place.id); };
      marker.on('click', choose);
      const element = marker.getElement();
      element?.setAttribute('aria-label', `${name}を選択`);
      element?.setAttribute('aria-pressed', String(isSelected));
      if (element) element.dataset.mapPlaceId = String(place.id);
      if (element) listen(element, 'keydown', (event) => { if (event.key === ' ') { event.preventDefault(); choose(); } }, markerDisposers);
      if (focusedPlaceId !== undefined && focusedPlaceId === String(place.id)) element?.focus({ preventScroll: true });
      if (isSelected) {
        const label = document.createElement('span'); label.textContent = name;
        marker.bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -15], opacity: 1, className: 'mp-map__place-label' });
      }
    });
    canvas.classList.toggle('is-picking', typeof state.onMapSelect === 'function');
  }

  function initialize() {
    if (destroyed || map) return;
    const L = view.L;
    if (!L?.map || !L?.tileLayer) { setNotice('地図を読み込めませんでした', true); return; }
    try {
      map = L.map(canvas, { zoomControl: false, attributionControl: true, scrollWheelZoom: true, maxZoom: 19, minZoom: 1, zoomSnap: 0.5, zoomDelta: 0.5, boxZoom: false });
      map.attributionControl.setPrefix(false);
      tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, minZoom: 1, keepBuffer: 0, updateWhenIdle: true, updateWhenZooming: false,
        referrerPolicy: 'strict-origin-when-cross-origin',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
      });
      tiles.on('loading', () => { loadedTiles = 0; });
      tiles.on('tileload', () => { if (!destroyed) { loadedTiles += 1; setNotice(); } });
      tiles.on('tileerror', () => { if (!destroyed && !loadedTiles) setNotice('背景地図を取得できませんでした。経路はそのまま表示しています。', true); });
      tiles.addTo(map);
      speedLayer = mountSpeedLayer(map,L);
      explorationLayer = mountExplorationLayer(map,L);
      overlays = L.layerGroup().addTo(map);
      map.on('click', (event) => { if (!destroyed && typeof state.onMapSelect === 'function') state.onMapSelect({ lat: event.latlng.lat, lon: event.latlng.lng }); });
      render();
    } catch {
      speedLayer?.destroy();speedLayer=null;explorationLayer?.destroy();explorationLayer=null;
      map?.remove(); map = null; tiles = null; overlays = null; hasView = false;
      setNotice('地図を読み込めませんでした', true);
    }
  }

  controls.forEach((button) => {
    button.disabled = true;
    listen(button, 'click', () => {
      if (!map || !hasView) return;
      if (button.dataset.mapAction === 'fit') fit();
      else if (button.dataset.mapAction === 'in') map.zoomIn();
      else map.zoomOut();
    });
  });
  listen(retry, 'click', () => { setNotice('地図を読み込み中…'); loadedTiles = 0; if (tiles) tiles.redraw(); else initialize(); });
  const observer = view.ResizeObserver ? new view.ResizeObserver(() => {
    if (destroyed || !map) return;
    if (resizeFrame !== null) view.cancelAnimationFrame(resizeFrame);
    resizeFrame = view.requestAnimationFrame(() => {
      resizeFrame = null;
      if (destroyed || !map) return;
      const previous = map.getSize();
      map.invalidateSize({ pan: false, debounceMoveend: true });
      const current = map.getSize();
      // Switching calendar density changes the map's height on a phone.
      if (state.speedRoutes && (Math.abs(previous.x-current.x)>2 || Math.abs(previous.y-current.y)>2)) fit();
    });
  }) : null;
  observer?.observe(root);
  initialize();
  return {
    update(patch = {}) {
      if (destroyed) return;
      const previous = state;
      state = { ...state, ...patch };
      if (!map) initialize();
      else {
        render();
        const routeChanged = state.route && state.route !== previous.route;
        const selectionChanged = state.selectedRunId && (state.selectedRunId !== previous.selectedRunId || previous.atlasIndex !== state.atlasIndex);
        const runKeys = (items) => (Array.isArray(items) ? items : []).map((run) => String(run.id || run.date || '')).join('|');
        const runsChanged = runKeys(state.runs) !== runKeys(previous.runs);
        const placesArrived = !previous.places?.length && state.places?.length && !state.runs?.length && !state.route;
        const inAtlas = Number.isFinite(state.atlasIndex);
        const enteringAtlas = inAtlas && !Number.isFinite(previous.atlasIndex);
        const viewportChanged = state.viewportKey !== previous.viewportKey;
        if ((inAtlas && (enteringAtlas || runsChanged)) || (!inAtlas && (routeChanged || selectionChanged || runsChanged || placesArrived || viewportChanged))) fit();
      }
    },
    fit,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (resizeFrame !== null) view.cancelAnimationFrame(resizeFrame);
      observer?.disconnect();
      disposers.forEach((remove) => remove()); markerDisposers.forEach((remove) => remove());
      speedLayer?.destroy();speedLayer=null;explorationLayer?.destroy();explorationLayer=null;
      tiles?.off(); map?.off(); map?.remove();
      map = null; tiles = null; overlays = null; root.remove();
    },
  };
}
