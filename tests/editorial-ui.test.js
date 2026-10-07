import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createInitialState} from '../src/lib/domain.js';
import {renderDashboard} from '../src/views/dashboard.js';
import {renderWake} from '../src/views/wake.js';
import {renderRunning} from '../src/views/running.js';
import {wakeChart,runChart} from '../src/lib/charts.js';
import {captureFocus,restoreFocus} from '../src/lib/focus.js';
const date='2026-10-06',context=state=>({state,date,today:date});
test('home continuity uses seven real dates and never treats planned events as completed records',()=>{
 const state=createInitialState();state.events=[{id:'event',date,title:'予定',time:null,note:''}];
 const html=renderDashboard(context(state));
 assert.equal((html.match(/class="continuity-day /g)||[]).length,7);
 assert.match(html,/今日のひとつが、次につながる/);
 assert.doesNotMatch(html,/class="continuity-day recorded"/);
 assert.match(html,/—<small>未記録/);assert.match(html,/—<small>未設定/);
});
test('a diary-only day contributes to continuity without manufacturing activity counts',()=>{
 const state=createInitialState();state.diary[date]={text:'今日の記録',mood:'calm'};
 const html=renderDashboard(context(state));assert.match(html,/この7日間、1日を記録/);
 assert.equal((html.match(/class="continuity-day recorded"/g)||[]).length,1);
 assert.match(html,/—<small>未記録/);
});
test('historical home days cannot record the current wake time',()=>{
 const html=renderDashboard({...context(createInitialState()),date:'2026-10-04'});
 assert.doesNotMatch(html,/data-action="wake-now"/);assert.match(html,/data-action="wake-edit"/);
});
test('empty history pages offer an existing recording action',()=>{
 assert.match(renderWake({...context(createInitialState()),tab:'history'}),/empty-action" data-action="wake-edit"/);
 assert.match(renderRunning({...context(createInitialState()),tab:'history'}),/empty-action" data-action="run-add"/);
});
test('chart accessible names expose numeric data and missing wake dates without relying on color',()=>{
 const state=createInitialState();state.wake[date]='06:35';state.runs=[{id:'run',date,distanceKm:4.2,durationSec:1500,points:[],note:''}];
 assert.match(wakeChart(state,7,date),/aria-label="[^"]*2026-10-06 06:35/);
 assert.match(wakeChart(state,7,date),/2026-10-05 未記録/);
 assert.match(runChart(state,7,date),/aria-label="[^"]*2026-10-06 4.20 km/);
 assert.match(runChart(state,7,date),/text-anchor="middle">4.2<\/text>/);
});
function element(attrs,disabled=false){return{tagName:'BUTTON',disabled,getAttribute:name=>attrs[name]??null,focus(){this.focused=true;}};}
test('focus identity preserves the exact habit or date after rerender, including quoted ids',()=>{
 const id='a" ] [ x';const old=element({'data-action':'habit-log','data-id':id});
 const snapshot=captureFocus({contains:()=>true},old),other=element({'data-action':'habit-log','data-id':'b'}),replacement=element({'data-action':'habit-log','data-id':id});
 assert.equal(restoreFocus({querySelectorAll:()=>[other,replacement]},snapshot),true);
 assert.equal(replacement.focused,true);assert.equal(other.focused,undefined);
});
test('removed or disabled targets fall back rather than focusing an unrelated control',()=>{
 const snapshot=captureFocus({contains:()=>true},element({'data-action':'save'}));
 assert.equal(restoreFocus({querySelectorAll:()=>[element({'data-action':'save'},true)]},snapshot),false);
 assert.equal(captureFocus({contains:()=>false},element({id:'outside'})),null);
});
test('editorial styles retain bounded desktop and internally scrollable mobile layouts',()=>{
 const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
 assert.match(css,/\.home-overview\s*\{[^}]*height:auto[^}]*min-height:100%/);
 assert.match(css,/\.home-dashboard-grid\s*\{[^}]*grid-template-columns:minmax\(0,3fr\) minmax\(0,2fr\)/);
 assert.match(css,/@media\s*\(prefers-reduced-motion:reduce\)/);
 assert.match(css,/\.habit-week \.filled::after\s*\{\s*content:'✓'/);
 const app=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
 assert.match(app,/<span>マイペース<\/span>/);
});


test('wake record workspace renders real gapped chart and existing target controls without mutating records',()=>{
 const state=createInitialState();state.wake={'2026-10-04':'00:00',[date]:'06:35'};state.settings.wakeTarget='06:00';
 const before=structuredClone(state),html=renderWake(context(state));
 assert.ok(html.includes(wakeChart(state,7,date)));
 for(const hook of ['wake-workspace','wake-entry-row','wake-context','wake-chart-panel sky-panel','wake-summary apricot-panel'])assert.ok(html.includes(hook));
 for(const action of ['wake-edit','target-edit'])assert.match(html,new RegExp(`data-action="${action}"`));
 assert.match(html,/data-action="view-tab" data-tab="trends"/);assert.doesNotMatch(html,/data-action="wake-now"/);
 assert.equal((html.match(/class="chart-dot"/g)||[]).length,2);assert.match(html,/2026-10-05 未記録/);assert.deepEqual(state,before);
});
test('run record workspace shows real series, missing days and genuine zero separately from no entry',()=>{
 const state=createInitialState(),empty=renderRunning(context(state));
 assert.match(empty,/class="unrecorded">未記録/);assert.doesNotMatch(empty,/class="run-summary/);
 state.runs=[{id:'zero',date,distanceKm:0,durationSec:0,points:[],note:''}];
 const before=structuredClone(state),html=renderRunning(context(state));
 assert.match(html,/class="hero-time">0\.00<small>km/);assert.ok(html.includes(runChart(state,7,date)));
 for(const action of ['run-add','gpx-import'])assert.match(html,new RegExp(`data-action="${action}"`));
 for(const tab of ['history','trends'])assert.match(html,new RegExp(`data-action="view-tab" data-tab="${tab}"`));
 assert.match(html,/run-chart-panel forest-panel/);assert.match(html,/run-summary sky-panel/);assert.deepEqual(state,before);
});
