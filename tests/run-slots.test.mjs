import test from 'node:test';
import assert from 'node:assert/strict';
import { runSlotModel, runSlotWindow, routeThumbnailPaths } from '../lib/run-slots.js';
import { runningSelectionData } from '../lib/running-view.js';
import { indexRunDays } from '../lib/running-calendar.js';

const run=(id,date,distanceMeters=1000,durationSeconds=600)=>({id,date,summary:{distanceMeters,durationSeconds,paceSecondsPerKm:durationSeconds/(distanceMeters/1000)}});
const records=[run('sep','2026-09-30'),run('a','2026-10-05'),run('b','2026-10-09'),run('c','2026-10-15',2000,1000),run('d','2026-10-15',3000,1200)];
const days=indexRunDays(records,'2026-11-08');

test('the reel browses recorded days across months without duplicating multi-run days',()=>{
 const model=runSlotModel({days,month:'2026-10',selectedDay:'2026-10-05'});
 assert.equal(model.previous,'2026-09-30');assert.equal(model.next,'2026-10-09');assert.equal(model.current.runs[0].id,'a');
 const last=runSlotModel({days,month:'2026-10',selectedDay:'2026-10-15'});
 assert.equal(last.next,null);assert.equal(last.current.distanceMeters,5000);assert.equal(last.dates.length,4);
 const first=runSlotModel({days,month:'2026-09',selectedDay:'2026-09-30'});assert.equal(first.previous,null);
});

test('an empty day sits between real runs; an empty month never borrows a different month’s selected day',()=>{
 const empty=runSlotModel({days,month:'2026-10',selectedDay:'2026-10-10'});
 assert.equal(empty.anchor,'2026-10-10');assert.equal(empty.current,null);assert.equal(empty.previous,'2026-10-09');assert.equal(empty.next,'2026-10-15');
 const remembered=runSlotModel({days,month:'2026-10',lastSelectedDay:'2026-10-09'});assert.equal(remembered.anchor,'2026-10-09');assert(remembered.monthly);
 const otherMonth=runSlotModel({days,month:'2026-09',lastSelectedDay:'2026-10-15'});assert.equal(otherMonth.anchor,'2026-09-30');
 const noMonth=runSlotModel({days,month:'2026-11',lastSelectedDay:'2026-10-15'});assert.equal(noMonth.current,null);assert.equal(noMonth.anchor,'2026-11-01');assert.equal(noMonth.previous,'2026-10-15');
 const noData=runSlotModel({days:new Map(),month:'2026-11'});assert.equal(noData.previous,null);assert.equal(noData.next,null);
});

test('the visible window fills both ends with recorded days and keeps the selected date visible',()=>{
 const dates=Array.from({length:12},(_,i)=>`2026-10-${String(i+1).padStart(2,'0')}`);
 const many=indexRunDays(dates.map((date,i)=>run(`window-${i}`,date)),'2026-11-08');
 const window=(date,count=5)=>runSlotWindow({days:many,month:'2026-10',selectedDay:date},count).visible;
 assert.deepEqual(window(dates[0]),dates.slice(0,5));
 assert.deepEqual(window(dates.at(-1)),dates.slice(-5));
 assert.deepEqual(window(dates[5]),dates.slice(3,8));
 assert.deepEqual(window(dates[5],7),dates.slice(2,9));
 const sparse=runSlotWindow({days,month:'2026-10',selectedDay:'2026-10-15'},7);
 assert.deepEqual(sparse.visible,[...days.keys()].sort(),'short histories use all real rows, without blank future slots');
 const empty=runSlotWindow({days,month:'2026-10',selectedDay:'2026-10-10'});
 assert(empty.visible.includes('2026-10-10'));assert.equal(empty.current,null);
 assert.deepEqual(runSlotWindow({days:new Map(),month:'2026-11'}).visible,['2026-11-01']);
});

test('floating summaries keep the displayed day/month totals when individual run analysis is open',()=>{
 const stats=new Map(records.map((r,i)=>[r.id,{total:1000,fresh:100*(i+1)}]));
 const context={days,month:'2026-10',selectedDay:'2026-10-15',explorationStats:stats};
 const day=runningSelectionData(context);assert.equal(day.count,2);assert.equal(day.metrics.distanceMeters,5000);assert.equal(day.metrics.durationSeconds,2200);assert.equal(day.metrics.paceSecondsPerKm,440);assert.equal(day.fresh,900);
 const month=runningSelectionData({...context,selectedDay:null});assert.equal(month.count,4);assert.equal(month.metrics.distanceMeters,7000);assert.equal(month.fresh,1400);
 const expanded=runningSelectionData({...context,logExpanded:true,selectedRunId:records[3].id});assert.deepEqual(expanded,day);
 assert.equal(runningSelectionData({...context,selectedDay:'2026-10-10'}).count,0);
 assert.equal(runningSelectionData({...context,explorationStats:new Map()}).fresh,null,'missing GPS is not a zero-distance discovery');
 assert.equal(runningSelectionData({...context,explorationStats:new Map([['c',{total:2000,fresh:0}],['d',{total:3000,fresh:0}]])}).fresh,0);
});

test('thumbnails preserve separate GPS pieces, aspect ratio, north and input data',()=>{
 const source=[{segments:[{points:[[0,0],[0,.001],null,[.001,.001],[.002,.001]]}]}],before=structuredClone(source);
 const paths=routeThumbnailPaths(source);assert.equal(paths.length,2);assert.deepEqual(source,before);
 const parse=d=>[...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map(m=>[Number(m[1]),Number(m[2])]);
 const east=parse(paths[0]),north=parse(paths[1]);
 assert(east.at(-1)[0]>east[0][0]);assert.equal(east.at(-1)[1],east[0][1]);assert(north.at(-1)[1]<north[0][1]);
 assert(Math.abs((east.at(-1)[0]-east[0][0])-(north[0][1]-north.at(-1)[1]))<.03);
 assert.deepEqual(routeThumbnailPaths([]),[]);
 const dateLine=routeThumbnailPaths([{segments:[{points:[[0,179.9995],[0,-179.9995]]}]}]);assert.equal(dateLine.length,1);
 for(const p of parse(dateLine[0]))assert(p[0]>=6&&p[0]<=66&&p[1]>=6&&p[1]<=46);
 assert.equal(routeThumbnailPaths([{segments:[{points:[[0,0],[0,.02]]}]}]).length,2,'long GPS jump must not draw a fake connection');
});
