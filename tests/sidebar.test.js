/** Lightweight DOM doubles exercise the controller; these are not browser/layout tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createSidebarController, SIDEBAR_STORAGE_KEY, SIDEBAR_MEDIA_QUERY} from '../src/lib/sidebar.js';
import {STORAGE_KEY} from '../src/lib/storage.js';

class Events {
  handlers = new Map();
  addEventListener(type, handler) { this.handlers.set(type, [...this.handlers.get(type) || [], handler]); }
  emit(type, event = {}) { for (const handler of this.handlers.get(type) || []) handler(event); }
}
class Node {
  constructor(document, name) {
    this.document = document; this.name = name; this.hidden = false; this.inert = false;
    this.isConnected = true; this.attributes = new Map(); this.children = []; this.dataset = {};
    this.innerHTML = ''; this.value = '';
  }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  focus() { this.document.activeElement = this; }
  querySelector(selector) { return selector === '[aria-current="page"]' ? this.children.find(child => child.current) : null; }
  querySelectorAll() { return this.children; }
}
function launch({mobile = false, preference = null, denyRead = false, denyWrite = false} = {}) {
  const document = new Events(), window = new Events(), media = new Events();
  media.matches = mobile;
  window.matchMedia = query => { assert.equal(query, SIDEBAR_MEDIA_QUERY); return media; };
  const make = name => new Node(document, name), panel = make('sidebar'), toggle = make('toggle'), backdrop = make('backdrop');
  const workspace = make('workspace'), notice = make('notice'), skip = make('skip'), main = make('main'), editor = make('editor');
  const close = make('close'), brand = make('brand'), current = make('current-link'), last = make('last-link');
  current.current = true; panel.children = [close, brand, current, last]; editor.open = false;
  const draft = make('draft'); draft.value = '編集中のメモ'; workspace.children = [toggle, main]; main.children = [draft];
  const classes = new Set();
  document.body = {classList:{toggle(name, on) { on ? classes.add(name) : classes.delete(name); }}};
  document.querySelector = selector => ({'#app-sidebar':panel, '#sidebar-toggle':toggle, '#sidebar-backdrop':backdrop,
    '.workspace':workspace, '#notice':notice, '.skip-link':skip, '#main':main}[selector] ?? null);
  const record = '{"version":1,"private":"keep this untouched"}', values = new Map([[STORAGE_KEY, record]]), writes = [];
  if (preference !== null) values.set(SIDEBAR_STORAGE_KEY, preference);
  const storage = {
    getItem(key) { if (denyRead) throw Error('blocked'); return values.get(key) ?? null; },
    setItem(key, value) { if (denyWrite) throw Error('quota'); writes.push([key, value]); values.set(key, value); }
  };
  const controller = createSidebarController({document, window, editor, storage:() => storage});
  controller.sync(); toggle.focus();
  const click = (kind, extra = {}) => {
    const event = {preventDefault() { this.defaultPrevented = true; }, ...extra};
    const control = {dataset:{sidebar:kind}};
    event.target = {closest:selector => selector === '[data-sidebar]' ? control : null};
    document.emit('click', event); return event;
  };
  const link = (extra = {}) => {
    const event = {target:{closest:selector => selector === '#app-sidebar a[href^="#"]' ? current : null}, ...extra};
    document.emit('click', event); return event;
  };
  const key = (key, shiftKey = false) => {
    const event = {key, shiftKey, preventDefault() { this.defaultPrevented = true; }};
    document.emit('keydown', event); return event;
  };
  const resize = matches => { media.matches = matches; media.emit('change', {matches}); };
  return {controller, document, window, panel, toggle, backdrop, workspace, notice, skip, main, editor, close, brand,
    current, last, draft, values, writes, record, classes, click, link, key, resize};
}

test('desktop closes completely and persists only its separate preference', () => {
  const ui = launch();
  assert.equal(ui.panel.hidden, false); assert.equal(ui.toggle.getAttribute('aria-expanded'), 'true');
  ui.current.focus(); ui.click('close');
  assert.equal(ui.panel.hidden, true); assert.equal(ui.panel.inert, true);
  assert.equal(ui.document.activeElement, ui.toggle); assert.ok(ui.classes.has('sidebar-collapsed'));
  assert.equal(ui.toggle.getAttribute('aria-label'), 'メニューを開く');
  assert.deepEqual(ui.writes, [[SIDEBAR_STORAGE_KEY, '1']]); assert.equal(ui.values.get(STORAGE_KEY), ui.record);
  ui.click('toggle'); assert.equal(ui.panel.hidden, false); assert.equal(ui.values.get(SIDEBAR_STORAGE_KEY), '0');
  assert.equal(ui.draft.value, '編集中のメモ'); assert.equal(ui.main.children[0], ui.draft);
});

test('desktop reload restores its preference, invalid values fail open', () => {
  assert.equal(launch({preference:'1'}).panel.hidden, true);
  assert.equal(launch({preference:'0'}).panel.hidden, false);
  assert.equal(launch({preference:'nonsense'}).panel.hidden, false);
});

test('mobile starts closed regardless of desktop preference and opens a modal drawer', () => {
  for (const preference of ['0','1',null]) {
    const ui = launch({mobile:true, preference});
    assert.equal(ui.panel.hidden, true); assert.equal(ui.backdrop.hidden, true);
    ui.click('toggle'); assert.equal(ui.panel.hidden, false); assert.equal(ui.backdrop.hidden, false);
    assert.equal(ui.panel.getAttribute('role'), 'dialog'); assert.equal(ui.panel.getAttribute('aria-modal'), 'true');
    assert.equal(ui.workspace.inert, true); assert.equal(ui.notice.inert, true); assert.equal(ui.skip.inert, true);
    assert.ok(ui.classes.has('sidebar-drawer-open')); assert.equal(ui.document.activeElement, ui.current);
    assert.deepEqual(ui.writes, []);
  }
});

test('backdrop/close/Escape restore focus and release inert background and scroll lock', () => {
  for (const action of ['backdrop','close','escape']) {
    const ui = launch({mobile:true}); ui.click('toggle');
    if (action === 'escape') assert.equal(ui.key('Escape').defaultPrevented, true);
    else ui.click('close');
    assert.equal(ui.panel.hidden, true); assert.equal(ui.backdrop.hidden, true);
    assert.equal(ui.workspace.inert, false); assert.equal(ui.notice.inert, false); assert.equal(ui.skip.inert, false);
    assert.equal(ui.panel.getAttribute('aria-modal'), null); assert.ok(!ui.classes.has('sidebar-drawer-open'));
    assert.equal(ui.document.activeElement, ui.toggle); assert.deepEqual(ui.writes, []);
  }
});

test('Tab/Shift-Tab wrap at drawer edges; stray focus returns inside', () => {
  const ui = launch({mobile:true}); ui.click('toggle');
  ui.last.focus(); assert.equal(ui.key('Tab').defaultPrevented, true); assert.equal(ui.document.activeElement, ui.close);
  assert.equal(ui.key('Tab',true).defaultPrevented, true); assert.equal(ui.document.activeElement, ui.last);
  ui.current.focus(); assert.equal(ui.key('Tab').defaultPrevented, undefined);
  ui.main.focus(); ui.document.emit('focusin'); assert.equal(ui.document.activeElement, ui.current);
  ui.main.focus(); ui.key('Tab'); assert.equal(ui.document.activeElement, ui.close);
});

test('page selection including current page closes mobile drawer and focuses main', () => {
  const ui = launch({mobile:true}); ui.click('toggle'); ui.link();
  assert.equal(ui.panel.hidden, true); assert.equal(ui.document.activeElement, ui.main);
  assert.deepEqual(ui.writes, []);
  ui.click('toggle'); ui.link({ctrlKey:true}); assert.equal(ui.panel.hidden, false);
  ui.link({defaultPrevented:true}); assert.equal(ui.panel.hidden, false);
  ui.window.emit('hashchange'); assert.equal(ui.panel.hidden, true); assert.equal(ui.document.activeElement, ui.main);
  ui.window.emit('hashchange'); assert.equal(ui.panel.hidden, true);
});

test('desktop navigation and Escape do not collapse the persistent sidebar', () => {
  const ui = launch(); ui.link(); ui.window.emit('hashchange'); ui.key('Escape');
  assert.equal(ui.panel.hidden, false); assert.deepEqual(ui.writes, []);
});

test('breakpoint crossings close mobile and restore desktop preference without data edits', () => {
  for (const preference of ['0','1']) {
    const ui = launch({preference}); ui.resize(true); assert.equal(ui.panel.hidden, true);
    ui.click('toggle'); ui.current.focus(); ui.resize(false);
    assert.equal(ui.panel.hidden, preference === '1'); assert.equal(ui.backdrop.hidden, true);
    assert.equal(ui.workspace.inert, false); assert.ok(!ui.classes.has('sidebar-drawer-open'));
    if (preference === '1') assert.equal(ui.document.activeElement, ui.toggle);
    ui.current.focus(); ui.resize(true); assert.equal(ui.panel.hidden, true); assert.equal(ui.document.activeElement, ui.toggle);
    assert.equal(ui.draft.value, '編集中のメモ'); assert.deepEqual(ui.writes, []);
  }
});

test('native editor keeps priority for Escape/Tab/toggle, preserving its unsaved draft', () => {
  const ui = launch({mobile:true}); ui.click('toggle'); ui.editor.open = true; ui.editor.value = '未保存'; ui.editor.focus();
  assert.equal(ui.key('Escape').defaultPrevented, undefined); assert.equal(ui.key('Tab').defaultPrevented, undefined);
  ui.click('close'); ui.click('toggle'); ui.document.emit('focusin');
  assert.equal(ui.panel.hidden, false); assert.equal(ui.document.activeElement, ui.editor); assert.equal(ui.editor.value, '未保存');
  ui.resize(false); ui.resize(true); assert.equal(ui.document.activeElement, ui.editor); assert.equal(ui.editor.open, true);
  ui.editor.open = false; ui.click('toggle'); ui.key('Escape'); assert.equal(ui.panel.hidden, true);
});

test('rapid repeated toggles have no queued transition and do not replace forms', () => {
  const ui = launch({mobile:true}), main = ui.main, draft = ui.draft;
  for (let i = 0; i < 101; i++) ui.click('toggle');
  assert.equal(ui.panel.hidden, false); assert.equal(ui.workspace.inert, true);
  ui.click('toggle'); assert.equal(ui.panel.hidden, true); assert.equal(ui.workspace.inert, false);
  assert.equal(ui.main, main); assert.equal(ui.main.children[0], draft); assert.equal(draft.value, '編集中のメモ');
  assert.equal(ui.values.get(STORAGE_KEY), ui.record); assert.deepEqual(ui.writes, []);
});

test('blocked storage still allows toggles without touching application records', () => {
  for (const options of [{denyRead:true}, {denyWrite:true}]) {
    const ui = launch(options); ui.click('toggle'); assert.equal(ui.panel.hidden, true);
    ui.click('toggle'); assert.equal(ui.panel.hidden, false); assert.equal(ui.values.get(STORAGE_KEY), ui.record);
  }
});

test('preference events sync desktop; mobile stays independent and record events are ignored', () => {
  const ui = launch(); ui.current.focus(); ui.values.set(SIDEBAR_STORAGE_KEY, '1');
  ui.window.emit('storage',{key:SIDEBAR_STORAGE_KEY}); assert.equal(ui.panel.hidden, true); assert.equal(ui.document.activeElement, ui.toggle);
  ui.resize(true); ui.click('toggle'); ui.values.set(SIDEBAR_STORAGE_KEY, '0');
  ui.window.emit('storage',{key:SIDEBAR_STORAGE_KEY}); assert.equal(ui.panel.hidden, false);
  ui.window.emit('storage',{key:STORAGE_KEY}); assert.equal(ui.panel.hidden, false);
  ui.resize(false); assert.equal(ui.panel.hidden, false);
  ui.values.delete(SIDEBAR_STORAGE_KEY); ui.window.emit('storage',{key:null}); assert.equal(ui.panel.hidden, false);
});

test('render sync reattaches state without rendering content or writing records', () => {
  const ui = launch({mobile:true}); ui.click('toggle');
  for (let i = 0; i < 10; i++) ui.controller.sync();
  assert.equal(ui.panel.hidden, false); assert.equal(ui.draft.value, '編集中のメモ'); assert.deepEqual(ui.writes, []);
});

test('source contracts retain brand nowrap/data key and remove old mobile bottom bar', async () => {
  const [app, css, controller] = await Promise.all(['src/app.js','src/style.css','src/lib/sidebar.js'].map(file => fs.readFile(file,'utf8')));
  assert.match(app, /aria-controls="app-sidebar"/); assert.match(app, /sidebar\.sync\(\)/);
  assert.match(css, /my-pace: brand-nowrap-v1/); assert.match(css, /\.sidebar-collapsed \.workspace \{ margin-left:0; \}/);
  assert.match(css, /\.sidebar-collapsed main \{ max-width:none; \}/);
  assert.match(css, /\[hidden\]\s*\{\s*display:none!important/);
  assert.doesNotMatch(css, /inset:auto 0 0|repeat\(5,1fr\)|padding-bottom:calc\(69px/);
  assert.doesNotMatch(controller, /innerHTML|replaceChildren|STORAGE_KEY\s*from|rhythm\.personal/);
  assert.equal(STORAGE_KEY, 'rhythm.personal.v1');
});


test('dismissal restores the live opener even when pointer activation left body focused', () => {
  const ui = launch({mobile:true}); ui.document.activeElement = ui.document.body;
  ui.click('toggle'); ui.key('Escape'); assert.equal(ui.document.activeElement, ui.toggle);
});

test('sync restores focus after drawer DOM replacement, but never steals editor focus', () => {
  const ui = launch({mobile:true}); ui.click('toggle'); ui.document.activeElement = ui.document.body;
  ui.controller.sync(); assert.equal(ui.document.activeElement, ui.current);
  ui.editor.open = true; ui.editor.focus(); ui.controller.sync(); assert.equal(ui.document.activeElement, ui.editor);
});
