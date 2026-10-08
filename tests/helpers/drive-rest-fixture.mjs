// Local HTTP-shaped Drive emulator only. No network. It adapts the retained
// owner-bootstrap fixture so generated GAS exercises the REAL REST adapter.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export function installDriveRestFixture(f,{aroundRequest,aroundBatch,allowOwnerBootstrapReads=false,createProof=false}={}){
 const original=f.globals.UrlFetchApp.fetch,calls=[],batches=[];let activeBatch=null;
 const response=(status,body)=>{const bytes=Buffer.from(typeof body==='string'?body:JSON.stringify(body));return {getResponseCode:()=>status,getContent:()=>Uint8Array.from(bytes),getContentText:()=>bytes.toString('utf8'),getAllHeaders:()=>({'Content-Length':String(bytes.length)})};};
 f.globals.UrlFetchApp.fetch=(url,request)=>{
  const u=new URL(url),method=request.method||'get';assert.equal(u.origin,'https://www.googleapis.com');assert.equal(request.followRedirects,false);
  // The pre-existing explicit owner-editor configuration verifier still uses
  // its legacy metadata reader. Public handler fixtures keep this disabled.
  if(!(allowOwnerBootstrapReads&&request.timeoutSeconds===undefined&&method==='get'&&u.pathname.startsWith('/drive/v3/files/')&&(u.searchParams.has('fields')||u.searchParams.get('alt')==='media'))){assert.equal(request.validateHttpsCertificates,true);assert(Number.isInteger(request.timeoutSeconds));assert(request.timeoutSeconds>=1&&request.timeoutSeconds<=8);}
  const kind=u.pathname.endsWith('/generateIds')?'ids':u.pathname.startsWith('/upload/')?method==='patch'?'hint-update':'create':u.searchParams.get('alt')==='media'?'media':'metadata';
  const call={kind,method,path:u.pathname,timeoutSeconds:request.timeoutSeconds,...(activeBatch?{batchId:activeBatch.id}:{})};calls.push(call);
  const perform=()=>{
   if(kind==='ids'){assert.equal(method,'get');return response(200,f.globals.Drive.Files.generateIds({count:Number(u.searchParams.get('count')),space:'drive',type:'files'}));}
   if(kind==='create'){
    assert.equal(method,'post');assert.equal(u.searchParams.get('uploadType'),'multipart');assert.equal(u.searchParams.get('ignoreDefaultVisibility'),'true');
    const boundary=/^multipart\/related; boundary=([A-Za-z0-9_-]+)$/.exec(request.contentType)?.[1];assert(boundary);
    const body=Buffer.from(request.payload.map(x=>x&255)),separator=Buffer.from('\r\n--'+boundary+'\r\n'),tail=Buffer.from('\r\n--'+boundary+'--\r\n');
    assert(body.subarray(body.length-tail.length).equals(tail));const metaStart=body.indexOf('\r\n\r\n')+4,metaEnd=body.indexOf(separator,metaStart);assert(metaStart>=4&&metaEnd>metaStart);
    const meta=JSON.parse(body.subarray(metaStart,metaEnd).toString('utf8')),bytesStart=body.indexOf('\r\n\r\n',metaEnd+separator.length)+4;assert(bytesStart>metaEnd);
    const bytes=Uint8Array.from(body.subarray(bytesStart,body.length-tail.length));
    try{const created=f.globals.Drive.Files.create(meta,{bytes},{fields:u.searchParams.get('fields'),ignoreDefaultVisibility:true});const proof={...f.files.get(created.id).meta,version:'1',sha256Checksum:createHash('sha256').update(bytes).digest('hex')};return response(200,createProof===true?proof:typeof createProof==='function'?createProof(proof):created);}catch(error){if(error.code===409||/409/.test(error.message))return response(409,{error:{code:409}});throw error;}
   }
   if(kind==='hint-update'){
    assert.equal(method,'patch');assert.equal(u.searchParams.get('uploadType'),'media');const id=u.pathname.split('/').at(-1),entry=f.files.get(id);assert(entry);assert.equal(entry.meta.appProperties['mypace.role'],'checkpoint-hint');
    entry.bytes=Uint8Array.from(request.payload,x=>x&255);entry.meta.size=String(entry.bytes.length);f.events?.push(['rest-update',id]);return response(200,{id});
   }
   assert.equal(method,'get');return original(url,request);
  };
  return aroundRequest?aroundRequest(call,perform):perform();
 };
 f.globals.UrlFetchApp.fetchAll=requests=>{
  assert(Array.isArray(requests)&&requests.length>=1&&requests.length<=16);assert(requests.every(r=>r.method==='get'||r.method==='post'&&requests.length<=4&&r.url.startsWith('https://www.googleapis.com/upload/drive/v3/files?')));
  const batch={id:batches.length+1,subrequests:requests.length};batches.push(batch);
  const perform=()=>{const previous=activeBatch;activeBatch=batch;let failure=null;const responses=[];try{for(const request of requests){const {url,...params}=request;try{responses.push(f.globals.UrlFetchApp.fetch(url,params));}catch(error){responses.push(null);if(!failure)failure=error;}}}finally{activeBatch=previous;}if(failure)throw failure;return responses;};
  return aroundBatch?aroundBatch(batch,perform):perform();
 };
 return {calls,batches};
}
