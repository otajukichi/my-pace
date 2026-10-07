// Local test-only GAS/Drive simulator. Never included in the production bundle.
import assert from 'node:assert/strict';
import {createOwnerBootstrap,OWNER_STORE_PROPERTY} from './owner-bootstrap.mjs';
import {encodeUtf8,decodeUtf8} from './codec.mjs';
const MIME='application/vnd.google-apps.folder';
const copy=x=>structuredClone(x);
export function ownerBootstrapFixture(options={}){
 const state={active:'owner@example.com',effective:'owner@example.com',script:'script_1',held:false,budget:true,serial:0,...options};
 const events=[],files=new Map(),properties=new Map([['existing.source','unchanged'],['old.probe','probe-folder']]);
 const root={id:'mydrive',mimeType:MIME,ownedByMe:true,shared:false,trashed:false};
 files.set('mydrive',{meta:root});files.set('probe-folder',{meta:{...copy(root),id:'probe-folder',name:'MyPace Private Store',parents:['mydrive']}});
 const response=(status,body,headers={})=>({getResponseCode:()=>status,getContentText:()=>typeof body==='string'?body:decodeUtf8(body),getContent:()=>typeof body==='string'?encodeUtf8(body):body,getAllHeaders:()=>headers});
 const lock={hasLock:()=>state.held,tryLock:()=>{events.push(['lock']);if(state.busy)return false;state.held=true;return true;},releaseLock:()=>{events.push(['unlock']);state.held=false;}};
 const globals={
  Session:{getActiveUser:()=>({getEmail:()=>state.active}),getEffectiveUser:()=>({getEmail:()=>state.effective})},
  ScriptApp:{getScriptId:()=>state.script,getOAuthToken:()=>{events.push(['token']);return 'private-token';}},
  LockService:{getScriptLock:()=>lock},
  PropertiesService:{getScriptProperties:()=>({
   getProperty:key=>{events.push(['property-read',key]);if(state.propertyReadFault)state.propertyReadFault(key);return properties.get(key)??null;},
   setProperty:(key,value)=>{events.push(['property-write',key,value]);if(state.beforePropertyWrite)state.beforePropertyWrite(key,value);properties.set(key,value);if(state.afterPropertyWrite)state.afterPropertyWrite(key,value);}
  })},
  Utilities:{newBlob:(b,m,n)=>({bytes:Uint8Array.from(b,x=>x&255),mime:m,name:n})},
  Drive:{Files:{
   generateIds:request=>{events.push(['ids',copy(request)]);if(state.idsFault)return state.idsFault(request);return {ids:Array.from({length:request.count},()=>`reserved_${++state.serial}`)};},
   create:(meta,blob,request)=>{
    events.push(['create',copy(meta),blob?copy(blob.bytes):null,copy(request)]);
    assert.equal(state.held,true);assert.ok(properties.has(OWNER_STORE_PROPERTY));
    if(state.beforeCreate)state.beforeCreate(meta,blob,request);
    if(files.has(meta.id))throw Error('409 conflict');
    if(!state.skipCreate)files.set(meta.id,{meta:{...copy(meta),ownedByMe:true,shared:false,trashed:false,...(blob?{size:String(blob.bytes.length)}:{})},...(blob?{bytes:copy(blob.bytes)}:{})});
    if(state.afterCreate)state.afterCreate(meta,blob,request);
    return state.createResult??{id:meta.id};
   },
   list:()=>{throw Error('Folder listing and name adoption forbidden');},
   update:()=>{throw Error('Updates forbidden');},delete:()=>{throw Error('Deletes forbidden');}
  }},
  UrlFetchApp:{fetch:(url,request)=>{
   const u=new URL(url),fileId=decodeURIComponent(u.pathname.split('/').at(-1));events.push(['fetch',fileId,copy(request)]);
   assert.equal(u.origin,'https://www.googleapis.com');assert.equal(request.method,'get');assert.equal(request.followRedirects,false);assert.equal(request.muteHttpExceptions,true);
   if(state.fetchFault){const r=state.fetchFault(fileId,u,request);if(r)return r;}
   const entry=files.get(fileId==='root'?'mydrive':fileId);if(!entry)return response(404,'{}');
   if(u.searchParams.get('alt')!=='media')return response(200,JSON.stringify(entry.meta));
   assert.ok(/^bytes=0-\d+$/.test(request.headers.Range));const b=entry.bytes;
   return response(206,b,{'Content-Range':`bytes 0-${b.length-1}/${b.length}`,'Content-Length':String(b.length)});
  }}
 };
 const config={ownerEmail:'owner@example.com',expectedScriptId:'script_1',checkBudget:()=>state.budget};
 const api=overrides=>createOwnerBootstrap(globals,{...config,...overrides});
 const bootstrap=()=>api().bootstrap();
 return {globals,state,events,files,properties,config,api,bootstrap,lock,response};
}
