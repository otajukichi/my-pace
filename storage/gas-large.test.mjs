import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {initialCheckpoint,prepareRange,checkpointBytes,buildStagedPayloads} from './bounded-import.mjs';
test('GAS-compatible layer streams over 100 MiB with bounded restored hash/parser and linked manifest pages',()=>{
 const prefix=Buffer.from('# sensor:multi_record\ntime,latitude,longitude,altitude,speed\n');
 const line='2026-01-01T00:00:00.123456Z,1.123456789,2.123456789,3,-1\n',perBlock=2000,blocks=1000,block=Buffer.from(line.repeat(perBlock));
 const bytes=prefix.length+block.length*blocks;assert.ok(bytes>100*1024*1024);
 const src=createHash('sha256'),expected=createHash('sha256'),actual=createHash('sha256');src.update(prefix);
 const canonical=JSON.stringify({time:'2026-01-01T00:00:00.123456Z',lat:1.123456789,lon:2.123456789,altitude:3,speed:null})+'\n';
 const expectedBlock=canonical.repeat(perBlock);
 let cp=initialCheckpoint({id:'synthetic',version:'1',size:String(bytes),md5Checksum:'0'.repeat(32)}),maxCheckpoint=0,maxOutput=0,n=0;
 const apply=b=>{const prepared=prepareRange(cp,b);for(const o of prepared.outputs){actual.update(o.bytes);maxOutput=Math.max(maxOutput,o.bytes.length);}const p=buildStagedPayloads(prepared,{outputIds:prepared.outputs.map((_,i)=>'out_'+n+'_'+i),manifestId:'manifest_'+n,checkpointId:'checkpoint_'+n});cp=JSON.parse(JSON.stringify(p.checkpoint));maxCheckpoint=Math.max(maxCheckpoint,checkpointBytes(cp).length);n++;};
 apply(prefix);
 for(let i=0;i<blocks;i++){src.update(block);expected.update(expectedBlock);const split=(i*97)%block.length;if(split)apply(block.subarray(0,split));apply(block.subarray(split));}
 assert.equal(cp.points,blocks*perBlock);assert.equal(cp.sourceSha256,src.digest('hex'));assert.equal(cp.normalizedSha256,expected.digest('hex'));assert.equal(cp.normalizedSha256,actual.digest('hex'));assert.ok(maxCheckpoint<5000);assert.ok(maxOutput<=262144);
 console.log(JSON.stringify({gasSyntheticBytes:bytes,points:cp.points,restarts:n,maxCheckpoint,maxOutput,verifiedSourceHash:true,verifiedNormalizedHash:true}));
});
