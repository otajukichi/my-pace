import test from 'node:test';
import assert from 'node:assert/strict';
import {gasWebFixture} from '../helpers/gas-web-fixture.mjs';
const command=f=>({operationId:'owner_gate_legacy_diary_0001',epoch:'default',generation:'1',store:f.config.storeId,key:'diary:2026-10-07',expectedVersion:0,deleted:false,value:{text:'既存の日記は残す',mood:null},recreate:false});
const immutable=f=>new Map([...f.files].filter(([,e])=>e.bytes&&e.meta.appProperties?.['mypace.role']!=='checkpoint-hint').map(([id,e])=>[id,Uint8Array.from(e.bytes)]));
function preserved(f,before){for(const[id,b]of before)assert.deepEqual(f.files.get(id).bytes,b);}

test('generated owner gate preserves legacy diary, original receipt, pinned IDs and generation',()=>{
 const f=gasWebFixture({allowOwnerBootstrapReads:true}),c=command(f),legacy=f.invoke('command',c);assert.equal(legacy.ok,true);assert.equal(legacy.result.result.appSeq,undefined);
 const before=immutable(f),pins=f.properties.get('mypace.production.store.v1');
 const blocked=f.invoke('pull',{cursor:null,since:null,minimumAcknowledged:null});assert.equal(blocked.ok,false);assert.equal(blocked.error,'SYNC_V2_MIGRATION_REQUIRED');assert.equal(blocked.requiresOwnerAction,true);preserved(f,before);
 const result=f.context.MyPaceEnableIncrementalSync();assert.equal(result.status,'incremental-sync-enabled');assert.equal(result.writerFence,2);assert.equal(result.alreadyEnabled,false);assert.equal(f.properties.get('mypace.production.store.v1'),pins);assert.equal(result.storeId,f.config.storeId);assert.equal(result.datasetGeneration,'1');preserved(f,before);
 const replay=f.invoke('commandV2',c);assert.deepEqual(replay,legacy);
 const pull=f.invoke('pull',{cursor:null,since:null,minimumAcknowledged:null});assert.equal(pull.ok,true,JSON.stringify(pull));assert.equal(pull.result.targetSeq,0);assert.equal(pull.result.entries.length,1);assert.equal(pull.result.entries[0].value.text,c.value.text);
 const after=immutable(f),again=f.context.MyPaceEnableIncrementalSync();assert.equal(again.alreadyEnabled,true);assert.equal(again.revision,result.revision);assert.equal(immutable(f).size,after.size);preserved(f,after);
});

test('generated owner activation requires both editor identities before storage work',()=>{
 for(const name of ['active','effective']){const f=gasWebFixture({allowOwnerBootstrapReads:true});f.state[name]='visitor@example.com';const before=f.restCalls.length,files=immutable(f);assert.throws(()=>f.context.MyPaceEnableIncrementalSync(),/OWNER_UNVERIFIED/);assert.equal(f.restCalls.length,before);assert.equal(immutable(f).size,files.size);preserved(f,files);}
});

test('generated public endpoint cannot invoke activation and never bootstraps missing pins',()=>{
 const f=gasWebFixture({allowOwnerBootstrapReads:true}),before=f.restCalls.length,pins=f.properties.get('mypace.production.store.v1');for(const action of ['activateSyncV2','MyPaceEnableIncrementalSync','enableFormatFence'])assert.equal(f.invoke(action,{}).ok,false);assert.equal(f.restCalls.length,before);assert.equal(f.properties.get('mypace.production.store.v1'),pins);
 f.properties.delete('mypace.production.store.v1');const files=immutable(f),out=f.context.MyPaceEnableIncrementalSync();assert.equal(out.status,'setup-needed');assert.equal(out.code,'OWNER_BOOTSTRAP_REQUIRED');assert.equal(f.properties.has('mypace.production.store.v1'),false);assert.equal(immutable(f).size,files.size);preserved(f,files);
});
