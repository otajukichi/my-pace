const ORBIT_DURATION = 1160;
const EASING = 'cubic-bezier(.22,1,.36,1)';
const clamp = value => Math.max(0, Math.min(1, value));
const easeOut = value => 1 - (1 - clamp(value)) ** 4;
const sweep = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const number = value => Number(value.toFixed(3));

// Both contours use the same eight cubic segments, beginning at twelve o'clock.
// Interpolating their control points rounds a calendar square into a donut
// without changing the path order used by the three activity segments.
const squareQuarter = [
  [69, 10, 86, 10, 88, 12],
  [90, 14, 90, 31, 90, 50],
];
const circleSegments = Array.from({ length: 8 }, (_, index) => {
  const from = -Math.PI / 2 + index * Math.PI / 4;
  const to = from + Math.PI / 4;
  const k = 4 / 3 * Math.tan(Math.PI / 16);
  return [
    50 + 40 * (Math.cos(from) - k * Math.sin(from)),
    50 + 40 * (Math.sin(from) + k * Math.cos(from)),
    50 + 40 * (Math.cos(to) + k * Math.sin(to)),
    50 + 40 * (Math.sin(to) - k * Math.cos(to)),
    50 + 40 * Math.cos(to), 50 + 40 * Math.sin(to),
  ];
});
const squareSegments = Array.from({ length: 8 }, (_, index) => {
  const angle = Math.floor(index / 2) * Math.PI / 2;
  const values = squareQuarter[index % 2];
  return values.flatMap((value, coordinate) => {
    if (coordinate % 2) return [];
    const x = value - 50, y = values[coordinate + 1] - 50;
    return [50 + x * Math.cos(angle) - y * Math.sin(angle), 50 + x * Math.sin(angle) + y * Math.cos(angle)];
  });
});

export function orbitPath(roundness = 1) {
  const t = Number.isFinite(roundness) ? clamp(roundness) : 1;
  return 'M50 10' + circleSegments.map((segment, index) => 'C' + segment.map((value, coordinate) =>
    number(squareSegments[index][coordinate] + (value - squareSegments[index][coordinate]) * t)
  ).join(' ')).join('') + 'Z';
}

const CIRCLE = orbitPath();

/** Finite presentation effects only. The model's recorded values are never
 * changed by animation. Detached views, hidden tabs, and reduced motion settle
 * to the same completed SVG immediately, with no background animation loop. */
