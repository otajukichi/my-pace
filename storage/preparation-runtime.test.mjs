import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {createGasCheckpointHintCodec} from './checkpoint-hint.mjs';
import {createGasPreparationCodec} from './preparation-codec.mjs';
import {createScheduledImportRuntime} from './scheduled-runtime.mjs';
import {clockEvent} from './scheduled-runtime-fixture.mjs';
import {gasWebFixture} from '../tests/helpers/gas-web-fixture.mjs';
import {restrictGasContext} from '../tests/helpers/gas-compat.js';
const owner='yakitorihanbagu0412@gmail.com',newSecret='rotated-synthetic-preparation-test-key-32bytes';
const command=f=>({operationId:'owner_prepared_write_001',epoch:'default',generation:'1',store:f.config.storeId,key:'diary:2026-10-07',expectedVersion:0,deleted:false,value:{text:'Retain this diary',mood:null},recreate:false});
function prepared(){const f=gasWebFixture({activate:true,allowOwnerBootstrapReads:true}),c=command(f),result=f.invoke('commandV2',c);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.result.result.appSeq,1);return {f,c,receipt:result.result};}
function inspect(f,key){const runtime=createGasImportRuntime(f.globals,{...f.config,checkBudget:()=>true,checkpointHintCodec:createGasCheckpointHintCodec({Utilities:f.globals.Utilities,secret:key}),preparationCodec:createGasPreparationCodec({Utilities:f.globals.Utilities,secret:key}),protocolReadCache:{mode:'lock-phase'}});assert.equal(typeof runtime.writer.prepareAppCommand,'function','known adapter is defaulted by the shared runtime');return runtime.locked(()=>{runtime.writer.recoveryBarrier();return {receipt:runtime.writer.getReceipt('owner_prepared_write_001','default'),data:runtime.writer.getEntity('app/data/diary:2026-10-07'),journal:runtime.writer.getEntity('app/change-head')};});}

test('generated owner recovery and explicit bootstrap retry replay old-key prepared work without resetting identity',()=>{
 const {f,c,receipt}=prepared(),config=f.properties.get('mypace.production.store.v1'),writes=f.events.filter(e=>e[0]==='property-write').length;
 f.properties.set('MYPACE_WRITER_SECRET',newSecret);const restored=f.context.MyPaceRecoverStorage();assert.equal(restored.status,'ready',JSON.stringify(restored));assert.equal(restored.storage.datasetGeneration,'1');
 const again=f.api({ownerEmail:owner}).bootstrap();assert.equal(again.anchorId,f.config.anchorId);assert.equal(again.storeId,f.config.storeId);assert.equal(f.properties.get('mypace.production.store.v1'),config);assert.equal(f.properties.get('MYPACE_WRITER_SECRET'),newSecret);assert.equal(f.events.filter(e=>e[0]==='property-write').length,writes);
 const state=inspect(f,newSecret);assert.deepEqual(state.receipt,receipt);assert.equal(state.data.value.text,c.value.text);assert.equal(state.journal.value.seq,1);
});

test('scheduled owner runtime has the same known adapter and existing-secret proof after key rotation',()=>{
 const {f,c,receipt}=prepared(),config=f.properties.get('mypace.production.store.v1'),writes=f.events.filter(e=>e[0]==='property-write').length;
 f.properties.set('MYPACE_WRITER_SECRET',newSecret);f.globals.ScriptApp.AuthMode={FULL:'FULL'};f.globals.Drive.Files.list=()=>({files:[]});f.state.active='';
 const result=createScheduledImportRuntime(f.globals,{now:()=>f.now}).tick(clockEvent());assert(!['blocked','setup-needed'].includes(result.status),JSON.stringify(result));assert.equal(f.properties.get('mypace.production.store.v1'),config);assert.equal(f.properties.get('MYPACE_WRITER_SECRET'),newSecret);assert.equal(f.events.filter(e=>e[0]==='property-write').length,writes);
 const state=inspect(f,newSecret);assert.deepEqual(state.receipt,receipt);assert.equal(state.data.value.text,c.value.text);assert.equal(state.journal.value.seq,1);
});

test('private application dependencies do not replace the public storage limits or run IO on bundle load',()=>{
 const context=restrictGasContext(vm.createContext({}));vm.runInContext(fs.readFileSync(new URL('gas/FolderImport.gs',import.meta.url),'utf8'),context);
 assert.equal(context.MyPaceFolderImport.LIMITS.range,1048576);assert.equal(context.MyPaceFolderImport.LIMITS.checkpoint,2097152);assert.equal(typeof context.MyPaceFolderImport.createPreparedAppCommand,'function');assert.equal(context.MyPaceFolderImport.createInitialState,undefined);
});
