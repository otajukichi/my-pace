import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createGasDriveRest} from './gas-drive-rest.mjs';
import {encodeUtf8,decodeUtf8} from './codec.mjs';
const retry=code=>e=>e.code===code&&e.retryable===true;
const error=code=>e=>e.code===code;
const response=(status,body)=>({getResponseCode:()=>status,getContent:()=>Array.from(typeof body==='string'?encodeUtf8(body):body,n=>n>127?n-256:n),getContentText:()=>typeof body==='string'?body:decodeUtf8(body)});
const ok=value=>response(200,JSON.stringify(value));
const metadata=(id='reserved')=>({id,name:'日記-immutable',mimeType:'application/octet-stream',parents:['private_parent'],appProperties:{'mypace.store':'store','mypace.role':'frame'}});
function fixture(options={}){
 const calls=[],events=[],state={now:0,tokenCalls:0,budget:true},token='PRIVATE_EXISTING_TOKEN';
 const f={calls,events,state,handler:()=>ok({id:'reserved'}),tokenHandler:()=>token};
 f.rest=createGasDriveRest({UrlFetchApp:{fetch(url,params){calls.push({url,params});return f.handler(url,params);}},ScriptApp:{getOAuthToken(){state.tokenCalls++;return f.tokenHandler();}}},{deadlineMs:20000,now:()=>state.now,checkBudget:()=>state.budget,onRequest:e=>events.push(e),...options});return f;
}
function requestBytes(call){return Uint8Array.from(call.params.payload,n=>n&255);}
function splitMultipart(call){const boundary=call.params.contentType.split('boundary=')[1],all=requestBytes(call),body=decodeUtf8(all),prefix='--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n',middle='\r\n--'+boundary+'\r\nContent-Type: application/octet-stream\r\n\r\n',tail='\r\n--'+boundary+'--\r\n';assert.ok(body.startsWith(prefix));assert.ok(body.endsWith(tail));const start=body.indexOf(middle);assert.ok(start>0);return {boundary,metadata:JSON.parse(body.slice(prefix.length,start)),text:body.slice(start+middle.length,-tail.length)};}

