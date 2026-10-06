import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState, validateState, isHabitComplete} from '../src/lib/domain.js';
import {e, habitValue, isDone} from '../src/lib/ui.js';
import {wakeChart, runChart} from '../src/lib/charts.js';
import {renderDashboard} from '../src/views/dashboard.js';
import {renderWake, periodToggle} from '../src/views/wake.js';
import {renderRunning, routeMap} from '../src/views/running.js';
import {renderHabits} from '../src/views/habits.js';
import {renderSettings} from '../src/views/settings.js';
import {wakeDialog, targetDialog, runDialog, habitDialog, habitLogDialog, confirmDialog} from '../src/dialogs.js';

const date = '2026-10-05';
const renderers = [renderDashboard, renderWake, renderRunning, renderHabits, renderSettings];
const context = (state = createInitialState(), day = date) => ({state, date:day, today:date, period:7});
function fixture() {
  return validateState({...createInitialState(), wake:{[date]:'06:30'},
    habits:[{id:'reading',name:'本を読む',type:'number',unit:'ページ',target:10,archived:false},
      {id:'stretch',name:'ストレッチ',type:'check',unit:'',target:1,archived:false},
      {id:'rest',name:'お休み中',type:'time',unit:'分',target:5,archived:true}],
    habitLogs:{reading:{[date]:0},stretch:{[date]:true},rest:{[date]:10}},
    runs:[{id:'run-1',date,distanceKm:5,durationSec:1800,note:'気持ちよかった',points:[]}]});
}
function input(html, name) {
  const value = html.match(new RegExp(`<input\\b(?=[^>]*\\bname="${name}")[^>]*>`))?.[0];
  assert.ok(value, `Input ${name} exists`);
  return value;
}

test('all pages render meaningful empty and populated states without undefined or non-finite numbers', () => {
  for (const state of [createInitialState(), fixture()]) for (const render of renderers) {
    const html = render(context(state));
    assert.ok(html.length > 100, render.name);
    assert.doesNotMatch(html, /\bundefined\b|\bNaN\b|\bInfinity\b/, render.name);
  }
});

test('escaping preserves user text without turning it into markup or attributes', () => {
  assert.equal(e(`<>&"'`),'&lt;&gt;&amp;&quot;&#39;');
  const malicious = `<img src=x onerror="alert('x')">`;
  const state = fixture(); state.habits[0].name=malicious; state.habits[0].unit='" onfocus="x'; state.runs[0].note=malicious;
  const html = [renderDashboard(context(state)),renderHabits(context(state)),renderRunning(context(state)),habitDialog(state.habits[0]),habitLogDialog(state.habits[0],0,date),runDialog(state.runs[0],date,date),confirmDialog(malicious,malicious,malicious,'known-action')].join('');
  assert.doesNotMatch(html, /<img src=x| onerror="alert|value="" onfocus=/);
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;'));
});

test('zero is a recorded numeric value and not an absent value', () => {
  const habit=fixture().habits[0];
  assert.equal(habitValue(habit,0),'0 ページ');
  assert.equal(habitValue(habit,undefined),'まだ');
  assert.equal(isDone(habit,0),false);
  assert.match(input(habitLogDialog(habit,0,date),'value'),/value="0"/);
  assert.match(habitLogDialog(habit,0,date),/data-action="habit-log-delete"/);
});

test('UI completion agrees with domain rules, including imported target-free habits', () => {
  for(const type of ['number','time']) for(const target of [null,1,10]) for(const value of [undefined,0,1,10]) {
    const habit={id:'h',name:'習慣',type,target,unit:'回',archived:false};
    assert.equal(isDone(habit,value),isHabitComplete(habit,value),JSON.stringify({type,target,value}));
  }
});

test('selected historical days do not offer current-time recording', () => {
  for(const render of [renderDashboard,renderWake]) {
    assert.match(render(context()),/data-action="wake-now"/);
    assert.doesNotMatch(render(context(createInitialState(),'2026-10-04')),/data-action="wake-now"/);
  }
});

test('archived habits are excluded from dashboard and can be resumed on habit page', () => {
  const state=fixture();
  assert.doesNotMatch(renderDashboard(context(state)),/お休み中/);
  assert.match(renderHabits({...context(state),tab:'archived'}),/data-action="habit-restore" data-id="rest"/);
  assert.doesNotMatch(renderHabits(context(state)),/data-action="habit-log" data-id="rest"/);
});

test('recording dialogs have cancel, close, validation alert, named controls and submit buttons', () => {
  const state=fixture();
  for(const html of [wakeDialog(date,''),targetDialog(null),runDialog(null,date,date),habitDialog(null),habitLogDialog(state.habits[0],undefined,date)]) {
    assert.match(html,/id="dialog-title"/); assert.match(html,/role="alert" hidden/);
    assert.match(html,/type="button" data-action="dialog-close"/);
    assert.match(html,/type="submit"/); assert.match(html,/<form data-form=/);
  }
  assert.match(input(runDialog(null,date,date),'date'),/max="2026-10-05"/);
  assert.match(habitDialog(state.habits[0]),/<select name="type" disabled>/);
  assert.match(input(targetDialog(null),'target'),/value=""/);
  assert.doesNotMatch(input(targetDialog(null),'target'),/required/);
});

test('zero-distance GPX import permits manual distance entry, nonzero computed distances remain protected', () => {
  const points=[{lat:35,lon:139,segment:0}];
  const emptyDistance=runDialog({distanceKm:0,durationSec:0,points},date,date,['距離を入力してください。']);
  assert.doesNotMatch(input(emptyDistance,'distance'),/readonly/);
  assert.match(input(runDialog({distanceKm:5,durationSec:1800,points},date,date),'distance'),/readonly/);
});

test('run pace labels show the /km unit exactly once per displayed pace', () => {
  const html=renderRunning({...context(fixture()),tab:'trends'})+renderRunning({...context(fixture()),tab:'history'});
  assert.equal((html.match(/\/km/g)||[]).length,2);
  assert.doesNotMatch(html,/\/km\s*\/km/);
});

test('valid earliest date does not crash any page', () => {
  for(const render of renderers) assert.doesNotThrow(()=>render(context(createInitialState(),'1900-01-01')),render.name);
});

test('wake chart leaves gaps for missing days and keeps midnight as a real observation', () => {
  const state=createInitialState(); state.wake={'2026-10-03':'00:00',[date]:'06:30'};
  const html=wakeChart(state,7,date), path=html.match(/<path d="([^"]*)" class="chart-line"/)[1];
  assert.equal((path.match(/M/g)||[]).length,2); assert.doesNotMatch(path,/L/);
  assert.equal((html.match(/class="chart-dot"/g)||[]).length,2);
  assert.match(html,/2026-10-03 00:00/);
});

