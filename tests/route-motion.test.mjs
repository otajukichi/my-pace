import test from 'node:test';
import assert from 'node:assert/strict';
import { routeMotionPlan, revealEdges } from '../lib/route-motion.js';

const ready = (motionKey, extra = {}) => ({
  motionKey, animate: true, runCount: 1, edges: 100, pixels: 1_000_000, ...extra,
});

test('an entrance belongs to a ready semantic selection, not a refresh or map remount', () => {
  const retained = {};
  assert.deepEqual(routeMotionPlan(retained, ready('day-a')), { kind: 'trace', duration: 1450 });
  // Details, new data object references, pan/zoom and a new map retain this key.
  assert.equal(routeMotionPlan(retained, ready('day-a', { edges: 110 })), null);
  assert.deepEqual(routeMotionPlan(retained, ready('day-b')), { kind: 'trace', duration: 850 });
  assert.equal(routeMotionPlan(retained, ready('day-b')), null);
  assert.deepEqual(routeMotionPlan(retained, ready('day-a')), { kind: 'trace', duration: 850 });
});

test('pending routes do not consume a selection, but a genuinely empty day does', () => {
  const state = {};
  assert.equal(routeMotionPlan(state, ready(null, { runCount: 0, edges: 0 })), null);
  assert.deepEqual(state, {});
  routeMotionPlan(state, ready('day-a'));
  routeMotionPlan(state, ready(null, { animate: false, runCount: 0, edges: 0 }));
  assert.equal(state.key, 'day-a');
  assert.equal(routeMotionPlan(state, ready('day-a')), null);
  assert.equal(routeMotionPlan(state, ready('empty-b', { runCount: 0, edges: 0 })), null);
  assert.equal(state.key, 'empty-b');
  assert.deepEqual(routeMotionPlan(state, ready('day-a')), { kind: 'trace', duration: 850 });
});

test('disabled, reduced-motion and hidden selections never replay when re-enabled', () => {
  for (const flag of [{ animate: false }, { reduced: true }, { hidden: true }]) {
    const state = {};
    assert.equal(routeMotionPlan(state, ready('a', flag)), null);
    assert.equal(routeMotionPlan(state, ready('a')), null);
    assert.deepEqual(routeMotionPlan(state, ready('b')), { kind: 'trace', duration: 850 });
  }
});

test('a discarded pending request cannot override a more recent consumed date', () => {
  const state = {};
  routeMotionPlan(state, ready('a'));
  // Repeated loading/null calls are allowed while app generation checks discard
  // stale network responses. Only the final ready selection is consumed.
  routeMotionPlan(state, ready(null));
  routeMotionPlan(state, ready(null));
  assert.deepEqual(routeMotionPlan(state, ready('c')), { kind: 'trace', duration: 850 });
  assert.equal(state.key, 'c');
  assert.equal(routeMotionPlan(state, ready('c')), null);
});

test('monthly and large renderings bound animation work with a short fade', () => {
  for (const data of [{ overview: true }, { runCount: 5 }, { edges: 6001 }, { pixels: 8_000_001 }]) {
    assert.deepEqual(routeMotionPlan({}, ready('a', data)), { kind: 'fade', duration: 440 });
  }
  assert.deepEqual(routeMotionPlan({}, ready('a', { edges: 6000, pixels: 8_000_000 })), { kind: 'trace', duration: 1450 });
  assert.equal(routeMotionPlan({}, ready('a', { edges: 0 })), null);
});

test('reveal geometry keeps chain breaks and separate runs without joining gaps', () => {
  const models = [
    { chains: [{ points: [[0, 0], [3, 4], [3, 4], [6, 8]] }, { points: [[50, 50], [53, 54]] }] },
    { chains: [{ points: [[100, 100], [103, 104]] }] },
  ];
  const original = JSON.stringify(models);
  const result = revealEdges(models, ([x, y]) => ({ x, y }), 2);
  assert.equal(result.total, 40);
  assert.equal(result.edges.length, 4);
  assert.deepEqual(result.edges.map(edge => edge.from), [0, 10, 20, 30]);
  assert.deepEqual(result.edges[2].a, { x: 100, y: 100 });
  assert.deepEqual(result.edges[3].a, { x: 200, y: 200 });
  assert.equal(JSON.stringify(models), original);
  assert.deepEqual(revealEdges([{ chains: [{ points: [[1, 1]] }] }], ([x, y]) => ({ x, y })), { edges: [], total: 0 });
});
