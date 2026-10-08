/**
 * Small, server-only authenticated envelopes for resumable write preparation.
 * Each purpose has its own HMAC domain and exact payload schema. Certificates
 * bind a fully verified transition; progress only locates authenticated work;
 * work envelopes bind the canonical digest of a separate immutable work page.
 *
 * Authentication does not replace the caller's store/anchor/descriptor/base
 * checks. frameCoreHash omits only the frame's certificate field;
 * workStateHash omits only the work page's authentication envelope. Those
 * digests must be recomputed by the caller before trusting the bound content.
 * Missing/invalid envelopes decode to null for independent full verification.
 * No key generation, persistence, configuration writes, I/O or logging occurs.
 * Portable to Apps Script V8; no Node, TextEncoder, or Web Crypto dependency.
 */
import {encodeUtf8,decodeUtf8} from './codec.mjs';

export const PREPARATION_CERTIFICATE_PROTOCOL='mypace-transition-certificate-v1';
export const PREPARATION_PROGRESS_PROTOCOL='mypace-preparation-progress-v1';
export const PREPARATION_ATTESTED_PROGRESS_PROTOCOL='mypace-preparation-attested-progress-v1';
export const PREPARATION_ATTESTED_PROGRESS_DOMAIN='MyPace/Drive/preparation-attested-progress/HMAC-SHA256/v1\n';
export const PREPARATION_WORK_PROTOCOL='mypace-preparation-work-v1';
export const PREPARATION_PROOF_VERSION=1;
export const PREPARATION_MAX_BYTES=4096;
export const PREPARATION_CERTIFICATE_DOMAIN='MyPace/Drive/transition-certificate/HMAC-SHA256/v1\n';
export const PREPARATION_PROGRESS_DOMAIN='MyPace/Drive/preparation-progress/HMAC-SHA256/v1\n';
export const PREPARATION_WORK_DOMAIN='MyPace/Drive/preparation-work/HMAC-SHA256/v1\n';

const HASH=/^[0-9a-f]{64}$/;
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const COMMON=['protocol','storeId','writerScriptId','schemaVersion','datasetGeneration','preparation','parent','commitSlotId'];
const CERTIFICATE_KEYS=COMMON.concat(['frameCoreHash','finalWorkRef','proofVersion']).sort().join(',');
const PROGRESS_KEYS=COMMON.concat(['workOrdinal','workPage','recoverySeed','admission']).sort().join(',');
const WORK_KEYS=COMMON.concat(['workOrdinal','previousWorkRef','workStateHash']).sort().join(',');
const fail=code=>{const error=new Error(code);error.code=code;throw error;};
const hash=value=>typeof value==='string'&&HASH.test(value);
const id=value=>typeof value==='string'&&ID.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0);

// Reject accessors, non-enumerable fields, symbols, arrays, inherited fields and
// custom prototypes rather than silently omitting them from authenticated JSON.
function shape(value,keys){
 if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype||Object.getOwnPropertySymbols(value).length)return false;
 const names=Object.getOwnPropertyNames(value);
 return names.sort().join(',')===keys&&names.every(name=>{const entry=Object.getOwnPropertyDescriptor(value,name);return entry.enumerable&&Object.prototype.hasOwnProperty.call(entry,'value');});
}
function ref(value){return shape(value,'hash,id')&&id(value.id)&&hash(value.hash);}
function sameRef(left,right){return left.id===right.id&&left.hash===right.hash;}
function common(payload,keys,protocol){
 return shape(payload,keys)&&payload.protocol===protocol&&id(payload.storeId)&&id(payload.writerScriptId)
  &&integer(payload.schemaVersion)&&payload.schemaVersion>=1&&id(payload.datasetGeneration)
  &&ref(payload.preparation)&&shape(payload.parent,'hash,id,revision')&&id(payload.parent.id)
  &&hash(payload.parent.hash)&&integer(payload.parent.revision)&&id(payload.commitSlotId);
}
function certificate(payload){
 return common(payload,CERTIFICATE_KEYS,PREPARATION_CERTIFICATE_PROTOCOL)
  &&payload.proofVersion===PREPARATION_PROOF_VERSION&&hash(payload.frameCoreHash)&&ref(payload.finalWorkRef);
}
function recoverySeed(seed,parent,attested=false){
 return shape(seed,'anchorHash,anchorId,frameRef,frameRevision,hintFileId,indexLinks,indexRef,replayFrames'+(attested?',writerFence':''))
  &&(!attested||[0,2].includes(seed.writerFence))
  &&id(seed.anchorId)&&hash(seed.anchorHash)&&id(seed.hintFileId)&&integer(seed.indexLinks)
  &&(seed.indexLinks===0?seed.indexRef===null:ref(seed.indexRef))
  &&ref(seed.frameRef)&&sameRef(seed.frameRef,parent)&&integer(seed.frameRevision)&&seed.frameRevision===parent.revision
  &&integer(seed.replayFrames)&&seed.replayFrames>=1&&seed.replayFrames<=seed.frameRevision;
}
function progress(payload,attested=false){
 return common(payload,PROGRESS_KEYS,attested?PREPARATION_ATTESTED_PROGRESS_PROTOCOL:PREPARATION_PROGRESS_PROTOCOL)
  &&integer(payload.workOrdinal)&&payload.workOrdinal>=1&&ref(payload.workPage)
  &&(payload.admission===null||shape(payload.admission,'digest,epoch,operationId')&&id(payload.admission.operationId)&&id(payload.admission.epoch)&&hash(payload.admission.digest))
  &&recoverySeed(payload.recoverySeed,payload.parent,attested);
}
function work(payload){
 return common(payload,WORK_KEYS,PREPARATION_WORK_PROTOCOL)
  &&integer(payload.workOrdinal)&&payload.workOrdinal>=1&&hash(payload.workStateHash)
  &&(payload.workOrdinal===1?payload.previousWorkRef===null:ref(payload.previousWorkRef));
}
function canonical(value,depth=0){
 if(depth>8)fail('PREPARATION_FORMAT');
 if(value===null||typeof value==='string'||integer(value))return JSON.stringify(value);
 if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype)
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key],depth+1)).join(',')+'}';
 fail('PREPARATION_FORMAT');
}
function sameMac(left,right){
 if(!hash(left)||!hash(right))return false;
 let difference=0;for(let at=0;at<64;at++)difference|=left.charCodeAt(at)^right.charCodeAt(at);
 return difference===0;
}

