import test from 'node:test';import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';
import {gasWebFixture} from '../helpers/gas-web-fixture.mjs';
import {createCheckpointHintCodec,ATTESTED_FRAME_HINT_PROTOCOL,FRAME_SCAN_HINT_PROTOCOL} from '../../storage/checkpoint-hint.mjs';
const codec=createCheckpointHintCodec({hmacSha256:text=>createHmac('sha256','synthetic-gas-web-fixture-secret-32bytes').update(text).digest('hex')});
const cmd=(f,n)=>({operationId:'attestation_edit_'+String(n).padStart(16,'0'),epoch:'default',generation:'1',store:f.config.storeId,key:'diary:2099-01-'+String(n+1).padStart(2,'0'),expectedVersion:0,deleted:false,value:{text:'preserve '+n,mood:null},recreate:false});
function setup(){const f=gasWebFixture({activate:true,createProof:true});for(let n=0;n<16;n++)assert(f.invoke('commandV2',cmd(f,n)).ok);assert(f.invoke('maintain',{}).ok);assert(f.invoke('commandV2',cmd(f,16)).ok);return f;}
const hint=f=>codec.decode(f.files.get(f.config.checkpointHintId).bytes);
const putHint=(f,p)=>{const file=f.files.get(f.config.checkpointHintId);file.bytes=codec.encode(p);file.meta.size=String(file.bytes.length);};
const checkpoint=f=>JSON.parse(Buffer.from(f.files.get(hint(f).indexRef.id).bytes).toString()).payload;
test('new attestation purpose is emitted only after verified recovery and binds fence',()=>{const f=setup(),p=hint(f);assert.equal(p.protocol,ATTESTED_FRAME_HINT_PROTOCOL);assert.equal(p.writerFence,2);assert.equal(f.invoke('commandV2',cmd(f,17)).ok,true);});
test('managed hint intentionally skips historical checkpoint body while maintenance still detects damage',()=>{
 const f=setup(),p=checkpoint(f),file=f.files.get(p.manifestRef.id);file.bytes[0]^=1;
 const r=f.invoke('commandV2',cmd(f,17));assert.equal(r.ok,true,JSON.stringify(r));const checked=f.invoke('maintain',{});assert.equal(checked.ok,false);assert.match(checked.error,/WRITER_/);assert.equal(checked.result,undefined);
});
test('old generic frame hint never gains stronger historical-proof shortcut',()=>{
 const f=setup(),p=hint(f);delete p.writerFence;p.protocol=FRAME_SCAN_HINT_PROTOCOL;putHint(f,p);const file=f.files.get(checkpoint(f).manifestRef.id);file.bytes[0]^=1;
 const r=f.invoke('commandV2',cmd(f,17));assert.equal(r.ok,false);assert.equal(r.result,undefined);
});
test('missing exact signed current frame fails closed, never falls back to stale records',()=>{const f=setup();f.files.delete(hint(f).frameRef.id);const r=f.invoke('commandV2',cmd(f,17));assert.equal(r.ok,false);assert.equal(r.result,undefined);});
test('validly signed attestation cannot regress fence or mismatch revision counters',()=>{
 for(const change of [p=>p.writerFence=0,p=>p.replayFrames++,p=>p.frameRevision++,p=>p.indexLinks++]){const f=setup(),p=hint(f);change(p);putHint(f,p);const r=f.invoke('commandV2',cmd(f,17));assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.result,undefined);}
});
