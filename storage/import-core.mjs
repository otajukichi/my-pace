// Local tested core. GAS adapter/Drive durable writer integration is deliberately not wired.
export const PARSER_VERSION = 'sensor-multi-v1';
export class CsvBytes {
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
export function sensorRow(row, header) {
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
export function candidate(file, folderId) {
  return !file.trashed && typeof file.mimeType==='string' && !file.mimeType.startsWith('application/vnd.google-apps.') &&
    file.parents?.includes(folderId) && /\.csv$/i.test(file.name) && file.mimeType!=='application/vnd.google-apps.folder';
}
export function sourceKey(file, mappingHash) {
  // version is observation metadata; unchanged content on a rename must not duplicate a run.
  if(!file.id||!file.md5Checksum||!file.size||!mappingHash)throw Error('SOURCE_IDENTITY_REQUIRED');
  return JSON.stringify([file.id,file.md5Checksum,String(file.size),PARSER_VERSION,mappingHash]);
}
export function sourceUnchanged(before,after,folderId) {
  return candidate(after,folderId)&&['id','version','md5Checksum','size'].every(k=>String(before[k])===String(after[k]));
}
// Model of a durable batch boundary. Adapter must implement putOnce/read receipt under the
// existing writer protocol, NOT mutable overwrite. Outputs precede checkpoint advancement.
export async function commitBatch(io, {job, index, digest, output, checkpoint}) {
  const key=JSON.stringify([job,index]);
  const old=await io.receipt(key);
  if(old){if(old.digest!==digest)throw Error('BATCH_MISMATCH');return old;}
  const asset=await io.putOnce(key,digest,output);
  await io.verify(asset,digest);
  return io.commitOnce(key,{digest,asset,checkpoint});
}
