import {mac,equal,errorResponse,fail} from './security.mjs';
import {writerConfiguration,callWriter} from './writer-client.mjs';
import {driveChangeTokenInput} from '../storage/drive-change-discovery.mjs';
// This separate webhook cannot invoke browser/owner mutation actions. Google
// sends no file metadata; only a registered channel's authenticated hint passes.
export function createDriveChangeReceiver({env=process.env,writer=callWriter,now=()=>Date.now()}={}){
 const admitted=new Map(); // Best-effort abuse bound only; never evidence of receipt.
 return async(req,res)=>{try{
  if(req.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
  if(env.MYPACE_DRIVE_CHANGES_ENABLED!=='true'||env.VERCEL_ENV==='preview')fail('DRIVE_CHANGE_DISABLED',503);
  const cfg=writerConfiguration(env);
  const header=name=>{const value=req.headers?.[name];if(typeof value!=='string'||value.length>1024||/[\r\n\0]/.test(value))fail('DRIVE_CHANGE_FORBIDDEN',403);return value;};
  const channelId=header('x-goog-channel-id'),resourceId=header('x-goog-resource-id'),resourceState=header('x-goog-resource-state'),messageNumber=header('x-goog-message-number'),token=header('x-goog-channel-token');
  if(!/^[A-Za-z0-9_-]{1,256}$/.test(channelId)||resourceId.length>256||!resourceId||!['sync','change'].includes(resourceState)||!/^\d{1,30}$/.test(messageNumber)||!equal(token,mac(driveChangeTokenInput(cfg.store,channelId),cfg.key)))fail('DRIVE_CHANGE_FORBIDDEN',403);
  const time=now(),last=admitted.get(channelId);
  if(last!==undefined&&time-last<1000)fail('DRIVE_CHANGE_RATE_LIMIT',429);
  if(admitted.size>=256&&!admitted.has(channelId))admitted.delete(admitted.keys().next().value);
  admitted.set(channelId,time);
  // Never trust a supplied resource URI, file ID, body, or query as work input.
  // Await durable GAS receipt. No waitUntil/volatile in-process acknowledgement.
  const result=await writer('driveChangeHint',{channelId,resourceId,resourceState,messageNumber,token},{env});
  if(!result?.ok||result.result?.accepted!==true)fail('DRIVE_CHANGE_RECEIPT_UNAVAILABLE',503);
  res.statusCode=204;res.setHeader('Cache-Control','no-store');res.end();
 }catch(error){errorResponse(res,error);}};
}
