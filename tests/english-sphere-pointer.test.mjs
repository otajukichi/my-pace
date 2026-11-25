import test from 'node:test';
import assert from 'node:assert/strict';
import { mountEnglishSphere } from '../lib/english-sphere.js';
import { ENGLISH_AREAS } from '../lib/english-model.js';

function element() {
  const classes = new Set(), listeners = new Map();
  return {
    dataset: {}, style: { setProperty() {} },
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    },
    setAttribute() {},
    addEventListener(type, callback, options = {}) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ callback, signal: options.signal });
    },
    emit(type, event) {
      for (const { callback, signal } of listeners.get(type) || []) {
        if (!signal?.aborted) callback(event);
      }
    },
  };
}

/** Only the DOM/canvas surface is mocked: pointer handlers and rotation are real. */
function fixture(t) {
  const host = element(), canvas = { getContext: () => null }, hit = element();
  const nodes = ENGLISH_AREAS.map((_, index) => ({ ...element(), dataset: { sphereArea: String(index) } }));
  for (const node of nodes) node.closest = selector => ['.en-world', '[data-sphere-area]'].includes(selector) ? node : null;
  hit.closest = selector => selector === '.en-sphere-hit' ? hit : null;
  const child = { closest: selector => nodes[0].closest(selector) }; // e.g. an SVG path or area label.
  const captions = Object.fromEntries(['.en-sphere-kicker', '.en-sphere-caption strong', '.en-sphere-subtitle'].map(key => [key, {}]));
  host.querySelector = selector => ({ canvas, '.en-sphere-hit': hit, ...captions })[selector];
  host.querySelectorAll = () => nodes;
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 });
  const captured = new Set();
  host.setPointerCapture = id => captured.add(id);
  host.hasPointerCapture = id => captured.has(id);
  host.releasePointerCapture = id => captured.delete(id);

  const frames = new Map(); let nextFrame = 1;
  const globals = {
    matchMedia: () => ({ ...element(), matches: true }),
    innerWidth: 390, devicePixelRatio: 2,
    getComputedStyle: () => ({ getPropertyValue: () => '#234567' }),
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    document: { ...element(), hidden: false, documentElement: {} },
    performance: { now: () => 1000 },
  };
  const original = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const selected = [];
  const sphere = mountEnglishSphere(host, { areas: ENGLISH_AREAS, onSelect: index => selected.push(index) });
  t.after(() => {
    sphere.destroy();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  function send(type, overrides = {}) {
    const event = { target: child, pointerId: 1, pointerType: 'touch', button: 0, isPrimary: true,
      clientX: 200, clientY: 160, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, ...overrides };
    if (type === 'lostpointercapture' && event.target === host) captured.delete(event.pointerId);
    host.emit(type, event);
    return event;
  }
  return { host, hit, child, sphere, selected, send };
}

test('touch rotation continues after a child loses its implicit capture to the sphere host', t => {
  const f = fixture(t);
  for (const target of [f.child, f.hit]) {
    f.send('pointerdown', { target });
    f.send('pointermove', { target, clientX: 220 });
    const first = f.sphere.getOrientation();
    assert.equal(f.host.hasPointerCapture(1), true);
    // Native touch browsers emit this bubbling event when capture transfers.
    f.send('lostpointercapture', { target });
    assert.equal(f.host.classList.contains('is-dragging'), true);
    f.send('pointermove', { target: f.host, clientX: 250 });
    assert.notDeepEqual(f.sphere.getOrientation(), first);
    const second = f.sphere.getOrientation();
    f.send('pointermove', { target: f.host, clientX: 250, clientY: 200 });
    assert.notDeepEqual(f.sphere.getOrientation(), second, 'vertical movement also continues');
    f.send('pointerup', { target: f.host });
    const released = f.sphere.getOrientation();
    f.send('pointermove', { target: f.host, clientX: 280 });
    assert.deepEqual(f.sphere.getOrientation(), released);
  }
});

test('actual host capture loss and cancellation stop rotation and allow a new gesture', t => {
  const f = fixture(t);
  for (const type of ['lostpointercapture', 'pointercancel']) {
    f.send('pointerdown');
    f.send('pointermove', { clientX: 230 });
    f.send('lostpointercapture', { target: f.host, pointerId: 9 });
    const before = f.sphere.getOrientation();
    f.send('pointermove', { clientX: 250 });
    assert.notDeepEqual(f.sphere.getOrientation(), before, 'an unrelated pointer cannot stop this drag');
    f.send(type, { target: f.host });
    const stopped = f.sphere.getOrientation();
    f.send('pointermove', { clientX: 280 });
    assert.deepEqual(f.sphere.getOrientation(), stopped);
    assert.equal(f.host.classList.contains('is-dragging'), false);
  }
});

test('a swipe cannot select an area, but a fresh immediate tap can', t => {
  const f = fixture(t);
  f.send('pointerdown');
  f.send('pointermove', { clientX: 250 });
  f.send('pointerup', { target: f.host });
  assert.equal(f.send('click').defaultPrevented, true);
  assert.deepEqual(f.selected, []);

  // No elapsed time: this is a deliberate next gesture, not the swipe's click.
  f.send('pointerdown', { pointerId: 2 });
  f.send('pointerup', { pointerId: 2 });
  assert.equal(f.send('click', { pointerId: 2 }).defaultPrevented, false);
  assert.deepEqual(f.selected, [0]);
});

test('small finger jitter remains a tap and mouse dragging still rotates', t => {
  const f = fixture(t), initial = f.sphere.getOrientation();
  f.send('pointerdown');
  f.send('pointermove', { clientX: 203, clientY: 162 });
  f.send('pointerup');
  f.send('click');
  assert.deepEqual(f.sphere.getOrientation(), initial);
  assert.deepEqual(f.selected, [0]);

  f.send('pointerdown', { pointerType: 'mouse' });
  f.send('pointermove', { pointerType: 'mouse', clientX: 250 });
  assert.notDeepEqual(f.sphere.getOrientation(), initial);
  f.send('pointerup', { pointerType: 'mouse' });
  f.send('click', { pointerType: 'mouse' });
  assert.deepEqual(f.selected, [0]);
});