export function createHomeMotion(root) {
  const document = root.ownerDocument;
  const view = document.defaultView;
  const reduced = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  const orbits = new Map();
  const reveals = new Set();
  let frame = null, destroyed = false;
  const query = (selector, within = root) => [...within.querySelectorAll(selector)];
  const allowed = () => !destroyed && !document.hidden && !reduced?.matches && root.isConnected !== false;

  function arcValues(path) {
    const length = Number(path.dataset.length), start = Number(path.dataset.start);
    return { path, length: Number.isFinite(length) ? Math.max(0, Math.min(100, length)) : 0,
      start: Number.isFinite(start) ? ((start % 100) + 100) % 100 : 0 };
  }

  function finalOrbit(svg, values = query('[data-orbit-arc]', svg).map(arcValues)) {
    for (const path of query('[data-orbit-track], [data-orbit-arc]', svg)) path.setAttribute('d', CIRCLE);
    for (const { path, length, start } of values) {
      path.setAttribute('stroke-dasharray', `${number(length)} 100`);
      path.setAttribute('stroke-dashoffset', String(number(-start)));
    }
  }

  function restoreStyle(element, saved) {
    for (const [key, value, priority] of saved) {
      if (value) element.style.setProperty(key, value, priority);
      else element.style.removeProperty(key);
    }
  }

  function settleOrbit(record) {
    finalOrbit(record.svg, record.arcs);
    restoreStyle(record.svg, record.styles);
    orbits.delete(record.svg);
  }

  function cancelFrameIfIdle() {
    if (orbits.size || frame === null) return;
    view.cancelAnimationFrame(frame); frame = null;
  }

  function stop(group) {
    for (const record of [...orbits.values()]) if (!group || record.group === group) settleOrbit(record);
    for (const effect of [...reveals]) if (!group || effect.group === group) effect.finish();
    cancelFrameIfIdle();
  }

  function tick(now) {
    frame = null;
    if (!allowed()) { stop(); return; }
    for (const record of [...orbits.values()]) {
      if (record.svg.isConnected === false) { settleOrbit(record); continue; }
      const progress = clamp((now - record.start) / record.duration);
      if (progress >= 1) { settleOrbit(record); continue; }
      draw(record, progress);
    }
    if (orbits.size) frame = view.requestAnimationFrame(tick);
  }

  function draw(record, progress) {
    const rounded = easeOut(progress / .82);
    const d = orbitPath(rounded);
    if (d !== record.lastPath) {
      record.paths.forEach(path => path.setAttribute('d', d));
      record.lastPath = d;
    }
    const painted = sweep((progress - .1) / .9);
    for (const { path, length } of record.arcs) path.setAttribute('stroke-dasharray', `${number(length * painted)} 100`);
    record.svg.style.opacity = String(.3 + .7 * easeOut(progress / .65));
    record.svg.style.transform = `scale(${number(.8 + .2 * easeOut(progress))})`;
  }

  function startOrbit(svg, group, delay = 0, duration = ORBIT_DURATION) {
    const previous = orbits.get(svg);
    if (previous) settleOrbit(previous);
    const arcs = query('[data-orbit-arc]', svg).map(arcValues);
    if (!allowed() || typeof view.requestAnimationFrame !== 'function') { finalOrbit(svg, arcs); return; }
    const styles = ['opacity', 'transform', 'transform-origin', 'transform-box'].map(key =>
      [key, svg.style.getPropertyValue(key), svg.style.getPropertyPriority(key)]);
    const record = { svg, arcs, group, paths: query('[data-orbit-track], [data-orbit-arc]', svg), styles,
      start: view.performance.now() + delay, duration, lastPath: null };
    svg.style.transformOrigin = '50% 50%';
    svg.style.transformBox = 'view-box';
    for (const { path, start } of arcs) path.setAttribute('stroke-dashoffset', String(number(-start)));
    orbits.set(svg, record); draw(record, 0);
    if (frame === null) frame = view.requestAnimationFrame(tick);
  }

  function reveal(element, group, { delay = 0, x = 0, y = 10, duration = 520 } = {}) {
    if (!element?.animate || !allowed()) return;
    const animation = element.animate([
      { opacity: .25, transform: `translate(${x}px, ${y}px)` },
      { opacity: 1, transform: 'translate(0, 0)' },
    ], { duration, delay, easing: EASING, fill: 'backwards' });
    const effect = { group, finish() { animation.cancel(); reveals.delete(effect); } };
    reveals.add(effect);
    animation.finished.then(effect.finish, () => reveals.delete(effect));
  }

  function flyFromDay(date, target) {
    if (!allowed() || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const cell = query('[data-home-day]').find(element => element.dataset.homeDay === date);
    const source = cell?.querySelector?.('.home-orbit');
    if (!source?.cloneNode || !target?.getBoundingClientRect) return;
    const from = source.getBoundingClientRect(), to = target.getBoundingClientRect();
    const inViewport = rect => rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0
      && rect.right <= view.innerWidth && rect.bottom <= view.innerHeight;
    // A mobile detail panel may sit below the fold. Never scroll the page or
    // send a floating element to an invisible destination.
    if (!inViewport(from) || !inViewport(to)) return;

    const ghost = source.cloneNode(true);
    if (!ghost.animate) return;
    ghost.classList.add('home-flight-ghost');
    ghost.removeAttribute('id');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.setAttribute('focusable', 'false');
    query('[id]', ghost).forEach(element => element.removeAttribute('id'));
    const originals = query('[data-orbit-track], [data-orbit-arc]', source);
    query('[data-orbit-track], [data-orbit-arc]', ghost).forEach((path, index) => {
      const computed = view.getComputedStyle(originals[index]);
      for (const key of ['stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill', 'opacity', 'fill-opacity', 'stroke-opacity', 'display']) {
        path.style.setProperty(key, computed.getPropertyValue(key));
      }
    });
    Object.assign(ghost.style, {
      position: 'fixed', inset: 'auto', left: `${from.left}px`, top: `${from.top}px`,
      width: `${from.width}px`, height: `${from.height}px`, maxWidth: 'none', maxHeight: 'none',
      margin: '0', padding: '0', pointerEvents: 'none', zIndex: '1000',
      transformOrigin: '50% 50%', transformBox: 'border-box', opacity: '0',
      display: 'block', overflow: 'visible', filter: 'drop-shadow(0 6px 12px #00000012)',
    });
    root.appendChild(ghost);
    const dx = to.left + to.width / 2 - from.left - from.width / 2;
    const dy = to.top + to.height / 2 - from.top - from.height / 2;
    const bend = Math.min(64, Math.hypot(dx, dy) * .14);
    const sx = to.width / from.width, sy = to.height / from.height;
    const frames = Array.from({ length: 9 }, (_, index) => {
      const t = index / 8;
      const x = dx * t, y = dy * t - 2 * bend * t * (1 - t);
      const opacity = t < .15 ? .1 + .7 * t / .15 : t > .72 ? .8 * (1 - (t - .72) / .28) : .8;
      return { offset: t, opacity: Math.max(0, opacity),
        transform: `translate(${number(x)}px, ${number(y)}px) scale(${number(1 + (sx - 1) * t)}, ${number(1 + (sy - 1) * t)})` };
    });
    const animation = ghost.animate(frames, { duration: 620, easing: 'cubic-bezier(.3,.05,.2,1)', fill: 'both' });
    let done = false;
    const effect = { group: 'detail', kind: 'flight', finish() {
      if (done) return;
      done = true; animation.cancel(); ghost.remove(); reveals.delete(effect);
    } };
    reveals.add(effect);
    animation.finished.then(effect.finish, effect.finish);
  }

  function calendarOrbits(direction = 1) {
    stop('calendar');
    // Individual habit updates can overlap a month change. Cancel those old
    // cells too, while allowing a separate selected-day animation to finish.
    for (const record of [...orbits.values()]) if (record.group.startsWith('day:')) settleOrbit(record);
    const cells = query('.home-calendar-grid .home-orbit');
    cells.forEach((svg, index) => {
      const order = direction < 0 ? cells.length - 1 - index : index;
      startOrbit(svg, 'calendar', order / Math.max(1, cells.length - 1) * 220);
    });
  }

  function detail({ fromDate } = {}) {
    if (destroyed) return;
    stop('detail');
    const panel = root.querySelector('.home-day-detail');
    if (!panel) return;
    flyFromDay(fromDate, panel.querySelector?.('.home-orbit'));
    query('.home-orbit', panel).forEach(svg => startOrbit(svg, 'detail', 20, 600));
    reveal(panel, 'detail', { y: 7, duration: 430 });
  }

  function settleAll() { stop(); }
  function visibility() { if (document.hidden) settleAll(); }
  function cancelFlights() { for (const effect of [...reveals]) if (effect.kind === 'flight') effect.finish(); }
  document.addEventListener('visibilitychange', visibility);
  reduced?.addEventListener?.('change', settleAll);
  view.addEventListener?.('scroll', cancelFlights, { capture: true, passive: true });
  view.addEventListener?.('resize', cancelFlights, { passive: true });

  return {
    enter() {
      if (destroyed) return;
      stop(); calendarOrbits(); detail();
      query('.home-reveal').filter(element => !element.matches?.('.home-day-detail'))
        .forEach((element, index) => reveal(element, 'entry', { delay: Math.min(index * 65, 260), y: 12, duration: 620 }));
    },
    calendar(direction = 1) {
      if (destroyed) return;
      calendarOrbits(direction); detail();
      reveal(root.querySelector('.home-calendar-grid'), 'calendar', { x: direction < 0 ? -9 : 9, y: 0, duration: 450 });
    },
    detail,
    refreshDay(date) {
      if (destroyed || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      const cell = query('[data-home-day]').find(element => element.dataset.homeDay === date);
      if (!cell) return;
      const group = `day:${date}`;
      stop(group);
      query('.home-orbit', cell).forEach(svg => startOrbit(svg, group, 0, 460));
    },
    destroy() {
      if (destroyed) return;
      stop(); destroyed = true;
      document.removeEventListener('visibilitychange', visibility);
      reduced?.removeEventListener?.('change', settleAll);
      view.removeEventListener?.('scroll', cancelFlights, true);
      view.removeEventListener?.('resize', cancelFlights);
    },
  };
}
