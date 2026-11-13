import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDriveRunningSource, driveRequest } from '../lib/running-drive.js';
import { indexRunDays } from '../lib/running-calendar.js';
import { runningSlot } from '../lib/run-slots.js';
import { runningSelectionData } from '../lib/running-view.js';
import { paintPreparedMask } from '../lib/prepared-mask.js';

function fixture() {
  const files = new Map(), reads = [];
  const put = value => { const bytes = JSON.stringify(value) + '\n', path = 'objects/' + createHash('sha256').update(bytes).digest('hex') + '.json'; files.set(path, value); return { path, bytes: Buffer.byteLength(bytes) }; };
  const route = { schema: 1, kind: 'route', id: 'run-a', date: '2026-01-01', encoding: 'delta-e6-speed10', segments: [{ chain: 0, part: 0, data: [[0, 0], [0, 1000, 100]] }] };
  const summary = { distanceMeters: 111, durationSeconds: 40, paceSecondsPerKm: 360 };
  const run = { id: 'run-a', date: route.date, start: '2026-01-01T00:00:00Z', summary, freshMeters: 72, thumbnail: [[[60, 260], [660, 260]]], route: [put(route)],
    analysis: put({ schema: 1, kind: 'analysis', id: 'run-a', paceSamples: [[20, 360, 1]], splits: [[1, 111, 40, 360, 1, true]] }) };
  const synthetic = { ...run, id: 'r_' + createHash('sha256').update('control').digest('hex').slice(0,24) + '_2001-01-01', date: '2001-01-01' };
  const month = { month: '2026-01', lists: [put({ schema: 1, kind: 'month', runs: [run, synthetic] })], overview: [put({ schema: 1, kind: 'overview', routes: [route] })] };
  const year = put({ schema: 1, kind: 'year', months: [month], days: [[run.date,111,40,1]] });
  const near = put({ schema: 1, kind: 'exploration', tiles: [{ x: 32768, y: 32768, rle: [4096, 255] }] });
  const far = put({ schema: 1, kind: 'exploration', tiles: [{ x: 100, y: 100, rle: [4096, 255] }] });
  files.set('index.json', { schema: 1, kind: 'catalog', years: { 2026: year }, exploration: { zoom: 16, size: 64, blockTiles: 16, blocks: { '2048/2048': [near], '6/6': [far] } } });
  return { files, reads, run, near, far, source: createDriveRunningSource({ fetchJson: async path => { reads.push(path); return structuredClone(files.get(path)); } }) };
}
test('calendar, summaries, outlines and new-road totals load without full GPS or CSV', async () => {
  const f = fixture(), data = await f.source.load();
  assert.equal(data.runs.length,1); assert.equal(f.reads.length,3); assert(!f.reads.includes(f.run.route[0].path));
  const days=indexRunDays(data.runs,'2026-12-31');
  assert.equal(runningSelectionData({ days, selectedDay:'2026-01-01', month:'2026-01', explorationStats:data.explorationStats }).fresh,72);
  assert.match(runningSlot({ days,selectedDay:'2026-01-01',month:'2026-01',lastSelectedDay:'2026-01-01' }), /class="run-thumbnail"/);
  assert(!data.runs[0].segments);
});
test('daily detail and monthly overview are independent lazy reads, with gaps preserved', async () => {
  const f=fixture();await f.source.load();
  const first=await f.source.view({day:'2026-01-01',month:'2026-01'});
  assert.deepEqual(first.routes[0].segments[0].points,[[0,0],[0,.001]]);assert.equal(first.detail,null);
  assert(!f.reads.includes(f.run.analysis.path));
  const detail=await f.source.view({day:'2026-01-01',month:'2026-01',analysis:true,runId:f.run.id});
  assert.equal(detail.detail.splits[0].partial,true); assert.equal(detail.detail.paceSamples[0].paceSecondsPerKm,360);
  assert.equal(f.reads.filter(p=>p===f.run.route[0].path).length,1);
  const monthly=await f.source.view({month:'2026-01'});assert.deepEqual(monthly.routes[0].segments,first.routes[0].segments);
  assert.deepEqual((await f.source.view({day:'2026-01-02',month:'2026-01'})).routes,[]);
});
test('only exploration blocks in the visible map are fetched; reuse and clear work', async () => {
  const f=fixture();await f.source.load();
  const [a,b]=await Promise.all([f.source.maskTiles({x:32768,y:32768,z:16}),f.source.maskTiles({x:32768,y:32768,z:16})]);
  assert.equal(a.length,1);assert.equal(b[0].cells[42],255);assert.equal(f.reads.filter(p=>p===f.near.path).length,1);assert(!f.reads.includes(f.far.path));
  f.source.clear();assert.deepEqual(await f.source.maskTiles({x:32768,y:32768,z:16}),[]);
});
test('mask painting uses prepared alpha values and world coordinates, not a new GPS analysis', () => {
  const operations=[];const ctx={setTransform(){},clearRect(){},fillRect(){},drawImage(...args){operations.push(args);}};
  const canvas=()=>({getContext:()=>({createImageData:()=>({data:new Uint8ClampedArray(64*64*4)}),putImageData(data){assert.equal(data.data[3],255);}})});
  paintPreparedMask(ctx,[{x:32768,y:32768,cells:new Uint8Array(4096).fill(255)}],{x:32768,y:32768,z:16,color:'#000',revealColor:'#fff',revealOpacity:.2},canvas);
  assert.deepEqual(operations[0].slice(1),[0,0,256,256]);assert.equal(ctx.globalCompositeOperation,'source-over');assert.equal(ctx.globalAlpha,1);
});
test('unauthorized transport reports login without leaking provider data', async () => {
  await assert.rejects(driveRequest('/api/running-drive',{path:'index.json'},async()=>Response.json({error:{code:'SIGN_IN'}},{status:401})),e=>e.code==='SIGN_IN'&&e.message.includes('ログイン'));
});
