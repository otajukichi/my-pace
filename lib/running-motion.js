const ENTRY_DURATION = 1450;
const EASING = 'cubic-bezier(.22,1,.36,1)';

/** Changes to the selected day are deliberately absent: only the map moves.
 * A rerender or a new data object is not a new visit to this page. */
export function runningMotionPlan(previous, next) {
  if (!next.ready) return { state: previous, entry: false, month: false, calendar: false };
  const entry = previous === null;
  return {
    state: { month: next.month, calendar: next.calendar },
    entry,
    month: !entry && previous.month !== next.month,
    calendar: !entry && previous.calendar !== next.calendar,
  };
}

/** Short, interruptible presentation effects. The real values and all controls
 * remain in the document, including while an aria-hidden counter is running. */
export function createRunningMotion({ document = globalThis.document } = {}) {
  const view = document.defaultView;
  const reduced = view.matchMedia('(prefers-reduced-motion: reduce)');
  const effects = new Set();
  let state = null;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const allowed = () => !document.hidden && !reduced.matches;

  function stop(scope) {
    for (const effect of [...effects]) if (!scope || effect.scope === scope) effect.finish();
  }

  function animate(element, keyframes, options, scope = 'panel') {
    if (!element?.animate || !allowed()) return;
    const animation = element.animate(keyframes, {
      duration: 420, easing: EASING, fill: 'backwards', ...options,
    });
    const effect = { scope, finish() { animation.cancel(); effects.delete(effect); } };
    effects.add(effect);
    animation.finished.then(effect.finish, () => effects.delete(effect));
  }

  function enter(element, delay = 0, scope = 'panel') {
    animate(element, [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0)' }], { delay }, scope);
  }

  function countMonth(delay = 0) {
    const original = $('.running-month-distance>strong:not(.running-count-overlay)');
    if (!original || !allowed()) return;
    const value = Number.parseFloat(original.textContent.replaceAll(',', ''));
    if (!Number.isFinite(value) || value <= 0) return;

    // Keep the original markup and direct-child typography selectors intact.
    // The clone takes no layout space, so the card cannot grow mid-animation.
    const overlay = original.cloneNode(true);
    overlay.classList.add('running-count-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.removeAttribute('id');
    const whole = [...overlay.childNodes].find(node => node.nodeType === 3);
    const fraction = overlay.querySelector('.distance-fraction');
    if (!whole || !fraction) return;
    Object.assign(overlay.style, {
      top: `${original.offsetTop}px`, left: `${original.offsetLeft}px`,
      width: `${original.getBoundingClientRect().width}px`,
    });
    original.after(overlay);
    original.classList.add('running-count-source');
    let frame = null, done = false;
    const start = view.performance.now() + delay;
    const effect = { scope: 'panel', finish() {
      if (done) return;
      done = true;
      if (frame !== null) view.cancelAnimationFrame(frame);
      original.classList.remove('running-count-source');
      overlay.remove(); effects.delete(effect);
    } };
    effects.add(effect);
    function tick(now) {
      if (done) return;
      if (!original.isConnected || !allowed()) { effect.finish(); return; }
      const time = Math.min(1, Math.max(0, (now - start) / ENTRY_DURATION));
      const [integer, decimal] = (value * (1 - (1 - time) ** 3)).toFixed(2).split('.');
      whole.textContent = integer; fraction.textContent = '.' + decimal;
      if (time < 1) frame = view.requestAnimationFrame(tick);
      else effect.finish();
    }
    tick(view.performance.now());
  }

  function calendarWave() {
    const cells = $$('.run-cell');
    cells.forEach((cell, index) => {
      if (cell.classList.contains('level-0') || cell.classList.contains('future')) return;
      animate(cell.firstElementChild, [
        { opacity: .12, transform: 'scale(.78)' },
        { opacity: 1, transform: 'scale(1)' },
      ], { delay: 100 + index / Math.max(1, cells.length) * 460, duration: 460 });
    });
  }

  function trace(path, delay) {
    const length = path.getTotalLength();
    if (!length) return;
    animate(path, [
      { strokeDasharray: `${length} ${length}`, strokeDashoffset: length },
      { strokeDasharray: `${length} ${length}`, strokeDashoffset: 0 },
    ], { duration: ENTRY_DURATION, delay });
  }

  function rendered(next) {
    const plan = runningMotionPlan(state, next);
    state = plan.state;
    // Consume this change even when motion is disabled or the tab is hidden.
    if (!allowed()) return;
    if (plan.entry) {
      enter($('.running-message'));
      enter($('.running-month-summary'), 80);
      enter($('.running-slot'), 120);
      enter($('#running-weather'), 160);
      // Opacity only: map fitting measures this card's rectangle.
      animate($('#map-bottom>.running-selection'), [{ opacity: 0 }, { opacity: 1 }], { delay: 160 }, 'selection');
      calendarWave(); countMonth(80);
      $$('.run-thumbnail path').forEach((path, index) => trace(path, 120 + index * 35));
      const lane = $('.message-lanes path');
      if (lane) trace(lane, 0);
    } else {
      if (plan.month) { enter($('.running-month-summary')); countMonth(); }
      if (plan.calendar) calendarWave();
    }
  }

  const interrupt = () => stop();
  const visibility = () => { if (document.hidden) stop(); };
  for (const event of ['pointerdown', 'wheel', 'keydown']) document.addEventListener(event, interrupt, { capture: true, passive: true });
  document.addEventListener('visibilitychange', visibility);
  view.addEventListener('resize', interrupt);
  reduced.addEventListener('change', interrupt);
  return {
    rendered, stop,
    reset() { stop(); state = null; },
    destroy() {
      stop();
      for (const event of ['pointerdown', 'wheel', 'keydown']) document.removeEventListener(event, interrupt, true);
      document.removeEventListener('visibilitychange', visibility);
      view.removeEventListener('resize', interrupt);
      reduced.removeEventListener('change', interrupt);
    },
  };
}
