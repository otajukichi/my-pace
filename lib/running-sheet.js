/** Two fixed positions. Only the handle owns gestures; map/reel keep theirs. */
export function mountRunningSheet({ workspace, handle, onChange, onSettled, view = window }) {
  const media = view.matchMedia('(max-width:760px)');
  const reduced = view.matchMedia('(prefers-reduced-motion:reduce)');
  const state = { expanded: false, analysis: false, moving: false };
  let timer, pointer, ignoreClickUntil = 0;
  const active = () => media.matches && workspace.classList.contains('history');
  function sync() {
    workspace.dataset.sheet = state.expanded ? 'expanded' : 'collapsed';
    handle.setAttribute('aria-expanded', String(state.expanded));
    handle.setAttribute('aria-label', state.expanded ? '記録パネルを閉じて地図を広げる' : '記録パネルを広げる');
    handle.querySelector('span').textContent = state.expanded ? '地図を広く見る' : 'カレンダー・ルートを見る';
  }
  function settle() {
    clearTimeout(timer); state.moving = false;
    if (active()) onSettled();
  }
  function expand(value) {
    if (!active() || state.expanded === value) return;
    state.expanded = value; state.moving = !reduced.matches;
    sync(); onChange();
    clearTimeout(timer); timer = view.setTimeout(settle, reduced.matches ? 0 : 520);
  }
  function click(event) {
    if (!active()) return;
    if (event.target.closest('#running-sheet-toggle')) {
      if (view.performance.now() >= ignoreClickUntil) expand(!state.expanded);
      return;
    }
    if (!state.expanded && event.target.closest('.mobile-run-summary') && !event.target.closest('button,a')) {
      expand(true); return;
    }
    if (event.target.closest('[data-mobile-analysis]')) {
      state.analysis = !state.analysis; onChange();
      workspace.querySelector('[data-mobile-analysis]')?.focus({ preventScroll: true });
    } else if (event.target.closest('[data-mobile-history]') && state.analysis) {
      state.analysis = false; onChange();
      workspace.querySelector('[data-mobile-history]')?.focus({ preventScroll: true });
    }
  }
  function keydown(event) {
    if (!active()) return;
    if (event.key === 'Escape' && state.expanded) {
      event.preventDefault(); expand(false); handle.focus({ preventScroll: true });
    }

  }
  function down(event) {
    if (!active() || !event.isPrimary || event.pointerType === 'mouse') return;
    pointer = { id: event.pointerId, y: event.clientY, x: event.clientX };
    handle.setPointerCapture(event.pointerId);
  }
  function up(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    const dy = event.clientY - pointer.y, dx = event.clientX - pointer.x;
    pointer = null;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    if (Math.abs(dy) < 24 || Math.abs(dy) <= Math.abs(dx)) return;
    ignoreClickUntil = view.performance.now() + 400; expand(dy < 0);
  }
  const cancel = () => { pointer = null; };
  const breakpoint = () => { clearTimeout(timer); state.moving = false; sync(); };
  workspace.addEventListener('click', click); workspace.addEventListener('keydown', keydown);
  handle.addEventListener('pointerdown', down); handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', cancel); media.addEventListener('change', breakpoint); reduced.addEventListener('change', settle);
  sync();
  return { state, sync, destroy() {
    clearTimeout(timer);
    workspace.removeEventListener('click', click); workspace.removeEventListener('keydown', keydown);
    handle.removeEventListener('pointerdown', down); handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', cancel); media.removeEventListener('change', breakpoint); reduced.removeEventListener('change', settle);
  } };
}
