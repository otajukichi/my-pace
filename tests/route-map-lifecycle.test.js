import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {routeMap,preparedRouteMap,mountRouteMaps,updateRouteMap,disposeRouteMaps,discardRouteMapRegistration,reusePreparedRouteMap} from '../src/lib/route-map.js';
const points=[{lat:35,lon:139,time:'2026-10-09T00:00:00Z'},{lat:35.0001,lon:139,time:'2026-10-09T00:00:05Z'}];
const daily={schema:1,store:'store-a',generation:'generation-a',date:'2026-10-09',hash:'hash-a',summary:{distanceMeters:1234,durationSeconds:543,averageSpeedKmh:8.2},segments:[
 {sourceKey:'file-a',points:[[35,139],[35.0001,139],[35.0002,139]],colors:['#315b9b','#49a677']},
 {sourceKey:'file-a',points:[[35.0004,139],[35.0005,139]],colors:['#d36b40']},
 {sourceKey:'file-b',points:[[35.0005,139],[35.0006,139]],colors:['#258b9a']}
]};
function fixture({markup=preparedRouteMap(daily,'owner/store/generation/2026-10-09/hash-a'),width=800,height=420}={}){
 const calls={tiles:[],maps:[],lines:[],markers:[],fits:[],events:[],observers:[],frames:[]},nodes=new Map();
 const size={width,height};
 const node=name=>{
  if(!nodes.has(name))nodes.set(name,{listeners:{},textContent:'',setAttribute(){},querySelector:()=>node('zoom'),addEventListener(name,fn){this.listeners[name]=fn;},removeEventListener(name,fn){if(this.listeners[name]===fn)delete this.listeners[name];}});
  return nodes.get(name);
 };
 const canvas=node('.route-canvas');
 Object.defineProperties(canvas,{clientWidth:{get:()=>size.width},clientHeight:{get:()=>size.height}});
 canvas.getBoundingClientRect=()=>({...size});
 const element={isConnected:true,dataset:{routeMap:markup.match(/data-route-map="([^"]+)"/)?.[1]},querySelector:node};
 const root={querySelectorAll:()=>[element],querySelector:()=>element,contains:e=>e===element};
 class ResizeObserver{constructor(callback){this.callback=callback;this.disconnected=false;calls.observers.push(this);}observe(target){this.target=target;}disconnect(){this.disconnected=true;}fire(){this.callback([{target:this.target,contentRect:{...size}}]);}}
 const L={
  map(target,options){
   const map={removed:false,options,view:null,attributionControl:{setPrefix(){}},zoomControl:{setPosition(){}},
    invalidateSize(options){calls.events.push({kind:'invalidate',options,size:{...size}});},setMinZoom(value){this.minZoom=value;},removeLayer(){},
    fitBounds(bounds,options){calls.events.push({kind:'fit'});calls.fits.push({bounds,options,size:{...size}});this.view={bounds,options};},remove(){this.removed=true;}};
   calls.maps.push(map);return map;
  },canvas:()=>({}),layerGroup:()=>({addTo(){return this;},clearLayers(){}}),
  polyline(path,options){calls.lines.push({path,options});return {addTo(){return this;}};},
  circleMarker(position,options){const marker={position,options};calls.markers.push(marker);return {addTo(){return this;},bindTooltip(text){marker.tooltip=text;return this;}};},
  latLngBounds:p=>p,
  tileLayer(url,options){const tile={url,options,listeners:{},addTo(){return this;},on(name,fn){this.listeners[name]=fn;return this;},redraw(){this.listeners.loading();}};calls.tiles.push(tile);return tile;}
 };
 return {calls,nodes,node,element,root,L,ResizeObserver,size,markup};
}
function withGlobals(f,run){
 const old={L:globalThis.L,ResizeObserver:globalThis.ResizeObserver,requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame};
 Object.assign(globalThis,{L:f.L,ResizeObserver:f.ResizeObserver,requestAnimationFrame:callback=>{f.calls.frames.push(callback);return f.calls.frames.length;},cancelAnimationFrame:id=>{f.calls.frames[id-1]=null;}});
 try{return run();}finally{disposeRouteMaps(f.root);Object.assign(globalThis,old);}
}
test('prepared map renders every file and break with backend colors and fragment markers',()=>{
 const before=structuredClone(daily),f=fixture();
 withGlobals(f,()=>{
  mountRouteMaps(f.root);
  assert.deepEqual(f.calls.lines.map(line=>line.options.color),['#315b9b','#49a677','#d36b40','#258b9a']);
  assert.deepEqual(f.calls.lines.map(line=>line.path),[
   [[35,139],[35.0001,139]],[[35.0001,139],[35.0002,139]],[[35.0004,139],[35.0005,139]],[[35.0005,139],[35.0006,139]]
  ]);
  assert.equal(f.calls.markers.length,6,'every backend fragment has independent start/end markers');
  assert.deepEqual(f.calls.fits[0].bounds,daily.segments.flatMap(segment=>segment.points));
  assert.ok(f.calls.lines.every(line=>line.options.dashArray===null));
  assert.deepEqual(daily,before,'rendering never mutates the prepared record');
  assert.match(f.markup,/data-map-identity="owner\/store/);
  assert.doesNotMatch(f.markup,/速度不明|速度を区間平均/);
 });
});
test('prepared drawing path has no browser statistics or speed calculation dependency',()=>{
 const source=readFileSync(new URL('../src/lib/route-map.js',import.meta.url),'utf8');
 const adapter=source.slice(source.indexOf('function preparedModel'),source.indexOf('function legacyModel'));
 assert.doesNotMatch(adapter,/buildRouteModel|haversine|Date\.parse|durationSeconds|distanceMeters|averageSpeedKmh|speedColor/);
 const method=source.slice(source.indexOf('export function preparedRouteMap'),source.indexOf('// Legacy exports'));
 assert.doesNotMatch(method,/buildRouteModel|legacyModel/);
});
test('visible map uses OSM automatically, no low-zoom cap, and fits the actual canvas after invalidation',()=>{
 const f=fixture();
 withGlobals(f,()=>{
  mountRouteMaps(f.root);
  assert.equal(f.calls.maps.length,1);assert.equal(f.calls.tiles.length,1);
  assert.equal(f.calls.tiles[0].url,'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.equal(f.calls.tiles[0].options.keepBuffer,0);assert.equal(f.calls.tiles[0].options.maxNativeZoom,19);
  assert.equal(f.calls.maps[0].options.minZoom,1);
  assert.equal(f.calls.fits.length,1);
  assert.deepEqual(f.calls.fits[0].size,{width:800,height:420});
  assert.deepEqual(f.calls.events.slice(0,2).map(event=>event.kind),['invalidate','fit']);
  assert.deepEqual(f.calls.events[0].options,{pan:false,animate:false});
  assert.equal(Object.hasOwn(f.calls.fits[0].options,'maxZoom'),false,'nondegenerate routes may zoom beyond 16');
  assert.deepEqual(f.calls.fits[0].options.padding,[24,24]);
  f.node('[data-map-provider]').listeners.change({target:{value:'gsi'}});
  assert.equal(f.calls.tiles.length,2);assert.equal(f.calls.tiles[1].url,'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png');
  assert.equal(f.calls.tiles[1].options.minZoom,9);assert.equal(f.calls.tiles[1].options.maxNativeZoom,18);
  assert.equal(f.calls.fits.length,1,'changing the provider does not fit again');
 });
});
test('hidden canvas waits for its first real size and later resizes preserve the viewport',()=>{
 const f=fixture({width:0,height:0});
 withGlobals(f,()=>{
  mountRouteMaps(f.root);assert.equal(f.calls.fits.length,0);
  f.calls.frames[0]();assert.equal(f.calls.fits.length,0);
  f.calls.observers[0].fire();assert.equal(f.calls.fits.length,0);
  f.size.width=620;f.size.height=350;f.calls.observers[0].fire();
  assert.equal(f.calls.fits.length,1);assert.deepEqual(f.calls.fits[0].size,{width:620,height:350});
  const userView={center:[35.5,139.5],zoom:18};f.calls.maps[0].view=userView;
  f.size.width=400;f.size.height=280;f.calls.observers[0].fire();
  assert.equal(f.calls.fits.length,1);assert.equal(f.calls.maps[0].view,userView);
  assert.deepEqual(f.calls.events.at(-1),{kind:'invalidate',options:{pan:false,animate:false},size:{width:400,height:280}});
 });
});
test('reinserted map retains map, tile, provider, pan and zoom across advisory renders',()=>{
 const f=fixture();
 withGlobals(f,()=>{
  mountRouteMaps(f.root);
  f.node('[data-map-provider]').listeners.change({target:{value:'gsi'}});
  const userView={center:[35.5,139.5],zoom:18};f.calls.maps[0].view=userView;
  const replacement=fixture();discardRouteMapRegistration(replacement.element);
  // The app reuses the old DOM element before the mount/disposal pass.
  f.element.isConnected=false;f.element.isConnected=true;mountRouteMaps(f.root);
  f.calls.frames[0]();f.calls.observers[0].fire();
  assert.equal(f.calls.maps.length,1);assert.equal(f.calls.tiles.length,2);assert.equal(f.calls.fits.length,1);
  assert.equal(f.calls.maps[0].view,userView);assert.equal(f.calls.maps[0].minZoom,9);
  mountRouteMaps(replacement.root);assert.equal(f.calls.maps.length,1,'discarded fresh registration cannot accidentally mount');
  f.node('[data-map-fit]').listeners.click();assert.equal(f.calls.fits.length,2,'explicit fit is still available');
 });
});
test('a new identity mounts a fresh map and disconnected map cleans observer and scheduled layout',()=>{
 const f=fixture();
 withGlobals(f,()=>{
  mountRouteMaps(f.root);const oldMap=f.calls.maps[0],oldObserver=f.calls.observers[0],oldFrame=f.calls.frames[0];
  f.element.isConnected=false;
  const next=fixture({markup:preparedRouteMap({...daily,date:'2026-10-10',hash:'hash-b'},'owner/store/generation/2026-10-10/hash-b')});
  mountRouteMaps(next.root);
  assert.equal(oldMap.removed,true);assert.equal(oldObserver.disconnected,true);assert.equal(f.calls.frames[0],null);
  assert.equal(f.calls.maps.length,2);assert.equal(f.calls.fits.length,2);
  oldObserver.fire();oldFrame();assert.equal(f.calls.fits.length,2,'late callbacks cannot revive a disposed map');
  disposeRouteMaps(next.root);
 });
});
test('one-point fragments use sensible point zoom and still get both endpoint markers',()=>{
 const f=fixture({markup:preparedRouteMap({...daily,segments:[{sourceKey:'one',points:[[35,139]],colors:[]}]})});
 withGlobals(f,()=>{
  mountRouteMaps(f.root);assert.equal(f.calls.lines.length,0);assert.equal(f.calls.markers.length,2);
  assert.equal(f.calls.fits[0].options.maxZoom,17);
 });
});
test('date-line fragments stay locally bounded without joining breaks or changing supplied colors',()=>{
 const f=fixture({markup:preparedRouteMap({...daily,segments:[
  {sourceKey:'east',points:[[10,179.999],[10,-179.999]],colors:['#d6b343']},
  {sourceKey:'west',points:[[10,-179.998],[10,-179.997]],colors:['#49a677']}
 ]})});
 withGlobals(f,()=>{
  mountRouteMaps(f.root);
  const longitudes=f.calls.fits[0].bounds.map(point=>point[1]);
  assert.ok(Math.max(...longitudes)-Math.min(...longitudes)<0.01);
  assert.equal(f.calls.lines.length,2);assert.equal(f.calls.markers.length,4);
  assert.deepEqual(f.calls.lines.map(line=>line.options.color),['#d6b343','#49a677']);
 });
});
test('malformed coordinates or missing colors cannot create a line across a break',()=>{
 const f=fixture({markup:preparedRouteMap({...daily,segments:[
  {sourceKey:'bad',points:[[35,139],[NaN,139],[35.1,139]],colors:['#315b9b','#315b9b']},
  {sourceKey:'missing',points:[[36,139],[36.1,139]],colors:[]}
 ]})});
 withGlobals(f,()=>{mountRouteMaps(f.root);assert.equal(f.calls.lines.length,0);assert.equal(f.calls.markers.length,8);});
 assert.equal(preparedRouteMap({...daily,segments:[]}), '');
});
test('all supplied fragments survive without inherited route-model display limits',()=>{
 const segments=Array.from({length:1810},(_,index)=>({sourceKey:`source-${index}`,points:[[35+index/1e6,139],[35+(index+0.5)/1e6,139]],colors:['#315b9b']}));
 const f=fixture({markup:preparedRouteMap({...daily,segments})});
 withGlobals(f,()=>{mountRouteMaps(f.root);assert.equal(f.calls.lines.length,1810);assert.equal(f.calls.markers.length,3620);});
});
test('tile failure stays honest until retry; stale tile callbacks and route data never reach providers',()=>{
 const f=fixture();
 withGlobals(f,()=>{
  mountRouteMaps(f.root);const tile=f.calls.tiles[0],status=f.node('.route-map-status');
  tile.listeners.tileerror();tile.listeners.load();assert.match(status.textContent,/取得できません/);
  f.node('[data-map-tiles]').listeners.click();assert.match(status.textContent,/再読み込み中/);
  tile.listeners.load();assert.match(status.textContent,/準備済みのルート/);assert.match(status.textContent,/OpenStreetMapを表示中/);
  assert.doesNotMatch(tile.url,/35|139|2026|source|hash/);assert.equal(tile.options.updateWhenZooming,false);assert.equal(tile.options.detectRetina,false);
  f.node('[data-map-provider]').listeners.change({target:{value:'gsi'}});const current=status.textContent;
  tile.listeners.tileerror();assert.equal(status.textContent,current);
  disposeRouteMaps(f.root);const removed=status.textContent;
  f.calls.tiles[1].listeners.tileerror();assert.equal(status.textContent,removed);
 });
});
test('legacy preview compatibility updates keep tile layer and preserve a user-operated viewport',()=>{
 const f=fixture({markup:routeMap(points)});
 withGlobals(f,()=>{
  mountRouteMaps(f.root);
  updateRouteMap(f.root,[...points,{lat:35.0002,lon:139,time:'2026-10-09T00:00:10Z'}]);
  assert.equal(f.calls.tiles.length,1);assert.equal(f.calls.maps.length,1);assert.equal(f.calls.fits.length,2);
  f.node('.route-canvas').listeners.pointerdown();updateRouteMap(f.root,points);assert.equal(f.calls.fits.length,2);
  f.node('[data-map-fit]').listeners.click();assert.equal(f.calls.fits.length,3);
 });
});

test('new completed same-day generation updates colors and geometry without resetting user pan',()=>{
 const f=fixture();f.element.dataset.mapIdentity='old';f.element.dataset.mapDayIdentity='day';
 withGlobals(f,()=>{
  mountRouteMaps(f.root);f.node('.route-canvas').listeners.pointerdown();
  const userView={center:[36,140],zoom:18};f.calls.maps[0].view=userView;
  const next=fixture({markup:preparedRouteMap({...daily,hash:'new',segments:[{sourceKey:'new',points:[[35,139],[36,140]],colors:['#abcdef']}]})});next.element.dataset.mapIdentity='new';next.element.dataset.mapDayIdentity='day';
  assert.equal(reusePreparedRouteMap(f.element,next.element),true);
  assert.equal(f.calls.fits.length,1);assert.equal(f.calls.maps[0].view,userView);assert.equal(f.calls.lines.at(-1).options.color,'#abcdef');assert.equal(f.element.dataset.mapIdentity,'new');
  mountRouteMaps(f.root);assert.equal(f.calls.maps.length,1);assert.equal(f.calls.tiles.length,1);
 });
});