test('constructing a REST adapter performs no network, token, or budget call',()=>{
 let touches=0;createGasDriveRest({UrlFetchApp:{fetch(){touches++;}},ScriptApp:{getOAuthToken(){touches++;}}},{deadlineMs:20000,checkBudget:()=>{touches++;return true;}});assert.equal(touches,0);
});
test('metadata read preserves raw response and 404 without inventing absence elsewhere',()=>{
 const f=fixture(),r=response(404,'{"error":{"code":404}}');f.handler=()=>r;assert.equal(f.rest.read('reserved','?fields=id%2Cparents'),r);assert.equal(f.calls[0].url,'https://www.googleapis.com/drive/v3/files/reserved?fields=id%2Cparents');assert.equal(f.calls[0].params.timeoutSeconds,8);assert.equal(f.calls[0].params.followRedirects,false);assert.equal(f.calls[0].params.validateHttpsCertificates,true);assert.equal(f.calls[0].params.muteHttpExceptions,true);
});
test('read timeout decreases to whole remaining seconds after response reserve',()=>{
 const f=fixture();f.state.now=15001;f.rest.read('reserved','?fields=id');assert.equal(f.calls[0].params.timeoutSeconds,3);f.state.now=17500;f.rest.read('reserved','?fields=id');assert.equal(f.calls[1].params.timeoutSeconds,1);f.state.now=17501;assert.throws(()=>f.rest.read('reserved','?fields=id'),retry('STORE_YIELD'));assert.equal(f.calls.length,2);
});
test('deadline and budget denial stop before token retrieval or HTTP request',()=>{
 for(const mode of ['deadline','budget']){const f=fixture();if(mode==='deadline')f.state.now=19000;else f.state.budget=false;assert.throws(()=>f.rest.read('reserved','?fields=id'),retry('STORE_YIELD'));assert.equal(f.state.tokenCalls,0);assert.equal(f.calls.length,0);}
});
test('budget and deadline are rechecked after obtaining token',()=>{
 for(const mode of ['deadline','budget']){const f=fixture();f.tokenHandler=()=>{if(mode==='deadline')f.state.now=19000;else f.state.budget=false;return 'token';};assert.throws(()=>f.rest.read('reserved','?fields=id'),retry('STORE_YIELD'));assert.equal(f.state.tokenCalls,1);assert.equal(f.calls.length,0);assert.equal(f.events[0].outcome,'yield');}
});
test('token is memoized within exactly one adapter, without persistence',()=>{
 const f=fixture();f.rest.read('reserved','?fields=id');f.rest.update('reserved',Uint8Array.of(1));f.handler=()=>ok({ids:['new_id']});f.rest.generateIds(1);assert.equal(f.state.tokenCalls,1);assert.ok(f.calls.every(c=>c.params.headers.Authorization==='Bearer PRIVATE_EXISTING_TOKEN'));const g=fixture();g.rest.read('reserved','?fields=id');assert.equal(g.state.tokenCalls,1);
});
test('token and fetch exceptions expose only safe structured errors',()=>{
 const f=fixture();f.tokenHandler=()=>{throw Error('PRIVATE_TOKEN file-secret');};assert.throws(()=>f.rest.read('reserved','?fields=id'),e=>e.code==='STORE_AUTH_UNRESOLVED'&&!JSON.stringify(e).includes('PRIVATE_TOKEN'));assert.equal(f.calls.length,0);
 const g=fixture();g.handler=()=>{throw Error('PRIVATE_TOKEN private URL');};assert.throws(()=>g.rest.read('reserved','?fields=id'),retry('STORE_REQUEST_UNRESOLVED'));assert.equal(g.calls.length,1);assert.equal(g.events[0].outcome,'transport-error');
});
test('malformed tokens cannot enter Authorization headers',()=>{
 for(const value of ['',null,'bad\r\nHeader: value','bad token','あ']){const f=fixture();f.tokenHandler=()=>value;assert.throws(()=>f.rest.read('reserved','?fields=id'),retry('STORE_AUTH_UNRESOLVED'));assert.equal(f.calls.length,0);}
});
test('fixed host and constrained query reject raw URLs and query injection',()=>{
 const f=fixture();for(const id of ['https://evil.example/x','../files','id?x=1'])assert.throws(()=>f.rest.read(id,'?fields=id'),error('STORE_REST_READ_INVALID'));
 for(const suffix of ['https://evil.example/','?alt=media&key=secret','?fields=id&alt=media','?fields=id%26key%3Dsecret','?fields=%zz','?fields=','?fields=id#fragment'])assert.throws(()=>f.rest.read('reserved',suffix));assert.equal(f.calls.length,0);
});
test('media requires bounded Range and forbids header overrides or duplicates',()=>{
 const f=fixture();assert.throws(()=>f.rest.read('reserved','?alt=media'),error('STORE_REST_RANGE_REQUIRED'));
 for(const headers of [{Authorization:'x'},{Host:'evil'},{Range:'bytes=0-2097152'},{Range:'bytes=2-1'},{Range:'bytes=0-1',range:'bytes=0-1'},{Range:'bytes=0-1','Accept-Encoding':'gzip'},{Range:'bytes=0-1\r\nX: y'}])assert.throws(()=>f.rest.read('reserved','?alt=media',headers));assert.equal(f.calls.length,0);
});
test('media read preserves exact signed GAS response bytes and Range header',()=>{
 const f=fixture(),raw=Uint8Array.of(0,127,128,255);f.handler=()=>response(206,raw);const r=f.rest.read('reserved','?alt=media',{Range:'bytes=0-3','Accept-Encoding':'identity'});assert.deepEqual(r.getContent(),[0,127,-128,-1]);assert.deepEqual(f.calls[0].params.headers,{Range:'bytes=0-3','Accept-Encoding':'identity',Authorization:'Bearer PRIVATE_EXISTING_TOKEN'});
});
test('redirects are never followed or returned as success',()=>{
 const f=fixture();f.handler=()=>({getResponseCode:()=>302,getContent(){throw Error('must not read redirect body');},getHeaders:()=>({Location:'https://evil.example/token'})});assert.throws(()=>f.rest.read('reserved','?fields=id'),e=>e.code==='STORE_REDIRECT_UNRESOLVED'&&e.status===302&&e.retryable);assert.equal(f.calls.length,1);assert.equal(f.events[0].status,302);
});
test('metadata and media response byte limits reject oversize and malformed bytes',()=>{
 const f=fixture();f.handler=()=>response(200,new Uint8Array(16385));assert.throws(()=>f.rest.read('reserved','?fields=id'),error('STORE_REST_RESPONSE_TOO_LARGE'));f.handler=()=>response(206,new Uint8Array(2097153));assert.throws(()=>f.rest.read('reserved','?alt=media',{Range:'bytes=0-2'}),error('STORE_REST_RESPONSE_TOO_LARGE'));
 f.handler=()=>({getResponseCode:()=>200,getContent:()=>[256]});assert.throws(()=>f.rest.read('reserved','?fields=id'),error('STORE_REST_RESPONSE_TOO_LARGE'));
});
test('generateIds uses REST fixed parameters and validates exact unique count',()=>{
 const f=fixture();f.handler=()=>ok({ids:['id1','id2']});assert.deepEqual(f.rest.generateIds(2),{ids:['id1','id2']});assert.equal(f.calls[0].url,'https://www.googleapis.com/drive/v3/files/generateIds?count=2&space=drive&type=files&fields=ids');
 for(const value of [{ids:['id1']},{ids:['id1','id1']},{ids:['id1','evil/id']}]){f.handler=()=>ok(value);assert.throws(()=>f.rest.generateIds(2),error('STORE_IDS_INVALID'));}
 for(const count of [0,1001,1.5,'2'])assert.throws(()=>f.rest.generateIds(count),error('STORE_ID_COUNT'));
});
test('non-success ID generation preserves numeric status and does not retry',()=>{
 const f=fixture();f.handler=()=>response(403,'{"error":{"message":"private data"}}');assert.throws(()=>f.rest.generateIds(1),e=>e.code==='STORE_IDS_UNRESOLVED'&&e.status===403&&e.retryable===true&&!JSON.stringify(e).includes('private data'));assert.equal(f.calls.length,1);
});
test('multipart create preserves all metadata and exact UTF-8 bytes with CRLF framing',()=>{
 const f=fixture(),m=metadata(),content='日本語\nline two\r\n';f.rest.create(m,encodeUtf8(content));const c=f.calls[0],parts=splitMultipart(c);assert.deepEqual(parts.metadata,m);assert.equal(parts.text,content);assert.equal(c.params.method,'post');assert.equal(c.url,'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,parents,appProperties,size,trashed,mimeType,ownedByMe,shared,version,sha256Checksum&ignoreDefaultVisibility=true');assert.equal(c.params.timeoutSeconds,8);assert.ok(Array.isArray(c.params.payload));
});
test('multipart preserves binary bytes including NUL, CRLF, high bytes and no conversion',()=>{
 const f=fixture(),data=Uint8Array.of(0,13,10,127,128,255,0);f.rest.create(metadata(),data);const c=f.calls[0],b=requestBytes(c),marker=encodeUtf8('Content-Type: application/octet-stream\r\n\r\n');let pos=-1;outer:for(let i=0;i<b.length-marker.length;i++){for(let j=0;j<marker.length;j++)if(b[i+j]!==marker[j])continue outer;pos=i+marker.length;break;}assert.ok(pos>0);assert.deepEqual(b.slice(pos,pos+data.length),data);assert.ok(c.params.payload.includes(-128));assert.ok(c.params.payload.includes(-1));
});
test('multipart delimiter derives from exact body while delimiter-looking text stays unchanged',()=>{
 const f=fixture(),m=metadata();m.name='mypace_drive_v3_2';const content='\r\n--mypace_drive_v3_1\r\n';f.rest.create(m,encodeUtf8(content));assert.match(f.calls[0].params.contentType,/^multipart\/related; boundary=mp_[a-f0-9]{64}$/);assert.equal(splitMultipart(f.calls[0]).text,content);
});
test('valid content containing every former predictable delimiter remains writable',()=>{
 const f=fixture(),content=Array.from({length:32},(_,i)=>'mypace_drive_v3_'+(i+1)+';').join('');f.rest.create(metadata(),encodeUtf8(content));assert.equal(f.calls.length,1);const parts=splitMultipart(f.calls[0]);assert.equal(parts.text,content);assert.equal(parts.boundary.length,67);assert.equal(content.includes(parts.boundary),false);
});
test('create cannot drop or introduce identity, parent, MIME, or permissions metadata',()=>{
 const f=fixture();for(const m of [{...metadata(),id:undefined},{...metadata(),parents:[]},{...metadata(),parents:['one','two']},{...metadata(),permissions:[{type:'anyone',role:'reader'}]},{...metadata(),mimeType:'application/vnd.google-apps.document'},{...metadata(),appProperties:{bad:undefined}}])assert.throws(()=>f.rest.create(m,Uint8Array.of(1)),error('STORE_REST_METADATA_INVALID'));assert.equal(f.calls.length,0);
});
test('request media and metadata have preflight byte ceilings',()=>{
 const f=fixture();for(const b of [[],new Uint8Array(),new Uint8Array(2097153)])assert.throws(()=>f.rest.create(metadata(),b),error('STORE_REST_MEDIA_INVALID'));assert.throws(()=>f.rest.create({...metadata(),name:'あ'.repeat(6000)},Uint8Array.of(1)),error('STORE_REST_METADATA_TOO_LARGE'));assert.equal(f.calls.length,0);
});
test('timeout after write stays ambiguous with one request and original reserved ID',()=>{
 const f=fixture();let durable;f.handler=(url,params)=>{durable=splitMultipart({url,params});throw Error('timeout after server committed');};assert.throws(()=>f.rest.create(metadata(),encodeUtf8('exact')),retry('STORE_REQUEST_UNRESOLVED'));assert.equal(durable.metadata.id,'reserved');assert.equal(durable.text,'exact');assert.equal(f.calls.length,1);assert.equal(f.events[0].outcome,'transport-error');
});
test('409 occupied create never overwrites, changes ID, or declares byte identity',()=>{
 const f=fixture();f.handler=()=>response(409,'{"error":{"code":409}}');assert.throws(()=>f.rest.create(metadata(),Uint8Array.of(1)),e=>e.code==='STORE_CREATE_UNRESOLVED'&&e.status===409&&e.retryable);assert.equal(f.calls.length,1);assert.equal(f.calls[0].params.method,'post');
});
test('wrong success ID and malformed success body remain unproven',()=>{
 const f=fixture();f.handler=()=>ok({id:'other'});assert.throws(()=>f.rest.create(metadata(),Uint8Array.of(1)),error('STORE_CREATE_ID_MISMATCH'));for(const body of ['not json','null','[]','"private"']){f.handler=()=>response(200,body);assert.throws(()=>f.rest.create(metadata(),Uint8Array.of(1)),retry('STORE_REST_JSON_INVALID'));}
});
test('media-only update stays at exact caller-pinned ID with no metadata mutation',()=>{
 const f=fixture(),b=Uint8Array.of(0,128,255);f.rest.update('reserved',b);assert.equal(f.calls[0].url,'https://www.googleapis.com/upload/drive/v3/files/reserved?uploadType=media&fields=id');assert.equal(f.calls[0].params.method,'patch');assert.equal(f.calls[0].params.contentType,'application/octet-stream');assert.deepEqual(f.calls[0].params.payload,[0,-128,-1]);
 f.handler=()=>response(500,'{}');assert.throws(()=>f.rest.update('reserved',b),e=>e.code==='STORE_HINT_WRITE_UNRESOLVED'&&e.status===500);assert.equal(f.calls.length,2);
});
test('advisory start requires at least seven seconds and no raised deadline',()=>{
 const f=fixture();f.state.now=13000;assert.equal(f.rest.canStartAdvisory(),true);f.state.now=13001;assert.equal(f.rest.canStartAdvisory(),false);let touched=false;assert.throws(()=>f.rest.advisory(()=>{touched=true;}),retry('STORE_YIELD'));assert.equal(touched,false);assert.equal(f.state.tokenCalls,0);
});
test('advisory cap restores after return and exception, including nested advisory calls',()=>{
 const f=fixture();assert.equal(f.rest.advisory(()=>{f.rest.read('reserved','?fields=id');return 7;}),7);f.rest.read('reserved','?fields=id');assert.throws(()=>f.rest.advisory(()=>{f.rest.advisory(()=>f.rest.read('reserved','?fields=id'));throw Error('local');}),/local/);f.rest.read('reserved','?fields=id');assert.deepEqual(f.calls.map(c=>c.params.timeoutSeconds),[2,8,2,8]);
});
test('advisory cannot raise an already smaller timeout cap',()=>{
 const f=fixture({maxTimeoutSeconds:1});f.rest.advisory(()=>f.rest.read('reserved','?fields=id'));assert.equal(f.calls[0].params.timeoutSeconds,1);
});
test('advisory consuming time still yields before later fetch admission',()=>{
 const f=fixture();f.rest.advisory(()=>{f.state.now=17501;assert.throws(()=>f.rest.read('reserved','?fields=id'),retry('STORE_YIELD'));});assert.equal(f.calls.length,0);assert.equal(f.state.tokenCalls,0);
});
test('telemetry contains only safe summary keys and cannot alter request outcome',()=>{
 const f=fixture();f.handler=()=>{f.state.now+=25;return ok({id:'reserved'});};f.rest.create(metadata(),encodeUtf8('PRIVATE_DIARY'));assert.deepEqual(f.events,[{operation:'create',method:'post',elapsedMs:25,status:200,outcome:'ok'}]);const encoded=JSON.stringify(f.events);for(const sensitive of ['PRIVATE_DIARY','PRIVATE_EXISTING_TOKEN','reserved','googleapis','private_parent'])assert.equal(encoded.includes(sensitive),false);
 const g=fixture({onRequest:()=>{throw Error('telemetry unavailable');}});assert.deepEqual(g.rest.update('reserved',Uint8Array.of(1)),{id:'reserved'});
});
test('production module runs in GAS-like VM without Buffer, TextEncoder, URL or Node globals',()=>{
 const codec=fs.readFileSync(new URL('./codec.mjs',import.meta.url),'utf8').replace(/\bexport\s+(?=(?:function|class|const)\b)/g,'');
 const source=fs.readFileSync(new URL('./gas-drive-rest.mjs',import.meta.url),'utf8').replace(/import[^\n]+\n/g,'').replace(/\bexport\s+(?=(?:function|class|const)\b)/g,'');
 const context=vm.createContext({});vm.runInContext(codec+'\n'+source+'\nconst calls=[];const rest=createGasDriveRest({UrlFetchApp:{fetch(url,params){calls.push({url,params});return {getResponseCode:()=>200,getContent:()=>[123,34,105,100,34,58,34,114,101,115,101,114,118,101,100,34,125]};}},ScriptApp:{getOAuthToken:()=>"token"}},{deadlineMs:20000,now:()=>0});rest.create({id:"reserved",name:"one",mimeType:"application/octet-stream",parents:["parent"],appProperties:{"mypace.store":"store"}},Uint8Array.of(0,128,255));this.answer={count:calls.length,timeout:calls[0].params.timeoutSeconds,method:calls[0].params.method};',context);assert.deepEqual(JSON.parse(JSON.stringify(context.answer)),{count:1,timeout:8,method:'post'});
});
test('invalid configuration and clock failures fail before token or request',()=>{
 for(const options of [{deadlineMs:0},{deadlineMs:Infinity},{deadlineMs:20000,maxTimeoutSeconds:0},{deadlineMs:20000,responseReserveMs:-1},{deadlineMs:20000,onRequest:1}])assert.throws(()=>createGasDriveRest({UrlFetchApp:{fetch(){}},ScriptApp:{getOAuthToken(){}}},options),error('STORE_REST_CONFIG'));
 const f=fixture({now:()=>{throw Error('PRIVATE_CLOCK_DETAIL');}});assert.throws(()=>f.rest.read('reserved','?fields=id'),e=>e.code==='STORE_REST_CLOCK_INVALID'&&!JSON.stringify(e).includes('PRIVATE_CLOCK_DETAIL'));assert.equal(f.state.tokenCalls,0);assert.equal(f.calls.length,0);
});
test('a lost update response is never retried inside advisory transport',()=>{
 const f=fixture();let accepted;f.handler=(url,params)=>{accepted=Uint8Array.from(params.payload,n=>n&255);throw Error('late acknowledgment');};assert.throws(()=>f.rest.advisory(()=>f.rest.update('reserved',Uint8Array.of(1,128,255))),retry('STORE_REQUEST_UNRESOLVED'));assert.deepEqual(accepted,Uint8Array.of(1,128,255));assert.equal(f.calls.length,1);assert.equal(f.calls[0].params.timeoutSeconds,2);f.handler=()=>ok({id:'reserved'});f.rest.read('reserved','?fields=id');assert.equal(f.calls[1].params.timeoutSeconds,8);
});
test('HTTP 201 create is accepted only for the exact reserved identifier',()=>{
 const f=fixture();f.handler=()=>response(201,'{"id":"reserved"}');assert.deepEqual(f.rest.create(metadata(),Uint8Array.of(1)),{id:'reserved'});f.handler=()=>response(201,'{"id":"foreign"}');assert.throws(()=>f.rest.create(metadata(),Uint8Array.of(1)),error('STORE_CREATE_ID_MISMATCH'));
});

