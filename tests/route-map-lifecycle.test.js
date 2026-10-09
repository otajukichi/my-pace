import test from 'node:test';
import assert from 'node:assert/strict';
import {routeMap,mountRouteMaps,updateRouteMap,disposeRouteMaps} from '../src/lib/route-map.js';
const points=[{lat:35,lon:139,time:'2026-10-09T00:00:00Z'},{lat:35.0001,lon:139,time:'2026-10-09T00:00:05Z'}];
function fixture(){
 const calls={tiles:[],maps:[],lines:[],fit:0},nodes=new Map();
 const node=name=>{if(!nodes.has(name))nodes.set(name,{listeners:{},textContent:'',setAttribute(){},querySelector:()=>node('zoom'),addEventListener(name,fn){this.listeners[name]=fn;}});return nodes.get(name);};
 const element={isConnected:true,dataset:{routeMap:routeMap(points).match(/data-route-map="([^"]+)"/)[1]},querySelector:node};
 const root={querySelectorAll:()=>[element],querySelector:()=>element,contains:e=>e===element};
 const L={map(){const map={removed:false,attributionControl:{setPrefix(){}},zoomControl:{setPosition(){}},invalidateSize(){},setMinZoom(){},removeLayer(){},fitBounds(){calls.fit++;},remove(){this.removed=true;}};calls.maps.push(map);return map;},canvas:()=>({}),layerGroup:()=>({addTo(){return this;},clearLayers(){}}),polyline(path,options){calls.lines.push({path,options});return {addTo(){return this;}};},circleMarker:()=>({addTo(){return this;},bindTooltip(){return this;}}),latLngBounds:p=>p,tileLayer(url,options){const tile={url,options,listeners:{},addTo(){return this;},on(name,fn){this.listeners[name]=fn;return this;},redraw(){this.listeners.loading();}};calls.tiles.push(tile);return tile;}};
 return {calls,nodes,node,element,root,L};
}
test('visible route automatically mounts one local map and allowed raster layer; updates keep tile layer',()=>{
 const f=fixture(),old=globalThis.L;globalThis.L=f.L;
 try{
  mountRouteMaps(f.root);assert.equal(f.calls.maps.length,1);assert.equal(f.calls.tiles.length,1);assert.equal(f.calls.tiles[0].url,'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png');assert.equal(f.calls.tiles[0].options.keepBuffer,0);
  updateRouteMap(f.root,[...points,{lat:35.0002,lon:139,time:'2026-10-09T00:00:10Z'}]);assert.equal(f.calls.tiles.length,1);assert.equal(f.calls.maps.length,1);assert.equal(f.calls.fit,2);
  f.node('.route-canvas').listeners.pointerdown();updateRouteMap(f.root,points);assert.equal(f.calls.fit,2,'user viewport is preserved');
  f.node('[data-map-fit]').listeners.click();assert.equal(f.calls.fit,3);
  f.node('[data-map-provider]').listeners.change({target:{value:'osm'}});assert.equal(f.calls.tiles.length,2);assert.equal(f.calls.tiles[1].url,'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.equal(f.calls.tiles[1].options.maxNativeZoom,19);
  disposeRouteMaps(f.root);assert.ok(f.calls.maps[0].removed);
 }finally{disposeRouteMaps(f.root);globalThis.L=old;}
});
test('tile failure remains honest, successful retry restores summary, no raw point URL',()=>{
 const f=fixture(),old=globalThis.L;globalThis.L=f.L;
 try{
  mountRouteMaps(f.root);const tile=f.calls.tiles[0],status=f.node('.route-map-status');
  tile.listeners.tileerror();tile.listeners.load();assert.match(status.textContent,/取得できません/);
  f.node('[data-map-tiles]').listeners.click();assert.match(status.textContent,/再読み込み中/);
  tile.listeners.load();assert.match(status.textContent,/推定速度/);assert.match(status.textContent,/国土地理院（淡色）を表示中/);
  assert.doesNotMatch(tile.url,/35|139|2026/);assert.equal(tile.options.updateWhenZooming,false);assert.equal(tile.options.detectRetina,false);
 }finally{disposeRouteMaps(f.root);globalThis.L=old;}
});
