import {mac,random,fail} from './security.mjs';
import {canonical} from '../src/lib/entity-codec.js';
export function writerConfiguration(env){const url=env.MYPACE_WRITER_URL;if(!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url||'')||!env.MYPACE_WRITER_SECRET||Buffer.byteLength(env.MYPACE_WRITER_SECRET)<32||!/^[-A-Za-z0-9_]{1,128}$/.test(env.MYPACE_STORE_ID||''))fail('WRITER_NOT_CONFIGURED',503);return {url,key:env.MYPACE_WRITER_SECRET,store:env.MYPACE_STORE_ID,owner:'yakitorihanbagu0412@gmail.com'};}
async function boundedJson(response){const reader=response.body?.getReader();if(!reader)fail('WRITER_RESPONSE_INVALID',502);const chunks=[];let n=0;for(;;){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>1048576){await reader.cancel();fail('WRITER_RESPONSE_TOO_LARGE',502);}chunks.push(Buffer.from(value));}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('WRITER_RESPONSE_INVALID',502);}}
export async function callWriter(action,payload,{env=process.env,fetcher=fetch,now=Date.now}={}){
 const cfg=writerConfiguration(env),unsigned={v:1,ts:now(),nonce:random(),owner:cfg.owner,store:cfg.store,action,payload},envelope={...unsigned,signature:mac(canonical(unsigned),cfg.key)};
 const signal=AbortSignal.timeout(['command','commandV2','recover','maintain','pull','snapshot'].includes(action)?55000:25000);let response=await fetcher(cfg.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(envelope),redirect:'manual',signal});
 // ContentService emits a one-use GET location. Never forward the signed body
 // to a redirect, accounts login, arbitrary host, or a second redirect.
 if([302,303].includes(response.status)){let u;try{u=new URL(response.headers.get('location'));}catch{fail('WRITER_REDIRECT_INVALID',502);}if(u.protocol!=='https:'||u.hostname!=='script.googleusercontent.com'||u.port||u.username||u.password)fail('WRITER_REDIRECT_INVALID',502);response=await fetcher(u.href,{method:'GET',redirect:'manual',signal});}
 if(response.status!==200)fail('WRITER_UNAVAILABLE',503);const result=await boundedJson(response);if(!result||typeof result.ok!=='boolean')fail('WRITER_RESPONSE_INVALID',502);return result;
}