function batchFixture({fetchAll=true,...options}={}){
 const state={now:0,tokenCalls:0,budget:true,fetches:0,batches:0,requests:[],events:[]},f={state,handler:requests=>requests.map(()=>response(200,'{}'))};
 const globals={UrlFetchApp:{fetch(url,params){state.fetches++;return f.handler([{url,...params}])[0];}},ScriptApp:{getOAuthToken(){state.tokenCalls++;f.onToken?.();return 'PRIVATE_EXISTING_TOKEN';}}};
 if(fetchAll===true)globals.UrlFetchApp.fetchAll=requests=>{state.batches++;state.requests.push(...requests);return f.handler(requests);};else if(fetchAll!==undefined)globals.UrlFetchApp.fetchAll=fetchAll;
 f.rest=createGasDriveRest(globals,{deadlineMs:20000,now:()=>state.now,checkBudget:()=>state.budget,onRequest:e=>state.events.push(e),...options});return f;
}
const reads=n=>Array.from({length:n},(_,i)=>({id:'reserved_'+i,suffix:'?fields=id%2Cparents'}));

test('readMany admits a bounded read-only batch and counts every response without replacing order',()=>{
 const f=batchFixture(),responses=reads(16).map((_,i)=>response(i===4?404:200,JSON.stringify({position:i})));f.handler=()=>responses;
 assert.deepEqual(f.rest.readMany(reads(16)),responses);assert.equal(f.state.batches,1);assert.equal(f.state.fetches,0);assert.equal(f.state.tokenCalls,1);assert.equal(f.state.events.length,16);
 for(const [i,r]of f.state.requests.entries()){assert.equal(r.url,'https://www.googleapis.com/drive/v3/files/reserved_'+i+'?fields=id%2Cparents');assert.equal(r.method,'get');assert.equal(r.headers.Authorization,'Bearer PRIVATE_EXISTING_TOKEN');assert.equal(r.timeoutSeconds,8);assert.equal(r.followRedirects,false);assert.equal(r.validateHttpsCertificates,true);assert.equal(r.payload,undefined);}
});

