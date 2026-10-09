/** App integration with a minimal DOM/event double, not real-browser map or layout QA.
 * Raw route paging was removed. These tests exercise the prepared daily read wiring.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {launch} from './helpers/auth-ui-harness.mjs';
import {indexedDBDouble} from './helpers/indexeddb-double.js';
import {createInitialState,addDays} from '../src/lib/domain.js';
import {stateToEntities} from '../src/lib/entity-codec.js';
import {runningDayKey} from '../src/lib/daily-running.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate,label){for(let i=0;i<100&&!predicate();i++)await tick();assert.ok(predicate(),label);}
const ready=(date,distanceMeters=7777)=>({schema:1,store:'owner',generation:'generation',date,status:'ready',hash:`prepared-${date}-${distanceMeters}`,pending:false,summary:{distanceMeters,durationSeconds:3661,averageSpeedKmh:12.3},segments:[{points:[[35,139],[35.001,139.001]],colors:['#112233']} ]});
function fixture(){
 const initial=createInitialState();initial.runs=[{id:'legacy',date:runningDayKey(),distanceKm:987,durationSec:12,note:'private legacy note',points:[{lat:36,lon:140,segment:0}]}];
 const idb=indexedDBDouble({format:1,store:'owner',generation:'generation',epoch:'epoch',revision:1,entities:Object.fromEntries(Object.entries(stateToEntities(initial)).map(([key,value])=>[key,{key,value,version:1,deleted:false}])),outbox:[],conflicts:[],importedRuns:[],importStatus:null});
 const net={initial,idb,requests:[],pending:[],delayDaily:false,snapshotGate:null};
 net.fetcher=async(path,options)=>{
  if(path==='/api/auth/session')return Response.json({ok:true,authenticated:true,csrf:'test'});
  if(path==='/api/auth/logout')return Response.json({ok:true});
  const body=JSON.parse(options.body);net.requests.push(body);let result;
  if(body.action==='dailyRun'){
   if(net.delayDaily){const wait=deferred();net.pending.push({body,resolve:daily=>wait.resolve(Response.json({ok:true,result:daily}))});return wait.promise;}
   result=ready(body.payload.date);
  }else if(body.action==='snapshot'){
   if(net.snapshotGate)await net.snapshotGate.promise;
   const cached=idb.read();result={store:cached.store,generation:cached.generation,epoch:cached.epoch,revision:cached.revision,entities:Object.values(cached.entities),cursor:null};
  }else if(body.action==='imports')result={revision:1,runs:[],nextCursor:null};
  else if(body.action==='importStatus')result={status:'idle'};
  else throw Error('Unexpected action '+body.action);
  return Response.json({ok:true,result});
 };
 return net;
}
const dailyCalls=net=>net.requests.filter(request=>request.action==='dailyRun');
function assertReadOnly(ui,net,legacy){
 assert.equal(ui.raw,legacy);assert.equal(ui.writes,0);assert.equal(net.idb.read().outbox.length,0);
 assert.ok(net.requests.every(request=>!['route','command','import','importStart','triggerImport'].includes(request.action)));
}

test('authenticated running renders one prepared read before legacy sync finishes, using only server summary values',async t=>{
 const net=fixture();net.snapshotGate=deferred();
 const opening=launch(t,{initial:net.initial,idb:net.idb,fetcher:net.fetcher,modePreference:'cloud',hash:'#running',timers:[]});
 await until(()=>net.requests.some(request=>request.action==='snapshot'),'legacy snapshot is pending');
 await until(()=>document.querySelector('#app').innerHTML.includes('7.78<small>km'),'prepared summary renders while ordinary sync is busy');
 assert.equal(dailyCalls(net).length,1);assert.deepEqual(dailyCalls(net)[0].payload,{date:runningDayKey(),knownHash:null});
 net.snapshotGate.resolve();const ui=await opening,legacy=ui.raw;
 assert.match(ui.app.innerHTML,/12\.3<small>km\/h/);assert.match(ui.app.innerHTML,/01:01:01/);assert.match(ui.app.innerHTML,/data-route-map=/);
 assert.doesNotMatch(ui.app.innerHTML,/987\.00|private legacy note|run-add|cloud-route|gpx-import/);
 assert.equal(dailyCalls(net).length,1);assert.equal(ui.editor.open,false);assertReadOnly(ui,net,legacy);
});

test('newer date selection wins over an older delayed daily response and repeated selection is deduplicated',async t=>{
 const net=fixture(),ui=await launch(t,{initial:net.initial,idb:net.idb,fetcher:net.fetcher,modePreference:'cloud',hash:'#running',timers:[]}),legacy=ui.raw;
 net.delayDaily=true;const oldDate=addDays(runningDayKey(),-1),newDate=addDays(runningDayKey(),-2);
 await ui.changeDate(oldDate);await ui.changeDate(newDate);await ui.changeDate(newDate);
 assert.equal(net.pending.length,2);assert.equal(ui.editor.open,false);assert.match(ui.app.innerHTML,/記録を読み込み中/);
 net.pending[1].resolve(ready(newDate,2222));await until(()=>ui.app.innerHTML.includes('2.22<small>km'),'newer date resolves');
 net.pending[0].resolve(ready(oldDate,1111));await tick();await tick();
 assert.match(ui.app.innerHTML,/2\.22<small>km/);assert.doesNotMatch(ui.app.innerHTML,/1\.11<small>km/);
 assert.match(ui.app.innerHTML,new RegExp(`id="selected-date"[^>]*value="${newDate}"`));assertReadOnly(ui,net,legacy);
});

test('navigation cancels the selected daily read and stale completion cannot replace a newer diary editor',async t=>{
 const net=fixture(),ui=await launch(t,{initial:net.initial,idb:net.idb,fetcher:net.fetcher,modePreference:'cloud',hash:'#running',timers:[]}),legacy=ui.raw;
 net.delayDaily=true;const date=addDays(runningDayKey(),-1);await ui.changeDate(date);assert.equal(net.pending.length,1);
 await ui.changeHash('#diary');await ui.click('diary-edit');const draft=ui.editor.innerHTML;
 net.pending[0].resolve(ready(date,1111));await tick();await tick();
 assert.equal(ui.editor.open,true);assert.equal(ui.editor.innerHTML,draft);assert.match(ui.app.innerHTML,/<h1>日記<\/h1>/);assert.doesNotMatch(ui.app.innerHTML,/daily-running-stats/);assertReadOnly(ui,net,legacy);
});

test('logout hides prepared data immediately and a pending refresh cannot display it again',async t=>{
 const net=fixture(),ui=await launch(t,{initial:net.initial,idb:net.idb,fetcher:net.fetcher,modePreference:'cloud',hash:'#running',timers:[]}),legacy=ui.raw;
 await until(()=>ui.app.innerHTML.includes('7.78<small>km'),'initial daily read is visible');
 net.delayDaily=true;const refresh=ui.click('daily-retry');await until(()=>net.pending.length===1,'explicit refresh is pending');
 await ui.click('cloud-logout');assert.doesNotMatch(ui.app.innerHTML,/daily-running-stats|data-route-map=/);assert.match(ui.app.innerHTML,/Google でログインすると記録を表示できます/);
 net.pending[0].resolve(ready(runningDayKey(),8888));await refresh;await tick();
 assert.equal(ui.editor.open,false);assert.doesNotMatch(ui.app.innerHTML,/8\.89<small>km|daily-running-stats|data-route-map=/);assert.match(ui.app.innerHTML,/Google でログインすると記録を表示できます/);assertReadOnly(ui,net,legacy);
});

test('explicit local mode never starts a prepared daily read or exposes stored legacy runs',async t=>{
 const net=fixture(),ui=await launch(t,{initial:net.initial,idb:net.idb,fetcher:net.fetcher,modePreference:'local',hash:'#running',timers:[]}),legacy=ui.raw;
 assert.equal(dailyCalls(net).length,0);assert.doesNotMatch(ui.app.innerHTML,/987\.00|private legacy note|daily-running-stats/);
 for(const action of ['cloud-route','cloud-route-next','run-add','gpx-import'])await ui.click(action,{id:'legacy'});
 assert.equal(dailyCalls(net).length,0);assert.equal(ui.editor.open,false);assert.equal(ui.fileInput(),undefined);assertReadOnly(ui,net,legacy);
});
for(const timezone of ['Pacific/Honolulu','Asia/Tokyo'])test(`running default and today action use03:00JST while diary keeps device dates (${timezone})`,async t=>{
 const NativeDate=globalThis.Date,oldTZ=process.env.TZ,instant=NativeDate.parse('2026-10-09T17:00:00Z');
 process.env.TZ=timezone;globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[instant]));}static now(){return instant;}};
 t.after(()=>{globalThis.Date=NativeDate;if(oldTZ===undefined)delete process.env.TZ;else process.env.TZ=oldTZ;});
 const ui=await launch(t,{hash:'#running',modePreference:'local',timers:[]});
 const selected=()=>ui.app.innerHTML.match(/id="selected-date"[^>]*value="([^"]+)"/)[1];
 assert.equal(selected(),'2026-10-09','02:00JST still belongs to the previous start date');
 await ui.changeDate('2026-10-08');assert.equal(selected(),'2026-10-08');await ui.click('today');assert.equal(selected(),'2026-10-09');
 await ui.changeHash('#diary');await ui.click('today');assert.equal(selected(),timezone==='Asia/Tokyo'?'2026-10-10':'2026-10-09');
 await ui.changeHash('#running');await ui.click('today');assert.equal(selected(),'2026-10-09');
});
