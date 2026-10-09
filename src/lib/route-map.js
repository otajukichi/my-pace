import {e} from './ui.js';
// Compatibility for retained GPX previews only. Prepared CSV maps never call this.
import {buildRouteModel} from './route-speed.js';

export const ROUTE_MAP_PROVIDERS=Object.freeze({
  osm:{label:'OpenStreetMap',url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',minZoom:1,maxNativeZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'},
  gsi:{label:'国土地理院（淡色）',url:'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',minZoom:9,maxNativeZoom:18,attribution:'<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">地理院タイル</a>'}
});
let serial=0;
const pending=new Map(),mounted=new Map();
const validLocation=point=>Array.isArray(point)&&point.length>=2&&Number.isFinite(point[0])&&Math.abs(point[0])<=90&&Number.isFinite(point[1])&&Math.abs(point[1])<=180;
const sameLocation=(a,b)=>a[0]===b[0]&&a[1]===b[1];

// This is a drawing adapter, not an import/parser or statistics calculation.
// Every backend fragment remains separate, even when its endpoints coincide.
function preparedModel(daily){
  const fragments=[],edges=[],locations=[];
  for(const segment of Array.isArray(daily?.segments)?daily.segments:[]){
    const points=Array.isArray(segment?.points)?segment.points:[],colors=Array.isArray(segment?.colors)?segment.colors:[];
    let fragment=[];
    const finish=()=>{if(fragment.length)fragments.push(fragment);fragment=[];};
    for(let i=0;i<points.length;i++){
      if(!validLocation(points[i])){finish();continue;}
      let longitude=points[i][1];
      const reference=fragment.at(-1)?.[1]??locations[0]?.[1];
      // Projection-only normalization prevents a local date-line route from
      // fitting to the entire world; the prepared speed colors stay untouched.
      if(reference!==undefined){while(longitude-reference>180)longitude-=360;while(longitude-reference< -180)longitude+=360;}
      const point=[points[i][0],longitude],color=colors[i-1];
      // Invalid/missing presentation data must never create an invented bridge.
      if(fragment.length&&!/^#[\da-f]{6}$/i.test(color??''))finish();
      if(fragment.length)edges.push({path:[fragment.at(-1),point],color,speedKnown:true});
      fragment.push(point);locations.push(point);
    }
    finish();
  }
  return {prepared:true,fragments,edges,locations};
}
function legacyModel(points){
  const model=buildRouteModel(points);
  return {...model,prepared:false,fragments:model.locations.length?[model.locations]:[]};
}
function mapMarkup(model,source,identity='',dayIdentity=''){
  if(!model.locations.length)return '';
  const id=`route-${++serial}`;
  pending.set(id,model);
  // Bound abandoned render registrations without retaining discarded tracks.
  while(pending.size>16)pending.delete(pending.keys().next().value);
  const explanation=model.prepared
    ?'速度の色と区間の切れ目はサーバーで準備した値をそのまま表示します。GPSの誤差を含みます。異なるファイルや途切れた区間はつなぎません。'
    :`速度は隣接するGPS座標と時刻から推定。GPS誤差を含みます。60秒超の空白、時刻の重複・逆順、45 km/h超、1 km超の飛び、別区間は線をつなぎません。${model.simplified?'連続する区間をまとめ、速度を区間平均しています。ルートの曲がり角は保持します。':''}${model.limited?'表示上限のため一部の線を省略しています。':''}`;
  return `<section class="route-map" data-route-map="${id}"${identity?` data-map-identity="${e(identity)}"`:''}${dayIdentity?` data-map-day-identity="${e(dayIdentity)}"`:''} aria-label="${e(source)} の速度付きルート"><div class="route-map-heading"><strong>${e(source)} のルート</strong><span>${model.prepared?'準備済みの推定速度':'GPSからの推定速度'}</span></div><div class="route-canvas" tabindex="0" role="region" aria-label="ルート地図。矢印キーで移動、プラスとマイナスで拡大縮小"></div><div class="route-map-tools"><label class="route-provider-label">背景地図<select data-map-provider aria-label="背景地図の提供元"><option value="osm">OpenStreetMap</option><option value="gsi">国土地理院（淡色）</option></select></label><button type="button" class="btn secondary" data-map-fit>全体を見る</button><button type="button" class="btn secondary" data-map-tiles>背景地図を再読み込み</button></div><div class="route-legend" aria-label="速度の色。0から24キロメートル毎時${model.prepared?'':'。灰色の破線は速度不明'}"><div class="route-gradient"></div><div class="route-legend-values"><span>0</span><span>6</span><span>12</span><span>18</span><span>24+ km/h</span></div>${model.prepared?'':'<p><span class="route-unknown-key"></span> 時刻なし：速度不明</p>'}</div><p class="route-map-status" aria-live="polite">背景地図を読み込みます。</p><details class="route-map-details"><summary>速度と地図について</summary><p>${explanation}</p><p>背景地図はOpenStreetMapを自動で読み込みます。国土地理院の淡色地図にも切り替えられます。表示範囲とIPアドレスが選択した提供元に伝わります。走行データ自体は送りません。国土地理院は日本国内向けで、縮尺に上限があります（ズーム9〜18、19は拡大表示）。施設名の収録は提供元により異なります。<a href="./privacy.html" target="_blank" rel="noopener">地図のプライバシー</a></p></details></section>`;
}
export function preparedRouteMap(daily,identity=JSON.stringify([daily?.store,daily?.generation,daily?.date,daily?.hash]),dayIdentity=JSON.stringify([daily?.store,daily?.generation,daily?.date])){
  return mapMarkup(preparedModel(daily),'この日',identity,dayIdentity);
}
// Legacy exports are kept for old saved GPX previews; the running page uses only
// preparedRouteMap, with backend-prepared positions and speed colors.
export function routeMap(points,source='GPX'){
  if(!points?.length)return '';
  return mapMarkup(legacyModel(points),source);
}
export function discardRouteMapRegistration(element){
  const id=typeof element==='string'?element:element?.dataset?.routeMap;
  if(id)pending.delete(id);
}
// Swap a completed same-day route into the retained map without resetting a
// viewport the user has moved. The app swaps the matching summary in this turn.
export function reusePreparedRouteMap(element,replacement){
  const entry=mounted.get(element),model=pending.get(replacement?.dataset?.routeMap);
  if(!entry||!model?.prepared)return false;
  pending.delete(replacement.dataset.routeMap);
  if(element.dataset.mapIdentity!==replacement.dataset.mapIdentity)entry.update(model);
  element.dataset.mapIdentity=replacement.dataset.mapIdentity;
  element.dataset.mapDayIdentity=replacement.dataset.mapDayIdentity;
  return true;
}
export function disposeRouteMaps(root){
  if(root?.querySelectorAll)for(const element of root.querySelectorAll('[data-route-map]'))discardRouteMapRegistration(element);
  for(const [element,entry] of mounted)if(!element.isConnected||root?.contains(element)){
    entry.dispose();mounted.delete(element);
  }
}
export function mountRouteMaps(root){
  disposeRouteMaps();
  if(!root?.querySelectorAll)return;
  for(const element of root.querySelectorAll('[data-route-map]')){
    const existing=mounted.get(element);
    if(existing){existing.resize();continue;}
    let model=pending.get(element.dataset.routeMap);pending.delete(element.dataset.routeMap);
    if(!model)continue;
    const status=element.querySelector('.route-map-status'),canvas=element.querySelector('.route-canvas'),L=globalThis.L;
    if(!L){status.textContent='地図の表示機能を読み込めませんでした。ページを再読み込みしてください。';continue;}
    if(!model.locations.length){status.textContent='表示できるGPS座標がありません。';continue;}
    const map=L.map(canvas,{attributionControl:true,scrollWheelZoom:false,maxZoom:19,minZoom:1,zoomControl:true});
    map.attributionControl.setPrefix(false);
    map.zoomControl.setPosition('topleft');
    const zoom=canvas.querySelector('.leaflet-control-zoom');
    zoom?.querySelector('.leaflet-control-zoom-in')?.setAttribute('aria-label','拡大');
    zoom?.querySelector('.leaflet-control-zoom-out')?.setAttribute('aria-label','縮小');
    const renderer=L.canvas({padding:0.2}),routeLayer=L.layerGroup().addTo(map);
    let bounds,follow=true,hasFit=false,disposed=false,observer=null,frame=null;
    const draw=()=>{
      routeLayer.clearLayers();
      for(const edge of model.edges)L.polyline(edge.path,{renderer,color:edge.color,weight:5,opacity:0.96,dashArray:!model.prepared&&edge.speed===null?'6 6':null,interactive:false}).addTo(routeLayer);
      for(const fragment of model.fragments){
        L.circleMarker(fragment[0],{renderer,radius:6,color:'#ffffff',weight:2,fillColor:'#315b9b',fillOpacity:1}).addTo(routeLayer).bindTooltip('区間の開始点');
        L.circleMarker(fragment.at(-1),{renderer,radius:6,color:'#ffffff',weight:2,fillColor:'#d36b40',fillOpacity:1}).addTo(routeLayer).bindTooltip('区間の終了点');
      }
      bounds=L.latLngBounds(model.locations);
    };
    const dimensions=()=>{
      // Leaflet sizes itself from the laid-out canvas, never the page viewport.
      const rect=canvas.getBoundingClientRect?.();
      return {width:canvas.clientWidth??rect?.width??0,height:canvas.clientHeight??rect?.height??0};
    };
    const fit=()=>{
      if(disposed||!element.isConnected)return false;
      const {width,height}=dimensions();
      if(width<=0||height<=0)return false;
      map.invalidateSize({pan:false,animate:false});
      const padding=Math.min(24,Math.max(1,Math.floor(Math.min(width,height)*0.06)));
      const options={padding:[padding,padding],animate:false};
      // Real routes can fill the container at every supported zoom level. A
      // degenerate one-point route needs a useful, finite neighborhood view.
      if(model.locations.every(point=>sameLocation(point,model.locations[0])))options.maxZoom=17;
      map.fitBounds(bounds,options);hasFit=true;return true;
    };
    const resize=()=>{
      if(disposed||!element.isConnected)return;
      const {width,height}=dimensions();
      if(width<=0||height<=0)return;
      if(!hasFit)fit();else map.invalidateSize({pan:false,animate:false});
    };
    const stopFollowing=()=>{follow=false;};
    const entry={map,tile:null,provider:'osm',failed:false,loading:true,resize,dispose(){
      disposed=true;observer?.disconnect();
      if(frame!==null)globalThis.cancelAnimationFrame?.(frame);
      for(const event of ['pointerdown','wheel','keydown'])canvas.removeEventListener?.(event,stopFollowing);
      map.remove();
    },update(next){if(!next.locations.length)return;model=next;draw();if(follow)fit();status.textContent=message();}};
    mounted.set(element,entry);
    for(const event of ['pointerdown','wheel','keydown'])canvas.addEventListener(event,stopFollowing);
    const message=()=>{
      const route=model.prepared?'準備済みのルートを表示。':`${model.known?`推定速度 ${model.minSpeed.toFixed(1)}〜${model.maxSpeed.toFixed(1)} km/h。`:''}速度あり ${model.known}区間・不明 ${model.unknown}区間${model.gaps?`・未接続 ${model.gaps}箇所`:''}。`;
      return `${route}${entry.failed?'背景地図を取得できません。再読み込み、または別の地図に切り替えられます。':entry.loading?'背景地図を読み込み中…':entry.tile?`${ROUTE_MAP_PROVIDERS[entry.provider].label}を表示中。`:'背景地図なし。'}${model.simplified?'速度を区間平均しています。':''}${model.limited?'一部の線は表示上限で省略。':''}`;
    };
    const addTiles=()=>{
      if(entry.tile)return;
      // Visible maps only. No prefetch, analytics, geolocation or track upload.
      const provider=ROUTE_MAP_PROVIDERS[entry.provider];
      map.setMinZoom(provider.minZoom);
      entry.tile=L.tileLayer(provider.url,{maxZoom:19,maxNativeZoom:provider.maxNativeZoom,minZoom:provider.minZoom,keepBuffer:0,updateWhenIdle:true,updateWhenZooming:false,detectRetina:false,attribution:provider.attribution}).addTo(map);
      const tile=entry.tile;
      entry.loading=true;
      tile.on('loading',()=>{if(entry.tile!==tile||disposed)return;entry.failed=false;entry.loading=true;status.textContent=message();});
      tile.on('tileerror',()=>{if(entry.tile!==tile||disposed)return;entry.failed=true;status.textContent=message();});
      tile.on('load',()=>{if(entry.tile!==tile||disposed)return;entry.loading=false;status.textContent=message();});
      status.textContent=message();
    };
    element.querySelector('[data-map-fit]').addEventListener('click',()=>{follow=true;fit();});
    element.querySelector('[data-map-tiles]').addEventListener('click',()=>{
      if(entry.tile)entry.tile.redraw();else addTiles();
      status.textContent='背景地図を再読み込み中…';
    });
    element.querySelector('[data-map-provider]').addEventListener('change',event=>{
      const key=event.target.value;
      if(!Object.hasOwn(ROUTE_MAP_PROVIDERS,key)||key===entry.provider)return;
      if(entry.tile)map.removeLayer(entry.tile);
      entry.tile=null;entry.failed=false;entry.provider=key;addTiles();
    });
    draw();resize();status.textContent=message();addTiles();
    if(typeof globalThis.ResizeObserver==='function'){
      observer=new globalThis.ResizeObserver(resize);observer.observe(canvas);
    }
    // A frame also covers the first layout when ResizeObserver is unavailable.
    if(typeof globalThis.requestAnimationFrame==='function')frame=globalThis.requestAnimationFrame(()=>{frame=null;resize();});
  }
}
export function updateRouteMap(root,points){
  const element=root?.querySelector?.('[data-route-map]'),entry=mounted.get(element);
  if(entry)entry.update(legacyModel(points));
}
