import test from 'node:test';
import assert from 'node:assert/strict';
import { orbitPath, createHomeMotion } from '../lib/home-motion.js';

const camel = key => key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
function style() {
  return {
    getPropertyValue(key) { return this[camel(key)] || ''; },
    getPropertyPriority() { return ''; },
    setProperty(key, value) { this[camel(key)] = value; },
    removeProperty(key) { delete this[camel(key)]; },
  };
}
function path(dataset = {}) {
  return { dataset, style: style(), attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } };
}
function orbit() {
  const track = path(), arcs = [path({ length: '28', start: '0' }), path({ length: '14', start: '33.333' })];
  return { track, arcs, isConnected: true, style: style(), querySelectorAll(selector) {
    return selector === '[data-orbit-arc]' ? arcs : [track, ...arcs];
  } };
}
function fixture(reduce = false) {
  const frames = new Map(), listeners = new Map(), reducedListeners = new Map();
  let now = 0, next = 1;
  const reduced = { matches: reduce, addEventListener(name, callback) { reducedListeners.set(name, callback); }, removeEventListener(name) { reducedListeners.delete(name); } };
  const view = {
    performance: { now: () => now }, matchMedia: () => reduced,
    requestAnimationFrame(callback) { const id = next++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const document = { defaultView: view, hidden: false,
    addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); } };
  const calendar = [orbit(), orbit()], selected = orbit();
  const cells = calendar.map((svg, index) => ({ dataset: { homeDay: `2026-11-${20 + index}` }, querySelectorAll: () => [svg] }));
  const panel = { querySelectorAll: () => [selected] };
  const root = { ownerDocument: document, isConnected: true,
    querySelectorAll(selector) {
      return ({ '.home-calendar-grid .home-orbit': calendar, '.home-reveal': [], '[data-home-day]': cells })[selector] || [];
    },
    querySelector(selector) { return selector === '.home-day-detail' ? panel : null; },
  };
  return { root, calendar, selected, cells, panel, view, frames, document, reduced, listeners, reducedListeners,
    step(milliseconds) { now += milliseconds; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(now)); },
    visibility(hidden) { document.hidden = hidden; listeners.get('visibilitychange')?.(); },
    reduce(value) { reduced.matches = value; reducedListeners.get('change')?.(); },
  };
}

function enableFlights(f) {
  const ghosts = new Set(), animations = [], events = new Map();
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  let target = rect(800, 200, 160, 160);
  f.view.innerWidth = 1200; f.view.innerHeight = 800;
  f.view.getComputedStyle = () => ({ getPropertyValue: key => key === 'stroke' ? 'rgb(200, 80, 50)' : '' });
  f.view.addEventListener = (name, callback) => events.set(name, callback);
  f.view.removeEventListener = name => events.delete(name);
  f.calendar[0].getBoundingClientRect = () => rect(100, 220, 48, 48);
  f.selected.getBoundingClientRect = () => target;
  f.cells[0].querySelector = () => f.calendar[0];
  f.panel.querySelector = () => f.selected;
  f.root.appendChild = ghost => ghosts.add(ghost);
  f.calendar[0].cloneNode = () => {
    const ghost = orbit();
    const select = ghost.querySelectorAll;
    ghost.querySelectorAll = selector => selector === '[id]' ? [] : select(selector);
    ghost.classList = { add() {} };
    ghost.setAttribute = () => {};
    ghost.removeAttribute = () => {};
    ghost.remove = () => ghosts.delete(ghost);
    ghost.animate = (frames, options) => {
      const animation = { frames, options, canceled: false, cancel() { this.canceled = true; } };
      animation.finished = new Promise(resolve => { animation.complete = resolve; });
      animations.push(animation);
      return animation;
    };
    return ghost;
  };
  return { ghosts, animations, events, offscreen() { target = rect(800, 900, 160, 160); } };
}

test('square and circle share a clockwise, closed eight-segment topology with bounded coordinates', () => {
  assert.notEqual(orbitPath(0), orbitPath(1));
  for (const t of [0, .25, .5, .75, 1]) {
    const value = orbitPath(t);
    assert.ok(value.startsWith('M50 10C'));
    assert.equal(value.match(/C/g).length, 8);
    assert.ok(value.endsWith('50 10Z'));
    const coordinates = value.match(/-?\d+(?:\.\d+)?/g).map(Number);
    assert.ok(coordinates.every(n => n >= 10 && n <= 90));
  }
  assert.equal(orbitPath(-5), orbitPath(0));
  assert.equal(orbitPath(8), orbitPath(1));
  assert.equal(orbitPath(NaN), orbitPath(1));
});

test('a whole calendar and selected-day entrance share one RAF and settle to real lengths', () => {
  const f = fixture(), motion = createHomeMotion(f.root);
  motion.enter();
  assert.equal(f.frames.size, 1);
  assert.equal(f.calendar[0].track.attributes.d, orbitPath(0));
  assert.equal(f.calendar[0].arcs[0].attributes['stroke-dasharray'], '0 100');
  f.step(1600);
  assert.equal(f.frames.size, 0);
  for (const svg of [...f.calendar, f.selected]) {
    assert.equal(svg.track.attributes.d, orbitPath(1));
    assert.equal(svg.arcs[0].attributes['stroke-dasharray'], '28 100');
    assert.equal(svg.arcs[1].attributes['stroke-dashoffset'], '-33.333');
    assert.equal(svg.style.transform, undefined);
    assert.equal(svg.style.opacity, undefined);
  }
  motion.destroy();
});

