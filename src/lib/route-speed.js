import {haversineKm} from './gpx.js';
import {isDateKey} from './domain.js';

// Presentation only: never rewrite imported samples, run totals or persisted state.
export const ROUTE_LIMITS = Object.freeze({points:20480, edges:1800, gapSeconds:60, maxKmh:45});
export const SPEED_STOPS = Object.freeze([[0,'#315b9b'],[6,'#258b9a'],[12,'#49a677'],[18,'#d6b343'],[24,'#d36b40']]);
export function speedColor(kmh) {
  if(!Number.isFinite(kmh)||kmh<0)return '#718096';
  const v=Math.min(24,kmh), i=Math.min(3,Math.floor(v/6)), a=SPEED_STOPS[i],b=SPEED_STOPS[i+1],f=(v-a[0])/6;
  const rgb=s=>s.match(/[a-f0-9]{2}/gi).map(x=>parseInt(x,16));
  return '#'+rgb(a[1]).map((x,j)=>Math.round(x+(rgb(b[1])[j]-x)*f).toString(16).padStart(2,'0')).join('');
}
function time(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null;
  if(!isDateKey(value.slice(0,10))||Number(value.slice(11,13))>23||Number(value.slice(14,16))>59||Number(value.slice(17,19))>59)return null;
  const n=Date.parse(value);return Number.isFinite(n)?n:null;
}
const valid=p=>p&&Number.isFinite(p.lat)&&Math.abs(p.lat)<=90&&Number.isFinite(p.lon)&&Math.abs(p.lon)<=180;
export function buildRouteModel(input) {
  const points=Array.isArray(input)?input.slice(0,ROUTE_LIMITS.points):[],edges=[],locations=[];
  let previous=null, previousLon=null, gaps=0,known=0,unknown=0,omitted=0,bucket=null,minSpeed=Infinity,maxSpeed=-Infinity;
  // Aggregate only consecutive valid intervals. Never simplify across a gap.
  const stride=Math.max(1,Math.ceil(points.length/ROUTE_LIMITS.edges));
  const flush=()=>{if(!bucket)return;if(edges.length<ROUTE_LIMITS.edges){const speed=bucket.known?bucket.distance/bucket.seconds*3600:null;edges.push({a:bucket.a,b:bucket.b,path:bucket.path,speed,color:speedColor(speed)});}else omitted++;bucket=null;};
  for(const p of points){
    if(!valid(p)){flush();previous=null;gaps++;continue;}
    let lon=p.lon;
    if(previousLon!==null){while(lon-previousLon>180)lon-=360;while(lon-previousLon< -180)lon+=360;}
    previousLon=lon;
    const position=[Math.max(-85.05112878,Math.min(85.05112878,p.lat)),lon];
    locations.push(position);
    if(previous){
      const a=time(previous.p.time),b=time(p.time),dt=a!==null&&b!==null?(b-a)/1000:null,distance=haversineKm(previous.p,p);
      const speed=dt>0?distance/dt*3600:null;
      const broken=(previous.p.segment??0)!==(p.segment??0)||(dt!==null&&(dt<=0||dt>ROUTE_LIMITS.gapSeconds))||(speed!==null&&speed>ROUTE_LIMITS.maxKmh)||distance>1;
      if(broken){flush();gaps++;}
      else {
        const isKnown=speed!==null;
        if(isKnown){known++;minSpeed=Math.min(minSpeed,speed);maxSpeed=Math.max(maxSpeed,speed);}else unknown++;
        if(bucket&&(bucket.known!==isKnown||bucket.count>=stride))flush();
        if(!bucket)bucket={a:previous.position,b:position,known:isKnown,count:0,distance:0,seconds:0,path:[previous.position]};
        bucket.b=position;bucket.path.push(position);bucket.count++;bucket.distance+=distance;bucket.seconds+=dt??0;
      }
    }
    previous={p,position};
  }
  flush();
  return {edges,locations,known,unknown,gaps,simplified:stride>1,limited:omitted>0||(input?.length||0)>points.length,total:points.length,minSpeed:known?minSpeed:null,maxSpeed:known?maxSpeed:null};
}
