// In-process HTTP/auth -> public sync API -> generated GAS -> HTTP-shaped Drive
// fixture. Browser cookies and IndexedDB remain protocol doubles, not real UI.
import {createCloudSync,createIndexedDBStorage} from '../../src/lib/cloud-sync.js';
import {createSyncHandler} from '../../api/sync.js';
import {createAuthHandler} from '../../server/auth.mjs';
import {configuration,seal,SESSION_COOKIE} from '../../server/security.mjs';
import {keyedIndexedDBDouble} from './indexeddb-keyed-double.js';
import {gasWebFixture} from './gas-web-fixture.mjs';
export function cloudEndpointFixture(options={}){
 const gas=gasWebFixture(options),calls=[];
 const env={MYPACE_ORIGIN:'https://fixture.example',GOOGLE_CLIENT_ID:'123.apps.googleusercontent.com',MYPACE_SESSION_SECRET:'synthetic-local-session-key-32bytes',MYPACE_SECURITY_GENERATION:'1',MYPACE_OWNER_SUB:'123456',MYPACE_STORE_ID:gas.config.storeId};
 const cfg=configuration(env),syncHandler=createSyncHandler({env,writer:async(action,payload)=>gas.invoke(action,payload)});
 const authHandler=createAuthHandler({env,verify:async token=>JSON.parse(token)});
 function profile({idb=keyedIndexedDBDouble(),authenticated=true,extra={}}={}){
  const cookies=new Map(),hooks={},n={offline:false};
  const signIn=()=>{const now=Date.now();cookies.set(SESSION_COOKIE,seal({kind:'session',sub:cfg.ownerSub,generation:cfg.generation,csrf:'test-csrf',iat:now,exp:now+30*86400000},cfg.sessionKey));};
  if(authenticated)signIn();
  const fetcher=async(path,options={})=>{
   if(n.offline)throw Error('offline fixture');
   const request={path,action:path==='/api/sync'?JSON.parse(options.body).action:null,payload:path==='/api/sync'?JSON.parse(options.body).payload:null};calls.push(structuredClone(request));
   await hooks.before?.(request);
   const headers=Object.fromEntries(Object.entries(options.headers||{}).map(([key,value])=>[key.toLowerCase(),value]));
   Object.assign(headers,{origin:cfg.origin,'sec-fetch-site':'same-origin',cookie:[...cookies].map(([key,value])=>key+'='+value).join('; ')});
   const req={url:path,method:options.method||'GET',headers,body:options.body},responseHeaders={};let body,status;
   const res={statusCode:200,setHeader(key,value){responseHeaders[key.toLowerCase()]=value;},end(value){body=value;status=this.statusCode;}};
   await (path==='/api/sync'?syncHandler:authHandler)(req,res);
   const setCookies=responseHeaders['set-cookie'];for(const item of setCookies===undefined?[]:Array.isArray(setCookies)?setCookies:[setCookies]){
    const first=item.split(';')[0],index=first.indexOf('='),name=first.slice(0,index),value=first.slice(index+1);if(/Max-Age=0(?:;|$)/.test(item))cookies.delete(name);else cookies.set(name,value);
   }
   const response={status,body:JSON.parse(body)};await hooks.after?.(request,response);
   if(response.status!==status||response.body!==undefined)body=JSON.stringify(response.body);
   return new Response(body,{status:response.status,headers:{'Content-Type':'application/json'}});
  };
  const a=createCloudSync({storage:createIndexedDBStorage(idb),fetcher,sleep:async()=>{},...extra});
  const login=async()=>{const c=await a.login();return a.completeLogin(JSON.stringify({iss:'https://accounts.google.com',aud:cfg.clientId,exp:Math.floor(Date.now()/1000)+600,email_verified:true,email:cfg.ownerEmail,nonce:c.nonce,sub:cfg.ownerSub}),c.csrf);};
  return {a,idb,hooks,n,cookies,signIn,login};
 }
 return {gas,calls,env,profile};
}
