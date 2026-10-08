import test from 'node:test';
import assert from 'node:assert/strict';
import {safeRecoveryProgress,createPublicServices} from '../../gas/public-services.mjs';
import {createSignedDispatcher} from '../../gas/signed-dispatcher.mjs';
import {canonical} from '../../src/lib/entity-codec.js';
import {mac} from '../../server/security.mjs';
const progress={phase:'preparation',ordinal:5,cursorPersisted:true,cursorAdvanced:true};
function failure(properties={}){return Object.assign(Error('STORE_YIELD'),{code:'STORE_YIELD',retryable:true,...properties});}
function service(error,continuation=null){return createPublicServices({runtime:{locked:fn=>fn(),writer:{continuationProgress:()=>continuation}},domain:{command(){throw error;}},reader:{},appSync:{},deadlineMs:1000,now:()=>0});}
function dispatch(services){const secret='x'.repeat(40),now=1000,dispatcher=createSignedDispatcher({owner:'yakitorihanbagu0412@gmail.com',store:'store',secret,hmac:mac,byteLength:s=>Buffer.byteLength(s),now:()=>now,createServices:()=>services}),unsigned={v:1,ts:now,nonce:'a'.repeat(43),owner:'yakitorihanbagu0412@gmail.com',store:'store',action:'command',payload:{}};return dispatcher(JSON.stringify({...unsigned,signature:mac(canonical(unsigned),secret)}));}

test('public recovery exposes only validated progress counters, never descriptor pointers or secrets',()=>{
 const secret={...progress,descriptorId:'private',hash:'f'.repeat(64),cursor:'signed-private-hint',command:{value:'private diary'}};assert.deepEqual(safeRecoveryProgress(secret),progress);
 for(const change of [{phase:'not-allowed'},{ordinal:0},{ordinal:-1},{ordinal:2.5},{ordinal:'2'},{ordinal:Number.MAX_SAFE_INTEGER+1},{cursorPersisted:false},{cursorAdvanced:false}])assert.equal(safeRecoveryProgress({...progress,...change}),null);
 for(const [phase,field]of [['frames','revision'],['index','indexLinks'],['checkpoint','revision']]){assert.deepEqual(safeRecoveryProgress({phase,[field]:3,cursorPersisted:true,cursorAdvanced:true,ordinal:90}),{phase,[field]:3,cursorPersisted:true,cursorAdvanced:true});assert.equal(safeRecoveryProgress({phase,ordinal:3,cursorPersisted:true,cursorAdvanced:true}),null);}
});

test('guarded services and signed dispatch retain typed preparation progress from every engine form',()=>{
 const variants=[()=>service(failure({recovery:{...progress,descriptorId:'private'}})),()=>service(failure({...progress,descriptorId:'private'})),()=>service(failure(),{...progress,descriptorId:'private'})];
 for(const variant of variants){const result=dispatch(variant());assert.deepEqual(result,{ok:false,error:'WRITER_RECOVERY_PENDING',retryable:true,recovery:progress});assert.equal(JSON.stringify(result).includes('private'),false);}
});

test('unproven progress cannot turn a server failure into preparation progress',()=>{
 for(const patch of [{ordinal:0},{cursorAdvanced:false},{phase:'other'}]){const result=dispatch(service(failure({recovery:{...progress,...patch}})));assert.deepEqual(result,{ok:false,error:'STORE_YIELD',retryable:true});}
});

test('a genuine typed rejection remains terminal and cannot carry progress or masquerade as success',()=>{
 const result=dispatch(service(Object.assign(Error('ENTITY_VERSION_CONFLICT'),{code:'ENTITY_VERSION_CONFLICT',retryable:false})));assert.deepEqual(result,{ok:false,error:'ENTITY_VERSION_CONFLICT',retryable:false});
});