test('readMany validates every request before token or IO and rejects arbitrary URLs, methods and headers',()=>{
 for(const input of [null,{},reads(17),[...reads(1),{id:'../private',suffix:'?fields=id'}],[...reads(1),{id:'safe',suffix:'?alt=media',headers:{Range:'bytes=0-4',Authorization:'foreign'}}],[{...reads(1)[0],method:'post'}],[{...reads(1)[0],url:'https://example.com'}]]){const f=batchFixture();assert.throws(()=>f.rest.readMany(input));assert.equal(f.state.tokenCalls,0);assert.equal(f.state.batches,0);assert.equal(f.state.fetches,0);}
 const f=batchFixture();assert.deepEqual(f.rest.readMany([]),[]);assert.equal(f.state.tokenCalls,0);
});

test('readMany sequential fallback exists only when fetchAll is absent, never after a batch failure',()=>{
 const state={calls:0,tokens:0};const rest=createGasDriveRest({UrlFetchApp:{fetch(){state.calls++;return response(200,'{}');}},ScriptApp:{getOAuthToken(){state.tokens++;return 'token';}}},{deadlineMs:20000,now:()=>0});assert.equal(rest.readMany(reads(2)).length,2);assert.equal(state.calls,2);assert.equal(state.tokens,1);
 for(const unsupported of [null,false,3]){const f=batchFixture({fetchAll:unsupported});assert.throws(()=>f.rest.readMany(reads(2)),/STORE_REST_BATCH_UNAVAILABLE/);assert.equal(f.state.fetches,0);}
 const f=batchFixture();f.handler=()=>{throw Error('PRIVATE_EXISTING_TOKEN private URL');};assert.throws(()=>f.rest.readMany(reads(3)),e=>e.code==='STORE_REQUEST_UNRESOLVED'&&e.retryable&&!e.message.includes('PRIVATE'));assert.equal(f.state.batches,1);assert.equal(f.state.fetches,0);assert.equal(f.state.events.length,3);
});

