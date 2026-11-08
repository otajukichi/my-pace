import { distanceMeters } from './journey.js';

export const REVEAL_METERS = 60;
export const MAX_RECORDED_GAP = 250;
const valid = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 85.05112878 && Math.abs(p[1]) <= 180;
const wrap = value => ((value + 540) % 360) - 180;

/** Missing samples and implausibly long edges must not unlock the land between them. */
export function explorationPaths(runs) {
  const paths = [];
  for (const run of runs || []) for (const segment of run.segments || []) {
    let path = [];
    const flush = () => { if (path.length) paths.push(path); path = []; };
    for (const point of (Array.isArray(segment) ? segment : segment?.points) || []) {
      if (!valid(point)) { flush(); continue; }
      if (path.length && distanceMeters(path.at(-1), point) > MAX_RECORDED_GAP) flush();
      path.push([point[0], point[1]]);
    }
    flush();
  }
  return paths;
}

export function projectExploration(paths, zoom) {
  const world = 256 * 2 ** zoom;
  return paths.map(path => {
    let lastX;
    const points = path.map(([lat, lon]) => {
      let x = (lon + 180) / 360 * world;
      if (lastX !== undefined) x += Math.round((lastX - x) / world) * world;
      lastX = x;
      const sine = Math.sin(lat * Math.PI / 180);
      return { x, y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * world };
    });
    const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const p of points) { bounds.minX=Math.min(bounds.minX,p.x);bounds.maxX=Math.max(bounds.maxX,p.x);bounds.minY=Math.min(bounds.minY,p.y);bounds.maxY=Math.max(bounds.maxY,p.y); }
    return { points, ...bounds };
  });
}

// A geographic bucket index limits comparisons to nearby recorded edges.
// Distances are evaluated in metres at the queried latitude, including the date line.
function footprintIndex() {
  const cell = .0005, columns = 720000, metres = 111195.08, buckets = new Map(), seen = new Set();
  const key = (x,y) => `${((x%columns)+columns)%columns}:${y}`;
  function eachCell(west,east,south,north,visit) {
    for(let x=Math.floor((west+180)/cell);x<=Math.floor((east+180)/cell);x++)for(let y=Math.floor(south/cell);y<=Math.floor(north/cell);y++)if(visit(key(x,y)))return true;
    return false;
  }
  return {
    get empty() { return !seen.size; },
    add(paths) {
      for(const path of paths) for(let i=0;i<Math.max(1,path.length-1);i++) {
        const a=path[i],b=path[i+1]||a,signature=[a.join(','),b.join(',')].sort().join('|');
        if(seen.has(signature))continue;seen.add(signature);
        const lon=a[1]+wrap(b[1]-a[1]),edge=[a,b];
        eachCell(Math.min(a[1],lon),Math.max(a[1],lon),Math.min(a[0],b[0]),Math.max(a[0],b[0]),k=>{if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(edge);return false;});
      }
    },
    contains(point) {
      const scale=metres*Math.cos(point[0]*Math.PI/180),dy=30/metres,dx=30/scale,checked=new Set();
      return eachCell(point[1]-dx,point[1]+dx,point[0]-dy,point[0]+dy,k=>{
        for(const edge of buckets.get(k)||[]) {
          if(checked.has(edge))continue;checked.add(edge);
          const [a,b]=edge,ax=wrap(a[1]-point[1])*scale,ay=(a[0]-point[0])*metres;
          const bx=ax+wrap(b[1]-a[1])*scale,by=(b[0]-point[0])*metres,vx=bx-ax,vy=by-ay;
          const t=vx||vy?Math.min(1,Math.max(0,-(ax*vx+ay*vy)/(vx*vx+vy*vy))):0;
          if((ax+t*vx)**2+(ay+t*vy)**2<=900)return true;
        }
        return false;
      });
    },
  };
}

/** Fraction of recorded distance away from earlier days' tracks, not unique street length. */
export function explorationByRun(runs) {
  const result = new Map(), previous = footprintIndex();
  const days = new Map();
  for(const run of runs){if(!days.has(run.date))days.set(run.date,[]);days.get(run.date).push(run);}
  for (const date of [...days.keys()].sort()) {
    const day = days.get(date);
    for (const run of day) {
      let total = 0, fresh = 0;
      for (const path of explorationPaths([run])) {
        for(let i=1;i<path.length;i++) {
          const a=path[i-1],b=path[i],meters=distanceMeters(a,b),samples=Math.max(1,Math.ceil(meters/20));
          total+=meters;
          if(previous.empty){fresh+=meters;continue;}
          for(let j=0;j<samples;j++) {
            const fraction=(j+.5)/samples,point=[a[0]+(b[0]-a[0])*fraction,wrap(a[1]+wrap(b[1]-a[1])*fraction)];
            if(!previous.contains(point))fresh+=meters/samples;
          }
        }
      }
      result.set(run.id, { total, fresh:Math.min(total,fresh), first: previous.empty });
    }
    previous.add(explorationPaths(day));
  }
  return result;
}
