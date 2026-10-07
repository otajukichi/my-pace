import test from 'node:test';import assert from 'node:assert/strict';
import {CsvBytes,sensorRow,candidate,sourceKey,sourceUnchanged,commitBatch} from './import-core.mjs';
const decode=b=>new TextDecoder('utf-8',{fatal:true}).decode(b), enc=s=>new TextEncoder().encode(s);
function parse(b,cut){const rows=[];const p=new CsvBytes({decode});p.feed(b.slice(0,cut),r=>rows.push(r));const q=new CsvBytes({decode,state:p.snapshot()});q.feed(b.slice(cut),r=>rows.push(r),true);return rows;}
test('UTF8, quoted newline, escaped quotes, CRLF and checkpoint at every byte',()=>{const b=enc('\uFEFFa,b\r\n"日\n本","x""y"\r\nlast,');for(let i=0;i<=b.length;i++)assert.deepEqual(parse(b,i),[['a','b'],['日\n本','x"y'],['last','']]);});
test('empty, empty fields, final newline',()=>{assert.deepEqual(parse(enc(''),0),[]);assert.deepEqual(parse(enc(',\n'),1),[['','']]);});
test('malformed quoting rejects',()=>{for(const s of ['a"b','"a"x','"a'])assert.throws(()=>parse(enc(s),1));});
test('invalid UTF8 rejects',()=>assert.throws(()=>parse(Uint8Array.from([0xc3,10]),1)));
test('bounded row and field memory',()=>{assert.throws(()=>new CsvBytes({decode,maxFieldBytes:2}).feed(enc('aaa'),()=>{}),/FIELD/);assert.throws(()=>new CsvBytes({decode,maxRowBytes:2}).feed(enc('a,b'),()=>{}),/ROW/);});
test('sensor preamble and named columns',()=>{assert.equal(sensorRow(['# sensor:multi_record']).kind,'comment');const h=sensorRow(['time','longitude','speed','latitude']).header;assert.deepEqual(sensorRow(['2026-01-01T00:00:00Z','2','-1','1'],h).point,{time:'2026-01-01T00:00:00Z',lat:1,lon:2,speed:null});});
test('bad headers, values and widths reject',()=>{assert.throws(()=>sensorRow(['time']));const h=['time','latitude','longitude'];for(const r of [['bad','1','2'],['2026-01-01T00:00:00Z','','2'],['2026-01-01T00:00:00Z','91','2'],['x']])assert.throws(()=>sensorRow(r,h));});
const f={id:'f',name:'a.csv',parents:['folder'],mimeType:'text/csv',version:'1',size:'10',md5Checksum:'hash'};
test('only direct children, no shortcuts or deleted files',()=>{assert.ok(candidate(f,'folder'));for(const d of [{parents:['else']},{trashed:true},{mimeType:'application/vnd.google-apps.shortcut'},{name:'x.txt'}])assert.ok(!candidate({...f,...d},'folder'));});
test('rename dedup; content/config change yields new candidate; mid-read version changes abort',()=>{assert.equal(sourceKey(f,'map'),sourceKey({...f,name:'b.csv',version:'2'},'map'));assert.notEqual(sourceKey(f,'map'),sourceKey({...f,md5Checksum:'other'},'map'));assert.notEqual(sourceKey(f,'map'),sourceKey(f,'map2'));assert.ok(!sourceUnchanged(f,{...f,version:'2'},'folder'));assert.ok(sourceUnchanged(f,f,'folder'));});
test('crashes before/after output, verification and commit are idempotent',async()=>{
 for(let fail=1;fail<=6;fail++){
  const assets=new Map(),receipts=new Map();let n=0;const crash=()=>{if(++n===fail)throw Error('CRASH');};
  const io={receipt:async k=>receipts.get(k),putOnce:async(k,d,v)=>{crash();if(!assets.has(k))assets.set(k,{d,v});crash();return k;},verify:async(k,d)=>{crash();assert.equal(assets.get(k).d,d);crash();},commitOnce:async(k,r)=>{crash();if(!receipts.has(k))receipts.set(k,r);crash();return receipts.get(k);}};
  const batch={job:'job',index:0,digest:'digest',output:'synthetic',checkpoint:{offset:20}};
  try{await commitBatch(io,batch);}catch(e){assert.equal(e.message,'CRASH');}
  n=100;await commitBatch(io,batch);await commitBatch(io,batch);assert.equal(assets.size,1);assert.equal(receipts.size,1);assert.equal(receipts.values().next().value.checkpoint.offset,20);
  await assert.rejects(commitBatch(io,{...batch,digest:'changed'}),/BATCH_MISMATCH/);
 }
});
test('BOM before a quoted first field at every split',()=>{const b=enc('\uFEFF"a",b\n');for(let i=0;i<=b.length;i++)assert.deepEqual(parse(b,i),[['a','b']]);});
test('invalid calendar day and excess column count reject',()=>{assert.throws(()=>sensorRow(['2026-02-30T00:00:00Z','1','2'],['time','latitude','longitude']),/INVALID_TIME/);assert.throws(()=>parse(enc(','.repeat(128)),10),/TOO_MANY_FIELDS/);});
test('Google-native renamed CSV is never a direct binary CSV candidate',()=>{assert.equal(candidate({...f,mimeType:'application/vnd.google-apps.spreadsheet'},'folder'),false);});
