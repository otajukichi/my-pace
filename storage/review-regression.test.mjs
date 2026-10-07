import test from 'node:test';
import assert from 'node:assert/strict';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {runtimeFixture} from './runtime-fixture.mjs';
import {importKeys} from './import-store.mjs';

const open=f=>createGasImportRuntime(f.globals,f.config);
function parsedFixture(){
 const f=runtimeFixture(),r=open(f);
 r.locked(()=>r.writer.bootstrap());
 r.locked(()=>r.store.registerJob({operationId:'register_review',jobId:'review_job',sourceIdentity:f.source}));
 assert.equal(r.runner.stepJob('review_job').status,'parsed');
 const resumed=r.locked(()=>r.store.resumeJob('review_job'));
 return {f,r,job:resumed.job};
}

test('checkpoint budget yield retains retryability, not a JSON-corruption label',()=>{
 const {f}=parsedFixture();f.config.checkBudget=stage=>stage!=='asset-media';const r=open(f);
 assert.throws(()=>r.locked(()=>r.store.resumeJob('review_job')),error=>{
  assert.equal(error.message,'IMPORT_YIELD');assert.equal(error.retryable,true);return true;
 });
 assert.equal(f.lock.hasLock(),false);
});

test('checkpoint media outage retains retryability, and a later cold retry succeeds',()=>{
 const {f,job}=parsedFixture(),original=f.globals.UrlFetchApp.fetch;
 f.globals.UrlFetchApp.fetch=(url,options)=>{const u=new URL(url);if(u.pathname.endsWith('/'+job.checkpoint.fileId)&&u.searchParams.get('alt')==='media')throw Error('injected read outage');return original(url,options);};
 const r=open(f);assert.throws(()=>r.locked(()=>r.store.resumeJob('review_job')),error=>{
  assert.equal(error.message,'ASSET_MEDIA_PENDING');assert.equal(error.retryable,true);return true;
 });
 f.globals.UrlFetchApp.fetch=original;const retry=open(f);assert.equal(retry.locked(()=>retry.store.resumeJob('review_job')).job.status,'parsed');assert.equal(f.lock.hasLock(),false);
});

test('a failed recovery barrier invalidates cached reads until a new successful recovery',()=>{
 const {f,r}=parsedFixture(),next=r.locked(()=>r.writer.status().nextSlotId),original=f.globals.UrlFetchApp.fetch;
 f.globals.UrlFetchApp.fetch=(url,options)=>{if(new URL(url).pathname.endsWith('/'+next))throw Error('injected tail outage');return original(url,options);};
 r.locked(()=>{
  assert.throws(()=>r.writer.recoveryBarrier(),/STORE_READ_UNRESOLVED/);
  for(const action of [()=>r.writer.status(),()=>r.writer.get(importKeys.job('review_job')),()=>r.writer.getReceipt('register_review')])assert.throws(action,/WRITER_RECOVERY_REQUIRED/);
 });
 f.globals.UrlFetchApp.fetch=original;r.locked(()=>{r.writer.recoveryBarrier();assert.equal(r.writer.get(importKeys.job('review_job')).value.status,'parsed');});
});

test('a separately committed cancellation invalidates an old runtime reservation before create',()=>{
 const {f,r,job}=parsedFixture();
 const reservation=r.locked(()=>r.writer.get(importKeys.pin(job.lastPin)).value.assets.find(a=>a.role==='output'));
 const bytes=Uint8Array.from(f.files.get(reservation.fileId).bytes),other=open(f);
 other.locked(()=>other.store.cancelJob({operationId:'cancel_review',jobId:'review_job'}));
 const creates=f.calls.filter(c=>c[0]==='create').length;
 assert.throws(()=>r.assets.putOnce({reservation,bytes}),/RESERVATION_NOT_DURABLE/);
 assert.equal(f.calls.filter(c=>c[0]==='create').length,creates);assert.equal(f.lock.hasLock(),false);
});
