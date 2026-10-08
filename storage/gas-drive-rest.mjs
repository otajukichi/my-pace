/**
 * Server-internal, one-invocation Drive REST transport for GAS V8.
 * No retries, new-ID fallback, caller URL, token persistence, or authority checks
 * are supplied here. GasStoreIO still owns locks, fixed parents/advisory IDs,
 * permissions, schema/hash validation, and same-ID immutable readback.
 *
 * timeoutSeconds is documented for UrlFetchApp (checked 2026-10-07):
 * https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app
 * Multipart and pre-generated-ID retry contract:
 * https://developers.google.com/workspace/drive/api/guides/manage-uploads
 * https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create
 * A timed-out write remains ambiguous. A HTTP success ID is NOT byte proof.
 */
import {IncrementalSha256,encodeUtf8,decodeUtf8} from './codec.mjs';
const REST='https://www.googleapis.com/drive/v3/files';
const UPLOAD='https://www.googleapis.com/upload/drive/v3/files';
const MAX_MEDIA=2*1024*1024,MAX_JSON=16*1024;
const MIME='application/octet-stream';
const fileId=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const record=x=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
function restFail(code,status,retryable=false){const e=Error(code);e.code=code;if(Number.isInteger(status)&&status>=100&&status<=599)e.status=status;if(retryable)e.retryable=true;throw e;}
function boundedBytes(raw,limit,code){
 if(!raw||!Number.isSafeInteger(raw.length)||raw.length<0||raw.length>limit)restFail(code);
 const bytes=new Uint8Array(raw.length);
 for(let i=0;i<raw.length;i++){const n=raw[i];if(!Number.isInteger(n)||n< -128||n>255)restFail(code);bytes[i]=n&255;}
 return bytes;
}
function containsBytes(haystack,needle){
 outer:for(let i=0;i<=haystack.length-needle.length;i++){for(let j=0;j<needle.length;j++)if(haystack[i+j]!==needle[j])continue outer;return true;}return false;
}
export function createGasDriveRest({UrlFetchApp,ScriptApp}={},options={}){
 const {deadlineMs,now=Date.now,checkBudget=()=>true,maxTimeoutSeconds=8,responseReserveMs=1500,advisoryMinMs=7000,onRequest}=options;
 if(typeof UrlFetchApp?.fetch!=='function'||typeof ScriptApp?.getOAuthToken!=='function'||typeof now!=='function'||typeof checkBudget!=='function'||!Number.isSafeInteger(deadlineMs)||deadlineMs<1||!Number.isSafeInteger(maxTimeoutSeconds)||maxTimeoutSeconds<1||maxTimeoutSeconds>360||!Number.isSafeInteger(responseReserveMs)||responseReserveMs<0||responseReserveMs>30000||(!Number.isSafeInteger(advisoryMinMs)||advisoryMinMs<4000||advisoryMinMs>30000)||(onRequest!==undefined&&typeof onRequest!=='function'))restFail('STORE_REST_CONFIG');
 let accessToken=null,timeoutCap=maxTimeoutSeconds;
 function clock(){let n;try{n=now();}catch(_){restFail('STORE_REST_CLOCK_INVALID');}if(!Number.isSafeInteger(n)||n<0)restFail('STORE_REST_CLOCK_INVALID');return n;}
 function budget(){let allowed;try{allowed=checkBudget('drive-rest');}catch(_){restFail('STORE_YIELD',undefined,true);}if(allowed!==true)restFail('STORE_YIELD',undefined,true);}
 function timeout(){budget();const seconds=Math.min(timeoutCap,Math.floor((deadlineMs-clock()-responseReserveMs)/1000));if(seconds<1)restFail('STORE_YIELD',undefined,true);return seconds;}
 function token(){
  if(accessToken!==null)return accessToken;
  let value;try{value=ScriptApp.getOAuthToken();}catch(_){restFail('STORE_AUTH_UNRESOLVED',undefined,true);}
  if(typeof value!=='string'||value.length<1||value.length>16384||/[^\x21-\x7e]/.test(value))restFail('STORE_AUTH_UNRESOLVED',undefined,true);
  accessToken=value;return value;
 }
 function telemetry(operation,method,start,status,outcome){
  if(!onRequest)return;
  try{const end=now(),elapsedMs=Number.isSafeInteger(end)&&end>=start?end-start:0;onRequest({operation,method,elapsedMs,...(Number.isInteger(status)?{status}:{}),outcome});}catch(_){}
 }
 function request(operation,method,url,{headers={},payload,contentType,maxBytes=MAX_JSON}={}){
  // Admission before token retrieval and again after it. Body construction is
  // completed by the caller before this second, final timeout calculation.
  timeout();const start=clock();let status,outcome='transport-error';
  try{
   const credential=token(),seconds=timeout();
   const params={method,headers:{...headers,Authorization:'Bearer '+credential},muteHttpExceptions:true,followRedirects:false,validateHttpsCertificates:true,timeoutSeconds:seconds};
   if(payload!==undefined)params.payload=payload;
   if(contentType!==undefined)params.contentType=contentType;
   let response;try{response=UrlFetchApp.fetch(url,params);}catch(_){restFail('STORE_REQUEST_UNRESOLVED',undefined,true);}
   if(!response||typeof response.getResponseCode!=='function'||typeof response.getContent!=='function')restFail('STORE_REST_RESPONSE_INVALID',undefined,true);
   try{status=response.getResponseCode();}catch(_){restFail('STORE_REST_RESPONSE_INVALID',undefined,true);}
   if(!Number.isInteger(status)||status<100||status>599)restFail('STORE_REST_RESPONSE_INVALID',undefined,true);
   if(status>=300&&status<400){outcome='http-error';restFail('STORE_REDIRECT_UNRESOLVED',status,true);}
   let raw;try{raw=response.getContent();}catch(_){restFail('STORE_REST_RESPONSE_INVALID',status,true);}
   let bytes;try{bytes=boundedBytes(raw,maxBytes,'STORE_REST_RESPONSE_TOO_LARGE');}catch(e){outcome='response-invalid';throw e;}
   outcome=status>=200&&status<300?'ok':'http-error';
   return {response,status,bytes};
  }catch(e){if(e?.code==='STORE_YIELD')outcome='yield';else if(e?.code?.startsWith('STORE_REST_'))outcome='response-invalid';throw e;}
  finally{telemetry(operation,method,start,status,outcome);}
 }
 function json(result,code,success){
  if(!success.includes(result.status))restFail(code,result.status,true);
  let value;try{value=JSON.parse(decodeUtf8(result.bytes));}catch(_){restFail('STORE_REST_JSON_INVALID',result.status,true);}
  if(!record(value))restFail('STORE_REST_JSON_INVALID',result.status,true);return value;
 }
 function mediaBytes(bytes){if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>MAX_MEDIA)restFail('STORE_REST_MEDIA_INVALID');return Uint8Array.from(bytes);}
 function signed(bytes){return Array.from(bytes,n=>n>127?n-256:n);}
 function safeHeaders(headers,media){
  if(!record(headers))restFail('STORE_REST_HEADERS_INVALID');const out={},seen=new Set();
  for(const key of Object.keys(headers)){
   const name=key.toLowerCase(),value=headers[key];if(seen.has(name)||typeof value!=='string'||/[\r\n]/.test(value))restFail('STORE_REST_HEADERS_INVALID');seen.add(name);
   if(name==='accept-encoding'&&value==='identity')out['Accept-Encoding']='identity';
   else if(name==='range'&&media){const m=/^bytes=(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(value);if(!m)restFail('STORE_REST_RANGE_INVALID');const lo=Number(m[1]),hi=Number(m[2]);if(!Number.isSafeInteger(lo)||!Number.isSafeInteger(hi)||hi<lo||hi-lo+1>MAX_MEDIA)restFail('STORE_REST_RANGE_INVALID');out.Range=value;}
   else restFail('STORE_REST_HEADERS_INVALID');
  }
  if(media&&!out.Range)restFail('STORE_REST_RANGE_REQUIRED');return out;
 }
 function readSpec(id,suffix,headers={}){
  if(!fileId(id)||typeof suffix!=='string')restFail('STORE_REST_READ_INVALID');
  let query,media=false;
  if(suffix==='?alt=media'){query=suffix;media=true;}
  else if(suffix.startsWith('?fields=')){
   let fields;try{fields=decodeURIComponent(suffix.slice(8));}catch(_){restFail('STORE_REST_QUERY_INVALID');}
   if(!fields||fields.length>1024||!/^[A-Za-z0-9_(),/.*]+$/.test(fields))restFail('STORE_REST_QUERY_INVALID');query='?fields='+encodeURIComponent(fields);
  }else restFail('STORE_REST_QUERY_INVALID');
  const url=REST+'/'+encodeURIComponent(id)+query;if(url.length>2082)restFail('STORE_REST_QUERY_INVALID');
  return {operation:media?'read-media':'read-metadata',method:'get',url,headers:safeHeaders(headers,media),maxBytes:media?MAX_MEDIA:MAX_JSON};
 }
 function read(id,suffix,headers={}){const r=readSpec(id,suffix,headers);return request(r.operation,'get',r.url,r).response;}
 function requestMany(specs){
  if(!specs.length)return [];
  if(UrlFetchApp.fetchAll===undefined)return specs.map(r=>request(r.operation,r.method,r.url,r));
  if(typeof UrlFetchApp.fetchAll!=='function')restFail('STORE_REST_BATCH_UNAVAILABLE');
  timeout();const start=clock();let responses;
  try{
   const credential=token(),seconds=timeout();
   const requests=specs.map(r=>({url:r.url,method:r.method,headers:{...(r.headers||{}),Authorization:'Bearer '+credential},muteHttpExceptions:true,followRedirects:false,validateHttpsCertificates:true,timeoutSeconds:seconds,...(r.payload===undefined?{}:{payload:r.payload}),...(r.contentType===undefined?{}:{contentType:r.contentType})}));
   try{responses=UrlFetchApp.fetchAll(requests);}catch(e){if((e?.code||e?.message)==='OWNER_BUDGET_YIELD')restFail('STORE_YIELD',undefined,true);restFail('STORE_REQUEST_UNRESOLVED',undefined,true);}
   if(!Array.isArray(responses)||responses.length!==specs.length)restFail('STORE_REST_RESPONSE_INVALID',undefined,true);
  }catch(error){for(const r of specs)telemetry(r.operation,r.method,start,undefined,error?.code==='STORE_YIELD'?'yield':error?.code==='STORE_REST_RESPONSE_INVALID'?'response-invalid':'transport-error');throw error;}
  let firstError=null;const results=[];
  for(let i=0;i<specs.length;i++){
   let status,outcome='transport-error';
   try{
    const response=responses[i];if(!response||typeof response.getResponseCode!=='function'||typeof response.getContent!=='function')restFail('STORE_REST_RESPONSE_INVALID',undefined,true);
    try{status=response.getResponseCode();}catch(_){restFail('STORE_REST_RESPONSE_INVALID',undefined,true);}
    if(!Number.isInteger(status)||status<100||status>599)restFail('STORE_REST_RESPONSE_INVALID',undefined,true);
    if(status>=300&&status<400){outcome='http-error';restFail('STORE_REDIRECT_UNRESOLVED',status,true);}
    let bytes;try{bytes=response.getContent();}catch(_){restFail('STORE_REST_RESPONSE_INVALID',status,true);}
    bytes=boundedBytes(bytes,specs[i].maxBytes??MAX_JSON,'STORE_REST_RESPONSE_TOO_LARGE');outcome=status>=200&&status<300?'ok':'http-error';results.push({response,status,bytes});
   }catch(error){if(error?.code?.startsWith('STORE_REST_'))outcome='response-invalid';if(!firstError)firstError=error;}
   finally{telemetry(specs[i].operation,specs[i].method,start,status,outcome);}
  }
  if(firstError)throw firstError;
  return results;
 }
 function readMany(reads){
  if(!Array.isArray(reads)||reads.length>16)restFail('STORE_REST_BATCH_INVALID');
  // Validate the entire batch before token retrieval or the first network call.
  const specs=reads.map(r=>{if(!record(r)||Object.keys(r).some(k=>!['id','suffix','headers'].includes(k)))restFail('STORE_REST_BATCH_INVALID');return readSpec(r.id,r.suffix,r.headers===undefined?{}:r.headers);});
  return requestMany(specs).map(r=>r.response);
 }

 function generateIds(count){
  if(!Number.isSafeInteger(count)||count<1||count>1000)restFail('STORE_ID_COUNT');
  const result=json(request('generate-ids','get',REST+'/generateIds?count='+count+'&space=drive&type=files&fields=ids'),'STORE_IDS_UNRESOLVED',[200]);
  if(!Array.isArray(result.ids)||result.ids.length!==count||result.ids.some(id=>!fileId(id))||new Set(result.ids).size!==count)restFail('STORE_IDS_INVALID');return result;
 }
 function createSpec(metadata,input){
  if(!record(metadata)||Object.keys(metadata).sort().join(',')!=='appProperties,id,mimeType,name,parents'||!fileId(metadata.id)||metadata.mimeType!==MIME||typeof metadata.name!=='string'||metadata.name.length<1||!Array.isArray(metadata.parents)||metadata.parents.length!==1||!fileId(metadata.parents[0])||!record(metadata.appProperties)||Object.values(metadata.appProperties).some(x=>typeof x!=='string'))restFail('STORE_REST_METADATA_INVALID');
  let text;try{text=JSON.stringify(metadata);}catch(_){restFail('STORE_REST_METADATA_INVALID');}
  const meta=encodeUtf8(text);if(meta.length>MAX_JSON)restFail('STORE_REST_METADATA_TOO_LARGE');
  const bytes=mediaBytes(input);let boundary;
  for(let attempt=0;attempt<32;attempt++){
   // A predictable short candidate list lets ordinary content block every
   // fresh invocation. Bind a full SHA-256 candidate to this exact body; the
   // independent collision scan is retained. 3 + 64 = 67 MIME boundary chars.
   const digest=new IncrementalSha256().update(encodeUtf8('MyPace/Drive/multipart-boundary/v1\n'+attempt+'\n')).update(meta).update(bytes).digestHex();
   const candidate='mp_'+digest,needle=encodeUtf8(candidate);
   if(!containsBytes(meta,needle)&&!containsBytes(bytes,needle)){boundary=candidate;break;}
  }
  if(!boundary)restFail('STORE_REST_BOUNDARY_INVALID');
  const first=encodeUtf8('--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+text+'\r\n--'+boundary+'\r\nContent-Type: '+MIME+'\r\n\r\n');
  const last=encodeUtf8('\r\n--'+boundary+'--\r\n'),payload=new Uint8Array(first.length+bytes.length+last.length);
  payload.set(first);payload.set(bytes,first.length);payload.set(last,first.length+bytes.length);
  return {operation:'create',method:'post',url:UPLOAD+'?uploadType=multipart&fields=id,parents,appProperties,size,trashed,mimeType,ownedByMe,shared,version,sha256Checksum&ignoreDefaultVisibility=true',payload:signed(payload),contentType:'multipart/related; boundary='+boundary,maxBytes:MAX_JSON,id:metadata.id};
 }
 function createResult(result,id){const value=json(result,'STORE_CREATE_UNRESOLVED',[200,201]);if(value.id!==id)restFail('STORE_CREATE_ID_MISMATCH');return value;}
 function create(metadata,input){const spec=createSpec(metadata,input);return createResult(request(spec.operation,spec.method,spec.url,spec),spec.id);}
 function createMany(files){
  if(!Array.isArray(files)||files.length>4)restFail('STORE_REST_BATCH_INVALID');let total=0;const ids=new Set();
  for(const file of files){
   if(!record(file)||Object.keys(file).sort().join(',')!=='bytes,metadata'||!record(file.metadata)||file.metadata.appProperties?.['mypace.role']!=='index-node'||!(file.bytes instanceof Uint8Array)||file.bytes.length<1||file.bytes.length>MAX_MEDIA||ids.has(file.metadata.id))restFail('STORE_REST_BATCH_INVALID');
   ids.add(file.metadata.id);total+=file.bytes.length;if(total>1048576)restFail('STORE_REST_BATCH_BOUND');
  }
  const specs=files.map(file=>createSpec(file.metadata,file.bytes)),results=requestMany(specs);
  return results.map((result,i)=>createResult(result,specs[i].id));
 }

 function update(id,input){
  // Only GasStoreIO may select the separately pinned mutable advisory file.
  // This is not a public arbitrary-ID mutation surface.
  if(!fileId(id))restFail('STORE_REST_UPDATE_INVALID');const bytes=mediaBytes(input);
  const result=json(request('update','patch',UPLOAD+'/'+encodeURIComponent(id)+'?uploadType=media&fields=id',{payload:signed(bytes),contentType:MIME}),'STORE_HINT_WRITE_UNRESOLVED',[200]);
  if(result.id!==id)restFail('STORE_CREATE_ID_MISMATCH');return result;
 }
 function canStartAdvisory(){try{budget();const remaining=deadlineMs-clock();return remaining>=advisoryMinMs&&Math.floor((remaining-responseReserveMs)/1000)>=1;}catch(_){return false;}}
 function advisory(fn){
  if(typeof fn!=='function')restFail('STORE_REST_ADVISORY_INVALID');if(!canStartAdvisory())restFail('STORE_YIELD',undefined,true);
  const previous=timeoutCap;timeoutCap=Math.min(previous,2);try{return fn();}finally{timeoutCap=previous;}
 }
 return Object.freeze({read,readMany,generateIds,create,createMany,update,advisory,canStartAdvisory});
}
