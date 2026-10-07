/** Local storage integration milestone. NOT DEPLOYED. No public endpoint or trigger installer. */
var MyPaceFolderImport = (function () {
"use strict";
const m0 = (function(){
// Local tested core. GAS adapter/Drive durable writer integration is deliberately not wired.
const PARSER_VERSION = 'sensor-multi-v1';
class CsvBytes {
  constructor({decode, state, maxRowBytes = 262144, maxFieldBytes = 65536} = {}) {
    if (!decode) throw Error('DECODE_REQUIRED');
    this.decode=decode; this.maxRowBytes=maxRowBytes; this.maxFieldBytes=maxFieldBytes;
    this.s=state ? JSON.parse(JSON.stringify(state)) : {mode:'start',field:[],row:[],bytes:0,offset:0,cr:false,first:true,prefix:[]};
  }
  snapshot(){ return JSON.parse(JSON.stringify(this.s)); }
  feed(bytes, emit, final=false) {
    const s=this.s;
    const field=()=>{let v=this.decode(Uint8Array.from(s.field)); if(s.first){v=v.replace(/^\uFEFF/,'');s.first=false;} s.row.push(v);if(s.row.length>128)throw Error('TOO_MANY_FIELDS');s.field=[];};
    const row=()=>{field(); const r=s.row;s.row=[];s.bytes=0;s.mode='start';emit(r,s.offset);};
    const append=b=>{s.field.push(b);if(s.field.length>this.maxFieldBytes)throw Error('FIELD_TOO_LARGE');};
    if(s.prefix!==null){
      const combined=[...s.prefix,...bytes];
      const bom=[239,187,191];
      const couldBeBom=combined.slice(0,3).every((b,i)=>b===bom[i]);
      if(combined.length<3&&couldBeBom&&!final){s.prefix=combined;return;}
      const skip=combined.length>=3&&couldBeBom?3:0;
      s.offset+=skip;bytes=combined.slice(skip);s.prefix=null;
    }
    for(const b of bytes){
      s.offset++;
      if(s.cr){s.cr=false;if(b===10)continue;}
      if(++s.bytes>this.maxRowBytes)throw Error('ROW_TOO_LARGE');
      if(s.mode==='quoted'){if(b===34)s.mode='closed';else append(b);continue;}
      if(s.mode==='closed'){
        if(b===34){append(b);s.mode='quoted';continue;}
        if(b!==44&&b!==10&&b!==13)throw Error('AFTER_QUOTE');
      }else if(b===34){if(s.mode!=='start'||s.field.length)throw Error('BARE_QUOTE');s.mode='quoted';continue;}
      if(b===44){field();s.mode='start';}
      else if(b===10||b===13){row();s.cr=b===13;}
      else {append(b);s.mode='plain';}
    }
    if(final){if(s.mode==='quoted')throw Error('UNCLOSED_QUOTE');if(s.bytes||s.row.length||s.field.length)row();}
  }
}
function sensorRow(row, header) {
  if(row.length===1&&row[0].startsWith('#'))return {kind:'comment'};
  if(!header){
    if(!['time','latitude','longitude'].every(k=>row.includes(k))||new Set(row).size!==row.length)throw Error('UNSUPPORTED_HEADER');
    return {kind:'header',header:row};
  }
  if(row.length!==header.length)throw Error('COLUMN_COUNT');
  const at=k=>row[header.indexOf(k)];
  const number=(v,min,max)=>{if(v===undefined||v.trim()===''||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(v))throw Error('INVALID_NUMBER');const n=Number(v);if(!Number.isFinite(n)||n<min||n>max)throw Error('INVALID_NUMBER');return n;};
  const time=at('time');
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(time)||!Number.isFinite(Date.parse(time)))throw Error('INVALID_TIME');
  if(new Date(Date.parse(time)).toISOString().slice(0,19)!==time.slice(0,19))throw Error('INVALID_TIME');
  const point={time,lat:number(at('latitude'),-90,90),lon:number(at('longitude'),-180,180)};
  if(header.includes('altitude'))point.altitude=number(at('altitude'),-20000,100000);
  if(header.includes('speed')){const n=number(at('speed'),-1,10000);if(n<0&&n!==-1)throw Error('INVALID_SPEED_SENTINEL');point.speed=n===-1?null:n;}
  return {kind:'point',point};
}
function candidate(file, folderId) {
  return !file.trashed && typeof file.mimeType==='string' && !file.mimeType.startsWith('application/vnd.google-apps.') &&
    file.parents?.includes(folderId) && /\.csv$/i.test(file.name) && file.mimeType!=='application/vnd.google-apps.folder';
}
function sourceKey(file, mappingHash) {
  // version is observation metadata; unchanged content on a rename must not duplicate a run.
  if(!file.id||!file.md5Checksum||!file.size||!mappingHash)throw Error('SOURCE_IDENTITY_REQUIRED');
  return JSON.stringify([file.id,file.md5Checksum,String(file.size),PARSER_VERSION,mappingHash]);
}
function sourceUnchanged(before,after,folderId) {
  return candidate(after,folderId)&&['id','version','md5Checksum','size'].every(k=>String(before[k])===String(after[k]));
}
// Model of a durable batch boundary. Adapter must implement putOnce/read receipt under the
// existing writer protocol, NOT mutable overwrite. Outputs precede checkpoint advancement.
async function commitBatch(io, {job, index, digest, output, checkpoint}) {
  const key=JSON.stringify([job,index]);
  const old=await io.receipt(key);
  if(old){if(old.digest!==digest)throw Error('BATCH_MISMATCH');return old;}
  const asset=await io.putOnce(key,digest,output);
  await io.verify(asset,digest);
  return io.commitOnce(key,{digest,asset,checkpoint});
}

return {PARSER_VERSION,CsvBytes,sensorRow,candidate,sourceKey,sourceUnchanged,commitBatch};
})();
const m1 = (function(){
/**
 * Portable Apps Script V8 primitives; no Node, TextDecoder, TextEncoder, Blob,
 * Utilities, Web Crypto, I/O, or dependencies. Remove ES-module `export` when
 * bundling for GAS. UTF functions operate on one bounded field/output batch;
 * SHA-256 never accumulates the complete input.
 *
 * UTF-8 validity: RFC 3629, sections 3-4 (surrogates and non-shortest encodings
 * are rejected): https://www.rfc-editor.org/rfc/rfc3629.html#section-4
 * SHA-256: NIST FIPS 180-4, sections 5 and 6.2:
 * https://doi.org/10.6028/NIST.FIPS.180-4
 *
 * Byte inputs are Uint8Array, Int8Array, or ordinary integer arrays. Signed
 * GAS Byte[] values -128..-1 are normalized to 128..255. Other values fail.
 */

const SHA256_VERSION = 'sha256-v1';
const SHA256_IV = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function checkBytes(bytes) {
  if (bytes instanceof Uint8Array || bytes instanceof Int8Array) return;
  if (!Array.isArray(bytes)) throw Error('INVALID_BYTES');
  for (let i = 0; i < bytes.length; i++) {
    if (!Number.isInteger(bytes[i]) || bytes[i] < -128 || bytes[i] > 255) {
      throw Error('INVALID_BYTES');
    }
  }
}

/** Decode exactly one complete UTF-8 value; preserve U+FEFF, including a BOM. */
function decodeUtf8(bytes) {
  checkBytes(bytes);
  const parts = [];
  let part = '';
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++] & 255;
    let scalar, extra, minimum;
    if (first < 0x80) { scalar = first; extra = 0; minimum = 0; }
    else if (first >= 0xc2 && first <= 0xdf) { scalar = first & 0x1f; extra = 1; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { scalar = first & 0x0f; extra = 2; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { scalar = first & 0x07; extra = 3; minimum = 0x10000; }
    else throw Error('INVALID_UTF8');
    if (i + extra > bytes.length) throw Error('INVALID_UTF8');
    for (let j = 0; j < extra; j++) {
      const next = bytes[i++] & 255;
      if ((next & 0xc0) !== 0x80) throw Error('INVALID_UTF8');
      scalar = scalar * 64 + (next & 0x3f);
    }
    if (scalar < minimum || scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) {
      throw Error('INVALID_UTF8');
    }
    if (scalar < 0x10000) part += String.fromCharCode(scalar);
    else {
      const pair = scalar - 0x10000;
      part += String.fromCharCode(0xd800 + (pair >>> 10), 0xdc00 + (pair & 0x3ff));
    }
    // No unbounded argument spread / apply, even on a large permitted field.
    if (part.length >= 4096) { parts.push(part); part = ''; }
  }
  parts.push(part);
  return parts.join('');
}

/** Encode Unicode scalar values; reject lone UTF-16 surrogates, never replace. */
function encodeUtf8(text) {
  if (typeof text !== 'string') throw Error('TEXT_REQUIRED');
  let size = 0;
  // Validate before allocating or emitting any output.
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) size++;
    else if (unit < 0x800) size += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw Error('INVALID_UTF16');
      size += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw Error('INVALID_UTF16');
    else size += 3;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    let scalar = text.charCodeAt(i);
    if (scalar < 0x80) out[at++] = scalar;
    else if (scalar < 0x800) {
      out[at++] = 0xc0 | (scalar >>> 6);
      out[at++] = 0x80 | (scalar & 0x3f);
    } else if (scalar >= 0xd800 && scalar <= 0xdbff) {
      scalar = 0x10000 + (scalar - 0xd800) * 0x400 + text.charCodeAt(++i) - 0xdc00;
      out[at++] = 0xf0 | (scalar >>> 18);
      out[at++] = 0x80 | ((scalar >>> 12) & 0x3f);
      out[at++] = 0x80 | ((scalar >>> 6) & 0x3f);
      out[at++] = 0x80 | (scalar & 0x3f);
    } else {
      out[at++] = 0xe0 | (scalar >>> 12);
      out[at++] = 0x80 | ((scalar >>> 6) & 0x3f);
      out[at++] = 0x80 | (scalar & 0x3f);
    }
  }
  return out;
}

function checkedHashState(state) {
  const fail = () => { throw Error('INVALID_SHA256_STATE'); };
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail();
  const keys = Object.keys(state).sort();
  if (keys.join(',') !== 'h,tail,totalBytes,version' || state.version !== SHA256_VERSION) fail();
  if (!Number.isSafeInteger(state.totalBytes) || state.totalBytes < 0) fail();
  if (!Array.isArray(state.h) || state.h.length !== 8) fail();
  for (let i = 0; i < 8; i++) {
    if (!Number.isInteger(state.h[i]) || state.h[i] < 0 || state.h[i] > 0xffffffff) fail();
  }
  if (!Array.isArray(state.tail) || state.tail.length >= 64 || state.tail.length !== state.totalBytes % 64) fail();
  for (let i = 0; i < state.tail.length; i++) {
    if (!Number.isInteger(state.tail[i]) || state.tail[i] < 0 || state.tail[i] > 255) fail();
  }
  if (state.totalBytes < 64 && state.h.some((word, i) => word !== SHA256_IV[i])) fail();
  return {h: state.h.slice(), tail: state.tail.slice(), totalBytes: state.totalBytes};
}

function rotr(word, count) { return (word >>> count) | (word << (32 - count)); }

/**
 * Serializable incremental SHA-256. update() retains at most 63 input bytes;
 * snapshots have exactly four fields and are <512 ASCII JSON bytes. The live
 * compression scratchpad is 64 words and is never serialized.
 *
 * totalBytes is capped at 2^53-1; this is lower than SHA-256's standard limit,
 * but keeps every byte offset exact using GAS Number arithmetic. Length bits
 * are split without computing totalBytes * 8 as an unsafe JS integer.
 *
 * A valid-shaped saved state does not prove its authenticity or source
 * provenance. Persist it through the same integrity-protected checkpoint
 * protocol as the parser/source identity. Never resume untrusted state.
 * digestBytes()/digestHex() finalize a copy; update() can continue afterwards.
 */
class IncrementalSha256 {
  constructor(state) {
    const saved = state === undefined
      ? {h: SHA256_IV.slice(), tail: [], totalBytes: 0}
      : checkedHashState(state);
    this._h = saved.h;
    this._tail = saved.tail;
    this._totalBytes = saved.totalBytes;
    this._w = new Uint32Array(64);
  }

  snapshot() {
    return {version: SHA256_VERSION, h: this._h.slice(), tail: this._tail.slice(), totalBytes: this._totalBytes};
  }

  update(bytes) {
    // Invalid input and overflow leave state unchanged.
    checkBytes(bytes);
    if (bytes.length > Number.MAX_SAFE_INTEGER - this._totalBytes) throw Error('SHA256_LENGTH_OVERFLOW');
    let at = 0;
    if (this._tail.length) {
      while (this._tail.length < 64 && at < bytes.length) this._tail.push(bytes[at++] & 255);
      if (this._tail.length === 64) { this._compress(this._tail, 0); this._tail.length = 0; }
    }
    while (at + 64 <= bytes.length) { this._compress(bytes, at); at += 64; }
    while (at < bytes.length) this._tail.push(bytes[at++] & 255);
    this._totalBytes += bytes.length;
    return this;
  }

  _compress(bytes, offset) {
    const w = this._w;
    for (let i = 0; i < 16; i++, offset += 4) {
      w[i] = ((bytes[offset] & 255) << 24) | ((bytes[offset + 1] & 255) << 16)
        | ((bytes[offset + 2] & 255) << 8) | (bytes[offset + 3] & 255);
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this._h;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + sum1 + choose + SHA256_K[i] + w[i]) >>> 0;
      const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const mixed = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) this._h[i] = (this._h[i] + mixed[i]) >>> 0;
  }

  digestBytes() {
    const copy = new IncrementalSha256(this.snapshot());
    const paddingSize = copy._tail.length < 56 ? 64 : 128;
    const finalBlocks = new Uint8Array(paddingSize);
    finalBlocks.set(copy._tail);
    finalBlocks[copy._tail.length] = 0x80;
    const bitHigh = Math.floor(copy._totalBytes / 0x20000000);
    const bitLow = (copy._totalBytes % 0x20000000) * 8;
    for (let i = 0; i < 4; i++) {
      finalBlocks[paddingSize - 8 + i] = (bitHigh >>> (24 - 8 * i)) & 255;
      finalBlocks[paddingSize - 4 + i] = (bitLow >>> (24 - 8 * i)) & 255;
    }
    for (let at = 0; at < paddingSize; at += 64) copy._compress(finalBlocks, at);
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 4; j++) out[i * 4 + j] = (copy._h[i] >>> (24 - 8 * j)) & 255;
    }
    return out;
  }

  digestHex() {
    let hex = '';
    for (const byte of this.digestBytes()) hex += ('0' + byte.toString(16)).slice(-2);
    return hex;
  }
}

return {decodeUtf8,encodeUtf8,IncrementalSha256};
})();
const m2 = (function(){
// Pure GAS V8-compatible preparation layer. No network, clocks, tokens or persistence.
const {CsvBytes, sensorRow, sourceKey, PARSER_VERSION} = m0;
const {decodeUtf8, encodeUtf8, IncrementalSha256} = m1;
const LIMITS = Object.freeze({range:1048576,points:4096,output:262144,checkpoint:2097152,outputs:64,totalOutput:8388608});
const BASE=['time','latitude','longitude','altitude','speed'];
const EXT=['time','gFx','gFy','gFz','ax','ay','az','wx','wy','wz','P(Pa)','Bx(µT)','By(µT)','Bz(µT)','latitude','longitude','altitude','speed','yaw','pitch','roll'];
const MAPPING=Object.freeze({version:'observed-sensor-multi-v1',time:'ISO8601-UTC',coordinates:'latitude-longitude-degrees',altitudeUnit:'undeclared',speedUnit:'undeclared',negativeSpeed:'unavailable',statistics:'samples-only-no-distance'});
const hash=b=>new IncrementalSha256().update(b).digestHex();
const mappingHash=()=>hash(encodeUtf8(JSON.stringify(MAPPING)));
const copy=x=>JSON.parse(JSON.stringify(x));
const timeOrder=(a,b)=>{const seconds=a.slice(0,19).localeCompare(b.slice(0,19));if(seconds)return seconds;const fa=a.slice(19,-1).replace(/^\./,''),fb=b.slice(19,-1).replace(/^\./,''),n=Math.max(fa.length,fb.length);return fa.padEnd(n,'0').localeCompare(fb.padEnd(n,'0'));};
const check=(ok,code)=>{if(!ok)throw Error(code);};
// Packing is representation only: it never changes parser/mapping/source identity.
// Absent packingVersion is the original 1,024-point format, including its bytes.
function checkpointPointLimit(cp){
 if(!Object.prototype.hasOwnProperty.call(cp,'packingVersion'))return 1024;
 check(cp.packingVersion===1,'CHECKPOINT_PACKING');return LIMITS.points;
}
function initialCheckpoint(source,{packingVersion=1}={}){
 check(packingVersion===0||packingVersion===1,'CHECKPOINT_PACKING');
 check(source && /^\d+$/.test(String(source.size)) && Number.isSafeInteger(Number(source.size)) && Number(source.size)>0,'SOURCE_SIZE');
 check(typeof source.version==='string' && /^\d+$/.test(source.version),'SOURCE_VERSION');
 check(/^[0-9a-f]{32}$/i.test(source.md5Checksum || ''),'SOURCE_MD5');
 return {schema:1,parserVersion:PARSER_VERSION,mappingHash:mappingHash(),...(packingVersion===1?{packingVersion:1}:{}),source:copy(source),sourceKey:sourceKey(source,mappingHash()),offset:0,parser:null,header:null,sawPreamble:false,rows:0,comments:0,points:0,normalizedBytes:0,batch:0,sourceHash:new IncrementalSha256().snapshot(),normalizedHash:new IncrementalSha256().snapshot(),firstTime:null,lastTime:null,nonIncreasingTimes:0,previousManifest:null,complete:false};
}
function checkpointBytes(cp){const b=encodeUtf8(JSON.stringify(cp));check(b.length<=LIMITS.checkpoint,'CHECKPOINT_TOO_LARGE');return b;}
// Caller must read one verified range at cp.offset. No partial result escapes on parse failure.
// Returned outputs are bounded per asset AND per invocation. They remain staged until writer commit.
function prepareRange(cp, bytes){
 checkpointBytes(cp);check(cp.schema===1 && cp.parserVersion===PARSER_VERSION && cp.mappingHash===mappingHash(),'CHECKPOINT_SCHEMA');
 check(!cp.complete,'ALREADY_COMPLETE');check(cp.sourceKey===sourceKey(cp.source,cp.mappingHash),'SOURCE_KEY');
 check(Number.isSafeInteger(cp.offset)&&cp.offset>=0,'CHECKPOINT_OFFSET');
 for(const key of ['rows','comments','points','normalizedBytes','batch','nonIncreasingTimes'])check(Number.isSafeInteger(cp[key])&&cp[key]>=0,'CHECKPOINT_COUNTER');
 check(cp.sourceHash && cp.sourceHash.totalBytes===cp.offset,'HASH_OFFSET');
 check(cp.normalizedHash && cp.normalizedHash.totalBytes===cp.normalizedBytes && (cp.points===0 ? cp.normalizedBytes===0 : cp.normalizedBytes>0),'NORMALIZED_HASH_OFFSET');
 check(cp.offset===0 || cp.parser!==null,'PARSER_STATE_REQUIRED');
 if(cp.parser){const p=cp.parser;check(['start','plain','quoted','closed'].includes(p.mode) && Array.isArray(p.field) && p.field.length<=65536 && p.field.every(b=>Number.isInteger(b)&&b>=0&&b<=255) && Array.isArray(p.row)&&p.row.length<=128&&p.row.every(v=>typeof v==='string'&&encodeUtf8(v).length<=65536) && Number.isSafeInteger(p.bytes)&&p.bytes>=0&&p.bytes<=262144 && Number.isSafeInteger(p.offset)&&p.offset>=0 && typeof p.cr==='boolean'&&typeof p.first==='boolean' && (p.prefix===null || (Array.isArray(p.prefix)&&p.prefix.length<3&&p.prefix.every((b,i)=>b===[239,187,191][i]))),'PARSER_STATE_INVALID');}
 check(bytes instanceof Uint8Array && bytes.length>0 && bytes.length<=LIMITS.range,'RANGE_SIZE');
 const end=cp.offset+bytes.length,size=Number(cp.source.size);check(Number.isSafeInteger(size)&&end<=size,'RANGE_OFFSET');
 const pointLimit=checkpointPointLimit(cp),next=copy(cp),outputs=[];let parts=[],partBytes=0,totalBytes=0,pointCount=0;
 const normalized=new IncrementalSha256(cp.normalizedHash),sourceHash=new IncrementalSha256(cp.sourceHash);
 const flush=()=>{if(!pointCount)return;const out=encodeUtf8(parts.join(''));check(out.length===partBytes,'OUTPUT_ENCODING');totalBytes+=out.length;check(totalBytes<=LIMITS.totalOutput && outputs.length<LIMITS.outputs,'OUTPUT_BUDGET');outputs.push({index:next.batch++,pointCount,bytes:out,digest:hash(out)});parts=[];partBytes=0;pointCount=0;};
 const parser=new CsvBytes({decode:decodeUtf8,state:cp.parser || undefined});
 if(cp.parser)check(cp.parser.offset+(cp.parser.prefix ? cp.parser.prefix.length:0)===cp.offset,'PARSER_OFFSET');
 parser.feed(bytes,row=>{
  next.rows++;
  if(row.length===1 && row[0].startsWith('#')){
   check(!next.header,'COMMENT_AFTER_HEADER');
   if(row[0]==='# sensor:multi_record'){check(!next.sawPreamble,'DUPLICATE_PREAMBLE');next.sawPreamble=true;}
   else check(next.sawPreamble && /^# Inertial correction: sensor=(g_force|linear_acceleration|gyroscope); operation=add; unit=(1|m\/s\^2|rad\/s); x=[^;]+; y=[^;]+; z=[^;]+$/.test(row[0]),'UNKNOWN_PREAMBLE');
   next.comments++;return;
  }
  if(!next.header){
   check(next.sawPreamble,'PREAMBLE_REQUIRED');
   check((['time','latitude','longitude'].every(k=>row.includes(k)) && row.every(k=>BASE.includes(k))) || (row.length===EXT.length && EXT.every(k=>row.includes(k))),'UNSUPPORTED_SENSOR_SCHEMA');
   next.header=sensorRow(row).header;return;
  }
  const point=sensorRow(row,next.header).point;
  const line=JSON.stringify(point)+'\n', encoded=encodeUtf8(line);
  check(encoded.length<=LIMITS.output,'POINT_TOO_LARGE');
  if(pointCount===pointLimit || partBytes+encoded.length>LIMITS.output)flush();
  parts.push(line);partBytes+=encoded.length;pointCount++;normalized.update(encoded);next.normalizedBytes+=encoded.length;
  if(next.firstTime===null)next.firstTime=point.time;
  if(next.lastTime!==null && timeOrder(point.time,next.lastTime)<=0)next.nonIncreasingTimes++;
  next.lastTime=point.time;next.points++;
 },end===size);
 flush();sourceHash.update(bytes);next.offset=end;next.parser=parser.snapshot();next.sourceHash=sourceHash.snapshot();next.normalizedHash=normalized.snapshot();
 if(end===size){check(next.header && next.points>0,'EMPTY_SOURCE');next.complete=true;next.sourceSha256=sourceHash.digestHex();next.normalizedSha256=normalized.digestHex();}
 checkpointBytes(next);
 return {outputs,checkpoint:next};
}
// IDs are pre-generated by the caller; the caller MUST commit/pin these reservations through
// the application writer before uploading anything. This builder itself confers no authority.
function buildStagedPayloads(prepared,{outputIds,manifestId,checkpointId}){
 const {outputs,checkpoint}=prepared;
 check(Array.isArray(outputs)&&outputs.length<=LIMITS.outputs && outputIds.length===outputs.length,'OUTPUT_IDS');
 const ids=[...outputIds,manifestId,checkpointId];
 check(ids.every(id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(id))&&new Set(ids).size===ids.length,'ASSET_IDS');
 const assets=outputs.map((o,i)=>{check(o.bytes instanceof Uint8Array && o.bytes.length<=LIMITS.output && hash(o.bytes)===o.digest,'OUTPUT_DIGEST');return {fileId:outputIds[i],role:'output',bytes:o.bytes,sha256:o.digest,byteLength:o.bytes.length};});
 const manifest={schema:1,kind:'import-manifest-page',sourceKey:checkpoint.sourceKey,previous:checkpoint.previousManifest,throughOffset:checkpoint.offset,outputs:outputs.map((o,i)=>({fileId:outputIds[i],sha256:o.digest,byteLength:o.bytes.length,index:o.index,pointCount:o.pointCount}))};
 const mbytes=encodeUtf8(JSON.stringify(manifest));check(mbytes.length<=LIMITS.output,'MANIFEST_TOO_LARGE');
 const m={fileId:manifestId,role:'manifest-page',bytes:mbytes,sha256:hash(mbytes),byteLength:mbytes.length};assets.push(m);
 const next=copy(checkpoint);next.previousManifest={fileId:manifestId,sha256:m.sha256,byteLength:m.byteLength};
 const cbytes=checkpointBytes(next);assets.push({fileId:checkpointId,role:'checkpoint',bytes:cbytes,sha256:hash(cbytes),byteLength:cbytes.length});
 return {assets,checkpoint:next};
}

return {LIMITS,MAPPING,mappingHash,checkpointPointLimit,initialCheckpoint,checkpointBytes,prepareRange,buildStagedPayloads};
})();
const m3 = (function(){
// GAS V8-compatible source reads only. Inject existing authorized services; this module
// neither creates grants nor installs services/triggers. Keep these methods server-internal.
// Official contracts: https://developers.google.com/workspace/drive/api/guides/manage-downloads
// https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
// https://developers.google.com/workspace/drive/api/reference/rest/v3/files
// https://developers.google.com/apps-script/reference/url-fetch/http-response
// https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app
// https://developers.google.com/workspace/drive/api/guides/handle-errors
// https://www.rfc-editor.org/rfc/rfc9110.html#section-14
const SOURCE_FOLDER_ID = '1xam56gYF-jcBU5XzXBKtMxqhyJYwiNE1';
const MAX_RANGE_BYTES = 1024 * 1024;
const SOURCE_FIELDS = 'id,name,mimeType,parents,trashed,size,version,md5Checksum,capabilities(canDownload)';
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const DIGITS = /^(?:0|[1-9][0-9]*)$/;

class TransportError extends Error {
  constructor(code, details = {}) {
    super(code); this.name = 'TransportError'; this.code = code;
    // Never attach Google error text, a token, source filename, URL or source bytes.
    for (const key of ['status', 'retryAfterMs', 'restartScan']) {
      if (details[key] !== undefined) this[key] = details[key];
    }
  }
}
const fail = (code, details) => { throw new TransportError(code, details); };
function integer(value, min, max, code = 'TRANSPORT_CONFIG_INVALID') {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}
function decimal(value, code) {
  if (typeof value !== 'string' || value.length > 20 || !DIGITS.test(value)) fail(code);
  return value;
}
function inFolder(file) {
  return file && file.trashed === false && typeof file.name === 'string' &&
    /\.csv$/i.test(file.name) && typeof file.mimeType === 'string' &&
    file.mimeType.length > 0 && !file.mimeType.startsWith('application/vnd.google-apps.') &&
    Array.isArray(file.parents) && file.parents.includes(SOURCE_FOLDER_ID);
}
// A full, serializable identity is required, never a bare client-supplied file ID.
// Fresh metadata still rechecks membership before ANY media request on resume.
function validateSourceIdentity(file) {
  if (!inFolder(file)) fail('SOURCE_OUT_OF_SCOPE');
  if (typeof file.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(file.id) ||
      file.name.length > 4096 || file.mimeType.length > 256 || file.parents.length > 32 ||
      file.parents.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) ||
      typeof file.md5Checksum !== 'string' || !/^[a-fA-F0-9]{32}$/.test(file.md5Checksum)) {
    fail('SOURCE_IDENTITY_REQUIRED');
  }
  const version = decimal(file.version, 'SOURCE_IDENTITY_REQUIRED');
  const size = decimal(file.size, 'SOURCE_IDENTITY_REQUIRED');
  integer(Number(size), 0, Number.MAX_SAFE_INTEGER, 'SOURCE_SIZE_UNSUPPORTED');
  if (file.capabilities && file.capabilities.canDownload === false) fail('SOURCE_DOWNLOAD_FORBIDDEN');
  return Object.freeze({id: file.id, name: file.name, mimeType: file.mimeType,
    parents: Object.freeze(file.parents.slice()), trashed: false,
    version, size, md5Checksum: file.md5Checksum.toLowerCase()});
}
function header(headers, target, required = false) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) fail('RANGE_HEADERS_INVALID');
  const keys = Object.keys(headers).filter(key => key.toLowerCase() === target);
  if (keys.length > 1) fail('RANGE_HEADERS_INVALID');
  if (!keys.length) { if (required) fail('RANGE_HEADERS_INVALID'); return null; }
  let value = headers[keys[0]];
  if (Array.isArray(value)) { if (value.length !== 1) fail('RANGE_HEADERS_INVALID'); value = value[0]; }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string' || value.length > 1024 || /[\r\n]/.test(value)) fail('RANGE_HEADERS_INVALID');
  return value.trim();
}
// Apps Script Byte[] can contain signed bytes. Reject non-bytes rather than coercing.
function normalizeGasBytes(raw, expectedLength) {
  if (!raw || !Number.isSafeInteger(raw.length) || raw.length !== expectedLength ||
      expectedLength < 0 || expectedLength > MAX_RANGE_BYTES) fail('RANGE_LENGTH_MISMATCH');
  const bytes = new Uint8Array(expectedLength);
  for (let i = 0; i < expectedLength; i++) {
    const value = raw[i];
    if (!Number.isInteger(value) || value < -128 || value > 255) fail('RANGE_BYTES_INVALID');
    bytes[i] = value & 255;
  }
  return bytes;
}
function statusFromError(error) {
  // Advanced-service exception details are not reliably structured in every runtime.
  // Unknown exceptions fail closed; never regex-match human text into an auth retry.
  const status = error && (error.code ?? error.details?.code ?? error.error?.code);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}
function forbiddenError(error) {
  const reasons = error?.errors ?? error?.details?.errors ?? error?.error?.errors;
  // Only a bounded, unambiguous structured rate-limit error permits a 403 retry.
  if (Array.isArray(reasons) && reasons.length > 0 && reasons.length <= 8 &&
      reasons.every(item => item && ['rateLimitExceeded', 'userRateLimitExceeded'].includes(item.reason))) {
    return new TransportError('RATE_LIMITED', {status: 403});
  }
  return new TransportError('FORBIDDEN', {status: 403});
}
function serviceError(error, pageToken = null) {
  if (error instanceof TransportError) return error;
  const status = statusFromError(error);
  if (status === 401) return new TransportError('AUTH_REQUIRED', {status});
  if (status === 403) return forbiddenError(error);
  if (status === 404) return new TransportError('SOURCE_NOT_FOUND', {status});
  if (status === 400 && pageToken) return new TransportError('PAGE_TOKEN_REJECTED', {status, restartScan: true});
  return new TransportError('DRIVE_REQUEST_FAILED', {status});
}

/**
 * Synchronous GAS methods are also await-compatible. Supply the SAME absolute
 * deadlineMs across a scheduler invocation; defaults only bound an individual call.
 * UrlFetch has no documented per-request timeout/body streaming limit: a server
 * ignoring Range may buffer internally before we reject 200 without getContent().
 * This is a verified response contract, not a claim of hard platform memory/runtime limits.
 */
function createDriveSourceTransport(globals, options = {}) {
  const {Drive, UrlFetchApp, ScriptApp, Utilities} = globals || {};
  const now = globals?.now || (() => Date.now());
  const random = globals?.random || (() => Math.random());
  if (!Drive?.Files || typeof Drive.Files.list !== 'function' || typeof Drive.Files.get !== 'function' ||
      typeof UrlFetchApp?.fetch !== 'function' || typeof ScriptApp?.getOAuthToken !== 'function' ||
      typeof now !== 'function' || typeof random !== 'function') fail('GAS_SERVICES_REQUIRED');
  if ('folderId' in options && options.folderId !== SOURCE_FOLDER_ID) fail('SOURCE_FOLDER_FIXED');
  const pageSize = integer(options.pageSize ?? 100, 1, 100);
  const maxRangeBytes = integer(options.maxRangeBytes ?? MAX_RANGE_BYTES, 1, MAX_RANGE_BYTES);
  const maxAttempts = integer(options.maxAttempts ?? 3, 1, 3);
  const baseDelayMs = integer(options.baseDelayMs ?? 250, 1, 1000);
  const maxDelayMs = integer(options.maxDelayMs ?? 2000, baseDelayMs, 5000);
  const maxSleepMs = integer(options.maxSleepMs ?? 2000, 0, 2000);
  const reserveMs = integer(options.reserveMs ?? 5000, 0, 30000);
  const maxCalls = integer(options.maxCalls ?? 20, 1, 32);
  function context(args) {
    const start = now();
    if (!Number.isSafeInteger(start)) fail('CLOCK_INVALID');
    const deadlineMs = args?.deadlineMs ?? (start + 120000);
    integer(deadlineMs, 0, Number.MAX_SAFE_INTEGER, 'DEADLINE_INVALID');
    // A later caller-supplied deadline cannot increase this operation's work window.
    return {deadlineMs: Math.min(deadlineMs, start + 120000), calls: 0, slept: 0};
  }
  function check(ctx, extraMs = 0) {
    const time = now();
    if (!Number.isSafeInteger(time)) fail('CLOCK_INVALID');
    if (time + reserveMs + extraMs >= ctx.deadlineMs) fail('TRANSPORT_YIELD', {retryAfterMs: extraMs});
  }
  function call(ctx, fn) {
    check(ctx);
    if (ctx.calls >= maxCalls) fail('TRANSPORT_YIELD', {retryAfterMs: 0});
    ctx.calls++;
    const result = fn();
    check(ctx);
    return result;
  }
  function backoff(ctx, attempt, error) {
    if (attempt + 1 >= maxAttempts) fail('RETRY_EXHAUSTED', {status: error.status});
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) fail('RANDOM_INVALID');
    const delay = Math.max(error.retryAfterMs || 0,
      Math.min(maxDelayMs, baseDelayMs * (2 ** attempt) + Math.floor(sample * baseDelayMs)));
    if (delay > maxDelayMs || ctx.slept + delay > maxSleepMs || typeof Utilities?.sleep !== 'function') {
      fail('TRANSPORT_YIELD', {status: error.status, retryAfterMs: delay});
    }
    check(ctx, delay);
    Utilities.sleep(delay);
    ctx.slept += delay;
    check(ctx);
  }
  function driveCall(ctx, fn, pageToken = null) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try { return call(ctx, fn); }
      catch (raw) {
        const error = serviceError(raw, pageToken);
        if (error.code !== 'RATE_LIMITED' && (!TRANSIENT.has(error.status) || error.code !== 'DRIVE_REQUEST_FAILED')) throw error;
        backoff(ctx, attempt, error);
      }
    }
  }
  function expectedSource(expected, ctx) {
    const actual = driveCall(ctx, () => Drive.Files.get(expected.id, {fields: SOURCE_FIELDS, supportsAllDrives: true}));
    if (!inFolder(actual)) fail('SOURCE_CHANGED');
    const current = validateSourceIdentity(actual);
    if (['id', 'version', 'md5Checksum', 'size'].some(key => current[key] !== expected[key])) fail('SOURCE_CHANGED');
    return current;
  }
  function tokenValue(value) {
    if (value == null) return null;
    if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || /[\r\n\0]/.test(value)) fail('PAGE_TOKEN_INVALID');
    return value;
  }
  function listPage(args = {}) {
    const pageToken = tokenValue(args.pageToken);
    const ctx = context(args);
    const request = {q: "'" + SOURCE_FOLDER_ID + "' in parents and trashed = false",
      fields: 'nextPageToken,incompleteSearch,files(' + SOURCE_FIELDS + ')',
      pageSize, spaces: 'drive', corpora: 'user', supportsAllDrives: true};
    if (pageToken) request.pageToken = pageToken;
    const page = driveCall(ctx, () => Drive.Files.list(request), pageToken);
    if (!page || !Array.isArray(page.files) || page.files.length > pageSize ||
        (page.incompleteSearch !== undefined && typeof page.incompleteSearch !== 'boolean')) fail('LIST_RESPONSE_INVALID');
    if (page.incompleteSearch === true) fail('LIST_INCOMPLETE');
    const nextPageToken = tokenValue(page.nextPageToken);
    if (nextPageToken && nextPageToken === pageToken) fail('PAGE_TOKEN_STALLED');
    // At most one API page; no unbounded seen-ID set. Caller persists cursor, dedups
    // by content identity, restarts rejected cursors and periodically starts new scans.
    for (const file of page.files) {
      if (!file || typeof file.name !== 'string' || typeof file.mimeType !== 'string' ||
          !Array.isArray(file.parents) || typeof file.trashed !== 'boolean') fail('LIST_RESPONSE_INVALID');
    }
    const files = page.files.filter(inFolder).map(validateSourceIdentity);
    check(ctx);
    return {files, nextPageToken, done: nextPageToken === null};
  }
  function getSource(expected, args = {}) {
    return expectedSource(validateSourceIdentity(expected), context(args));
  }
  function retryAfter(headers) {
    const raw = header(headers, 'retry-after');
    if (raw === null) return 0;
    if (/^[0-9]+$/.test(raw)) {
      const ms = Number(raw) * 1000;
      if (!Number.isSafeInteger(ms)) fail('RANGE_HEADERS_INVALID');
      return ms;
    }
    const date = Date.parse(raw);
    if (!Number.isFinite(date)) fail('RANGE_HEADERS_INVALID');
    return Math.max(0, date - now());
  }
  function mediaForbidden(response) {
    // Do not getContentText() an unbounded error response. A missing, malformed or
    // large declared body is simply FORBIDDEN; no auth or quota guess is made.
    const headers = response.getAllHeaders();
    const length = header(headers, 'content-length');
    const type = header(headers, 'content-type');
    if (!length || !DIGITS.test(length) || Number(length) > 8192 ||
        !type || !/^application\/json(?:\s*;|$)/i.test(type)) return forbiddenError(null);
    try {
      const bytes = normalizeGasBytes(response.getContent(), Number(length));
      let json = '';
      // Relevant JSON reason keys are ASCII. Non-ASCII message text is ignored.
      for (const byte of bytes) json += String.fromCharCode(byte);
      return forbiddenError(JSON.parse(json));
    } catch (_) { return forbiddenError(null); }
  }
  function readRange(expectedInput, start, length = maxRangeBytes, args = {}) {
    const expected = validateSourceIdentity(expectedInput);
    const size = Number(expected.size);
    integer(start, 0, Math.max(0, size - 1), 'RANGE_REQUEST_INVALID');
    integer(length, 1, maxRangeBytes, 'RANGE_REQUEST_INVALID');
    if (size === 0 || start >= size) fail('RANGE_REQUEST_INVALID');
    const count = Math.min(length, size - start);
    const end = start + count - 1;
    const ctx = context(args);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      expectedSource(expected, ctx);
      let token;
      try { token = ScriptApp.getOAuthToken(); }
      catch (_) { fail('AUTH_REQUIRED'); }
      if (typeof token !== 'string' || !token || token.length > 8192 || /[\s\x00-\x1f\x7f]/.test(token)) fail('AUTH_REQUIRED');
      let response, fetchError;
      try {
        response = call(ctx, () => UrlFetchApp.fetch(
          'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(expected.id) + '?alt=media',
          {method: 'get', headers: {Authorization: 'Bearer ' + token,
            Range: 'bytes=' + start + '-' + end, 'Accept-Encoding': 'identity'},
          followRedirects: false, validateHttpsCertificates: true, muteHttpExceptions: true}));
      } catch (error) { fetchError = error; }
      token = null;
      // No response bytes are exposed until a post-read freshness check succeeds.
      // If the deadline has elapsed, this check yields and the unverified body is discarded.
      expectedSource(expected, ctx);
      if (fetchError) {
        if (fetchError instanceof TransportError) throw fetchError;
        const status = statusFromError(fetchError);
        if (status === 401) fail('AUTH_REQUIRED', {status});
        const error = status === 403 ? forbiddenError(fetchError) : new TransportError('MEDIA_REQUEST_FAILED', {status});
        if (error.code === 'FORBIDDEN') throw error;
        if (error.code !== 'RATE_LIMITED' && !TRANSIENT.has(status)) throw error;
        backoff(ctx, attempt, error);
        continue;
      }
      if (!response || typeof response.getResponseCode !== 'function' ||
          typeof response.getAllHeaders !== 'function' || typeof response.getContent !== 'function') fail('RANGE_RESPONSE_INVALID');
      const status = response.getResponseCode();
      if (!Number.isInteger(status) || status < 100 || status > 599) fail('RANGE_RESPONSE_INVALID');
      if (status === 401) fail('AUTH_REQUIRED', {status});
      if (status === 403) {
        const error = mediaForbidden(response);
        if (error.code !== 'RATE_LIMITED') throw error;
        error.retryAfterMs = retryAfter(response.getAllHeaders());
        backoff(ctx, attempt, error);
        continue;
      }
      if (status === 404) fail('SOURCE_NOT_FOUND', {status});
      if (TRANSIENT.has(status)) {
        backoff(ctx, attempt, new TransportError('MEDIA_REQUEST_FAILED', {status,
          retryAfterMs: retryAfter(response.getAllHeaders())}));
        continue;
      }
      // In particular, never accept full-file 200, redirects, 304, or 416.
      if (status !== 206) fail('RANGE_STATUS_INVALID', {status});
      const headers = response.getAllHeaders();
      const range = header(headers, 'content-range', true);
      const match = /^bytes (0|[1-9][0-9]*)-(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)$/.exec(range);
      if (!match || match[1] !== String(start) || match[2] !== String(end) || match[3] !== expected.size) fail('RANGE_CONTENT_RANGE_INVALID');
      const contentLength = header(headers, 'content-length');
      if (contentLength !== null && contentLength !== String(count)) fail('RANGE_LENGTH_MISMATCH');
      const encoding = header(headers, 'content-encoding');
      if (encoding !== null && encoding.toLowerCase() !== 'identity') fail('RANGE_ENCODING_INVALID');
      const contentType = header(headers, 'content-type');
      if (contentType !== null && /^multipart\//i.test(contentType)) fail('RANGE_MULTIPART_INVALID');
      let raw;
      try { raw = response.getContent(); }
      catch (_) { fail('MEDIA_BODY_UNAVAILABLE'); }
      const bytes = normalizeGasBytes(raw, count);
      check(ctx);
      return bytes;
    }
  }
  return Object.freeze({listPage, getSource, readRange, folderId: SOURCE_FOLDER_ID, maxRangeBytes});
}

