import test from 'node:test';import assert from 'node:assert/strict';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {runtimeFixture} from './runtime-fixture.mjs';
import {importKeys} from './import-store.mjs';
function open(f){return createGasImportRuntime(f.globals,f.config);}
function start(f){const r=open(f);r.locked(()=>r.writer.bootstrap());r.locked(()=>r.store.registerJob({operationId:'register',jobId:'job',sourceIdentity:f.source}));return r;}
test('real composed writer and GAS adapters import, cold-resume, verify and publish once',()=>{
 const f=runtimeFixture();let r=start(f);const original=Uint8Array.from(f.files.get('source').bytes);
 const result=r.runner.stepJob('job');assert.equal(result.status,'parsed');
 r=open(f);for(let i=0;i<4;i++)r.runner.finalizeJobStep('job');
 r=open(f);const restored=r.locked(()=>r.store.resumeJob('job'));assert.equal(restored.job.status,'completed');
 const run=r.locked(()=>r.writer.get(importKeys.run(restored.job.runId)));assert.equal(run.value.imported.sampleCount,1);assert.equal(run.value.imported.originalManaged,false);
 assert.deepEqual(f.files.get('source').bytes,original);assert.equal(f.calls.filter(c=>c[0]==='create'&&c[1]==='source').length,0);
});
test('new runtime reconstructs scan page and registered identity without local state',()=>{
 const f=runtimeFixture();let r=open(f);r.locked(()=>r.writer.bootstrap());r.locked(()=>r.store.beginScan({operationId:'scan_start',scanId:'scan'}));
 r.runner.stepScan('scan');r=open(f);r.runner.stepScan('scan');r=open(f);assert.equal(r.runner.stepScan('scan').status,'complete');
});
test('termination before output create resumes reserved IDs without duplicate assets',()=>{
 const f=runtimeFixture();let r=start(f);const create=f.globals.Drive.Files.create;let fault=true;
 f.globals.Drive.Files.create=(m,b,o)=>{if(fault&&m.appProperties['mypace.role']==='output'){fault=false;throw Error('terminated before output');}return create(m,b,o);};
 assert.throws(()=>r.runner.stepJob('job'),/ASSET_UNRESOLVED/);
 const pending=r.locked(()=>r.store.resumeJob('job')).pending;assert(pending);const ids=pending.assets.map(a=>a.fileId);
 r=open(f);assert.equal(r.runner.stepJob('job').status,'parsed');for(const id of ids)assert(f.files.has(id));
 const outputFiles=[...f.files.values()].filter(f=>f.meta.appProperties?.['mypace.role']==='output');assert.equal(outputFiles.length,1);
});
test('lost create responses for writer frames and every asset role recover at the same IDs',()=>{
 const f=runtimeFixture();f.setCreateFault(()=>true);let r=start(f);assert.equal(r.runner.stepJob('job').status,'parsed');r=open(f);for(let i=0;i<4;i++)r.runner.finalizeJobStep('job');assert.equal(r.locked(()=>r.store.resumeJob('job')).job.status,'completed');
});
test('changed asset privacy blocks resume before media download',()=>{
 const f=runtimeFixture();let r=start(f);r.runner.stepJob('job');const job=r.locked(()=>r.store.resumeJob('job')).job;
 f.files.get(job.checkpoint.fileId).meta.shared=true;r=open(f);const before=f.calls.length;assert.throws(()=>r.locked(()=>r.store.resumeJob('job')),/IMPORT_ASSET_JSON|ASSET_METADATA_MISMATCH/);
 assert.equal(f.calls.slice(before).filter(c=>c[0]==='fetch'&&c[1]===job.checkpoint.fileId).length,0);
});
test('source replacement prevents publication and retains staged job',()=>{
 const f=runtimeFixture();let r=start(f);r.runner.stepJob('job');r.runner.finalizeJobStep('job');r.runner.finalizeJobStep('job');f.files.get('source').meta.version='2';
 assert.throws(()=>r.runner.finalizeJobStep('job'),/SOURCE_CHANGED/);r=open(f);assert.equal(r.locked(()=>r.store.resumeJob('job')).job.status,'verified');
});
test('generated module-free GAS bundle executes the composed importer without Node byte codecs',async()=>{
 const {default:vm}=await import('node:vm');const {readFileSync}=await import('node:fs');
 const context={};vm.createContext(context);vm.runInContext(readFileSync(new URL('gas/FolderImport.gs',import.meta.url),'utf8'),context);
 const f=runtimeFixture();const api=context.MyPaceFolderImport;const r=api.createGasImportRuntime(f.globals,f.config);
 r.locked(()=>r.writer.bootstrap());r.locked(()=>r.store.registerJob({operationId:'register',jobId:'job',sourceIdentity:f.source}));assert.equal(r.runner.stepJob('job').status,'parsed');
 for(let i=0;i<4;i++)r.runner.finalizeJobStep('job');assert.equal(r.locked(()=>r.store.resumeJob('job')).job.status,'completed');
 assert.equal(context.Buffer,undefined);assert.equal(context.TextDecoder,undefined);assert.equal(context.TextEncoder,undefined);
});
test('multi-range import restarts every parse and finalization step with bounded checkpoints',()=>{
 const csv='# sensor:multi_record\ntime,latitude,longitude\n'+('2026-01-01T00:00:00Z,1,2\n'.repeat(45000));
 const f=runtimeFixture(csv);let r=start(f);let steps=0;
 while(true){r=open(f);const result=r.runner.stepJob('job');assert(++steps<10);if(result.status==='parsed')break;}
 assert(steps>1);for(let i=0;i<10;i++){r=open(f);r.runner.finalizeJobStep('job');const j=r.locked(()=>r.store.getJob('job'));if(j.status==='completed')break;assert(i<9);}
 r=open(f);const j=r.locked(()=>r.store.getJob('job'));assert.equal(j.status,'completed');const run=r.locked(()=>r.writer.get(importKeys.run(j.runId)));assert.equal(run.value.imported.sampleCount,45000);
 for(const {meta,bytes} of f.files.values()){if(meta.appProperties?.['mypace.role']==='checkpoint')assert(bytes.length<=2097152);if(meta.appProperties?.['mypace.role']==='output')assert(bytes.length<=262144);}
});
