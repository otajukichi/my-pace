// The imported daily-calculator v2 encodes each GPS edge's speed in one of
// 49 colors (0–24 km/h, rounded to 0.5). Decode that known scale only; an
// unknown color or missing speed is never inferred from a run's average.
const LEGACY_RGB = [[49,91,155],[37,139,154],[73,166,119],[214,179,67],[211,107,64]];
// A fixed 6–14 km/h running range makes the imported runs' variations visible
// (distance-weighted median 10.5, 95th percentile 14 km/h). Never renormalize
// by day/month: equal speeds keep equal colors when records are compared.
export const SPEED_STOPS = [[6,'#607FC6'],[8,'#279AB3'],[10,'#73AD83'],[12,'#D8AB55'],[14,'#D56D52']];
export const UNKNOWN_SPEED_COLOR = '#8B94A3';
export const RUN_OPACITY = 0.68;
const rgb = hex => hex.slice(1).match(/../g).map(c => parseInt(c,16));
const mix = (a,b,f) => '#'+a.map((c,i)=>Math.round(c+(b[i]-c)*f).toString(16).padStart(2,'0')).join('');
const legacy = new Map(Array.from({length:49},(_,n)=>{
  const speed=n/2,index=Math.min(3,Math.floor(speed/6));
  return [mix(LEGACY_RGB[index],LEGACY_RGB[index+1],(speed-index*6)/6),speed];
}));
export function decodedSpeed(color) { return typeof color==='string' ? legacy.get(color.toLowerCase()) ?? null : null; }
export function speedColor(speed) {
  if (!Number.isFinite(speed) || speed < 0) return UNKNOWN_SPEED_COLOR;
  const value=Math.max(6,Math.min(14,speed)),index=Math.min(3,Math.floor((value-6)/2));
  return mix(rgb(SPEED_STOPS[index][1]),rgb(SPEED_STOPS[index+1][1]),(value-SPEED_STOPS[index][0])/2);
}
const valid = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0])<=90 && Math.abs(p[1])<=180;
const displaySpeed = value => value === null ? null : Math.max(6, Math.min(14, value));

// Keep each edge's measured color at its midpoint. At a shared endpoint the
// two edges meet at the same display speed. Intermediate palette stops avoid
// a blue-to-red shortcut through purple. Unknown speeds are never bridged.
export function edgeGradient(previous, current, next) {
  if(current === null)return [[0, UNKNOWN_SPEED_COLOR], [1, UNKNOWN_SPEED_COLOR]];
  const mid=displaySpeed(current),before=displaySpeed(previous),after=displaySpeed(next);
  const anchors=[[0,before===null?mid:(before+mid)/2],[.5,mid],[1,after===null?mid:(mid+after)/2]];
  const stops=[];
  for(let i=0;i<2;i++){
    const [offset,a]=anchors[i],[end,b]=anchors[i+1];
    stops.push([offset,speedColor(a)]);
    const between=SPEED_STOPS.filter(([speed])=>speed>Math.min(a,b)&&speed<Math.max(a,b));
    if(b<a)between.reverse();
    for(const [speed,color] of between)stops.push([offset+(end-offset)*(speed-a)/(b-a),color]);
  }
  stops.push([1,speedColor(anchors[2][1])]);
  return stops;
}

/** Geometry is unchanged; only colors between adjacent recorded edges blend. */
export function gradientChains(run) {
  const chains=[];let known=0,unknown=0;
  for(const segment of run?.segments??[]){
    let active=null;
    for(let i=0;i<(segment.points?.length??0)-1;i++){
      const a=segment.points[i],b=segment.points[i+1];
      if(!valid(a)||!valid(b)){active=null;continue;}
      if(a[0]===b[0]&&a[1]===b[1])continue;
      const explicit=segment.speedsKmh?.[i];
      const speed=Number.isFinite(explicit)&&explicit>=0?explicit:decodedSpeed(segment.colors?.[i]);
      if(speed===null)unknown++;else known++;
      if(!active){active={points:[a],speeds:[]};chains.push(active);}
      active.points.push(b);active.speeds.push(speed);
    }
  }
  return {known,unknown,chains:chains.map(({points,speeds})=>({points,gradients:speeds.map((v,i)=>edgeGradient(speeds[i-1]??null,v,speeds[i+1]??null))}))};
}