test('day selection leaves the calendar in flight, and a habit refresh replaces only its own cell', () => {
  const f = fixture(), motion = createHomeMotion(f.root);
  motion.enter(); f.step(450);
  const before = f.calendar[1].arcs[0].attributes['stroke-dasharray'];
  motion.detail();
  assert.equal(f.calendar[1].arcs[0].attributes['stroke-dasharray'], before);
  f.calendar[0].arcs[0].dataset.length = '7';
  motion.refreshDay('2026-11-20');
  assert.equal(f.calendar[0].arcs[0].attributes['stroke-dasharray'], '0 100');
  assert.equal(f.calendar[1].arcs[0].attributes['stroke-dasharray'], before);
  assert.equal(f.frames.size, 1);
  f.step(1600);
  assert.equal(f.calendar[0].arcs[0].attributes['stroke-dasharray'], '7 100');
  assert.equal(f.calendar[1].arcs[0].attributes['stroke-dasharray'], '28 100');
  assert.equal(f.frames.size, 0);
  motion.destroy();
});

test('reduced motion, hidden tabs, and destroy cancel work while leaving complete contours', () => {
  const f = fixture(true), motion = createHomeMotion(f.root);
  motion.enter();
  assert.equal(f.frames.size, 0);
  assert.equal(f.selected.track.attributes.d, orbitPath(1));
  f.reduce(false); motion.enter();
  assert.equal(f.frames.size, 1);
  f.visibility(true);
  assert.equal(f.frames.size, 0);
  assert.equal(f.calendar[0].arcs[0].attributes['stroke-dasharray'], '28 100');
  f.visibility(false); motion.calendar(-1); f.reduce(true);
  assert.equal(f.frames.size, 0);
  f.reduce(false); motion.enter(); motion.destroy();
  assert.equal(f.frames.size, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.reducedListeners.size, 0);
  motion.enter(); motion.detail(); motion.calendar(); motion.refreshDay('2026-11-20');
  assert.equal(f.frames.size, 0);
});

test('detached elements cannot keep a frame loop alive and malformed arc values stay finite', () => {
  const f = fixture(), motion = createHomeMotion(f.root);
  f.calendar[0].arcs[0].dataset.length = 'NaN';
  f.calendar[0].arcs[0].dataset.start = 'Infinity';
  motion.enter();
  [...f.calendar, f.selected].forEach(svg => { svg.isConnected = false; });
  f.step(10);
  assert.equal(f.frames.size, 0);
  assert.equal(f.calendar[0].arcs[0].attributes['stroke-dasharray'], '0 100');
  assert.equal(f.calendar[0].arcs[0].attributes['stroke-dashoffset'], '0');
  motion.destroy();
});

test('a selected-day ghost flies with preserved colors and cleans up after completion or replacement', async () => {
  const f = fixture(), flight = enableFlights(f), motion = createHomeMotion(f.root);
  motion.detail({ fromDate: '2026-11-20' });
  assert.equal(flight.ghosts.size, 1);
  assert.equal(flight.animations[0].options.duration, 620);
  assert.equal(flight.animations[0].frames.length, 9);
  const ghost = [...flight.ghosts][0];
  assert.equal(ghost.arcs[0].style.stroke, 'rgb(200, 80, 50)');
  assert.equal(ghost.style.pointerEvents, 'none');
  assert.equal(ghost.style.position, 'fixed');
  motion.detail({ fromDate: '2026-11-20' });
  assert.equal(flight.animations[0].canceled, true);
  assert.equal(flight.ghosts.size, 1);
  flight.animations[1].complete(); await Promise.resolve();
  assert.equal(flight.ghosts.size, 0);
  motion.detail({ fromDate: '2026-11-20' }); motion.detail();
  assert.equal(flight.ghosts.size, 0, 'ordinary detail/habit refresh never retains a flight');
  motion.destroy();
  assert.equal(flight.events.size, 0);
});

test('offscreen destinations do not fly; visibility, reduced motion, scrolling and destroy remove ghosts', () => {
  const f = fixture(), flight = enableFlights(f), motion = createHomeMotion(f.root);
  motion.detail({ fromDate: '2026-11-20' }); f.visibility(true);
  assert.equal(flight.ghosts.size, 0);
  f.visibility(false); motion.detail({ fromDate: '2026-11-20' }); f.reduce(true);
  assert.equal(flight.ghosts.size, 0);
  f.reduce(false); motion.detail({ fromDate: '2026-11-20' }); flight.events.get('scroll')();
  assert.equal(flight.ghosts.size, 0);
  motion.detail({ fromDate: '2026-11-20' }); flight.events.get('resize')();
  assert.equal(flight.ghosts.size, 0);
  flight.offscreen(); motion.detail({ fromDate: '2026-11-20' });
  assert.equal(flight.ghosts.size, 0);
  motion.destroy();
  assert.equal(f.frames.size, 0);
});
