import { explorationPaths, projectExploration } from './exploration.js';
import { icon, dayLabel, km } from './ui.js';

/** The reel browses recorded days; an empty selected day keeps its own slot. */
export function runSlotModel({ days, selectedDay, month, lastSelectedDay }) {
  const dates = [...days.keys()].sort();
  const inMonth = dates.filter(date => date.startsWith(month));
  const anchor = selectedDay || (inMonth.includes(lastSelectedDay) ? lastSelectedDay : inMonth.at(-1)) || `${month}-01`;
  const current = days.get(anchor) || null;
  return {
    anchor, current, monthly: !selectedDay, dates,
    previous: dates.filter(date => date < anchor).at(-1) || null,
    next: dates.find(date => date > anchor) || null,
    index: current ? dates.indexOf(anchor) + 1 : null,
  };
}

/** Keep the chosen date in view and fill edge windows with real nearby days,
 * instead of wasting rows on empty future slots. Missing days remain explicit. */
export function runSlotWindow(context, count = 5) {
  const model = runSlotModel(context), dates = [...model.dates];
  if (!dates.includes(model.anchor)) dates.push(model.anchor);
  dates.sort();
  const size = Math.max(1, Math.floor(count)), at = dates.indexOf(model.anchor);
  const start = Math.max(0, Math.min(at - Math.floor(size / 2), dates.length - size));
  return { ...model, visible: dates.slice(start, start + size) };
}

const thumbnailCache = new WeakMap();
/** North stays up and both axes share one scale. Missing GPS stays missing. */
export function routeThumbnailPaths(runs) {
  const paths = projectExploration(explorationPaths(runs), 0);
  if (!paths.length) return [];
  const anchor = paths[0].points[0].x;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const points = paths.map(path => {
    const shift = Math.round((anchor - (path.minX + path.maxX) / 2) / 256) * 256;
    return path.points.map(p => {
      const x = p.x + shift;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      return { x, y: p.y };
    });
  });
  const scale = Math.min(60 / Math.max(maxX - minX, 1e-12), 40 / Math.max(maxY - minY, 1e-12));
  const offsetX = (72 - (maxX - minX) * scale) / 2, offsetY = (52 - (maxY - minY) * scale) / 2;
  return points.map(path => {
    const output = []; let previous = null;
    path.forEach((p, i) => {
      const x = offsetX + (p.x - minX) * scale, y = offsetY + (p.y - minY) * scale;
      if (previous && i < path.length - 1 && Math.hypot(x - previous.x, y - previous.y) < .45) return;
      output.push(`${output.length ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`); previous = { x, y };
    });
    // A single recorded point is a point, not a fabricated route.
    if (output.length === 1) output.push(`l.01 0`);
    return output.join(' ');
  });
}

function thumbnail(day) {
  if (!day) return '<span class="run-slot-no-route" aria-hidden="true">—</span>';
  let paths = thumbnailCache.get(day);
  if (!paths) { paths = routeThumbnailPaths(day.runs); thumbnailCache.set(day, paths); }
  return paths.length ? `<svg class="run-thumbnail" viewBox="0 0 72 52" fill="none" aria-hidden="true">${paths.map(d => `<path d="${d}"/>`).join('')}</svg>` : '<span class="run-slot-no-route">GPSなし</span>';
}

