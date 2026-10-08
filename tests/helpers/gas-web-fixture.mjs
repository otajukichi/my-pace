// Complete generated-GAS + HTTP-shaped Drive fixture. Synthetic, no network.
import vm from 'node:vm';import fs from 'node:fs';import {createHash,createHmac} from 'node:crypto';
import {ownerBootstrapFixture} from '../../storage/owner-bootstrap-fixture.mjs';
import {createGasImportRuntime} from '../../storage/gas-import-runtime.mjs';
import {createGasCheckpointHintCodec} from '../../storage/checkpoint-hint.mjs';
import {canonical} from '../../src/lib/entity-codec.js';
import {restrictGasContext} from './gas-compat.js';
import {installDriveRestFixture} from './drive-rest-fixture.mjs';
import {activateSyncV2} from '../../storage/sync-v2-activation.mjs';
export function gasWebFixture({readMs=0,writeMs=0,tokenMs=0,seed,aroundRequest,activate=false,allowOwnerBootstrapReads=false,createProof=false,batchConcurrency=16,batchTimeoutScope="request"}={}){
 const owner='yakitorihanbagu0412@gmail.com',secret='synthetic-gas-web-fixture-secret-32bytes';
 const f=ownerBootstrapFixture({active:owner,effective:owner}),config=f.api({ownerEmail:owner}).bootstrap();let time=Date.UTC(2026,9,7,17),last=null;
 f.properties.set('MYPACE_WRITER_SECRET',secret);f.properties.set('MYPACE_STORE_ID',config.storeId);
 const U=f.globals.Utilities;U.Charset={UTF_8:'UTF-8'};U.DigestAlgorithm={SHA_256:'sha256'};
 U.newBlob=(b,m,n)=>{const bytes=Buffer.from(b);return {bytes:Uint8Array.from(bytes),mime:m,name:n,getBytes:()=>Array.from(bytes),getDataAsString:()=>bytes.toString('utf8')};};
 U.computeDigest=(_,s)=>Array.from(createHash('sha256').update(s).digest());U.computeHmacSha256Signature=(s,key)=>Array.from(createHmac('sha256',key).update(s).digest());U.base64EncodeWebSafe=b=>Buffer.from(b).toString('base64url');U.base64DecodeWebSafe=b=>Array.from(Buffer.from(b,'base64url'));
 f.globals.Drive.Files.get=id=>structuredClone(f.files.get(id)?.meta);
 f.globals.Drive.Files.update=(m,id,b)=>{const item=f.files.get(id);item.bytes=Uint8Array.from(b.bytes);item.meta.size=String(item.bytes.length);return {id};};
 if(seed||activate){const rt=createGasImportRuntime(f.globals,{...config,checkBudget:()=>true,protocolReadCache:{mode:'lock-phase'},checkpointHintCodec:createGasCheckpointHintCodec({Utilities:U,secret})});rt.locked(()=>{rt.writer.recoveryBarrier();if(activate)activateSyncV2(rt);if(seed)seed(rt);});}
 const token=f.globals.ScriptApp.getOAuthToken;f.globals.ScriptApp.getOAuthToken=()=>{time+=tokenMs;return token();};
 let batchTiming=null;
 const rest=installDriveRestFixture(f,{allowOwnerBootstrapReads,createProof,aroundBatch:(batch,perform)=>{const previous=batchTiming;batchTiming={start:time,end:time,lanes:Array.from({length:Math.min(batch.subrequests,batchConcurrency)},()=>time),activeLane:0};try{return perform();}finally{time=batchTiming.end;batch.elapsedMs=time-batchTiming.start;batchTiming=previous;}},aroundRequest:(call,perform)=>{
  if(batchTiming){batchTiming.activeLane=batchTiming.lanes.indexOf(Math.min(...batchTiming.lanes));time=batchTiming.lanes[batchTiming.activeLane];}
  const delay=['create','ids','hint-update'].includes(call.kind)?writeMs:readMs;
  const normal=()=>{const available=Math.max(0,call.timeoutSeconds*1000-(batchTiming&&batchTimeoutScope==='dispatch'?time-batchTiming.start:0));if(delay>available){time+=available;throw Error('synthetic timeout');}time+=delay;return perform();};
  try{return aroundRequest?aroundRequest(call,normal,{advance:n=>{time+=n;},perform}):normal();}finally{if(batchTiming){batchTiming.lanes[batchTiming.activeLane]=time;batchTiming.end=Math.max(batchTiming.end,time);}}
 }});
 class Clock extends Date{constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}}
 const context=vm.createContext({...f.globals,Date:Clock,ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})},console});restrictGasContext(context);vm.runInContext(fs.readFileSync(new URL('../../gas/MyPaceComplete.gs',import.meta.url),'utf8'),context);
 function invoke(action,payload){const at=time,start=rest.calls.length,envelope={v:1,ts:time,nonce:'a'.repeat(43),owner,store:config.storeId,action,payload},signature=createHmac('sha256',secret).update(canonical(envelope)).digest('base64url');context.raw=JSON.stringify({...envelope,signature});const result=JSON.parse(vm.runInContext('doPost({postData:{contents:raw}}).text',context));const calls=rest.calls.slice(start);last={elapsedMs:time-at,calls:calls.length,fetchAllBatches:new Set(calls.map(c=>c.batchId).filter(Boolean)).size,kinds:Object.fromEntries([...new Set(calls.map(c=>c.kind))].map(k=>[k,calls.filter(c=>c.kind===k).length]))};return result;}
 return {...f,config,context,invoke,get last(){return last;},get now(){return time;},advance:n=>{time+=n;},restCalls:rest.calls,restBatches:rest.batches};
}