/** All encode methods return canonical UTF-8 Uint8Array; all decode methods
 * return a validated payload or null, including when the HMAC provider fails.
 * hmacSha256(text) must synchronously return 64 lowercase hex characters.
 */
export function createPreparationCodec({hmacSha256}={}){
 if(typeof hmacSha256!=='function')fail('PREPARATION_AUTH_REQUIRED');
 function signature(domain,text){
  let mac;try{mac=hmacSha256(domain+text);}catch(_){fail('PREPARATION_AUTH_INVALID');}
  if(!hash(mac))fail('PREPARATION_AUTH_INVALID');return mac;
 }
 function encode(payload,validate,domain){
  if(!validate(payload))fail('PREPARATION_FORMAT');
  const text=canonical(payload);
  // Fixed overhead includes braces, labels, punctuation and the 64-byte MAC.
  if(encodeUtf8(text).length+85>PREPARATION_MAX_BYTES)fail('PREPARATION_BOUND');
  const mac=signature(domain,text);
  // Reuse the validated immutable text: a callback cannot change the payload
  // between signing and serialization by mutating the original input object.
  const bytes=encodeUtf8('{"mac":"'+mac+'","payload":'+text+'}');
  if(bytes.length>PREPARATION_MAX_BYTES)fail('PREPARATION_BOUND');return bytes;
 }
 function decode(bytes,validate,domain){
  try{
   if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>PREPARATION_MAX_BYTES)return null;
   const text=decodeUtf8(bytes),envelope=JSON.parse(text);
   if(!shape(envelope,'mac,payload')||!hash(envelope.mac)||!validate(envelope.payload))return null;
   const payloadText=canonical(envelope.payload);
   if('{"mac":"'+envelope.mac+'","payload":'+payloadText+'}'!==text)return null;
   if(!sameMac(envelope.mac,signature(domain,payloadText)))return null;
   return envelope.payload;
  }catch(_){return null;}
 }
 return Object.freeze({
  encodeCertificate:payload=>encode(payload,certificate,PREPARATION_CERTIFICATE_DOMAIN),
  decodeCertificate:bytes=>decode(bytes,certificate,PREPARATION_CERTIFICATE_DOMAIN),
  encodeProgress:payload=>payload?.protocol===PREPARATION_ATTESTED_PROGRESS_PROTOCOL?encode(payload,p=>progress(p,true),PREPARATION_ATTESTED_PROGRESS_DOMAIN):encode(payload,progress,PREPARATION_PROGRESS_DOMAIN),
  decodeProgress:bytes=>decode(bytes,p=>progress(p,true),PREPARATION_ATTESTED_PROGRESS_DOMAIN)||decode(bytes,progress,PREPARATION_PROGRESS_DOMAIN),
  encodeWork:payload=>encode(payload,work,PREPARATION_WORK_DOMAIN),
  decodeWork:bytes=>decode(bytes,work,PREPARATION_WORK_DOMAIN)
 });
}

/** Uses only the existing, explicitly owner-configured secret in memory. */
export function createGasPreparationCodec({Utilities,secret}={}){
 let keyBytes=0;try{if(typeof secret==='string')keyBytes=encodeUtf8(secret).length;}catch(_){}
 if(keyBytes<32||keyBytes>4096||typeof Utilities?.computeHmacSha256Signature!=='function'||Utilities?.Charset?.UTF_8===undefined)fail('PREPARATION_AUTH_REQUIRED');
 return createPreparationCodec({hmacSha256:text=>{
  const bytes=Utilities.computeHmacSha256Signature(text,secret,Utilities.Charset.UTF_8);
  if(!bytes||bytes.length!==32)fail('PREPARATION_AUTH_INVALID');
  return Array.from(bytes,byte=>{
   if(!Number.isInteger(byte)||byte< -128||byte>255)fail('PREPARATION_AUTH_INVALID');
   return (byte&255).toString(16).padStart(2,'0');
  }).join('');
 }});
}
