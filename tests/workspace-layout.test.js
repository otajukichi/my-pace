/** Static markup/CSS contracts only. These tests do not measure browser layout,
 * scrollHeight, focus behavior, keyboard reachability, computed styles or contrast.
 * Actual viewport acceptance still requires a permitted real browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createInitialState, addDays} from '../src/lib/domain.js';
import {pageCapacity} from '../src/lib/workspace.js';
import {renderWake} from '../src/views/wake.js';
import {renderRunning} from '../src/views/running.js';
import {renderHabits} from '../src/views/habits.js';
import {renderCalendar} from '../src/views/calendar.js';
import {renderDiary} from '../src/views/diary.js';
import {wakeChart, runChart} from '../src/lib/charts.js';
import {habitDialog} from '../src/dialogs.js';
import {eventDialog} from '../src/journal-dialogs.js';

const today='2026-10-06';
const viewports=[[320,568],[390,844],[600,700],[768,768],[1024,768],[1366,768],[1440,900],[1920,1080]];
const names='非常に長い日本語の名前が途中で省略されても詳細を開いてすべて確認できること';
const note='長いメモの内容。\n'.repeat(90);
function historyFixture(){
  const state=createInitialState();
  for(let i=0;i<47;i++){
    const day=addDays(today,-i);
    state.wake[day]='06:30';
    state.runs.push({id:`run-${i}`,date:day,distanceKm:5,durationSec:1800,note,points:[]});
    state.habits.push({id:`habit-${i}`,name:names,type:'number',unit:'ページ',target:10,archived:false});
    state.habits.push({id:`archive-${i}`,name:names,type:'check',unit:'',target:1,archived:true});
    state.events.push({id:`event-${i}`,date:day,time:null,title:names,note});
    state.diary[day]={text:note,mood:'calm'};
  }
  return state;
}
function readAllPages(render,options,selector){
  const seen=[];
  for(let page=0;page<1000;page++){
    const html=render({...options,page});
    seen.push(...Array.from(html.matchAll(selector),match=>match[1]));
    const next=html.match(/<button\b[^>]*aria-label="次のページ"[^>]*>/)?.[0];
    assert.ok(next, `${render.name} exposes its next-page control`);
    if(/\bdisabled\b/.test(next))return seen;
  }
  assert.fail(`${render.name} did not reach its final page`);
}

for(const [width,height] of viewports){
  test(`all stored history is reachable by page controls at ${width}x${height} capacity (not browser layout)`,()=>{
    const state=historyFixture(), context={state,date:today,today,pageSize:pageCapacity(width,height)};
    const cases=[
      [renderWake,{tab:'history'},/data-action="wake-history" data-date="([^"]+)"/g,Object.keys(state.wake)],
      [renderHabits,{tab:'active'},/class="habit-name"[^>]*data-id="([^"]+)"/g,state.habits.filter(row=>!row.archived).map(row=>row.id)],
      [renderHabits,{tab:'archived'},/class="habit-name"[^>]*data-id="([^"]+)"/g,state.habits.filter(row=>row.archived).map(row=>row.id)],
      [renderCalendar,{tab:'agenda'},/data-action="event-edit" data-id="([^"]+)"/g,state.events.map(row=>row.id)],
      [renderDiary,{tab:'history'},/data-action="diary-day" data-date="([^"]+)"/g,Object.keys(state.diary)],
    ];
    for(const [render,extra,selector,expected] of cases){
      const seen=readAllPages(render,{...context,...extra},selector);
      assert.deepEqual([...seen].sort(),[...expected].sort(),`${render.name} ${extra.tab}`);
      assert.equal(new Set(seen).size,expected.length,'records are not duplicated across pages');
    }
  });
}

test('every character of long Japanese, emoji, whitespace and newline diary is readable through pages',()=>{
  const text=('日常の文章。🌱 一日を記録\n\n'.repeat(180))+'おしまい。';
  for(const [width,height] of viewports){
    const state=createInitialState();state.diary[today]={text,mood:'calm'};
    const fragments=readAllPages(renderDiary,{state,date:today,today,tab:'entry',pageSize:pageCapacity(width,height)},/<p class="diary-text">([\s\S]*?)<\/p>/g);
    assert.equal(fragments.join(''),text,`${width}x${height}: no content is silently sliced away`);
  }
});

test('editable names and notes retain full detail while running legacy notes remain hidden',()=>{
  const state=historyFixture(),context={state,date:today,today};
  assert.match(renderHabits(context),/class="habit-name"[^>]*data-action="habit-edit"/);
  assert.ok(habitDialog(state.habits[0]).includes(names));
  assert.doesNotMatch(renderRunning({...context,tab:'history'}),/run-edit|run-add|非常に長い|長いメモ/);
  assert.match(renderCalendar({...context,tab:'agenda'}),/aria-label="[^\"]+の詳細・編集"/);
  assert.ok(eventDialog(state.events[0],today).includes(names));
  assert.ok(eventDialog(state.events[0],today).includes(note));
  assert.match(renderDiary({...context,tab:'history'}),/data-action="diary-day"/);
});

test('source declares a bounded document and reachable internal overflow safety surfaces',async()=>{
  const css=await readFile(new URL('../src/style.css',import.meta.url),'utf8');
  const app=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
  for(const selector of ['html','body'])assert.match(css,new RegExp(selector+'\\s*\\{[^}]*height:100%[^}]*overflow:hidden'));
  assert.match(css,/#app\s*\{[^}]*height:100dvh[^}]*overflow:hidden/);
  assert.match(css,/\.view-stage\s*\{[^}]*min-height:0[^}]*overflow:auto/);
  assert.match(app,/class="view-stage"[^>]*role="region"[^>]*tabindex="0"/);
  assert.match(css,/dialog\s*\{[^}]*max-height:[^;}]+[^}]*overflow:auto/);
  assert.match(css,/\.field textarea\s*\{[^}]*max-height:[^;}]+[^}]*overflow:auto/);
});

test('populated chart markup is matched by explicit bounded SVG CSS',async()=>{
  const css=await readFile(new URL('../src/style.css',import.meta.url),'utf8');
  const state=historyFixture();
  for(const render of [wakeChart,runChart])assert.match(render(state,7,today),/class="chart-wrap" tabindex="0" role="region" aria-label="[^"]+"><svg/);
  assert.match(css,/\.chart-wrap\s*\{[^}]*justify-content:flex-start[^}]*overflow-x:auto[^}]*max-width:100%/);
  assert.match(css,/\.chart-wrap svg\s*\{[^}]*height:auto[^}]*min-width:620px[^}]*width:100%/);
  assert.match(css,/\.chart-space\s*\{[^}]*flex-direction:column/);
  assert.match(css,/\.run-bar\s*\{[^}]*fill:/);
  assert.match(css,/\[tabindex\]:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/);
  assert.match(css,/\.chart-wrap text\s*\{[^}]*font:12px/);
});

test('running remains read-only with no legacy history or pagination at every viewport capacity',()=>{
 const state=historyFixture(),before=structuredClone(state);
 for(const [width,height] of viewports)for(const tab of ['record','history','trends']){
  const html=renderRunning({state,date:today,today,tab,pageSize:pageCapacity(width,height)});
  assert.match(html,/daily-running/);assert.doesNotMatch(html,/run-edit|run-add|gpx-import|cloud-route|次のページ|長いメモ/);
 }
 assert.deepEqual(state,before);
});
