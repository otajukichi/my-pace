import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENTITY_QUATERNION, SPHERE_POINTS, SPHERE_EDGES, rotatePoint,
  quaternionBetween, multiplyQuaternions, slerpQuaternions, focusQuaternion,
  greatCirclePoints, slerpPoint, arcballPoint, dragQuaternion, projectPoint,
} from '../lib/english-sphere-math.js';

const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a-b) <= tolerance, `${a} should equal ${b}`);
const vectorClose = (a, b, tolerance) => a.forEach((value, index) => close(value, b[index], tolerance));
const length = point => Math.hypot(...point);
const angle = (a,b) => Math.acos(Math.min(1, Math.max(-1, a.reduce((sum,value,index)=>sum+value*b[index],0))));

test('all eight areas occupy a sphere and each connects directly to every other area', () => {
  assert.equal(SPHERE_POINTS.length, 8);
  assert.equal(SPHERE_EDGES.length, 28);
  assert.equal(new Set(SPHERE_EDGES.map(pair=>pair.join('/'))).size, 28);
  for (let index=0;index<8;index++) {
    close(length(SPHERE_POINTS[index]),1);
    const neighbors=SPHERE_EDGES.filter(pair=>pair.includes(index)).map(pair=>pair.find(other=>other!==index));
    assert.deepEqual(neighbors.sort((a,b)=>a-b),[0,1,2,3,4,5,6,7].filter(other=>other!==index));
  }
  assert.ok(new Set(SPHERE_POINTS.map(point=>point[1])).size>4, 'vertical positions must not form one ring');
  assert.ok(SPHERE_POINTS.some(point=>point[2]<0) && SPHERE_POINTS.some(point=>point[2]>0));
  for (let a=0;a<8;a++) for (let b=a+1;b<8;b++) assert.ok(angle(SPHERE_POINTS[a],SPHERE_POINTS[b])>.8,'areas must be separated');
});

test('every area can be reached directly from every other area, including after arbitrary camera roll', () => {
  const roll=quaternionBetween([1,0,0],[0,1,0]);
  for (let from=0;from<8;from++) for (let to=0;to<8;to++) {
    const start=multiplyQuaternions(roll,focusQuaternion(from));
    const target=focusQuaternion(to,start);
    close(length(target),1);
    vectorClose(rotatePoint(SPHERE_POINTS[to],target),[0,0,1]);
    for (const point of SPHERE_POINTS) close(length(rotatePoint(point,target)),1);
  }
});

test('quaternion interpolation follows the short arc at a constant angular rate', () => {
  const destination=quaternionBetween([0,0,1],[1,0,0]);
  for (const sign of [1,-1]) {
    const q=destination.map(value=>sign*value), points=[0,.25,.5,.75,1].map(t=>rotatePoint([0,0,1],slerpQuaternions(IDENTITY_QUATERNION,q,t)));
    vectorClose(points.at(-1),[1,0,0]);
    for (let index=1;index<points.length;index++) close(angle(points[index-1],points[index]),Math.PI/8);
  }
  const same=IDENTITY_QUATERNION.map(value=>-value);
  vectorClose(slerpQuaternions(IDENTITY_QUATERNION,same,.5),IDENTITY_QUATERNION);
});

test('an interrupted transition retargets exactly from its displayed orientation without a reset', () => {
  const initial=focusQuaternion(0), firstDestination=focusQuaternion(6,initial);
  const displayed=slerpQuaternions(initial,firstDestination,.37), nextDestination=focusQuaternion(2,displayed);
  const nextStart=slerpQuaternions(displayed,nextDestination,0);
  vectorClose(nextStart,displayed);
  vectorClose(rotatePoint(SPHERE_POINTS[2],nextDestination),[0,0,1]);
  assert.ok(angle(rotatePoint(SPHERE_POINTS[0],displayed),[0,0,1])>.1);
});

test('great-circle connections stay finite and on the surface for every edge and both degeneracies', () => {
  const pairs=[...SPHERE_EDGES.map(([a,b])=>[SPHERE_POINTS[a],SPHERE_POINTS[b]]),[[1,0,0],[1,0,0]],[[0,1,0],[0,-1,0]],[[0,0,1],[0,0,-1]]];
  for (const [from,to] of pairs) {
    const arc=greatCirclePoints(from,to,24);
    assert.equal(arc.length,25);
    vectorClose(arc[0],from);vectorClose(arc.at(-1),to);
    arc.forEach(point=>{assert.ok(point.every(Number.isFinite));close(length(point),1);});
    const expectedStep=angle(from,to)/24;
    for(let index=1;index<arc.length;index++)close(angle(arc[index-1],arc[index]),expectedStep,3e-8);
    vectorClose(slerpPoint(from,to,.5),arc[12]);
  }
});

test('arcball dragging works vertically and horizontally without singularities outside its rim', () => {
  const center=arcballPoint(0,0);
  vectorClose(center,[0,0,1]);
  for (const [x,y] of [[.4,0],[0,.4],[2,3],[-2,-3],[1,0]]) {
    const endpoint=arcballPoint(x,y), q=dragQuaternion(center,endpoint);
    close(length(endpoint),1);close(length(q),1);
    vectorClose(rotatePoint(center,q),endpoint);
  }
  const rotated=focusQuaternion(4), start=arcballPoint(.1,.2), end=arcballPoint(-.3,.4);
  vectorClose(dragQuaternion(start,end,rotated),multiplyQuaternions(quaternionBetween(start,end),rotated));
});

test('perspective projection preserves centre, depth and a bounded sphere silhouette', () => {
  const options={radius:180,camera:4,centerX:400,centerY:240};
  assert.deepEqual(projectPoint([0,0,1],options),{x:400,y:240,z:1,scale:4/3});
  assert.deepEqual(projectPoint([0,0,-1],options),{x:400,y:240,z:-1,scale:4/5});
  const silhouette=options.radius*options.camera/Math.sqrt(options.camera**2-1);
  for(let index=0;index<200;index++) {
    const phase=index*Math.PI*2/200, p=projectPoint([Math.sin(phase),0,Math.cos(phase)],options);
    assert.ok(Math.hypot(p.x-400,p.y-240)<=silhouette+1e-8);
    assert.ok(p.scale>=.8 && p.scale<=4/3);
  }
  assert.ok(projectPoint([0,1,0],options).y<options.centerY,'world up maps to screen up');
});

test('inputs are never mutated and invalid view parameters fail explicitly', () => {
  const point=[.3,.4,.5],q=[0,0,0,1],before=JSON.stringify({point,q});
  rotatePoint(point,q);quaternionBetween(point,[0,0,1]);slerpQuaternions(q,q,.5);greatCirclePoints(point,[1,0,0]);projectPoint(point);
  assert.equal(JSON.stringify({point,q}),before);
  assert.throws(()=>focusQuaternion(8),RangeError);
  assert.throws(()=>greatCirclePoints([1,0,0],[0,1,0],0),RangeError);
  assert.throws(()=>projectPoint([0,0,1],{camera:1}),RangeError);
  assert.throws(()=>projectPoint([0,0,4]),RangeError);
  assert.throws(()=>arcballPoint(Infinity,0),TypeError);
  assert.throws(()=>slerpQuaternions(q,q,NaN),TypeError);
});
