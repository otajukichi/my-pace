import {configuration,random,seal,unseal,cookie,cookies,session,sameOrigin,jsonBody,respond,errorResponse,fail,SESSION_COOKIE,CHALLENGE_COOKIE,equal} from './security.mjs';
let google;
async function verifyGoogle(token,audience){if(!google){try{const {OAuth2Client}=await import('google-auth-library');google=new OAuth2Client();}catch{fail('GOOGLE_AUTH_UNAVAILABLE',503);}}return (await google.verifyIdToken({idToken:token,audience})).getPayload();}
export function createAuthHandler({env=process.env,verify=verifyGoogle,now=()=>Date.now()}={}){return async(req,res)=>{try{
 const cfg=configuration(env),path=(req.url||'').split('?')[0].split('/').at(-1);
 if(path==='session'&&req.method==='GET'){let s;try{s=session(req,cfg);}catch(e){if(e.status!==401&&e.code!=='OWNER_PROVISIONING_REQUIRED')throw e;return respond(res,200,{ok:true,authenticated:false,configured:!!cfg.ownerSub});}return respond(res,200,{ok:true,authenticated:true,csrf:s.csrf,expiresAt:s.exp});}
 if(path==='challenge'&&req.method==='POST'){sameOrigin(req,cfg);const nonce=random(),csrf=random(),issuedAt=now(),p={kind:'challenge',nonce,csrf,iat:issuedAt,exp:issuedAt+600000};res.setHeader('Set-Cookie',cookie(CHALLENGE_COOKIE,seal(p,cfg.sessionKey),600));return respond(res,200,{ok:true,clientId:cfg.clientId,nonce,csrf});}
 if(path==='login'&&req.method==='POST'){
  sameOrigin(req,cfg);const p=unseal(cookies(req)[CHALLENGE_COOKIE],cfg.sessionKey,now());if(p.kind!=='challenge'||p.exp-p.iat>600000||!equal(req.headers['x-mypace-csrf'],p.csrf))fail('LOGIN_CHALLENGE_INVALID',403);
  const b=await jsonBody(req,16384);if(Object.keys(b).join(',')!=='credential'||typeof b.credential!=='string'||b.credential.length>12000)fail('LOGIN_INVALID');
  let identity;try{identity=await verify(b.credential,cfg.clientId);}catch(e){if(e.status===503)throw e;fail('GOOGLE_ID_TOKEN_INVALID',401);}
  if(!identity||!['accounts.google.com','https://accounts.google.com'].includes(identity.iss)||identity.aud!==cfg.clientId||!Number.isFinite(identity.exp)||identity.exp*1000<=now()||identity.email_verified!==true||identity.email?.toLowerCase()!==cfg.ownerEmail||!equal(identity.nonce,p.nonce)||typeof identity.sub!=='string'||!/^\d{5,100}$/.test(identity.sub))fail('OWNER_FORBIDDEN',403);
  res.setHeader('Set-Cookie',cookie(CHALLENGE_COOKIE,'',0));
  if(!cfg.ownerSub)return respond(res,200,{ok:true,authenticated:false,provisioningRequired:true,ownerSubject:identity.sub});
  if(identity.sub!==cfg.ownerSub)fail('OWNER_FORBIDDEN',403);
  const issuedAt=now(),s={kind:'session',sub:cfg.ownerSub,generation:cfg.generation,csrf:random(),iat:issuedAt,exp:issuedAt+30*86400000};res.setHeader('Set-Cookie',[cookie(CHALLENGE_COOKIE,'',0),cookie(SESSION_COOKIE,seal(s,cfg.sessionKey),30*86400)]);return respond(res,200,{ok:true,authenticated:true,csrf:s.csrf,expiresAt:s.exp});
 }
 if(path==='logout'&&req.method==='POST'){session(req,cfg,{mutation:true});res.setHeader('Set-Cookie',[cookie(SESSION_COOKIE,'',0),cookie(CHALLENGE_COOKIE,'',0)]);return respond(res,200,{ok:true});}
 fail('METHOD_NOT_ALLOWED',405);
 }catch(e){errorResponse(res,e);}};}
export default createAuthHandler();