return {SOURCE_FOLDER_ID,MAX_RANGE_BYTES,SOURCE_FIELDS,TransportError,validateSourceIdentity,normalizeGasBytes,createDriveSourceTransport};
})();
const m4 = (function(){
// Local candidate only. This module does NOT supply the reserved-slot writer,
// allocate file IDs, persist pins, or authorize a deployment.
const {IncrementalSha256, encodeUtf8, decodeUtf8} = m1;

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const ROLE_LIMITS = Object.freeze({output: MAX_OUTPUT_BYTES, checkpoint: MAX_CHECKPOINT_BYTES, 'manifest-page': MAX_MANIFEST_BYTES});
const FIELDS = 'id,parents,appProperties,size,trashed,mimeType,ownedByMe,shared';
const MIME = 'application/octet-stream';
const fail = code => { throw new Error(code); };
const safeAssetError = error => /^(?:ASSET_(?:(?:METADATA|CONTENT)_MISMATCH|BYTES_INVALID|TOO_LARGE|UNRESOLVED|MEDIA_[A-Z_]+)|IMPORT_YIELD)$/.test(error?.message || '');
const unresolvedAsset = stage => {const e=new Error('ASSET_UNRESOLVED');e.retryable=true;e.stage=stage;return e;};
const token = (value, max=100) => typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);

function asBytes(value, limit, code='ASSET_BYTES_INVALID') {
  if (!value || !Number.isSafeInteger(value.length) || value.length > limit) fail(value && value.length > limit ? 'ASSET_TOO_LARGE' : code);
  const out = new Uint8Array(value.length);
  for (let i=0; i<value.length; i++) {
    const n=value[i];
    // GAS Blob.getBytes() uses signed Java bytes; typed arrays use unsigned bytes.
    if (!Number.isInteger(n) || n < -128 || n > 255) fail(code);
    out[i]=n & 255;
  }
  return out;
}
function hashAssetBytes(bytes) { return new IncrementalSha256().update(bytes).digestHex(); }

function encodeBoundedJson(value, maxBytes=MAX_CHECKPOINT_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CHECKPOINT_BYTES) fail('JSON_BOUND_INVALID');
  let json;
  try { json=JSON.stringify(value); } catch (_) { fail('JSON_INVALID'); }
  if (typeof json !== 'string') fail('JSON_INVALID');
  // Early character check avoids encoding an already over-large string.
  if (json.length > maxBytes) fail('CHECKPOINT_TOO_LARGE');
  const bytes=encodeUtf8(json);
  if (bytes.length > maxBytes) fail('CHECKPOINT_TOO_LARGE');
  return bytes;
}

function validatedReservation(input, storeId) {
  if (!input || !token(input.fileId, 128) || !token(input.jobId) || !token(input.pinId) || input.storeId !== storeId || !Object.prototype.hasOwnProperty.call(ROLE_LIMITS,input.role)) fail('RESERVATION_INVALID');
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > ROLE_LIMITS[input.role]) fail('ASSET_TOO_LARGE');
  if (typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.sha256)) fail('RESERVATION_DIGEST_INVALID');
  return Object.freeze({fileId:input.fileId,storeId:input.storeId,jobId:input.jobId,pinId:input.pinId,role:input.role,byteLength:input.byteLength,sha256:input.sha256});
}
function markers(r) { return {'mypace.store':r.storeId,'mypace.job':r.jobId,'mypace.pin':r.pinId,'mypace.role':r.role,'mypace.sha256':r.sha256}; }

/**
 * Advanced Drive v3 immutable multipart creates with mandatory exact read-back.
 * assertReservation(r) must return true only for a reservation already persisted
 * in the EXISTING writer's live pinned job. A supplied object or appProperties
 * alone is not authorization. readAssetBytes(id, byteLength, maxBytes) must be a
 * bounded, authenticated media reader restricted to the supplied same fixed ID.
 * No dependency may silently perform alternate-ID creation or overwrite.
 */
class ImmutableAssetAdapter {
  constructor({Drive,Utilities,readAssetBytes,managedParentId,storeId,assertReservation}) {
    if (!Drive?.Files || typeof Drive.Files.create!=='function' || typeof Drive.Files.get!=='function' || typeof Utilities?.newBlob!=='function' || typeof readAssetBytes!=='function' || typeof assertReservation!=='function' || !token(managedParentId,128) || !token(storeId)) fail('ASSET_ADAPTER_CONFIG_INVALID');
    this.Drive=Drive; this.Utilities=Utilities; this.readAssetBytes=readAssetBytes;
    this.managedParentId=managedParentId; this.storeId=storeId; this.assertReservation=assertReservation;
  }
  _proposal({reservation,bytes}) {
    const r=validatedReservation(reservation,this.storeId);
    // Never let a caller-created descriptor stand in for durable writer evidence.
    if (this.assertReservation(r)!==true) fail('RESERVATION_NOT_DURABLE');
    const body=asBytes(bytes,ROLE_LIMITS[r.role]);
    if (body.length!==r.byteLength || hashAssetBytes(body)!==r.sha256) fail('ASSET_PROPOSAL_MISMATCH');
    return {r,body};
  }
  _privateParent() {
    let parent;
    try { parent=this.Drive.Files.get(this.managedParentId,{fields:'id,mimeType,trashed,ownedByMe,shared'}); }
    catch (_) { const e=new Error('MANAGED_PARENT_UNRESOLVED');e.retryable=true;throw e; }
    if (!parent || parent.id!==this.managedParentId || parent.mimeType!=='application/vnd.google-apps.folder' || parent.trashed!==false || parent.ownedByMe!==true || parent.shared!==false) fail('MANAGED_PARENT_NOT_PRIVATE');
  }
  _verify(r,expected) {
    let meta;
    try { meta=this.Drive.Files.get(r.fileId,{fields:FIELDS}); }
    catch (_) {throw unresolvedAsset('metadata');}
    const props=markers(r);
    if (!meta || meta.id!==r.fileId || meta.trashed!==false || meta.ownedByMe!==true || meta.shared!==false || meta.mimeType!==MIME || !Array.isArray(meta.parents) || meta.parents.length!==1 || meta.parents[0]!==this.managedParentId || String(meta.size)!==String(r.byteLength) || Object.keys(props).some(k=>meta.appProperties?.[k]!==props[k])) fail('ASSET_METADATA_MISMATCH');
    // Metadata is checked before media retrieval, with a fixed per-role bound.
    let read;
    try { read=this.readAssetBytes(r.fileId,r.byteLength,ROLE_LIMITS[r.role]); }
    catch(error) {if(safeAssetError(error))throw error;throw unresolvedAsset('media');}
    const actual=asBytes(read,ROLE_LIMITS[r.role]);
    if (actual.length!==expected.length || hashAssetBytes(actual)!==r.sha256) fail('ASSET_CONTENT_MISMATCH');
    for (let i=0; i<actual.length; i++) if(actual[i]!==expected[i]) fail('ASSET_CONTENT_MISMATCH');
    return Object.freeze({...r,verified:true});
  }
  verify(proposal) {
    const {r,body}=this._proposal(proposal);
    return this._verify(r,body);
  }
  putOnce(proposal) {
    const {r,body}=this._proposal(proposal);
    this._privateParent();
    // A resumed reservation may already have uploaded this exact immutable ID.
    // Verify it before issuing another guaranteed-conflicting create. Fresh
    // batches retain create-first behavior; no byte/privacy check is skipped.
    if(proposal.reuseExisting===true){
      try{return this._verify(r,body);}catch(error){
        // Only an unresolved metadata lookup can mean this reserved slot still
        // needs its first create. Existing wrong metadata/content or a failed
        // media read never permits a write/replacement fallback.
        if(error?.message!=='ASSET_UNRESOLVED'||error.stage!=='metadata')throw error;
      }
    }
    const metadata={id:r.fileId,name:`mypace-${r.role}-${r.fileId}`,mimeType:MIME,parents:[this.managedParentId],appProperties:markers(r)};
    const signed=Array.from(body,n=>n>127?n-256:n);
    const blob=this.Utilities.newBlob(signed,MIME,metadata.name);
    let createError;
    try {
      const result=this.Drive.Files.create(metadata,blob,{fields:'id',ignoreDefaultVisibility:true});
      if (!result || result.id!==r.fileId) fail('ASSET_CREATE_ID_MISMATCH');
    } catch(error) {
      if (error?.message==='ASSET_CREATE_ID_MISMATCH') throw error;
      createError=error;
      // Including timeout/409: inspect THIS ID. Never search/create another ID.
    }
    try { return this._verify(r,body); }
    catch(error) {
      // Content/identity corruption is terminal. Other read failures remain
      // unresolved; a caller may retry the same committed descriptor later.
      if (safeAssetError(error)) throw error;
      const unresolved=new Error('ASSET_UNRESOLVED');
      unresolved.retryable=true;
      unresolved.fileId=r.fileId;
      unresolved.stage=createError?'create-or-readback':'readback';
      throw unresolved;
    }
  }
}

/**
 * Server-internal same-ID media reader for the adapter above. This is not a
 * client API accepting arbitrary Drive IDs. assertReadableAsset must validate
 * the caller's current committed managed reservation before ANY request; the
 * adapter also checks ownership/privacy/markers before invoking this function.
 * GAS fetch buffers its response and offers no request streaming/body ceiling:
 * the requested range is bounded, but a misbehaving server may allocate a larger
 * response before rejection. Never fall back to a full-file 200 download.
 */
function createGasAssetMediaReader({UrlFetchApp,ScriptApp,assertReadableAsset,checkBudget}) {
  if (typeof UrlFetchApp?.fetch!=='function' || typeof ScriptApp?.getOAuthToken!=='function' || typeof assertReadableAsset!=='function' || typeof checkBudget!=='function') fail('ASSET_MEDIA_CONFIG_INVALID');
  return function readAssetBytes(fileId,expectedLength,maxBytes) {
    if (!token(fileId,128) || !Number.isSafeInteger(expectedLength) || expectedLength<1 || !Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>MAX_CHECKPOINT_BYTES || expectedLength>maxBytes) fail('ASSET_MEDIA_BOUNDS_INVALID');
    if (assertReadableAsset(fileId,expectedLength,maxBytes)!==true) fail('ASSET_MEDIA_NOT_RESERVED');
    if (checkBudget('asset-media')!==true) {const e=new Error('IMPORT_YIELD');e.retryable=true;throw e;}
    let response;
    try {
      const oauth=ScriptApp.getOAuthToken();
      if (typeof oauth!=='string' || !oauth) fail('ASSET_AUTH_UNAVAILABLE');
      response=UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(fileId)+'?alt=media',{
        method:'get',headers:{Authorization:'Bearer '+oauth,Range:'bytes=0-'+(expectedLength-1),'Accept-Encoding':'identity'},
        muteHttpExceptions:true,followRedirects:false
      });
    } catch (_) {const e=new Error('ASSET_MEDIA_PENDING');e.retryable=true;throw e;}
    if (!response || typeof response.getResponseCode!=='function' || typeof response.getAllHeaders!=='function' || typeof response.getContent!=='function') fail('ASSET_MEDIA_RESPONSE_INVALID');
    const status=response.getResponseCode();
    if (status!==206) {
      const e=new Error('ASSET_MEDIA_STATUS');e.status=status;
      e.retryable=[401,403,404,408,429,500,502,503,504].includes(status);throw e;
    }
    const all=response.getAllHeaders();
    if (!all || typeof all!=='object' || Array.isArray(all)) fail('ASSET_MEDIA_HEADERS_INVALID');
    const header=name=>{
      const keys=Object.keys(all).filter(k=>k.toLowerCase()===name);
      if (!keys.length) return null;
      if (keys.length!==1 || !['string','number'].includes(typeof all[keys[0]])) fail('ASSET_MEDIA_HEADERS_INVALID');
      return String(all[keys[0]]).trim();
    };
    if (header('content-range')!=='bytes 0-'+(expectedLength-1)+'/'+expectedLength) fail('ASSET_MEDIA_RANGE_MISMATCH');
    const length=header('content-length'),encoding=header('content-encoding');
    if ((length!==null && length!==String(expectedLength)) || (encoding!==null && encoding.toLowerCase()!=='identity')) fail('ASSET_MEDIA_HEADERS_INVALID');
    const body=asBytes(response.getContent(),maxBytes);
    if (body.length!==expectedLength) fail('ASSET_CONTENT_MISMATCH');
    return body;
  };
}

const MAX_BATCH_OUTPUT_ASSETS = 64;
const MAX_BATCH_OUTPUT_BYTES = 8 * 1024 * 1024;

// Restricted canonical JSON keeps a command stable across retries even if object
// insertion order differs. The digest binds checkpoints as well as route output.
function canonical(value, depth=0) {
  if (depth>32) fail('COMMAND_TOO_DEEP');
  if (value===null || typeof value==='string' || typeof value==='boolean') return JSON.stringify(value);
  if (typeof value==='number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '['+value.map(v=>canonical(v,depth+1)).join(',')+']';
  if (typeof value==='object' && value && Object.getPrototypeOf(value)===Object.prototype) return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k],depth+1)).join(',')+'}';
  fail('COMMAND_VALUE_INVALID');
}
function receiptFor(receipt, command) {
  if (!receipt || receipt.operationId!==command.operationId || receipt.digest!==command.digest) fail('OP_ID_REUSED');
  return receipt;
}

/**
 * Two bounded lock phases around immutable staging. All durable state and
 * authoritative commit/recovery remain in the injected EXISTING reserved-slot
 * writer; this is deliberately not another database or a fake production writer.
 *
 * Required synchronous writer methods, called with the script lock held:
 *   recoveryBarrier(): finish/check all mandatory publication barriers or throw.
 *   getReceipt(operationId): return committed original receipt or null.
 *   validateImportBatch(command,{checkpoint,manifestPage}): return true only after checking store/writer
 *     identity, expected job checkpoint, every persisted reservation and active
 *     durable pin; their lengths/hashes/roles must exactly match command.assets. Verify the
 *     decoded checkpoint schema/expected previousManifest and exact output
 *     descriptors and links in the manifest page. Role counts are not enough.
 *   commitImportBatch(command,{verifiedAssets}): use the existing reserved-slot
 *     protocol and ordered version-checked job/ready/reference transition; return
 *     {operationId,digest,...}. Unpinning must have no reference-protection gap.
 *
 * validateSourceCurrent(sourceIdentity) must re-read source metadata and compare
 * ID, observed version, checksum, size, direct parent and candidate restrictions.
 * It runs under the final lock, immediately before commit. A writer must still
 * verify every ready descriptor/pin in the same authoritative frame transition.
 * The writer must not trust command fields or verified:true as authorization.
 * completed means parsing finished in this staged checkpoint ONLY. This module
 * never publishes a completed run or contributes totals/rewards. Full manifest,
 * source hash/count/stability and domain checks still gate that separate action.
 * Required checkBudget(stage) in an invocation: true only while enough time/quota
 * remains, INCLUDING an early checkpoint/recovery reserve. False yields with
 * existing checkpoint/pins intact. A GAS API call cannot be interrupted once
 * started; there is no per-call timeout guarantee. The callback must
 * conservatively reserve the ENTIRE final verify/source/commit/recovery phase
 * before final-lock, using observed call latency and bounded batch size.
 */
class ImportCheckpointCoordinator {
  constructor({writer,assets,getScriptLock,validateSourceCurrent,lockTimeoutMs=1000,checkBudget}) {
    if (!writer || ['recoveryBarrier','getReceipt','validateImportBatch','commitImportBatch'].some(k=>typeof writer[k]!=='function') || !assets || typeof assets.putOnce!=='function' || typeof assets.verify!=='function' || typeof getScriptLock!=='function' || typeof validateSourceCurrent!=='function' || typeof checkBudget!=='function' || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs<0 || lockTimeoutMs>5000) fail('COORDINATOR_CONFIG_INVALID');
    this.writer=writer; this.assets=assets; this.getScriptLock=getScriptLock;
    this.validateSourceCurrent=validateSourceCurrent; this.lockTimeoutMs=lockTimeoutMs; this.checkBudget=checkBudget;
  }
  _budget(stage) {
    if (this.checkBudget(stage)!==true) {const e=new Error('IMPORT_YIELD');e.retryable=true;throw e;}
  }
  _locked(fn) {
    const lock=this.getScriptLock();
    if (!lock || typeof lock.tryLock!=='function' || typeof lock.releaseLock!=='function') fail('LOCK_INVALID');
    // Owner-editor orchestration may already hold this exact project lock.
    // Never release a lock acquired by the caller.
    if (typeof lock.hasLock==='function' && lock.hasLock()===true) return fn();
    let acquired=false;
    try {
      acquired=lock.tryLock(this.lockTimeoutMs)===true;
      if (!acquired) { const e=new Error('WRITER_BUSY');e.retryable=true;throw e; }
      return fn();
    } finally { if (acquired) lock.releaseLock(); }
  }
  _validate(command, content) {
    if (this.writer.validateImportBatch(command,content)!==true) fail('JOB_RESERVATION_OR_VERSION_INVALID');
  }
  commitPreparedBatch(input) {
    if (!input || !token(input.operationId,128) || !token(input.jobId) || !(input.expectedCheckpointId===null || token(input.expectedCheckpointId,128)) || typeof input.completed!=='boolean' || !input.sourceIdentity || !Array.isArray(input.assets) || input.assets.length<2 || input.assets.length>MAX_BATCH_OUTPUT_ASSETS+2) fail('IMPORT_COMMAND_INVALID');
    const seen=new Set();
    const staged=[]; let outputCount=0, outputBytes=0, checkpointCount=0, manifestCount=0;
    for (const a of input.assets) {
      const r=validatedReservation(a?.reservation,a?.reservation?.storeId);
      if (r.jobId!==input.jobId || seen.has(r.fileId)) fail('IMPORT_ASSET_IDENTITY_INVALID');
      seen.add(r.fileId);
      const bytes=asBytes(a.bytes,ROLE_LIMITS[r.role]);
      if (bytes.length!==r.byteLength || hashAssetBytes(bytes)!==r.sha256) fail('ASSET_PROPOSAL_MISMATCH');
      if (r.role==='output') {outputCount++;outputBytes+=r.byteLength;}
      if (r.role==='checkpoint') checkpointCount++;
      if (r.role==='manifest-page') manifestCount++;
      staged.push({reservation:r,bytes});
    }
    if (checkpointCount!==1 || manifestCount!==1 || outputCount>MAX_BATCH_OUTPUT_ASSETS || outputBytes>MAX_BATCH_OUTPUT_BYTES) fail('IMPORT_BATCH_BOUNDS_INVALID');
    const storeId=staged[0].reservation.storeId;
    if (!token(storeId) || staged.some(a=>a.reservation.storeId!==storeId)) fail('IMPORT_STORE_MISMATCH');
    // Clone and cap source identity rather than retaining caller-mutable state.
    const sourceJson=canonical(input.sourceIdentity);
    if (encodeUtf8(sourceJson).length>16*1024) fail('SOURCE_IDENTITY_TOO_LARGE');
    const base={protocol:'mypace-import-batch-v1',storeId,operationId:input.operationId,jobId:input.jobId,expectedCheckpointId:input.expectedCheckpointId,sourceIdentity:JSON.parse(sourceJson),completed:input.completed,assets:staged.map(a=>a.reservation)};
    const digest=hashAssetBytes(encodeUtf8(canonical(base)));
    // Recursive freeze prevents callbacks changing the command after hashing.
    const freeze=(v,depth=0)=>{if(depth>32)fail('COMMAND_TOO_DEEP');if(v && typeof v==='object'){Object.values(v).forEach(x=>freeze(x,depth+1));Object.freeze(v);}return v;};
    const command=freeze({...base,digest});
    const parsed={};
    for (const a of staged) if(a.reservation.role!=='output') {
      let value;
      try { value=JSON.parse(decodeUtf8(a.bytes)); } catch (_) { fail('IMPORT_CHECKPOINT_JSON_INVALID'); }
      if (!value || typeof value!=='object' || Array.isArray(value)) fail('IMPORT_CHECKPOINT_JSON_INVALID');
      parsed[a.reservation.role==='checkpoint'?'checkpoint':'manifestPage']=value;
    }
    const content=freeze(parsed);
    const prior=this._locked(()=>{
      this.writer.recoveryBarrier();
      const receipt=this.writer.getReceipt(command.operationId);
      if (receipt) return receiptFor(receipt,command);
      this._validate(command,content);
      return null;
    });
    if (prior) return prior;
    // IDs and live pins have already been committed and checked above.
    // Normal runner uploads release the phase lock here. An owner-editor
    // invocation may deliberately hold the outer lock for its bounded step.
    for (const a of staged) { this._budget('stage'); this.assets.putOnce(input.reuseExisting===true?{...a,reuseExisting:true}:a); }
    this._budget('final-lock');
    return this._locked(()=>{
      this.writer.recoveryBarrier();
      const receipt=this.writer.getReceipt(command.operationId);
      if (receipt) return receiptFor(receipt,command);
      this._validate(command,content);
      const verifiedAssets=staged.map(a=>{this._budget('verify');return this.assets.verify(a);});
      this._budget('source');
      if (this.validateSourceCurrent(command.sourceIdentity)!==true) fail('SOURCE_CHANGED');
      this._budget('commit');
      const committed=receiptFor(this.writer.commitImportBatch(command,{verifiedAssets}),command);
      // Mandatory checkpoint-index publication recovery precedes success as well
      // as the next mutation. No hint write can substitute for this barrier.
      this.writer.recoveryBarrier();
      return committed;
    });
  }
}

return {MAX_OUTPUT_BYTES,MAX_CHECKPOINT_BYTES,MAX_MANIFEST_BYTES,hashAssetBytes,encodeBoundedJson,ImmutableAssetAdapter,createGasAssetMediaReader,MAX_BATCH_OUTPUT_ASSETS,MAX_BATCH_OUTPUT_BYTES,ImportCheckpointCoordinator};
})();
const m5 = (function(){
// Server-only authenticated acceleration. These bytes are never authoritative
// state, an authentication credential, or a caller-selected recovery root.
const {encodeUtf8,decodeUtf8} = m1;
const CHECKPOINT_HINT_PROTOCOL='mypace-checkpoint-hint-v1';
// Same authenticated fixed-ID envelope, explicitly different semantics: this
// certifies only a traversed INDEX prefix, never recovered business state.
const INDEX_SCAN_HINT_PROTOCOL='mypace-index-scan-hint-v1';
// Owner recovery attests a fully verified immutable frame prefix. Roots and
// receipts remain in the referenced immutable frame, never in mutable advice.
const FRAME_SCAN_HINT_PROTOCOL='mypace-frame-scan-hint-v1';
const CHECKPOINT_HINT_MAX_BYTES=4096;
const CHECKPOINT_HINT_DOMAIN='MyPace/Drive/checkpoint-hint/HMAC-SHA256/v1\n';
const hash=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const fail=code=>{throw Error(code);};
function canonical(x,depth=0){
 if(depth>8)fail('CHECKPOINT_HINT_FORMAT');
 if(x===null||typeof x==='string'||typeof x==='boolean'||(typeof x==='number'&&Number.isSafeInteger(x)))return JSON.stringify(x);
 if(x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype)return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k],depth+1)).join(',')+'}';
 fail('CHECKPOINT_HINT_FORMAT');
}
function sameMac(a,b){if(!hash(a)||!hash(b))return false;let difference=0;for(let i=0;i<64;i++)difference|=a.charCodeAt(i)^b.charCodeAt(i);return difference===0;}
function createCheckpointHintCodec({hmacSha256}={}){
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
function createGasCheckpointHintCodec({Utilities,secret}={}){
 if(typeof secret!=='string'||encodeUtf8(secret).length<32||encodeUtf8(secret).length>4096||typeof Utilities?.computeHmacSha256Signature!=='function'||Utilities?.Charset?.UTF_8===undefined)fail('CHECKPOINT_HINT_AUTH_REQUIRED');
 return createCheckpointHintCodec({hmacSha256:text=>{
  const bytes=Utilities.computeHmacSha256Signature(text,secret,Utilities.Charset.UTF_8);
  if(!bytes||bytes.length!==32)fail('CHECKPOINT_HINT_AUTH_INVALID');
  return Array.from(bytes,n=>{if(!Number.isInteger(n)||n< -128||n>255)fail('CHECKPOINT_HINT_AUTH_INVALID');return (n&255).toString(16).padStart(2,'0');}).join('');
 }});
}

return {CHECKPOINT_HINT_PROTOCOL,INDEX_SCAN_HINT_PROTOCOL,FRAME_SCAN_HINT_PROTOCOL,CHECKPOINT_HINT_MAX_BYTES,CHECKPOINT_HINT_DOMAIN,createCheckpointHintCodec,createGasCheckpointHintCodec};
})();
const m6 = (function(){
/**
 * Portable, synchronous GAS V8 reserved-slot writer. No external state is
 * authoritative: the fixed Drive bootstrap, immutable frames, index links and
 * copy-on-write radix shards are the complete durable store.
 *
 * IO contract (all methods synchronous):
 * getScriptId(), assertLockHeld() === true, allocateIds(n) -> unique IDs;
 * readFile(id, maxBytes) -> bytes or null ONLY for positively identified 404;
 * createFile(id, bytes, role) -> immutable same-ID create, NEVER overwrite.
 * Optional readCheckpointHint()/writeCheckpointHint(bytes) address one fixed
 * separately pinned, non-authoritative mutable hint; they accept no caller ID.
 * IO must enforce private owned managed-parent metadata and byte bounds.
 * Caller owns the script lock. This module never acquires/releases another
 * invocation's lock. A fresh recoveryBarrier() is required each lock phase.
 *
 * This is a local implementation, not proof of Drive's complete-byte atomic
 * create/visibility semantics. Those remain live integration gates. No GC,
 * deployment, endpoint authentication or domain-specific authorization here.
 * An optional authenticated, separately pinned mutable hint accelerates cold
 * recovery; immutable index/manifest/publication verification remains mandatory.
 * The absolute index ordinal is authenticated, but is not a lifetime limit.
 * With authenticated recovery configured, maxIndexScanLinks bounds discovery
 * per call (also respecting a smaller maxIndexLinks); signed INDEX-prefix cursors
 * resume full-anchor scans. No state
 * is ready until discovery and current manifest/publication/tail verification
 * finish. Missing keys or unsupported legacy stores require owner setup at the
 * safe legacy admission limit. Receipts and revision proofs are never purged.
 * Referenced shards are verified on bounded traversal, not by a full-store scrub.
 */
const {CHECKPOINT_HINT_PROTOCOL,INDEX_SCAN_HINT_PROTOCOL,FRAME_SCAN_HINT_PROTOCOL} = m5;
const {IncrementalSha256, encodeUtf8, decodeUtf8} = m1;

const WRITER_PROTOCOL = 'mypace-reserved-v1';
const WRITER_ROLES = Object.freeze(['bootstrap','frame','index-node','checkpoint-manifest','checkpoint-index']);
const DEFAULT_LIMITS = Object.freeze({maxFileBytes:256*1024,maxValueBytes:128*1024,maxChanges:128,maxReferences:128,maxLeafEntries:512,maxCachedNodes:64,maxReplayFrames:256,maxIndexLinks:4096,maxIndexScanLinks:64,checkpointEvery:16,maxContention:4,maxCreateAttempts:2});
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const validId=s=>typeof s==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const digestOk=s=>typeof s==='string' && /^[0-9a-f]{64}$/.test(s);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
function fail(code,retryable=false) {const e=new Error(code);e.code=code;if(retryable)e.retryable=true;throw e;}
function canonical(value,depth=0) {
  if(depth>40)fail('WRITER_VALUE_DEPTH');
  if(value===null || typeof value==='string' || typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number' && Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value)) {
    for(let i=0;i<value.length;i++)if(!own(value,i))fail('WRITER_VALUE_INVALID');
    return '['+value.map(v=>canonical(v,depth+1)).join(',')+']';
  }
  if(value && typeof value==='object' && Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k],depth+1)).join(',')+'}';
  fail('WRITER_VALUE_INVALID');
}
function writerDigest(value) {return new IncrementalSha256().update(encodeUtf8(canonical(value))).digestHex();}
function clone(v) {return JSON.parse(canonical(v));}
function equal(a,b) {return canonical(a)===canonical(b);}
function refOk(r) {return r===null || !!(r && validId(r.id) && digestOk(r.hash) && Object.keys(r).sort().join(',')==='hash,id');}
function receiptKey(epoch,id) {return JSON.stringify([epoch,id]);}
function pointer(file) {return {id:file.id,hash:file.hash};}

