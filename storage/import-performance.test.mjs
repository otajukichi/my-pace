import test from 'node:test';
import assert from 'node:assert/strict';
import {LIMITS} from './bounded-import.mjs';
import {measureColdOwnerImport} from './import-performance.mjs';

// Regression ceilings retain ~25–40% request headroom over the frozen counts.
// Final checkpoints keep completed cold recovery independent of import length.
test('one-row cold scheduler remains within protocol IO regression bounds',()=>{
 const result=measureColdOwnerImport();assert.equal(result.completedSampleCount,1);assert(result.coldRecovery.requests<=40);assert(result.requests<=400,JSON.stringify(result));assert(result.invocations.length<=2);assert(result.filesByRole['index-node']<=80);assert.equal(result.filesByRole.output,1);
});
test('one-MiB multi-range CSV cold-resumes and publishes all rows within bounded calls/files',()=>{
 const result=measureColdOwnerImport({minimumBytes:1024*1024});assert(result.sourceBytes>=1024*1024);assert(result.coldRecovery.requests<=40);assert(result.requests<=1100,JSON.stringify(result));assert(result.invocations.length<=4);assert(result.invocations.every(r=>r.calls<=1900));assert.equal(result.filesByRole.checkpoint,Math.ceil(result.sourceBytes/LIMITS.range));assert.equal(result.filesByRole['manifest-page'],Math.ceil(result.sourceBytes/LIMITS.range));assert.equal(result.filesByRole.output,12);assert(result.filesByRole['index-node']<=300);assert(result.filesByRole.frame<=50);
});

test('one-MiB 21-column sensor CSV verifies row count and realistic output density',()=>{const result=measureColdOwnerImport({minimumBytes:1024*1024,sensor:true});assert(result.coldRecovery.requests<=40);assert(result.rowBytes>=200&&result.rowBytes<=215);assert(result.rows>=4900&&result.rows<=5300);assert(result.requests<=550,JSON.stringify(result));assert(result.filesByRole.output<=10);assert(result.invocations.length<=2);});
