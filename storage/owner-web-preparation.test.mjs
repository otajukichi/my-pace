import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHmac,createHash} from 'node:crypto';
import {ownerBootstrapFixture} from './owner-bootstrap-fixture.mjs';
import {createGasCheckpointHintCodec} from './checkpoint-hint.mjs';
import {createGasImportRuntime} from './gas-import-runtime.mjs';
import {writerDigest} from './reserved-writer.mjs';
const owner='yakitorihanbagu0412@gmail.com',secret='synthetic-owner-web-preparation-secret-32bytes';
function editor({latency=0,bootstrap=true}={}){
 const f=ownerBootstrapFixture({active:owner,effective:owner});let now=0;
 Object.assign(f.globals.Utilities,{Charset:{UTF_8:'utf8'},DigestAlgorithm:{SHA_256:'sha256'},computeHmacSha256Signature:(s,k)=>Array.from(createHmac('sha256',k).update(s).digest()),computeDigest:(_,s)=>Array.from(createHash('sha256').update(s).digest()),base64EncodeWebSafe:b=>Buffer.from(b).toString('base64url'),base64DecodeWebSafe:b=>Array.from(Buffer.from(b,'base64url'))});
 f.globals.Drive.Files.get=id=>structuredClone(f.files.get(id)?.meta);
 f.globals.Drive.Files.update=(m,id,blob)=>{f.events.push(['update',id]);const e=f.files.get(id);e.bytes=Uint8Array.from(blob.bytes);e.meta.size=String(e.bytes.length);return {id};};
 f.properties.set('MYPACE_WRITER_SECRET',secret);
 let config;if(bootstrap){config=f.api({ownerEmail:owner}).bootstrap();const r=createGasImportRuntime(f.globals,{...config,checkBudget:()=>true,checkpointHintCodec:createGasCheckpointHintCodec({Utilities:f.globals.Utilities,secret}),protocolReadCache:{mode:'lock-phase'}});r.locked(()=>{for(let n=0;n<3;n++)r.writer.transact({operationId:'seed_'+n,digest:writerDigest(n),changes:[{key:'kept',value:n,expectedVersion:n}]});});}
 for(const [obj,key] of [...['get','list','create','generateIds','update'].map(k=>[f.globals.Drive.Files,k]),[f.globals.UrlFetchApp,'fetch']]){const original=obj[key];obj[key]=(...args)=>{now+=latency;return original(...args);};}
 class Clock extends Date{static now(){return now;}}
 const logs=[],context=vm.createContext({...f.globals,Date:Clock,console:{log:s=>logs.push(s)}});vm.runInContext(fs.readFileSync(new URL('gas/OwnerImportKit.gs',import.meta.url),'utf8'),context);
 return {...f,config,context,logs};
}
const roles=f=>[...f.files].map(([id,e])=>[id,e.meta.appProperties?.['mypace.role']]).filter(([,role])=>role&&role!=='checkpoint-hint');

test('owner preparation verifies and cold-probes one existing store without restarting work',()=>{
 const f=editor({latency:1000}),before=JSON.parse(f.properties.get('mypace.production.store.v1')),r=f.context.MyPacePrepareWebSync();assert.equal(r.status,'ready');assert.equal(r.replayFrames,1);assert.equal(r.sealed,true);assert.equal(r.webProbe.scope,'cold-storage-recovery');assert.equal(r.webProbe.ok,true);assert(r.webProbe.elapsedMs<20000);assert(r.usage.elapsedMs<120000);assert.deepEqual(JSON.parse(f.properties.get('mypace.production.store.v1')),before);assert(!f.logs.join('\n').includes(secret));const files=roles(f),again=f.context.MyPacePrepareWebSync();assert.equal(again.status,'ready');assert.equal(again.sealed,false);assert.deepEqual(roles(f),files);
});

test('owner preparation reports an insufficient cold web budget instead of promising success',()=>{
 const f=editor({latency:1500}),r=f.context.MyPacePrepareWebSync();assert.equal(r.status,'web-budget-blocked');assert.equal(r.code,'STORE_YIELD');assert.equal(r.webProbe.ok,false);assert.equal(r.replayFrames,1);assert.match(r.nextAction,/do not repeatedly sync/);
});

test('owner preparation rejects wrong active/effective identity before storage work',()=>{
 for(const field of ['active','effective']){const f=editor();f.state[field]='visitor@example.com';const before=f.events.length;assert.throws(()=>f.context.MyPacePrepareWebSync(),/OWNER_UNVERIFIED/);assert.equal(f.events.length,before);}
});

test('owner preparation never bootstraps missing configuration or silently replaces a key',()=>{
 const f=editor({bootstrap:false}),before=roles(f),r=f.context.MyPacePrepareWebSync();assert.equal(r.status,'setup-needed');assert.equal(r.code,'OWNER_BOOTSTRAP_REQUIRED');assert.deepEqual(roles(f),before);
 const g=editor();g.properties.delete('MYPACE_WRITER_SECRET');const existing=roles(g),out=g.context.MyPacePrepareWebSync();assert.equal(out.status,'setup-needed');assert.equal(out.code,'OWNER_RECOVERY_SECRET_REQUIRED');assert.deepEqual(roles(g),existing);assert.equal(g.properties.has('MYPACE_WRITER_SECRET'),false);
});