class ReservedSlotWriter {
  constructor({io,anchorId,bootstrapId,storeId,writerScriptId,scriptId,schemaVersion=3,limits={},clock=()=>new Date().toISOString(),validateMutation,verifyReferences,checkpointHintId,checkpointHintAnchorHash,checkpointHintCodec}) {
    anchorId=anchorId||bootstrapId;writerScriptId=writerScriptId||scriptId;
    if(!io || ['getScriptId','assertLockHeld','allocateIds','readFile','createFile'].some(k=>typeof io[k]!=='function') || !validId(anchorId) || !validId(storeId) || !validId(writerScriptId) || !integer(schemaVersion) || schemaVersion<1 || typeof clock!=='function')fail('WRITER_CONFIG_INVALID');
    if(checkpointHintId!==undefined&&(!validId(checkpointHintId)||[anchorId,storeId,writerScriptId].includes(checkpointHintId)))fail('WRITER_HINT_CONFIG');
    if(checkpointHintAnchorHash!==undefined&&(!checkpointHintId||!digestOk(checkpointHintAnchorHash)))fail('WRITER_HINT_CONFIG');
    if(checkpointHintCodec!==undefined&&(!checkpointHintId||typeof checkpointHintCodec?.encode!=='function'||typeof checkpointHintCodec?.decode!=='function'||typeof io.readCheckpointHint!=='function'||typeof io.writeCheckpointHint!=='function'))fail('WRITER_HINT_CONFIG');
    this.checkpointHintId=checkpointHintId;this.checkpointHintAnchorHash=checkpointHintAnchorHash;this.checkpointHintCodec=checkpointHintCodec;this._hintRef=null;
    this.io=io;this.anchorId=anchorId;this.storeId=storeId;this.writerScriptId=writerScriptId;this.schemaVersion=schemaVersion;this.clock=clock;this.validateMutation=validateMutation;this.verifyReferences=verifyReferences;
    this.limits={...DEFAULT_LIMITS,...limits};
    if(Object.keys(limits).some(k=>!own(DEFAULT_LIMITS,k)) || Object.values(this.limits).some(v=>!Number.isSafeInteger(v)||v<1) || this.limits.maxValueBytes>this.limits.maxFileBytes || this.limits.checkpointEvery+2>=this.limits.maxReplayFrames)fail('WRITER_LIMITS_INVALID');
    this._state=null;this._cache=new Map();this._ids=[];this._verifiedPhase=null;this._recovering=false;
  }
  _guard() {
    if(this.io.getScriptId()!==this.writerScriptId)fail('WRITER_SCRIPT_MISMATCH');
    if(this.io.assertLockHeld()!==true)fail('WRITER_LOCK_REQUIRED');
  }
  _id() {
    if(!this._ids.length) {
      const ids=this.io.allocateIds(16);
      if(!Array.isArray(ids)||ids.length!==16||ids.some(x=>!validId(x))||new Set(ids).size!==ids.length)fail('WRITER_ID_ALLOCATION_INVALID');
      this._ids=ids.slice();
    }
    return this._ids.shift();
  }
  _sealed(kind,payload) {
    const body={protocol:WRITER_PROTOCOL,kind,storeId:this.storeId,writerScriptId:this.writerScriptId,schemaVersion:this.schemaVersion,payload};
    return {...body,hash:writerDigest(body)};
  }
  _bytes(file) {
    const s=canonical(file);
    if(s.length>this.limits.maxFileBytes)fail('WRITER_FILE_TOO_LARGE');
    const bytes=encodeUtf8(s);if(bytes.length>this.limits.maxFileBytes)fail('WRITER_FILE_TOO_LARGE');return bytes;
  }
  _read(id,kind,ref=null,optional=false) {
    if(!validId(id))fail('WRITER_REFERENCE_INVALID');
    // A throw is never absence. IO owns HTTP status and metadata classification.
    const bytes=this.io.readFile(id,this.limits.maxFileBytes);
    if(bytes===null){if(optional)return null;fail('WRITER_MISSING_REFERENCE');}
    if(!bytes || !integer(bytes.length) || bytes.length<1 || bytes.length>this.limits.maxFileBytes)fail('WRITER_FILE_INVALID');
    let file;try{file=JSON.parse(decodeUtf8(bytes));}catch(_){fail('WRITER_FILE_INVALID');}
    if(!file || Object.keys(file).sort().join(',')!=='hash,kind,payload,protocol,schemaVersion,storeId,writerScriptId' || file.protocol!==WRITER_PROTOCOL || file.kind!==kind || file.storeId!==this.storeId || file.writerScriptId!==this.writerScriptId || file.schemaVersion!==this.schemaVersion || !digestOk(file.hash))fail('WRITER_IDENTITY_INVALID');
    const {hash,...body}=file;
    if(writerDigest(body)!==hash || (ref && (ref.id!==id||ref.hash!==hash)))fail('WRITER_HASH_MISMATCH');
    if(canonical(file)!==decodeUtf8(bytes))fail('WRITER_NONCANONICAL_FILE');
    return {...file,id};
  }
  _createExact(id,kind,payload) {
    const file=this._sealed(kind,payload),bytes=this._bytes(file);
    let observed;
    for(let n=0;n<this.limits.maxCreateAttempts;n++) {
      try{this.io.createFile(id,bytes,kind);}catch(_){/* Same ID read decides; errors are never unconditional success. */}
      observed=this._read(id,kind,null,true);
      if(observed){if(observed.hash!==file.hash)fail('WRITER_IMMUTABLE_CONFLICT');if(kind==='index-node'){this._cache.set(observed.id+':'+observed.hash,observed);if(this._cache.size>this.limits.maxCachedNodes)this._cache.delete(this._cache.keys().next().value);}return pointer(observed);}
    }
    fail('WRITER_CREATE_UNRESOLVED',true);
  }
  _epochs(epochs) {
    if(!Array.isArray(epochs)||epochs.length<1||epochs.length>4||epochs.some(x=>!validId(x))||new Set(epochs).size!==epochs.length)fail('WRITER_EPOCHS_INVALID');return epochs.slice();
  }
  readBootstrap() {return this.readBootstrapInfo().payload;}
  readBootstrapInfo() {
    // Strictly read-only identity inspection for guarded owner repair/config.
    // recoveryBarrier() is not read-only: it may finish mandatory index links.
    this._guard();const anchor=this._read(this.anchorId,'bootstrap');this._checkAnchor(anchor);return {payload:clone(anchor.payload),hash:anchor.hash};
  }
  bootstrap({datasetGeneration='1',acceptedEpochs=['default'],firstSlotId,firstIndexId}={}) {
    this._guard();if(!validId(datasetGeneration))fail('WRITER_GENERATION_INVALID');this._epochs(acceptedEpochs);
    // Owner provisioning can pin the initial successors before ANY Drive create.
    // Supplying either ID requires the pair; retries never allocate replacements.
    const pinned=firstSlotId!==undefined||firstIndexId!==undefined;
    if(pinned&&(!validId(firstSlotId)||!validId(firstIndexId)||firstSlotId===firstIndexId||[firstSlotId,firstIndexId].some(x=>x===this.anchorId||x===this.checkpointHintId)))fail('WRITER_BOOTSTRAP_SLOTS_INVALID');
    let anchor=this._read(this.anchorId,'bootstrap',null,true);
    if(!anchor) {
      // An owner repair binds a pre-existing anchor, never authorizes replacing
      // its missing bytes with a newly shaped bootstrap or a fresh store.
      if(this.checkpointHintAnchorHash!==undefined)fail('WRITER_MISSING_REFERENCE');
      const payload={datasetGeneration,acceptedEpochs:this._epochs(acceptedEpochs),firstSlotId:pinned?firstSlotId:this._id(),firstIndexId:pinned?firstIndexId:this._id(),...(this.checkpointHintId?{checkpointHintId:this.checkpointHintId}:{})};
      // A concurrent same-store initialization may win with different generated
      // slots. Adopt its fixed anchor only after validating the requested identity.
      try{this.io.createFile(this.anchorId,this._bytes(this._sealed('bootstrap',payload)),'bootstrap');}catch(_){}
      anchor=this._read(this.anchorId,'bootstrap',null,true);if(!anchor)fail('WRITER_BOOTSTRAP_UNRESOLVED',true);
    }
    this._checkAnchor(anchor);
    if(anchor.payload.datasetGeneration!==datasetGeneration || !equal(anchor.payload.acceptedEpochs,acceptedEpochs)||(pinned&&(anchor.payload.firstSlotId!==firstSlotId||anchor.payload.firstIndexId!==firstIndexId)))fail('WRITER_BOOTSTRAP_MISMATCH');
    return this.recoveryBarrier();
  }
  _checkAnchor(a) {
    const p=a.payload;
    if(!p || !['acceptedEpochs,datasetGeneration,firstIndexId,firstSlotId','acceptedEpochs,checkpointHintId,datasetGeneration,firstIndexId,firstSlotId'].includes(Object.keys(p).sort().join(',')) || !validId(p.datasetGeneration)||!validId(p.firstSlotId)||!validId(p.firstIndexId)||p.firstSlotId===p.firstIndexId||[p.firstSlotId,p.firstIndexId].includes(this.anchorId))fail('WRITER_BOOTSTRAP_INVALID');
    if(own(p,'checkpointHintId')&&(!validId(p.checkpointHintId)||[this.anchorId,p.firstSlotId,p.firstIndexId,this.storeId,this.writerScriptId].includes(p.checkpointHintId)))fail('WRITER_BOOTSTRAP_INVALID');
    // Explicit guarded owner repair may bind a replacement advisory file to
    // these exact immutable anchor bytes. Without that binding the original
    // embedded pin remains mandatory. These are trusted server-config fields.
    if(this.checkpointHintAnchorHash!==undefined&&a.hash!==this.checkpointHintAnchorHash)fail('WRITER_BOOTSTRAP_MISMATCH');
    if(this.checkpointHintId!==undefined&&((this.checkpointHintAnchorHash===undefined&&p.checkpointHintId!==this.checkpointHintId)||[p.firstSlotId,p.firstIndexId].includes(this.checkpointHintId)))fail('WRITER_BOOTSTRAP_MISMATCH');
    this._epochs(p.acceptedEpochs);
  }
  _node(ref,tree,depth) {
    if(!refOk(ref)||!ref)fail('WRITER_INDEX_REFERENCE_INVALID');
    const key=ref.id+':'+ref.hash;
    let f=this._cache.get(key);if(!f){f=this._read(ref.id,'index-node',ref);this._cache.set(key,f);if(this._cache.size>this.limits.maxCachedNodes)this._cache.delete(this._cache.keys().next().value);}
    const p=f.payload;
    if(!p||p.tree!==tree||p.depth!==depth||!validId(p.slotId)||!['leaf','branch'].includes(p.type))fail('WRITER_INDEX_INVALID');
    if(p.type==='leaf') {
      if(Object.keys(p).sort().join(',')!=='depth,entries,slotId,tree,type'||!Array.isArray(p.entries)||p.entries.length<1||p.entries.length>this.limits.maxLeafEntries)fail('WRITER_INDEX_INVALID');
      let prev=null;for(const e of p.entries){if(!e||Object.keys(e).sort().join(',')!=='key,value'||typeof e.key!=='string'||(prev!==null&&e.key<=prev))fail('WRITER_INDEX_INVALID');prev=e.key;}
    } else {
      if(Object.keys(p).sort().join(',')!=='children,depth,slotId,tree,type'||!Array.isArray(p.children)||p.children.length<1||p.children.length>16||depth>=64)fail('WRITER_INDEX_INVALID');
      let prev='';for(const c of p.children){if(!c||Object.keys(c).sort().join(',')!=='digit,ref'||!/^[0-9a-f]$/.test(c.digit)||c.digit<=prev||!refOk(c.ref)||!c.ref)fail('WRITER_INDEX_INVALID');prev=c.digit;}
    }
    return p;
  }
  _lookup(root,tree,key) {
    let ref=root,depth=0;const h=writerDigest(key);
    while(ref){const p=this._node(ref,tree,depth);if(p.type==='leaf'){const found=p.entries.find(e=>e.key===key);return found?clone(found.value):null;}const digit=h[depth++],child=p.children.find(c=>c.digit===digit);ref=child?child.ref:null;}
    return null;
  }
  _put(root,tree,key,value,slotId,depth=0) {return this._putMany(root,tree,[{key,value}],slotId,depth);}
  // Build the final immutable copy-on-write subtree once for the whole frame.
  // Sequential _put calls leave intermediate roots unreachable; grouping keeps
  // the same transition verifier and durable frame boundary without that IO.
  _putMany(root,tree,updates,slotId,depth=0) {
    if(!updates.length)return root;
    if(depth>64)fail('WRITER_INDEX_DEPTH');
    const p=root?this._node(root,tree,depth):null;
    if(!p||p.type==='leaf') {
      const entries=new Map((p?p.entries:[]).map(e=>[e.key,clone(e)]));
      for(const {key,value} of updates)entries.set(key,{key,value});
      return this._writeEntries([...entries.values()].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0),tree,slotId,depth);
    }
    const children=new Map(p.children.map(c=>[c.digit,clone(c)])),groups=new Map();
    for(const update of updates){const digit=writerDigest(update.key)[depth];if(!groups.has(digit))groups.set(digit,[]);groups.get(digit).push(update);}
    for(const [digit,group] of groups)children.set(digit,{digit,ref:this._putMany(children.get(digit)?.ref||null,tree,group,slotId,depth+1)});
    return this._createExact(this._id(),'index-node',{tree,depth,type:'branch',children:[...children.values()].sort((a,b)=>a.digit<b.digit?-1:1),slotId});
  }
  _writeEntries(entries,tree,slotId,depth) {
    const payload={tree,depth,type:'leaf',entries,slotId};
    let fit=entries.length<=this.limits.maxLeafEntries;
    if(fit){try{this._bytes(this._sealed('index-node',payload));}catch(e){if(e.code!=='WRITER_FILE_TOO_LARGE')throw e;fit=false;}}
    if(fit)return this._createExact(this._id(),'index-node',payload);
    if(depth>=64)fail('WRITER_INDEX_COLLISION_LIMIT');
    const groups={};for(const entry of entries){const d=writerDigest(entry.key)[depth];if(!groups[d])groups[d]=[];groups[d].push(entry);}
    const children=Object.keys(groups).sort().map(digit=>({digit,ref:this._writeEntries(groups[digit],tree,slotId,depth+1)}));
    return this._createExact(this._id(),'index-node',{tree,depth,type:'branch',children,slotId});
  }
  // Verify copy-on-write transition without walking untouched subtrees. This
  // prevents a well-formed competing frame from dropping unrelated entities or
  // older receipts while still passing checks for its own changed keys.
  _verifyTree(oldRef,newRef,tree,updates,slotId,depth=0) {
    if(!updates.length){if(!equal(oldRef,newRef))fail('WRITER_INDEX_TRANSITION_INVALID');return;}
    if(!newRef)fail('WRITER_INDEX_TRANSITION_INVALID');
    const old=oldRef?this._node(oldRef,tree,depth):null,next=this._node(newRef,tree,depth);
    if(next.slotId!==slotId)fail('WRITER_INDEX_SLOT_INVALID');
    if(!old||old.type==='leaf') {
      const entries=old?old.entries.map(clone):[];
      for(const update of updates){const at=entries.findIndex(e=>e.key===update.key);if(at<0)entries.push(update);else entries[at]=update;}
      entries.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
      this._verifyEntries(newRef,tree,entries,slotId,depth);return;
    }
    if(next.type!=='branch')fail('WRITER_INDEX_TRANSITION_INVALID');
    const digits=new Set([...old.children.map(c=>c.digit),...next.children.map(c=>c.digit),...updates.map(e=>writerDigest(e.key)[depth])]);
    for(const digit of digits){const before=old.children.find(c=>c.digit===digit),after=next.children.find(c=>c.digit===digit);this._verifyTree(before?before.ref:null,after?after.ref:null,tree,updates.filter(e=>writerDigest(e.key)[depth]===digit),slotId,depth+1);}
  }
  _verifyEntries(ref,tree,entries,slotId,depth) {
    const p=this._node(ref,tree,depth);if(p.slotId!==slotId)fail('WRITER_INDEX_SLOT_INVALID');
    if(p.type==='leaf'){if(!equal(p.entries,entries))fail('WRITER_INDEX_TRANSITION_INVALID');return;}
    const groups={};for(const entry of entries){const digit=writerDigest(entry.key)[depth];if(!groups[digit])groups[digit]=[];groups[digit].push(entry);}
    if(!equal(Object.keys(groups).sort(),p.children.map(c=>c.digit)))fail('WRITER_INDEX_TRANSITION_INVALID');
    for(const child of p.children)this._verifyEntries(child.ref,tree,groups[child.digit],slotId,depth+1);
  }
  _validateEntity(entity,key) {
    if(!entity||Object.keys(entity).sort().join(',')!=='deleted,key,value,version'||entity.key!==key||!integer(entity.version)||entity.version<1||typeof entity.deleted!=='boolean'||(entity.deleted&&entity.value!==null))fail('WRITER_ENTITY_INVALID');
    return entity;
  }
  _get(root,key) {const entity=this._lookup(root,'entities',key);return entity===null?null:this._validateEntity(entity,key);}
  _assertReady(){this._guard();if(!this._state||this._recovering)fail('WRITER_RECOVERY_REQUIRED');}
  getEntity(key) {this._assertReady();this._key(key);return this._get(this._state.stateRoot,key);}
  get(key) {return this.getEntity(key);}
  _key(key) {if(typeof key!=='string'||key.length<1||encodeUtf8(key).length>512)fail('WRITER_KEY_INVALID');}
  _receipt(op,epoch) {
    const s=this._state,key=receiptKey(epoch,op);
    if(s.headReceipt && s.headReceipt.operationId===op&&s.headReceipt.epoch===epoch)return clone(s.headReceipt);
    return this._lookup(s.receiptRoot,'receipts',key);
  }
  getReceipt(operationId,epoch='default') {this._assertReady();if(!validId(operationId)||!validId(epoch))fail('WRITER_OPERATION_INVALID');return this._receipt(operationId,epoch);}
  _receiptFor(f) {
    const p=f.payload;
    return {operationId:p.operation.operationId,epoch:p.operation.epoch,digest:p.operation.digest,revision:p.revision,frameId:f.id,frameHash:f.hash,committedAt:p.committedAt,result:clone(p.result),entityVersions:p.changes.map(c=>({key:c.key,version:c.entity.version,deleted:c.entity.deleted}))};
  }
  _refs(refs,phase,frame) {
    if(!Array.isArray(refs)||refs.length>this.limits.maxReferences)fail('WRITER_REFERENCES_INVALID');
    if(refs.length && (typeof this.verifyReferences!=='function'||this.verifyReferences(clone(refs),{phase,slotId:frame.id,revision:frame.revision,changes:clone(frame.changes),getEntity:key=>this._get(this._state.stateRoot,key)})!==true))fail('WRITER_REFERENCES_UNVERIFIED');
  }
  _frame(f,phase) {
    const p=f.payload,s=this._state;
    if(!p||Object.keys(p).sort().join(',')!=='acceptedEpochs,changes,checkpoint,committedAt,datasetGeneration,nextSlotId,operation,parent,receiptRoot,references,result,revision,stateRoot'||p.datasetGeneration!==s.datasetGeneration||p.revision!==s.revision+1||!equal(p.parent,{id:s.headId,hash:s.headHash})||f.id!==s.nextSlotId||!validId(p.nextSlotId)||p.nextSlotId===f.id||p.nextSlotId===s.headId||!refOk(p.stateRoot)||!refOk(p.receiptRoot)||typeof p.committedAt!=='string'||!Number.isFinite(Date.parse(p.committedAt)))fail('WRITER_FRAME_INVALID');
    const op=p.operation;
    if(!op||Object.keys(op).sort().join(',')!=='digest,epoch,operationId'||!validId(op.operationId)||!validId(op.epoch)||!digestOk(op.digest)||!s.acceptedEpochs.includes(op.epoch)||this._receipt(op.operationId,op.epoch)!==null)fail('WRITER_FRAME_OPERATION_INVALID');
    this._epochs(p.acceptedEpochs);
    if(!Array.isArray(p.changes)||p.changes.length>this.limits.maxChanges)fail('WRITER_FRAME_CHANGES_INVALID');
    const keys=new Set();
    for(const c of p.changes){if(!c||Object.keys(c).sort().join(',')!=='entity,expectedVersion,key'||keys.has(c.key)||!integer(c.expectedVersion))fail('WRITER_FRAME_CHANGES_INVALID');this._key(c.key);keys.add(c.key);const prev=this._get(s.stateRoot,c.key),entity=this._validateEntity(c.entity,c.key);if((prev?prev.version:0)!==c.expectedVersion||entity.version!==c.expectedVersion+1||!equal(this._get(p.stateRoot,c.key),entity))fail('WRITER_FRAME_ENTITY_MISMATCH');}
    this._verifyTree(s.stateRoot,p.stateRoot,'entities',p.changes.map(c=>({key:c.key,value:c.entity})),f.id);
    // The prior head receipt is carried forward with its full verified hash.
    // The current receipt lives in THIS frame until the following commit.
    const receiptUpdates=s.headReceipt?[{key:receiptKey(s.headReceipt.epoch,s.headReceipt.operationId),value:s.headReceipt},{key:'@revision:'+s.revision,value:{revision:s.revision,hash:s.headHash}}]:[];
    this._verifyTree(s.receiptRoot,p.receiptRoot,'receipts',receiptUpdates,f.id);
    this._refs(p.references,phase,{id:f.id,revision:p.revision,changes:p.changes});
    if(p.checkpoint)this._publication(f);
    s.revision=p.revision;s.headId=f.id;s.headHash=f.hash;s.nextSlotId=p.nextSlotId;s.stateRoot=p.stateRoot;s.receiptRoot=p.receiptRoot;s.headReceipt=this._receiptFor(f);s.acceptedEpochs=p.acceptedEpochs.slice();s.replayFrames=p.checkpoint?1:s.replayFrames+1;
  }
  _checkCut(cut) {
    if(!cut||Object.keys(cut).sort().join(',')!=='hash,id,nextSlotId,revision'||!integer(cut.revision)||!validId(cut.id)||!digestOk(cut.hash)||!validId(cut.nextSlotId))fail('WRITER_CHECKPOINT_INVALID');
  }
  _indexPayload(p,id,previous,previousCut=-1) {
    if(!p||Object.keys(p).sort().join(',')!=='cut,manifestRef,nextIndexId,previousIndex,publishingFrame'||!refOk(p.manifestRef)||!p.manifestRef||!validId(p.nextIndexId)||p.nextIndexId===id||!refOk(p.previousIndex)||!equal(p.previousIndex,previous)||(p.previousIndex&&p.previousIndex.id===id)||!p.publishingFrame||Object.keys(p.publishingFrame).sort().join(',')!=='hash,id,revision'||!validId(p.publishingFrame.id)||!digestOk(p.publishingFrame.hash))fail('WRITER_CHECKPOINT_INDEX_INVALID');
    this._checkCut(p.cut);if(p.cut.revision<=previousCut||p.publishingFrame.revision!==p.cut.revision+1||p.publishingFrame.id!==p.cut.nextSlotId)fail('WRITER_CHECKPOINT_INDEX_INVALID');
  }
  _manifest(ref,cut) {
    const f=this._read(ref.id,'checkpoint-manifest',ref),p=f.payload;
    if(!p||Object.keys(p).sort().join(',')!=='acceptedEpochs,cut,datasetGeneration,receiptRoot,stateRoot'||p.datasetGeneration!==this._state.datasetGeneration||!equal(p.cut,cut)||!refOk(p.stateRoot)||!refOk(p.receiptRoot))fail('WRITER_CHECKPOINT_INVALID');
    this._epochs(p.acceptedEpochs);return p;
  }
  _publication(f) {
    const c=f.payload.checkpoint,s=this._state;
    if(!c||Object.keys(c).sort().join(',')!=='cut,indexId,manifestRef,nextIndexId,previousIndex'||!validId(c.indexId)||!validId(c.nextIndexId)||!refOk(c.manifestRef)||!c.manifestRef||!refOk(c.previousIndex))fail('WRITER_CHECKPOINT_INVALID');
    this._checkCut(c.cut);
    if(!equal(c.cut,{id:s.headId,hash:s.headHash,revision:s.revision,nextSlotId:s.nextSlotId}))fail('WRITER_CHECKPOINT_CUT_MISMATCH');
    const m=this._manifest(c.manifestRef,c.cut);
    if(!equal(m.stateRoot,s.stateRoot)||!equal(m.receiptRoot,f.payload.receiptRoot)||!equal(m.acceptedEpochs,s.acceptedEpochs))fail('WRITER_CHECKPOINT_STATE_MISMATCH');
    const link={previousIndex:c.previousIndex,nextIndexId:c.nextIndexId,manifestRef:c.manifestRef,cut:c.cut,publishingFrame:{id:f.id,hash:f.hash,revision:f.payload.revision}};
    this._indexPayload(link,c.indexId,c.previousIndex);
    if(s.indexHead?.id!==c.indexId)this._indexAdmission(s.indexLinks);
    const expected=this._sealed('checkpoint-index',link);
    // This is mandatory before applying any successor mutation or permitting GC.
    const existing=this._read(c.indexId,'checkpoint-index',null,true);
    if(existing&&existing.hash!==expected.hash)fail('WRITER_CHECKPOINT_BARRIER_INVALID');
    const ref=existing?pointer(existing):this._createExact(c.indexId,'checkpoint-index',link);
    if(ref.hash!==expected.hash)fail('WRITER_CHECKPOINT_BARRIER_INVALID');
    if(s.indexHead && s.indexHead.id===c.indexId){if(s.indexHead.hash!==ref.hash)fail('WRITER_CHECKPOINT_BARRIER_INVALID');}
    else {
      if(c.indexId!==s.nextIndexId||!equal(c.previousIndex,s.indexHead))fail('WRITER_CHECKPOINT_ORDER_INVALID');
      s.indexHead=ref;s.nextIndexId=c.nextIndexId;s.indexLinks++;
    }
    s.checkpoint={manifestRef:c.manifestRef,cut:c.cut,indexRef:ref};
    this._writeCheckpointHint(ref);
  }
  _indexAdmission(indexLinks) {
    if(!integer(indexLinks+1))fail('WRITER_INDEX_ORDINAL_OVERFLOW');
    if(!this.checkpointHintCodec&&indexLinks>=this.limits.maxIndexLinks)this._recoverySetupRequired();
  }
  _recoverySetupRequired() {
    const error=new Error('WRITER_RECOVERY_SETUP_REQUIRED');error.code=error.message;
    error.requiresOwnerAction=true;
    error.setup='Configure the owner HMAC signing key and a supported fixed-ID recovery hint. Keep the existing anchor, immutable INDEX chain, records and receipts; never reset the store or raise the history bound.';
    throw error;
  }
  recoveryBarrier(options={}) {
    if(this._recovering)fail('WRITER_RECOVERY_REENTRANT');
    this._recovering=true;this._persistFrameProgress=options.persistFrameProgress===true;this._frameProgress=null;this._frameProgressStart=0;
    try{return this._recover(options);}catch(error){
      if(this._frameProgress&&['STORE_YIELD','OWNER_BUDGET_YIELD','IMPORT_YIELD'].includes(error.code||error.message))Object.assign(error,{recoveryPhase:'frames',recoveredRevision:this._frameProgress.revision,cursorPersisted:true,cursorAdvanced:this._frameProgress.revision>this._frameProgressStart});
      this._state=null;this._cache.clear();this._verifiedPhase=null;throw error;
    }finally{this._recovering=false;this._persistFrameProgress=false;}
  }
  _hintPayload(ref,indexLinks=this._state.indexLinks,protocol=CHECKPOINT_HINT_PROTOCOL){const s=this._state;return {protocol,anchorId:this.anchorId,anchorHash:s.anchorHash,hintFileId:this.checkpointHintId,storeId:this.storeId,writerScriptId:this.writerScriptId,schemaVersion:this.schemaVersion,datasetGeneration:s.datasetGeneration,indexRef:ref,indexLinks};}
  _writeCheckpointHint(ref){
    if(!this.checkpointHintCodec||equal(this._hintRef,ref))return;
    try{this.io.writeCheckpointHint(this.checkpointHintCodec.encode(this._hintPayload(ref)));this._hintRef=clone(ref);}catch(_){/* Advisory only: the immutable commit and mandatory index already won. */}
  }
  _writeIndexScanHint(link,indexLinks){
    if(!this.checkpointHintCodec||!link)return false;
    try{this.io.writeCheckpointHint(this.checkpointHintCodec.encode(this._hintPayload(pointer(link),indexLinks,INDEX_SCAN_HINT_PROTOCOL)));this._hintRef=null;return true;}
    catch(_){/* Lost writes or delayed regressions can cost work, never records. */return false;}
  }
  _recoveryPending(link,indexLinks,scannedLinks){
    if(!this.checkpointHintCodec)this._recoverySetupRequired();
    const cursorPersisted=this._writeIndexScanHint(link,indexLinks);
    const error=new Error('WRITER_RECOVERY_PENDING');error.code=error.message;error.retryable=true;
    Object.assign(error,{indexLinks,scannedLinks,cursorPersisted});throw error;
  }
  _authenticatedHint(){
    if(!this.checkpointHintCodec)return null;
    let payload;
    try{const bytes=this.io.readCheckpointHint();if(bytes===null)return null;payload=this.checkpointHintCodec.decode(bytes);}catch(error){if(error?.message==='STORE_YIELD'||error?.message==='STORE_LOCK_REQUIRED')throw error;return null;}
    const s=this._state,base='anchorHash,anchorId,datasetGeneration,hintFileId,indexLinks,indexRef,protocol,schemaVersion,storeId,writerScriptId';
    if(!payload||payload.anchorId!==this.anchorId||payload.anchorHash!==s.anchorHash||payload.hintFileId!==this.checkpointHintId||payload.storeId!==this.storeId||payload.writerScriptId!==this.writerScriptId||payload.schemaVersion!==this.schemaVersion||payload.datasetGeneration!==s.datasetGeneration||!refOk(payload.indexRef)||!integer(payload.indexLinks))return null;
    if(payload.protocol===FRAME_SCAN_HINT_PROTOCOL){
      if(Object.keys(payload).sort().join(',')!==(base+',frameRef,frameRevision,replayFrames').split(',').sort().join(',')||!refOk(payload.frameRef)||!payload.frameRef||!integer(payload.frameRevision)||payload.frameRevision<1||!integer(payload.replayFrames)||payload.replayFrames<1||payload.replayFrames>this.limits.maxReplayFrames||(payload.indexRef===null)!==(payload.indexLinks===0))return null;
    }else if(![CHECKPOINT_HINT_PROTOCOL,INDEX_SCAN_HINT_PROTOCOL].includes(payload.protocol)||Object.keys(payload).sort().join(',')!==base||!payload.indexRef||payload.indexLinks<1)return null;
    return payload;
  }
  _writeFrameScanHint(){
    const s=this._state;
    if(!this._persistFrameProgress||!this.checkpointHintCodec||s.revision<1||this._frameProgress?.revision===s.revision)return false;
    const payload={...this._hintPayload(s.indexHead,s.indexLinks,FRAME_SCAN_HINT_PROTOCOL),frameRef:{id:s.headId,hash:s.headHash},frameRevision:s.revision,replayFrames:s.replayFrames};
    try{this.io.writeCheckpointHint(this.checkpointHintCodec.encode(payload));this._hintRef=null;this._frameProgress={revision:s.revision};return true;}
    catch(_){return false;} // Only confirmed progress is reported; advice never acknowledges a write.
  }
  _restoreFramePrefix(hint,last){
    if(hint?.protocol!==FRAME_SCAN_HINT_PROTOCOL||!equal(hint.indexRef,last?pointer(last):null)||hint.indexLinks!==this._state.indexLinks)return false;
    if(last){
      // Even an authenticated later prefix must retain the current checkpoint's
      // mandatory manifest/publication/INDEX proof. Do not overwrite the useful
      // frame cursor with older advice while checking that publication.
      this._hintRef=pointer(last);
      const witness=last.payload.publishingFrame;
      this._frame(this._read(witness.id,'frame',{id:witness.id,hash:witness.hash}),'recovery');
    }
    const f=this._read(hint.frameRef.id,'frame',hint.frameRef),p=f.payload,s=this._state;
    // The owner signature attests that this exact immutable frame AND all of
    // its transitions/references were already verified. Re-read/hash/identity
    // validation is mandatory; a missing signed witness never falls back.
    const cut=last?last.payload.cut.revision:0;
    if(!p||Object.keys(p).sort().join(',')!=='acceptedEpochs,changes,checkpoint,committedAt,datasetGeneration,nextSlotId,operation,parent,receiptRoot,references,result,revision,stateRoot'||p.datasetGeneration!==s.datasetGeneration||p.revision!==hint.frameRevision||p.revision<=cut||hint.replayFrames!==p.revision-cut||!validId(p.nextSlotId)||p.nextSlotId===f.id||!refOk(p.stateRoot)||!refOk(p.receiptRoot))fail('WRITER_FRAME_HINT_INVALID');
    this._epochs(p.acceptedEpochs);
    Object.assign(s,{revision:p.revision,headId:f.id,headHash:f.hash,nextSlotId:p.nextSlotId,stateRoot:p.stateRoot,receiptRoot:p.receiptRoot,headReceipt:this._receiptFor(f),acceptedEpochs:p.acceptedEpochs.slice(),replayFrames:hint.replayFrames});
    this._frameProgress={revision:p.revision};this._frameProgressStart=p.revision;this._hintRef=null;return true;
  }
  _restoreIndex(link,next,indexLinks){
    const p=link.payload,m=this._manifest(p.manifestRef,p.cut);
    Object.assign(this._state,{revision:p.cut.revision,headId:p.cut.id,headHash:p.cut.hash,nextSlotId:p.cut.nextSlotId,stateRoot:m.stateRoot,receiptRoot:m.receiptRoot,headReceipt:null,acceptedEpochs:m.acceptedEpochs.slice(),indexHead:pointer(link),nextIndexId:next,checkpoint:{manifestRef:p.manifestRef,cut:p.cut,indexRef:pointer(link)},replayFrames:0,indexLinks});
  }
  _recover({minimumAcknowledged}={}) {
    this._guard();const phase=typeof this.io.getVerifiedReadPhase==='function'?this.io.getVerifiedReadPhase():null;
    // Reuse only this continuously-held phase's already verified prefix. The
    // successor remains an uncached read, so delayed immutable creates are seen.
    if(phase&&this._state&&this._verifiedPhase===phase){
      const link=this._read(this._state.nextIndexId,'checkpoint-index',null,true);
      if(!link)return this._recoverTail(minimumAcknowledged);
    }
    this._verifiedPhase=null;this._state=null;this._cache.clear();this._hintRef=null;
    const anchor=this._read(this.anchorId,'bootstrap');this._checkAnchor(anchor);const a=anchor.payload;
    this._state={anchorHash:anchor.hash,datasetGeneration:a.datasetGeneration,revision:0,headId:anchor.id,headHash:anchor.hash,nextSlotId:a.firstSlotId,stateRoot:null,receiptRoot:null,headReceipt:null,acceptedEpochs:a.acceptedEpochs.slice(),indexHead:null,nextIndexId:a.firstIndexId,checkpoint:null,replayFrames:0,indexLinks:0};
    let next=a.firstIndexId,previous=null,last=null,previousCut=-1,count=0,scanned=0;const seen=new Set();
    const hint=this._authenticatedHint();
    if(hint?.indexRef){
      // INDEX-bearing hint protocols attest ONLY a verified immutable INDEX prefix. Do
      // not open its historical manifest/publication: those may be retired.
      // An authenticated referenced INDEX itself may never silently disappear.
      const link=this._read(hint.indexRef.id,'checkpoint-index',hint.indexRef),p=link.payload;
      this._indexPayload(p,link.id,p?.previousIndex);
      if((hint.indexLinks===1)!==(p.previousIndex===null)||(hint.indexLinks===1&&link.id!==a.firstIndexId)||hint.indexLinks>p.cut.revision+1)fail('WRITER_CHECKPOINT_INDEX_INVALID');
      if(hint.protocol===CHECKPOINT_HINT_PROTOCOL)this._hintRef=pointer(link);
      last=link;next=p.nextIndexId;previous=pointer(link);previousCut=p.cut.revision;count=hint.indexLinks;seen.add(link.id);
    }
    const scanLimit=this.checkpointHintCodec?Math.min(this.limits.maxIndexLinks,this.limits.maxIndexScanLinks):this.limits.maxIndexLinks;
    while(true){
      if(seen.has(next))fail('WRITER_INDEX_CYCLE');
      // scanLimit bounds new link discovery, with one final absent/present
      // boundary probe. The authenticated seed is one additional bounded read.
      // Publication verification rechecks the selected current INDEX separately.
      let link;
      try{link=this._read(next,'checkpoint-index',null,true);}
      catch(error){if(last&&scanned)this._writeIndexScanHint(last,count);throw error;}
      if(!link)break;
      if(scanned>=scanLimit)this._recoveryPending(last,count,scanned);
      seen.add(next);this._indexPayload(link.payload,next,previous,previousCut);
      if(!integer(count+1))fail('WRITER_INDEX_ORDINAL_OVERFLOW');
      count++;scanned++;last=link;previous=pointer(link);previousCut=link.payload.cut.revision;next=link.payload.nextIndexId;
      // Save the first link before a short/slow service budget can repeatedly
      // starve a whole 16-link interval; then checkpoint progress periodically.
      // The fixed file and constant-sized payload keep recovery memory bounded.
      if(scanned===1||scanned%16===0)this._writeIndexScanHint(last,count);
    }
    this._state.indexLinks=count;
    if(last)this._restoreIndex(last,next,count);
    this._restoreFramePrefix(hint,last);
    const result=this._recoverTail(minimumAcknowledged,last?last.payload.publishingFrame.revision:null);
    this._verifiedPhase=phase;return result;
  }

  _recoverTail(minimumAcknowledged,requiredPublicationRevision=null,replayed=0) {
    const s=this._state;let minSeen=minimumAcknowledged?this._minimumAtState(minimumAcknowledged):true;
    const frameSeen=new Set();
    while(true){if(frameSeen.has(s.nextSlotId))fail('WRITER_FRAME_CYCLE');frameSeen.add(s.nextSlotId);const f=this._read(s.nextSlotId,'frame',null,true);if(!f)break;if(replayed++>=this.limits.maxReplayFrames||s.replayFrames>=this.limits.maxReplayFrames)fail('WRITER_REPLAY_BUDGET');this._frame(f,'recovery');if(replayed===1||replayed%4===0)this._writeFrameScanHint();if(minimumAcknowledged&&this._minimumAtState(minimumAcknowledged))minSeen=true;}
    if(requiredPublicationRevision!==null&&s.revision<requiredPublicationRevision)fail('WRITER_MISSING_PUBLICATION_FRAME');
    if(minimumAcknowledged&&!minSeen){const r=minimumAcknowledged;const known=this._lookup(s.receiptRoot,'receipts','@revision:'+r.revision);if(!known||known.revision!==r.revision||known.hash!==r.hash)fail('WRITER_ACKNOWLEDGEMENT_UNPROVEN');}
    this._writeFrameScanHint();
    return this._statusSnapshot();
  }
  _minimumAtState(min) {
    if(!min||!integer(min.revision)||!digestOk(min.hash))fail('WRITER_ACKNOWLEDGEMENT_INVALID');
    if(min.revision===this._state.revision){if(min.hash!==this._state.headHash)fail('WRITER_ACKNOWLEDGEMENT_MISMATCH');return true;}return false;
  }
  // Diagnostic only: a signed verified prefix is not an available business state.
  recoveryProgress() {this._guard();return this._frameProgress?{recoveredRevision:this._frameProgress.revision,cursorPersisted:true,cursorAdvanced:this._frameProgress.revision>this._frameProgressStart}: {recoveredRevision:null,cursorPersisted:false,cursorAdvanced:false};}
  status() {this._assertReady();return this._statusSnapshot();}
  _statusSnapshot() {const s=this._state;return clone({storeId:this.storeId,datasetGeneration:s.datasetGeneration,revision:s.revision,headId:s.headId,headHash:s.headHash,nextSlotId:s.nextSlotId,checkpoint:s.checkpoint,stateRoot:s.stateRoot,receiptRoot:s.receiptRoot,headReceipt:s.headReceipt,acceptedEpochs:s.acceptedEpochs,indexHead:s.indexHead,nextIndexId:s.nextIndexId,indexLinks:s.indexLinks,replayFrames:s.replayFrames});}
  _command(command) {
    if(!command||!validId(command.operationId)||!validId(command.epoch||'default')||!digestOk(command.digest)||!Array.isArray(command.changes)||command.changes.length>this.limits.maxChanges)fail('WRITER_COMMAND_INVALID');
    const c=clone({...command,epoch:command.epoch||'default',result:command.result===undefined?null:command.result,references:command.references||[]});
    if(c.datasetGeneration!==undefined&&c.datasetGeneration!==this._state.datasetGeneration)fail('WRITER_GENERATION_MISMATCH');
    if(!Array.isArray(c.references)||c.references.length>this.limits.maxReferences)fail('WRITER_REFERENCES_INVALID');return c;
  }
  _checkReplay(c) {const prior=this._receipt(c.operationId,c.epoch);if(prior){if(prior.digest!==c.digest)fail('OP_ID_REUSED');return prior;}return null;}
  _changes(c) {
    const changes=[],keys=new Set();
    for(const change of c.changes){this._key(change.key);if(keys.has(change.key)||!integer(change.expectedVersion)||change.expectedVersion>=Number.MAX_SAFE_INTEGER||Object.keys(change).some(k=>!['key','expectedVersion','value','deleted','recreate'].includes(k)))fail('WRITER_CHANGE_INVALID');keys.add(change.key);
      const old=this._get(this._state.stateRoot,change.key);
      if((old?old.version:0)!==change.expectedVersion)fail('ENTITY_VERSION_CONFLICT');
      if(change.deleted!==undefined&&typeof change.deleted!=='boolean')fail('WRITER_CHANGE_INVALID');
      if(change.deleted&&(!old||old.deleted))fail('ENTITY_MISSING');
      if(!change.deleted&&old?.deleted&&change.recreate!==true)fail('ENTITY_TOMBSTONED');
      if(change.recreate!==undefined&&change.recreate!==true)fail('WRITER_CHANGE_INVALID');
      if(!change.deleted&&!own(change,'value'))fail('WRITER_CHANGE_INVALID');
      const value=change.deleted?null:clone(change.value);if(encodeUtf8(canonical(value)).length>this.limits.maxValueBytes)fail('WRITER_VALUE_TOO_LARGE');
      changes.push({key:change.key,expectedVersion:change.expectedVersion,entity:{key:change.key,version:change.expectedVersion+1,deleted:!!change.deleted,value}});
    }return changes;
  }
  _carryReceipts(slotId) {const s=this._state;if(!s.headReceipt)return s.receiptRoot;return this._putMany(s.receiptRoot,'receipts',[{key:receiptKey(s.headReceipt.epoch,s.headReceipt.operationId),value:s.headReceipt},{key:'@revision:'+s.revision,value:{revision:s.revision,hash:s.headHash}}],slotId);}
  _append(c,checkpoint=false,nextEpochs=null) {
    const s=this._state;if(!s.acceptedEpochs.includes(c.epoch))fail('OP_EXPIRED');
    if(checkpoint)this._indexAdmission(s.indexLinks);
    if(typeof this.validateMutation==='function'&&this.validateMutation(clone(c),{getEntity:key=>this._get(s.stateRoot,key),revision:s.revision,slotId:s.nextSlotId})!==true)fail('WRITER_DOMAIN_INVALID');
    const committedAt=this.clock();if(typeof committedAt!=='string'||!Number.isFinite(Date.parse(committedAt)))fail('WRITER_CLOCK_INVALID');
    const changes=this._changes(c),slotId=s.nextSlotId;
    // Reserve enough envelope space before creating any staged index nodes.
    if(encodeUtf8(canonical({changes,result:c.result,references:c.references})).length>this.limits.maxFileBytes-4096)fail('WRITER_FILE_TOO_LARGE');
    this._refs(c.references,'proposal',{id:slotId,revision:s.revision+1,changes});
    const stateRoot=this._putMany(s.stateRoot,'entities',changes.map(change=>({key:change.key,value:change.entity})),slotId);
    const receiptRoot=this._carryReceipts(slotId);
    let publication=null;
    if(checkpoint){if(changes.length)fail('WRITER_CHECKPOINT_CHANGES');const cut={id:s.headId,hash:s.headHash,revision:s.revision,nextSlotId:slotId};const manifestRef=this._createExact(this._id(),'checkpoint-manifest',{datasetGeneration:s.datasetGeneration,cut,stateRoot,receiptRoot,acceptedEpochs:s.acceptedEpochs});publication={indexId:s.nextIndexId,nextIndexId:this._id(),previousIndex:s.indexHead,manifestRef,cut};}
    const payload={datasetGeneration:s.datasetGeneration,revision:s.revision+1,parent:{id:s.headId,hash:s.headHash},nextSlotId:this._id(),operation:{operationId:c.operationId,epoch:c.epoch,digest:c.digest},committedAt,changes,stateRoot,receiptRoot,result:c.result,references:c.references,checkpoint:publication,acceptedEpochs:nextEpochs?this._epochs(nextEpochs):s.acceptedEpochs.slice()};
    const proposal=this._sealed('frame',payload),bytes=this._bytes(proposal);
    let winner=null;
    try {
    for(let attempt=0;attempt<this.limits.maxCreateAttempts;attempt++){try{this.io.createFile(slotId,bytes,'frame');}catch(_){}winner=this._read(slotId,'frame',null,true);if(winner)break;}
    if(!winner)fail('WRITER_COMMIT_UNRESOLVED',true);
    // A valid older, delayed proposal may win. Adopt its ORIGINAL receipt and
    // reserved successor, even when timestamps or generated IDs differ.
    this._frame(winner,'readback');
    const receipt=this._receipt(c.operationId,c.epoch);
    if(receipt){if(receipt.digest!==c.digest)fail('OP_ID_REUSED');return receipt;}
    return null;
    }catch(error){this._state=null;this._cache.clear();this._verifiedPhase=null;throw error;}
  }
  transact(command) {
    this.recoveryBarrier(command?.minimumAcknowledged?{minimumAcknowledged:command.minimumAcknowledged}:{});
    const c=this._command(command);
    for(let attempt=0;attempt<this.limits.maxContention;attempt++) {
      const prior=this._checkReplay(c);if(prior)return prior;
      if(!this._state.acceptedEpochs.includes(c.epoch))fail('OP_EXPIRED');
      if(this._state.replayFrames>=this.limits.checkpointEvery)this._automaticCheckpoint();
      const result=this._append(c);if(result)return result;
      // Winning competing operation has changed versions; reevaluate from the
      // immutable durable chain, never move our frozen proposal blindly forward.
      this.recoveryBarrier();
    }fail('WRITER_CONTENTION',true);
  }
  commit(command) {return this.transact(command);}
  _automaticCheckpoint() {
    const s=this._state,c={operationId:'checkpoint_'+s.revision+'_'+s.headHash.slice(0,16),epoch:s.acceptedEpochs[0],digest:writerDigest({kind:'checkpoint',headId:s.headId,headHash:s.headHash}),changes:[],references:[],result:{checkpoint:true}};
    if(!this._append(c,true))this.recoveryBarrier();
  }
  checkpoint(command) {
    this.recoveryBarrier();const c=this._command({...command,changes:[],references:[]});
    for(let i=0;i<this.limits.maxContention;i++){const prior=this._checkReplay(c);if(prior)return prior;const receipt=this._append(c,true);if(receipt)return receipt;this.recoveryBarrier();}fail('WRITER_CONTENTION',true);
  }
  /** Ordered epoch fence. No receipt deletion is implemented. A late old create
   * may win the current slot first; it is recovered before this fence retries.
   * Fences consume replay frames too, so they use the same checkpoint admission
   * as ordinary transactions rather than extending an unrecoverable tail. */
  advanceEpochs(command,acceptedEpochs) {
    this._epochs(acceptedEpochs);this.recoveryBarrier();const c=this._command({...command,changes:[],references:[]});
    for(let i=0;i<this.limits.maxContention;i++){
      const prior=this._checkReplay(c);if(prior)return prior;
      if(!this._state.acceptedEpochs.includes(c.epoch))fail('OP_EXPIRED');
      if(this._state.replayFrames>=this.limits.checkpointEvery)this._automaticCheckpoint();
      const receipt=this._append(c,false,acceptedEpochs);if(receipt)return receipt;this.recoveryBarrier();
    }fail('WRITER_CONTENTION',true);
  }
}