test('charts and route preview include accessible summaries, no fake background map', () => {
  const state=fixture();
  for(const html of [wakeChart(state,7,date),runChart(state,7,date),routeMap([{lat:35,lon:139},{lat:35.01,lon:139.01}])]) assert.match(html,/role="img" aria-label="[^"]+"/);
  assert.match(routeMap([{lat:35,lon:139}]),/背景地図なし/);
  assert.match(periodToggle(30),/data-days="30" aria-pressed="true"/);
  assert.match(periodToggle(30),/data-days="7" aria-pressed="false"/);
});

test('settings disclose opt-in Drive, local persistence, backup privacy and unimplemented LINE', () => {
  const html=renderSettings(context())+renderSettings({...context(),tab:'about'});
  assert.match(html,/自動で同期されません/); assert.match(html,/位置情報/);
  assert.match(html,/Google Drive/); assert.match(html,/Google ログイン/); assert.match(html,/LINE/);
  assert.equal((html.match(/class="planned">未実装/g)||[]).length,1);
  assert.match(html,/接続操作をしたときだけ/); assert.match(html,/開いている間だけ/);
  assert.doesNotMatch(html,/data-action="(?:login|connect|sync)/);
});

test('form upper bounds permit unchanged editing of every largest valid record value', () => {
  const habit={id:'maximum',name:'数値の上限',type:'number',unit:'回',target:1000000,archived:false};
  const run={id:'maximum-run',date,distanceKm:10000,durationSec:31*24*3600,note:'a'.repeat(2000),points:[]};
  validateState({...createInitialState(),habits:[habit],habitLogs:{maximum:{[date]:1000000}},runs:[run]});
  const max=(html,name)=>Number(input(html,name).match(/max="([^"]+)"/)[1]);
  assert.ok(max(habitDialog(habit),'target')>=habit.target);
  assert.ok(max(habitLogDialog(habit,1000000,date),'value')>=1000000);
  assert.ok(max(runDialog(run,date,date),'distance')>=run.distanceKm);
  assert.ok(max(runDialog(run,date,date),'minutes')>=run.durationSec/60);
  assert.ok(Number(runDialog(run,date,date).match(/<textarea[^>]*maxlength="(\d+)"/)[1])>=run.note.length);
});