test('readMany applies one current bounded timeout after token retrieval and refuses exhausted admission',()=>{
 const f=batchFixture();f.onToken=()=>{f.state.now=15001;};f.rest.readMany(reads(2));assert(f.state.requests.every(r=>r.timeoutSeconds===3));
 for(const mode of ['clock','budget']){const g=batchFixture();g.onToken=()=>{if(mode==='clock')g.state.now=19000;else g.state.budget=false;};assert.throws(()=>g.rest.readMany(reads(2)),retry('STORE_YIELD'));assert.equal(g.state.batches,0);assert.equal(g.state.events.length,2);}
});

test('readMany fails closed on response cardinality, malformed bodies and any redirect while counting all subrequests',()=>{
 for(const result of [null,{},[],[response(200,'{}')],[response(200,'{}'),{}],[response(200,'{}'),response(302,'{}')],[response(200,'{}'),response(200,new Uint8Array(16385))]]){const f=batchFixture();f.handler=()=>result;assert.throws(()=>f.rest.readMany(reads(2)));assert.equal(f.state.events.length,2);assert.equal(f.state.fetches,0);}
});

test('readMany applies exact media admission and preserves HTTP status for the IO verifier',()=>{
 const f=batchFixture(),input=[{id:'node_a',suffix:'?alt=media',headers:{Range:'bytes=0-3','Accept-Encoding':'identity'}},{id:'node_b',suffix:'?fields=id'}],out=[response(206,Uint8Array.of(0,127,128,255)),response(403,'{}')];f.handler=()=>out;assert.deepEqual(f.rest.readMany(input),out);assert.equal(f.state.requests[0].headers.Range,'bytes=0-3');assert.deepEqual(out[0].getContent(),[0,127,-128,-1]);assert.equal(f.state.events[1].outcome,'http-error');
});