return {WRITER_PROTOCOL,WRITER_ROLES,writerDigest,ReservedSlotWriter};
})();
const m7 = (function(){
const {CHECKPOINT_HINT_MAX_BYTES} = m5;
// Server-internal Drive IO. No exported web handler or arbitrary-ID client route.
// Configuration contains fixed IDs only; all authoritative state is in Drive.
const fail=code=>{throw Error(code);};
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const MAX=2*1024*1024;
const FIELDS='id,parents,appProperties,size,trashed,mimeType,ownedByMe,shared';
const MIME='application/octet-stream';
const CACHE_DEFAULTS=Object.freeze({mode:'bytes',maxEntries:512,maxBytes:8*1024*1024});
const retry=(code,status)=>{const e=Error(code);e.retryable=true;if(status)e.status=status;throw e;};
class GasStoreIO {
 constructor({Drive,Utilities,UrlFetchApp,ScriptApp,lock,storeId,managedParentId,checkBudget,protocolReadCache=false,checkpointHintId}) {
  if(!Drive?.Files||typeof Drive.Files.create!=='function'||typeof Drive.Files.generateIds!=='function'||typeof Utilities?.newBlob!=='function'||typeof UrlFetchApp?.fetch!=='function'||typeof ScriptApp?.getOAuthToken!=='function'||typeof ScriptApp?.getScriptId!=='function'||typeof lock?.hasLock!=='function'||!id(storeId)||!id(managedParentId)||typeof checkBudget!=='function')fail('STORE_IO_CONFIG');
  if(checkpointHintId!==undefined&&(!id(checkpointHintId)||checkpointHintId===managedParentId||checkpointHintId===storeId))fail('STORE_HINT_CONFIG');
  Object.assign(this,{Drive,Utilities,UrlFetchApp,ScriptApp,lock,storeId,managedParentId,checkBudget,checkpointHintId});
  if(protocolReadCache!==false&&protocolReadCache!==true&&(!protocolReadCache||typeof protocolReadCache!=='object'||Array.isArray(protocolReadCache)))fail('STORE_CACHE_CONFIG');
  this._readCacheLimits=protocolReadCache===false?null:{...CACHE_DEFAULTS,...(protocolReadCache===true?{}:protocolReadCache)};
  const c=this._readCacheLimits;
  if(c&&(Object.keys(c).some(k=>!Object.prototype.hasOwnProperty.call(CACHE_DEFAULTS,k))||!['bytes','lock-phase'].includes(c.mode)||!Number.isSafeInteger(c.maxEntries)||c.maxEntries<1||c.maxEntries>1024||!Number.isSafeInteger(c.maxBytes)||c.maxBytes<1||c.maxBytes>8*1024*1024))fail('STORE_CACHE_CONFIG');
  this._readCache=new Map();this._readCacheBytes=0;this._readCacheActive=false;this._readPhaseToken=null;
 }
 // Only runtime-owned, continuously-held lock phases may enable this cache.
 // Immutable protocol bytes are still hash/schema-verified by the writer on
 // every read. Missing slots, parents, original sources and assets are excluded.
 // 'bytes' mode freshly validates metadata on every read. Explicit 'lock-phase'
 // mode trusts previously verified positive metadata only until lock release.
 beginReadPhase(){this.endReadPhase();if(this._readCacheLimits){this.assertLockHeld();this._readCacheActive=true;this._readPhaseToken={};}}
 endReadPhase(){this._readCache.clear();this._readCacheBytes=0;this._readCacheActive=false;this._readPhaseToken=null;}
 // An opaque token authorizes verified-prefix reuse only in full positive mode.
 getVerifiedReadPhase(){if(!this._readCacheActive||this._readCacheLimits.mode!=='lock-phase')return null;this.assertLockHeld();this._budget();return this._readPhaseToken;}
 _forget(fileId){const old=this._readCache.get(fileId);if(old){this._readCacheBytes-=old.bytes.length;this._readCache.delete(fileId);}}
 _cached(fileId,maxBytes){
  if(!this._readCacheActive)return null;
  this.assertLockHeld();this._budget();
  const hit=this._readCache.get(fileId);if(!hit)return null;
  if(hit.bytes.length>maxBytes)fail('STORE_SIZE_INVALID');
  this._readCache.delete(fileId);this._readCache.set(fileId,hit);return hit;
 }
 _remember(fileId,bytes,metadata){
  if(!this._readCacheActive||bytes.length>this._readCacheLimits.maxBytes)return;
  // Missing revision evidence must never compare equal as undefined/undefined.
  if(this._readCacheLimits.mode==='bytes'&&(typeof metadata.version!=='string'||!/^[1-9]\d{0,19}$/.test(metadata.version)||typeof metadata.md5Checksum!=='string'||!/^[0-9a-f]{32}$/.test(metadata.md5Checksum)))return;
  this._forget(fileId);
  while(this._readCache.size>=this._readCacheLimits.maxEntries||this._readCacheBytes+bytes.length>this._readCacheLimits.maxBytes)this._forget(this._readCache.keys().next().value);
  this.assertLockHeld();
  this._readCache.set(fileId,{bytes:Uint8Array.from(bytes),...(this._readCacheLimits.mode==='bytes'?{version:metadata.version,md5Checksum:metadata.md5Checksum}:{})});this._readCacheBytes+=bytes.length;
 }
 getScriptId(){return this.ScriptApp.getScriptId();}
 assertLockHeld(){if(this.lock.hasLock()!==true){this.endReadPhase();fail('STORE_LOCK_REQUIRED');}return true;}
 _budget(){if(this.checkBudget('store-io')!==true)retry('STORE_YIELD');}
 _fetch(fileId,suffix,headers={}) {
  this.assertLockHeld();this._budget();if(!id(fileId))fail('STORE_ID_INVALID');
  let r;try{const token=this.ScriptApp.getOAuthToken();if(typeof token!=='string'||!token)fail('STORE_AUTH');r=this.UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(fileId)+suffix,{method:'get',headers:{Authorization:'Bearer '+token,...headers},muteHttpExceptions:true,followRedirects:false});}catch(e){retry('STORE_READ_UNRESOLVED');}
  if(!r||typeof r.getResponseCode!=='function')fail('STORE_RESPONSE_INVALID');return r;
 }
 _metadata(fileId){const r=this._fetch(fileId,'?fields='+encodeURIComponent(FIELDS+(this._readCacheLimits?.mode==='bytes'?',version,md5Checksum':'')));const status=r.getResponseCode();if(status===404)return null;if(status!==200)retry('STORE_METADATA_UNRESOLVED',status);let m;try{const t=r.getContentText();if(typeof t!=='string'||t.length>16384)fail('STORE_METADATA_INVALID');m=JSON.parse(t);if(!m||typeof m!=='object'||Array.isArray(m))fail('STORE_METADATA_INVALID');}catch(e){fail('STORE_METADATA_INVALID');}return m;}
 _parent(){const m=this._metadata(this.managedParentId);if(!m||m.id!==this.managedParentId||m.mimeType!=='application/vnd.google-apps.folder'||m.trashed!==false||m.ownedByMe!==true||m.shared!==false)fail('STORE_PARENT_NOT_PRIVATE');}
 allocateIds(n){this.assertLockHeld();this._budget();if(!Number.isSafeInteger(n)||n<1||n>1000)fail('STORE_ID_COUNT');let r;try{r=this.Drive.Files.generateIds({count:n,space:'drive',type:'files'});}catch(e){retry('STORE_IDS_UNRESOLVED');}if(!r||!Array.isArray(r.ids)||r.ids.length!==n||r.ids.some(x=>!id(x))||new Set(r.ids).size!==n)fail('STORE_IDS_INVALID');return r.ids;}
 readFile(fileId,maxBytes=MAX){
  if(fileId===this.checkpointHintId)fail('STORE_HINT_ROLE_REQUIRED');
  return this._readFile(fileId,maxBytes);
 }
 _readFile(fileId,maxBytes=MAX,hint=false){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX)fail('STORE_READ_BOUND');
  const hit=hint?null:this._cached(fileId,maxBytes);if(hit&&this._readCacheLimits.mode==='lock-phase')return Uint8Array.from(hit.bytes);
  const m=this._metadata(fileId);if(m===null){this._forget(fileId);return null;}
  if(m.id!==fileId||m.trashed!==false||m.ownedByMe!==true||m.shared!==false||m.mimeType!==MIME||!Array.isArray(m.parents)||m.parents.length!==1||m.parents[0]!==this.managedParentId||m.appProperties?.['mypace.store']!==this.storeId)fail('STORE_METADATA_MISMATCH');
  if(hint&&m.appProperties?.['mypace.role']!=='checkpoint-hint')fail('STORE_HINT_ROLE_MISMATCH');
  if(!/^\d+$/.test(String(m.size)))fail('STORE_SIZE_INVALID');const n=Number(m.size);if(!Number.isSafeInteger(n)||n<1||n>maxBytes)fail('STORE_SIZE_INVALID');
  if(hit&&hit.bytes.length===n&&hit.version===m.version&&hit.md5Checksum===m.md5Checksum)return Uint8Array.from(hit.bytes);
  this._forget(fileId);
  const r=this._fetch(fileId,'?alt=media',{Range:'bytes=0-'+(n-1),'Accept-Encoding':'identity'});if(r.getResponseCode()!==206)retry('STORE_RANGE_STATUS',r.getResponseCode());
  const h=r.getAllHeaders();if(!h||typeof h!=='object'||Array.isArray(h))fail('STORE_HEADERS_INVALID');
  const header=name=>{const keys=Object.keys(h).filter(k=>k.toLowerCase()===name);if(!keys.length)return null;if(keys.length!==1||!['string','number'].includes(typeof h[keys[0]]))fail('STORE_HEADERS_INVALID');return String(h[keys[0]]).trim();};
  if(header('content-range')!==`bytes 0-${n-1}/${n}`)fail('STORE_RANGE_INVALID');const length=header('content-length'),encoding=header('content-encoding');if((length!==null&&length!==String(n))||(encoding!==null&&encoding.toLowerCase()!=='identity'))fail('STORE_HEADERS_INVALID');
  const raw=r.getContent();if(!raw||raw.length!==n)fail('STORE_BYTES_INVALID');const b=new Uint8Array(n);for(let i=0;i<n;i++){if(!Number.isInteger(raw[i])||raw[i]<-128||raw[i]>255)fail('STORE_BYTES_INVALID');b[i]=raw[i]&255;}if(!hint)this._remember(fileId,b,m);return b;
 }
 // The only mutable IO surface has NO ID argument. It is bound to an optional
 // bootstrap pin, never accepts metadata/parent/role from callers, and is never
 // cached as immutable protocol data. Failure is safe: recovery uses the anchor.
 readCheckpointHint(){
  this.assertLockHeld();if(!this.checkpointHintId)return null;this._parent();
  return this._readFile(this.checkpointHintId,CHECKPOINT_HINT_MAX_BYTES,true);
 }
 writeCheckpointHint(bytes){
  this.assertLockHeld();this._budget();
  if(!this.checkpointHintId||!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>CHECKPOINT_HINT_MAX_BYTES)fail('STORE_HINT_WRITE_INVALID');
  this._parent();const fileId=this.checkpointHintId,m=this._metadata(fileId);
  if(m&&(m.id!==fileId||m.trashed!==false||m.ownedByMe!==true||m.shared!==false||m.mimeType!==MIME||!Array.isArray(m.parents)||m.parents.length!==1||m.parents[0]!==this.managedParentId||m.appProperties?.['mypace.store']!==this.storeId||m.appProperties?.['mypace.role']!=='checkpoint-hint'))fail('STORE_HINT_METADATA_MISMATCH');
  const name='mypace-checkpoint-hint-'+fileId,blob=this.Utilities.newBlob(Array.from(bytes,n=>n>127?n-256:n),MIME,name);
  this.assertLockHeld();this._budget();
  // One attempt only. Response loss never allocates a new ID or retries a stale
  // payload; a late update may regress this hint and successors repair recovery.
  let result;
  if(m){if(typeof this.Drive.Files.update!=='function')fail('STORE_HINT_UPDATE_UNAVAILABLE');result=this.Drive.Files.update({},fileId,blob,{fields:'id'});}
  else result=this.Drive.Files.create({id:fileId,name,mimeType:MIME,parents:[this.managedParentId],appProperties:{'mypace.store':this.storeId,'mypace.role':'checkpoint-hint'}},blob,{fields:'id',ignoreDefaultVisibility:true});
  if(!result||result.id!==fileId)fail('STORE_HINT_WRITE_UNRESOLVED');
  return true;
 }
 createFile(fileId,bytes,role){
  this.assertLockHeld();this._budget();if(fileId===this.checkpointHintId||role==='checkpoint-hint')fail('STORE_HINT_ROLE_REQUIRED');if(!id(fileId)||typeof role!=='string'||! /^[a-z][a-z0-9-]{0,63}$/.test(role)||!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>MAX)fail('STORE_CREATE_INVALID');
  this._forget(fileId);this._parent();const metadata={id:fileId,name:'mypace-'+role+'-'+fileId,mimeType:MIME,parents:[this.managedParentId],appProperties:{'mypace.store':this.storeId,'mypace.role':role}};
  const blob=this.Utilities.newBlob(Array.from(bytes,n=>n>127?n-256:n),MIME,metadata.name);
  // Caller MUST read this same ID after any result, including timeout or 409.
  // No new-ID fallback or authoritative object updates exist in this adapter.
  this.assertLockHeld();this._budget();const result=this.Drive.Files.create(metadata,blob,{fields:'id',ignoreDefaultVisibility:true});if(!result||result.id!==fileId)fail('STORE_CREATE_ID_MISMATCH');return result;
 }
}

return {GasStoreIO};
})();
const m8 = (function(){
// GAS V8-compatible import domain binding. Drive persistence is supplied only by
// the reserved-slot writer. Every public method must run under its ONE script lock;
// ImportCheckpointCoordinator supplies that lock for its two bounded phases.
// No original source is mutated, no job list/snapshot grows in a single entity.
const {encodeUtf8, decodeUtf8, IncrementalSha256} = m1;
const {initialCheckpoint, checkpointBytes, checkpointPointLimit, mappingHash, LIMITS} = m2;
const {PARSER_VERSION, sourceKey} = m0;
const {validateSourceIdentity, SOURCE_FOLDER_ID} = m3;
const {hashAssetBytes} = m4;

const IMPORT_STORE_LIMITS=Object.freeze({entityBytes:65536,scanPageBytes:65536,scanFiles:100,assets:66});
const fail=code=>{throw Error(code);};
const check=(ok,code)=>{if(!ok)fail(code);};
const token=(s,max=128)=>typeof s==='string'&&s.length>0&&s.length<=max&&/^[A-Za-z0-9_-]+$/.test(s);
const clone=x=>JSON.parse(JSON.stringify(x));
const canonical=(x,depth=0)=>{
 check(depth<=40,'IMPORT_VALUE_DEPTH');
 if(x===null||typeof x==='string'||typeof x==='boolean')return JSON.stringify(x);
 if(typeof x==='number'&&Number.isFinite(x))return JSON.stringify(x);
 if(Array.isArray(x))return '['+x.map(v=>canonical(v,depth+1)).join(',')+']';
 check(x&&Object.getPrototypeOf(x)===Object.prototype,'IMPORT_VALUE_INVALID');
 return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k],depth+1)).join(',')+'}';
};
const same=(a,b)=>canonical(a)===canonical(b);
const digest=x=>hashAssetBytes(encodeUtf8(canonical(x)));
const roleLimit=role=>role==='checkpoint'?LIMITS.checkpoint:['output','manifest-page'].includes(role)?LIMITS.output:0;
const scalar=(x,min=0)=>Number.isSafeInteger(x)&&x>=min;
// A failed storage read is not evidence that a reservation is unauthorized.
// Preserve transient/recovery control flow so the caller can retry safely.
const reservationLookupFailure=error=>{
 const code=error?.code||error?.message||'';
 if(error?.retryable===true||error?.requiresOwnerAction===true||typeof code==='string'&&(code.endsWith('_YIELD')||code.startsWith('WRITER_RECOVERY_')||['WRITER_REPLAY_BUDGET','WRITER_LOCK_REQUIRED','STORE_LOCK_REQUIRED','WRITER_BUSY'].includes(code)))throw error;
 return false;
};
const timeOrder=(a,b)=>{const seconds=a.slice(0,19).localeCompare(b.slice(0,19));if(seconds)return seconds;const fa=a.slice(19,-1).replace(/^\./,''),fb=b.slice(19,-1).replace(/^\./,''),n=Math.max(fa.length,fb.length);return fa.padEnd(n,'0').localeCompare(fb.padEnd(n,'0'));};
const validTime=t=>typeof t==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(t)&&Number.isFinite(Date.parse(t))&&new Date(Date.parse(t)).toISOString().slice(0,19)===t.slice(0,19);
const outputPoint=line=>{let p;try{p=JSON.parse(line);}catch(_){fail('OUTPUT_POINT_INVALID');}
 check(p&&Object.getPrototypeOf(p)===Object.prototype&&Object.keys(p).every(k=>['time','lat','lon','altitude','speed'].includes(k))&&validTime(p.time)&&typeof p.lat==='number'&&Number.isFinite(p.lat)&&p.lat>=-90&&p.lat<=90&&typeof p.lon==='number'&&Number.isFinite(p.lon)&&p.lon>=-180&&p.lon<=180,'OUTPUT_POINT_INVALID');
 if('altitude' in p)check(typeof p.altitude==='number'&&Number.isFinite(p.altitude)&&p.altitude>=-20000&&p.altitude<=100000,'OUTPUT_POINT_INVALID');
 if('speed' in p)check(p.speed===null||typeof p.speed==='number'&&Number.isFinite(p.speed)&&p.speed>=0&&p.speed<=10000,'OUTPUT_POINT_INVALID');return p;
};
const ref=r=>r?{fileId:r.fileId,sha256:r.sha256,byteLength:r.byteLength}:null;
const safeSource=s=>clone(validateSourceIdentity(s));
const SIMPLE_HEADER=['time','latitude','longitude','altitude','speed'];
const SENSOR_HEADER=['time','gFx','gFy','gFz','ax','ay','az','wx','wy','wz','P(Pa)','Bx(µT)','By(µT)','Bz(µT)','latitude','longitude','altitude','speed','yaw','pitch','roll'];
const cpCounters=cp=>({offset:cp.offset,batch:cp.batch,points:cp.points,normalizedBytes:cp.normalizedBytes,rows:cp.rows,comments:cp.comments,nonIncreasingTimes:cp.nonIncreasingTimes,firstTime:cp.firstTime,lastTime:cp.lastTime,complete:cp.complete});
const importKeys=Object.freeze({
 job:id=>'import/job/'+id,
 pin:id=>'import/pin/'+id,
 asset:id=>'import/asset/'+digest(id),
 directory:()=> 'import/jobs',
 source:id=>'import/source/'+digest(id),
 identity:key=>'import/identity/'+digest(key),
 content:key=>'import/content/'+digest(key),
 scan:id=>'import/scan/'+id,
 scanPage:(id,n)=>'import/scan-page/'+id+'/'+n,
 run:id=>'run/'+id
});

/**
 * readAsset(reservation) is a server-internal bounded managed asset reader. It
 * must verify private parent/ownership/markers before returning immutable bytes.
 * This binding independently checks byte length and SHA-256. Never pass a public
 * arbitrary-ID media endpoint. validateSourceCurrent must re-read Drive metadata.
 * GC must treat active job.pinActive + linked pin records as roots; a completed
 * run.imported.assetsRoot is the same linked root transferred atomically. Pin
 * entities remain immutable-reference history until coordinated GC retires them.
 */
class ImportStoreBinding {
 constructor({writer,storeId,readAsset,validateSourceCurrent}) {
  check(writer&&['get','transact','getReceipt','recoveryBarrier'].every(k=>typeof writer[k]==='function')&&token(storeId,100)&&typeof readAsset==='function'&&typeof validateSourceCurrent==='function','IMPORT_STORE_CONFIG');
  this.writer=writer;this.storeId=storeId;this.readAsset=readAsset;this.validateSourceCurrent=validateSourceCurrent;
 }
 recoveryBarrier(){return this.writer.recoveryBarrier();}
 getReceipt(id){return this.writer.getReceipt(id);}
 _entity(key){const e=this.writer.get(key);check(!e?.deleted,'IMPORT_TOMBSTONE');return e;}
 _required(key){const e=this._entity(key);check(e,'IMPORT_ENTITY_MISSING');return e;}
 _change(key,value){check(encodeUtf8(canonical(value)).length<=IMPORT_STORE_LIMITS.entityBytes,'IMPORT_ENTITY_TOO_LARGE');return {key,expectedVersion:this._entity(key)?.version||0,value:clone(value)};}
 _job(id){check(token(id,100),'JOB_ID_INVALID');const e=this._required(importKeys.job(id));check(e.value.storeId===this.storeId&&e.value.jobId===id,'JOB_STORE_MISMATCH');return e;}
 _intent(kind,input){check(token(input?.operationId),'OPERATION_ID_INVALID');const clean=clone(input);return {operationId:input.operationId,epoch:'default',digest:digest({protocol:'mypace-import-domain-v1',storeId:this.storeId,kind,input:clean})};}
 _prior(intent){this.recoveryBarrier();const r=this.getReceipt(intent.operationId);if(r)check(r.digest===intent.digest,'OP_ID_REUSED');return r;}
 _commit(intent,changes,result){const r=this.writer.transact({...intent,changes,result});this.recoveryBarrier();return r;}
 _read(r){
  check(r&&roleLimit(r.role)&&r.storeId===this.storeId,'ASSET_DESCRIPTOR_INVALID');
  const raw=this.readAsset(clone(r));check(raw instanceof Uint8Array&&raw.length===r.byteLength&&raw.length<=roleLimit(r.role)&&hashAssetBytes(raw)===r.sha256,'ASSET_CONTENT_MISMATCH');return raw;
 }
 _json(r){const bytes=this._read(r);let v;try{v=JSON.parse(decodeUtf8(bytes));}catch(_){fail('IMPORT_ASSET_JSON');}return v;}
 _assets(assets,jobId,pinId){
  check(Array.isArray(assets)&&assets.length>=2&&assets.length<=IMPORT_STORE_LIMITS.assets,'IMPORT_BATCH_BOUNDS');
  const ids=new Set();let outputs=0,bytes=0,cps=0,manifests=0;
  const out=assets.map(a=>{
   check(a&&token(a.fileId)&&a.storeId===this.storeId&&a.jobId===jobId&&a.pinId===pinId&&roleLimit(a.role)&&scalar(a.byteLength,1)&&a.byteLength<=roleLimit(a.role)&&/^[a-f0-9]{64}$/.test(a.sha256)&&!ids.has(a.fileId),'RESERVATION_INVALID');
   ids.add(a.fileId);if(a.role==='output'){outputs++;bytes+=a.byteLength;}if(a.role==='checkpoint')cps++;if(a.role==='manifest-page')manifests++;
   return {fileId:a.fileId,storeId:a.storeId,jobId:a.jobId,pinId:a.pinId,role:a.role,byteLength:a.byteLength,sha256:a.sha256};
  });
  check(cps===1&&manifests===1&&outputs<=LIMITS.outputs&&bytes<=LIMITS.totalOutput,'IMPORT_BATCH_BOUNDS');return out;
 }
 _checkpoint(job){
  const cp=job.checkpoint?this._json(job.checkpoint):initialCheckpoint(job.sourceIdentity,{packingVersion:job.packingVersion??0});
  this._checkpointShape(cp,job);
  check(same(cpCounters(cp),job.progress)&&same(cp.previousManifest,ref(job.manifest)),'CHECKPOINT_STATE_MISMATCH');return cp;
 }
 _checkpointShape(cp,job){
  checkpointBytes(cp);
  check(job.packingVersion===undefined||job.packingVersion===1,'CHECKPOINT_PACKING');
  check(cp&&typeof cp==='object'&&!Array.isArray(cp),'CHECKPOINT_SOURCE_MISMATCH');
  checkpointPointLimit(cp);
  check((cp.packingVersion??0)===(job.packingVersion??0),'CHECKPOINT_PACKING_CHANGED');
  check(cp&&cp.schema===1&&cp.parserVersion===PARSER_VERSION&&cp.mappingHash===mappingHash()&&same(cp.source,job.sourceIdentity)&&cp.sourceKey===job.sourceKey,'CHECKPOINT_SOURCE_MISMATCH');
  for(const k of ['offset','batch','points','normalizedBytes','rows','comments','nonIncreasingTimes'])check(scalar(cp[k]),'CHECKPOINT_COUNTER');
  check(typeof cp.complete==='boolean'&&cp.offset<=Number(job.sourceIdentity.size)&&cp.sourceHash?.totalBytes===cp.offset&&cp.normalizedHash?.totalBytes===cp.normalizedBytes,'CHECKPOINT_HASH_OFFSET');
  // Constructor validates SHA compression state and bounded remainder.
  const sh=new IncrementalSha256(cp.sourceHash),nh=new IncrementalSha256(cp.normalizedHash);
  check(cp.offset===0||cp.parser!==null,'PARSER_STATE_REQUIRED');
  if(cp.parser){const p=cp.parser;check(['start','plain','quoted','closed'].includes(p.mode)&&Array.isArray(p.field)&&p.field.length<=65536&&p.field.every(b=>Number.isInteger(b)&&b>=0&&b<=255)&&Array.isArray(p.row)&&p.row.length<=128&&p.row.every(v=>typeof v==='string'&&encodeUtf8(v).length<=65536)&&scalar(p.bytes)&&p.bytes<=262144&&scalar(p.offset)&&typeof p.cr==='boolean'&&typeof p.first==='boolean'&&(p.prefix===null||Array.isArray(p.prefix)&&p.prefix.length<3&&p.prefix.every((b,i)=>b===[239,187,191][i]))&&p.offset+(p.prefix?.length||0)===cp.offset,'PARSER_STATE_INVALID');}
  check(cp.header===null||Array.isArray(cp.header)&&cp.header.length<=128&&cp.header.every(x=>typeof x==='string'&&x.length<=128)&&new Set(cp.header).size===cp.header.length&&['time','latitude','longitude'].every(x=>cp.header.includes(x))&&(cp.header.every(x=>SIMPLE_HEADER.includes(x))||cp.header.length===SENSOR_HEADER.length&&SENSOR_HEADER.every(x=>cp.header.includes(x))),'CHECKPOINT_HEADER');
  check(typeof cp.sawPreamble==='boolean'&&cp.sawPreamble===(cp.comments>0)&&(cp.header===null||cp.sawPreamble)&&cp.rows===cp.points+cp.comments+(cp.header===null?0:1)&&cp.nonIncreasingTimes<=Math.max(0,cp.points-1),'CHECKPOINT_ROW_INVARIANTS');
  check(cp.points===0?cp.firstTime===null&&cp.lastTime===null&&cp.normalizedBytes===0:validTime(cp.firstTime)&&validTime(cp.lastTime),'CHECKPOINT_TIMES');
  if(cp.complete)check(cp.header!==null&&cp.sawPreamble&&cp.parser?.mode==='start'&&cp.parser.field.length===0&&cp.parser.row.length===0&&cp.parser.bytes===0&&cp.offset===Number(job.sourceIdentity.size)&&cp.points>0&&cp.sourceSha256===sh.digestHex()&&cp.normalizedSha256===nh.digestHex(),'CHECKPOINT_COMPLETION');
  else check(cp.offset<Number(job.sourceIdentity.size),'CHECKPOINT_COMPLETION');
 }
 _transition(job,assets,cp,manifest){
  this._checkpointShape(cp,job);
  const old=this._checkpoint(job),c=assets.find(a=>a.role==='checkpoint'),m=assets.find(a=>a.role==='manifest-page'),outs=assets.filter(a=>a.role==='output');
  check(checkpointBytes(cp).length===c.byteLength&&hashAssetBytes(checkpointBytes(cp))===c.sha256,'CHECKPOINT_DESCRIPTOR_MISMATCH');
  const mb=encodeUtf8(JSON.stringify(manifest));check(mb.length===m.byteLength&&hashAssetBytes(mb)===m.sha256,'MANIFEST_DESCRIPTOR_MISMATCH');
  check(manifest&&manifest.schema===1&&manifest.kind==='import-manifest-page'&&manifest.sourceKey===job.sourceKey&&manifest.throughOffset===cp.offset&&same(manifest.previous,ref(job.manifest))&&same(cp.previousManifest,ref(m)),'MANIFEST_LINK_MISMATCH');
  check(cp.offset>old.offset&&cp.offset-old.offset<=LIMITS.range&&!old.complete,'CHECKPOINT_NOT_NEXT');
  check((old.header===null||same(old.header,cp.header)&&cp.comments===old.comments)&&(!old.sawPreamble||cp.sawPreamble),'CHECKPOINT_MAPPING_CHANGED');
  check(Array.isArray(manifest.outputs)&&manifest.outputs.length===outs.length,'MANIFEST_OUTPUTS_MISMATCH');
  let points=0,bytes=0;
  manifest.outputs.forEach((o,i)=>{const a=outs[i];check(o&&o.fileId===a.fileId&&o.sha256===a.sha256&&o.byteLength===a.byteLength&&o.index===old.batch+i&&scalar(o.pointCount,1)&&o.pointCount<=checkpointPointLimit(cp)&&same(Object.keys(o).sort(),['byteLength','fileId','index','pointCount','sha256'].sort()),'MANIFEST_OUTPUTS_MISMATCH');points+=o.pointCount;bytes+=o.byteLength;});
  check(cp.batch===old.batch+outs.length&&cp.points===old.points+points&&cp.normalizedBytes===old.normalizedBytes+bytes&&cp.rows>=old.rows&&cp.comments>=old.comments&&cp.nonIncreasingTimes>=old.nonIncreasingTimes&&(old.firstTime===null||cp.firstTime===old.firstTime),'CHECKPOINT_DELTA_MISMATCH');
  if(!outs.length)check(same(cp.normalizedHash,old.normalizedHash)&&cp.lastTime===old.lastTime,'CHECKPOINT_EMPTY_OUTPUT');
  return {checkpoint:c,manifest:m,progress:cpCounters(cp)};
 }
 registerJob(input){
  const intent=this._intent('register-job',input),prior=this._prior(intent);if(prior)return prior;
  const {jobId}=input;check(token(jobId,100),'JOB_ID_INVALID');const source=safeSource(input.sourceIdentity);check(Number(source.size)>0,'SOURCE_EMPTY');
  const key=sourceKey(source,mappingHash()),ik=importKeys.identity(key),existing=this._entity(ik),sk=importKeys.source(source.id),si=this._entity(sk)?.value;
  if(existing){const priorJob=this._job(existing.value.jobId).value;
   // Every known identity must still be this source's active generation. A
   // historical completed OR duplicate A must not suppress A -> B -> A.
   const current=si?.activeJobId===priorJob.jobId;
   let known=current&&!['cancelled','completed','duplicate'].includes(priorJob.status);
   if(current&&priorJob.status==='completed'){
    const imported=this._entity(importKeys.run(si.runId))?.value.imported;
    known=si.publishedSourceKey===key&&imported?.jobId===priorJob.jobId&&imported?.sourceKey===key;
   }
   if(current&&priorJob.status==='duplicate'&&priorJob.publishedContentKey&&priorJob.duplicateRunId){
    const target=this._entity(importKeys.run(priorJob.duplicateRunId))?.value.imported;
    known=!!(target&&target.parserVersion===PARSER_VERSION&&target.mappingHash===mappingHash()&&priorJob.publishedContentKey===JSON.stringify([target.sourceSha256,target.sourceIdentity?.size,PARSER_VERSION,mappingHash()]));
   }
   // Missing legacy duplicate evidence is re-parsed/reverified through the
   // normal content claim before any new run can become visible.
   if(known)return this._commit(intent,[],{jobId:existing.value.jobId,status:'known'});
  }
  check(!this._entity(importKeys.job(jobId)),'JOB_ID_REUSED');
  if(si?.activeJobId){const active=this._job(si.activeJobId).value;check(['completed','cancelled','duplicate'].includes(active.status),'SOURCE_JOB_ACTIVE');}
  if(si)check(si.mappingHash===mappingHash(),'REPROCESS_REQUIRES_APPROVAL');
  const runId=si?.runId||'drive_'+digest(source.id).slice(0,32),run=this._entity(importKeys.run(runId));
  const cp=initialCheckpoint(source);
  const directory=this._entity(importKeys.directory())?.value||{head:null,count:0};
  const job={schema:1,queueNext:directory.head,storeId:this.storeId,jobId,sourceIdentity:source,sourceKey:key,packingVersion:cp.packingVersion,parserVersion:PARSER_VERSION,mappingHash:mappingHash(),status:'active',pinActive:true,runId,baseImportedDigest:run?digest(run.value.imported??null):null,checkpoint:null,manifest:null,progress:cpCounters(cp),pending:null,firstPin:null,lastPin:null,batchCount:0,finalization:null};
  const changes=[this._change(importKeys.job(jobId),job),this._change(ik,{jobId}),this._change(sk,{sourceId:source.id,mappingHash:mappingHash(),runId,activeJobId:jobId,publishedSourceKey:si?.publishedSourceKey||null}),this._change(importKeys.directory(),{head:jobId,count:directory.count+1})];
  return this._commit(intent,changes,{jobId,status:'active'});
 }
 reserveBatch(input){
  const intent=this._intent('reserve-batch',input),prior=this._prior(intent);if(prior)return prior;
  const {jobId,pinId,batchOperationId,expectedCheckpointId,checkpoint,manifestPage}=input;
  check(token(pinId,100)&&token(batchOperationId),'RESERVATION_INVALID');const job=clone(this._job(jobId).value);
  check(job.status==='active'&&job.pinActive&&!job.pending,'JOB_NOT_RESERVABLE');check((job.checkpoint?.fileId||null)===expectedCheckpointId,'CHECKPOINT_CONFLICT');
  check(!this._entity(importKeys.pin(pinId)),'PIN_ID_REUSED');const assets=this._assets(input.assets,jobId,pinId),transition=this._transition(job,assets,checkpoint,manifestPage);
  const pending={schema:1,storeId:this.storeId,jobId,pinId,batchOperationId,expectedCheckpointId,assets,state:'reserved',previousPin:job.lastPin,nextPin:null,transition};
  job.pending=pinId;
  const changes=[this._change(importKeys.job(jobId),job),this._change(importKeys.pin(pinId),pending)];
  for(const a of assets){check(!this._entity(importKeys.asset(a.fileId)),'ASSET_ID_REUSED');changes.push(this._change(importKeys.asset(a.fileId),{jobId,pinId,fileId:a.fileId}));}
  return this._commit(intent,changes,{jobId,pinId,batchOperationId});
 }
 assertReservation(r){
  try{const job=this._job(r.jobId).value,pin=this._required(importKeys.pin(r.pinId)).value;return job.pinActive===true&&pin.storeId===this.storeId&&pin.jobId===job.jobId&&['reserved','ready'].includes(pin.state)&&pin.assets.some(a=>same(a,r));}catch(error){return reservationLookupFailure(error);}
 }
 assertReadableAsset(fileId,expectedLength,maxBytes){
  try{const index=this._required(importKeys.asset(fileId)).value,pin=this._required(importKeys.pin(index.pinId)).value,job=this._job(index.jobId).value;
   const r=pin.assets.find(a=>a.fileId===fileId);if(!r||r.byteLength!==expectedLength||expectedLength>maxBytes||pin.jobId!==job.jobId||pin.storeId!==this.storeId)return false;
   if(job.pinActive)return ['reserved','ready'].includes(pin.state);
   return job.status==='completed'&&pin.state==='ready'&&this._entity(importKeys.run(job.runId))?.value.imported?.jobId===job.jobId;
  }catch(error){return reservationLookupFailure(error);}
 }
 listJobsPage({cursor=null,limit=16}={}){
  check(cursor===null||token(cursor,100),'JOB_CURSOR_INVALID');check(scalar(limit,1)&&limit<=100,'JOB_PAGE_BOUNDS');
  let id=cursor||this._entity(importKeys.directory())?.value.head||null;const jobs=[];
  while(id&&jobs.length<limit){const job=this._job(id).value;jobs.push({jobId:id,status:job.status,pinActive:job.pinActive,progress:clone(job.progress)});id=job.queueNext;}
  return {jobs,nextCursor:id};
 }
 getJob(jobId){this.recoveryBarrier();return clone(this._job(jobId).value);}
 resumeJob(jobId){
  this.recoveryBarrier();const job=clone(this._job(jobId).value);return {job,checkpoint:this._checkpoint(job),pending:job.pending?clone(this._required(importKeys.pin(job.pending)).value):null};
 }
 validateImportBatch(command,{checkpoint,manifestPage}){
  check(command?.protocol==='mypace-import-batch-v1'&&command.storeId===this.storeId&&token(command.operationId),'IMPORT_COMMAND_INVALID');
  const {digest:given,...base}=command;check(given===digest(base),'IMPORT_COMMAND_DIGEST');
  const job=this._job(command.jobId).value;check(job.pinActive&&job.status==='active'&&job.pending,'JOB_NOT_ACTIVE');
  const pin=this._required(importKeys.pin(job.pending)).value;
  check(pin.state==='reserved'&&pin.batchOperationId===command.operationId&&pin.jobId===job.jobId&&pin.storeId===this.storeId&&same(command.sourceIdentity,job.sourceIdentity)&&(job.checkpoint?.fileId||null)===command.expectedCheckpointId&&pin.expectedCheckpointId===command.expectedCheckpointId,'JOB_RESERVATION_OR_VERSION_INVALID');
  const assets=this._assets(command.assets,job.jobId,pin.pinId);check(same(assets,pin.assets)&&assets.every(a=>this.assertReservation(a)),'JOB_RESERVATION_OR_VERSION_INVALID');
  const transition=this._transition(job,assets,checkpoint,manifestPage);check(same(transition,pin.transition)&&command.completed===checkpoint.complete,'JOB_RESERVATION_OR_VERSION_INVALID');return true;
 }
 commitImportBatch(command,{verifiedAssets}){
  this.recoveryBarrier();const prior=this.getReceipt(command.operationId);if(prior){check(prior.digest===command.digest,'OP_ID_REUSED');return prior;}
  const job=clone(this._job(command.jobId).value),pin=clone(this._required(importKeys.pin(job.pending)).value);
  check(Array.isArray(verifiedAssets)&&verifiedAssets.length===pin.assets.length&&verifiedAssets.every((v,i)=>v.verified===true&&same(Object.fromEntries(Object.entries(v).filter(([k])=>k!=='verified')),pin.assets[i])),'ASSETS_NOT_VERIFIED');
  // A caller-created verified:true cannot authorize commit: managed readback is
  // rechecked here and the actual checkpoint/manifest are revalidated under lock.
  const contents={};for(const a of pin.assets){const bytes=this._read(a);if(a.role!=='output')contents[a.role==='checkpoint'?'checkpoint':'manifestPage']=JSON.parse(decodeUtf8(bytes));}
  this.validateImportBatch(command,contents);check(this.validateSourceCurrent(job.sourceIdentity)===true,'SOURCE_CHANGED');
  pin.state='ready';job.checkpoint=pin.transition.checkpoint;job.manifest=pin.transition.manifest;job.progress=pin.transition.progress;job.pending=null;job.firstPin=job.firstPin||pin.pinId;job.lastPin=pin.pinId;job.batchCount++;if(command.completed)job.status='parsed';
  const changes=[this._change(importKeys.pin(pin.pinId),pin),this._change(importKeys.job(job.jobId),job)];
  if(pin.previousPin){const prev=clone(this._required(importKeys.pin(pin.previousPin)).value);check(prev.state==='ready'&&prev.nextPin===null&&prev.jobId===job.jobId,'PIN_CHAIN_CONFLICT');prev.nextPin=pin.pinId;changes.push(this._change(importKeys.pin(prev.pinId),prev));}
  return this._commit({operationId:command.operationId,epoch:'default',digest:command.digest},changes,{jobId:job.jobId,checkpointId:job.checkpoint.fileId,completed:command.completed});
 }
 beginFinalization(input){
  const intent=this._intent('begin-finalization',input),prior=this._prior(intent);if(prior)return prior;
  const job=clone(this._job(input.jobId).value);check(job.status==='parsed'&&job.pinActive&&!job.pending&&job.firstPin,'JOB_NOT_PARSED');this._checkpoint(job);
  job.status='verifying';job.finalization={cursor:job.firstPin,previousPin:null,previousManifest:null,visited:0,nextOutputIndex:0,points:0,bytes:0,throughOffset:0,firstTime:null,lastTime:null,nonIncreasingTimes:0,hash:new IncrementalSha256().snapshot()};
  return this._commit(intent,[this._change(importKeys.job(job.jobId),job)],{jobId:job.jobId,cursor:job.firstPin});
 }
 verifyNextBatch(input){
  const intent=this._intent('verify-next-batch',input),prior=this._prior(intent);if(prior)return prior;
  const job=clone(this._job(input.jobId).value),f=job.finalization;
  check(job.status==='verifying'&&job.pinActive&&f&&f.cursor===input.expectedCursor&&f.cursor!==null&&f.visited<job.batchCount,'FINALIZATION_CURSOR_CONFLICT');
  this._verifyOneFinalizationBatch(job);
  return this._commit(intent,[this._change(importKeys.job(job.jobId),job)],{jobId:job.jobId,cursor:f.cursor,verified:job.status==='verified'});
 }
 _verifyOneFinalizationBatch(job){
  const f=job.finalization;
  const pin=this._required(importKeys.pin(f.cursor)).value;
  check(pin.state==='ready'&&pin.jobId===job.jobId&&pin.previousPin===f.previousPin,'PIN_CHAIN_CONFLICT');
  const manifest=this._json(pin.transition.manifest),cp=this._json(pin.transition.checkpoint);this._checkpointShape(cp,job);
  check(manifest.schema===1&&manifest.kind==='import-manifest-page'&&manifest.sourceKey===job.sourceKey&&same(manifest.previous,f.previousManifest)&&manifest.throughOffset===cp.offset&&cp.offset>f.throughOffset&&cp.offset-f.throughOffset<=LIMITS.range&&same(cp.previousManifest,ref(pin.transition.manifest)),'MANIFEST_LINK_MISMATCH');
  const outs=pin.assets.filter(a=>a.role==='output');check(manifest.outputs.length===outs.length,'MANIFEST_OUTPUTS_MISMATCH');
  const hash=new IncrementalSha256(f.hash);
  manifest.outputs.forEach((o,i)=>{const a=outs[i];check(o.fileId===a.fileId&&o.sha256===a.sha256&&o.byteLength===a.byteLength&&o.index===f.nextOutputIndex&&scalar(o.pointCount,1)&&o.pointCount<=checkpointPointLimit(cp),'MANIFEST_OUTPUTS_MISMATCH');const bytes=this._read(a),text=decodeUtf8(bytes),lines=text.split('\n');check(text.endsWith('\n')&&lines.length-1===o.pointCount,'OUTPUT_POINT_COUNT');lines.pop();for(const line of lines){const point=outputPoint(line);if(f.firstTime===null)f.firstTime=point.time;if(f.lastTime!==null&&timeOrder(point.time,f.lastTime)<=0)f.nonIncreasingTimes++;f.lastTime=point.time;}hash.update(bytes);f.points+=o.pointCount;f.bytes+=bytes.length;f.nextOutputIndex++;});
  check(f.firstTime===cp.firstTime&&f.lastTime===cp.lastTime&&f.nonIncreasingTimes===cp.nonIncreasingTimes,'FINALIZATION_SUMMARY_MISMATCH');
  check(f.points===cp.points&&f.bytes===cp.normalizedBytes&&f.nextOutputIndex===cp.batch&&hash.digestHex()===new IncrementalSha256(cp.normalizedHash).digestHex(),'FINALIZATION_HASH_OR_COUNT');
  f.hash=hash.snapshot();f.previousPin=pin.pinId;f.previousManifest=ref(pin.transition.manifest);f.throughOffset=cp.offset;f.cursor=pin.nextPin;f.visited++;
  if(f.cursor===null){const final=this._checkpoint(job);check(f.visited===job.batchCount&&pin.pinId===job.lastPin&&same(f.previousManifest,ref(job.manifest))&&f.throughOffset===Number(job.sourceIdentity.size)&&f.points===final.points&&f.bytes===final.normalizedBytes&&hash.digestHex()===final.normalizedSha256,'FINALIZATION_INCOMPLETE');job.status='verified';}
 }
 // Reverify at most four pinned source ranges after a crash. No intermediate
 // run is published, and each asset remains bounded and independently checked.
 verifyNextBatches(input){
  const maxBatches=input.maxBatches??4;check(Number.isSafeInteger(maxBatches)&&maxBatches>=1&&maxBatches<=4,'FINALIZATION_BATCH_LIMIT');
  const intent=this._intent('verify-next-batches',input),prior=this._prior(intent);if(prior)return prior;
  const job=clone(this._job(input.jobId).value),f=job.finalization;
  check(job.status==='verifying'&&job.pinActive&&f&&f.cursor===input.expectedCursor&&f.cursor!==null&&f.visited<job.batchCount,'FINALIZATION_CURSOR_CONFLICT');
  let checked=0;while(job.status==='verifying'&&checked<maxBatches){this._verifyOneFinalizationBatch(job);checked++;}
  return this._commit(intent,[this._change(importKeys.job(job.jobId),job)],{jobId:job.jobId,cursor:f.cursor,verified:job.status==='verified',checked});
 }
 publishCompletedJob(input){
  const intent=this._intent('publish-job',input),prior=this._prior(intent);if(prior)return prior;
  const job=clone(this._job(input.jobId).value);check(['verified','duplicate'].includes(job.status)&&job.pinActive&&!job.pending&&job.finalization?.cursor===null,'JOB_NOT_VERIFIED');
  const cp=this._checkpoint(job);check(this.validateSourceCurrent(job.sourceIdentity)===true,'SOURCE_CHANGED');
  const contentKey=JSON.stringify([cp.sourceSha256,job.sourceIdentity.size,PARSER_VERSION,mappingHash()]),ck=importKeys.content(contentKey),existing=this._entity(ck)?.value;
  const claimedRun=existing?this.writer.get(importKeys.run(existing.runId)):null,claimed=claimedRun&&!claimedRun.deleted?claimedRun.value.imported:null;
  const liveDuplicate=claimed&&claimed.sourceSha256===cp.sourceSha256&&claimed.sourceIdentity?.size===job.sourceIdentity.size&&claimed.parserVersion===PARSER_VERSION&&claimed.mappingHash===mappingHash();
  if(existing&&existing.runId!==job.runId&&liveDuplicate){job.status='duplicate';job.duplicateRunId=existing.runId;job.publishedContentKey=contentKey;return this._commit(intent,[this._change(importKeys.job(job.jobId),job)],{jobId:job.jobId,status:'duplicate',duplicateRunId:existing.runId});}
  const rk=importKeys.run(job.runId),run=this._entity(rk);check((run?digest(run.value.imported??null):null)===job.baseImportedDigest,'OWNER_IMPORT_CONFLICT');
  const sk=importKeys.source(job.sourceIdentity.id),source=this._required(sk).value;check(source.activeJobId===job.jobId,'SOURCE_JOB_CONFLICT');
  const imported={schema:1,jobId:job.jobId,sourceKey:job.sourceKey,sourceIdentity:job.sourceIdentity,originalManaged:false,parserVersion:PARSER_VERSION,mappingHash:mappingHash(),sourceSha256:cp.sourceSha256,normalizedSha256:cp.normalizedSha256,sampleCount:cp.points,normalizedBytes:cp.normalizedBytes,firstTime:cp.firstTime,lastTime:cp.lastTime,nonIncreasingTimes:cp.nonIncreasingTimes,manifest:ref(job.manifest),assetsRoot:job.firstPin,checkpoint:ref(job.checkpoint),statistics:'samples-only-no-distance'};
  const value=run?{...clone(run.value),imported}:{id:job.runId,source:'drive-import',imported,owner:{}};
  job.status='completed';job.pinActive=false;job.publishedContentKey=contentKey;delete job.duplicateRunId;
  const changes=[this._change(rk,value),this._change(importKeys.job(job.jobId),job),this._change(ck,{runId:job.runId,jobId:job.jobId,sourceSha256:cp.sourceSha256}),this._change(sk,{...source,publishedSourceKey:job.sourceKey})];
  // Transfer the same linked asset root to the run in this exact frame. No
  // intermediate unpin exists, and owner-only fields are copied from latest run.
  return this._commit(intent,changes,{jobId:job.jobId,status:'completed',runId:job.runId});
 }
 cancelJob(input){
  const intent=this._intent('cancel-job',input),prior=this._prior(intent);if(prior)return prior;
  const job=clone(this._job(input.jobId).value);check(job.pinActive&&job.status!=='completed','JOB_NOT_CANCELLABLE');
  // The ordered writer frame fences every earlier command before unpin. GC still
  // needs its own retained-root/quarantine protocol; cancellation does not delete.
  job.status='cancelled';job.pinActive=false;return this._commit(intent,[this._change(importKeys.job(job.jobId),job)],{jobId:job.jobId,status:'cancelled'});
 }
 beginScan(input){
  const intent=this._intent('begin-scan',input),prior=this._prior(intent);if(prior)return prior;check(token(input.scanId,100),'SCAN_ID_INVALID');const key=importKeys.scan(input.scanId);check(!this._entity(key),'SCAN_ID_REUSED');
  const state={schema:1,scanId:input.scanId,folderId:SOURCE_FOLDER_ID,pageToken:null,nextPage:0,pendingPage:null,pendingIndex:0,done:false,restarts:0};
  return this._commit(intent,[this._change(key,state)],state);
 }
 getScan(scanId){check(token(scanId,100),'SCAN_ID_INVALID');return clone(this._required(importKeys.scan(scanId)).value);}
 recordScanPage(input){
  const intent=this._intent('record-scan-page',input),prior=this._prior(intent);if(prior)return prior;
  const state=this.getScan(input.scanId);check(!state.done&&state.pendingPage===null&&state.pageToken===input.expectedPageToken&&state.nextPage===input.expectedPage,'SCAN_CURSOR_CONFLICT');
  check(Array.isArray(input.files)&&input.files.length<=IMPORT_STORE_LIMITS.scanFiles,'SCAN_PAGE_BOUNDS');
  const validToken=t=>t===null||typeof t==='string'&&t.length>0&&t.length<=4096&&!/[\0\r\n]/.test(t);
  check(validToken(input.nextPageToken)&&(input.nextPageToken===null||input.nextPageToken!==state.pageToken),'SCAN_TOKEN_INVALID');
  const page={schema:1,scanId:input.scanId,page:state.nextPage,files:input.files.map(safeSource),nextPageToken:input.nextPageToken};
  check(encodeUtf8(canonical(page)).length<=IMPORT_STORE_LIMITS.scanPageBytes,'SCAN_PAGE_BOUNDS');
  state.pendingPage=state.nextPage++;state.pendingIndex=0;state.pageToken=input.nextPageToken;
  if(page.files.length===0){state.pendingPage=null;state.done=input.nextPageToken===null;}
  return this._commit(intent,[this._change(importKeys.scanPage(input.scanId,page.page),page),this._change(importKeys.scan(input.scanId),state)],{scanId:input.scanId,page:page.page,done:state.done});
 }
 nextScanEntry(scanId){const state=this.getScan(scanId);if(state.pendingPage===null)return null;const page=this._required(importKeys.scanPage(scanId,state.pendingPage)).value;return {page:state.pendingPage,index:state.pendingIndex,sourceIdentity:clone(page.files[state.pendingIndex])};}
 acknowledgeScanEntry(input){
  const intent=this._intent('acknowledge-scan-entry',input),prior=this._prior(intent);if(prior)return prior;
  const state=this.getScan(input.scanId);check(state.pendingPage===input.expectedPage&&state.pendingIndex===input.expectedIndex,'SCAN_CURSOR_CONFLICT');
  const page=this._required(importKeys.scanPage(input.scanId,state.pendingPage)).value,source=page.files[state.pendingIndex];
  // A page position can advance only once its exact content identity has a
  // durable job. A crash between registration and acknowledgement is deduped.
  check(this._entity(importKeys.identity(sourceKey(source,mappingHash()))),'SCAN_JOB_NOT_DURABLE');
  state.pendingIndex++;if(state.pendingIndex===page.files.length){state.pendingPage=null;state.pendingIndex=0;state.done=state.pageToken===null;}
  return this._commit(intent,[this._change(importKeys.scan(input.scanId),state)],{scanId:input.scanId,done:state.done});
 }
 restartScan(input){
  const intent=this._intent('restart-scan',input),prior=this._prior(intent);if(prior)return prior;const state=this.getScan(input.scanId);check(state.pendingPage===null&&!state.done&&state.pageToken===input.expectedPageToken&&state.nextPage===input.expectedPage,'SCAN_CURSOR_CONFLICT');state.pageToken=null;state.restarts++;
  return this._commit(intent,[this._change(importKeys.scan(input.scanId),state)],{scanId:input.scanId,page:state.nextPage});
 }
}

