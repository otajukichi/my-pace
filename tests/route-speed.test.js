import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRouteModel,speedColor,ROUTE_LIMITS} from '../src/lib/route-speed.js';
import {renderRunning} from '../src/views/running.js';
import {createInitialState} from '../src/lib/domain.js';
const p=(lat,sec,extra={})=>({lat,lon:0,time:typeof sec==='number'?new Date(Date.UTC(2026,9,9,0,0,sec)).toISOString():sec,...extra});
test('speed is derived in km/h from UTC elapsed seconds, never undocumented CSV speed',()=>{
 const points=[p(0,0,{speed:999}),p(.001,40,{speed:999})],before=JSON.stringify(points),m=buildRouteModel(points);
 assert.equal(m.known,1);assert.ok(Math.abs(m.edges[0].speed-10.00756)<.001);assert.equal(JSON.stringify(points),before);
 assert.equal(buildRouteModel([p(0,0),p(.001,40,{time:'2026-10-09T09:00:40+09:00'})]).edges[0].speed,m.edges[0].speed);
});
test('missing or numeric time is unknown, not zero-speed; unknown CSV speed is ignored',()=>{
 for(const t of [undefined,null,1791504000000,'2026-10-09T00:00:00']){
  const m=buildRouteModel([p(0,t),p(.001,t,{speed:100})]);assert.equal(m.unknown,1);assert.equal(m.edges[0].speed,null);assert.equal(m.edges[0].color,'#718096');
 }
 const stationary=buildRouteModel([p(0,0),p(0,1)]);assert.equal(stationary.edges[0].speed,0);
});
test('segments, invalid coordinates, missing intervals, backwards and duplicate time never bridge',()=>{
 for(const points of [[p(0,0,{segment:0}),p(.001,20,{segment:1})],[p(0,0),p(99,10),p(.001,20)],[p(0,0),p(.001,61)],[p(0,1),p(.001,0)],[p(0,0),p(.001,0)],[p(0,0),p(1,1)]]){
  const m=buildRouteModel(points);assert.equal(m.edges.length,0);assert.ok(m.gaps>0);
 }
});
test('palette interpolates continuously, uses fixed endpoints and clamps high values',()=>{
 assert.equal(speedColor(0),'#315b9b');assert.equal(speedColor(24),'#d36b40');assert.equal(speedColor(45),speedColor(24));assert.notEqual(speedColor(7),speedColor(8));assert.equal(speedColor(null),'#718096');
});
test('bounded simplification retains gaps and dateline adjacency',()=>{
 const points=Array.from({length:20000},(_,i)=>p(i*.00001,i,{segment:i<10000?0:1}));
 const m=buildRouteModel(points);assert.ok(m.edges.length<=ROUTE_LIMITS.edges);assert.equal(m.gaps,1);assert.ok(m.simplified);assert.ok(m.edges.every(x=>!(x.a[0]<.1&&x.b[0]>=.1)));
 const d=buildRouteModel([p(0,undefined,{lon:179.999}),p(0,undefined,{lon:-179.999})]);assert.ok(Math.abs(d.edges[0].b[1]-d.edges[0].a[1])<.01);
 assert.equal(buildRouteModel([]).edges.length,0);assert.equal(buildRouteModel([p(0,0)]).locations.length,1);
});
test('day view renders only the prepared daily map and summary, leaving legacy GPS untouched',()=>{
 const state=createInitialState();state.runs=Array.from({length:5},(_,i)=>({id:`run-${i}`,date:'2026-10-09',distanceKm:99,durationSec:300,points:[p(0,0),p(.001,40)]}));
 const daily={status:'ready',store:'s',generation:'g',date:'2026-10-09',hash:'h',pending:false,summary:{distanceMeters:2100,durationSeconds:700,averageSpeedKmh:10.8},segments:[{points:[[35,139],[35.001,139.001]],colors:['#112233']}]};
 const before=structuredClone({state,daily}),html=renderRunning({state,date:'2026-10-09',today:'2026-10-09',dailyView:{status:'ready',daily}});
 assert.equal((html.match(/data-route-map=/g)||[]).length,1);assert.match(html,/2\.10<small>km/);assert.match(html,/10\.8<small>km\/h/);
 assert.match(html,/サーバーで準備した値をそのまま表示/);assert.match(html,/日本時間の午前3時/);
 assert.doesNotMatch(html,/run-edit|cloud-route|GPX|最初のサンプルの日付|99\.00/);assert.deepEqual({state,daily},before);
});
