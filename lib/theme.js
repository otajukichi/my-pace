import { DEFAULT_THEME_PACK, THEME_PACKS, THEME_MODES, resolveTheme } from './theme-packs.js';
export { THEME_MODES, THEME_NAMES, themeAt } from './theme-packs.js';

export const THEME_STORAGE_KEY = 'mypace.theme.v2';
const LEGACY_KEY = 'mypace.theme.v1';
const knownPack = id => THEME_PACKS.some(pack => pack.id === id);
const knownMode = mode => THEME_MODES.includes(mode);
const validPage = page => typeof page === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(page);

/** A preference only: activity records and account state never enter this store. */
function preference(raw, legacy) {
  if (raw != null) {
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return { pack: knownPack(value.pack) ? value.pack : DEFAULT_THEME_PACK,
          mode: knownMode(value.mode) ? value.mode : 'auto' };
      }
    } catch {}
  }
  return { pack: DEFAULT_THEME_PACK, mode: knownMode(legacy) ? legacy : 'auto' };
}

/** Resolve page and clock independently; changing colors never remounts a page. */
export function createThemeController({ document = globalThis.document, storage, page,
  now = () => new Date(), onChange = () => {} } = {}) {
  let pack = DEFAULT_THEME_PACK, mode = 'auto', state, signature = '', destroyed = false, timer = null;
  let currentPage = validPage(page) ? page : validPage(document.documentElement.dataset.page) ? document.documentElement.dataset.page : 'home';
  let ownedTokens = new Set();
  const view = document.defaultView;
  const timerHost = typeof view?.setTimeout === 'function' && typeof view?.clearTimeout === 'function' ? view : globalThis;
  try { if (storage === undefined) storage = globalThis.localStorage; } catch {}

  function readPreference() {
    if (!storage) return null;
    try { return preference(storage.getItem(THEME_STORAGE_KEY), storage.getItem(LEGACY_KEY)); }
    catch { return null; }
  }
  const saved = readPreference();
  if (saved) ({ pack, mode } = saved);
  const snapshot = () => state && ({ ...state, tokens: { ...state.tokens } });
  const hidden = () => document.visibilityState === 'hidden' || document.hidden === true;

  function apply() {
    if (destroyed) return snapshot();
    const next = resolveTheme({ pack, mode, page: currentPage, date: now() });
    const nextSignature = JSON.stringify(next);
    if (nextSignature === signature) return snapshot();
    signature = nextSignature;
    state = { ...next, tokens: { ...next.tokens } };
    const element = document.documentElement;
    Object.assign(element.dataset, { theme: next.active, themeMode: mode, themePack: next.pack,
      themePage: currentPage, themeVariant: next.variant, themeScheme: next.scheme });
    const style = element.style;
    const keys = new Set(Object.keys(next.tokens));
    for (const key of ownedTokens) if (!keys.has(key)) style?.removeProperty(`--${key}`);
    for (const [key, value] of Object.entries(next.tokens)) style?.setProperty(`--${key}`, value);
    if (style) style.colorScheme = next.scheme;
    ownedTokens = keys;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next.tokens.paper);
    onChange(snapshot());
    return snapshot();
  }
  function clearTimer() {
    if (timer !== null) timerHost.clearTimeout(timer);
    timer = null;
  }
  function schedule() {
    clearTimer();
    const result = apply();
    if (!destroyed && mode === 'auto' && !hidden()) {
      timer = timerHost.setTimeout(schedule, 60000 - (+now() % 60000) + 20);
    }
    return result;
  }
  function save() {
    if (!storage) return false;
    try { storage.setItem(THEME_STORAGE_KEY, JSON.stringify({ pack, mode })); return true; }
    catch { return false; }
  }
  function resume() { if (hidden()) clearTimer(); else schedule(); }
  function storageChanged(event) {
    if (event.key !== THEME_STORAGE_KEY && event.key !== LEGACY_KEY && event.key !== null) return;
    if (event.storageArea && event.storageArea !== storage) return;
    const next = readPreference();
    if (!next) return;
    ({ pack, mode } = next);
    schedule();
  }
  document.addEventListener('visibilitychange', resume);
  view?.addEventListener('pageshow', resume);
  view?.addEventListener('storage', storageChanged);
  schedule();
  return {
    get: snapshot,
    refresh: schedule,
    set(next) {
      if (destroyed || !knownMode(next)) return false;
      mode = next; const persisted = save(); schedule(); return persisted;
    },
    setPack(next) {
      if (destroyed || !knownPack(next)) return false;
      pack = next; const persisted = save(); schedule(); return persisted;
    },
    setPage(next) {
      if (destroyed || !validPage(next) || next === currentPage) return;
      currentPage = next; apply();
    },
    destroy() {
      destroyed = true; clearTimer();
      document.removeEventListener('visibilitychange', resume);
      view?.removeEventListener('pageshow', resume);
      view?.removeEventListener('storage', storageChanged);
    },
  };
}