return {IMPORT_STORE_LIMITS,importKeys,ImportStoreBinding};
})();
const m9 = (function(){
// Bounded server-internal orchestration. The caller provides one script-lock
// helper shared by writer, reservations and coordinator. No timer is installed.
const {prepareRange,buildStagedPayloads,LIMITS} = m2;
const {decodeUtf8,encodeUtf8} = m1;
const {hashAssetBytes} = m4;
const fail=code=>{throw Error(code);};
const operation=(jobId,stage,marker)=>'imp_'+hashAssetBytes(encodeUtf8(JSON.stringify([jobId,stage,marker])));
class ImportRunner {
 constructor({store,coordinator,source,allocateIds,locked,checkBudget,rangeBytes=LIMITS.range,finalizationBatchLimit=4,maxFreshOutputs=64}){
  if(!store||!coordinator||typeof source?.readRange!=='function'||typeof allocateIds!=='function'||typeof locked!=='function'||typeof checkBudget!=='function')fail('RUNNER_CONFIG');
  if(!Number.isSafeInteger(rangeBytes)||rangeBytes<1||rangeBytes>LIMITS.range)fail('RUNNER_RANGE_CONFIG');
  if(!Number.isSafeInteger(finalizationBatchLimit)||finalizationBatchLimit<1||finalizationBatchLimit>4)fail('RUNNER_FINALIZATION_CONFIG');
  if(!Number.isSafeInteger(maxFreshOutputs)||maxFreshOutputs<1||maxFreshOutputs>64)fail('RUNNER_OUTPUT_CONFIG');
  Object.assign(this,{store,coordinator,source,allocateIds,locked,checkBudget,rangeBytes,finalizationBatchLimit,maxFreshOutputs});
 }
 _budget(){if(this.checkBudget('import-runner')!==true){const e=Error('IMPORT_YIELD');e.retryable=true;throw e;}}
 // One bounded source range and one durable checkpoint per invocation. No full
 // source or full route array is materialized. Retry identities derive from the
 // committed checkpoint, and pending IDs survive termination in Drive state.
 stepJob(jobId,{deadlineMs}={}){
  this._budget();const resumed=this.locked(()=>{const current=this.store.getJob(jobId);if(current&&['completed','duplicate','cancelled'].includes(current.status))return {terminal:current};return this.store.resumeJob(jobId);});
  if(resumed.terminal)return {jobId,status:resumed.terminal.status};
  const cp=resumed.checkpoint,job=resumed.job;
  if(!cp||!job)fail('RUNNER_JOB_INVALID');
  if(cp.complete)return {status:'parsed',jobId,checkpoint:cp.previousManifest};
  const expectedCheckpointId=resumed.pending?.expectedCheckpointId ?? job.checkpoint?.fileId ?? null;
  // A resumed reservation fixes its original range even if a later trusted
  // scheduler chooses smaller cooperative chunks for fresh work.
  const length=resumed.pending?resumed.pending.transition.progress.offset-cp.offset:Math.min(this.rangeBytes,Number(cp.source.size)-cp.offset);
  if(!Number.isSafeInteger(length)||length<1||length>LIMITS.range||length>Number(cp.source.size)-cp.offset)fail('RUNNER_PENDING_RANGE');
  let bytes=this.source.readRange(cp.source,cp.offset,length,{deadlineMs});
  this._budget();let prepared=prepareRange(cp,bytes);
  // Only fresh work may shrink its committed prefix. Preparation is pure and
  // always restarts from the original checkpoint; the downloaded suffix is
  // re-read next time. A pending reservation fixes every original byte/ID.
  if(!resumed.pending)while(prepared.outputs.length>this.maxFreshOutputs){
   this._budget();if(bytes.length<=1)fail('RUNNER_OUTPUT_BOUNDS');
   bytes=bytes.slice(0,Math.floor(bytes.length/2));prepared=prepareRange(cp,bytes);
  }
  let pending=resumed.pending,ids;
  if(pending){
   const outputIds=pending.assets.filter(a=>a.role==='output').map(a=>a.fileId);
   const manifest=pending.assets.find(a=>a.role==='manifest-page');const checkpoint=pending.assets.find(a=>a.role==='checkpoint');
   if(!manifest||!checkpoint||outputIds.length!==prepared.outputs.length)fail('RUNNER_PENDING_MISMATCH');
   ids={outputIds,manifestId:manifest.fileId,checkpointId:checkpoint.fileId};
  }else{
   ids=this.locked(()=>{const all=this.allocateIds(prepared.outputs.length+2);return {outputIds:all.slice(0,-2),manifestId:all[all.length-2],checkpointId:all[all.length-1]};});
  }
  const payload=buildStagedPayloads(prepared,ids);
  const marker=expectedCheckpointId||'initial';
  const batchOperationId=pending?.batchOperationId||operation(jobId,'batch',marker);
  const pinId=pending?.pinId||operation(jobId,'pin',marker);
  const assets=payload.assets.map(a=>({reservation:{fileId:a.fileId,role:a.role,sha256:a.sha256,byteLength:a.byteLength,storeId:this.store.storeId,jobId,pinId},bytes:a.bytes}));
  if(!pending){
   const manifestPage=JSON.parse(decodeUtf8(payload.assets.find(a=>a.role==='manifest-page').bytes));
   this.locked(()=>this.store.reserveBatch({operationId:operation(jobId,'reserve',marker),jobId,pinId,batchOperationId,expectedCheckpointId,assets:assets.map(a=>a.reservation),checkpoint:payload.checkpoint,manifestPage}));
  }
  this._budget();const receipt=this.coordinator.commitPreparedBatch({operationId:batchOperationId,jobId,expectedCheckpointId,sourceIdentity:cp.source,completed:payload.checkpoint.complete,assets,reuseExisting:!!resumed.pending});
  return {status:payload.checkpoint.complete?'parsed':'checkpointed',jobId,offset:payload.checkpoint.offset,size:Number(cp.source.size),receipt};
 }
 // A separate bounded finalization step verifies up to four pinned batches.
 // A parsed checkpoint alone never makes a run visible.
 finalizeJobStep(jobId){
  this._budget();return this.locked(()=>{
   const job=this.store.getJob(jobId);
   if(['completed','duplicate','cancelled'].includes(job.status))return {jobId,status:job.status};
   if(job.status==='parsed')return this.store.beginFinalization({operationId:operation(jobId,'finalize',job.lastPin),jobId});
   if(job.status==='verifying')return this.store.verifyNextBatches({operationId:operation(jobId,'verify-bounded',[job.finalization.cursor,this.finalizationBatchLimit]),jobId,expectedCursor:job.finalization.cursor,maxBatches:this.finalizationBatchLimit});
   if(job.status==='verified')return this.store.publishCompletedJob({operationId:operation(jobId,'publish',job.lastPin),jobId});
   return {jobId,status:job.status};
  });
 }
 stepScan(scanId,{deadlineMs}={}){
  this._budget();const state=this.locked(()=>{this.store.recoveryBarrier();return this.store.getScan(scanId);});
  if(state.done)return {scanId,status:'complete'};
  if(state.pendingPage!==null){
   return this.locked(()=>{
    this.store.recoveryBarrier();const entry=this.store.nextScanEntry(scanId);
    if(!entry)return {scanId,status:this.store.getScan(scanId).done?'complete':'progressed'};
    const marker=[entry.page,entry.index];
    const jobId=operation(scanId,'job',marker);
    this.store.registerJob({operationId:operation(scanId,'register',marker),jobId,sourceIdentity:entry.sourceIdentity});
    return this.store.acknowledgeScanEntry({operationId:operation(scanId,'ack',marker),scanId,expectedPage:entry.page,expectedIndex:entry.index});
   });
  }
  let page;
  try{page=this.source.listPage({pageToken:state.pageToken,deadlineMs});}
  catch(e){if(e.code==='PAGE_TOKEN_REJECTED')return this.locked(()=>this.store.restartScan({operationId:operation(scanId,'restart',state.restarts),scanId,expectedPageToken:state.pageToken,expectedPage:state.nextPage}));throw e;}
  this._budget();return this.locked(()=>this.store.recordScanPage({operationId:operation(scanId,'page',state.nextPage),scanId,expectedPageToken:state.pageToken,expectedPage:state.nextPage,files:page.files,nextPageToken:page.nextPageToken}));
 }

}

return {ImportRunner};
})();
const m10 = (function(){
// Composition root for the one owner-authorized Apps Script project. Constructing
// this runtime does not bootstrap, import, publish, deploy or install a trigger.
const {GasStoreIO} = m7;
const {ReservedSlotWriter} = m6;
const {ImportStoreBinding} = m8;
const {ImportCheckpointCoordinator,ImmutableAssetAdapter,createGasAssetMediaReader} = m4;
const {createDriveSourceTransport} = m3;
const {ImportRunner} = m9;
const fail=code=>{throw Error(code);};
function createGasImportRuntime(globals,config){
 const {Drive,Utilities,UrlFetchApp,ScriptApp,LockService}=globals||{};
 if(!config||typeof config.checkBudget!=='function'||typeof LockService?.getScriptLock!=='function')fail('RUNTIME_CONFIG');
 const scriptLock=LockService.getScriptLock();let io;
 // All runtime and coordinator lock phases pass through this facade. A lock
 // already held by an external caller never activates a cache: its release and
 // reacquisition cannot be observed here. No cache survives our own release,
 // failed acquisition, exception, or observed loss of ownership.
 const lock={
  hasLock(){const held=scriptLock.hasLock();if(held!==true)io?.endReadPhase();return held;},
  tryLock(ms){io?.endReadPhase();const acquired=scriptLock.tryLock(ms);if(acquired===true)io?.beginReadPhase();return acquired;},
  releaseLock(){io?.endReadPhase();return scriptLock.releaseLock();}
 };
 const locked=fn=>{if(lock.hasLock())return fn();let acquired=false;try{acquired=lock.tryLock(1000)===true;if(!acquired){const e=Error('WRITER_BUSY');e.retryable=true;throw e;}return fn();}finally{if(acquired)lock.releaseLock();}};
 io=new GasStoreIO({Drive,Utilities,UrlFetchApp,ScriptApp,lock,storeId:config.storeId,managedParentId:config.metadataParentId,checkBudget:config.checkBudget,protocolReadCache:config.protocolReadCache,checkpointHintId:config.checkpointHintId});
 const writer=new ReservedSlotWriter({io,storeId:config.storeId,writerScriptId:config.writerScriptId,anchorId:config.anchorId,limits:config.writerLimits,checkpointHintId:config.checkpointHintId,checkpointHintCodec:config.checkpointHintCodec,checkpointHintAnchorHash:config.checkpointHintAnchorHash});
 const source=createDriveSourceTransport(globals,{pageSize:32});
 const budget=()=>{if(config.checkBudget('runtime')!==true){const e=Error('IMPORT_YIELD');e.retryable=true;throw e;}};
 const validateSource=s=>{budget();source.getSource(s,{deadlineMs:config.deadlineMs});return true;};
 let store;
 const reservationRead=fn=>lock.hasLock()?fn():locked(()=>{store.recoveryBarrier();return fn();});
 const reader=createGasAssetMediaReader({UrlFetchApp,ScriptApp,checkBudget:config.checkBudget,assertReadableAsset:(...args)=>reservationRead(()=>store.assertReadableAsset(...args))});
 const readManaged=r=>{
  if(store.assertReadableAsset(r.fileId,r.byteLength,2097152)!==true)fail('ASSET_MEDIA_NOT_RESERVED');
  budget();const m=Drive.Files.get(r.fileId,{fields:'id,parents,appProperties,size,trashed,mimeType,ownedByMe,shared'});
  const markers={'mypace.store':r.storeId,'mypace.job':r.jobId,'mypace.pin':r.pinId,'mypace.role':r.role,'mypace.sha256':r.sha256};
  if(!m||m.id!==r.fileId||m.trashed!==false||m.ownedByMe!==true||m.shared!==false||m.mimeType!=='application/octet-stream'||!Array.isArray(m.parents)||m.parents.length!==1||m.parents[0]!==config.assetsParentId||String(m.size)!==String(r.byteLength)||Object.keys(markers).some(k=>m.appProperties?.[k]!==markers[k]))fail('ASSET_METADATA_MISMATCH');
  return reader(r.fileId,r.byteLength,2097152);
 };
 store=new ImportStoreBinding({writer,storeId:config.storeId,readAsset:readManaged,validateSourceCurrent:validateSource});
 const assets=new ImmutableAssetAdapter({Drive,Utilities,readAssetBytes:reader,managedParentId:config.assetsParentId,storeId:config.storeId,assertReservation:r=>reservationRead(()=>store.assertReservation(r))});
 const coordinator=new ImportCheckpointCoordinator({writer:store,assets,getScriptLock:()=>lock,validateSourceCurrent:validateSource,checkBudget:config.checkBudget});
 const runner=new ImportRunner({store,coordinator,source,allocateIds:n=>io.allocateIds(n),locked,checkBudget:config.checkBudget,rangeBytes:config.rangeBytes,finalizationBatchLimit:config.finalizationBatchLimit,maxFreshOutputs:config.maxFreshOutputs});
 return Object.freeze({writer,store,source,assets,coordinator,runner,locked});
}

return {createGasImportRuntime};
})();
const m11 = (function(){
// Explicit owner repair only. It never imports CSV, changes store identity,
// deletes history or changes application entities. Repeated completed calls are
// no-ops; ambiguous checkpoint commits are resolved through existing recovery.
const {writerDigest} = m6;
function prepareWebRead(runtime){
 if(!runtime?.writer||typeof runtime.locked!=='function')throw Error('WEB_PREPARATION_CONFIG');
 return runtime.locked(()=>{
  const writer=runtime.writer;writer.recoveryBarrier({persistFrameProgress:true});
  const before=writer.status(),progress=writer.recoveryProgress();let sealed=false;
  if(before.replayFrames>1){
   const identity={kind:'web-read-quiescent',storeId:before.storeId,generation:before.datasetGeneration,headId:before.headId,headHash:before.headHash,revision:before.revision};
   try{writer.checkpoint({operationId:'web_ready_'+before.revision+'_'+before.headHash.slice(0,24),epoch:before.acceptedEpochs[before.acceptedEpochs.length-1],digest:writerDigest(identity),result:{webReadPrepared:true,cutRevision:before.revision}});}
   catch(error){if(['STORE_YIELD','OWNER_BUDGET_YIELD','IMPORT_YIELD'].includes(error.code||error.message)&&progress.cursorPersisted)Object.assign(error,progress,{recoveryPhase:'seal'});throw error;}
   sealed=true;
  }
  return {sealed,storage:writer.status()};
 });
}

return {prepareWebRead};
})();
const m12 = (function(){
/**
 * Server-internal owner provisioning for the EXISTING authorized Apps Script.
 * Not an HTTP handler, public RPC, trigger installer or OAuth setup flow.
 * The caller supplies the owner from trusted code. The first explicit bootstrap
 * pins the actual existing script ID; an optional expectedScriptId adds a check.
 * Reusing its Cloud project in a different GAS project does not satisfy this.
 *
 * ScriptProperties contains one bounded fixed-configuration record only. An
 * explicit owner repair can add missing advisory pins, not replace identity.
 * It is written and read back before any folder/file create. No progress, job,
 * receipt or phase flag is stored there. A lost response resumes the SAME IDs.
 * No folder name search/adoption, update, sharing change, source write or delete.
 */
const {GasStoreIO} = m7;
const {ReservedSlotWriter,writerDigest} = m6;
const {createGasCheckpointHintCodec} = m5;

const OWNER_STORE_PROPERTY='mypace.production.store.v1';
const OWNER_BOOTSTRAP_PROTOCOL='mypace-owner-store-v1';
// Owner may manually move the SAME pinned store root into this known folder.
// This is not a caller/configuration-selected parent or a request to move it.
const OWNER_STORE_MANUAL_DESTINATION='1kqtRzzNKZAq7-HE83XIN_JErtBn9YM_6';
const FOLDER='application/vnd.google-apps.folder';
const FIELDS='id,parents,appProperties,trashed,mimeType,ownedByMe,shared';
const KEYS='acceptedEpochs,anchorId,assetsParentId,datasetGeneration,firstIndexId,firstSlotId,metadataParentId,myDriveRootId,ownerEmail,protocol,rootParentId,storeId,writerScriptId';
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const folderId=x=>id(x)&&x.length<=100; // Drive app-property key+value limit.
const email=x=>typeof x==='string'&&x.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
const normalized=x=>typeof x==='string'?x.trim().toLowerCase():'';
const clone=x=>JSON.parse(JSON.stringify(x));
const fail=(code,retryable=false,status)=>{const e=Error(code);e.code=code;if(retryable)e.retryable=true;if(status!==undefined)e.status=status;throw e;};
const freezeConfig=c=>Object.freeze({...c,acceptedEpochs:Object.freeze(c.acceptedEpochs.slice())});
const validEpochs=x=>Array.isArray(x)&&x.length>=1&&x.length<=4&&x.every(id)&&new Set(x).size===x.length;

// Pure configuration validation for a SEPARATELY authenticated trusted server
// boundary. This does not authorize a caller, inspect Drive, or verify grants.
// writerScriptId must be the actual ScriptApp.getScriptId(), never request data.
function parsePinnedOwnerStoreConfig(raw,{ownerEmail,writerScriptId,datasetGeneration,acceptedEpochs}={}){
 const owner=normalized(ownerEmail);
 if(!email(owner)||!id(writerScriptId)||(datasetGeneration!==undefined&&!id(datasetGeneration))||(acceptedEpochs!==undefined&&!validEpochs(acceptedEpochs)))fail('OWNER_BOOTSTRAP_CONFIG');
 if(raw===null)return null;
 if(typeof raw!=='string'||raw.length<1||raw.length>8192)fail('OWNER_BOOTSTRAP_CONFIG_INVALID');
 let c;try{c=JSON.parse(raw);}catch(_){fail('OWNER_BOOTSTRAP_CONFIG_INVALID');}
 if(!c||typeof c!=='object'||Array.isArray(c)||(Object.keys(c).some(k=>!KEYS.split(',').includes(k)&&!['checkpointHintId','checkpointHintAnchorHash','discoveryStateId'].includes(k))||KEYS.split(',').some(k=>!Object.prototype.hasOwnProperty.call(c,k)))||c.protocol!==OWNER_BOOTSTRAP_PROTOCOL||c.writerScriptId!==writerScriptId||c.ownerEmail!==owner||(datasetGeneration!==undefined&&c.datasetGeneration!==datasetGeneration)||(acceptedEpochs!==undefined&&JSON.stringify(c.acceptedEpochs)!==JSON.stringify(acceptedEpochs)))fail('OWNER_BOOTSTRAP_CONFIG_MISMATCH');
 const ids=['rootParentId','metadataParentId','assetsParentId','anchorId','firstSlotId','firstIndexId',...(Object.prototype.hasOwnProperty.call(c,'checkpointHintId')?['checkpointHintId']:[]),...(Object.prototype.hasOwnProperty.call(c,'discoveryStateId')?['discoveryStateId']:[])].map(k=>c[k]);
 if(ids.some(x=>!folderId(x))||new Set(ids).size!==ids.length||!id(c.myDriveRootId)||ids.includes(c.myDriveRootId)||c.storeId!==c.rootParentId||!id(c.datasetGeneration)||!validEpochs(c.acceptedEpochs))fail('OWNER_BOOTSTRAP_CONFIG_INVALID');
 if(Object.prototype.hasOwnProperty.call(c,'checkpointHintAnchorHash')&&(!c.checkpointHintId||typeof c.checkpointHintAnchorHash!=='string'||! /^[a-f0-9]{64}$/.test(c.checkpointHintAnchorHash)))fail('OWNER_BOOTSTRAP_CONFIG_INVALID');
 return freezeConfig(c);
}

function createOwnerBootstrap(globals,options){
 const {Drive,Utilities,UrlFetchApp,ScriptApp,LockService,PropertiesService,Session}=globals||{};
 const {expectedScriptId:requestedScriptId,ownerEmail,checkBudget,propertyKey=OWNER_STORE_PROPERTY,datasetGeneration='1',acceptedEpochs=['default']}=options||{};
 const expectedScriptId=requestedScriptId===undefined&&typeof ScriptApp?.getScriptId==='function'?ScriptApp.getScriptId():requestedScriptId;
 const owner=normalized(ownerEmail);
 if(!id(expectedScriptId)||!email(owner)||typeof checkBudget!=='function'||typeof propertyKey!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(propertyKey)||!id(datasetGeneration)||!validEpochs(acceptedEpochs)||typeof Drive?.Files?.generateIds!=='function'||typeof Drive?.Files?.create!=='function'||typeof Utilities?.newBlob!=='function'||typeof UrlFetchApp?.fetch!=='function'||typeof ScriptApp?.getScriptId!=='function'||typeof ScriptApp?.getOAuthToken!=='function'||typeof LockService?.getScriptLock!=='function'||typeof PropertiesService?.getScriptProperties!=='function'||typeof Session?.getActiveUser!=='function'||typeof Session?.getEffectiveUser!=='function')fail('OWNER_BOOTSTRAP_CONFIG');
 // Do not obtain a token, inspect properties, acquire a lock or call Drive merely
 // by constructing this API. All public methods perform the guards afresh.
 const epochs=acceptedEpochs.slice();
 const budget=()=>{if(checkBudget('owner-bootstrap')!==true)fail('OWNER_BOOTSTRAP_YIELD',true);};
 function guard(){
  if(ScriptApp.getScriptId()!==expectedScriptId)fail('OWNER_BOOTSTRAP_SCRIPT_MISMATCH');
  let active,effective;
  try{active=normalized(Session.getActiveUser().getEmail());effective=normalized(Session.getEffectiveUser().getEmail());}catch(_){fail('OWNER_BOOTSTRAP_OWNER_UNVERIFIED');}
  // Effective user alone is unsafe for execute-as-owner web apps and triggers.
  if(active!==owner||effective!==owner)fail('OWNER_BOOTSTRAP_OWNER_UNVERIFIED');
 }
 function locked(action){
  guard();budget();const lock=LockService.getScriptLock();
  if(!lock||['hasLock','tryLock','releaseLock'].some(k=>typeof lock[k]!=='function'))fail('OWNER_BOOTSTRAP_LOCK_INVALID');
  let acquired=false;
  try{if(lock.hasLock()!==true){acquired=lock.tryLock(1000)===true;if(!acquired)fail('OWNER_BOOTSTRAP_BUSY',true);}return action(lock);}finally{if(acquired)lock.releaseLock();}
 }
 function assertHeld(lock){guard();if(lock.hasLock()!==true)fail('OWNER_BOOTSTRAP_LOCK_REQUIRED');budget();}
 function properties(lock){assertHeld(lock);const p=PropertiesService.getScriptProperties();if(!p||typeof p.getProperty!=='function'||typeof p.setProperty!=='function')fail('OWNER_BOOTSTRAP_PROPERTIES_INVALID');return p;}
 function readProperty(p){budget();try{return p.getProperty(propertyKey);}catch(_){fail('OWNER_BOOTSTRAP_CONFIG_UNRESOLVED',true);}}
 function parse(raw){return parsePinnedOwnerStoreConfig(raw,{ownerEmail:owner,writerScriptId:expectedScriptId,datasetGeneration,acceptedEpochs:epochs});}
 function parseRecovery(raw){return parsePinnedOwnerStoreConfig(raw,{ownerEmail:owner,writerScriptId:expectedScriptId});}
 function metadata(lock,fileId){
  assertHeld(lock);if(fileId!=='root'&&!id(fileId))fail('OWNER_BOOTSTRAP_ID_INVALID');
  let r;
  try{const token=ScriptApp.getOAuthToken();if(typeof token!=='string'||!token)fail('OWNER_BOOTSTRAP_AUTH');r=UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(fileId)+'?fields='+encodeURIComponent(FIELDS),{method:'get',headers:{Authorization:'Bearer '+token},muteHttpExceptions:true,followRedirects:false});}catch(_){fail('OWNER_BOOTSTRAP_READ_UNRESOLVED',true);}
  if(!r||typeof r.getResponseCode!=='function'||typeof r.getContentText!=='function')fail('OWNER_BOOTSTRAP_RESPONSE_INVALID');
  const status=r.getResponseCode();if(status===404)return null;if(status!==200)fail('OWNER_BOOTSTRAP_READ_UNRESOLVED',true,status);
  let m;try{const text=r.getContentText();if(typeof text!=='string'||text.length>16384)fail('OWNER_BOOTSTRAP_METADATA_INVALID');m=JSON.parse(text);}catch(_){fail('OWNER_BOOTSTRAP_METADATA_INVALID');}
  if(!m||typeof m!=='object'||Array.isArray(m))fail('OWNER_BOOTSTRAP_METADATA_INVALID');return m;
 }
 function privateFolder(m){return !!(m&&id(m.id)&&m.mimeType===FOLDER&&m.trashed===false&&m.ownedByMe===true&&m.shared===false);}
 function driveRoot(lock,c){const m=metadata(lock,'root');if(!privateFolder(m)||(c&&m.id!==c.myDriveRootId))fail('OWNER_BOOTSTRAP_DRIVE_ROOT_INVALID');return m.id;}
 function folderSpec(c,role){
  const keys={root:'rootParentId',metadata:'metadataParentId',assets:'assetsParentId'};
  return {id:c[keys[role]],name:role==='root'?'MyPace Private Store':'MyPace '+role,mimeType:FOLDER,parents:[role==='root'?c.myDriveRootId:c.rootParentId],appProperties:{'mypace.bootstrap':OWNER_BOOTSTRAP_PROTOCOL,'mypace.store':c.storeId,'mypace.script':writerDigest(c.writerScriptId),'mypace.role':'store-'+role}};
 }
 function verifyFolder(m,spec){
  if(!privateFolder(m)||m.id!==spec.id||!Array.isArray(m.parents)||m.parents.length!==1||m.parents[0]!==spec.parents[0]||!m.appProperties||Object.keys(spec.appProperties).some(k=>m.appProperties[k]!==spec.appProperties[k]))fail('OWNER_BOOTSTRAP_FOLDER_MISMATCH');
  // Display names are not identity. A user rename remains harmless.
  return m;
 }
 function verifyRootFolder(lock,c,m){
  const spec=folderSpec(c,'root');
  if(Array.isArray(m?.parents)&&m.parents.length===1&&m.parents[0]===OWNER_STORE_MANUAL_DESTINATION){
   // Keep exact identity/privacy/marker validation on the root itself. Only
   // this one root role may have the one explicitly known alternate parent.
   verifyFolder(m,{...spec,parents:[OWNER_STORE_MANUAL_DESTINATION]});
   const destination=metadata(lock,OWNER_STORE_MANUAL_DESTINATION);
   if(!privateFolder(destination)||destination.id!==OWNER_STORE_MANUAL_DESTINATION)fail('OWNER_BOOTSTRAP_PLACEMENT_INVALID');
   return m;
  }
  return verifyFolder(m,spec);
 }
 function folder(lock,c,role,allowCreate){
  const spec=folderSpec(c,role);
  const verify=m=>role==='root'?verifyRootFolder(lock,c,m):verifyFolder(m,spec);
  const parent=()=>{driveRoot(lock,c);if(role!=='root')verifyRootFolder(lock,c,metadata(lock,c.rootParentId));};
  parent();const m=metadata(lock,spec.id);if(m)return verify(m);
  if(!allowCreate)fail('OWNER_BOOTSTRAP_FOLDER_MISSING');
  for(let attempt=0;attempt<2;attempt++){
   parent();assertHeld(lock);
   try{Drive.Files.create(clone(spec),null,{fields:'id',ignoreDefaultVisibility:true});}catch(_){/* Read THIS ID even after 409, timeout, malformed reply or permission error. */}
   const observed=metadata(lock,spec.id);if(observed)return verify(observed);
  }
  fail('OWNER_BOOTSTRAP_CREATE_UNRESOLVED',true);
 }
 function writer(lock,c){const io=new GasStoreIO({Drive,Utilities,UrlFetchApp,ScriptApp,lock,storeId:c.storeId,managedParentId:c.metadataParentId,checkBudget,checkpointHintId:c.checkpointHintId});return new ReservedSlotWriter({io,storeId:c.storeId,writerScriptId:c.writerScriptId,anchorId:c.anchorId,checkpointHintId:c.checkpointHintId,checkpointHintAnchorHash:c.checkpointHintAnchorHash});}
 function configure(lock,p){
  const myDriveRootId=driveRoot(lock);assertHeld(lock);let r;
  try{r=Drive.Files.generateIds({count:8,space:'drive',type:'files'});}catch(_){fail('OWNER_BOOTSTRAP_IDS_UNRESOLVED',true);}
  if(!r||!Array.isArray(r.ids)||r.ids.length!==8||r.ids.some(x=>!folderId(x))||new Set(r.ids).size!==8||r.ids.includes(myDriveRootId))fail('OWNER_BOOTSTRAP_IDS_INVALID');
  const [rootParentId,metadataParentId,assetsParentId,anchorId,firstSlotId,firstIndexId,checkpointHintId,discoveryStateId]=r.ids;
  const c=parse(JSON.stringify({protocol:OWNER_BOOTSTRAP_PROTOCOL,ownerEmail:owner,writerScriptId:expectedScriptId,myDriveRootId,storeId:rootParentId,rootParentId,metadataParentId,assetsParentId,anchorId,firstSlotId,firstIndexId,checkpointHintId,discoveryStateId,datasetGeneration,acceptedEpochs:epochs}));
  // A second guard/read prevents an accidental overwrite if trusted code changed
  // properties while reserving. All supported callers share this script lock.
  assertHeld(lock);if(readProperty(p)!==null)fail('OWNER_BOOTSTRAP_CONFIG_CHANGED');
  const raw=JSON.stringify(c);if(raw.length>8192)fail('OWNER_BOOTSTRAP_CONFIG_INVALID');
  try{p.setProperty(propertyKey,raw);}catch(_){/* An ambiguous config write is resolved by exact readback. */}
  const observed=readProperty(p);if(observed!==raw)fail('OWNER_BOOTSTRAP_CONFIG_WRITE_UNRESOLVED',true);
  return parse(observed);
 }
 function inspect(lock,c,allowCreate){
  for(const role of ['root','metadata','assets'])folder(lock,c,role,allowCreate);
  const w=writer(lock,c);
  if(allowCreate)w.bootstrap({datasetGeneration:c.datasetGeneration,acceptedEpochs:c.acceptedEpochs,firstSlotId:c.firstSlotId,firstIndexId:c.firstIndexId});
  else {
   // bootstrap() creates a missing anchor; recoveryBarrier() may publish missing
   // checkpoint index links. Neither is appropriate for read-only configuration.
   const a=w.readBootstrap();
   if((!c.checkpointHintAnchorHash&&a.checkpointHintId!==c.checkpointHintId)||a.firstSlotId!==c.firstSlotId||a.firstIndexId!==c.firstIndexId||a.datasetGeneration!==c.datasetGeneration||JSON.stringify(a.acceptedEpochs)!==JSON.stringify(c.acceptedEpochs))fail('OWNER_BOOTSTRAP_ANCHOR_MISMATCH');
  }
  return freezeConfig(c);
 }
 function repairRecoveryConfiguration(lock){
  const p=properties(lock),before=readProperty(p),c=parseRecovery(before);
  if(!c)fail('OWNER_BOOTSTRAP_REQUIRED');
  // Use the already configured server secret. Never generate, replace, return,
  // log or persist a key here, and never reset configuration to bypass one.
  let secret;
  try{secret=p.getProperty('MYPACE_WRITER_SECRET');}catch(_){fail('OWNER_RECOVERY_SECRET_UNRESOLVED',true);}
  try{createGasCheckpointHintCodec({Utilities,secret}).encode({protocol:'mypace-owner-repair-check-v1'});}catch(_){
   const error=Error('OWNER_RECOVERY_SECRET_REQUIRED');error.code=error.message;error.requiresOwnerAction=true;
   error.setup='Configure the existing owner-managed MYPACE_WRITER_SECRET in this same Apps Script project, then run MyPaceRepairRecoveryConfiguration. Keep any existing key and all original storage IDs; never reset the store.';
   throw error;
  }
  // These checks are strictly read-only and precede even ID reservation. They
  // verify the old authority, not an empty replacement store or name adoption.
  inspect(lock,c,false);
  const anchor=writer(lock,c).readBootstrapInfo();
  const missing=['checkpointHintId','discoveryStateId'].filter(k=>c[k]===undefined);
  if(!missing.length)return freezeConfig(c);
  assertHeld(lock);let generated;
  try{generated=Drive.Files.generateIds({count:missing.length,space:'drive',type:'files'});}catch(_){fail('OWNER_BOOTSTRAP_IDS_UNRESOLVED',true);}
  if(!generated||!Array.isArray(generated.ids)||generated.ids.length!==missing.length||generated.ids.some(x=>!folderId(x))||new Set(generated.ids).size!==missing.length)fail('OWNER_BOOTSTRAP_IDS_INVALID');
  const updated={...c};for(let i=0;i<missing.length;i++)updated[missing[i]]=generated.ids[i];
  // A legacy anchor contains no hint field. Bind its exact existing immutable
  // bytes instead of rewriting that anchor or changing initial chain slots.
  if(missing.includes('checkpointHintId'))updated.checkpointHintAnchorHash=anchor.hash;
  const candidate=parseRecovery(JSON.stringify(updated)),raw=JSON.stringify(candidate);
  assertHeld(lock);if(readProperty(p)!==before)fail('OWNER_BOOTSTRAP_CONFIG_CHANGED');
  try{p.setProperty(propertyKey,raw);}catch(_){/* A lost response is decided by exact readback. */}
  const observed=readProperty(p);if(observed!==raw)fail('OWNER_BOOTSTRAP_CONFIG_WRITE_UNRESOLVED',true);
  // No advice is initialized here. Recovery creates/updates only the fixed
  // pinned hint ID. In particular, a valid authenticated witness to missing
  // immutable authority must remain untouched rather than being overwritten.
  return parseRecovery(observed);
 }
 return Object.freeze({
  bootstrap:()=>locked(lock=>{const p=properties(lock),c=parse(readProperty(p))||configure(lock,p);return inspect(lock,c,true);}),
  load:()=>locked(lock=>{const c=parse(readProperty(properties(lock)));return c?inspect(lock,c,false):null;}),
  // Maintenance may inspect older valid generations/epochs without changing
  // the ordinary import runtime's explicit compatibility contract/defaults.
  loadRecoveryConfiguration:()=>locked(lock=>{const c=parseRecovery(readProperty(properties(lock)));return c?inspect(lock,c,false):null;}),
  repairRecoveryConfiguration:()=>locked(repairRecoveryConfiguration)
 });
}

return {OWNER_STORE_PROPERTY,OWNER_BOOTSTRAP_PROTOCOL,parsePinnedOwnerStoreConfig,createOwnerBootstrap};
})();
const m13 = (function(){
// Fixed-size, owner-private advisory source-discovery cursor. This is not an
// app/job checkpoint. Loss or invalid authentication restarts source discovery;
// only the immutable import protocol may register, resume or publish a job.
const {encodeUtf8,decodeUtf8} = m1;
const {SOURCE_FOLDER_ID,normalizeGasBytes} = m3;
const DISCOVERY_STATE_PROTOCOL='mypace-source-discovery-v1';
const DISCOVERY_STATE_MAX_BYTES=8192;
const DOMAIN='MyPace/Drive/source-discovery/HMAC-SHA256/v1\n';
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const token=x=>x===null||typeof x==='string'&&x.length>=1&&x.length<=4096&&!/[\0\r\n]/.test(x);
const fail=code=>{const e=Error(code);e.code=code;throw e;};
const retry=code=>{const e=Error(code);e.code=code;e.retryable=true;throw e;};
const canonical=x=>{if(x===null||typeof x==='string'||Number.isSafeInteger(x))return JSON.stringify(x);if(x&&Object.getPrototypeOf(x)===Object.prototype)return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';fail('DISCOVERY_STATE_FORMAT');};
const sameMac=(a,b)=>{if(!hex(a)||!hex(b))return false;let n=0;for(let i=0;i<64;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;};
function createDiscoveryStateCodec({hmacSha256}={}){
 if(typeof hmacSha256!=='function')fail('DISCOVERY_STATE_AUTH_REQUIRED');
 const sign=p=>{const text=canonical(p);if(encodeUtf8(text).length>DISCOVERY_STATE_MAX_BYTES-128)fail('DISCOVERY_STATE_BOUND');const mac=hmacSha256(DOMAIN+text);if(!hex(mac))fail('DISCOVERY_STATE_AUTH_INVALID');return mac;};
 return Object.freeze({encode:payload=>{const bytes=encodeUtf8(canonical({payload,mac:sign(payload)}));if(bytes.length>DISCOVERY_STATE_MAX_BYTES)fail('DISCOVERY_STATE_BOUND');return bytes;},decode:bytes=>{try{if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>DISCOVERY_STATE_MAX_BYTES)return null;const text=decodeUtf8(bytes),e=JSON.parse(text);if(!e||Object.keys(e).sort().join(',')!=='mac,payload'||canonical(e)!==text||!sameMac(e.mac,sign(e.payload)))return null;return e.payload;}catch(_){return null;}}});
}
function createGasDiscoveryStateCodec({Utilities,secret}={}){
 if(typeof secret!=='string'||encodeUtf8(secret).length<32||encodeUtf8(secret).length>4096||typeof Utilities?.computeHmacSha256Signature!=='function'||Utilities?.Charset?.UTF_8===undefined)fail('DISCOVERY_STATE_AUTH_REQUIRED');
 return createDiscoveryStateCodec({hmacSha256:text=>{const bytes=Utilities.computeHmacSha256Signature(text,secret,Utilities.Charset.UTF_8);if(!bytes||bytes.length!==32)fail('DISCOVERY_STATE_AUTH_INVALID');return Array.from(bytes,n=>{if(!Number.isInteger(n)||n< -128||n>255)fail('DISCOVERY_STATE_AUTH_INVALID');return (n&255).toString(16).padStart(2,'0');}).join('');}});
}
function createDiscoveryStateIO(globals,config,{checkBudget=()=>true,now=()=>Date.now()}={}){
 const codec=config.discoveryStateCodec,fileId=config.discoveryStateId;
 if(!fileId||!codec)return null;
 if(!id(fileId)||[config.storeId,config.anchorId,config.metadataParentId,config.assetsParentId,config.checkpointHintId].includes(fileId)||typeof codec.encode!=='function'||typeof codec.decode!=='function')fail('DISCOVERY_STATE_CONFIG');
 const {Drive,UrlFetchApp,ScriptApp,Utilities,LockService}=globals;
 const scope={protocol:DISCOVERY_STATE_PROTOCOL,fileId,storeId:config.storeId,writerScriptId:config.writerScriptId,anchorId:config.anchorId,folderId:SOURCE_FOLDER_ID,datasetGeneration:config.datasetGeneration||'1'};
 const guard=()=>{if(ScriptApp.getScriptId()!==scope.writerScriptId||LockService.getScriptLock().hasLock()!==true)fail('DISCOVERY_STATE_LOCK_REQUIRED');if(checkBudget()!==true)fail('OWNER_BUDGET_YIELD');};
 const getMeta=id=>{
  guard();let response;try{response=UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?fields='+encodeURIComponent('id,parents,appProperties,size,trashed,mimeType,ownedByMe,shared'),{method:'get',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true,followRedirects:false});}catch(error){if(error?.message==='OWNER_BUDGET_YIELD')throw error;retry('DISCOVERY_STATE_READ_UNRESOLVED');}
  const status=response.getResponseCode();if(status===404)return null;if(status===401)fail('DISCOVERY_STATE_AUTH_REQUIRED');if(status===403)fail('DISCOVERY_STATE_PERMISSION_DENIED');if(status===429||status>=500)retry('DISCOVERY_STATE_READ_UNRESOLVED');if(status!==200)fail('DISCOVERY_STATE_READ_REJECTED');
  const text=response.getContentText();if(typeof text!=='string'||text.length>16384)fail('DISCOVERY_STATE_METADATA_INVALID');let metadata;try{metadata=JSON.parse(text);}catch(_){fail('DISCOVERY_STATE_METADATA_INVALID');}if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))fail('DISCOVERY_STATE_METADATA_INVALID');return metadata;
 };
 const parent=()=>{const m=getMeta(config.metadataParentId);if(!m||m.id!==config.metadataParentId||m.trashed!==false||m.ownedByMe!==true||m.shared!==false||m.mimeType!=='application/vnd.google-apps.folder')fail('DISCOVERY_STATE_PARENT_INVALID');};
 const metadata=()=>{parent();const m=getMeta(fileId);if(m&&(m.id!==fileId||m.trashed!==false||m.ownedByMe!==true||m.shared!==false||m.mimeType!=='application/octet-stream'||!Array.isArray(m.parents)||m.parents.length!==1||m.parents[0]!==config.metadataParentId||m.appProperties?.['mypace.store']!==config.storeId||m.appProperties?.['mypace.role']!=='source-discovery'))fail('DISCOVERY_STATE_METADATA_MISMATCH');return m;};
 const stateValid=s=>s&&Object.keys(s).sort().join(',')==='checkedAt,index,pageHash,pageToken,phase'&&['scan','complete'].includes(s.phase)&&token(s.pageToken)&&Number.isSafeInteger(s.index)&&s.index>=0&&s.index<=32&&(s.pageHash===null||hex(s.pageHash))&&Number.isSafeInteger(s.checkedAt)&&s.checkedAt>=0&&s.checkedAt<=now()&&(s.phase!=='complete'||s.pageToken===null&&s.index===0&&s.pageHash===null);
 const read=head=>{
  const m=metadata();if(!m)return null;
  if(!/^\d+$/.test(String(m.size))||Number(m.size)<1||Number(m.size)>DISCOVERY_STATE_MAX_BYTES)return null;
  const size=Number(m.size);guard();const response=UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(fileId)+'?alt=media',{method:'get',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken(),Range:'bytes=0-'+(size-1),'Accept-Encoding':'identity'},muteHttpExceptions:true,followRedirects:false});
  const status=response.getResponseCode();if(status===404)return null;if(status===401)fail('DISCOVERY_STATE_AUTH_REQUIRED');if(status===403)fail('DISCOVERY_STATE_PERMISSION_DENIED');if(status===429||status>=500)retry('DISCOVERY_STATE_READ_UNRESOLVED');if(status!==206)fail('DISCOVERY_STATE_RANGE_INVALID');
  const headers=response.getAllHeaders(),header=name=>{const keys=Object.keys(headers||{}).filter(k=>k.toLowerCase()===name);return keys.length===1?String(headers[keys[0]]):null;};
  if(header('content-range')!==`bytes 0-${size-1}/${size}`||header('content-length')!==null&&header('content-length')!==String(size)||header('content-encoding')!==null&&header('content-encoding').toLowerCase()!=='identity')return null;
  let p;try{p=codec.decode(normalizeGasBytes(response.getContent(),size));}catch(_){return null;}
  if(!p||Object.keys(p).sort().join(',')!==[...Object.keys(scope),'headHash','revision','state'].sort().join(',')||Object.entries(scope).some(([k,v])=>p[k]!==v)||p.headHash!==head.headHash||p.revision!==head.revision||!stateValid(p.state))return null;
  return p.state;
 };
 const write=(head,state)=>{
  if(!stateValid(state))fail('DISCOVERY_STATE_INVALID');
  const bytes=codec.encode({...scope,headHash:head.headHash,revision:head.revision,state});
  if(!(bytes instanceof Uint8Array)||bytes.length>DISCOVERY_STATE_MAX_BYTES)fail('DISCOVERY_STATE_BOUND');
  const m=metadata(),blob=Utilities.newBlob(Array.from(bytes,n=>n>127?n-256:n),'application/octet-stream','mypace-source-discovery-'+fileId);guard();
  // Never retry an ambiguous overwrite or allocate a replacement ID. Old/absent
  // cursor only repeats discovery; committed source work remains in Drive.
  const result=m?Drive.Files.update({},fileId,blob,{fields:'id'}):Drive.Files.create({id:fileId,name:'mypace-source-discovery-'+fileId,mimeType:'application/octet-stream',parents:[config.metadataParentId],appProperties:{'mypace.store':config.storeId,'mypace.role':'source-discovery'}},blob,{fields:'id',ignoreDefaultVisibility:true});
  if(!result||result.id!==fileId)fail('DISCOVERY_STATE_WRITE_UNRESOLVED');
 };
 return Object.freeze({read,write});
}

