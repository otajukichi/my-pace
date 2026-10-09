// Pure derived data. Source CSV and normalized assets are never modified.
export const DAILY_ALGORITHM=2;
export const DAILY_OVERLAP_NOTICE='時刻が重複するファイルがあるため、開始時刻の早い記録を採用して表示しています';
export const DAILY_GEOMETRY_LIMIT=6000;
const fail=c=>{throw Error(c);};
const rad=x=>x*Math.PI/180;
const wrap=x=>((x+540)%360)-180;
export function dailyDate(ms){if(!Number.isFinite(ms))fail('DAILY_TIME_INVALID');return new Date(ms+21600000).toISOString().slice(0,10);}
export function dailyBounds(date){if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))fail('DAILY_DATE_INVALID');const ms=Date.parse(date+'T00:00:00Z');if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==date)fail('DAILY_DATE_INVALID');const start=ms-21600000;return {start,end:start+86400000};}
export function dailyDistance(a,b){const dlat=rad(b[0]-a[0]),dlon=rad(wrap(b[1]-a[1])),h=Math.sin(dlat/2)**2+Math.cos(rad(a[0]))*Math.cos(rad(b[0]))*Math.sin(dlon/2)**2;return 6371008.8*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));}
const SPEED_RGB=[[49,91,155],[37,139,154],[73,166,119],[214,179,67],[211,107,64]];
// Half-km/h quantization bounds the gradient to49 reproducible colors without
// changing source-derived distance/duration. Small fluctuations are averaged
// only within bounded display spans; meaningful shifts remain anchors.
export function dailySpeedColor(kmh){if(!Number.isFinite(kmh)||kmh<0)fail('DAILY_SPEED_INVALID');const v=Math.min(24,Math.round(kmh*2)/2),i=Math.min(3,Math.floor(v/6)),fraction=(v-i*6)/6;return '#'+SPEED_RGB[i].map((channel,j)=>Math.round(channel+(SPEED_RGB[i+1][j]-channel)*fraction).toString(16).padStart(2,'0')).join('');}

