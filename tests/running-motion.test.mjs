import test from 'node:test';
import assert from 'node:assert/strict';
import { runningMotionPlan } from '../lib/running-motion.js';

const view = { ready: true, month: '2026-10', calendar: '2026-11/6' };

test('opening waits for data, then async route/detail/weather renders do not restart it', () => {
  const waiting = runningMotionPlan(null, { ...view, ready: false });
  assert.equal(waiting.state, null);
  assert.equal(waiting.entry, false);
  const opened = runningMotionPlan(waiting.state, view);
  assert.equal(opened.entry, true);
  for (const change of [{ day: '2026-10-05' }, { day: '2026-10-09' }, { analysis: true }, { weather: {} }]) {
    const next = runningMotionPlan(opened.state, { ...view, ...change });
    assert.equal(next.entry, false);
    assert.equal(next.month, false);
    assert.equal(next.calendar, false);
  }
});

test('a different month animates only its summary, and a different calendar range only its cells', () => {
  const first = runningMotionPlan(null, view);
  const month = runningMotionPlan(first.state, { ...view, month: '2026-09' });
  assert.equal(month.entry, false);
  assert.equal(month.month, true);
  assert.equal(month.calendar, false);
  const range = runningMotionPlan(month.state, { ...view, month: '2026-09', calendar: '2026-11/12' });
  assert.equal(range.entry, false);
  assert.equal(range.month, false);
  assert.equal(range.calendar, true);
  const same = runningMotionPlan(range.state, { ...view, month: '2026-09', calendar: '2026-11/12' });
  assert.equal(same.calendar, false);
});

test('a transient wait preserves the visit; resetting for another account/category opens afresh', () => {
  const opened = runningMotionPlan(null, view);
  const waiting = runningMotionPlan(opened.state, { ...view, ready: false });
  assert.equal(waiting.state, opened.state);
  assert.equal(runningMotionPlan(waiting.state, view).entry, false);
  assert.equal(runningMotionPlan(null, view).entry, true);
});
