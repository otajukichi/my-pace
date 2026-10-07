// Independent review: uncertainty must pause work, never confer authorization.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ImportStoreBinding,importKeys} from './import-store.mjs';
function fixture(){
 const r={fileId:'asset',storeId:'store',jobId:'job',pinId:'pin',role:'output',byteLength:32,sha256:'a'.repeat(64)},values=new Map();let faultKey=null,fault=null;
 values.set(importKeys.job('job'),{storeId:'store',jobId:'job',pinActive:true,status:'active',runId:'run'});
 values.set(importKeys.pin('pin'),{storeId:'store',jobId:'job',state:'ready',assets:[r]});values.set(importKeys.asset('asset'),{fileId:'asset',jobId:'job',pinId:'pin'});values.set(importKeys.run('run'),{imported:{jobId:'job'}});
 const writer={get:key=>{if(key===faultKey)throw fault;return values.has(key)?{value:values.get(key),version:1}:null;},transact(){},getReceipt(){},recoveryBarrier(){}};
 const store=new ImportStoreBinding({writer,storeId:'store',readAsset:()=>{throw Error('authorization must not fetch bytes');},validateSourceCurrent:()=>true});
 return {r,values,store,inject:(key,error)=>{faultKey=key;fault=error;}};
}
const makeError=(message,properties={})=>Object.assign(Error(message),properties);
const errors=[
 ['STORE_YIELD',()=>makeError('STORE_YIELD')],['IMPORT_YIELD',()=>makeError('IMPORT_YIELD')],['OWNER_BUDGET_YIELD',()=>makeError('OWNER_BUDGET_YIELD')],
 ['recovery pending',()=>makeError('WRITER_RECOVERY_PENDING',{retryable:true})],['recovery required',()=>makeError('WRITER_RECOVERY_REQUIRED')],['recovery setup',()=>makeError('WRITER_RECOVERY_SETUP_REQUIRED',{requiresOwnerAction:true})],
 ['retryable metadata',()=>makeError('STORE_METADATA_UNRESOLVED',{retryable:true,status:503})],['code-only yield',()=>makeError('internal detail',{code:'STORE_YIELD'})]
];
for(const [name,errorFactory] of errors)for(const method of ['assertReservation','assertReadableAsset'])test(`${method} propagates ${name} without claiming authorization or denial`,()=>{
 for(const key of [importKeys.job('job'),importKeys.pin('pin'),...(method==='assertReadableAsset'?[importKeys.asset('asset')]:[])]){const f=fixture(),error=errorFactory();f.inject(key,error);assert.throws(()=>method==='assertReservation'?f.store.assertReservation(f.r):f.store.assertReadableAsset('asset',32,64),actual=>actual===error);}
});

test('completed publication lookup also preserves budget uncertainty',()=>{const f=fixture(),job=f.values.get(importKeys.job('job'));job.pinActive=false;job.status='completed';const e=makeError('STORE_YIELD');f.inject(importKeys.run('run'),e);assert.throws(()=>f.store.assertReadableAsset('asset',32,64),actual=>actual===e);});

test('real absent or mismatched reservations remain false',()=>{
 for(const method of ['assertReservation','assertReadableAsset'])for(const mutate of [
  f=>f.values.delete(importKeys.job('job')),f=>f.values.delete(importKeys.pin('pin')),f=>{f.values.get(importKeys.job('job')).storeId='different';},f=>{f.values.get(importKeys.pin('pin')).jobId='different';},f=>{f.values.get(importKeys.pin('pin')).state='uncommitted';},f=>{f.values.get(importKeys.pin('pin')).assets=[];}
 ]){const f=fixture();mutate(f);assert.equal(method==='assertReservation'?f.store.assertReservation(f.r):f.store.assertReadableAsset('asset',32,64),false);}
 const f=fixture();f.values.delete(importKeys.asset('asset'));assert.equal(f.store.assertReadableAsset('asset',32,64),false);assert.equal(f.store.assertReservation(null),false);assert.equal(f.store.assertReadableAsset('missing',32,64),false);
});

test('completed assets require the current published job and cannot regain staging permission',()=>{
 const f=fixture(),job=f.values.get(importKeys.job('job'));job.pinActive=false;job.status='completed';assert.equal(f.store.assertReadableAsset('asset',32,64),true);assert.equal(f.store.assertReservation(f.r),false);
 f.values.get(importKeys.run('run')).imported.jobId='new-generation';assert.equal(f.store.assertReadableAsset('asset',32,64),false);assert.equal(f.store.assertReservation(f.r),false);
});

test('mismatched bytes and ordinary missing-entity errors stay denied',()=>{
 const f=fixture();assert.equal(f.store.assertReservation({...f.r,byteLength:31}),false);assert.equal(f.store.assertReadableAsset('asset',31,64),false);assert.equal(f.store.assertReadableAsset('asset',32,31),false);
 const e=makeError('IMPORT_ENTITY_MISSING');f.inject(importKeys.job('job'),e);assert.equal(f.store.assertReservation(f.r),false);assert.equal(f.store.assertReadableAsset('asset',32,64),false);
});
