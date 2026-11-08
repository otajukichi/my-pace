import test from 'node:test';
import assert from 'node:assert/strict';
import {decodedSpeed,speedColor,gradientChains,edgeGradient,UNKNOWN_SPEED_COLOR,RUN_OPACITY} from '../lib/route-speed.js';
import {dailySpeedColor} from '../旧my-pace/storage/daily-calculator.mjs';

test('all 49 imported speed colors decode exactly using the archived calculator scale',()=>{
 for(let n=0;n<=48;n++)assert.equal(decodedSpeed(dailySpeedColor(n/2)),n/2);
 assert.equal(decodedSpeed('#D36B40'),24);assert.equal(decodedSpeed('#ffffff'),null);assert.equal(decodedSpeed(null),null);
});
test('hues use an absolute scale across days, clamp at 6 and 14, and do not color unknown speeds as slow',()=>{
 assert.equal(speedColor(0),'#607fc6');assert.equal(speedColor(10),'#73ad83');assert.equal(speedColor(24),'#d56d52');
 assert.equal(speedColor(100),speedColor(14));assert.equal(speedColor(0),speedColor(6));assert.equal(speedColor(null),UNKNOWN_SPEED_COLOR);assert.equal(speedColor(-1),UNKNOWN_SPEED_COLOR);
 assert.equal(RUN_OPACITY,.68);
});
test('gradient models decode legacy edge colors and prefer valid explicit speeds',()=>{
 const run={segments:[{points:[[0,0],[0,1],[0,2],[0,3]],colors:[dailySpeedColor(6),dailySpeedColor(8),'unknown'],speedsKmh:[null,12,null]}]};
 const model=gradientChains(run);
 assert.equal(model.known,2);assert.equal(model.unknown,1);
 assert.equal(model.chains[0].gradients[0].find(([t])=>t===.5)[1],speedColor(6));
 assert.equal(model.chains[0].gradients[1].find(([t])=>t===.5)[1],speedColor(12));
 assert.deepEqual(model.chains[0].gradients[2],[[0,UNKNOWN_SPEED_COLOR],[1,UNKNOWN_SPEED_COLOR]]);
});

test('adjacent gradients meet at the same color and preserve recorded midpoint colors',()=>{
 const slow=edgeGradient(null,6,14),fast=edgeGradient(6,14,null);
 assert.equal(slow.at(-1)[1],fast[0][1]);
 assert.equal(slow.find(([offset])=>offset===.5)[1],speedColor(6));
 assert.equal(fast.find(([offset])=>offset===.5)[1],speedColor(14));
 assert(slow.some(([,color])=>color.toLowerCase()===speedColor(8)));
 assert(fast.some(([,color])=>color.toLowerCase()===speedColor(12)));
 for(const speeds of [[6,14,6],[14,6,14],[0,24,0],[8,8,8]]){
  const stops=edgeGradient(...speeds);
  assert(stops.every(([v],i)=>v>=0&&v<=1&&(!i||v>stops[i-1][0])));
 }
 assert.deepEqual(edgeGradient(6,null,14),[[0,UNKNOWN_SPEED_COLOR],[1,UNKNOWN_SPEED_COLOR]]);
 assert.equal(edgeGradient(null,8,null)[0][1],speedColor(8));
});

test('gradient geometry retains GPS breaks, unknown edges and independent segments without changing source data',()=>{
 const run={segments:[{points:[[0,0],[0,1],[0,1],[0,2],null,[0,4],[0,5]],speedsKmh:[6,10,14,null,null,8]},
  {points:[[0,5],[0,6],[0,7]],speedsKmh:[null,12]}]};
 const original=JSON.stringify(run),model=gradientChains(run);
 assert.equal(model.known,4);assert.equal(model.unknown,1);assert.equal(model.chains.length,3);
 assert.deepEqual(model.chains[0].points,[[0,0],[0,1],[0,2]]);
 assert.equal(model.chains[0].gradients[0].at(-1)[1],model.chains[0].gradients[1][0][1]);
 assert.deepEqual(model.chains[2].gradients[0],[[0,UNKNOWN_SPEED_COLOR],[1,UNKNOWN_SPEED_COLOR]]);
 assert.equal(model.chains[2].gradients[1][0][1],speedColor(12));
 assert.equal(JSON.stringify(run),original);
 assert.deepEqual(gradientChains({segments:[{points:[[0,0]]}]}),{known:0,unknown:0,chains:[]});
});