return {DISCOVERY_STATE_PROTOCOL,DISCOVERY_STATE_MAX_BYTES,createDiscoveryStateCodec,createGasDiscoveryStateCodec,createDiscoveryStateIO};
})();
const m14 = (function(){
// Read-only completion reconciliation. CacheService holds a short-lived throttle,
// never jobs, pagination progress, app data, source snapshots, or authority.
const {encodeUtf8} = m1;
const {hashAssetBytes} = m4;
const {mappingHash} = m2;
const {PARSER_VERSION,sourceKey} = m0;
const {importKeys} = m8;
const {validateSourceIdentity} = m3;
const hash=x=>hashAssetBytes(encodeUtf8(JSON.stringify(x)));
const terminal=s=>['completed','duplicate','cancelled'].includes(s);
const RECONCILIATION_LIMITS=Object.freeze({pages:4,sources:128,jobs:32,additionalCalls:48,maxThrottleMs:3600000});
function value(writer,key){const e=writer.get(key);if(e?.deleted)throw Error('IMPORT_TOMBSTONE');return e?.value;}
function importDirectoryVersion(writer){const e=writer.get(importKeys.directory());if(e?.deleted)throw Error('IMPORT_TOMBSTONE');return e?.version||0;}
// Every lookup uses the current committed roots under the one script lock.
// Historical identity records alone cannot suppress an A -> B -> A replacement.
function sourceIsCurrentlySettled(writer,input){
 const source=validateSourceIdentity(input),key=sourceKey(source,mappingHash());
 const si=value(writer,importKeys.source(source.id));
 if(!si||si.sourceId!==source.id||si.mappingHash!==mappingHash()||!si.activeJobId)return false;
 const job=value(writer,importKeys.job(si.activeJobId));
 if(!job||job.sourceKey!==key||job.parserVersion!==PARSER_VERSION||job.mappingHash!==mappingHash())return false;
 if(job.status==='completed'){
  const imported=value(writer,importKeys.run(si.runId))?.imported;
  return si.publishedSourceKey===key&&imported?.sourceKey===key&&imported?.jobId===job.jobId&&imported?.parserVersion===PARSER_VERSION&&imported?.mappingHash===mappingHash();
 }
 if(job.status==='duplicate'&&job.duplicateRunId){
  const imported=value(writer,importKeys.run(job.duplicateRunId))?.imported;
  return !!(imported&&job.publishedContentKey&&job.publishedContentKey===JSON.stringify([imported.sourceSha256,imported.sourceIdentity?.size,PARSER_VERSION,mappingHash()])&&imported.parserVersion===PARSER_VERSION&&imported.mappingHash===mappingHash());
 }
 return false;
}
function completedQueueIsSettled({writer,store,state,canContinue=()=>true}){
 const version=importDirectoryVersion(writer);
 if(Number.isSafeInteger(state.completedDirectoryVersion)&&state.completedDirectoryVersion===version)return true;
 // Older completed scheduler records have no completion certificate. Verify a
 // bounded queue; a longer/unfinished queue goes through durable orchestration.
 let cursor=null,checked=0;
 do{if(!canContinue())return false;const page=store.listJobsPage({cursor,limit:1});if(page.jobs.some(job=>!terminal(job.status)))return false;checked+=page.jobs.length;cursor=page.nextCursor;}while(cursor&&checked<RECONCILIATION_LIMITS.jobs);
 return cursor===null;
}
function reconcileCompletedSources({writer,source,deadlineMs,canContinue=()=>true,cursor=null,now=()=>Date.now()}){
 let state=cursor?.phase==='scan'?{...cursor}:{phase:'scan',pageToken:null,index:0,pageHash:null,checkedAt:0},checked=0;
 for(let n=0;n<RECONCILIATION_LIMITS.pages;n++){
  if(!canContinue())return {unchanged:false,reason:'continue',cursor:state,checked};
  let page;
  try{page=source.listPage({pageToken:state.pageToken,deadlineMs});}
  catch(error){if(error?.code==='PAGE_TOKEN_REJECTED')return {unchanged:false,reason:'continue',cursor:{phase:'scan',pageToken:null,index:0,pageHash:null,checkedAt:0},checked};throw error;}
  const pageHash=hash([page.files,page.nextPageToken]);
  // A resumed page may have changed ordering/membership. Never skip its prefix
  // unless the exact bounded page fingerprint still matches.
  if(state.pageHash!==pageHash)state.index=0;
  state.pageHash=pageHash;
  for(let i=state.index;i<page.files.length;i++){
   if(checked>=RECONCILIATION_LIMITS.sources||!canContinue())return {unchanged:false,reason:'continue',cursor:state,checked};
   checked++;if(!sourceIsCurrentlySettled(writer,page.files[i]))return {unchanged:false,reason:'source-work',checked};
   state.index=i+1;
  }
  if(page.nextPageToken===null)return {unchanged:true,checked,cursor:{phase:'complete',pageToken:null,index:0,pageHash:null,checkedAt:now()}};
  state={phase:'scan',pageToken:page.nextPageToken,index:0,pageHash:null,checkedAt:0};
 }
 return {unchanged:false,reason:'continue',cursor:state,checked};
}
function createIdleScanThrottle(globals,config,{now,intervalMs}){
 // Actual server/script and pinned store identifiers only. No event input, URL,
 // source identity, filename, row, OAuth material, or arbitrary cache key.
 const scope=['mypace-idle-scan-v1',globals.ScriptApp.getScriptId(),config.writerScriptId,config.storeId,config.anchorId,config.datasetGeneration||'1'];
 const key='mypace-idle-'+hash(scope),duration=Math.min(intervalMs,RECONCILIATION_LIMITS.maxThrottleMs);
 const access=()=>{try{const c=globals.CacheService?.getScriptCache?.();return c&&['get','put','remove'].every(k=>typeof c[k]==='function')?c:null;}catch(_){return null;}};
 const clear=()=>{try{access()?.remove(key);}catch(_){/* Advisory eviction may fail. Current durable head still fences it. */}};
 const get=head=>{
  if(duration<1)return null;
  try{const raw=access()?.get(key);if(typeof raw!=='string'||raw.length>512)return null;const c=JSON.parse(raw),t=now();
   if(Object.keys(c).sort().join(',')!=='checkedAt,headHash,revision,schema'||c.schema!==1||c.headHash!==head.headHash||c.revision!==head.revision||!Number.isSafeInteger(c.checkedAt)||c.checkedAt<0||c.checkedAt>t||t-c.checkedAt>=duration)return null;
   return c.checkedAt+duration;
  }catch(_){return null;}
 };
 const remember=(head,checkedAt=now())=>{if(duration<1)return;try{access()?.put(key,JSON.stringify({schema:1,headHash:head.headHash,revision:head.revision,checkedAt}),Math.max(1,Math.ceil(duration/1000)));}catch(_){/* A miss repeats bounded authoritative reads. */}};
 return Object.freeze({get,remember,clear});
}

return {RECONCILIATION_LIMITS,importDirectoryVersion,sourceIsCurrentlySettled,completedQueueIsSettled,reconcileCompletedSources,createIdleScanThrottle};
})();
const m15 = (function(){
// Owner-editor only. No web handler, timer, trigger installer, or ambient work.
const {createGasImportRuntime} = m10;
const {encodeUtf8} = m1;
const {hashAssetBytes} = m4;
const {importKeys} = m8;
const {createDiscoveryStateIO} = m13;
const {RECONCILIATION_LIMITS,importDirectoryVersion,completedQueueIsSettled,reconcileCompletedSources,createIdleScanThrottle} = m14;
const KEY='import/owner-scheduler';
const hash=x=>hashAssetBytes(encodeUtf8(JSON.stringify(x)));
const fail=c=>{throw Error(c);};
const OWNER_LIMITS=Object.freeze({runtimeMs:120000,calls:2000,steps:16,rollingRuntimeMs:3600000,rollingCalls:12000});
// Read-only estimate from durable work reservations. This is not an account-wide
// quota meter. Choose the first expiry that can admit the specified profile.
function deriveImportBudgetWait(buckets,{nowMs,calls,runtimeMs,limits=OWNER_LIMITS}={}){
 if(!Number.isSafeInteger(nowMs)||nowMs<0||!Number.isSafeInteger(calls)||calls<1||calls>limits.calls||!Number.isSafeInteger(runtimeMs)||runtimeMs<1||runtimeMs>limits.runtimeMs||!Array.isArray(buckets)||buckets.length>32)fail('OWNER_BUDGET_STATE_INVALID');
 const hour=Math.floor(nowMs/3600000),active=[];let previous=-1;
 for(const b of buckets){if(!b||!Number.isSafeInteger(b.hour)||b.hour<0||b.hour<=previous||b.hour>hour||!Number.isSafeInteger(b.calls)||b.calls<0||!Number.isSafeInteger(b.ms)||b.ms<0)fail('OWNER_BUDGET_STATE_INVALID');previous=b.hour;if(b.hour>=hour-24)active.push(b);}
 let reservedCalls=active.reduce((n,b)=>n+b.calls,0),reservedMs=active.reduce((n,b)=>n+b.ms,0);
 if(!Number.isSafeInteger(reservedCalls)||!Number.isSafeInteger(reservedMs))fail('OWNER_BUDGET_STATE_INVALID');
 const fits=()=>reservedCalls+calls<=limits.rollingCalls&&reservedMs+runtimeMs<=limits.rollingRuntimeMs;
 if(fits())return null;
 for(const b of active){reservedCalls-=b.calls;reservedMs-=b.ms;if(fits())return {retryAt:(b.hour+25)*3600000};}
 fail('OWNER_BUDGET_STATE_INVALID');
}
// Counts actual external requests, including transport retries. Budget checks
// cannot interrupt an already running service call or bound its buffered body.
function meteredGas(globals,{now=()=>Date.now(),limits=OWNER_LIMITS,reserveMs=0,reserveCalls=0,deadlineMs}={}){
 const start=now();const absoluteCeiling=Math.min(start+limits.runtimeMs,deadlineMs??Infinity);let hardDeadline=absoluteCeiling;
 if(!Number.isSafeInteger(hardDeadline)||!Number.isSafeInteger(reserveMs)||reserveMs<0||reserveMs>=limits.runtimeMs||!Number.isSafeInteger(reserveCalls)||reserveCalls<0||reserveCalls>=limits.calls)fail('OWNER_BUDGET_INVALID');
 let calls=0,closed=false,closing=false,ceiling=limits.calls;
 const allowed=()=>{const t=now();return !closed&&Number.isSafeInteger(t)&&t>=start&&calls<(closing?ceiling:ceiling-reserveCalls)&&t<(closing?hardDeadline:hardDeadline-reserveMs);};
 const call=fn=>function(...args){if(!allowed())fail('OWNER_BUDGET_YIELD');calls++;return fn(...args);};
 const Files={};for(const key of ['get','list','create','generateIds','update'])Files[key]=call((...a)=>globals.Drive.Files[key](...a));
 return {globals:{...globals,Drive:{...globals.Drive,Files},UrlFetchApp:{...globals.UrlFetchApp,fetch:call((...a)=>globals.UrlFetchApp.fetch(...a))},now},checkBudget:allowed,get deadlineMs(){return hardDeadline-reserveMs;},get hardDeadlineMs(){return hardDeadline;},setRuntimeMs:(ms,headroomMs=reserveMs)=>{if(!Number.isSafeInteger(ms)||!Number.isSafeInteger(headroomMs)||headroomMs<0||ms<=headroomMs||ms>limits.runtimeMs||closing)fail('OWNER_BUDGET_INVALID');reserveMs=headroomMs;hardDeadline=Math.min(start+ms,absoluteCeiling);},usage:()=>({calls,elapsedMs:Math.max(0,now()-start)}),limitRemaining:n=>{if(!Number.isSafeInteger(n)||n<0)fail('OWNER_BUDGET_INVALID');ceiling=Math.min(ceiling,calls+n);closing=true;return ceiling;},close:()=>{closed=true;}};
}
function createOwnerScheduler(globals,config,{now=()=>Date.now(),limits=OWNER_LIMITS,deadlineMs,scanIntervalMs=0,reserveMs,scheduledPolicy,settleCalls=256}={}){
 if(!Number.isSafeInteger(settleCalls)||settleCalls<16||settleCalls>256)fail('OWNER_SETTLE_CALLS_INVALID');
 if(!Number.isSafeInteger(scanIntervalMs)||scanIntervalMs<0||scanIntervalMs>86400000)fail('OWNER_SCAN_INTERVAL_INVALID');
 for(const k of Object.keys(OWNER_LIMITS))if(!Number.isSafeInteger(limits[k])||limits[k]<1||limits[k]>OWNER_LIMITS[k])fail('OWNER_LIMITS_INVALID');
 // Manual work also needs enough closing time for the final durable status
 // and a quiescent checkpoint, even when a service call is slow.
 reserveMs=reserveMs??(scheduledPolicy?Math.min(15000,Math.floor(limits.runtimeMs/8)):Math.min(30000,Math.floor(limits.runtimeMs/4))); 
 if(!Number.isSafeInteger(reserveMs)||reserveMs<0||reserveMs>limits.runtimeMs/2)fail('OWNER_RESERVE_INVALID');
 if(scheduledPolicy&&(!Number.isSafeInteger(scheduledPolicy.sliceMs)||scheduledPolicy.sliceMs<30000||scheduledPolicy.sliceMs>60000||!Number.isSafeInteger(scheduledPolicy.rangeBytes)||scheduledPolicy.rangeBytes<1||scheduledPolicy.rangeBytes>1048576||(!Number.isSafeInteger(scheduledPolicy.maxFreshOutputs)||scheduledPolicy.maxFreshOutputs<1||scheduledPolicy.maxFreshOutputs>64)||scheduledPolicy.maxStalls!==3||(scheduledPolicy.catchUp!==undefined&&typeof scheduledPolicy.catchUp!=='boolean')||limits.runtimeMs!==OWNER_LIMITS.runtimeMs||reserveMs>=scheduledPolicy.sliceMs))fail('OWNER_SCHEDULED_POLICY_INVALID');
 const meter=meteredGas(globals,{now,limits,deadlineMs,reserveMs,reserveCalls:Math.min(settleCalls,Math.floor(limits.calls/2))});
 if(scheduledPolicy&&!scheduledPolicy.catchUp)meter.setRuntimeMs(scheduledPolicy.sliceMs);
 const runtime=createGasImportRuntime(meter.globals,{...config,checkBudget:meter.checkBudget,deadlineMs:scheduledPolicy?undefined:meter.deadlineMs,protocolReadCache:{mode:'lock-phase'}});
 const {writer,store,runner,source,locked}=runtime;
 const idleThrottle=createIdleScanThrottle(globals,config,{now,intervalMs:scanIntervalMs});
 const discovery=createDiscoveryStateIO(meter.globals,config,{checkBudget:meter.checkBudget,now});
 const read=()=>{store.recoveryBarrier();return writer.get(KEY);};
 const write=(entry,value,label)=>{
  const version=entry?.version||0;const digest=hash(value);
  writer.transact({operationId:'sched_'+hash([version,label,digest]),epoch:'default',digest,changes:[{key:KEY,expectedVersion:version,value}],result:{status:value.status}});
  return {version:version+1,value};
 };
 const initial=()=>({schema:1,generation:0,status:'idle',scanId:null,cursor:null,queueStarted:false,cycleActive:false,attempt:0,retryAt:0,error:null,lastJob:null,completedAt:null,buckets:[]});
 const view=s=>({status:s.status,scanId:s.scanId,nextJob:s.cursor,retryAt:s.retryAt,error:s.error,lastJob:s.lastJob||null,completedAt:s.completedAt??null,nextScanAt:s.status==='complete'&&Number.isSafeInteger(s.completedAt)?s.completedAt+scanIntervalMs:null,reservedCalls:s.buckets.reduce((n,b)=>n+b.calls,0),reservedRuntimeMs:s.buckets.reduce((n,b)=>n+b.ms,0),usage:meter.usage(),...(scheduledPolicy?{scheduledFallback:s.scheduledFallback||null,requiresOwnerAction:s.status==='blocked',processingMode:s.status==='blocked'?'paused':['idle','complete'].includes(s.status)?'idle':s.processingMode||'check',allowanceMs:s.allowanceMs??null}:{} )});
 function status(){return locked(()=>{const e=read();return view(e?.value||initial());});}
 function blockDiscovery(entry,s,code){
  idleThrottle.clear();s.resumeStatus='complete';s.status='blocked';s.error=code;s.retryAt=0;s.processingMode='paused';write(entry,s,'discovery-blocked');
  return {...view(s),requiresOwnerAction:true,reconciliation:'blocked',discoveryError:code,errorPersisted:true};
 }
 function run(startNew){return locked(()=>{
  let entry=read(),s=entry?.value||initial();
  if(s.schema!==1)fail('OWNER_STATE_SCHEMA');
  if(startNew!=='tick')idleThrottle.clear();
  if(startNew==='tick'){
   if(scheduledPolicy&&s.status==='complete'){
    const before=meter.usage(),canReconcile=()=>meter.checkBudget()&&meter.usage().calls-before.calls<RECONCILIATION_LIMITS.additionalCalls&&meter.usage().elapsedMs-before.elapsedMs<Math.floor(scheduledPolicy.sliceMs/4);
    if(!completedQueueIsSettled({writer,store,state:s,canContinue:canReconcile})){
     // A newly queued/manual unfinished job cannot be hidden by a completed
     // timestamp or CacheService. Resume the authoritative queue immediately.
     idleThrottle.clear();s.status='importing';s.cursor=null;s.queueStarted=false;s.cycleActive=false;startNew=false;
    }else{
     const head=writer.status(),cachedNextScanAt=idleThrottle.get(head);
     if(cachedNextScanAt!==null)return {...view(s),nextScanAt:cachedNextScanAt,reconciliation:'cached-idle'};
     if(Number.isSafeInteger(s.completedAt)&&now()<s.completedAt+scanIntervalMs)return view(s);
     let reconciled,cursor=null;
     if(discovery){
      try{cursor=discovery.read(head);}catch(error){
       const rawCode=error?.code||error?.message,code=/^[A-Z0-9_]{1,80}$/.test(rawCode)?rawCode:'DISCOVERY_STATE_READ_UNRESOLVED';
       if(['WRITER_RECOVERY_PENDING','WRITER_RECOVERY_SETUP_REQUIRED'].includes(code))throw error;
       if(error?.retryable===true||['OWNER_BUDGET_YIELD','STORE_YIELD'].includes(code))return {...view(s),reconciliation:'deferred',discoveryError:code,retryable:true,retryAt:now()+900000};
       // A permission/identity/ownership failure is new actionable state. Save
       // exactly one blocked status so the app cannot keep reporting a healthy
       // completed import forever. Further ticks read it without more writes.
       return blockDiscovery(entry,s,code);
      }
      if(cursor?.phase==='complete'&&now()<cursor.checkedAt+scanIntervalMs){idleThrottle.remember(head,cursor.checkedAt);return {...view(s),nextScanAt:cursor.checkedAt+scanIntervalMs,reconciliation:'recorded-idle'};}
     }
     try{reconciled=reconcileCompletedSources({writer,source,deadlineMs:meter.deadlineMs,canContinue:canReconcile,cursor,now});}
     catch(error){
      // A rejected/expired listing token or inconclusive read is not a proof of
      // completion. The durable bounded scanner retains the normal retry path.
      const code=error?.code||error?.message;
      if(['PAGE_TOKEN_REJECTED','PAGE_TOKEN_STALLED','TRANSPORT_YIELD','OWNER_BUDGET_YIELD','STORE_YIELD'].includes(code))reconciled={unchanged:false,reason:'continue',cursor:cursor?.phase==='scan'?cursor:{phase:'scan',pageToken:null,index:0,pageHash:null,checkedAt:0}};
      else reconciled={unchanged:false,reason:'source-work'};
     }
     if(reconciled.unchanged||reconciled.reason==='continue'&&discovery){
      let discoverySaved=false;
      if(discovery)try{discovery.write(head,reconciled.cursor);discoverySaved=true;}catch(error){
       // A lost successful response is resolved using one bounded authenticated
       // read of this exact fixed ID, head and cursor, never a replacement ID.
       try{const observed=discovery.read(head);discoverySaved=!!observed&&Object.keys(reconciled.cursor).every(key=>observed[key]===reconciled.cursor[key]);}catch(_){/* No proof of saved progress. */}
       if(!discoverySaved){const rawCode=error?.code||error?.message,code=/^DISCOVERY_STATE_[A-Z0-9_]{1,60}$/.test(rawCode)?rawCode:'DISCOVERY_STATE_WRITE_UNRESOLVED';return blockDiscovery(entry,s,code);}
      }
      if(reconciled.unchanged)idleThrottle.remember(head);
      return {...view(s),nextScanAt:reconciled.unchanged?now()+scanIntervalMs:now(),reconciliation:reconciled.unchanged?'unchanged':'scanning',checkedSources:reconciled.checked||0,...(discovery?{discoverySaved}:{})};
     }
     // New/changed source work enters the existing durable pipeline. Legacy
     // stores without an authenticated discovery pin retain bounded scans;
     // only an explicit owner setup can add that fixed mutable advisory file.
     idleThrottle.clear();startNew=true;
    }
   }else{
    if(s.status==='complete'&&Number.isSafeInteger(s.completedAt)&&now()<s.completedAt+scanIntervalMs)return view(s);
    startNew=['idle','complete'].includes(s.status);
   }
  }
  if(startNew&&['scanning','importing','retry','blocked'].includes(s.status))return view(s);
  if(!startNew&&['idle','complete','blocked'].includes(s.status))return view(s);
  if(!startNew&&now()<s.retryAt)return view(s);
  // A durable queued job may select the owner-approved catch-up profile. Idle
  // and new-scan checks stay short. Existing oversized reservations keep their
  // exact bytes/IDs and one finishing step. The selected full allowance and
  // no-progress attempt are both reserved in Drive BEFORE any import work.
  let runtimeAllowance=scheduledPolicy?scheduledPolicy.sliceMs:limits.runtimeMs,stepAllowance=limits.steps,fallback=null;
  if(scheduledPolicy)s.processingMode='check';
  if(scheduledPolicy&&!startNew&&(s.status==='importing'||s.resumeStatus==='importing')){
   const head=store.listJobsPage({cursor:s.cursor,limit:1}).jobs[0];
   const job=head?writer.get(importKeys.job(head.jobId))?.value:null;
   const pending=job?.pending?writer.get(importKeys.pin(job.pending))?.value:null;
   if(job&&!['completed','duplicate','cancelled'].includes(job.status)){
    const marker=hash([job.jobId,job.status,job.pending,job.progress.offset,job.finalization?.cursor||null]);
    const attempts=s.scheduledStall?.marker===marker?s.scheduledStall.attempts:0;
    if(attempts>=scheduledPolicy.maxStalls){s.resumeStatus=s.status==='retry'?s.resumeStatus:s.status;s.status='blocked';s.error='SCHEDULED_NO_PROGRESS';s.retryAt=0;s.processingMode='paused';write(entry,s,'scheduled-stalled');return view(s);}
    s.scheduledStall={marker,attempts:attempts+1};
    if(scheduledPolicy.catchUp){
     runtimeAllowance=limits.runtimeMs;stepAllowance=OWNER_LIMITS.steps;
     meter.setRuntimeMs(runtimeAllowance,15000);runner.finalizationBatchLimit=4;
     writer.limits.checkpointEvery=16;s.processingMode='catch-up';
    }
   }else s.scheduledStall=null;
   if(pending&&(pending.transition.progress.offset-job.progress.offset>scheduledPolicy.rangeBytes||pending.assets.filter(a=>a.role==='output').length>scheduledPolicy.maxFreshOutputs))fallback={jobId:job.jobId,pinId:pending.pinId,stage:'stage'};
   else if(job?.status==='verifying'&&job.finalization?.cursor){
    const pin=writer.get(importKeys.pin(job.finalization.cursor))?.value;
    if(pin?.assets?.filter(a=>a.role==='output').length>scheduledPolicy.maxFreshOutputs)fallback={jobId:job.jobId,pinId:job.finalization.cursor,stage:'verify'};
   }
   if(fallback){
    s.scheduledFallback={...fallback,attempts:s.scheduledStall.attempts};runtimeAllowance=limits.runtimeMs;meter.setRuntimeMs(runtimeAllowance,5000);runner.finalizationBatchLimit=1;writer.limits.checkpointEvery=4;s.processingMode='oversized-resume';
   }else s.scheduledFallback=null;
  }
  if(scheduledPolicy&&scheduledPolicy.catchUp&&runtimeAllowance===scheduledPolicy.sliceMs){
   // State must be authenticated/recovered before selecting a workload. The
   // bounded cold-recovery phase can need the existing 120s cap on retained
   // history. A rare slow recovery admits only one repair/new-scan step rather
   // than repeatedly starving before it can inspect durable queued work.
   if(meter.usage().elapsedMs+reserveMs>=scheduledPolicy.sliceMs){runtimeAllowance=limits.runtimeMs;stepAllowance=1;s.processingMode='recovery';meter.setRuntimeMs(runtimeAllowance,15000);}
   else meter.setRuntimeMs(runtimeAllowance,reserveMs);
  }
  if(scheduledPolicy)s.allowanceMs=runtimeAllowance;
  s.budgetProfile={calls:limits.calls,checkMs:scheduledPolicy?scheduledPolicy.sliceMs:limits.runtimeMs,catchUp:!!scheduledPolicy?.catchUp,catchUpMs:limits.runtimeMs};
  const hour=Math.floor(now()/3600000);s.buckets=s.buckets.filter(b=>b.hour>=hour-24);
  if(s.buckets.some(b=>b.hour>hour))fail('OWNER_CLOCK_REGRESSED');
  const calls=s.buckets.reduce((n,b)=>n+b.calls,0),ms=s.buckets.reduce((n,b)=>n+b.ms,0);
  if(calls+limits.calls>limits.rollingCalls||ms+runtimeAllowance>limits.rollingRuntimeMs)return {...view(s),status:'budget-wait',retryAt:(s.buckets[0].hour+25)*3600000};
  let b=s.buckets.find(b=>b.hour===hour);if(!b){b={hour,calls:0,ms:0};s.buckets.push(b);}b.calls+=limits.calls;b.ms+=runtimeAllowance;
  if(startNew){s.generation++;s.scanId='owner_scan_'+s.generation;s.status='scanning';s.cursor=null;s.queueStarted=false;s.cycleActive=false;s.error=null;s.lastJob=null;s.completedAt=null;}
  else if(s.status==='retry')s.status=s.resumeStatus;
  s.retryAt=0;entry=write(entry,s,'reserve'); // Conservative full reservation survives a hard kill.
  let settled=false;
  const settle=()=>{if(settled)return;settled=true;const ceiling=meter.limitRemaining(settleCalls);b.calls-=limits.calls-ceiling;};
  // Each reservation gets its own quiescent cut. Reusing a scan-only operation
  // ID would replay an old receipt instead of sealing later progress. The cut
  // is authoritative Drive state; the optional hint only accelerates finding it.
  const reservationVersion=entry.version;
  const seal=()=>writer.checkpoint({operationId:'owner_slice_'+hash([s.scanId,reservationVersion]),epoch:'default',digest:hash(['scheduled-quiescent',s.scanId,reservationVersion]),result:{scanId:s.scanId,reservationVersion}});
  const manualSealedView=()=>{
   try{seal();return {...view(s),checkpointReady:true};}
   catch(error){return {...view(s),checkpointReady:false,checkpointError:/^[A-Z0-9_]{1,80}$/.test(error.code||error.message)?error.code||error.message:'CHECKPOINT_PENDING',requiresOwnerAction:true};}
  }; 
  try{
   if(startNew)store.beginScan({operationId:'owner_begin_'+s.generation,scanId:s.scanId});
   // Repair an interruption after scheduler reservation but before scan creation.
   else if(s.status==='scanning')store.beginScan({operationId:'owner_begin_'+s.generation,scanId:s.scanId});
   for(let n=0;n<(fallback?1:stepAllowance);n++){
    if(!meter.checkBudget())fail('OWNER_BUDGET_YIELD');
    if(s.status==='scanning'){
     runner.stepScan(s.scanId,{deadlineMs:meter.deadlineMs});
     if(store.getScan(s.scanId).done){s.status='importing';s.cursor=null;s.queueStarted=false;s.cycleActive=false;}
    }else{
     store.recoveryBarrier();const page=store.listJobsPage({cursor:s.cursor,limit:1});
     if(!page.jobs.length){s.status='complete';break;}
     const job=page.jobs[0];s.queueStarted=true;
     if(!['completed','duplicate','cancelled'].includes(job.status)){
      s.cycleActive=true;
      if(job.status==='active')runner.stepJob(job.jobId,{deadlineMs:meter.deadlineMs});else runner.finalizeJobStep(job.jobId);
      const observed=store.getJob(job.jobId);s.lastJob={jobId:observed.jobId,status:observed.status,progress:observed.progress};
     }
     s.cursor=page.nextCursor;
     if(s.cursor===null){if(!s.cycleActive){s.status='complete';break;}s.cycleActive=false;s.queueStarted=false;}
    }
    // Runner steps have their own durable/idempotent checkpoints. Persist the
    // scheduler cursor once at the end; a kill replays safe terminal/scan reads.
    s.attempt=0;s.error=null;if(scheduledPolicy)s.scheduledStall=null;if(fallback)s.scheduledFallback=null;
    if(s.status==='complete')break;
   }
   // Seal a quiescent import cut before the final scheduler frame. Cold app
   // reads then replay only the checkpoint publication plus this finish frame.
   if(s.status==='complete'){s.completedDirectoryVersion=importDirectoryVersion(writer);s.completedAt=now();s.error=null;s.attempt=0;s.retryAt=0;if(scheduledPolicy)s.processingMode='idle';}
   settle();if(scheduledPolicy)seal();entry=write(entry,s,'finish');return scheduledPolicy?view(s):manualSealedView();
  }catch(e){
   // Retain the exact scan/job cursor and all pins. Changed/missing sources,
   // unsupported identities and structural faults require owner review.
   const code=e.code||e.message||'OWNER_OPERATION_FAILED';
   if(['WRITER_RECOVERY_PENDING','WRITER_RECOVERY_SETUP_REQUIRED'].includes(code))throw e;
   const retry=e.retryable===true||(code==='RETRY_EXHAUSTED'&&[403,429,500,502,503,504].includes(e.status))||['IMPORT_YIELD','TRANSPORT_YIELD','STORE_YIELD','OWNER_BUDGET_YIELD','RATE_LIMITED','DRIVE_REQUEST_FAILED','WRITER_BUSY'].includes(code);
   s.resumeStatus=s.status;s.status=retry?'retry':'blocked';s.attempt=Math.min(10,s.attempt+1);s.retryAt=retry?now()+Math.min(3600000,1000*2**s.attempt):0;
   s.error=/^[A-Z0-9_]{1,80}$/.test(code)?code:'OWNER_OPERATION_FAILED';
   settle();try{if(scheduledPolicy)seal();entry=write(entry,s,'error');}catch(_){return {...view(s),errorPersisted:false};}
   return {...(scheduledPolicy?view(s):manualSealedView()),errorPersisted:true};
  }
 });}
 // Review acknowledgement retries the same source/cursor. It never discards or
 // cancels a pending generation, adopts a new checksum, or overwrites history.
 function retryBlocked(){return locked(()=>{idleThrottle.clear();let e=read();if(!e||e.value.status!=='blocked')return view(e?.value||initial());const s=e.value;s.status=s.resumeStatus;s.error=null;s.retryAt=0;s.scheduledStall=null;s.scheduledFallback=null;write(e,s,'owner-retry');return view(s);});}
 function restartChangedSource(){return locked(()=>{
  idleThrottle.clear();const e=read();if(!e||e.value.status!=='blocked'||!['SOURCE_CHANGED','SOURCE_NOT_FOUND','SOURCE_JOB_ACTIVE'].includes(e.value.error))fail('OWNER_SOURCE_REVIEW_REQUIRED');
  const s=e.value;let jobId;
  if(s.resumeStatus==='scanning'){
   const next=store.nextScanEntry(s.scanId);if(!next)fail('OWNER_SOURCE_REVIEW_REQUIRED');
   jobId=writer.get(importKeys.source(next.sourceIdentity.id))?.value?.activeJobId;
  }else jobId=store.listJobsPage({cursor:s.cursor,limit:1}).jobs[0]?.jobId;
  if(!jobId)fail('OWNER_SOURCE_REVIEW_REQUIRED');
  const job=store.getJob(jobId);
  if(job.status!=='cancelled')store.cancelJob({operationId:'owner_cancel_'+hash([s.generation,jobId]),jobId});
  s.status='idle';s.error=null;s.retryAt=0;s.cursor=null;
  write(e,s,'owner-cancel-source');return view(s);
 });}
 // Recovery has not established an authoritative app/scheduler snapshot yet.
 // Expose only bounded recovery progress; never synthesize idle/complete state
 // or append a business error frame while this barrier is still pending.
 function recoveryResult(action){
  try{return action();}catch(error){
   const code=error?.code||error?.message;
   if(code==='WRITER_RECOVERY_PENDING')return {status:'recovering',processingMode:'recovery',retryable:true,requiresOwnerAction:false,error:code,indexLinks:error.indexLinks,scannedLinks:error.scannedLinks,cursorPersisted:error.cursorPersisted===true,usage:meter.usage()};
   if(code==='WRITER_RECOVERY_SETUP_REQUIRED')return {status:'blocked',processingMode:'paused',retryable:false,requiresOwnerAction:true,error:code,usage:meter.usage()};
   throw error; // Integrity corruption is not a retry or an empty store.
  }
 }
 return Object.freeze({start:()=>recoveryResult(()=>run(true)),resume:()=>recoveryResult(()=>run(false)),tick:()=>recoveryResult(()=>run('tick')),status:()=>recoveryResult(status),retryBlocked,restartChangedSource});
}

return {OWNER_LIMITS,deriveImportBudgetWait,meteredGas,createOwnerScheduler};
})();
const m16 = (function(){
// Trusted owner time-trigger boundary. No HTTP dispatcher, trigger installer,
// background work on load, or progress in ScriptProperties. Event shape rejects
// accidental/wrong entry paths; it is NOT authentication. The actual effective
// execution identity and immutable script/store pins remain authoritative.
const {OWNER_STORE_PROPERTY,parsePinnedOwnerStoreConfig} = m12;
const {createGasCheckpointHintCodec} = m5;
const {createGasDiscoveryStateCodec} = m13;
const {createOwnerScheduler,OWNER_LIMITS} = m15;
const SCHEDULED_OWNER_EMAIL='yakitorihanbagu0412@gmail.com';
const SCHEDULED_DEFAULTS=Object.freeze({sliceMs:60000,calls:750,steps:3,rangeBytes:1048576,scanIntervalMs:3600000,catchUp:true});
const fail=code=>{const e=Error(code);e.code=code;throw e;};
const normalized=x=>typeof x==='string'?x.trim().toLowerCase():'';
const integer=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
function optionsFor(options){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['now',...Object.keys(SCHEDULED_DEFAULTS)].includes(k)))fail('SCHEDULED_CONFIG_INVALID');
 const c={...SCHEDULED_DEFAULTS,...options};
 if(!integer(c.sliceMs,30000,60000)||!integer(c.calls,256,1000)||!integer(c.steps,1,4)||!integer(c.rangeBytes,16384,1048576)||!integer(c.scanIntervalMs,900000,86400000)||typeof c.catchUp!=='boolean'||(c.now!==undefined&&typeof c.now!=='function'))fail('SCHEDULED_CONFIG_INVALID');
 return c;
}
function assertClockEvent(globals,event){
 const full=globals?.ScriptApp?.AuthMode?.FULL;
 if(full===undefined||!event||typeof event!=='object'||Array.isArray(event)||event.authMode!==full||typeof event.triggerUid!=='string'||!/^\d{1,128}$/.test(event.triggerUid)||['parameter','parameters','postData','queryString','source','calendarId','response'].some(k=>k in event))fail('SCHEDULED_EVENT_REQUIRED');
 const fields=[['year',1970,9999],['month',1,12],['day-of-month',1,31],['day-of-week',1,7],['hour',0,23],['minute',0,59],['second',0,59]];
 if(fields.some(([k,min,max])=>!integer(event[k],min,max))||typeof event.timezone!=='string'||event.timezone.length<1||event.timezone.length>128||/[\0\r\n]/.test(event.timezone))fail('SCHEDULED_EVENT_REQUIRED');
}
function guardedConfig(globals,event){
 assertClockEvent(globals,event);
 const {Session,ScriptApp,PropertiesService}=globals||{};
 if(typeof Session?.getEffectiveUser!=='function'||typeof ScriptApp?.getScriptId!=='function'||typeof PropertiesService?.getScriptProperties!=='function')fail('SCHEDULED_IDENTITY_UNAVAILABLE');
 let effective,active='';
 try{
  effective=normalized(Session.getEffectiveUser().getEmail());
  // Active user is normally unavailable for a clock trigger. If supplied by
  // GAS, a contradictory identity still fails closed. Never read e.user.
  if(typeof Session.getActiveUser==='function')active=normalized(Session.getActiveUser().getEmail());
 }catch(_){fail('SCHEDULED_OWNER_UNVERIFIED');}
 if(effective!==SCHEDULED_OWNER_EMAIL||(active!==''&&active!==SCHEDULED_OWNER_EMAIL))fail('SCHEDULED_OWNER_UNVERIFIED');
 const writerScriptId=ScriptApp.getScriptId();
 let raw;try{raw=PropertiesService.getScriptProperties().getProperty(OWNER_STORE_PROPERTY);}catch(_){fail('SCHEDULED_CONFIG_UNRESOLVED');}
 const config=parsePinnedOwnerStoreConfig(raw,{ownerEmail:SCHEDULED_OWNER_EMAIL,writerScriptId,datasetGeneration:'1',acceptedEpochs:['default']});
 if(!config)fail('OWNER_BOOTSTRAP_REQUIRED');
 if(ScriptApp.getScriptId()!==writerScriptId)fail('SCHEDULED_SCRIPT_MISMATCH');
 // The existing owner-managed server secret is only read after all identity
 // and pinned-configuration guards. Never return/log it or persist progress in
 // properties. Legacy stores/no secret keep conservative anchor recovery.
 if(config.checkpointHintId||config.discoveryStateId){
  const secret=PropertiesService.getScriptProperties().getProperty('MYPACE_WRITER_SECRET');
  if(secret!==null&&secret!==undefined&&secret!=='')return {...config,...(config.checkpointHintId?{checkpointHintCodec:createGasCheckpointHintCodec({Utilities:globals.Utilities,secret})}:{}),...(config.discoveryStateId?{discoveryStateCodec:createGasDiscoveryStateCodec({Utilities:globals.Utilities,secret})}:{})};
 }
 return config;
}
function createScheduledImportRuntime(globals,options={}){
 const settings=optionsFor(options); // Construction is pure; check each tick.
 return Object.freeze({tick:event=>{
  const now=settings.now||(()=>Date.now()),started=now();
  const config=guardedConfig(globals,event);
  const limits={...OWNER_LIMITS,runtimeMs:OWNER_LIMITS.runtimeMs,calls:settings.calls,steps:settings.steps};
  const scheduler=createOwnerScheduler(globals,{...config,rangeBytes:settings.rangeBytes,finalizationBatchLimit:1,maxFreshOutputs:8,writerLimits:{checkpointEvery:settings.catchUp?16:(config.checkpointHintCodec?4:16)}},{now,deadlineMs:started+OWNER_LIMITS.runtimeMs,limits,scanIntervalMs:settings.scanIntervalMs,reserveMs:Math.min(15000,Math.floor(settings.sliceMs/4)),settleCalls:128,scheduledPolicy:{sliceMs:settings.sliceMs,rangeBytes:settings.rangeBytes,maxFreshOutputs:8,maxStalls:3,catchUp:settings.catchUp}});
  const result=scheduler.tick();result.usage.elapsedMs=Math.max(0,now()-started);return result;
 }});
}

