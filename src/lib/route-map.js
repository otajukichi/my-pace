import {e} from './ui.js';
import {buildRouteModel} from './route-speed.js';

export const ROUTE_MAP_PROVIDERS=Object.freeze({
  gsi:{label:'国土地理院（淡色）',url:'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',minZoom:9,maxNativeZoom:18,attribution:'<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">地理院タイル</a>'},
  osm:{label:'OpenStreetMap',url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',minZoom:1,maxNativeZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'}
});
let serial=0;
const pending=new Map(),mounted=new Map();
export function routeMap(points,source='GPX') {
  if(!points?.length)return '';
  const model=buildRouteModel(points),id=`route-${++serial}`;
  pending.set(id,model);
  // Bound abandoned render registrations (e.g. replaced dialogs) without retaining tracks.
  while(pending.size>16)pending.delete(pending.keys().next().value);
  return `<section class="route-map" data-route-map="${id}" aria-label="${e(source)} の速度付きルート"><div class="route-map-heading"><strong>${e(source)} のルート</strong><span>GPSからの推定速度</span></div><div class="route-canvas" tabindex="0" role="region" aria-label="ルート地図。矢印キーで移動、プラスとマイナスで拡大縮小"></div><div class="route-map-tools"><label class="route-provider-label">背景地図<select data-map-provider aria-label="背景地図の提供元"><option value="gsi">国土地理院（淡色）</option><option value="osm">OpenStreetMap</option></select></label><button type="button" class="btn secondary" data-map-fit>全体を見る</button><button type="button" class="btn secondary" data-map-tiles>背景地図を再読み込み</button></div><div class="route-legend" aria-label="速度の色。0から24キロメートル毎時。灰色の破線は速度不明"><div class="route-gradient"></div><div class="route-legend-values"><span>0</span><span>6</span><span>12</span><span>18</span><span>24+ km/h</span></div><p><span class="route-unknown-key"></span> 時刻なし：速度不明</p></div><p class="route-map-status" aria-live="polite">背景地図を読み込みます。</p><details class="route-map-details"><summary>速度と地図について</summary><p>速度は隣接するGPS座標と時刻から推定。GPS誤差を含みます。CSVの速度列は単位不明のため使いません。60秒超の空白、時刻の重複・逆順、45 km/h超、1 km超の飛び、別区間は線をつなぎません。${model.simplified?'連続する区間をまとめ、速度を区間平均しています。ルートの曲がり角は保持します。':''}${model.limited?'表示上限のため一部の線を省略しています。':''}</p><p>背景地図は国土地理院の淡色地図を自動で読み込みます。OpenStreetMapにも切り替えられます。表示範囲とIPアドレスが選択した提供元に伝わります。走行データ自体は送りません。国土地理院は日本国内向けで、縮尺に上限があります（ズーム9〜18、19は拡大表示）。日本国外や地図がない範囲はOpenStreetMapに切り替えてください。施設名の収録は提供元により異なります。<a href="./privacy.html" target="_blank" rel="noopener">地図のプライバシー</a></p></details></section>`;
}
export function disposeRouteMaps(root){
  for(const [element,entry] of mounted)if(!element.isConnected||root?.contains(element)){entry.map.remove();mounted.delete(element);}
}
export function mountRouteMaps(root){
  disposeRouteMaps();
  if(!root?.querySelectorAll)return;
  for(const element of root.querySelectorAll('[data-route-map]')){
    if(mounted.has(element))continue;
    let model=pending.get(element.dataset.routeMap);pending.delete(element.dataset.routeMap);
    if(!model)continue;
    const status=element.querySelector('.route-map-status'),canvas=element.querySelector('.route-canvas'),L=globalThis.L;
    if(!L){status.textContent='地図の表示機能を読み込めませんでした。ページを再読み込みしてください。';continue;}
    if(!model.locations.length){status.textContent='表示できるGPS座標がありません。';continue;}
    const map=L.map(canvas,{attributionControl:true,scrollWheelZoom:false,maxZoom:19,minZoom:9,zoomControl:true});
    map.attributionControl.setPrefix(false);
    map.zoomControl.setPosition('topleft');
    const zoom=canvas.querySelector('.leaflet-control-zoom');
    zoom?.querySelector('.leaflet-control-zoom-in')?.setAttribute('aria-label','拡大');
    zoom?.querySelector('.leaflet-control-zoom-out')?.setAttribute('aria-label','縮小');
    const renderer=L.canvas({padding:0.2});
    const routeLayer=L.layerGroup().addTo(map);
    let bounds,follow=true;
    const draw=()=>{
      routeLayer.clearLayers();
      for(const edge of model.edges)L.polyline(edge.path,{renderer,color:edge.color,weight:5,opacity:0.96,dashArray:edge.speed===null?'6 6':null,interactive:false}).addTo(routeLayer);
      const first=model.locations[0],last=model.locations.at(-1);
      L.circleMarker(first,{renderer,radius:6,color:'#ffffff',weight:2,fillColor:'#315b9b',fillOpacity:1}).addTo(routeLayer).bindTooltip('開始点');
      L.circleMarker(last,{renderer,radius:6,color:'#ffffff',weight:2,fillColor:'#d36b40',fillOpacity:1}).addTo(routeLayer).bindTooltip('終了点（表示範囲内）');
      bounds=L.latLngBounds(model.locations);
    };
    const fit=()=>{map.invalidateSize();map.fitBounds(bounds,{padding:[28,28],maxZoom:16,animate:false});};
    const entry={map,tile:null,provider:'gsi',failed:false,loading:true,update(next){if(!next.locations.length)return;model=next;draw();if(follow)fit();status.textContent=message();}};mounted.set(element,entry);
    for(const event of ['pointerdown','wheel','keydown'])canvas.addEventListener(event,()=>{follow=false;});
    draw();
    const message=()=>`${model.known?`推定速度 ${model.minSpeed.toFixed(1)}〜${model.maxSpeed.toFixed(1)} km/h。`:''}速度あり ${model.known}区間・不明 ${model.unknown}区間${model.gaps?`・未接続 ${model.gaps}箇所`:''}。${entry.failed?'背景地図を取得できません。再読み込み、または別の地図に切り替えられます。':entry.loading?'背景地図を読み込み中…':entry.tile?`${ROUTE_MAP_PROVIDERS[entry.provider].label}を表示中。`:'背景地図なし。'}${model.simplified?'速度を区間平均しています。':''}${model.limited?'一部の線は表示上限で省略。':''}`;
    const tilesButton=element.querySelector('[data-map-tiles]');
    const addTiles=()=>{
      if(entry.tile)return;
      // Visible maps only. No prefetch, analytics, geolocation or track upload.
      const provider=ROUTE_MAP_PROVIDERS[entry.provider];
      map.setMinZoom(provider.minZoom);
      entry.tile=L.tileLayer(provider.url,{maxZoom:19,maxNativeZoom:provider.maxNativeZoom,minZoom:provider.minZoom,keepBuffer:0,updateWhenIdle:true,updateWhenZooming:false,detectRetina:false,attribution:provider.attribution}).addTo(map);
      const tile=entry.tile;
      entry.loading=true;
      tile.on('loading',()=>{if(entry.tile!==tile)return;entry.failed=false;entry.loading=true;status.textContent=message();});
      tile.on('tileerror',()=>{if(entry.tile!==tile)return;entry.failed=true;status.textContent=message();});
      tile.on('load',()=>{if(entry.tile!==tile)return;entry.loading=false;status.textContent=message();});
      status.textContent=message();
    };
    element.querySelector('[data-map-fit]').addEventListener('click',()=>{follow=true;fit();});
    tilesButton.addEventListener('click',()=>{if(entry.tile)entry.tile.redraw();else addTiles();status.textContent='背景地図を再読み込み中…';});
    element.querySelector('[data-map-provider]').addEventListener('change',event=>{const key=event.target.value;if(!Object.hasOwn(ROUTE_MAP_PROVIDERS,key)||key===entry.provider)return;if(entry.tile)map.removeLayer(entry.tile);entry.tile=null;entry.failed=false;entry.provider=key;addTiles();});
    fit();status.textContent=message();addTiles();
  }
}

export function updateRouteMap(root,points){
  const element=root?.querySelector?.('[data-route-map]'),entry=mounted.get(element);
  if(entry)entry.update(buildRouteModel(points));
}