export function runningSlot(context) {
  const model = runSlotWindow(context, context.slotCount || 5), { days, month } = context;
  const row = (date, position) => {
    const day = date && days.get(date), center = position === 'current', active = center && !model.monthly;
    if (center && model.monthly && !day) return '<div class="run-slot-month-empty">この月の記録はありません</div>';
    const label = `${dayLabel(date)}、${day ? `${km(day.distanceMeters)}キロ` : '取得済みの記録なし'}`;
    return `<button class="run-slot-row ${position} ${active ? 'active' : ''}" data-slot-date="${date}" aria-label="${label}の地図を表示" aria-pressed="${active}"><span class="run-slot-thumbnail">${thumbnail(day)}</span><span class="run-slot-label"><span>${dayLabel(date)}</span><strong>${day ? `${km(day.distanceMeters)}<small>km</small>` : '<small>記録なし</small>'}</strong></span>${day?.runs.length > 1 ? `<small class="run-slot-count">${day.runs.length}件</small>` : ''}</button>`;
  };
  return `<section class="running-slot ${model.monthly ? 'is-month' : ''}" aria-label="ルートから走った日を選ぶ"><div class="run-slot-heading"><h2>ルートで振り返る</h2><small>${model.monthly ? `${Number(month.slice(5))}月全体を表示中` : model.index ? `${model.index} / ${model.dates.length}` : '記録のない日'}</small></div><div class="run-slot-body"><div class="run-slot-reel" tabindex="0" role="group" aria-label="${model.monthly?`${Number(month.slice(5))}月の記録`:dayLabel(model.anchor)}。上下キー、ホイール、スワイプで前後の記録へ"><div class="run-slot-rows" style="--slot-rows:${model.visible.length}">${model.visible.map(date => row(date, date === model.anchor ? 'current' : date < model.anchor ? 'previous' : 'next')).join('')}</div></div><div class="run-slot-controls"><button class="icon-button" data-slot-step="-1" aria-label="前の走った日" ${!model.previous ? 'disabled' : ''}>${icon('up')}</button><span aria-hidden="true"></span><button class="icon-button" data-slot-step="1" aria-label="次の走った日" ${!model.next ? 'disabled' : ''}>${icon('down')}</button></div></div><span class="visually-hidden" role="status" aria-live="polite">${model.monthly ? `${Number(month.slice(5))}月全体を表示中。日付を選ぶと日別表示になります。` : `${dayLabel(model.anchor)}を表示中`}</span></section>`;
}

/** Delegation survives re-rendering. Wheel inertia advances only one day per
 * gesture, and swipes never scroll the page or accidentally click a new row. */
export function mountRunSlotInput(root, { getContext, select }) {
  const model = () => runSlotModel(getContext());
  const move = direction => { const target = model()[direction < 0 ? 'previous' : 'next']; if (target) select(target, direction); };
  let lastWheel = 0, wheelDelta = 0, wheelDirection = 0, wheelUsed = false, pointer = null, suppressClickUntil = 0;
  root.addEventListener('wheel', event => {
    if (!event.target.closest('.run-slot-reel') || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    const now = performance.now(), direction = Math.sign(event.deltaY);
    if (now - lastWheel > 180 || direction !== wheelDirection) { wheelDelta = 0; wheelUsed = false; }
    lastWheel = now; wheelDirection = direction;
    wheelDelta += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 200 : 1);
    if (!wheelUsed && Math.abs(wheelDelta) >= 35) { wheelUsed = true; move(direction); }
  }, { passive: false });
  root.addEventListener('keydown', event => {
    if (!event.target.closest('.run-slot-reel')) return;
    if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(event.key === 'ArrowUp' ? -1 : 1); }
    else if (['Home', 'End'].includes(event.key)) { event.preventDefault(); const value = model().dates[event.key === 'Home' ? 0 : model().dates.length - 1]; if (value) select(value); }
    else if (event.target.matches('.run-slot-reel') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); const m = model(); if (m.current) select(m.anchor); }
  });
  root.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.pointerType === 'mouse' || !event.target.closest('.run-slot-reel')) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  root.addEventListener('pointermove', event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (Math.abs(event.clientY - pointer.y) > 8 && !root.hasPointerCapture(event.pointerId)) root.setPointerCapture(event.pointerId);
  });
  root.addEventListener('pointerup', event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y; pointer = null;
    if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    if (Math.abs(dy) < 25 || Math.abs(dy) < Math.abs(dx) * 1.2) return;
    suppressClickUntil = performance.now() + 350; move(dy < 0 ? 1 : -1);
  });
  root.addEventListener('pointercancel', () => { pointer = null; });
  root.addEventListener('click', event => {
    if (event.detail && performance.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
}
