import {canonical} from '../src/lib/entity-codec.js';
const fail=code=>{const e=Error(code);e.code=code;throw e;};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===(keys?keys.split(','):[]).sort().join(',');
function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
export function createSignedDispatcher({owner,store,secret,hmac,byteLength,now=()=>Date.now(),createServices}){
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
export function createCursorCodec({secret,hmac,encode,decode,now=()=>Date.now()}){
 return {
 sealCursor(value){const text=encode(canonical({value,exp:now()+600000}));return text+'.'+hmac('cursor:'+text,secret);},
 openCursor(token){if(typeof token!=='string'||token.length>8192)fail('CURSOR_INVALID');const [text,sig,...rest]=token.split('.');if(rest.length||!equal(hmac('cursor:'+text,secret),sig))fail('CURSOR_INVALID');let p;try{p=JSON.parse(decode(text));}catch{fail('CURSOR_INVALID');}if(!exact(p,'value,exp')||!Number.isSafeInteger(p.exp)||p.exp<=now()||p.exp>now()+600000)fail('CURSOR_EXPIRED');return p.value;}
 };
}
