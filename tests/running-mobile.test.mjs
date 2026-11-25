import test from 'node:test';
import assert from 'node:assert/strict';
import { indexRunDays } from '../lib/running-calendar.js';
import { runningMobilePanel } from '../lib/running-mobile-view.js';

const run = (id, date, distanceMeters, durationSeconds) => ({
  id, date,
  summary: { distanceMeters, durationSeconds, paceSecondsPerKm: durationSeconds / (distanceMeters / 1000) },
  paceSamples: [{ elapsedSeconds: 60, paceSecondsPerKm: 400, coverage: 1 }, { elapsedSeconds: 120, paceSecondsPerKm: 450, coverage: 1 }],
  splits: [{ kilometer: 1, distanceMeters: 1000, paceSecondsPerKm: 400 }],
});
const records = [
  run('outside-month', '2026-09-30', 1000, 600),
  run('earlier', '2026-10-05', 2000, 1000),
  run('morning', '2026-10-15', 2000, 1000),
  run('evening', '2026-10-15', 3000, 1200),
];
const context = {
  days: indexRunDays(records, '2026-11-08'), month: '2026-10', selectedDay: '2026-10-15',
  selectedRunId: 'evening', lastSelectedDay: '2026-10-15', calendarEnd: '2026-10', calendarMonths: 6,
  mobile: true, slotCount: 3, mobileExpanded: true,
  explorationStats: new Map([
    ['outside-month', { total: 1000, fresh: 1000 }], ['earlier', { total: 2000, fresh: 500 }],
    ['morning', { total: 2000, fresh: 400 }], ['evening', { total: 3000, fresh: 500 }],
  ]),
};
const summary = html => html.match(/<section class="mobile-run-summary"[\s\S]*?<\/section>/)[0];
const text = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const opening = (html, id) => html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))[0];
const hidden = tag => /\shidden(?:\s|>)/.test(tag);

test('phone day summary aggregates all same-day runs even while inspecting one run', () => {
  const collapsed = runningMobilePanel({ ...context, mobileExpanded: false });
  const expanded = runningMobilePanel(context);
  const analyzing = runningMobilePanel({ ...context, mobileAnalysis: true });
  assert.equal(summary(collapsed), summary(expanded));
  assert.equal(summary(expanded), summary(analyzing));
  const value = text(summary(expanded));
  assert.match(value, /2件の記録/);
  assert.match(value, /5\.00km距離/);
  assert.match(value, /36:40経過時間/);
  assert.match(value, /7′20″平均ペース/);
  assert.match(value, /約0\.90km新しく走った道/);
  assert.match(analyzing, /<option value="evening" selected>/);
});

test('phone month summary excludes other months and does not offer single-day pace analysis', () => {
  const html = runningMobilePanel({ ...context, selectedDay: null, mobileAnalysis: true });
  const value = text(summary(html));
  assert.match(value, /2026年10月/);
  assert.match(value, /2日 · 3件/);
  assert.match(value, /7\.00km月間距離/);
  assert.match(value, /53:20経過時間/);
  assert.match(value, /7′37″平均ペース/);
  assert.match(value, /約1\.40km新しく走った道/);
  assert.doesNotMatch(html, /data-mobile-analysis|id="running-log-details"/);
  assert.equal(hidden(opening(html, 'mobile-running-history')), false);
  assert.equal(hidden(opening(html, 'mobile-pace-content')), true);
});

test('empty selected days and months remain empty rather than showing another run’s metrics', () => {
  for (const selection of [
    { selectedDay: '2026-10-10' },
    { selectedDay: null, month: '2026-08' },
    { selectedDay: '2026-10-15', days: new Map() },
  ]) {
    const html = runningMobilePanel({ ...context, ...selection, mobileAnalysis: true });
    assert.match(text(summary(html)), /記録がありません|記録はありません/);
    assert.doesNotMatch(summary(html), /mobile-run-metrics/);
    assert.doesNotMatch(html, /data-mobile-analysis|id="running-log-details"/);
    assert.equal(hidden(opening(html, 'mobile-running-history')), false);
  }
  const noData = runningMobilePanel({ ...context, days: new Map() });
  assert.doesNotMatch(summary(noData), /data-action="running-latest"/);
  const emptyDay = runningMobilePanel({ ...context, selectedDay: '2026-10-10' });
  assert.match(summary(emptyDay), /data-action="running-latest"/);
});

test('missing GPS is unknown while a measured zero new-road distance remains zero', () => {
  const missing = runningMobilePanel({ ...context, explorationStats: new Map() });
  assert.match(summary(missing), /新しく走った道 算出できません/);
  assert.doesNotMatch(text(summary(missing)), /約0\.00km/);
  const known = runningMobilePanel({ ...context, explorationStats: new Map([
    ['morning', { total: 2000, fresh: 0 }], ['evening', { total: 3000, fresh: 0 }],
  ]) });
  assert.match(text(summary(known)), /約0\.00km新しく走った道/);
});

test('collapsed sheet keeps the selected summary outside hidden history; expanded history has no tabs', () => {
  const collapsed = runningMobilePanel({ ...context, mobileExpanded: false });
  const expanded = runningMobilePanel(context);
  assert.equal(hidden(opening(collapsed, 'mobile-running-content')), true);
  assert.equal(hidden(opening(expanded, 'mobile-running-content')), false);
  assert.ok(collapsed.indexOf('mobile-run-summary') < collapsed.indexOf('id="mobile-running-content"'));
  for (const html of [collapsed, expanded]) {
    assert.doesNotMatch(html, /role="tab(?:list|panel)?"|data-mobile-tab/);
    assert.match(html, /id="annual-calendar"/);
    assert.match(html, /class="mobile-month-summary"/);
    assert.match(html, /id="running-weather"/);
    assert.match(html, /class="running-slot/);
  }
});

test('pace disclosure can expose analysis and restore the same history without a page change', () => {
  const closed = runningMobilePanel({ ...context, mobileAnalysis: false });
  const opened = runningMobilePanel({ ...context, mobileAnalysis: true });
  const returned = runningMobilePanel({ ...context, mobileAnalysis: false });
  assert.match(closed, /data-mobile-analysis aria-expanded="false"/);
  assert.equal(hidden(opening(closed, 'mobile-running-history')), false);
  assert.equal(hidden(opening(closed, 'mobile-pace-content')), true);
  assert.match(opened, /data-mobile-analysis aria-expanded="true"/);
  assert.equal(hidden(opening(opened, 'mobile-running-history')), true);
  assert.equal(hidden(opening(opened, 'mobile-pace-content')), false);
  assert.match(opened, /id="running-log-details"/);
  const historyReturn = opened.match(/<button class="mobile-history-disclosure"[^>]*>/)[0];
  assert.equal(hidden(historyReturn), false);
  assert.match(historyReturn, /data-mobile-history/);
  assert.match(text(opened), /閉じる/);
  assert.equal(returned, closed);
  for (const html of [closed, opened]) {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length, 'shared renderers must not duplicate IDs');
  }
});
