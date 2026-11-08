export const THEME_MODES = ['auto', 'morning', 'day', 'night'];
export const THEME_NAMES = { morning: '朝', day: '昼', night: '晩' };
const KEY = 'mypace.theme.v1';
const hourFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' });
export function themeAt(date = new Date()) {
  const hour = Number(hourFormat.format(date));
  return hour >= 5 && hour < 11 ? 'morning' : hour >= 11 && hour < 18 ? 'day' : 'night';
}
export function createThemeController({ document = globalThis.document, storage, now = () => new Date(), onChange = () => {} } = {}) {
  let mode = 'auto', timer, active;
  try { storage ??= globalThis.localStorage; const saved = storage?.getItem(KEY); if (THEME_MODES.includes(saved)) mode = saved; } catch {}
  function apply() {
    const next = mode === 'auto' ? themeAt(now()) : mode;
    document.documentElement.dataset.themeMode = mode;
    if (next !== active) {
      active = next; document.documentElement.dataset.theme = active;
      const colors = { morning: '#FAF3E8', day: '#F7F0E8', night: '#16283F' };
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors[active]);
      onChange({ mode, active });
    }
    return { mode, active };
  }
  function schedule() { clearTimeout(timer); apply(); timer = setTimeout(schedule, 60000 - (+now() % 60000) + 20); }
  function resume() { if (document.visibilityState !== 'hidden') schedule(); }
  document.addEventListener('visibilitychange', resume);
  document.defaultView?.addEventListener('pageshow', resume);
  schedule();
  return { get: () => ({ mode, active }), refresh: apply,
    set(next) { if (!THEME_MODES.includes(next)) return false; mode = next; let saved = true;
      try { storage?.setItem(KEY, mode); if (!storage) saved = false; } catch { saved = false; }
      apply(); return saved;
    },
    destroy() { clearTimeout(timer); document.removeEventListener('visibilitychange', resume); document.defaultView?.removeEventListener('pageshow', resume); }
  };
}
