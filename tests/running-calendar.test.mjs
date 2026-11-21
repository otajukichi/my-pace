import test from 'node:test';
import assert from 'node:assert/strict';
import { indexRunDays, monthSummary, calendarWindow, shiftMonth, distanceLevel, initialRunningMonth } from '../lib/running-calendar.js';
import { themeAt, createThemeController } from '../lib/theme.js';
const record=(id,date,distance,duration=600)=>({id,date,summary:{distanceMeters:distance,durationSeconds:duration}});

test('calendar sums same-day runs, counts unique days, and weights pace by distance',()=>{
 const days=indexRunDays([record('a','2026-10-05',1000,300),record('b','2026-10-05',3000,1500),record('c','2026-10-06',2000,900),record('d','2026-09-30',500)],'2026-11-07');
 const october=monthSummary(days,'2026-10');
 assert.equal(october.runCount,3);assert.equal(october.dayCount,2);assert.equal(october.distanceMeters,6000);
 assert.equal(october.paceSecondsPerKm,450);assert.equal(october.longest.date,'2026-10-05');
 assert.equal(days.get('2026-10-05').level,3);assert.equal(days.get('2026-10-05').runs.length,2);
 const empty=monthSummary(days,'2026-11');assert.equal(empty.dayCount,0);assert.equal(empty.paceSecondsPerKm,null);assert.equal(empty.longest,null);
});
test('invalid, future and non-running records do not create calendar contributions',()=>{
 const days=indexRunDays([null,record('bad','2026-02-30',500),record('zero','2026-10-05',0),record('negative','2026-10-05',-5),record('bad-distance','2026-10-05',NaN),record('bad-duration','2026-10-05',100,-1),record('future','2026-11-08',200),record('valid','2026-11-07',5)],'2026-11-07');
 assert.deepEqual([...days.keys()],['2026-11-07']);assert.equal(days.get('2026-11-07').level,1);
});
test('distance colors have stable boundaries across months and preserve very short runs',()=>{
 assert.deepEqual([0,1,1999,2000,3999,4000,5999,6000,20000].map(distanceLevel),[0,1,1,2,2,3,3,4,4]);
 for(const invalid of [undefined,NaN,Infinity,-1])assert.equal(distanceLevel(invalid),0);
});
test('calendar preserves leap days, Monday rows, month boundaries, and year rollover',()=>{
 assert.equal(shiftMonth('2026-12',1),'2027-01');assert.equal(shiftMonth('2026-01',-1),'2025-12');
 assert.throws(()=>shiftMonth('2026-13',1));
 const window=calendarWindow(new Map(),'2024-02',{today:'2024-02-10'});
 const valid=window.cells.filter(c=>!c.outside);
 assert.equal(valid[0].date,'2023-12-01');assert.equal(valid.at(-1).date,'2024-02-29');assert.equal(valid.length,91);
 assert.equal(new Date(window.cells[0].date+'T12:00:00Z').getUTCDay(),1);
 assert.equal(window.cells.find(c=>c.date==='2024-02-10').future,false);
 assert.equal(window.cells.find(c=>c.date==='2024-02-11').future,true);
 assert.equal(window.cells.length,window.weeks*7);assert.equal(new Set(window.cells.map(c=>c.date)).size,window.cells.length);
 const short=calendarWindow(new Map(),'2026-10',{months:2,today:'2026-11-07'});
 assert.equal(short.first,'2026-09-01');assert.equal(short.last,'2026-10-31');
 assert.deepEqual(short.labels.map(x=>x.label),['9月','10月']);
 assert.equal(initialRunningMonth(new Map(),'2026-11-07'),'2026-11');
});
test('automatic themes follow Japan time at all boundaries, independently of host timezone',()=>{
 for(const [time,expected] of [['04:59:59','night'],['05:00:00','morning'],['10:59:59','morning'],['11:00:00','day'],['17:59:59','day'],['18:00:00','night'],['23:59:59','night'],['00:00:00','night']]) assert.equal(themeAt(new Date('2026-11-07T'+time+'+09:00')),expected,time);
 assert.equal(themeAt(new Date('2026-11-06T20:00:00Z')),'morning');
});
function fakeDocument(){const doc=new EventTarget();doc.documentElement={dataset:{}};doc.defaultView=new EventTarget();doc.querySelector=()=>({setAttribute(){}});doc.visibilityState='visible';return doc;}
test('theme mode persists explicitly, refreshes on return, and a manual theme stays fixed',()=>{
 const document=fakeDocument();let now=new Date('2026-11-07T10:00:00+09:00');const values=new Map(),changes=[];
 const controller=createThemeController({document,now:()=>now,storage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},onChange:s=>changes.push(s.active)});
 try{
  assert.equal(controller.get().active,'morning');now=new Date('2026-11-07T12:00:00+09:00');document.dispatchEvent(new Event('visibilitychange'));assert.equal(controller.get().active,'day');
  assert.equal(controller.set('morning'),true);now=new Date('2026-11-07T20:00:00+09:00');controller.refresh();assert.equal(controller.get().active,'morning');
  assert.equal(controller.set('auto'),true);assert.equal(controller.get().active,'night');assert.equal(JSON.parse(values.get('mypace.theme.v2')).mode,'auto');
  assert.equal(controller.set('unknown'),false);assert.equal(controller.get().mode,'auto');assert.deepEqual(changes,['morning','day','morning','night']);
 }finally{controller.destroy();}
});
test('unavailable storage still permits an in-memory theme and unknown settings are not overwritten',()=>{
 let writes=0;const controller=createThemeController({document:fakeDocument(),now:()=>new Date('2026-11-07T12:00:00+09:00'),storage:{getItem:()=>'{future format}',setItem(){writes++;throw new Error('full');}}});
 try{assert.equal(controller.get().mode,'auto');assert.equal(writes,0);assert.equal(controller.set('night'),false);assert.equal(controller.get().active,'night');}finally{controller.destroy();}
});

test('annual calendar includes all leap days and split halves contain each date once',()=>{
 for(const year of [2024,2025,2026]){
  const days=new Map(),today='2026-11-08';
  const annual=calendarWindow(days,`${year}-12`,{months:12,today});
  const valid=annual.cells.filter(c=>!c.outside).map(c=>c.date);
  const halves=['06','12'].flatMap(month=>calendarWindow(days,`${year}-${month}`,{months:6,today}).cells.filter(c=>!c.outside).map(c=>c.date));
  assert.equal(valid.length,year===2024?366:365);assert.deepEqual(halves,valid);
  assert.equal(annual.labels.length,12);assert.equal(new Set(halves).size,valid.length);
 }
});
test('day navigation includes empty days and crosses month/year boundaries with day clamping',async()=>{
 const {shiftDay,dayInMonth}=await import('../lib/running-calendar.js');
 assert.equal(shiftDay('2026-12-31',1),'2027-01-01');assert.equal(shiftDay('2024-03-01',-1),'2024-02-29');
 assert.equal(dayInMonth('2026-01-31','2026-02','2026-11-08'),'2026-02-28');
 assert.equal(dayInMonth('2026-10-15','2026-11','2026-11-08'),'2026-11-08');
});
