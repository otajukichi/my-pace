import test from 'node:test';import assert from 'node:assert/strict';
import {runtimeFixture} from './runtime-fixture.mjs';import {createGasImportRuntime} from './gas-import-runtime.mjs';
test('smaller trusted scheduled chunks do not change an already reserved manual range',()=>{
 const f=runtimeFixture('# sensor:multi_record\ntime,latitude,longitude\n'+'2026-01-01T00:00:00Z,1,2\n'.repeat(12000));
 const open=rangeBytes=>createGasImportRuntime(f.globals,{...f.config,rangeBytes,protocolReadCache:{mode:'lock-phase'}});
 let r=open(1048576);r.locked(()=>{r.writer.bootstrap();r.store.registerJob({operationId:'register',jobId:'job',sourceIdentity:f.source});});
 const create=f.globals.Drive.Files.create;f.globals.Drive.Files.create=(m,...args)=>{if(['output','checkpoint','manifest-page'].includes(m.appProperties?.['mypace.role']))throw Error('temporary upload failure');return create(m,...args);};
 assert.throws(()=>r.runner.stepJob('job'));const pending=r.locked(()=>r.store.resumeJob('job')).pending;assert.ok(pending);assert.equal(pending.transition.progress.offset,Number(f.source.size));
 f.globals.Drive.Files.create=create;r=open(32768);const resumed=r.runner.stepJob('job');assert.equal(resumed.status,'parsed');assert.equal(resumed.offset,Number(f.source.size));
 const done=r.locked(()=>r.store.getJob('job'));assert.equal(done.progress.points,12000);assert.equal(done.pending,null);
});
test('fresh trusted smaller chunks advance only their selected bound',()=>{
 const f=runtimeFixture('# sensor:multi_record\ntime,latitude,longitude\n'+'2026-01-01T00:00:00Z,1,2\n'.repeat(12000));const r=createGasImportRuntime(f.globals,{...f.config,rangeBytes:32768,protocolReadCache:{mode:'lock-phase'}});r.locked(()=>{r.writer.bootstrap();r.store.registerJob({operationId:'register',jobId:'job',sourceIdentity:f.source});});const result=r.runner.stepJob('job');assert.equal(result.status,'checkpointed');assert.equal(result.offset,32768);
});
