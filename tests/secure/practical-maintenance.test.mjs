import test from 'node:test';import assert from 'node:assert/strict';
import {gasWebFixture} from '../helpers/gas-web-fixture.mjs';
const command=(f,n)=>({operationId:'maintenance_edit_'+String(n).padStart(16,'0'),epoch:'default',generation:'1',store:f.config.storeId,key:'diary:2099-01-'+String(n%28+1).padStart(2,'0'),expectedVersion:Math.floor(n/28),deleted:false,value:{text:'retained edit '+n,mood:null},recreate:false});
function invoke(f,action,payload,max=80){let result;for(let i=0;i<max;i++){result=f.invoke(action,payload);if(result.ok)return result.result;assert.equal(result.retryable,true,JSON.stringify(result));f.advance(500);}assert.fail(JSON.stringify(result));}
test('soft maintenance is separate from exact tiny-write ACK, and idempotent when no debt',()=>{
 const f=gasWebFixture({activate:true,createProof:true,readMs:100,writeMs:100});
 for(let n=0;n<16;n++)invoke(f,'commandV2',command(f,n));
 const before=f.files.size,r=invoke(f,'maintain',{});assert.equal(r.ready,true);assert.equal(r.maintenance.due,false);assert(r.maintenance.replayFrames<16);assert(f.files.size>before);
 const revision=r.revision;assert.equal(invoke(f,'maintain',{}).revision,revision);
 const old=invoke(f,'commandV2',command(f,15));assert.equal(old.result.version,1);
});
test('old clients without idle maintenance cannot exceed64-frame debt indefinitely',()=>{
 const f=gasWebFixture({activate:true,createProof:true});for(let n=0;n<70;n++)invoke(f,'commandV2',command(f,n));
 const r=invoke(f,'maintain',{});assert.equal(r.maintenance.hardLimit,64);assert.equal(r.maintenance.due,false);
 const frames=[...f.files.values()].map(file=>{try{return JSON.parse(Buffer.from(file.bytes).toString());}catch{return null;}}).filter(o=>o?.kind==='frame');assert(frames.some(f=>f.payload.checkpoint),'hard limit produced durable checkpoint');
});
test('maintenance exact empty payload is enforced before any Drive access',()=>{
 const f=gasWebFixture({activate:true});for(const payload of [null,[],{operationId:'untrusted'},{store:'other'},{force:true}]){const n=f.restCalls.length,r=f.invoke('maintain',payload);assert.equal(r.ok,false);assert.equal(r.error,'PAYLOAD_INVALID');assert.equal(f.restCalls.length,n);}
});
test('lost maintenance ACK and competing edit preserve exact receipts and records',()=>{
 const f=gasWebFixture({activate:true,createProof:true,readMs:750,writeMs:750});for(let n=0;n<16;n++)invoke(f,'commandV2',command(f,n));
 invoke(f,'maintain',{}); // Deliberately discard response as if connection lost.
 const c=command(f,16),receipt=invoke(f,'commandV2',c);const r=invoke(f,'maintain',{});assert.equal(r.ready,true);assert.deepEqual(invoke(f,'commandV2',c),receipt);assert.equal(receipt.result.version,1);
});
