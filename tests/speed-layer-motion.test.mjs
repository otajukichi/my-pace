import test from 'node:test';
import assert from 'node:assert/strict';
import { mountSpeedLayer } from '../lib/speed-layer.js';

// Deterministic clock and minimal public Leaflet/canvas APIs. These tests cover
// lifecycle ordering without an external map or any personal running data.
function fixture() {
  let now = 0, nextId = 0;
  const tasks = new Map(), events = [], canvases = [];
  const timer = (callback, delay) => { const id = ++nextId; tasks.set(id, { callback, time: now + delay }); return id; };
  const clear = id => tasks.delete(id);
  function tick(milliseconds) {
    const end = now + milliseconds;
    for (;;) {
      const next = [...tasks.entries()].sort((a, b) => a[1].time - b[1].time)[0];
      if (!next || next[1].time > end) break;
      const [id, task] = next; tasks.delete(id); now = task.time; task.callback(now);
    }
    now = end;
  }
  function target() {
    const listeners = new Map();
    return {
      addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
      removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); },
      listenerCount() { return [...listeners.values()].reduce((total, set) => total + set.size, 0); },
    };
  }
  const media = { ...target(), matches: false };
  const context = () => ({
    setTransform() {}, clearRect() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    save() {}, restore() {}, arc() {}, fill() {}, createLinearGradient() { return { addColorStop() {} }; },
  });
  const style = () => ({ removeProperty(key) { delete this[key]; } });
  const document = {
    ...target(), visibilityState: 'visible',
    createElement() {
      const ctx = context();
      const canvas = { ...target(), style: style(), dataset: {}, width: 1, height: 1, hidden: false,
        setAttribute() {}, getContext: () => ctx,
        dispatchEvent(event) { events.push({ ...event.detail, type: event.type, time: now }); },
      };
      canvases.push(canvas); return canvas;
    },
  };
  const view = document.defaultView = {
    performance: { now: () => now }, devicePixelRatio: 1,
    requestAnimationFrame: callback => timer(callback, 16), cancelAnimationFrame: clear,
    setTimeout: timer, clearTimeout: clear, matchMedia: () => media,
    getComputedStyle: () => ({ getPropertyValue: () => '#cc7755' }),
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
  };
  const point = (x, y) => ({ x, y, subtract: other => point(x - other.x, y - other.y) });
  const pane = { style: style(), append() {}, remove() {} }, container = { ownerDocument: document };
  const handlers = new Map();
  const map = {
    center: { lat: 0, lng: 0 }, size: { x: 800, y: 600 },
    getContainer: () => container, createPane: () => pane, getSize() { return this.size; },
    getCenter() { return this.center; }, getZoom: () => 10,
    containerPointToLayerPoint: p => p, containerPointToLatLng: p => p,
    latLngToLayerPoint: ([lat, lng]) => point(lng * 100, lat * 100),
    on(types, handler) { for (const type of types.split(' ')) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(handler); } },
    off(types, handler) { for (const type of types.split(' ')) handlers.get(type)?.delete(handler); },
    fire(type) { for (const handler of handlers.get(type) || []) handler({ type }); },
  };
  const L = { point, DomUtil: { setTransform() {} } };
  const state = {}, layer = mountSpeedLayer(map, L, { motionState: state });
  const run = { segments: [{ points: [[0, 0], [0, 1], [1, 1]], speedsKmh: [8, 10] }] };
  const ready = key => layer.setRuns([run], { motionKey: key, animate: true });
  const motions = () => events.filter(event => event.type === 'running-motion');
  return { map, document, media, view, canvases, state, layer, run, ready, tick, motions, tasks };
}

test('initial fits settle before consuming the entrance, and delayed no-op redraws let it finish', () => {
  const f = fixture(); f.ready('a'); f.tick(16);
  assert.equal(f.state.key, undefined);
  f.tick(50); f.map.center = { lat: 1, lng: 1 }; f.map.fire('movestart'); f.map.fire('moveend'); f.tick(16);
  f.tick(100); assert.deepEqual(f.motions(), []);
  f.tick(20); assert.equal(f.state.key, 'a');
  assert.equal(f.motions()[0].phase, 'start'); assert.equal(f.motions()[0].duration, 1450);
  f.map.fire('moveend'); f.tick(16); // already painted this same geometry
  assert.equal(f.motions().length, 1);
  f.tick(1500);
  assert.deepEqual(f.motions().map(event => event.phase), ['start', 'finish']);
  assert.equal(f.canvases[0].dataset.motion, undefined);
  f.layer.destroy();
});

test('input cancels a pending entrance and the same selection never starts later', () => {
  const f = fixture(); f.ready('a'); f.tick(16);
  assert.equal(f.canvases[0].style.opacity, '.15');
  f.document.dispatchEvent({ type: 'pointerdown' }); f.tick(2000);
  assert.equal(f.canvases[0].style.opacity, undefined);
  assert.equal(f.state.key, 'a'); assert.deepEqual(f.motions(), []);
  f.map.fire('moveend'); f.ready('a'); f.tick(2000); assert.deepEqual(f.motions(), []);
  f.ready('b'); f.tick(150);
  assert.equal(f.motions()[0].duration, 850);
  f.document.dispatchEvent({ type: 'wheel' }); f.tick(1000);
  assert.deepEqual(f.motions().map(event => event.phase), ['start', 'cancel']);
  f.layer.destroy();
});

test('reduced motion and hidden-page events cancel pending work without later replay', () => {
  for (const reason of ['reduce', 'hide']) {
    const f = fixture(); f.ready('a'); f.tick(16);
    if (reason === 'reduce') { f.media.matches = true; f.media.dispatchEvent({ type: 'change' }); }
    else { f.document.visibilityState = 'hidden'; f.document.dispatchEvent({ type: 'visibilitychange' }); }
    f.tick(2000); assert.deepEqual(f.motions(), []);
    f.media.matches = false; f.document.visibilityState = 'visible'; f.ready('a'); f.tick(2000);
    assert.deepEqual(f.motions(), []); f.layer.destroy();
  }
});

test('destroy releases pending timers and listeners; it never starts after unmount', () => {
  const f = fixture(); f.ready('a'); f.tick(16); f.layer.destroy();
  f.tick(2000); assert.deepEqual(f.motions(), []);
  assert.equal(f.document.listenerCount(), 0); assert.equal(f.media.listenerCount(), 0); assert.equal(f.tasks.size, 0);
  assert.equal(f.canvases[0].width, 1);
});