const multipartMetadata=request=>{const bytes=Buffer.from(request.payload.map(n=>n&255)),start=bytes.indexOf('\r\n\r\n')+4,boundary=request.contentType.split('boundary=')[1],end=bytes.indexOf('\r\n--'+boundary+'\r\n',start);return JSON.parse(bytes.subarray(start,end).toString('utf8'));};
const nodeFile=(id='node_a',bytes=Uint8Array.of(0,127,128,255))=>({metadata:{...metadata(id),appProperties:{'mypace.store':'store','mypace.role':'index-node'}},bytes});

test('createMany sends only bounded stable-ID immutable node POSTs with finite common timeout and no overwrite method',()=>{
 const f=batchFixture(),input=[nodeFile('node_a'),nodeFile('node_b')];f.handler=requests=>requests.map(r=>ok({id:multipartMetadata(r).id}));assert.deepEqual(f.rest.createMany(input),[{id:'node_a'},{id:'node_b'}]);assert.equal(f.state.batches,1);assert.equal(f.state.fetches,0);assert.equal(f.state.events.length,2);
 for(const [i,r]of f.state.requests.entries()){assert.equal(r.method,'post');assert.match(r.url,/\/upload\/drive\/v3\/files\?uploadType=multipart&fields=id,parents,appProperties,size,trashed,mimeType,ownedByMe,shared,version,sha256Checksum&ignoreDefaultVisibility=true$/);assert.equal(r.timeoutSeconds,8);assert.equal(r.followRedirects,false);assert.equal(r.validateHttpsCertificates,true);assert.deepEqual(multipartMetadata(r),input[i].metadata);}
});

