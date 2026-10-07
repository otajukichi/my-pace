import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState} from '../src/lib/domain.js';
import {homeSummary} from '../src/lib/home-summary.js';
import {renderDashboard} from '../src/views/dashboard.js';
const date='2026-10-07';
const habit=(id,type='number',archived=false)=>({id,name:id,type,target:10,unit:'回',archived});
function fixture(){
 const state=createInitialState();
 state.wake={'2025-01-01':'00:00','2026-10-06':'07:20','2026-10-08':'06:00'};
 state.runs=[{date:'2025-01-01',distanceKm:5},{date:'2025-01-01',distanceKm:2.5},{date,distanceKm:1.2},{date:'2026-10-08',distanceKm:20}];
 state.habits=[habit('numeric'),habit('check','check'),habit('archived','time',true)];
 state.habitLogs={numeric:{'2025-01-01':0,'2026-10-05':2,[date]:10,'2026-10-08':100},check:{'2025-01-01':false,'2026-10-06':true},archived:{'2025-01-01':12}};
 state.diary={'2025-01-01':{text:'old',mood:null},[date]:{text:'new',mood:'calm'},'2026-10-08':{text:'future',mood:null}};
 state.events=[{date:'2026-10-03',title:'plan only'}];
 return state;
}
test('lifetime covers old history, counts multiple sessions, excludes future and planned events, preserves state',()=>{
 const state=fixture(),before=structuredClone(state),s=homeSummary(state,date);
 assert.equal(s.recordedDays,4);assert.equal(s.distanceKm,8.7);assert.equal(s.runCount,3);assert.equal(s.wakeDays,2);assert.equal(s.diaryDays,2);
 assert.equal(s.habitEntries,6);assert.equal(s.habitDays,4);assert.equal(s.habitChecked,1);assert.equal(s.habitMeasured,4);
 assert.equal(s.latestWake.date,'2026-10-06');assert.equal(s.latestWake.wake,'07:20');assert.deepEqual(state,before);
 assert.equal(s.week.length,7);assert.equal(s.week[0].date,'2026-10-01');assert.equal(s.week.at(-1).date,date);
 assert.equal(s.week.find(d=>d.date==='2026-10-03').recorded,false);
});
test('numeric zero and false are saved records but never completions',()=>{
 const state=createInitialState();state.habits=[habit('zero'),habit('no','check')];state.habitLogs={zero:{[date]:0},no:{[date]:false}};
 const s=homeSummary(state,date);assert.equal(s.recordedDays,1);assert.equal(s.habitEntries,2);assert.equal(s.habitChecked,0);assert.equal(s.week.at(-1).recorded,true);
});
test('missing imported distances never acquire a made-up distance and orphan logs are ignored',()=>{
 const state=createInitialState();state.habitLogs={orphan:{[date]:true}};state.drive={importedRuns:40,totalDistance:900};
 assert.equal(homeSummary(state,date).runCount,0);assert.equal(homeSummary(state,date).distanceKm,0);assert.equal(homeSummary(state,date).recordedDays,0);
});
test('earliest supported date and empty history remain finite',()=>{
 const s=homeSummary(createInitialState(),'1900-01-01');assert.equal(s.week.length,1);assert.equal(s.recordedDays,0);assert.equal(s.latestWake,null);
});
test('home exposes lifetime scope, actual counts, input controls, and record-only trace labels',()=>{
 const state=fixture(),html=renderDashboard({state,date,today:date});
 assert.match(html,/生活の記録（DriveのCSVは含みません） · 2026-10-07まで/);assert.match(html,/8\.70<small>km/);assert.match(html,/チェック済み 1回/);assert.match(html,/数値・時間の記録 4件/);
 assert.doesNotMatch(html,/現在の目標で達成|YOUR DAILY RHYTHM|home-sun/);
 for(const action of ['wake-now','wake-edit','run-add','diary-edit','event-add'])assert.match(html,new RegExp(`data-action="${action}"`));
 assert.match(html,/印は記録の有無/);assert.match(html,/href="#habits"/);
 const rhythm=renderDashboard({state,date,today:date,tab:'rhythm'});assert.match(rhythm,/これまでの積み重ね/);assert.match(rhythm,/現在の庭/);
 state.wake[date]='08:00';assert.doesNotMatch(renderDashboard({state,date,today:date}),/data-action="wake-now"/);
});

test('empty lifetime distance is not an achievement and genuine zero distance remains a recorded value',()=>{
 const state=createInitialState();let html=renderDashboard({state,date,today:date});assert.match(html,/まだ記録はありません/);assert.doesNotMatch(html,/0\.00<small>km/);
 state.runs=[{date,distanceKm:0}];html=renderDashboard({state,date,today:date});assert.match(html,/<dt>走った距離<\/dt><dd>0\.00<small>km/);
});
test('home shows bounded, escaped diary and plan previews',()=>{
 const state=createInitialState();state.diary[date]={text:'<img src=x> 気持ちよい朝。'+'続き'.repeat(80),mood:null};state.events=[{date,time:'10:00',title:'<会議>'},{date,time:null,title:'散歩'},{date,time:null,title:'第三の予定'}];
 const html=renderDashboard({state,date,today:date});assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img src=x>/);assert.match(html,/10:00 &lt;会議&gt;/);assert.match(html,/散歩/);assert.doesNotMatch(html,/第三の予定/);assert.match(html,/…/);
});

test('home offers up to three active quick habit controls with escaped accessible names',()=>{
 const state=createInitialState();state.habits=[habit('first','check'),habit('second'),habit('third'),habit('fourth'),habit('hidden','check',true)];state.habits[0].name='<朝>';state.habitLogs={first:{[date]:true},second:{[date]:0}};
 const html=renderDashboard({state,date,today:date});assert.equal((html.match(/data-action="habit-log"/g)||[]).length,3);assert.match(html,/aria-label="&lt;朝&gt;を未完了にする" aria-pressed="true"/);assert.match(html,/<small>0 回<\/small>/);assert.doesNotMatch(html,/data-id="fourth"|data-id="hidden"/);assert.match(html,/すべての習慣/);
});
