import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState} from '../src/lib/domain.js';
import {deriveGarden} from '../src/lib/garden.js';
import {pageItems, textPages} from '../src/lib/journal-ui.js';
import {renderCalendar, calendarCells, dailySummary} from '../src/views/calendar.js';
import {renderDiary} from '../src/views/diary.js';
import {renderGarden, gardenScene} from '../src/views/garden.js';

const today = '2026-10-06';
const context = (state = createInitialState(), extra = {}) => ({state, date:today, today, ...extra});
function fixture() {
  return {...createInitialState(), wake:{[today]:'00:00'},
    runs:[{id:'run-1',date:today,distanceKm:5,durationSec:1800,note:'',points:[]}],
    habits:[{id:'h',name:'読書',type:'number',unit:'頁',target:10,archived:false}],habitLogs:{h:{[today]:0}},
    events:[{id:'e1',date:today,time:'12:30',title:'ランチ',note:'久しぶりに。'},
      {id:'e2',date:'2200-12-31',time:null,title:'未来のこと',note:''}],
    diary:{[today]:{text:'朝の風が気持ちよかった。',mood:'calm'}}};
}

test('new journal views have meaningful empty and populated states in each tab', () => {
  for (const state of [createInitialState(),fixture()]) for (const [render,tabs] of [[renderCalendar,['month','agenda']],[renderDiary,['entry','history']],[renderGarden,['garden','collection']]]) {
    for (const tab of tabs) {
      const html = render(context(state,{tab}));
      assert.match(html,/class="view-stack /);
      assert.doesNotMatch(html,/\bundefined\b|\bNaN\b|\bInfinity\b/);
      assert.ok(html.length > 200);
    }
  }
});

test('calendar preserves six weeks and leap days at supported year boundaries', () => {
  for (const month of ['1900-01','1900-02','2000-02','2026-10','2200-12']) {
    const cells = calendarCells(month);
    assert.equal(cells.length,42);
    assert.equal(new Set(cells.filter(Boolean).map(cell => cell.date)).size,cells.filter(Boolean).length);
    assert.ok(cells.some(cell => cell?.date === `${month}-01`));
  }
  assert.equal(calendarCells('1900-02').filter(cell => cell?.inMonth).length,28);
  assert.equal(calendarCells('2000-02').filter(cell => cell?.inMonth).length,29);
  assert.ok(calendarCells('2200-12').some(cell => cell === null));
  assert.deepEqual(calendarCells('2201-01'),[]);
  assert.deepEqual(calendarCells('2026-99'),[]);
  assert.match(renderCalendar(context(undefined,{month:'1900-01'})),/data-offset="-1"[^>]*disabled/);
  assert.match(renderCalendar(context(undefined,{month:'2200-12'})),/data-offset="1"[^>]*disabled/);
});

test('calendar shows recorded zero and midnight honestly and permits future event dates', () => {
  const state=fixture(), summary=dailySummary(state,today);
  assert.equal(summary.wake,'00:00');
  assert.equal(summary.habits,1);
  assert.equal(summary.runs,1);
  assert.equal(summary.events,1);
  const html=renderCalendar(context(state));
  assert.match(html,/00:00/);
  assert.match(html,/aria-current="date"/);
  assert.match(html,/予定1件、日記あり、生活の記録あり/);
  const future=renderCalendar(context(state,{date:'2200-12-31',month:'2200-12'}));
  assert.match(future,/これからの一日/);
  assert.match(future,/data-action="event-add" data-date="2200-12-31"/);
  assert.match(future,/未来のこと/);
});

test('agenda pagination makes every event reachable rather than slicing the list silently', () => {
  const state=createInitialState();
  state.events=Array.from({length:11},(_,i)=>({id:`event-${i}`,date:`2026-10-${String(i+1).padStart(2,'0')}`,time:null,title:`タイトル ${i}`,note:''}));
  const seen=[];
  for(let page=0;page<4;page++) {
    const html=renderCalendar(context(state,{tab:'agenda',page,pageSize:3}));
    seen.push(...[...html.matchAll(/data-action="event-edit" data-id="([^"]+)"/g)].map(match=>match[1]));
    assert.match(html,/data-action="view-page"/);
    assert.ok((html.match(/class="event-row"/g)||[]).length<=3);
  }
  assert.deepEqual(seen,state.events.map(event=>event.id));
});

test('diary text pages preserve every character, emoji and newline within bounds', () => {
  for(const text of ['あ'.repeat(8000),'🌱'.repeat(700),'\n'.repeat(100),'line\n'.repeat(600),'👨‍👩‍👧‍👦 & < > ".\n'.repeat(300)]) {
    const pages=textPages(text);
    assert.equal(pages.join(''),text);
    assert.ok(pages.every(part=>Array.from(part).length<=220));
    assert.ok(pages.every(part=>(part.match(/\n/g)||[]).length<=8));
    assert.ok(pages.every(part=>!/[\uD800-\uDBFF]$/.test(part)));
  }
  assert.deepEqual(textPages(''),[]);
});

test('the full long diary can be read one page at a time and stale pages clamp safely', () => {
  const state=createInitialState();state.diary[today]={text:'始'.repeat(440)+'最後の文章',mood:'bright'};
  const first=renderDiary(context(state));
  assert.doesNotMatch(first,/最後の文章/);
  assert.match(first,/data-action="view-page" data-page="1"/);
  const last=renderDiary(context(state,{page:100}));
  assert.match(last,/最後の文章/);
  const totalPages=textPages(state.diary[today].text,220,4).length;
  assert.ok(last.includes(`${totalPages} / ${totalPages}`));
  state.diary[today]={text:'',mood:'tired'};
  assert.match(renderDiary(context(state)),/気分だけを残した日。/);
  assert.match(renderDiary(context(state)),/おつかれ/);
});

test('every historical diary is reachable with a date action', () => {
  const state=createInitialState();
  state.diary=Object.fromEntries(Array.from({length:10},(_,i)=>[`2026-09-${String(i+1).padStart(2,'0')}`,{text:`日記${i}`,mood:null}]));
  const seen=[];
  for(let page=0;page<4;page++) seen.push(...[...renderDiary(context(state,{tab:'history',page})).matchAll(/data-action="diary-day" data-date="([^"]+)"/g)].map(match=>match[1]));
  assert.deepEqual(seen,Object.keys(state.diary).sort().reverse());
});

test('user strings cannot become elements or attributes in calendar or diary', () => {
  const state=fixture(), malicious='<img src=x onerror="bad()">';
  state.events[0]={...state.events[0],title:malicious,note:malicious};
  state.diary[today]={text:malicious,mood:'calm'};
  for(const html of [renderCalendar(context(state)),renderCalendar(context(state,{tab:'agenda'})),renderDiary(context(state)),renderDiary(context(state,{tab:'history'}))]) {
    assert.doesNotMatch(html,/<img src=x| onerror="bad\(\)"/);
    assert.match(html,/&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;/);
  }
});

test('empty garden stays bare and rewards only real unique recorded dates', () => {
  const state=createInitialState();
  state.events=[{id:'e1',date:today,time:null,title:'予定',note:''}];state.diary[today]={text:'日記',mood:null};
  let html=renderGarden(context(state));
  assert.match(html,/<strong>0<\/strong>/);
  assert.match(html,/はじめの記録で、小さな芽/);
  const bare=gardenScene(deriveGarden(state,today));
  assert.doesNotMatch(bare,/<ellipse cx="0" cy="-13"/);
  state.wake[today]='06:00';state.runs=[{id:'r1',date:today,distanceKm:3,durationSec:1000}];
  state.wake['2200-01-01']='05:00';
  html=renderGarden(context(state,{date:'2200-01-01'}));
  assert.match(html,/<strong>1<\/strong>/);
  assert.match(html,/今日の記録も、庭に届いて/);
  assert.match(html,/role="img" aria-label="1日分の記録/);
});

test('collection plant unlock controls and themed views reflect actual earned days', () => {
  const state=createInitialState();
  let html=renderGarden(context(state,{tab:'collection'}));
  assert.match(html,/data-plant="cosmos" aria-pressed="true"/);
  assert.match(html,/data-plant="sunflower"[^>]*disabled/);
  assert.match(html,/data-plant="hydrangea"[^>]*disabled/);
  for(let i=1;i<=21;i++) state.wake[`2026-09-${String(i).padStart(2,'0')}`]='06:00';
  state.garden={plant:'sunflower',theme:'night'};
  html=renderGarden(context(state,{tab:'collection'}));
  assert.match(html,/data-plant="sunflower" aria-pressed="true"/);
  assert.doesNotMatch(html,/data-plant="hydrangea"[^>]*disabled/);
  assert.match(html,/data-theme="night" aria-pressed="true"/);
  assert.match(renderGarden(context(state)),/fill="#28394e"/);
  delete state.wake['2026-09-21'];
  assert.match(renderGarden(context(state,{tab:'collection'})),/data-plant="hydrangea"[^>]*disabled/);
});

test('pagination rejects stale, negative and non-finite input safely', () => {
  assert.deepEqual(pageItems([1,2,3,4],99,3).items,[4]);
  assert.equal(pageItems([],5,3).page,0);
  assert.deepEqual(pageItems([1,2,3,4],-2,0).items,[1,2,3]);
  assert.equal(pageItems([1,2],Infinity).page,0);
});