return {SCHEDULED_OWNER_EMAIL,SCHEDULED_DEFAULTS,createScheduledImportRuntime};
})();
const m17 = (function(){
// Authenticated dispatcher read adapter. Cursors must be authenticated by the
// trusted caller; no Drive file ID or checkpoint reference is accepted from UI.
const {importKeys} = m8;
const {decodeUtf8,encodeUtf8} = m1;
const {LIMITS} = m2;
const ROUTE_POINTS=1024,ROUTE_BYTES=262144,ROUTE_HEADROOM=32768;
const {deriveImportBudgetWait,OWNER_LIMITS} = m15;
const fail=c=>{throw Error(c);};
const token=(x,max=100)=>typeof x==='string'&&x.length>0&&x.length<=max&&/^[A-Za-z0-9_-]+$/.test(x);
const scalar=(x,min=0)=>Number.isSafeInteger(x)&&x>=min;
const validTime=t=>typeof t==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(t)&&Number.isFinite(Date.parse(t))&&new Date(Date.parse(t)).toISOString().slice(0,19)===t.slice(0,19);
const record=x=>x&&Object.getPrototypeOf(x)===Object.prototype;
function point(line){let p;try{p=JSON.parse(line);}catch(_){fail('IMPORT_ROUTE_INVALID');}
 if(!record(p)||!Object.keys(p).every(k=>['time','lat','lon','altitude','speed'].includes(k))||!validTime(p.time)||typeof p.lat!=='number'||!Number.isFinite(p.lat)||p.lat< -90||p.lat>90||typeof p.lon!=='number'||!Number.isFinite(p.lon)||p.lon< -180||p.lon>180)fail('IMPORT_ROUTE_INVALID');
 if('altitude' in p&&(typeof p.altitude!=='number'||!Number.isFinite(p.altitude)||p.altitude< -20000||p.altitude>100000))fail('IMPORT_ROUTE_INVALID');
 if('speed' in p&&p.speed!==null&&(typeof p.speed!=='number'||!Number.isFinite(p.speed)||p.speed<0||p.speed>10000))fail('IMPORT_ROUTE_INVALID');return p;
}
function createImportReader({runtime,sealCursor,openCursor,now=()=>Date.now()}){
 if(!runtime?.writer||!runtime?.store||typeof runtime.locked!=='function'||typeof sealCursor!=='function'||typeof openCursor!=='function'||typeof now!=='function')fail('IMPORT_READER_CONFIG');
 const {writer,store,locked}=runtime;
 const entity=key=>{const e=writer.get(key);if(!e||e.deleted)fail('IMPORT_READ_NOT_FOUND');return e.value;};
 function revision(expected){store.recoveryBarrier();const r=writer.status().revision;if(!scalar(r))fail('IMPORT_REVISION_INVALID');if(expected!==undefined&&expected!==null&&expected!==r)fail('CURSOR_REVISION_CHANGED');return r;}
 function cursor(value,kind,r){if(value===null)return null;if(typeof value!=='string'||value.length===0||value.length>4096)fail('IMPORT_CURSOR_INVALID');let c;try{c=openCursor(value);}catch(_){fail('IMPORT_CURSOR_INVALID');}if(!record(c)||c.kind!==kind)fail('IMPORT_CURSOR_INVALID');if(c.revision!==r)fail('CURSOR_REVISION_CHANGED');return c;}
 function published(runId,i,job){
  if(!record(i)||!token(i.jobId)||!token(i.assetsRoot)||!record(job)||job.storeId!==store.storeId||job.jobId!==i.jobId||job.status!=='completed'||job.pinActive!==false||job.runId!==runId||job.firstPin!==i.assetsRoot||!token(job.lastPin)||!scalar(job.batchCount,1))fail('IMPORT_RUN_NOT_PUBLISHED');
 }
 function status({revision:expected}={}){return locked(()=>{
  const r=revision(expected),entry=writer.get('import/owner-scheduler');
  if(!entry||entry.deleted)return {revision:r,status:'idle',retryAt:0,error:null,lastJob:null,processingMode:'idle',allowanceMs:null,requiresOwnerAction:false};
  const s=entry.value;if(!record(s)||s.schema!==1||!['idle','scanning','importing','retry','blocked','complete'].includes(s.status)||!scalar(s.retryAt)||s.error!==null&&!(typeof s.error==='string'&&/^[A-Z0-9_]{1,80}$/.test(s.error)))fail('IMPORT_STATUS_INVALID');
  let lastJob=null;if(s.lastJob!==null&&s.lastJob!==undefined){
   const j=s.lastJob,p=j?.progress;if(!record(j)||!['active','parsed','verifying','verified','duplicate','completed','cancelled'].includes(j.status)||!record(p))fail('IMPORT_STATUS_INVALID');
   const progress={};for(const k of ['offset','batch','points','normalizedBytes','rows','comments','nonIncreasingTimes']){if(!scalar(p[k]))fail('IMPORT_STATUS_INVALID');progress[k]=p[k];}
   for(const k of ['firstTime','lastTime']){if(p[k]!==null&&!validTime(p[k]))fail('IMPORT_STATUS_INVALID');progress[k]=p[k];}
   if(typeof p.complete!=='boolean')fail('IMPORT_STATUS_INVALID');progress.complete=p.complete;lastJob={status:j.status,progress};
  }
  const mode=s.status==='blocked'?'paused':['idle','complete'].includes(s.status)?'idle':s.processingMode??'check';
  if(!['check','catch-up','oversized-resume','recovery','paused','idle'].includes(mode)||s.allowanceMs!==undefined&&s.allowanceMs!==null&&(!scalar(s.allowanceMs,1)||s.allowanceMs>120000))fail('IMPORT_STATUS_INVALID');
  let budgetWait=null;
  if(['scanning','importing','retry'].includes(s.status)&&s.buckets!==undefined){
   const profile=s.budgetProfile??{calls:s.processingMode?750:OWNER_LIMITS.calls,checkMs:s.processingMode?60000:OWNER_LIMITS.runtimeMs,catchUp:!!s.processingMode,catchUpMs:OWNER_LIMITS.runtimeMs};
   if(!record(profile)||typeof profile.catchUp!=='boolean'||!scalar(profile.checkMs,1)||profile.checkMs>120000||!scalar(profile.catchUpMs,1)||profile.catchUpMs>120000)fail('IMPORT_STATUS_INVALID');
   let allowance=profile.checkMs;
   if(profile.catchUp&&(s.status==='importing'||s.resumeStatus==='importing')){
    const next=store.listJobsPage({cursor:s.cursor??null,limit:1}).jobs[0];
    if(next&&!['completed','duplicate','cancelled'].includes(next.status))allowance=profile.catchUpMs;
   }else if(s.processingMode==='oversized-resume'||s.processingMode==='recovery')allowance=s.allowanceMs??profile.catchUpMs;
   try{budgetWait=deriveImportBudgetWait(s.buckets,{nowMs:now(),calls:profile.calls,runtimeMs:allowance});}catch(_){fail('IMPORT_STATUS_INVALID');}
  }
  return {revision:r,status:budgetWait?'budget-wait':s.status,retryAt:budgetWait?Math.max(s.retryAt,budgetWait.retryAt):s.retryAt,error:s.error,lastJob,processingMode:mode,allowanceMs:s.allowanceMs??null,requiresOwnerAction:s.status==='blocked'};
 });}
 function listImportedRuns({cursor:encoded=null,revision:expected}={}){return locked(()=>{
  const r=revision(expected),c=cursor(encoded,'imports',r);if(c&&!token(c.jobId))fail('IMPORT_CURSOR_INVALID');
  const page=store.listJobsPage({cursor:c?.jobId||null,limit:16}),runs=[];
  for(const item of page.jobs){if(item.status!=='completed')continue;const job=entity(importKeys.job(item.jobId)),run=entity(importKeys.run(job.runId)),i=run.imported;
   if(i?.jobId!==job.jobId)continue;published(job.runId,i,job);
   if(!token(job.runId)||!scalar(i.sampleCount,1)||!validTime(i.firstTime)||!validTime(i.lastTime)||typeof i.normalizedSha256!=='string'||!/^[a-f0-9]{64}$/.test(i.normalizedSha256))fail('IMPORT_RUN_INVALID');
   runs.push({id:job.runId,kind:'imported-run',sampleCount:i.sampleCount,firstTime:i.firstTime,lastTime:i.lastTime,normalizedSha256:i.normalizedSha256,statistics:'samples-only-no-distance',routeAvailable:true});
  }
  return {revision:r,runs,nextCursor:page.nextCursor?sealCursor({kind:'imports',revision:r,jobId:page.nextCursor}):null};
 });}
 function readRoutePage({runId,cursor:encoded=null,revision:expected}={}){return locked(()=>{
  if(!token(runId))fail('IMPORT_RUN_INVALID');const r=revision(expected),run=entity(importKeys.run(runId)),i=run.imported;
  if(!i||!token(i.jobId)||!token(i.assetsRoot))fail('IMPORT_READ_NOT_FOUND');
  const job=entity(importKeys.job(i.jobId));published(runId,i,job);
  const c=cursor(encoded,'route',r);if(c&&(c.runId!==runId||c.jobId!==i.jobId||!token(c.pinId)||!scalar(c.output)||c.output>63||(c.pointOffset!==undefined&&(!scalar(c.pointOffset)||c.pointOffset>=LIMITS.points))||!scalar(c.pinIndex)||c.pinIndex>=job.batchCount||!(c.previousPin===null||token(c.previousPin))))fail('IMPORT_CURSOR_INVALID');
  const pinId=c?.pinId||i.assetsRoot,pinIndex=c?.pinIndex||0,pin=entity(importKeys.pin(pinId));
  if(pin.state!=='ready'||pin.pinId!==pinId||pin.jobId!==i.jobId||pin.storeId!==store.storeId||pin.previousPin!==(c?c.previousPin:null)||!Array.isArray(pin.assets)||pin.assets.length<2||pin.assets.length>66||pin.nextPin!==null&&!token(pin.nextPin)||pinIndex===0&&pinId!==i.assetsRoot||pinIndex===job.batchCount-1&&(pin.nextPin!==null||pinId!==job.lastPin)||pinIndex<job.batchCount-1&&(pin.nextPin===null||pin.nextPin===pinId))fail('IMPORT_ROUTE_PIN_INVALID');
  if(pin.assets.some(a=>!record(a)||!['output','checkpoint','manifest-page'].includes(a.role))||pin.assets.filter(a=>a.role==='checkpoint').length!==1||pin.assets.filter(a=>a.role==='manifest-page').length!==1)fail('IMPORT_ROUTE_PIN_INVALID');
  const outputs=pin.assets.filter(a=>a.role==='output'),index=c?.output||0;
  if(outputs.length>64||new Set(outputs.map(a=>a.fileId)).size!==outputs.length||outputs.some(a=>!token(a.fileId,128)||a.jobId!==i.jobId||a.pinId!==pinId||a.storeId!==store.storeId||!scalar(a.byteLength,1)||a.byteLength>262144||typeof a.sha256!=='string'||!/^[a-f0-9]{64}$/.test(a.sha256)))fail('IMPORT_ROUTE_PIN_INVALID');
  if(index>=outputs.length&&!(outputs.length===0&&index===0))fail('IMPORT_CURSOR_INVALID');
  const offset=c?.pointOffset??0;let points=[],withinOutput=false,nextOffset=0;
  if(outputs.length){
   const bytes=store._read(outputs[index]);if(bytes.length>LIMITS.output)fail('IMPORT_ROUTE_BOUND');
   const text=decodeUtf8(bytes);if(!text.endsWith('\n'))fail('IMPORT_ROUTE_INVALID');
   const lines=text.slice(0,-1).split('\n');if(lines.length>LIMITS.points)fail('IMPORT_ROUTE_BOUND');
   if(offset>=lines.length)fail('IMPORT_CURSOR_INVALID');
   // Validate the whole bounded immutable asset, while returning one small page.
   // The signed offset is meaningful only inside this revision/run/pin/output.
   const all=lines.map(point);let pageBytes=2;
   for(let n=offset;n<all.length&&points.length<ROUTE_POINTS;n++){
    const size=encodeUtf8(JSON.stringify(all[n])).length+(points.length?1:0);
    if(pageBytes+size>ROUTE_BYTES-ROUTE_HEADROOM)break;
    points.push(all[n]);pageBytes+=size;
   }
   if(!points.length)fail('IMPORT_ROUTE_BOUND');
   nextOffset=offset+points.length;withinOutput=nextOffset<all.length;
  }else if(offset!==0)fail('IMPORT_CURSOR_INVALID');
  const more=withinOutput||index+1<outputs.length,nextPin=more?pin.pinId:pin.nextPin;
  if(nextPin!==null&&!token(nextPin))fail('IMPORT_ROUTE_PIN_INVALID');
  const nextCursor=nextPin?sealCursor({kind:'route',revision:r,runId,jobId:i.jobId,pinId:nextPin,output:withinOutput?index:more?index+1:0,pointOffset:withinOutput?nextOffset:0,pinIndex:more?pinIndex:pinIndex+1,previousPin:more?pin.previousPin:pinId}):null;
  // 32 KiB also covers worst-case JSON escaping of a 4,096-character cursor.
  if(nextCursor!==null&&(typeof nextCursor!=='string'||!nextCursor.length||nextCursor.length>4096))fail('IMPORT_CURSOR_INVALID');
  const result={revision:r,runId,points,nextCursor};
  if(encodeUtf8(JSON.stringify(result)).length>ROUTE_BYTES)fail('IMPORT_ROUTE_BOUND');
  return result;
 });}
 return Object.freeze({status,listImportedRuns,readRoutePage});
}

return {createImportReader};
})();
return Object.assign({},m0,m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12,m13,m14,m15,m16,m17);
})();

// Paste this complete kit only into the existing owner-authorized Apps Script
// project. Run functions from its editor; do not deploy this as a web app.
var MYPACE_IMPORT_OWNER = 'yakitorihanbagu0412@gmail.com';
function myPaceOwnerGlobals_() {
  return {Drive:Drive, Utilities:Utilities, UrlFetchApp:UrlFetchApp,
    ScriptApp:ScriptApp, LockService:LockService, Session:Session,
    PropertiesService:PropertiesService, CacheService:typeof CacheService==='undefined'?undefined:CacheService};
}
function myPaceOwnerBootstrap_(meter) {
  return MyPaceFolderImport.createOwnerBootstrap(meter.globals, {
    ownerEmail:MYPACE_IMPORT_OWNER, checkBudget:meter.checkBudget
  });
}
function myPaceOwnerRuntimeConfig_(globals,config) {
  if(!config.checkpointHintId&&!config.discoveryStateId) return config;
  var secret=globals.PropertiesService.getScriptProperties().getProperty('MYPACE_WRITER_SECRET');
  if(secret===null||secret===undefined||secret==='') return config;
  return Object.assign({},config,config.checkpointHintId?{checkpointHintCodec:MyPaceFolderImport.createGasCheckpointHintCodec({Utilities:globals.Utilities,secret:secret})}:{},config.discoveryStateId?{discoveryStateCodec:MyPaceFolderImport.createGasDiscoveryStateCodec({Utilities:globals.Utilities,secret:secret})}:{});
}
function myPaceOwnerReport_(result) { console.log(JSON.stringify(result)); return result; }
function myPaceOwnerRun_(method) {
  var meter=MyPaceFolderImport.meteredGas(myPaceOwnerGlobals_());
  var config=myPaceOwnerBootstrap_(meter).load();
  if(!config) throw new Error('OWNER_BOOTSTRAP_REQUIRED');
  var result=MyPaceFolderImport.createOwnerScheduler(meter.globals,myPaceOwnerRuntimeConfig_(meter.globals,config),{deadlineMs:meter.hardDeadlineMs})[method]();
  result.usage=meter.usage();
  return myPaceOwnerReport_(result);
}
// Explicit first-write action: reserves and pins a new private app store.
// Repeat calls resume/verify the SAME IDs; never reset its property or folders.
function MyPaceImportBootstrap() { var meter=MyPaceFolderImport.meteredGas(myPaceOwnerGlobals_()); var config=myPaceOwnerBootstrap_(meter).bootstrap(); return myPaceOwnerReport_({config:config,usage:meter.usage()}); }
// Start a new scan only when idle/complete; a repeated click does not reset work.
function MyPaceImportStart() { return myPaceOwnerRun_('start'); }
function MyPaceImportResume() { return myPaceOwnerRun_('resume'); }
function MyPaceImportStatus() { return myPaceOwnerRun_('status'); }
// Explicitly retry a blocked cursor after fixing/reviewing its cause.
function MyPaceImportRetryBlocked() { return myPaceOwnerRun_('retryBlocked'); }
// Explicitly abandon a changed/missing unfinished source generation. Preserves
// the last published run and original CSV, releases its staging pin without
// deleting files, and returns idle. Run Start to enumerate the current folder.
function MyPaceImportRestartChangedSource() { return myPaceOwnerRun_('restartChangedSource'); }