test('createMany rejects a bad later node, duplicate ID, mutable role and total-size overflow before any IO',()=>{
 const samples=[Array.from({length:5},(_,i)=>nodeFile('node_'+i)),[nodeFile(),nodeFile()],[nodeFile(),{...nodeFile('node_b'),bytes:new Uint8Array()}],[nodeFile(),{...nodeFile('node_b'),metadata:{...metadata('node_b'),appProperties:{'mypace.store':'store','mypace.role':'checkpoint-hint'}}}],[nodeFile('node_a',new Uint8Array(600000)),nodeFile('node_b',new Uint8Array(600000))],[nodeFile(),{...nodeFile('node_b'),metadata:{...nodeFile('node_b').metadata,parents:['../invalid']}}]];
 for(const input of samples){const f=batchFixture();assert.throws(()=>f.rest.createMany(input));assert.equal(f.state.tokenCalls,0);assert.equal(f.state.batches,0);assert.equal(f.state.fetches,0);}
});

test('createMany admits exactly one MiB and four nodes, but any partial error remains ambiguous without retry',()=>{
 const f=batchFixture(),input=Array.from({length:4},(_,i)=>nodeFile('node_'+i,new Uint8Array(262144)));f.handler=requests=>requests.map(r=>ok({id:multipartMetadata(r).id}));assert.equal(f.rest.createMany(input).length,4);assert.equal(f.state.batches,1);
 for(const bad of [response(409,'{}'),response(403,'{}'),response(503,'{}'),ok({id:'wrong'}),response(200,'not JSON')]){const g=batchFixture();g.handler=()=>[ok({id:'node_a'}),bad];assert.throws(()=>g.rest.createMany([nodeFile('node_a'),nodeFile('node_b')]));assert.equal(g.state.batches,1);assert.equal(g.state.fetches,0);assert.equal(g.state.events.length,2);}
});

