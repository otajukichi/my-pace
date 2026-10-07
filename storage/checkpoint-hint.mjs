// Server-only authenticated acceleration. These bytes are never authoritative
// state, an authentication credential, or a caller-selected recovery root.
import {encodeUtf8,decodeUtf8} from './codec.mjs';
export const CHECKPOINT_HINT_PROTOCOL='mypace-checkpoint-hint-v1';
// Same authenticated fixed-ID envelope, explicitly different semantics: this
// certifies only a traversed INDEX prefix, never recovered business state.
export const INDEX_SCAN_HINT_PROTOCOL='mypace-index-scan-hint-v1';
// Owner recovery attests a fully verified immutable frame prefix. Roots and
// receipts remain in the referenced immutable frame, never in mutable advice.
export const FRAME_SCAN_HINT_PROTOCOL='mypace-frame-scan-hint-v1';
export const CHECKPOINT_HINT_MAX_BYTES=4096;
export const CHECKPOINT_HINT_DOMAIN='MyPace/Drive/checkpoint-hint/HMAC-SHA256/v1\n';
const hash=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const fail=code=>{throw Error(code);};
function canonical(x,depth=0){
 if(depth>8)fail('CHECKPOINT_HINT_FORMAT');
 if(x===null||typeof x==='string'||typeof x==='boolean'||(typeof x==='number'&&Number.isSafeInteger(x)))return JSON.stringify(x);
 if(x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype)return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k],depth+1)).join(',')+'}';
 fail('CHECKPOINT_HINT_FORMAT');
}
function sameMac(a,b){if(!hash(a)||!hash(b))return false;let difference=0;for(let i=0;i<64;i++)difference|=a.charCodeAt(i)^b.charCodeAt(i);return difference===0;}
export function createCheckpointHintCodec({hmacSha256}={}){
 if(typeof hmacSha256!=='function')fail('CHECKPOINT_HINT_AUTH_REQUIRED');
 function signature(payload){const text=canonical(payload);if(encodeUtf8(text).length>CHECKPOINT_HINT_MAX_BYTES-128)fail('CHECKPOINT_HINT_BOUND');const mac=hmacSha256(CHECKPOINT_HINT_DOMAIN+text);if(!hash(mac))fail('CHECKPOINT_HINT_AUTH_INVALID');return mac;}
 return Object.freeze({
  encode(payload){const bytes=encodeUtf8(canonical({payload,mac:signature(payload)}));if(bytes.length>CHECKPOINT_HINT_MAX_BYTES)fail('CHECKPOINT_HINT_BOUND');return bytes;},
  decode(bytes){
   try{
    if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>CHECKPOINT_HINT_MAX_BYTES)return null;
    const text=decodeUtf8(bytes),file=JSON.parse(text);
    if(!file||Object.keys(file).sort().join(',')!=='mac,payload'||!hash(file.mac)||canonical(file)!==text||!sameMac(file.mac,signature(file.payload)))return null;
    return file.payload;
   }catch(_){return null;}
  }
 });
}
// The owner configures MYPACE_WRITER_SECRET manually. No generated, public,
// empty, hash-only, cached, or property-stored fallback key is permitted.
export function createGasCheckpointHintCodec({Utilities,secret}={}){
 if(typeof secret!=='string'||encodeUtf8(secret).length<32||encodeUtf8(secret).length>4096||typeof Utilities?.computeHmacSha256Signature!=='function'||Utilities?.Charset?.UTF_8===undefined)fail('CHECKPOINT_HINT_AUTH_REQUIRED');
 return createCheckpointHintCodec({hmacSha256:text=>{
  const bytes=Utilities.computeHmacSha256Signature(text,secret,Utilities.Charset.UTF_8);
  if(!bytes||bytes.length!==32)fail('CHECKPOINT_HINT_AUTH_INVALID');
  return Array.from(bytes,n=>{if(!Number.isInteger(n)||n< -128||n>255)fail('CHECKPOINT_HINT_AUTH_INVALID');return (n&255).toString(16).padStart(2,'0');}).join('');
 }});
}