// Explicit owner-editor maintenance only. No web route or trigger installer.
// Repair pins optional configuration; Recover verifies existing immutable history.
function myPaceOwnerMaintenanceSetup_(error,meter) {
  var code=error&& (error.code||error.message);
  var actions={
    OWNER_BOOTSTRAP_REQUIRED:'No production store is configured. Use MyPaceImportBootstrap only for an explicitly requested first store; never clear an existing store configuration.',
    OWNER_RECOVERY_SECRET_REQUIRED:'Keep the existing owner-managed MYPACE_WRITER_SECRET. If it is absent or invalid, configure it privately in this same project, then run MyPaceRepairRecoveryConfiguration.',
    CHECKPOINT_HINT_AUTH_REQUIRED:'Check the existing owner-managed MYPACE_WRITER_SECRET and Apps Script Utilities support, then run MyPaceRepairRecoveryConfiguration. Do not replace the store or silently rotate an existing key.',
    OWNER_RECOVERY_CONFIGURATION_REQUIRED:'Run MyPaceRepairRecoveryConfiguration in this existing project, then run MyPaceRecoverStorage.',
    WRITER_RECOVERY_SETUP_REQUIRED:'Run MyPaceRepairRecoveryConfiguration with the existing owner-managed secret, then repeat MyPaceRecoverStorage. Preserve all original storage IDs and history.'
  };
  if(!Object.prototype.hasOwnProperty.call(actions,code))throw error;
  return myPaceOwnerReport_({status:'setup-needed',code:code,requiresOwnerAction:true,nextAction:actions[code],usage:meter.usage()});
}
function MyPaceRepairRecoveryConfiguration() {
  var meter=MyPaceFolderImport.meteredGas(myPaceOwnerGlobals_());
  try{
    var config=myPaceOwnerBootstrap_(meter).repairRecoveryConfiguration();
    return myPaceOwnerReport_({status:'recovery-configured',config:config,nextAction:'Run MyPaceRecoverStorage until it reports ready.',usage:meter.usage()});
  }catch(error){return myPaceOwnerMaintenanceSetup_(error,meter);}
}
function MyPaceRecoverStorage() {
  var meter=MyPaceFolderImport.meteredGas(myPaceOwnerGlobals_());
  try{
    var config=myPaceOwnerBootstrap_(meter).loadRecoveryConfiguration();
    if(!config)throw new Error('OWNER_BOOTSTRAP_REQUIRED');
    if(!config.checkpointHintId)throw new Error('OWNER_RECOVERY_CONFIGURATION_REQUIRED');
    var runtimeConfig=myPaceOwnerRuntimeConfig_(meter.globals,config);
    if(!runtimeConfig.checkpointHintCodec)throw new Error('OWNER_RECOVERY_SECRET_REQUIRED');
    var runtime=MyPaceFolderImport.createGasImportRuntime(meter.globals,Object.assign({},runtimeConfig,{checkBudget:meter.checkBudget,deadlineMs:meter.hardDeadlineMs,protocolReadCache:{mode:'lock-phase'}}));
    var state=runtime.locked(function(){return runtime.writer.recoveryBarrier();});
    return myPaceOwnerReport_({status:'ready',storage:state,usage:meter.usage()});
  }catch(error){
    var code=error&& (error.code||error.message);
    if(code==='WRITER_RECOVERY_PENDING')return myPaceOwnerReport_({status:'recovering',code:code,indexLinks:error.indexLinks,scannedLinks:error.scannedLinks,cursorPersisted:error.cursorPersisted===true,nextAction:'Run MyPaceRecoverStorage again to continue bounded recovery.',usage:meter.usage()});
    if(['OWNER_BOOTSTRAP_YIELD','OWNER_BUDGET_YIELD','STORE_YIELD','IMPORT_YIELD'].indexOf(code)>=0)return myPaceOwnerReport_({status:'recovering',code:code,nextAction:'This bounded slice reached its work budget. Run MyPaceRecoverStorage again; keep the existing store configuration.',usage:meter.usage()});
    return myPaceOwnerMaintenanceSetup_(error,meter);
  }
}

// Run once after updating this same project to repair slow app cold reads.
// It verifies existing history, saves authenticated recovery progress, and only
// then appends a no-business-change checkpoint. Never starts/resets CSV import.
function MyPacePrepareWebSync() {
  var meter=MyPaceFolderImport.meteredGas(myPaceOwnerGlobals_());
  try {
    var config=myPaceOwnerBootstrap_(meter).loadRecoveryConfiguration();
    if(!config)throw new Error('OWNER_BOOTSTRAP_REQUIRED');
    if(!config.checkpointHintId)throw new Error('OWNER_RECOVERY_CONFIGURATION_REQUIRED');
    var runtimeConfig=myPaceOwnerRuntimeConfig_(meter.globals,config);
    if(!runtimeConfig.checkpointHintCodec)throw new Error('OWNER_RECOVERY_SECRET_REQUIRED');
    var common=Object.assign({},runtimeConfig,{checkBudget:meter.checkBudget,deadlineMs:meter.hardDeadlineMs,protocolReadCache:{mode:'lock-phase'}});
    var result=MyPaceFolderImport.prepareWebRead(MyPaceFolderImport.createGasImportRuntime(meter.globals,common));
    if(meter.hardDeadlineMs-Date.now()<20000)return myPaceOwnerReport_({status:'prepared',sealed:result.sealed,revision:result.storage.revision,replayFrames:result.storage.replayFrames,webProbe:'not-run',nextAction:'The existing history is verified and its recovery tail is prepared. Try one app sync; report its result if it is still blocked.',usage:meter.usage()});
    var probeStarted=Date.now(),before=meter.usage(),cold=MyPaceFolderImport.createGasImportRuntime(meter.globals,Object.assign({},common,{writerLimits:{maxIndexScanLinks:8},deadlineMs:probeStarted+20000,checkBudget:function(){return meter.checkBudget()&&Date.now()-probeStarted<20000;}}));
    try {
      var state=cold.locked(function(){cold.writer.recoveryBarrier();return cold.writer.status();});
      return myPaceOwnerReport_({status:'ready',sealed:result.sealed,revision:state.revision,replayFrames:state.replayFrames,webProbe:{scope:'cold-storage-recovery',ok:true,calls:meter.usage().calls-before.calls,elapsedMs:Date.now()-probeStarted},nextAction:'Return to the app and run sync once. CSV import remains at its saved position.',usage:meter.usage()});
    } catch(probeError) {
      var probeCode=probeError.code||probeError.message;
      if(['STORE_YIELD','OWNER_BUDGET_YIELD','IMPORT_YIELD','WRITER_RECOVERY_PENDING'].indexOf(probeCode)<0)throw probeError;
      return myPaceOwnerReport_({status:'web-budget-blocked',sealed:result.sealed,revision:result.storage.revision,replayFrames:result.storage.replayFrames,code:probeCode,webProbe:{scope:'cold-storage-recovery',ok:false,calls:meter.usage().calls-before.calls,elapsedMs:Date.now()-probeStarted},nextAction:'History is verified, but the cold web budget is still insufficient. Report this result; do not repeatedly sync or recreate the store.',usage:meter.usage()});
    }
  } catch(error) {
    var code=error.code||error.message;
    if(code==='WRITER_RECOVERY_PENDING')return myPaceOwnerReport_({status:'recovering',code:code,indexLinks:error.indexLinks,scannedLinks:error.scannedLinks,cursorPersisted:error.cursorPersisted===true,nextAction:'A bounded INDEX slice was checked. Continue only if its persisted cursor is advancing.',usage:meter.usage()});
    if(['OWNER_BOOTSTRAP_YIELD','OWNER_BUDGET_YIELD','STORE_YIELD','IMPORT_YIELD'].indexOf(code)>=0)return myPaceOwnerReport_({status:error.cursorAdvanced===true?'recovering':'recovery-budget-blocked',code:code,recoveredRevision:error.recoveredRevision||null,cursorPersisted:error.cursorPersisted===true,cursorAdvanced:error.cursorAdvanced===true,nextAction:error.cursorAdvanced===true?'Verified frame progress was saved. Run MyPacePrepareWebSync again to continue.':'No new recovery cursor was confirmed. Report this result rather than repeating the same work.',usage:meter.usage()});
    return myPaceOwnerMaintenanceSetup_(error,meter);
  }
}

// Optional owner-created time-driven trigger; default Google UI cadence: 15 minutes. Create/remove it in the existing
// project's Triggers UI only after the coherent live acceptance bundle passes.
// Event fields cannot select methods, owners, stores, sources, limits or IDs.
// Keep this file server-only. Never route doGet/doPost/RPC to this handler.
var MYPACE_IMPORT_SCHEDULE = {
  sliceMs:60000, calls:750, steps:3, rangeBytes:1048576, scanIntervalMs:3600000, catchUp:true
};
function MyPaceImportScheduledTick(event) {
  var runtime=MyPaceFolderImport.createScheduledImportRuntime(myPaceOwnerGlobals_(),MYPACE_IMPORT_SCHEDULE);
  return myPaceOwnerReport_(runtime.tick(event));
}

// Local-only candidate. One owner-authorized Apps Script writer.
var MyPaceSecureSync=(function(){
"use strict";
const m0=(function(){
/** Pure, dependency-free domain rules. Calendar keys always use the device's local day. */
const STATE_VERSION = 2;
const LIMITS = Object.freeze({
  backupChars: 12 * 1024 * 1024,
  backupBytes: 12 * 1024 * 1024,
  wakeDays: 36600,
  habits: 100,
  habitDays: 100000,
  runs: 5000,
  pointsPerRun: 20000,
  totalPoints: 100000,
  events: 20000,
  eventTitle: 120,
  eventNote: 2000,
  diaryDays: 36600,
  diaryText: 8000,
});
const DIARY_MOODS = Object.freeze(['bright', 'calm', 'tired', 'low']);
const GARDEN_PLANTS = Object.freeze([
  Object.freeze({ id: 'cosmos', label: 'コスモス', unlockAt: 0 }),
  Object.freeze({ id: 'sunflower', label: 'ひまわり', unlockAt: 7 }),
  Object.freeze({ id: 'hydrangea', label: 'あじさい', unlockAt: 21 }),
]);
const GARDEN_THEMES = Object.freeze([
  Object.freeze({ id: 'day', label: '昼の庭' }),
  Object.freeze({ id: 'dusk', label: '夕暮れの庭' }),
  Object.freeze({ id: 'night', label: '夜の庭' }),
]);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DATE_RE = /^(19\d{2}|20\d{2}|21\d{2}|2200)-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const pad = (n) => String(n).padStart(2, '0');
const fail = (message) => { throw new Error(message); };
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function createInitialState() {
  return { version: STATE_VERSION, settings: { wakeTarget: null }, wake: {}, runs: [], habits: [], habitLogs: {},
    events: [], diary: {}, garden: { plant: 'cosmos', theme: 'day' } };
}

function isDateKey(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  const date = new Date(y, m - 1, d, 12);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function localDateKey(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail('日付が正しくありません。');
  const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (!isDateKey(key)) fail('日付は1900〜2200年の範囲で入力してください。');
  return key;
}
const dateKey = localDateKey;
const todayKey = () => localDateKey();

function addDays(key, count) {
  if (!isDateKey(key) || !Number.isInteger(count) || Math.abs(count) > 36600) fail('日付の計算ができません。');
  const [year, month, day] = key.split('-').map(Number);
  // Noon avoids DST midnight transitions; setDate advances a calendar day, not 24 hours.
  const date = new Date(year, month - 1, day, 12);
  date.setDate(date.getDate() + count);
  return localDateKey(date);
}

function trailingDateKeys(days, anchor = todayKey()) {
  if (!Number.isInteger(days) || days < 1 || days > 36600 || !isDateKey(anchor)) fail('集計期間が正しくありません。');
  const result = [anchor];
  while (result.length < days && result[0] !== '1900-01-01') result.unshift(addDays(result[0], -1));
  return result;
}
const recentDates = trailingDateKeys;

function timeToMinutes(time) {
  const match = typeof time === 'string' && TIME_RE.exec(time);
  if (!match) fail('時刻はHH:mm形式で入力してください。');
  return Number(match[1]) * 60 + Number(match[2]);
}
function minutesToTime(minutes) {
  if (!Number.isFinite(minutes)) return '—';
  const value = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds), hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60), remaining = total % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(remaining)}` : `${minutes}:${pad(remaining)}`;
}
function formatPace(distanceKm, durationSec) {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0 || !Number.isFinite(durationSec) || durationSec <= 0) return '—';
  return formatDuration(durationSec / distanceKm);
}
function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function record(value, path, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path}の形式が正しくありません。`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(`${path}の形式が正しくありません。`);
  for (const key of Object.keys(value)) {
    if (BAD_KEYS.has(key) || (allowed && !allowed.includes(key))) fail(`${path}に未対応の項目があります。`);
  }
  return value;
}
function list(value, maximum, path) {
  if (!Array.isArray(value) || value.length > maximum) fail(`${path}の件数または形式が正しくありません。`);
  return value;
}
function text(value, max, path, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) fail(`${path}が正しくありません。`);
  return value;
}
// Journal limits count Unicode code points, so an emoji gets the same capacity as a Japanese character.
function journalText(value, max, path, allowEmpty = true) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) fail(`${path}が正しくありません。`);
  let count = 0;
  for (const character of value) {
    if (++count > max) fail(`${path}が正しくありません。`);
  }
  return value;
}
function identifier(value, path) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value) || BAD_KEYS.has(value)) fail(`${path}が正しくありません。`);
  return value;
}
function number(value, min, max, path, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`${path}が正しくありません。`);
  return value;
}
function date(value, path) {
  if (!isDateKey(value)) fail(`${path}が正しくありません。`);
  return value;
}
function time(value, path) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) fail(`${path}が正しくありません。`);
  return value;
}

/** Validate the complete object before replacing data. Returns a detached canonical copy. */
function validateState(raw) {
  record(raw, 'バックアップ');
  if (raw.version !== 1 && raw.version !== STATE_VERSION) fail('このバックアップのバージョンには対応していません。');
  const legacy = raw.version === 1;
  record(raw, 'バックアップ', ['version', 'settings', 'wake', 'runs', 'habits', 'habitLogs',
    ...(legacy ? [] : ['events', 'diary', 'garden'])]);
  record(raw.settings, '設定', ['wakeTarget']);
  const output = createInitialState();
  output.settings.wakeTarget = raw.settings.wakeTarget === null ? null : time(raw.settings.wakeTarget, '目標時刻');
  record(raw.wake, '起床記録');
  if (Object.keys(raw.wake).length > LIMITS.wakeDays) fail('起床記録の件数が多すぎます。');
  for (const [key, value] of Object.entries(raw.wake)) output.wake[date(key, '起床日')] = time(value, '起床時刻');
  const habitIds = new Set();
  output.habits = list(raw.habits, LIMITS.habits, '習慣').map((item) => {
    record(item, '習慣', ['id', 'name', 'type', 'unit', 'target', 'archived']);
    const id = identifier(item.id, '習慣ID');
    if (habitIds.has(id)) fail('習慣IDが重複しています。');
    habitIds.add(id);
    if (!['check', 'number', 'time'].includes(item.type)) fail('習慣の種類が正しくありません。');
    if (item.archived !== undefined && typeof item.archived !== 'boolean') fail('習慣の非表示設定が正しくありません。');
    let target = item.target ?? null;
    if (item.type === 'check') {
      if (target !== null && target !== 1) fail('チェック習慣の目標が正しくありません。');
      target = 1;
    } else number(target, 0.001, 1000000, '習慣の目標');
    return { id, name: text(item.name, 80, '習慣名', false), type: item.type,
      unit: text(item.unit ?? (item.type === 'time' ? '分' : ''), 20, '単位'), target, archived: item.archived ?? false };
  });
  record(raw.habitLogs, '習慣記録');
  const definitions = new Map(output.habits.map((habit) => [habit.id, habit]));
  let logCount = 0;
  for (const [id, logs] of Object.entries(raw.habitLogs)) {
    identifier(id, '習慣ID');
    if (!definitions.has(id)) fail('存在しない習慣の記録が含まれています。');
    record(logs, '日々の習慣記録');
    output.habitLogs[id] = {};
    for (const [key, value] of Object.entries(logs)) {
      if (++logCount > LIMITS.habitDays) fail('習慣記録の件数が多すぎます。');
      date(key, '習慣の記録日');
      if (definitions.get(id).type === 'check') {
        if (typeof value !== 'boolean') fail('チェックの記録は真偽値にしてください。');
      } else number(value, 0, 1000000, '習慣の記録');
      output.habitLogs[id][key] = value;
    }
  }
  const runIds = new Set();
  let pointCount = 0;
  output.runs = list(raw.runs, LIMITS.runs, 'ランニング記録').map((item) => {
    record(item, 'ランニング記録', ['id', 'date', 'distanceKm', 'durationSec', 'note', 'points']);
    const id = identifier(item.id, 'ランニングID');
    if (runIds.has(id)) fail('ランニングIDが重複しています。');
    runIds.add(id);
    const points = list(item.points ?? [], LIMITS.pointsPerRun, 'ルート').map((point) => {
      if (++pointCount > LIMITS.totalPoints) fail('ルートの合計点数が多すぎます。');
      record(point, 'ルートの座標', ['lat', 'lon', 'segment', 'time']);
      const copy = { lat: number(point.lat, -90, 90, '緯度'), lon: number(point.lon, -180, 180, '経度'),
        segment: number(point.segment ?? 0, 0, LIMITS.pointsPerRun, '区間', true) };
      if (point.time !== undefined) {
        if (typeof point.time !== 'string' || point.time.length > 40 || !Number.isFinite(Date.parse(point.time))) fail('ルートの時刻が正しくありません。');
        copy.time = new Date(point.time).toISOString();
      }
      return copy;
    });
    return { id, date: date(item.date, 'ランニング日'), distanceKm: number(item.distanceKm, 0.001, 10000, '距離'),
      durationSec: number(item.durationSec, 1, 31 * 24 * 3600, '所要時間', true), note: text(item.note ?? '', 2000, 'メモ'), points };
  });
  if (!legacy) {
    const eventIds = new Set();
    output.events = list(raw.events, LIMITS.events, '予定').map((item) => {
      record(item, '予定', ['id', 'date', 'time', 'title', 'note']);
      const id = identifier(item.id, '予定ID');
      if (eventIds.has(id)) fail('予定IDが重複しています。');
      eventIds.add(id);
      return { id, date: date(item.date, '予定の日付'),
        time: item.time == null ? null : time(item.time, '予定の時刻'),
        title: journalText(item.title, LIMITS.eventTitle, '予定のタイトル', false),
        note: journalText(item.note ?? '', LIMITS.eventNote, '予定のメモ') };
    });
    record(raw.diary, '日記');
    if (Object.keys(raw.diary).length > LIMITS.diaryDays) fail('日記の件数が多すぎます。');
    for (const [key, entry] of Object.entries(raw.diary)) {
      date(key, '日記の日付');
      record(entry, '日記', ['text', 'mood']);
      if (entry.mood != null && !DIARY_MOODS.includes(entry.mood)) fail('日記の気分が正しくありません。');
      output.diary[key] = { text: journalText(entry.text, LIMITS.diaryText, '日記の本文'), mood: entry.mood ?? null };
    }
    record(raw.garden, '庭の設定', ['plant', 'theme']);
    if (!GARDEN_PLANTS.some((item) => item.id === raw.garden.plant)) fail('庭の植物が正しくありません。');
    if (!GARDEN_THEMES.some((item) => item.id === raw.garden.theme)) fail('庭のテーマが正しくありません。');
    // Selection is retained even after deleting an earning record. Visibility is derived separately.
    output.garden = { plant: raw.garden.plant, theme: raw.garden.theme };
  }
  return output;
}

// UTF-8 length with the same lone-surrogate replacement behavior as TextEncoder.
// Pure ECMAScript: Apps Script has no browser Encoding API.
function utf8ByteLength(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
             text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

function parseBackup(json) {
  if (typeof json !== 'string' || json.length > LIMITS.backupChars || utf8ByteLength(json) > LIMITS.backupBytes) fail('バックアップは12MiB以下のJSONにしてください。');
  let parsed;
  try { parsed = JSON.parse(json); } catch { fail('JSONファイルを読み取れませんでした。'); }
  return validateState(parsed);
}
function serializeBackup(state) {
  const result = JSON.stringify(validateState(state), null, 2);
  if (result.length > LIMITS.backupChars || utf8ByteLength(result) > LIMITS.backupBytes) fail('バックアップの容量が12MiBを超えています。');
  return result;
}

/** Current streak includes today when completed, otherwise allows yesterday. Future keys are ignored. */
function streak(dates, anchor = todayKey()) {
  if (!isDateKey(anchor)) fail('基準日が正しくありません。');
  const completed = new Set(Array.isArray(dates) || dates instanceof Set ? dates : Object.keys(dates ?? {}));
  let cursor = anchor;
  if (!completed.has(cursor)) {
    if (cursor === '1900-01-01') return 0;
    cursor = addDays(cursor, -1);
  }
  let count = 0;
  while (completed.has(cursor)) {
    count++;
    if (cursor === '1900-01-01' || count >= LIMITS.wakeDays) break;
    cursor = addDays(cursor, -1);
  }
  return count;
}
function wakeStreak(state, anchor = todayKey()) { return streak(Object.keys(state.wake), anchor); }
function wakeStats(state, days = 7, anchor = todayKey()) {
  const values = recentDates(days, anchor).filter((key) => has(state.wake, key)).map((key) => timeToMinutes(state.wake[key]));
  const averageMinutes = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const target = state.settings.wakeTarget == null ? null : timeToMinutes(state.settings.wakeTarget);
  const onTimeCount = target === null ? null : values.filter((value) => value <= target).length;
  return { count: values.length, averageMinutes, averageTime: averageMinutes === null ? null : minutesToTime(averageMinutes),
    earliest: values.length ? minutesToTime(Math.min(...values)) : null, latest: values.length ? minutesToTime(Math.max(...values)) : null,
    streak: wakeStreak(state, anchor), onTimeCount, targetRate: values.length && target !== null ? onTimeCount / values.length : null };
}
function isHabitComplete(habit, value) {
  if (habit.type === 'check') return value === true;
  return typeof value === 'number' && Number.isFinite(value) && (habit.target == null ? value > 0 : value >= habit.target);
}
function habitStreak(state, habitId, anchor = todayKey()) {
  const habit = state.habits.find((item) => item.id === habitId);
  if (!habit) return 0;
  return streak(Object.entries(state.habitLogs[habitId] ?? {}).filter(([, value]) => isHabitComplete(habit, value)).map(([key]) => key), anchor);
}
function habitStats(state, habitId, days = 7, anchor = todayKey()) {
  const habit = state.habits.find((item) => item.id === habitId);
  if (!habit) fail('習慣が見つかりません。');
  const logs = state.habitLogs[habitId] ?? {};
  const values = recentDates(days, anchor).filter((key) => has(logs, key)).map((key) => logs[key]);
  const total = values.reduce((sum, value) => sum + Number(value), 0);
  return { count: values.length, completed: values.filter((value) => isHabitComplete(habit, value)).length,
    total, average: values.length ? total / values.length : null, streak: habitStreak(state, habitId, anchor) };
}
function upsertWake(state, key, value) {
  return validateState({ ...state, wake: { ...state.wake, [key]: value } });
}
function upsertHabitLog(state, habitId, key, value) {
  return validateState({ ...state, habitLogs: { ...state.habitLogs, [habitId]: { ...state.habitLogs[habitId], [key]: value } } });
}

/** Immutable journal edits always pass the same strict validation as backup imports. */
function upsertEvent(state, event) {
  const current = validateState(state);
  return validateState({ ...current, events: [...current.events.filter((item) => item.id !== event?.id), event] });
}
function removeEvent(state, id) {
  identifier(id, '予定ID');
  const current = validateState(state);
  return validateState({ ...current, events: current.events.filter((item) => item.id !== id) });
}
function upsertDiary(state, key, entry) {
  date(key, '日記の日付');
  const current = validateState(state);
  return validateState({ ...current, diary: { ...current.diary, [key]: entry } });
}
function removeDiary(state, key) {
  date(key, '日記の日付');
  const current = validateState(state);
  delete current.diary[key];
  return current;
}

return {STATE_VERSION,LIMITS,DIARY_MOODS,GARDEN_PLANTS,GARDEN_THEMES,createInitialState,isDateKey,localDateKey,dateKey,todayKey,addDays,trailingDateKeys,recentDates,timeToMinutes,minutesToTime,formatDuration,formatPace,makeId,validateState,utf8ByteLength,parseBackup,serializeBackup,streak,wakeStreak,wakeStats,isHabitComplete,habitStreak,habitStats,upsertWake,upsertHabitLog,upsertEvent,removeEvent,upsertDiary,removeDiary};})();
const m1=(function(){
const {createInitialState,validateState,isDateKey}=m0;
const clone=x=>JSON.parse(JSON.stringify(x));
function canonical(x){if(x===null||typeof x==='boolean'||typeof x==='string')return JSON.stringify(x);if(typeof x==='number'&&Number.isFinite(x))return JSON.stringify(x);if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';if(x&&typeof x==='object'&&Object.getPrototypeOf(x)===Object.prototype)return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';throw Error('INVALID_JSON');}
function parseKey(key){
 if(typeof key!=='string'||key.length>240)throw Error('ENTITY_KEY_INVALID');
 const [kind,id,date,...rest]=key.split(':');if(rest.length)throw Error('ENTITY_KEY_INVALID');
 if(['wake','diary'].includes(kind)&&isDateKey(id)&&date===undefined)return {kind,id};
 if(['run','habit','event'].includes(kind)&&/^[A-Za-z0-9_-]{1,100}$/.test(id)&&!['constructor','prototype','__proto__'].includes(id)&&date===undefined)return {kind,id};
 if(kind==='habitLog'&&/^[A-Za-z0-9_-]{1,100}$/.test(id)&&!['constructor','prototype','__proto__'].includes(id)&&isDateKey(date))return {kind,id,date};
 if((kind==='settings'&&id==='wakeTarget'||kind==='garden'&&id==='preferences')&&date===undefined)return {kind,id};
 throw Error('ENTITY_KEY_INVALID');
}
function stateToEntities(raw){const s=validateState(raw),out={};for(const [d,v] of Object.entries(s.wake))out['wake:'+d]=v;for(const k of ['run','habit','event'])for(const v of s[k==='run'?'runs':k==='habit'?'habits':'events'])out[k+':'+v.id]=v;for(const [id,days] of Object.entries(s.habitLogs))for(const [d,v]of Object.entries(days))out['habitLog:'+id+':'+d]=v;for(const [d,v]of Object.entries(s.diary))out['diary:'+d]=v;out['settings:wakeTarget']=s.settings.wakeTarget;out['garden:preferences']=s.garden;return out;}
function entitiesToState(entities){const s=createInitialState();for(const [key,value]of Object.entries(entities)){const {kind,id,date}=parseKey(key);if(kind==='wake'||kind==='diary')s[kind][id]=clone(value);else if(kind==='run'||kind==='habit'||kind==='event')s[kind==='run'?'runs':kind==='habit'?'habits':'events'].push(clone(value));else if(kind==='habitLog'){if(s.habitLogs[id]===null||s.habitLogs[id]===undefined)s.habitLogs[id]={};s.habitLogs[id][date]=value;}else if(kind==='settings')s.settings.wakeTarget=value;else s.garden=clone(value);}for(const id of Object.keys(s.habitLogs))if(!s.habits.some(h=>h.id===id))delete s.habitLogs[id];return validateState(s);}
function validateEntity(key,value,habit){const p=parseKey(key),s=createInitialState();if(p.kind==='habitLog'){s.habits=[habit];s.habitLogs[p.id]={[p.date]:value};}else if(p.kind==='wake'||p.kind==='diary')s[p.kind][p.id]=value;else if(p.kind==='run'||p.kind==='habit'||p.kind==='event'){if(value?.id!==p.id)throw Error('ENTITY_ID_MISMATCH');s[p.kind==='run'?'runs':p.kind==='habit'?'habits':'events']=[value];}else if(p.kind==='settings')s.settings.wakeTarget=value;else s.garden=value;return stateToEntities(s)[key];}
function diffEntities(before,after){const a=stateToEntities(before),b=stateToEntities(after);return [...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>canonical(a[k]===undefined?null:a[k])!==canonical(b[k]===undefined?null:b[k])||Object.prototype.hasOwnProperty.call(a,k)!==Object.prototype.hasOwnProperty.call(b,k)).map(key=>({key,deleted:!Object.prototype.hasOwnProperty.call(b,key),value:Object.prototype.hasOwnProperty.call(b,key)?b[key]:null}));}

return {clone,canonical,parseKey,stateToEntities,entitiesToState,validateEntity,diffEntities};})();
const m2=(function(){
const {canonical,parseKey,validateEntity}=m1;
const fail=code=>{const e=Error(code);e.code=code;throw e;};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.split(',').sort().join(',');
const HEAD='app/catalog/head';const node=key=>'app/catalog/'+key;const data=key=>'app/data/'+key;
function createAppDomain({writer,locked,digest}){
 if(!writer||typeof locked!=='function'||typeof digest!=='function')fail('DOMAIN_CONFIG');
 return {
 command(c){return locked(()=>{
  if(!exact(c,'operationId,epoch,generation,store,key,expectedVersion,deleted,value,recreate')||!/^[-a-zA-Z0-9_]{16,100}$/.test(c.operationId)||!/^[-a-zA-Z0-9_]{1,100}$/.test(c.epoch)||typeof c.store!=='string'||typeof c.generation!=='string'||!Number.isSafeInteger(c.expectedVersion)||c.expectedVersion<0||typeof c.deleted!=='boolean'||typeof c.recreate!=='boolean')fail('COMMAND_INVALID');
  const parsed=parseKey(c.key);writer.recoveryBarrier();const hash=digest(canonical(c));
  // Receipt replay MUST precede generation/version/domain-state checks.
  const prior=writer.getReceipt(c.operationId,c.epoch);if(prior){if(prior.digest!==hash)fail('OP_ID_REUSED');return prior;}
  const status=writer.status();if(c.store!==status.storeId)fail('STORE_ID_MISMATCH');if(c.generation!==status.datasetGeneration)fail('DATASET_GENERATION_MISMATCH');
  if(!status.acceptedEpochs.includes(c.epoch))fail('OPERATION_EPOCH_EXPIRED');
  const old=writer.getEntity(data(c.key));if((old?.version??0)!==c.expectedVersion)fail('ENTITY_VERSION_CONFLICT');
  if(c.deleted&&(c.value!==null||!old||old.deleted))fail('ENTITY_MISSING');
  if(c.deleted&&['settings','garden','habit'].includes(parsed.kind))fail('ENTITY_DELETE_FORBIDDEN'); // Archive habits; preserves historical log types.
  let value=null;
  if(!c.deleted){const habit=parsed.kind==='habitLog'?writer.getEntity(data('habit:'+parsed.id)):null;if(parsed.kind==='habitLog'&&(!habit||habit.deleted))fail('HABIT_MISSING');value=validateEntity(c.key,c.value,habit?.value);if(parsed.kind==='habit'&&old&&!old.deleted&&old.value.type!==value.type)fail('HABIT_TYPE_IMMUTABLE');}
  const changes=[{key:data(c.key),expectedVersion:c.expectedVersion,deleted:c.deleted,value,...(c.recreate?{recreate:true}:{})}];
  if(!old){const head=writer.getEntity(HEAD);changes.push({key:node(c.key),expectedVersion:0,value:{key:c.key,next:head?.value.first??null}},{key:HEAD,expectedVersion:head?.version??0,value:{first:c.key}});}
  return writer.transact({operationId:c.operationId,epoch:c.epoch,datasetGeneration:c.generation,digest:hash,changes,result:{key:c.key,version:c.expectedVersion+1,deleted:c.deleted}});
 });},
 snapshot(p){return locked(()=>{
  if(!exact(p,'cursor,revision')||(p.cursor!==null&&typeof p.cursor!=='string')||(p.revision!==null&&!Number.isSafeInteger(p.revision)))fail('SNAPSHOT_INVALID');
  writer.recoveryBarrier();const s=writer.status();if(p.revision!==null&&p.revision!==s.revision)fail('SNAPSHOT_CHANGED');
  if(p.cursor!==null){parseKey(p.cursor);if(p.revision===null)fail('SNAPSHOT_INVALID');}
  let key=p.cursor??writer.getEntity(HEAD)?.value.first??null;const entities=[],seen=new Set();let bytes=0;
  while(key!==null&&entities.length<24&&bytes<131072){if(seen.has(key))fail('CATALOG_CORRUPT');seen.add(key);const n=writer.getEntity(node(key)),e=writer.getEntity(data(key));if(!n||n.deleted||n.value.key!==key||!e)fail('CATALOG_CORRUPT');parseKey(key);entities.push({key,version:e.version,deleted:e.deleted,value:e.value});bytes+=canonical(e).length;key=n.value.next;if(key!==null)parseKey(key);}
  return {store:s.storeId,generation:s.datasetGeneration,revision:s.revision,epoch:s.acceptedEpochs[s.acceptedEpochs.length-1],entities,cursor:key};
 });}
 };
}

return {createAppDomain};})();
const m3=(function(){
const {canonical}=m1;
const fail=code=>{const e=Error(code);e.code=code;throw e;};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===(keys?keys.split(','):[]).sort().join(',');
function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
function createSignedDispatcher({owner,store,secret,hmac,byteLength,now=()=>Date.now(),createServices}){
 if(owner!=='yakitorihanbagu0412@gmail.com'||!/^[-a-zA-Z0-9_]{1,128}$/.test(store)||typeof secret!=='string'||secret.length<32||typeof hmac!=='function'||typeof byteLength!=='function'||typeof createServices!=='function')fail('DISPATCHER_CONFIG');
 return raw=>{try{
  if(typeof raw!=='string'||byteLength(raw)>220000)fail('BODY_TOO_LARGE');let e;try{e=JSON.parse(raw);}catch{fail('INVALID_JSON');}
  if(!exact(e,'v,ts,nonce,owner,store,action,payload,signature')||e.v!==1||!Number.isSafeInteger(e.ts)||Math.abs(now()-e.ts)>120000||!/^[-A-Za-z0-9_]{43}$/.test(e.nonce)||e.owner!==owner||e.store!==store||!['command','snapshot','imports','route','importStatus'].includes(e.action)||!/^[-A-Za-z0-9_]{43}$/.test(e.signature))fail('REQUEST_FORBIDDEN');
  const {signature,...unsigned}=e;if(!equal(hmac(canonical(unsigned),secret),signature))fail('SIGNATURE_INVALID');
  // No Drive access, runtime or service construction occurs before authentication.
  if(e.action==='snapshot'||e.action==='imports'){if(!exact(e.payload,'cursor,revision'))fail('PAYLOAD_INVALID');}else if(e.action==='route'){if(!exact(e.payload,'runId,cursor,revision'))fail('PAYLOAD_INVALID');}else if(e.action==='importStatus'){if(!exact(e.payload,''))fail('PAYLOAD_INVALID');}
  const services=createServices();if(typeof services[e.action]!=='function')fail('ACTION_UNAVAILABLE');
  return {ok:true,result:services[e.action](e.payload)};
 }catch(error){const code=error.code||error.message;return {ok:false,error:/^[A-Z][A-Z0-9_]{1,80}$/.test(code)?code:'VALIDATION_FAILED',retryable:error.retryable===true};}};
}
function createCursorCodec({secret,hmac,encode,decode,now=()=>Date.now()}){
 return {
 sealCursor(value){const text=encode(canonical({value,exp:now()+600000}));return text+'.'+hmac('cursor:'+text,secret);},
 openCursor(token){if(typeof token!=='string'||token.length>8192)fail('CURSOR_INVALID');const [text,sig,...rest]=token.split('.');if(rest.length||!equal(hmac('cursor:'+text,secret),sig))fail('CURSOR_INVALID');let p;try{p=JSON.parse(decode(text));}catch{fail('CURSOR_INVALID');}if(!exact(p,'value,exp')||!Number.isSafeInteger(p.exp)||p.exp<=now()||p.exp>now()+600000)fail('CURSOR_EXPIRED');return p.value;}
 };
}

return {createSignedDispatcher,createCursorCodec};})();
return Object.assign({},m2,m3);})();

// Add to the SAME owner-authorized project and generated storage bundle.
// Secrets are ScriptProperties only, entered by the owner outside chat.
// This endpoint NEVER bootstraps, installs triggers, or returns OAuth tokens.
function doGet() { return ContentService.createTextOutput(JSON.stringify({ok:false,error:'POST_REQUIRED'})).setMimeType(ContentService.MimeType.JSON); }
function doPost(event) {
 var output;
 try {
  var props=PropertiesService.getScriptProperties();
  var secret=props.getProperty('MYPACE_WRITER_SECRET');
  var store=props.getProperty('MYPACE_STORE_ID');
  var owner='yakitorihanbagu0412@gmail.com';
  var hmac=function(text,key){return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text,key,Utilities.Charset.UTF_8)).replace(/=+$/,'');};
  var started=Date.now();
  var dispatch=MyPaceSecureSync.createSignedDispatcher({owner:owner,store:store,secret:secret,hmac:hmac,byteLength:function(text){return Utilities.newBlob(text).getBytes().length;},createServices:function(){
   var globals=myPaceOwnerGlobals_();
   if(Session.getEffectiveUser().getEmail().trim().toLowerCase()!==owner)throw new Error('EFFECTIVE_OWNER_MISMATCH');
   var config=MyPaceFolderImport.parsePinnedOwnerStoreConfig(props.getProperty(MyPaceFolderImport.OWNER_STORE_PROPERTY),{ownerEmail:owner,writerScriptId:ScriptApp.getScriptId()});
   if(!config||config.storeId!==store)throw new Error('PINNED_STORE_MISMATCH');
   var runtime=MyPaceFolderImport.createGasImportRuntime(globals,Object.assign({},config,{checkpointHintCodec:config.checkpointHintId?MyPaceFolderImport.createGasCheckpointHintCodec({Utilities:Utilities,secret:secret}):undefined,protocolReadCache:{mode:'lock-phase'},writerLimits:{maxIndexScanLinks:8},deadlineMs:started+20000,checkBudget:function(){return Date.now()-started<20000;}}));
   var domain=MyPaceSecureSync.createAppDomain({writer:runtime.writer,locked:runtime.locked,digest:function(text){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');}});
   var cursors=MyPaceSecureSync.createCursorCodec({secret:secret,hmac:hmac,encode:function(text){return Utilities.base64EncodeWebSafe(text,Utilities.Charset.UTF_8).replace(/=+$/,'');},decode:function(text){return Utilities.newBlob(Utilities.base64DecodeWebSafe(text)).getDataAsString('UTF-8');}});
   var reader=MyPaceFolderImport.createImportReader(Object.assign({runtime:runtime},cursors));
   return {command:domain.command,snapshot:domain.snapshot,imports:reader.listImportedRuns,route:reader.readRoutePage,importStatus:function(payload){if(!payload||Object.keys(payload).length)throw new Error('STATUS_INVALID');return reader.status();}};
  }});
  output=dispatch(event&&event.postData&&event.postData.contents);
 }catch(e){output={ok:false,error:'SERVICE_NOT_CONFIGURED',retryable:false};}
 return ContentService.createTextOutput(JSON.stringify(output)).setMimeType(ContentService.MimeType.JSON);
}