test('createMany response loss after remote work never allocates IDs, retries, or falls back to serial creates',()=>{
 const f=batchFixture();let executed=0;f.handler=requests=>{executed=requests.length;throw Error('lost POST responses');};assert.throws(()=>f.rest.createMany([nodeFile('stable_a'),nodeFile('stable_b')]),retry('STORE_REQUEST_UNRESOLVED'));assert.equal(executed,2);assert.equal(f.state.batches,1);assert.equal(f.state.fetches,0);assert(f.state.requests.every(r=>r.method==='post'));
});

test('explicit compact managed hint admission permits four seconds but never skips per-call deadline',()=>{
 const f=fixture({advisoryMinMs:4000});f.state.now=16000;assert.equal(f.rest.canStartAdvisory(),true);
 f.handler=()=>{f.state.now+=1000;return ok({id:'reserved'});};
 f.rest.advisory(()=>{f.rest.read('reserved','?fields=id');f.rest.update('reserved',Uint8Array.of(1));});assert.equal(f.state.now,18000);
 const g=fixture({advisoryMinMs:4000});g.state.now=16000;g.handler=()=>{g.state.now+=2000;return ok({id:'reserved'});};
 assert.throws(()=>g.rest.advisory(()=>{g.rest.read('reserved','?fields=id');g.rest.update('reserved',Uint8Array.of(1));}),retry('STORE_YIELD'));assert.equal(g.calls.length,1,'second request is never dispatched beyond remaining response reserve');
 for(const advisoryMinMs of [0,3999,30001,NaN])assert.throws(()=>fixture({advisoryMinMs}),/STORE_REST_CONFIG/);
});
