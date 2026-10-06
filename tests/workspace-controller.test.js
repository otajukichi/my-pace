/**
 * Workspace controller integration tests execute src/app.js with a minimal DOM/event double.
 * These verify controller state, durable writes, routes, and editor interruption rules.
 * They do NOT verify browser layout, scrolling, native validity, focus traps, file pickers,
 * native hash timing, keyboard interaction, or accessibility in a real browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState, serializeBackup, todayKey, addDays} from '../src/lib/domain.js';
import {STORAGE_KEY} from '../src/lib/storage.js';
import {deriveGarden} from '../src/lib/garden.js';
import {pageCapacity} from '../src/lib/workspace.js';

let instance = 0;
class EventNode {
  constructor() { this.dataset={}; this.handlers = new Map(); this._innerHTML = ''; this.htmlWrites = 0; this.hidden = true; this.open = false; this.fields = new Map(); this.focused = false; this.focusCalls = 0; this.attributes = new Map(); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) { this._innerHTML = value; this.htmlWrites++; this.fields.clear(); }
  addEventListener(type, handler) { this.handlers.set(type, [...(this.handlers.get(type) || []), handler]); }
  async emit(type, event = {}) { for (const handler of this.handlers.get(type) || []) await handler(event); }
  showModal() { this.open = true; }
  close() { if (this.open) { this.open = false; for (const handler of this.handlers.get('close') || []) handler({}); } }
  focus() { this.focused = true; this.focusCalls++; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  contains(node) { return node === this; }
  querySelector(selector) { if (!this.fields.has(selector)) this.fields.set(selector, new EventNode()); return this.fields.get(selector); }
  click() { this.clicked = true; }
}
const LEGACY_SIDEBAR_KEY = 'my-pace.ui.sidebar-collapsed.v1';
async function launch(t, {initial = createInitialState(), raw: initialRaw, hash = '#calendar', width = 1280, height = 900, legacySidebar = 'true'} = {}) {
  const originals = new Map(), app = new EventNode(), editor = new EventNode(), notice = new EventNode(), main = new EventNode();
  const document = new EventNode(), window = new EventNode(), created = [], location = {hash};
  window.innerWidth = width; window.innerHeight = height;
  let raw = initialRaw === undefined ? serializeBackup(initial) : initialRaw, writes = 0, deniedWrite = false, disposed = false;
  document.documentElement = {dataset: {}};
  document.querySelector = selector => ({'#app':app, '#editor':editor, '#notice':notice, main}[selector] || null);
  document.createElement = tag => { const node = new EventNode(); node.tag = tag; created.push(node); return node; };
  const storageAccess = [], preferences = new Map([[LEGACY_SIDEBAR_KEY, legacySidebar]]);
  const localStorage = {
    getItem(key) { storageAccess.push({method:'getItem', key}); return key === STORAGE_KEY ? raw : preferences.get(key) ?? null; },
    setItem(key, value) { storageAccess.push({method:'setItem', key}); assert.equal(key, STORAGE_KEY); if (deniedWrite) throw new Error('Quota exceeded'); raw = value; writes++; },
    removeItem(key) { storageAccess.push({method:'removeItem', key}); preferences.delete(key); },
  };
  const FormData = class { constructor(form) { this.values = form.values; } get(key) { return this.values[key] ?? null; } };
  for (const [key, value] of Object.entries({document, window, location, localStorage, FormData, requestAnimationFrame:callback => callback()})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value, writable:true, configurable:true});
  }
  const dispose = () => { if (disposed) return; disposed = true; for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } };
  t.after(dispose);
  await import(`../src/app.js?workspace-controller-test=${instance++}`);
  const click = async (action, data = {}, disabled = false) => {
    const beforeHash = location.hash, button = {dataset:{action, ...data}, disabled};
    await document.emit('click', {target:{closest:selector => selector === '[data-action]' ? button : null}, preventDefault(){}});
    // Native browsers dispatch hashchange after a controller assigns location.hash.
    // The double performs that dispatch explicitly, without claiming native browser coverage.
    if (location.hash !== beforeHash) await window.emit('hashchange');
  };
  const form = (type, values, valid = true) => ({dataset:{form:type}, values, closest(){return this;}, reportValidity(){return valid;}});
  const submitForm = form => editor.emit('submit', {target:form, preventDefault(){}});
  const submit = (type, values, valid = true) => submitForm(form(type, values, valid));
  const changeDate = value => document.emit('change', {target:{id:'selected-date', value}});
  const changeHash = async value => { location.hash = value; await window.emit('hashchange'); };
  const routeLink = route => {
    const rendered = headerLinks(app.innerHTML).find(link => link.attributes['data-route'] === route);
    assert.ok(rendered, `header contains the ${route} link`);
    const link = new EventNode();
    for (const [key, value] of Object.entries(rendered.attributes)) link.setAttribute(key, value);
    link.dataset.route = route;
    link.closest = selector => ['#page-navigation .page-link', 'a[href^="#"]', '.page-link'].includes(selector) ? link : null;
    return link;
  };
  const clickRoute = async route => {
    const link = routeLink(route), event = {target:link, button:0, defaultPrevented:false, preventDefault(){this.defaultPrevented = true;}};
    await document.emit('click', event);
    // Model the anchor's default action and changed-hash event explicitly. This is not
    // a browser click/history implementation; it detects interception by app handlers.
    if (!event.defaultPrevented && location.hash !== link.getAttribute('href')) await changeHash(link.getAttribute('href'));
    return event;
  };
  const selectFile = async file => { const input = created.filter(node => node.type === 'file').at(-1); assert.ok(input, 'a file input was created'); input.files = [file]; await input.emit('change'); };
  const resize = async (width, height) => { window.innerWidth = width; window.innerHeight = height; await window.emit('resize'); };
  return {app, editor, notice, main, document, window, location, click, routeLink, clickRoute, form, submit, submitForm, changeDate, changeHash, selectFile, resize, dispose, storageAccess, preferences,
    state:() => JSON.parse(raw), setRaw:value => {raw = value;}, denyWrite:value => {deniedWrite = value;}, get raw(){return raw;}, get writes(){return writes;}};
}
const valuesForEvent = (date = todayKey(), patch = {}) => ({date, time:'09:30', title:'散歩の約束', note:'公園で会う', ...patch});
const eventRecord = (id, date, patch = {}) => ({id, date, time:null, title:`予定 ${id}`, note:'', ...patch});
const selectedDate = ui => /id="selected-date"[^>]*value="([^"]+)"/.exec(ui.app.innerHTML)?.[1];
const calendarMonth = ui => /aria-label="(\d{4})年(\d+)月の日付"/.exec(ui.app.innerHTML)?.slice(1).map((part, index) => index ? part.padStart(2, '0') : part).join('-');
const currentTab = (ui, tab) => new RegExp(`data-action="view-tab" data-tab="${tab}" aria-pressed="true"`).test(ui.app.innerHTML);
const ROUTES = [
  ['home', 'ホーム'], ['running', 'ランニング'], ['wake', '早起き'], ['habits', '習慣'],
  ['calendar', 'カレンダー'], ['diary', '日記'], ['garden', '暮らしの庭'], ['settings', '設定'],
];
const attributesOf = markup => Object.fromEntries([...markup.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, value ?? '']));
function headerLinks(markup) {
  const header = /<header\b[^>]*class="topbar"[^>]*>([\s\S]*?)<\/header>/.exec(markup)?.[1];
  assert.ok(header, 'the page header exists');
  const nav = /<nav\b([^>]*\bid="page-navigation"[^>]*)>([\s\S]*?)<\/nav>/.exec(header);
  assert.ok(nav, 'the one main page navigation is inside the header');
  assert.equal(attributesOf(nav[1]).class, 'page-navigation');
  assert.equal(attributesOf(nav[1])['aria-label'], 'メインナビゲーション');
  assert.equal((markup.match(/id="page-navigation"/g) || []).length, 1);
  return [...nav[2].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, body]) => ({attributes:attributesOf(attributes), body}));
}
function assertHeaderNavigation(ui, current) {
  const links = headerLinks(ui.app.innerHTML);
  assert.deepEqual(links.map(link => link.attributes['data-route']), ROUTES.map(([route]) => route));
  assert.equal(links.filter(link => link.attributes['aria-current'] === 'page').length, 1);
  for (const [index, [route, label]] of ROUTES.entries()) {
    const {attributes, body} = links[index];
    assert.equal(attributes.class, 'page-link');
    assert.equal(attributes.href, `#${route}`);
    assert.equal(attributes['aria-label'], label);
    assert.equal(attributes['aria-current'], route === current ? 'page' : undefined);
    for (const attribute of ['tabindex', 'role', 'hidden', 'inert', 'aria-disabled', 'data-action']) assert.equal(attributes[attribute], undefined);
    assert.match(body, /<svg\b[^>]*aria-hidden="true"/);
    assert.match(body, /<span class="page-current" aria-hidden="true"><\/span>/);
    assert.match(body, new RegExp(`<span class="page-tooltip" role="tooltip" aria-hidden="true">${label}<\\/span>`));
    const textOutsideTooltip = body.replace(/<span class="page-tooltip"[^>]*>[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '').trim();
    assert.equal(textOutsideTooltip, '', 'route names are not rendered as permanent link text');
  }
  assert.doesNotMatch(ui.app.innerHTML, /<aside\b|app-sidebar|sidebar-toggle|sidebar-backdrop|data-sidebar|desktop-breadcrumb|mobile-brand/);
}

test('header markup keeps all eight ordinary links and their order at every tested viewport', async t => {
  const ui = await launch(t, {hash:'#wake'});
  assertHeaderNavigation(ui, 'wake');
  for (const [width, height] of [[1440, 1080], [768, 900], [375, 667], [320, 568]]) {
    await ui.resize(width, height);
    for (const [route, label] of ROUTES) {
      assert.equal((await ui.clickRoute(route)).defaultPrevented, false);
      assertHeaderNavigation(ui, route);
      assert.equal(ui.document.title, `${label} · マイペース`);
      assert.equal(ui.document.documentElement.dataset.page, route);
    }
  }
  await ui.changeHash('#unknown-page'); assertHeaderNavigation(ui, 'home');
  await ui.changeHash(''); assertHeaderNavigation(ui, 'home');
  assert.equal(ui.writes, 0);
});

test('repeated current-route anchor clicks do not rerender or discard calendar and diary drafts', async t => {
  const ui = await launch(t), before = ui.raw;
  for (const [route, action, field, value] of [
    ['calendar', 'event-add', 'title', 'まだ保存していない予定'],
    ['diary', 'diary-edit', 'text', 'まだ保存していない日記 🌷'],
  ]) {
    await ui.changeHash(`#${route}`); await ui.click(action);
    const input = ui.editor.querySelector(`[name="${field}"]`); input.value = value;
    const renders = ui.app.htmlWrites, editorRenders = ui.editor.htmlWrites, focusCalls = ui.main.focusCalls;
    for (let repeat = 0; repeat < 4; repeat++) {
      const event = await ui.clickRoute(route);
      assert.equal(event.defaultPrevented, false, 'page anchors keep their native default action');
    }
    assert.equal(ui.app.htmlWrites, renders); assert.equal(ui.editor.htmlWrites, editorRenders);
    assert.equal(ui.editor.open, true); assert.equal(ui.editor.querySelector(`[name="${field}"]`), input);
    assert.equal(input.value, value); assert.equal(ui.main.focusCalls, focusCalls);
    assert.equal(ui.raw, before); assert.equal(ui.writes, 0);
    await ui.click('dialog-close');
  }
});

test('explicit Back/Forward hash events restore route tabs, close stale editors, and focus main without saving', async t => {
  const date = addDays(todayKey(), -2), ui = await launch(t), before = ui.raw;
  await ui.changeDate(date); await ui.click('view-tab', {tab:'agenda'});
  await ui.clickRoute('diary'); await ui.click('view-tab', {tab:'history'});
  await ui.clickRoute('running'); await ui.click('view-tab', {tab:'trends'});
  // These are explicit URL/hashchange controller inputs standing in for Back/Forward.
  // No browser history stack, native timing, or browser focus behavior is asserted.
  for (const [route, tab] of [['diary','history'], ['calendar','agenda'], ['diary','history'], ['running','trends']]) {
    const source = ui.location.hash.slice(1);
    const [action, type, values] = {
      running:['run-add', 'run', {id:'', date, distance:'5', minutes:'30', seconds:'0', note:'保存しないラン'}],
      calendar:['event-add', 'event', valuesForEvent(date)],
      diary:['diary-edit', 'diary', {text:'保存しない古いフォーム', mood:'calm'}],
    }[source];
    await ui.click(action);
    const stale = ui.form(type, values), focusCalls = ui.main.focusCalls;
    await ui.changeHash(`#${route}`);
    assertHeaderNavigation(ui, route); assert.equal(currentTab(ui, tab), true);
    assert.equal(ui.editor.open, false); assert.ok(ui.main.focusCalls > focusCalls);
    assert.equal(selectedDate(ui), date);
    await ui.submitForm(stale); await ui.click('dialog-close');
    assert.equal(ui.raw, before); assert.equal(ui.writes, 0);
  }
});

test('top navigation never reads, writes, removes, or reacts to the obsolete sidebar preference', async t => {
  const ui = await launch(t, {hash:'#home', legacySidebar:'true'}), before = ui.raw;
  assert.equal(STORAGE_KEY, 'rhythm.personal.v1');
  for (const [route] of ROUTES) await ui.clickRoute(route);
  await ui.resize(320, 568); await ui.resize(1440, 1080);
  const renders = ui.app.htmlWrites, reads = ui.storageAccess.length;
  await ui.window.emit('storage', {key:LEGACY_SIDEBAR_KEY, oldValue:'true', newValue:'false'});
  assert.equal(ui.app.htmlWrites, renders); assert.equal(ui.storageAccess.length, reads);
  assert.equal(ui.raw, before); assert.equal(ui.writes, 0);
  await ui.clickRoute('wake'); await ui.click('wake-edit'); await ui.submit('wake', {time:'06:25'});
  assert.equal(ui.state().wake[todayKey()], '06:25'); assert.equal(ui.writes, 1);
  assert.equal(ui.preferences.get(LEGACY_SIDEBAR_KEY), 'true');
  // The second read protects a stale editor before the cross-tab storage event arrives.
  assert.deepEqual(ui.storageAccess, [{method:'getItem', key:STORAGE_KEY}, {method:'getItem', key:STORAGE_KEY}, {method:'setItem', key:STORAGE_KEY}]);
});

test('navigation keyboard and tooltip events leave native keys, drafts, routes, and record storage alone', async t => {
  const ui = await launch(t, {hash:'#diary'}); await ui.click('diary-edit');
  const input = ui.editor.querySelector('[name="text"]'); input.value = '書きかけ';
  const link = ui.routeLink('diary'), renders = ui.app.htmlWrites, editorRenders = ui.editor.htmlWrites;
  for (const key of ['Tab', 'Enter', 'ArrowLeft', 'ArrowRight', 'Escape']) {
    const event = {key, target:link, defaultPrevented:false, preventDefault(){this.defaultPrevented = true;}};
    await ui.document.emit('keydown', event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(link.getAttribute('data-tooltip-dismissed'), 'true');
  await ui.document.emit('pointerout', {target:link, relatedTarget:link});
  assert.equal(link.getAttribute('data-tooltip-dismissed'), 'true', 'moving inside a link keeps dismissal');
  await ui.document.emit('pointerout', {target:link, relatedTarget:null});
  assert.equal(link.getAttribute('data-tooltip-dismissed'), null);
  await ui.document.emit('keydown', {key:'Escape', target:link});
  await ui.document.emit('focusout', {target:link});
  assert.equal(link.getAttribute('data-tooltip-dismissed'), null);
  assert.equal(ui.location.hash, '#diary'); assert.equal(ui.app.htmlWrites, renders);
  assert.equal(ui.editor.htmlWrites, editorRenders); assert.equal(ui.editor.open, true);
  assert.equal(ui.editor.querySelector('[name="text"]'), input); assert.equal(input.value, '書きかけ');
  assert.equal(ui.writes, 0);
});

test('page palette follows direct entry, every route, invalid hashes and repeated renders without data writes',async t=>{
  const ui=await launch(t,{hash:'#wake'});
  assert.equal(ui.document.documentElement.dataset.page,'wake');
  for(const route of ['running','habits','home','calendar','diary','garden','settings','wake']){
    await ui.changeHash(`#${route}`);
    assert.equal(ui.document.documentElement.dataset.page,route);
  }
  await ui.changeHash('#not-a-page');
  assert.equal(ui.document.documentElement.dataset.page,'home');
  await ui.click('view-tab',{tab:'rhythm'});
  assert.equal(ui.document.documentElement.dataset.page,'home');
  assert.equal(ui.writes,0);
});

test('Home record dialogs use entity palettes; nested confirmation retains it and later dialogs reset it',async t=>{
  const ui=await launch(t,{hash:'#home'});
  for(const [action,theme] of [['wake-edit','wake'],['run-add','running'],['habit-add','habits'],['event-add','calendar'],['diary-edit','diary']]){
    await ui.click(action);
    assert.equal(ui.editor.dataset.theme,theme);
    assert.equal(ui.document.documentElement.dataset.page,'home');
    await ui.click('dialog-close');
  }
  await ui.click('run-add');
  await ui.submit('run',{id:'',date:todayKey(),distance:'5',minutes:'30',seconds:'0',note:''});
  assert.equal(ui.document.documentElement.dataset.page,'home');
  await ui.click('run-edit',{id:ui.state().runs[0].id});
  await ui.click('run-delete');
  assert.equal(ui.editor.dataset.theme,'running');
  await ui.click('dialog-close');
  await ui.click('wake-edit');
  assert.equal(ui.editor.dataset.theme,'wake');
  await ui.changeHash('#habits');
  assert.equal(ui.editor.open,false);
  assert.equal(ui.document.documentElement.dataset.page,'habits');
});

// Calendar events: actual delegated click/submit handlers and serialized storage.
test('calendar creates independent same-day and future events, edits one stable ID, and preserves escaped content', async t => {
  const ui = await launch(t), future = addDays(todayKey(), 40);
  await ui.click('event-add');
  await ui.submit('event', valuesForEvent(todayKey(), {title:'  <img src=x onerror=alert(1)> 🌷  ', note:'  一行目\n二行目  '}));
  const first = ui.state().events[0];
  assert.equal(first.title, '<img src=x onerror=alert(1)> 🌷'); assert.equal(first.note, '一行目\n二行目');
  assert.match(ui.app.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(ui.app.innerHTML, /<img src=x/);
  await ui.click('event-add'); await ui.submit('event', valuesForEvent(todayKey(), {time:'', title:'同じ日の別の予定'}));
  await ui.changeDate(future); await ui.click('event-add'); await ui.submit('event', valuesForEvent(future, {title:'未来の予定'}));
  assert.equal(ui.state().events.length, 3); assert.equal(ui.state().events[1].time, null);
  await ui.click('event-edit', {id:first.id}); await ui.submit('event', valuesForEvent(future, {title:'予定を移動した', time:'17:45'}));
  assert.equal(ui.state().events.length, 3);
  assert.deepEqual(ui.state().events.find(item => item.id === first.id), {...first, date:future, title:'予定を移動した', time:'17:45', note:'公園で会う'});
  assert.equal(ui.editor.open, false); assert.equal(ui.writes, 4);
});

test('event cancel, confirmed deletion, and durable single-level undo preserve other dates', async t => {
  const today = todayKey(), initial = {...createInitialState(), events:[eventRecord('one', today), eventRecord('two', addDays(today, 4))]}, ui = await launch(t, {initial});
  const before = ui.raw;
  await ui.click('event-add'); await ui.click('dialog-close'); assert.equal(ui.raw, before); assert.equal(ui.writes, 0);
  await ui.click('event-edit', {id:'one'}); await ui.click('event-delete');
  assert.match(ui.editor.innerHTML, /予定を削除/); assert.equal(ui.state().events.length, 2);
  await ui.click('dialog-close'); assert.equal(ui.raw, before);
  await ui.click('event-edit', {id:'one'}); await ui.click('event-delete'); await ui.click('event-delete-confirm');
  assert.deepEqual(ui.state().events.map(item => item.id), ['two']); assert.equal(ui.editor.open, false);
  await ui.click('undo'); assert.deepEqual(ui.state(), initial); assert.equal(ui.writes, 2);
  await ui.click('undo'); assert.equal(ui.writes, 2);
});

test('event invalid input and failed writes cannot overwrite durable state; retry saves once', async t => {
  const ui = await launch(t); await ui.click('event-add');
  for (const patch of [{title:'   '}, {date:'2026-02-30'}, {date:'2201-01-01'}, {time:'24:00'}, {title:'あ'.repeat(121)}]) {
    await ui.submit('event', valuesForEvent(todayKey(), patch)); assert.equal(ui.writes, 0); assert.equal(ui.editor.open, true);
  }
  await ui.submit('event', valuesForEvent(), false); assert.equal(ui.writes, 0);
  ui.denyWrite(true); await ui.submit('event', valuesForEvent()); assert.equal(ui.writes, 0); assert.equal(ui.editor.open, true);
  assert.match(ui.notice.innerHTML, /保存できませんでした/);
  ui.denyWrite(false); await ui.submit('event', valuesForEvent()); assert.equal(ui.state().events.length, 1); assert.equal(ui.writes, 1);
});

test('duplicate event submits, repeated confirmation, and disabled actions do not duplicate writes', async t => {
  const ui = await launch(t); await ui.click('event-add'); const form = ui.form('event', valuesForEvent());
  await Promise.all([ui.submitForm(form), ui.submitForm(form), ui.submitForm(form)]);
  assert.equal(ui.state().events.length, 1); assert.equal(ui.writes, 1);
  const id = ui.state().events[0].id;
  await ui.click('event-edit', {id}); await ui.click('event-delete');
  await Promise.all([ui.click('event-delete-confirm'), ui.click('event-delete-confirm')]);
  assert.equal(ui.state().events.length, 0); assert.equal(ui.writes, 2);
  await ui.click('event-add', {}, true); assert.equal(ui.editor.open, false); assert.equal(ui.writes, 2);
});

test('calendar diary action opens that date in the diary route, including a future date', async t => {
  const future = addDays(todayKey(), 45), ui = await launch(t, {initial:{...createInitialState(), diary:{[future]:{text:'未来のページ', mood:'calm'}}}});
  await ui.click('calendar-day', {date:future}); await ui.click('diary-day', {date:future});
  assert.equal(ui.location.hash, '#diary'); assert.match(ui.app.innerHTML, /<h1>日記<\/h1>/);
  assert.equal(selectedDate(ui), future); assert.equal(currentTab(ui, 'entry'), true); assert.match(ui.app.innerHTML, /未来のページ/);
});

test('calendar selected input, previous/next day, today, and month controls stay coherent at month boundaries', async t => {
  const ui = await launch(t);
  await ui.changeDate('2030-01-31'); assert.equal(calendarMonth(ui), '2030-01');
  await ui.click('next-day'); assert.equal(selectedDate(ui), '2030-02-01'); assert.equal(calendarMonth(ui), '2030-02');
  await ui.click('previous-day'); assert.equal(selectedDate(ui), '2030-01-31'); assert.equal(calendarMonth(ui), '2030-01');
  await ui.click('calendar-month', {offset:'1'}); assert.equal(calendarMonth(ui), '2030-02');
  assert.equal(selectedDate(ui), '2030-01-31', 'browsing the month does not silently select a different day');
  await ui.click('today'); assert.equal(selectedDate(ui), todayKey()); assert.equal(calendarMonth(ui), todayKey().slice(0, 7));
  await ui.click('calendar-month', {offset:'-1'}); await ui.click('calendar-today');
  assert.equal(calendarMonth(ui), todayKey().slice(0, 7)); assert.equal(ui.writes, 0);
});

test('calendar date boundaries and invalid navigation inputs do not escape supported dates', async t => {
  const ui = await launch(t);
  await ui.changeDate('1900-01-01'); await ui.click('previous-day'); await ui.click('calendar-month', {offset:'-1'});
  assert.equal(selectedDate(ui), '1900-01-01'); assert.equal(calendarMonth(ui), '1900-01');
  await ui.changeDate('2200-12-31'); await ui.click('next-day'); await ui.click('calendar-month', {offset:'1'});
  assert.equal(selectedDate(ui), '2200-12-31'); assert.equal(calendarMonth(ui), '2200-12');
  for (const date of ['2201-01-01', '1899-12-31', '2030-02-30', 'bad']) { await ui.changeDate(date); await ui.click('calendar-day', {date}); }
  await ui.click('calendar-month', {offset:'12'});
  assert.equal(selectedDate(ui), '2200-12-31'); assert.equal(calendarMonth(ui), '2200-12'); assert.equal(ui.writes, 0);
});

// Diary: one record per date, context-bound saves, deletion confirmation, and reload.
test('diary creates and updates one record per date, supports future dates, and saves the editor date', async t => {
  const today = todayKey(), future = addDays(today, 40), ui = await launch(t, {hash:'#diary'});
  await ui.click('diary-edit'); await ui.submit('diary', {text:'  一日目\n🌱  ', mood:'bright'});
  assert.deepEqual(ui.state().diary[today], {text:'一日目\n🌱', mood:'bright'});
  await ui.click('diary-edit'); await ui.submit('diary', {text:'追記した', mood:''});
  assert.equal(Object.keys(ui.state().diary).length, 1); assert.deepEqual(ui.state().diary[today], {text:'追記した', mood:null});
  await ui.changeDate(future); await ui.click('diary-edit');
  // Even an external date-control event cannot silently retarget the existing dialog.
  await ui.changeDate(today); await ui.submit('diary', {text:'未来の日の文章', mood:'calm'});
  assert.equal(ui.state().diary[future].text, '未来の日の文章'); assert.equal(ui.state().diary[today].text, '追記した');
});

test('diary cancel, deletion confirmation, undo, and reload preserve the full record and mood', async t => {
  const today = todayKey(), initial = {...createInitialState(), diary:{[today]:{text:'覚えておきたいこと\n二行目 🌷', mood:'calm'}}}, ui = await launch(t, {initial, hash:'#diary'});
  const before = ui.raw;
  await ui.click('diary-edit'); await ui.click('dialog-close'); assert.equal(ui.raw, before);
  await ui.click('diary-edit'); await ui.click('diary-delete'); assert.deepEqual(ui.state(), initial);
  await ui.click('dialog-close'); assert.equal(ui.raw, before);
  await ui.click('diary-edit'); await ui.click('diary-delete'); await ui.click('diary-delete-confirm');
  assert.deepEqual(ui.state().diary, {}); await ui.click('undo'); assert.deepEqual(ui.state(), initial);
  const saved = ui.raw; ui.dispose(); const reloaded = await launch(t, {raw:saved, hash:'#diary'});
  assert.deepEqual(reloaded.state(), initial); assert.match(reloaded.app.innerHTML, /覚えておきたいこと/); assert.match(reloaded.app.innerHTML, /mood-calm/); assert.equal(reloaded.writes, 0);
});

test('diary duplicate submits and invalid mood or excessive text cannot create extra records', async t => {
  const ui = await launch(t, {hash:'#diary'}); await ui.click('diary-edit');
  for (const values of [{text:'日記', mood:'unknown'}, {text:'あ'.repeat(8001), mood:'calm'}]) { await ui.submit('diary', values); assert.equal(ui.writes, 0); assert.equal(ui.editor.open, true); }
  const form = ui.form('diary', {text:'保存は一回', mood:'tired'}); await Promise.all([ui.submitForm(form), ui.submitForm(form)]);
  assert.equal(ui.writes, 1); assert.equal(Object.keys(ui.state().diary).length, 1);
  await ui.click('diary-edit'); await ui.click('diary-delete'); await ui.click('diary-delete-confirm'); await ui.click('diary-delete-confirm');
  assert.equal(ui.writes, 2); assert.deepEqual(ui.state().diary, {});
});

test('journal writes remain blocked with an unreadable original until explicitly restored', async t => {
  const raw = '{not-json', ui = await launch(t, {raw});
  await ui.click('event-add'); await ui.submit('event', valuesForEvent()); assert.equal(ui.raw, raw); assert.equal(ui.writes, 0); assert.equal(ui.editor.open, true);
  await ui.changeHash('#diary'); await ui.click('diary-edit'); await ui.submit('diary', {text:'書きかけ', mood:''});
  assert.equal(ui.raw, raw); assert.equal(ui.writes, 0); assert.match(ui.notice.innerHTML, /変更していません/);
});

// Garden: earned state is derived from records, preference writes are undoable.
test('locked garden choices and repeated current choices do nothing, while themes persist and undo', async t => {
  const ui = await launch(t, {hash:'#garden'}); await ui.click('view-tab', {tab:'collection'});
  for (const plant of ['sunflower', 'hydrangea', 'unknown', 'cosmos']) await ui.click('garden-plant', {plant});
  await ui.click('garden-theme', {theme:'unknown'}); await ui.click('garden-theme', {theme:'day'}); assert.equal(ui.writes, 0);
  await ui.click('garden-theme', {theme:'night'}); assert.equal(ui.state().garden.theme, 'night'); assert.equal(ui.writes, 1);
  await ui.click('garden-theme', {theme:'night'}); assert.equal(ui.writes, 1);
  await ui.click('undo'); assert.equal(ui.state().garden.theme, 'day'); assert.equal(ui.writes, 2);
  await ui.click('garden-theme', {theme:'dusk'}); const saved = ui.raw; ui.dispose();
  const reloaded = await launch(t, {raw:saved, hash:'#garden'}); await reloaded.click('view-tab', {tab:'collection'});
  assert.equal(reloaded.state().garden.theme, 'dusk'); assert.match(reloaded.app.innerHTML, /data-theme="dusk" aria-pressed="true"/); assert.equal(reloaded.writes, 0);
});

test('earned garden plants can be selected once, survive reload, and undo without changing rewards', async t => {
  const initial = createInitialState(); for (let day = 0; day < 21; day++) initial.wake[addDays(todayKey(), -day)] = '07:00';
  const ui = await launch(t, {initial, hash:'#garden'}); await ui.click('view-tab', {tab:'collection'});
  await ui.click('garden-plant', {plant:'sunflower'}); await ui.click('garden-plant', {plant:'sunflower'});
  assert.equal(ui.state().garden.plant, 'sunflower'); assert.equal(ui.writes, 1); assert.equal(deriveGarden(ui.state()).totalDays, 21);
  await ui.click('garden-plant', {plant:'hydrangea'}); assert.equal(ui.state().garden.plant, 'hydrangea');
  await ui.click('undo'); assert.equal(ui.state().garden.plant, 'sunflower'); assert.deepEqual(ui.state().wake, initial.wake);
  const saved = ui.raw; ui.dispose(); const reloaded = await launch(t, {raw:saved, hash:'#garden'});
  assert.equal(reloaded.state().garden.plant, 'sunflower'); assert.match(reloaded.app.innerHTML, /ひまわり/); assert.equal(deriveGarden(reloaded.state()).totalDays, 21);
});

test('removing the only earned record shrinks garden immediately and undo restores its growth', async t => {
  const initial = {...createInitialState(), wake:{[todayKey()]:'06:30'}}, ui = await launch(t, {initial, hash:'#wake'});
  await ui.click('wake-edit'); await ui.click('wake-delete'); await ui.changeHash('#garden');
  assert.equal(deriveGarden(ui.state()).totalDays, 0); assert.match(ui.app.innerHTML, /はじまりの種/);
  await ui.click('undo'); assert.equal(deriveGarden(ui.state()).totalDays, 1); assert.match(ui.app.innerHTML, /小さな芽/);
});

test('calendar and diary records never grant garden rewards, including repeated saves', async t => {
  const ui = await launch(t); await ui.click('event-add'); await ui.submit('event', valuesForEvent());
  await ui.changeHash('#diary'); await ui.click('diary-edit'); await ui.submit('diary', {text:'今日の日記', mood:'bright'});
  await ui.changeHash('#garden'); assert.equal(deriveGarden(ui.state()).totalDays, 0); assert.match(ui.app.innerHTML, /はじまりの種/);
});

// View state: pagination, navigation, future clamping, and interrupted editors.
test('route tabs and pages retain independent state and paginate every event after resize', async t => {
  const initial = {...createInitialState(), events:Array.from({length:10}, (_, i) => eventRecord(`event-${i}`, addDays(todayKey(), i)))}, ui = await launch(t, {initial, width:1280, height:680});
  const capacity = pageCapacity(1280, 680), largeCapacity = pageCapacity(1440, 1200);
  const hasRange = (start, end) => assert.ok(ui.app.innerHTML.includes(`${start}–${end} / 10`), `expected pagination range ${start}–${end} / 10`);
  await ui.click('view-tab', {tab:'agenda'}); assert.equal(currentTab(ui, 'agenda'), true); hasRange(1, capacity);
  await ui.click('view-page', {page:'1'}); hasRange(capacity + 1, Math.min(10, capacity * 2));
  await ui.changeHash('#diary'); await ui.click('view-tab', {tab:'history'}); await ui.changeHash('#calendar');
  assert.equal(currentTab(ui, 'agenda'), true); hasRange(capacity + 1, Math.min(10, capacity * 2));
  await ui.click('view-page', {page:'999'}); hasRange(Math.floor(9 / capacity) * capacity + 1, 10);
  await ui.resize(1440, 1200); hasRange(Math.floor(9 / largeCapacity) * largeCapacity + 1, 10);
  await ui.click('view-tab', {tab:'month'}); await ui.click('view-tab', {tab:'agenda'}); hasRange(1, largeCapacity);
  const before = ui.app.innerHTML; await ui.click('view-tab', {tab:'not-a-tab'}); await ui.click('view-page', {page:'-1'}); await ui.click('view-page', {page:'NaN'});
  assert.equal(ui.app.innerHTML, before); assert.equal(ui.writes, 0);
});

test('diary history page action opens the chosen entry and resets to the first text page', async t => {
  const date = addDays(todayKey(), -3), initial = {...createInitialState(), diary:{[date]:{text:'本文の始まり。'.repeat(120), mood:'bright'}}}, ui = await launch(t, {initial, hash:'#diary'});
  await ui.click('view-tab', {tab:'history'}); await ui.click('diary-day', {date});
  assert.equal(currentTab(ui, 'entry'), true); assert.equal(selectedDate(ui), date); assert.match(ui.app.innerHTML, /pagination-position[^>]*[^]*?1 \/ /);
  await ui.click('view-page', {page:'1'}); assert.match(ui.app.innerHTML, /pagination-position[^>]*>2 \/ /);
  await ui.click('view-tab', {tab:'history'}); await ui.click('diary-day', {date}); assert.match(ui.app.innerHTML, /pagination-position[^>]*>1 \/ /);
});

test('all primary record routes clamp future selected dates before opening a record editor', async t => {
  const today = todayKey(), future = addDays(today, 50), initial = {...createInitialState(), habits:[{id:'read', name:'読書', type:'number', unit:'ページ', target:10, archived:false}]}, ui = await launch(t, {initial});
  await ui.changeDate(future); await ui.changeHash('#wake'); assert.equal(selectedDate(ui), today);
  await ui.click('wake-edit'); await ui.submit('wake', {time:'06:15'}); assert.equal(ui.state().wake[today], '06:15'); assert.equal(ui.state().wake[future], undefined);
  await ui.changeHash('#calendar'); await ui.changeDate(future); await ui.changeHash('#running'); assert.equal(selectedDate(ui), today);
  await ui.click('run-add'); assert.match(ui.editor.innerHTML, new RegExp(`name="date"[^>]*value="${today}"`)); await ui.click('dialog-close');
  await ui.changeHash('#diary'); await ui.changeDate(future); await ui.changeHash('#habits'); assert.equal(selectedDate(ui), today);
  await ui.click('habit-log', {id:'read'}); await ui.submit('habit-log', {value:'3'}); assert.equal(ui.state().habitLogs.read[today], 3); assert.equal(ui.state().habitLogs.read[future], undefined);
  await ui.changeHash('#calendar'); await ui.changeDate(future); await ui.changeHash('#home'); assert.equal(selectedDate(ui), today);
});

test('resizing preserves an open journal editor and its unsaved fields, and saving still uses its original date', async t => {
  const future = addDays(todayKey(), 3), ui = await launch(t, {hash:'#diary', width:1280, height:900});
  await ui.changeDate(future); await ui.click('diary-edit'); const markup = ui.editor.innerHTML;
  const text = ui.editor.querySelector('[name="text"]'); text.value = '未保存の文章 🌷';
  await ui.resize(390, 640); await ui.resize(1920, 1080);
  assert.equal(ui.editor.open, true); assert.equal(ui.editor.innerHTML, markup); assert.equal(ui.editor.querySelector('[name="text"]').value, '未保存の文章 🌷'); assert.equal(ui.writes, 0);
  await ui.submit('diary', {text:text.value, mood:'calm'}); assert.equal(ui.state().diary[future].text, text.value);
});

test('navigation and cross-tab updates invalidate stale journal forms and obsolete undo', async t => {
  const ui = await launch(t); await ui.click('event-add'); const stale = ui.form('event', valuesForEvent());
  await ui.changeHash('#diary'); await ui.submitForm(stale); assert.equal(ui.writes, 0); assert.equal(ui.editor.open, false);
  await ui.click('diary-edit'); await ui.submit('diary', {text:'一度保存', mood:'calm'}); await ui.click('diary-edit');
  const diaryForm = ui.form('diary', {text:'古い下書き', mood:'tired'}), external = {...createInitialState(), diary:{[todayKey()]:{text:'別タブの新しい日記', mood:'bright'}}};
  ui.setRaw(serializeBackup(external)); await ui.window.emit('storage', {key:STORAGE_KEY});
  await ui.submitForm(diaryForm); await ui.click('undo');
  assert.equal(ui.writes, 1); assert.deepEqual(ui.state(), external); assert.equal(ui.editor.open, false); assert.match(ui.app.innerHTML, /別タブの新しい日記/);
});

test('slow backup import cannot replace a newer journal editor or survive a cross-tab update', async t => {
  const ui = await launch(t, {hash:'#settings'}); let finish;
  await ui.click('backup-import'); const pending = ui.selectFile({size:100, text:() => new Promise(resolve => {finish = resolve;})});
  await ui.changeHash('#calendar'); await ui.click('event-add'); const markup = ui.editor.innerHTML;
  finish(serializeBackup({...createInitialState(), events:[eventRecord('stale', todayKey())]})); await pending;
  assert.equal(ui.editor.innerHTML, markup); assert.equal(ui.editor.open, true); assert.equal(ui.writes, 0);
  await ui.click('dialog-close'); await ui.changeHash('#settings'); await ui.click('backup-import');
  const later = ui.selectFile({size:100, text:() => new Promise(resolve => {finish = resolve;})});
  const external = {...createInitialState(), diary:{[todayKey()]:{text:'別タブ', mood:null}}}; ui.setRaw(serializeBackup(external)); await ui.window.emit('storage', {key:STORAGE_KEY});
  finish(serializeBackup(createInitialState())); await later; assert.equal(ui.editor.open, false); assert.deepEqual(ui.state(), external); assert.equal(ui.writes, 0);
});

test('stale delete controls after cancel are harmless and never display an internal context error', async t => {
  const ui = await launch(t);
  const before = ui.notice.innerHTML; await ui.click('event-delete'); await ui.click('diary-delete');
  assert.equal(ui.writes, 0); assert.equal(ui.editor.open, false); assert.equal(ui.notice.innerHTML, before);
});


test('delete confirmations require matching editor types and cannot reuse unrelated form context', async t => {
  const today = todayKey(), initial = {...createInitialState(), events:[eventRecord('one', today)], diary:{[today]:{text:'大切な日記', mood:'calm'}}}, ui = await launch(t, {initial});
  await ui.click('event-edit', {id:'one'}); const eventMarkup = ui.editor.innerHTML;
  await ui.click('event-delete-confirm'); await ui.click('diary-delete'); await ui.click('diary-delete-confirm');
  assert.equal(ui.editor.innerHTML, eventMarkup); assert.deepEqual(ui.state(), initial); assert.equal(ui.writes, 0);
  await ui.click('event-delete'); const confirmMarkup = ui.editor.innerHTML;
  await ui.submit('event', valuesForEvent(today, {title:'古いフォームから上書き'}));
  assert.equal(ui.editor.innerHTML, confirmMarkup); assert.equal(ui.writes, 0);
  await ui.click('dialog-close'); await ui.changeHash('#diary'); await ui.click('diary-edit'); const diaryMarkup = ui.editor.innerHTML;
  await ui.click('event-delete'); await ui.click('event-delete-confirm'); await ui.click('diary-delete-confirm');
  await ui.submit('event', valuesForEvent(today, {title:'別の種類のフォーム'}));
  assert.equal(ui.editor.innerHTML, diaryMarkup); assert.deepEqual(ui.state(), initial); assert.equal(ui.writes, 0);
});

test('failed stale file reads are ignored after a newer same-route editor or navigation', async t => {
  const ui = await launch(t, {hash:'#running'}); let fail;
  await ui.click('gpx-import'); const pending = ui.selectFile({size:100, text:() => new Promise((resolve, reject) => {fail = reject;})});
  await ui.click('run-add'); const markup = ui.editor.innerHTML, notice = ui.notice.innerHTML;
  fail(new Error('Old file cannot be read')); await pending;
  assert.equal(ui.editor.innerHTML, markup); assert.equal(ui.notice.innerHTML, notice); assert.equal(ui.writes, 0);
  await ui.click('dialog-close'); await ui.changeHash('#settings'); await ui.click('backup-import');
  const later = ui.selectFile({size:100, text:() => new Promise((resolve, reject) => {fail = reject;})});
  await ui.changeHash('#diary'); fail(new Error('Old page file cannot be read')); await later;
  assert.equal(ui.editor.open, false); assert.equal(ui.notice.innerHTML, notice); assert.equal(ui.writes, 0);
});


test('diary permits a mood-only page but rejects an entirely empty entry', async t => {
  const ui = await launch(t, {hash:'#diary'}); await ui.click('diary-edit');
  await ui.submit('diary', {text:'   ', mood:''}); assert.equal(ui.writes, 0); assert.equal(ui.editor.open, true);
  await ui.submit('diary', {text:'   ', mood:'calm'}); assert.equal(ui.writes, 1);
  assert.deepEqual(ui.state().diary[todayKey()], {text:'', mood:'calm'}); assert.match(ui.app.innerHTML, /気分だけを残した日/);
});

test('resizing an event editor preserves unsaved title, date, time, and notes', async t => {
  const ui = await launch(t), future = addDays(todayKey(), 5); await ui.click('event-add'); const markup = ui.editor.innerHTML;
  const values = valuesForEvent(future, {title:'未保存の予定', time:'15:45', note:'書きかけのメモ'});
  for (const [key, value] of Object.entries(values)) ui.editor.querySelector(`[name="${key}"]`).value = value;
  await ui.resize(375, 620); await ui.resize(1280, 720);
  assert.equal(ui.editor.innerHTML, markup); assert.equal(ui.editor.open, true); assert.equal(ui.writes, 0);
  for (const [key, value] of Object.entries(values)) assert.equal(ui.editor.querySelector(`[name="${key}"]`).value, value);
  await ui.submit('event', values); assert.equal(ui.state().events[0].date, future); assert.equal(ui.state().events[0].title, values.title);
});
