import test from 'node:test';
import assert from 'node:assert/strict';
import { paceSeries } from '../lib/run-analysis.js';

test('pace charts preserve missing intervals and include the average in their scale',()=>{
  const run={summary:{durationSeconds:500,paceSecondsPerKm:600},paceSamples:[
    {elapsedSeconds:60,paceSecondsPerKm:300,coverage:1},
    {elapsedSeconds:120,paceSecondsPerKm:330,coverage:1},
    {elapsedSeconds:180,paceSecondsPerKm:320,coverage:.1},
    {elapsedSeconds:240,paceSecondsPerKm:340},
    {elapsedSeconds:400,paceSecondsPerKm:350},
    {elapsedSeconds:460,paceSecondsPerKm:NaN},
  ]};
  const result=paceSeries(run);
  assert.deepEqual(result.series.map(s=>s.map(p=>p.elapsedSeconds)),[[60,120],[240],[400]]);
  assert(result.low<=300&&result.high>=600);
  assert.equal(paceSeries({...run,summary:{durationSeconds:0}}),null);
  assert.equal(paceSeries({...run,paceSamples:[]}),null);
});
