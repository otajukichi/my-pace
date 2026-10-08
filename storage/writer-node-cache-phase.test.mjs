import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeFixture} from './runtime-fixture.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {writerDigest} from './reserved-writer.mjs';

for(const mode of ['bytes',false])test(`writer node cache cannot bypass fresh metadata when IO has no trusted phase (${mode})`,()=>{
 const f=runtimeFixture();f.config.protocolReadCache=mode===false?false:{mode};
 const runtime=createGasImportRuntime(f.globals,f.config);
 runtime.locked(()=>{
  const w=runtime.writer;w.bootstrap();w.transact({operationId:'node_cache_phase',digest:writerDigest('node_cache_phase'),changes:[{key:'private_record',expectedVersion:0,value:'private value'}]});
  assert.equal(w.getEntity('private_record').value,'private value');assert.equal(w.io.getVerifiedReadPhase(),null);
  f.files.get(w.status().stateRoot.id).meta.shared=true;
  assert.throws(()=>w.getEntity('private_record'),/STORE_METADATA_MISMATCH/);
 });
});

for(const restartPhase of [false,true])test(`writer cache rejects old private bytes after IO phase ends (${restartPhase?'replacement phase':'no phase'})`,()=>{
 const f=runtimeFixture();f.config.protocolReadCache={mode:'lock-phase'};const runtime=createGasImportRuntime(f.globals,f.config);
 runtime.locked(()=>{
  const w=runtime.writer;w.bootstrap();w.transact({operationId:'node_cache_phase',digest:writerDigest('node_cache_phase'),changes:[{key:'private_record',expectedVersion:0,value:'private value'}]});
  assert.equal(w.getEntity('private_record').value,'private value');w.io.endReadPhase();if(restartPhase)w.io.beginReadPhase();
  f.files.get(w.status().stateRoot.id).meta.shared=true;
  assert.throws(()=>w.getEntity('private_record'),/STORE_METADATA_MISMATCH/);
 });
});
