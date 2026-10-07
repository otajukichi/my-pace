// Pure GAS V8-compatible preparation layer. No network, clocks, tokens or persistence.
import {CsvBytes, sensorRow, sourceKey, PARSER_VERSION} from './import-core.mjs';
import {decodeUtf8, encodeUtf8, IncrementalSha256} from './codec.mjs';
export const LIMITS = Object.freeze({range:1048576,points:4096,output:262144,checkpoint:2097152,outputs:64,totalOutput:8388608});
const BASE=['time','latitude','longitude','altitude','speed'];
const EXT=['time','gFx','gFy','gFz','ax','ay','az','wx','wy','wz','P(Pa)','Bx(µT)','By(µT)','Bz(µT)','latitude','longitude','altitude','speed','yaw','pitch','roll'];
export const MAPPING=Object.freeze({version:'observed-sensor-multi-v1',time:'ISO8601-UTC',coordinates:'latitude-longitude-degrees',altitudeUnit:'undeclared',speedUnit:'undeclared',negativeSpeed:'unavailable',statistics:'samples-only-no-distance'});
const hash=b=>new IncrementalSha256().update(b).digestHex();
export const mappingHash=()=>hash(encodeUtf8(JSON.stringify(MAPPING)));
const copy=x=>JSON.parse(JSON.stringify(x));
const timeOrder=(a,b)=>{const seconds=a.slice(0,19).localeCompare(b.slice(0,19));if(seconds)return seconds;const fa=a.slice(19,-1).replace(/^\./,''),fb=b.slice(19,-1).replace(/^\./,''),n=Math.max(fa.length,fb.length);return fa.padEnd(n,'0').localeCompare(fb.padEnd(n,'0'));};
const check=(ok,code)=>{if(!ok)throw Error(code);};
// Packing is representation only: it never changes parser/mapping/source identity.
// Absent packingVersion is the original 1,024-point format, including its bytes.
export function checkpointPointLimit(cp){
 if(!Object.prototype.hasOwnProperty.call(cp,'packingVersion'))return 1024;
 check(cp.packingVersion===1,'CHECKPOINT_PACKING');return LIMITS.points;
}
export function initialCheckpoint(source,{packingVersion=1}={}){
 check(packingVersion===0||packingVersion===1,'CHECKPOINT_PACKING');
 check(source && /^\d+$/.test(String(source.size)) && Number.isSafeInteger(Number(source.size)) && Number(source.size)>0,'SOURCE_SIZE');
 check(typeof source.version==='string' && /^\d+$/.test(source.version),'SOURCE_VERSION');
 check(/^[0-9a-f]{32}$/i.test(source.md5Checksum || ''),'SOURCE_MD5');
 return {schema:1,parserVersion:PARSER_VERSION,mappingHash:mappingHash(),...(packingVersion===1?{packingVersion:1}:{}),source:copy(source),sourceKey:sourceKey(source,mappingHash()),offset:0,parser:null,header:null,sawPreamble:false,rows:0,comments:0,points:0,normalizedBytes:0,batch:0,sourceHash:new IncrementalSha256().snapshot(),normalizedHash:new IncrementalSha256().snapshot(),firstTime:null,lastTime:null,nonIncreasingTimes:0,previousManifest:null,complete:false};
}
export function checkpointBytes(cp){const b=encodeUtf8(JSON.stringify(cp));check(b.length<=LIMITS.checkpoint,'CHECKPOINT_TOO_LARGE');return b;}
// Caller must read one verified range at cp.offset. No partial result escapes on parse failure.
// Returned outputs are bounded per asset AND per invocation. They remain staged until writer commit.
export function prepareRange(cp, bytes){
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
export function buildStagedPayloads(prepared,{outputIds,manifestId,checkpointId}){
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