const point=p=>{const t=Date.parse(p?.time);if(typeof p?.time!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(p.time)||!Number.isFinite(t)||new Date(t).toISOString().slice(0,19)!==p.time.slice(0,19)||!Number.isFinite(p.lat)||Math.abs(p.lat)>90||!Number.isFinite(p.lon)||Math.abs(p.lon)>180)fail('DAILY_POINT_INVALID');return {t,p:[p.lat,p.lon]};};
export function startDailyFile({sourceKey,version}){if(typeof sourceKey!=='string'||!sourceKey||typeof version!=='string'||!version)fail('DAILY_SOURCE_INVALID');return {schema:1,algorithm:DAILY_ALGORITHM,sourceKey,version,start:null,end:null,last:null,days:{},count:0,geometry:0,quality:[],active:null};}
function day(s,date){return s.days[date]||(s.days[date]={distanceMeters:0,durationSeconds:0,segments:[]});}
function vertex(s,segment,p,c){segment.points.push(p);if(c)segment.colors.push(c);s.geometry++;if(s.geometry>DAILY_GEOMETRY_LIMIT)fail('DAILY_GEOMETRY_CAPACITY');}
// Continuity follows active source/date and explicit gap resets. A display
// span keeps only its anchor and pending endpoint; every discarded sample is
// within5m of that retained anchor. Source statistics are accumulated separately.
function edge(s,date,a,b,distanceMeters,seconds){const d=day(s,date);let segment=s.active?.date===date?d.segments[s.active.index]:null;
 if(!segment){segment={sourceKey:s.sourceKey,points:[],colors:[],anchor:0,span:null};d.segments.push(segment);s.active={date,index:d.segments.length-1};vertex(s,segment,a);}
 const kmh=distanceMeters/seconds*3.6,span=segment.span,shift=span&&(Math.abs(kmh-span.startKmh)>=2-1e-7||Math.abs(kmh-span.lastKmh)>=2-1e-7);
 if(span&&!shift){span.distanceMeters+=distanceMeters;span.seconds+=seconds;span.lastKmh=kmh;segment.points[segment.points.length-1]=b;segment.colors[segment.colors.length-1]=dailySpeedColor(span.distanceMeters/span.seconds*3.6);}
 else{segment.anchor=segment.points.length-1;vertex(s,segment,b,dailySpeedColor(kmh));segment.span={distanceMeters,seconds,startKmh:kmh,lastKmh:kmh};}
 if(dailyDistance(segment.points[segment.anchor],b)>=5){segment.anchor=segment.points.length-1;segment.span=null;}
}
export function appendDailyPoints(s,points){if(!s||s.schema!==1||s.algorithm!==DAILY_ALGORITHM||!Array.isArray(points))fail('DAILY_FILE_INVALID');for(const raw of points){const n=point(raw);if(s.last&&n.t<=s.last.t)fail('DAILY_TIME_ORDER');if(s.start===null)s.start=n.t;s.end=n.t;s.count++;day(s,dailyDate(n.t));
 if(s.last){const p=s.last,dt=n.t-p.t,distance=dailyDistance(p.p,n.p),valid=dt<=120000&&distance/(dt/1000)<=15;
  if(valid){let t=p.t;while(t<n.t){const date=dailyDate(t),end=Math.min(n.t,dailyBounds(date).end),f0=(t-p.t)/dt,f1=(end-p.t)/dt,inter=f=>f===0?p.p:f===1?n.p:[p.p[0]+(n.p[0]-p.p[0])*f,wrap(p.p[1]+wrap(n.p[1]-p.p[1])*f)];day(s,date).distanceMeters+=distance*(f1-f0);edge(s,date,inter(f0),inter(f1),distance*(f1-f0),dt/1000*(f1-f0));t=end;}}
  else{const previous=day(s,dailyDate(p.t));if(!previous.segments.some(seg=>seg.points[seg.points.length-1][0]===p.p[0]&&seg.points[seg.points.length-1][1]===p.p[1])){previous.segments.push({sourceKey:s.sourceKey,points:[p.p],colors:[]});s.geometry++;}day(s,dailyDate(n.t)).segments.push({sourceKey:s.sourceKey,points:[n.p],colors:[]});s.geometry++;if(s.geometry>DAILY_GEOMETRY_LIMIT)fail('DAILY_GEOMETRY_CAPACITY');s.active=null;if(!s.quality.includes('GPS_GAP_OR_IMPLAUSIBLE_SPEED'))s.quality.push('GPS_GAP_OR_IMPLAUSIBLE_SPEED');}
 }
 s.last=n;
 }return s;}
export function finishDailyFile(s){if(!s.count)fail('DAILY_FILE_EMPTY');if(s.end-s.start>366*86400000)fail('DAILY_DATE_CAPACITY');const out=JSON.parse(JSON.stringify(s));for(let t=out.start;t<out.end;){const date=dailyDate(t),end=Math.min(out.end,dailyBounds(date).end);day(out,date).durationSeconds+=(end-t)/1000;t=end;}
 const lastDay=day(out,dailyDate(out.end));if(!lastDay.segments.length)lastDay.segments.push({sourceKey:out.sourceKey,points:[out.last.p],colors:[]});
 for(const d of Object.values(out.days))for(const seg of d.segments){delete seg.anchor;delete seg.span;}delete out.active;return out;}
export function selectDailyFiles(files){const included=[],excluded=[];for(const f of [...files].sort((a,b)=>a.start-b.start||a.sourceKey.localeCompare(b.sourceKey)||a.version.localeCompare(b.version))){if(included.some(a=>f.end>f.start&&a.end>a.start&&f.start<a.end&&a.start<f.end))excluded.push(f);else included.push(f);}return {included,excluded};}
export function assembleDailyDate({date,files,storeId,generation}){dailyBounds(date);const {included,excluded}=selectDailyFiles(files),summary={distanceMeters:0,durationSeconds:0,averageSpeedKmh:null},segments=[],quality=[];for(const f of included){const d=f.days[date];if(!d)continue;summary.distanceMeters+=d.distanceMeters;summary.durationSeconds+=d.durationSeconds;segments.push(...d.segments);for(const q of f.quality)if(!quality.includes(q))quality.push(q);}
 if(summary.durationSeconds>0)summary.averageSpeedKmh=summary.distanceMeters/summary.durationSeconds*3.6;return {schema:1,store:storeId,generation,date,summary,segments,notice:excluded.some(f=>f.days[date])?DAILY_OVERLAP_NOTICE:null,quality};}
