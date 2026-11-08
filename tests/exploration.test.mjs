import test from 'node:test';
import assert from 'node:assert/strict';
import { explorationPaths, projectExploration, explorationByRun } from '../lib/exploration.js';
import { enclosedExploration } from '../lib/exploration-regions.js';

const run = (points, id = 'a', date = '2026-11-01') => ({ id, date, segments: [{ points }] });

test('recorded paths include all runs while preserving missing and implausible GPS gaps', () => {
  const loop = [[0,0],[0,.001],[.001,.001],[.001,0],[0,0]];
  const broken = [[1,1],[1,1.001],null,[1,1.004],[1,1.005],[1,1.02],[NaN,0],[91,0]];
  const input = [run(loop), run(broken,'b')], before = structuredClone(input);
  assert.deepEqual(explorationPaths(input), [loop, broken.slice(0,2), broken.slice(3,5), [broken[5]]]);
  assert.deepEqual(input,before);
  assert.deepEqual(explorationPaths([]),[]);
  assert.deepEqual(explorationPaths([{segments:[{points:[[0,0]]}]}]),[[[0,0]]]);
});

const geo = ([x,y],lat=35,lon=139) => [lat+y/111320,((lon+x/(111320*Math.cos(lat*Math.PI/180))+540)%360)-180];
function sampled(vertices,lat=35,lon=139) {
  const result=[];
  for(let i=1;i<vertices.length;i++) {
    const [ax,ay]=vertices[i-1],[bx,by]=vertices[i],count=Math.ceil(Math.hypot(bx-ax,by-ay)/100);
    for(let j=0;j<count;j++)result.push(geo([ax+(bx-ax)*j/count,ay+(by-ay)*j/count],lat,lon));
  }
  result.push(geo(vertices.at(-1),lat,lon));return result;
}
function isEnclosed(regions,point) {
  const projected=projectExploration([[point]],0)[0].points[0];
  return regions.some(region=>{
    const x=projected.x+Math.round(((region.minX+region.maxX)/2-projected.x)/256)*256,y=projected.y;
    let inside=false;
    for(let i=0,j=region.points.length-1;i<region.points.length;j=i++) {
      const a=region.points[i],b=region.points[j];
      if((a.y>y)!==(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)inside=!inside;
    }
    return inside;
  });
}
const regionsFor = runs => enclosedExploration(explorationPaths(runs));
const square = [[0,0],[600,0],[600,600],[0,600],[0,0]];

test('enclosed land opens for a loop, including nested and reversed repeated tracks', () => {
  const path=sampled(square),original=run(path),before=structuredClone(original);
  for(const runs of [[original],[original,run([...path].reverse(),'reverse'),run(sampled([[200,200],[400,200],[400,400],[200,400],[200,200]]),'inner')]]) {
    const regions=regionsFor(runs);
    assert(isEnclosed(regions,geo([300,300])));
    assert(isEnclosed(regions,geo([100,100])));
    assert(!isEnclosed(regions,geo([800,300])));
  }
  assert.deepEqual(original,before);
});

test('separate days can complete a loop, while open and retraced routes do not close themselves', () => {
  const first=run(sampled(square.slice(0,3))),last=run(sampled(square.slice(2)),'b','2026-11-02');
  assert.equal(regionsFor([first]).length,0);assert.equal(regionsFor([last]).length,0);
  assert(isEnclosed(regionsFor([first,last]),geo([300,300])));
  const open=sampled([[0,0],[600,0],[600,600],[0,600]]);
  assert.equal(regionsFor([run([...open,...open.toReversed()])]).length,0);
  const near=sampled([[0,0],[600,0],[600,600],[0,600],[0,15]]);
  assert(isEnclosed(regionsFor([run(near)]),geo([300,300])),'small GPS drift may join');
});

test('concave loops and crossing loops keep the outside outside', () => {
  const concave=sampled([[0,0],[800,0],[800,800],[500,800],[500,300],[300,300],[300,800],[0,800],[0,0]]);
  const regions=regionsFor([run(concave)]);
  assert(isEnclosed(regions,geo([150,500])));assert(isEnclosed(regions,geo([650,500])));
  assert(!isEnclosed(regions,geo([400,600])),'the notch must not be treated as a convex hull');
  const eight=regionsFor([run(sampled([[0,0],[600,600],[0,600],[600,0],[0,0]]))]);
  assert(isEnclosed(eight,geo([300,100])));assert(isEnclosed(eight,geo([300,500])));
  assert(!isEnclosed(eight,geo([50,300])));
});

test('missing samples and long jumps leave a loop open; remote outings do not connect', () => {
  const open=sampled([[0,0],[600,0],[600,600],[0,600],[0,400]]);
  assert.equal(regionsFor([run([...open,null,geo([0,0])])]).length,0);
  assert.equal(regionsFor([run([...open,geo([0,0])])]).length,0,'400m jump is split before enclosure detection');
  const local=run(sampled(square)),remote=run(sampled(square,51,0),'remote');
  const regions=regionsFor([local,remote]);
  assert(isEnclosed(regions,geo([300,300])));assert(isEnclosed(regions,geo([300,300],51,0)));
  assert(!isEnclosed(regions,[45,60]));assert.equal(regionsFor([]).length,0);
  assert.equal(regionsFor([run([geo([0,0])])]).length,0);
});

test('enclosures remain local at high latitude and when several tracks cross the date line', () => {
  for(const [lat,lon]of [[80,0],[0,179.998]]) {
    const runs=[run([[0,0]],'unrelated'),run(sampled(square.slice(0,3),lat,lon)),run(sampled(square.slice(2),lat,lon),'b')];
    const regions=regionsFor(runs);
    assert(isEnclosed(regions,geo([300,300],lat,lon)));
    assert(!isEnclosed(regions,geo([1000,300],lat,lon)));
    assert(regions.every(r=>r.maxX-r.minX<.1));
  }
});

test('projection unwraps the date line locally and preserves world-pixel scale across zoom', () => {
  const crossing = explorationPaths([run([[0,179.9995],[0,-179.9995]])]);
  const at16 = projectExploration(crossing,16)[0],at17=projectExploration(crossing,17)[0];
  assert(at16.maxX-at16.minX<100);
  assert(Math.abs((at16.maxX-at16.minX)*2-(at17.maxX-at17.minX))<1e-6);
  assert(at17.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
});

test('first runs, repeat visits and later extensions compare against earlier days only', () => {
  const a=run([[0,0],[0,.001]]), b=run([[0,0],[0,.001]],'b','2026-11-02'),
    c=run([[0,0],[0,.001],[0,.002]],'c','2026-11-03'), d=run([[0,.001],[0,0]],'d','2026-11-03');
  const result=explorationByRun([c,b,a,d]);
  assert(result.get('a').first);assert.equal(result.get('a').fresh,result.get('a').total);
  assert.equal(result.get('b').fresh,0);assert.equal(result.get('d').fresh,0);
  assert(result.get('c').fresh>40&&result.get('c').fresh<120);
  assert.equal(result.size,4);
});

test('nearby-edge lookup respects metre distances at high latitude and across the date line', () => {
  for(const path of [[[80,0],[80,.005]],[[0,179.9995],[0,-179.9995]]]) {
    const shifted=path.map(([lat,lon])=>[lat+.0006,lon]);
    const result=explorationByRun([run(path),run([...path].reverse(),'repeat','2026-11-02'),run(shifted,'new','2026-11-03')]);
    assert.equal(result.get('repeat').fresh,0);
    assert(Math.abs(result.get('new').fresh-result.get('new').total)<1e-6);
  }
});
