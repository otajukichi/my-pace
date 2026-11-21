import test from 'node:test';
import assert from 'node:assert/strict';
import { createThemeController, THEME_STORAGE_KEY, themeAt } from '../lib/theme.js';
import { DEFAULT_THEME_PACK, THEME_PACKS, resolveTheme, resolveThemePack } from '../lib/theme-packs.js';

function events() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    dispatch(name, event = {}) { for (const listener of listeners.get(name) || []) listener(event); },
  };
}
function fixture(initial = {}) {
  const values = new Map(Object.entries(initial)), writes = [], css = new Map(), meta = new Map(), timers = new Map(), changes = [];
  let date = new Date('2026-11-21T08:00:00+09:00'), timerId = 0;
  const storage = { getItem: key => values.get(key) ?? null, setItem(key, value) { values.set(key, value); writes.push([key, value]); } };
  const view = { ...events(),
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const document = { ...events(), defaultView: view, visibilityState: 'visible', hidden: false,
    documentElement: { dataset: {}, style: { setProperty(key, value) { css.set(key, value); }, removeProperty(key) { css.delete(key); } } },
    querySelector: () => ({ setAttribute(key, value) { meta.set(key, value); } }),
  };
  const controller = createThemeController({ document, storage, page: 'home', now: () => date, onChange: state => changes.push(state) });
  return { controller, storage, document, view, values, writes, css, meta, timers, changes,
    advance(iso) { date = new Date(iso); },
    tick() { const current = [...timers.values()]; timers.clear(); for (const { callback } of current) callback(); },
    visibility(value) { document.visibilityState = value; document.hidden = value === 'hidden'; document.dispatch('visibilitychange'); },
    stored(key, value) { if (value === null) values.delete(key); else values.set(key, value); view.dispatch('storage', { key, newValue: value, storageArea: storage }); },
  };
}
const alternate = () => THEME_PACKS.find(pack => pack.id !== DEFAULT_THEME_PACK && pack.pageAware)?.id;

// Old defaults must survive the introduction of independent pack and clock settings.
test('legacy choices migrate on the next explicit save without touching other local data', () => {
  for (const mode of ['auto', 'morning', 'day', 'night']) {
    const f = fixture({ 'mypace.theme.v1': mode, 'mypace.studio.v1': 'private activity data' });
    try {
      assert.equal(f.controller.get().pack, DEFAULT_THEME_PACK);
      assert.equal(f.controller.get().mode, mode);
      assert.equal(f.writes.length, 0);
      assert.equal(f.controller.setPack(alternate()), true);
      assert.deepEqual(JSON.parse(f.values.get(THEME_STORAGE_KEY)), { pack: alternate(), mode });
      assert.equal(f.values.get('mypace.studio.v1'), 'private activity data');
      assert.equal(f.values.get('mypace.theme.v1'), mode);
      assert.deepEqual(f.writes.map(([key]) => key), [THEME_STORAGE_KEY]);
    } finally { f.controller.destroy(); }
  }
});

test('v2 takes precedence, and unknown packs retain the chosen clock without destructive recovery', () => {
  const f = fixture({ [THEME_STORAGE_KEY]: JSON.stringify({ pack: 'future-pack', mode: 'night' }), 'mypace.theme.v1': 'morning' });
  try {
    assert.equal(f.controller.get().pack, DEFAULT_THEME_PACK);
    assert.equal(f.controller.get().mode, 'night');
    assert.equal(f.document.documentElement.dataset.themeScheme, 'dark');
    assert.equal(f.writes.length, 0);
    const previous = f.controller.get();
    assert.equal(f.controller.setPack('unregistered'), false);
    assert.equal(f.controller.set('12:00'), false);
    f.controller.setPage('<img>');
    assert.deepEqual(f.controller.get(), previous);
    assert.equal(f.writes.length, 0);
  } finally { f.controller.destroy(); }
});

test('pack and page jointly resolve complete palettes; leaving a dark or page-specific variant restores every token', () => {
  const f = fixture();
  try {
    assert.ok(alternate(), 'At least one page-aware alternative is available');
    f.css.set('--unrelated-owner', 'keep');
    f.controller.setPack(alternate());
    f.controller.set('night');
    const home = f.controller.get();
    f.controller.setPage('english');
    const english = f.controller.get();
    assert.equal(english.page, 'english');
    assert.notEqual(home.variant, english.variant);
    assert.notDeepEqual(home.tokens, english.tokens);
    assert.equal(f.document.documentElement.dataset.themePage, 'english');
    f.controller.setPage('fitness');
    assert.equal(f.controller.get().page, 'fitness');
    assert.ok(f.controller.get().tokens.paper);
    f.controller.setPack(DEFAULT_THEME_PACK); f.controller.set('morning');
    const expected = resolveTheme({ pack: DEFAULT_THEME_PACK, mode: 'morning', page: 'fitness' });
    for (const [key, value] of Object.entries(expected.tokens)) assert.equal(f.css.get(`--${key}`), value, key);
    assert.equal(f.css.get('--unrelated-owner'), 'keep');
    assert.deepEqual([...f.css.keys()].sort(), [...Object.keys(expected.tokens).map(key => `--${key}`), '--unrelated-owner'].sort());
    assert.equal(f.meta.get('content'), '#FAF3E8');
    assert.equal(f.document.documentElement.style.colorScheme, 'light');
    assert.equal(f.document.documentElement.dataset.themeScheme, 'light');
    assert.equal(f.css.get('--paper'), '#FAF3E8');
    assert.equal(f.css.get('--ink'), '#243D5A');
    assert.deepEqual(JSON.parse(f.values.get(THEME_STORAGE_KEY)), { pack: DEFAULT_THEME_PACK, mode: 'morning' });
  } finally { f.controller.destroy(); }
});

test('clock follows Japan time, pauses while hidden, catches up on return, and fixed time keeps page variations', () => {
  const f = fixture();
  try {
    for (const [time, expected] of [['04:59:59', 'night'], ['05:00:00', 'morning'], ['10:59:59', 'morning'], ['11:00:00', 'day'], ['17:59:59', 'day'], ['18:00:00', 'night']]) {
      const date = new Date(`2026-11-21T${time}+09:00`);
      assert.equal(themeAt(date), expected);
      f.advance(date.toISOString()); f.tick();
      assert.equal(f.controller.get().active, expected);
      assert.equal(f.timers.size, 1);
    }
    f.visibility('hidden'); assert.equal(f.timers.size, 0);
    f.advance('2026-11-22T08:00:00+09:00');
    f.visibility('visible'); assert.equal(f.controller.get().active, 'morning');
    assert.equal(f.timers.size, 1);
    f.controller.setPack(alternate()); f.controller.set('night');
    assert.equal(f.timers.size, 0);
    f.controller.setPage('records');
    assert.equal(f.controller.get().active, 'night');
    f.advance('2026-11-22T13:00:00+09:00'); f.view.dispatch('pageshow');
    assert.equal(f.controller.get().active, 'night');
    f.controller.set('auto');
    assert.equal(f.controller.get().active, 'day');
    assert.equal(f.timers.size, 1);
  } finally { f.controller.destroy(); }
});

test('mode and page changes notify the UI even when their visible palette remains the same', () => {
  const f = fixture();
  try {
    const initial = f.changes.length;
    f.controller.set('morning');
    assert.equal(f.changes.length, initial + 1);
    assert.equal(f.changes.at(-1).mode, 'morning');
    f.controller.setPage('records');
    assert.equal(f.changes.length, initial + 2);
    assert.equal(f.changes.at(-1).page, 'records');
    const count = f.changes.length;
    f.controller.refresh(); f.controller.setPage('records');
    assert.equal(f.changes.length, count);
    const copy = f.controller.get(); copy.tokens.paper = '#ff0000'; copy.mode = 'invalid';
    f.changes.at(-1).tokens.paper = '#00ff00';
    assert.equal(f.controller.get().tokens.paper, '#FAF3E8');
    assert.equal(f.controller.get().mode, 'morning');
  } finally { f.controller.destroy(); }
});

test('storage events update only theme preferences across tabs and do not persist the viewing page', () => {
  const f = fixture();
  try {
    f.controller.setPage('english');
    assert.equal(f.writes.length, 0);
    f.stored(THEME_STORAGE_KEY, JSON.stringify({ pack: alternate(), mode: 'night' }));
    assert.equal(f.controller.get().pack, alternate());
    assert.equal(f.controller.get().mode, 'night');
    assert.equal(f.controller.get().page, 'english');
    assert.equal(f.writes.length, 0);
    f.stored('mypace.theme.v1', 'morning');
    assert.equal(f.controller.get().mode, 'night');
    f.stored('mypace.studio.v1', 'different activities');
    assert.equal(f.controller.get().mode, 'night');
    f.stored(THEME_STORAGE_KEY, null);
    assert.equal(f.controller.get().pack, DEFAULT_THEME_PACK);
    assert.equal(f.controller.get().mode, 'morning');
  } finally { f.controller.destroy(); }
});

test('unavailable or malformed storage still supports this-window selection and is never rewritten on startup', () => {
  const f = fixture({ [THEME_STORAGE_KEY]: 'invalid json', 'mypace.theme.v1': 'day' });
  try {
    assert.equal(f.controller.get().mode, 'day');
    assert.equal(f.writes.length, 0);
    f.storage.setItem = () => { throw new Error('quota'); };
    assert.equal(f.controller.setPack(alternate()), false);
    assert.equal(f.controller.get().pack, alternate());
    assert.equal(f.controller.set('night'), false);
    assert.equal(f.controller.get().active, 'night');
    f.storage.getItem = () => { throw new Error('blocked'); };
    f.view.dispatch('storage', { key: THEME_STORAGE_KEY });
    assert.equal(f.controller.get().mode, 'night');
  } finally { f.controller.destroy(); }
});

test('destroy removes clock and event listeners and no subsequent event changes the applied theme', () => {
  const f = fixture();
  const before = f.controller.get(), count = f.changes.length;
  f.controller.destroy();
  assert.equal(f.timers.size, 0);
  for (const source of [f.document, f.view]) for (const listeners of source.listeners.values()) assert.equal(listeners.size, 0);
  f.advance('2026-11-21T23:00:00+09:00'); f.view.dispatch('pageshow'); f.visibility('visible'); f.tick();
  assert.equal(f.controller.set('night'), false); assert.equal(f.controller.setPack(alternate()), false);
  f.controller.setPage('english'); f.controller.refresh();
  assert.deepEqual(f.controller.get(), before);
  assert.equal(f.changes.length, count);
});


test('pack definitions also support static colors and page-only colors without a clock dependency', () => {
  const definition = { id: 'page-only', timeAware: false, pageAware: true,
    base: { scheme: 'light', tokens: { paper: '#fff7ef' } },
    pages: { english: { base: { scheme: 'dark', tokens: { paper: '#201b30', ink: '#f6efff' } } } },
  };
  for (const mode of ['auto', 'morning', 'day', 'night']) {
    const state = resolveThemePack(definition, { mode, page: 'english', date: new Date('2026-11-21T08:00:00+09:00') });
    assert.equal(state.mode, mode);
    assert.equal(state.active, 'day');
    assert.equal(state.scheme, 'dark');
    assert.equal(state.tokens.paper, '#201b30');
    assert.equal(state.tokens.ink, '#f6efff');
    assert.ok(state.tokens.surface, 'unspecified roles inherit a complete base');
  }
  const unknown = resolveThemePack(definition, { page: 'future-category' });
  assert.equal(unknown.tokens.paper, '#fff7ef');
  assert.equal(unknown.scheme, 'light');
  const uniform = resolveThemePack({ ...definition, pageAware: false }, { page: 'english', mode: 'night' });
  assert.equal(uniform.tokens.paper, '#fff7ef');
  assert.equal(uniform.scheme, 'light');
});

test('all shipped palettes preserve readable text and primary-button contrast on every page and period', () => {
  const luminance = hex => {
    const channels = hex.slice(1).match(/.{2}/g).map(pair => parseInt(pair, 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  for (const pack of THEME_PACKS) for (const page of ['home', 'records', 'english']) for (const mode of ['morning', 'day', 'night']) {
    const { tokens } = resolveTheme({ pack: pack.id, page, mode });
    for (const surface of ['paper', 'surface']) for (const text of ['ink', 'muted']) {
      assert.ok(contrast(tokens[text], tokens[surface]) >= 4.5, `${pack.id}/${page}/${mode}: ${text} on ${surface}`);
    }
    assert.ok(contrast(tokens['on-primary'], tokens.primary) >= 4.5, `${pack.id}/${page}/${mode}: primary button`);
    assert.ok(contrast(tokens['header-ink'], tokens.header) >= 4.5, `${pack.id}/${page}/${mode}: header`);
  }
});
