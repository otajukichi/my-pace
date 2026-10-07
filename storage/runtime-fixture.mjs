// Local test-only GAS/Drive simulator. Never included in the GAS bundle.
import {encodeUtf8,decodeUtf8} from './codec.mjs';
import {SOURCE_FOLDER_ID} from './transport.mjs';
import {createHash} from 'node:crypto';
export function runtimeFixture(csv='# sensor:multi_record\ntime,latitude,longitude\n2026-01-01T00:00:00Z,1,2\n'){
 const files=new Map();let serial=0,held=false,failAfterCreate=null;const calls=[];
 const folder=id=>({id,mimeType:'application/vnd.google-apps.folder',ownedByMe:true,shared:false,trashed:false});
 files.set('metadata',{meta:folder('metadata')});files.set('assets',{meta:folder('assets')});
 const bytes=encodeUtf8(csv);const source={id:'source',name:'fixture.csv',mimeType:'text/csv',size:String(bytes.length),version:'1',md5Checksum:createHash('md5').update(bytes).digest('hex'),parents:[SOURCE_FOLDER_ID],trashed:false,capabilities:{canDownload:true}};
 files.set('source',{meta:source,bytes});
 const lock={hasLock:()=>held,tryLock:()=>{if(held)return false;held=true;return true;},releaseLock:()=>{held=false;}};
 const response=(status,body,headers={})=>({getResponseCode:()=>status,getContentText:()=>typeof body==='string'?body:decodeUtf8(body),getContent:()=>typeof body==='string'?encodeUtf8(body):body,getAllHeaders:()=>headers});
 const globals={
  ScriptApp:{getScriptId:()=> 'writer',getOAuthToken:()=> 'test-token'},LockService:{getScriptLock:()=>lock},
  Utilities:{newBlob:(b,m,n)=>({bytes:Uint8Array.from(b,x=>x&255),mime:m,name:n}),sleep:()=>{}},
  Drive:{Files:{
   generateIds:({count})=>({ids:Array.from({length:count},()=>`fixed_${++serial}`)}),
   get:id=>{calls.push(['get',id]);const f=files.get(id);if(!f){const e=Error('not found');e.code=404;throw e;}return structuredClone(f.meta);},
   list:()=>({files:[structuredClone(source)]}),
   create:(m,b)=>{calls.push(['create',m.id]);if(files.has(m.id)){const e=Error('conflict');e.code=409;throw e;}files.set(m.id,{meta:{...structuredClone(m),size:String(b.bytes.length),version:'1',md5Checksum:createHash('md5').update(b.bytes).digest('hex'),ownedByMe:true,shared:false,trashed:false},bytes:Uint8Array.from(b.bytes)});if(failAfterCreate?.(m)){throw Error('injected lost response');}return {id:m.id};}
  }},
  UrlFetchApp:{fetch:(url,options)=>{const u=new URL(url);const id=decodeURIComponent(u.pathname.split('/').pop());calls.push(['fetch',id]);const f=files.get(id);if(!f)return response(404,'{}');if(u.searchParams.get('alt')!=='media')return response(200,JSON.stringify(f.meta));const range=/^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);if(!range)throw Error('range required');const start=Number(range[1]),end=Number(range[2]);return response(206,f.bytes.slice(start,end+1),{'Content-Range':`bytes ${start}-${end}/${f.bytes.length}`,'Content-Length':String(end-start+1)});}}
 };
 const config={storeId:'store',writerScriptId:'writer',anchorId:'anchor',metadataParentId:'metadata',assetsParentId:'assets',checkBudget:()=>true};
 return {globals,config,files,source,calls,lock,setCreateFault:fn=>{failAfterCreate=fn;}};
}
