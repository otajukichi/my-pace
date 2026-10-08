// Trusted owner time-trigger boundary. No HTTP dispatcher, trigger installer,
// background work on load, or progress in ScriptProperties. Event shape rejects
// accidental/wrong entry paths; it is NOT authentication. The actual effective
// execution identity and immutable script/store pins remain authoritative.
import {OWNER_STORE_PROPERTY,parsePinnedOwnerStoreConfig} from './owner-bootstrap.mjs';
import {createGasCheckpointHintCodec} from './checkpoint-hint.mjs';
import {createGasPreparationCodec} from './preparation-codec.mjs';
import {createGasDiscoveryStateCodec} from './discovery-state.mjs';
import {createOwnerScheduler,OWNER_LIMITS} from './owner-scheduler.mjs';
export const SCHEDULED_OWNER_EMAIL='yakitorihanbagu0412@gmail.com';
export const SCHEDULED_DEFAULTS=Object.freeze({sliceMs:60000,calls:750,steps:3,rangeBytes:1048576,scanIntervalMs:3600000,catchUp:true});
const fail=code=>{const e=Error(code);e.code=code;throw e;};
const normalized=x=>typeof x==='string'?x.trim().toLowerCase():'';
const integer=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
function optionsFor(options){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['now',...Object.keys(SCHEDULED_DEFAULTS)].includes(k)))fail('SCHEDULED_CONFIG_INVALID');
 const c={...SCHEDULED_DEFAULTS,...options};
 if(!integer(c.sliceMs,30000,60000)||!integer(c.calls,256,1000)||!integer(c.steps,1,4)||!integer(c.rangeBytes,16384,1048576)||!integer(c.scanIntervalMs,900000,86400000)||typeof c.catchUp!=='boolean'||(c.now!==undefined&&typeof c.now!=='function'))fail('SCHEDULED_CONFIG_INVALID');
 return c;
}
function assertClockEvent(globals,event){
 const full=globals?.ScriptApp?.AuthMode?.FULL;
 if(full===undefined||!event||typeof event!=='object'||Array.isArray(event)||event.authMode!==full||typeof event.triggerUid!=='string'||!/^\d{1,128}$/.test(event.triggerUid)||['parameter','parameters','postData','queryString','source','calendarId','response'].some(k=>k in event))fail('SCHEDULED_EVENT_REQUIRED');
 const fields=[['year',1970,9999],['month',1,12],['day-of-month',1,31],['day-of-week',1,7],['hour',0,23],['minute',0,59],['second',0,59]];
 if(fields.some(([k,min,max])=>!integer(event[k],min,max))||typeof event.timezone!=='string'||event.timezone.length<1||event.timezone.length>128||/[\0\r\n]/.test(event.timezone))fail('SCHEDULED_EVENT_REQUIRED');
}
function guardedConfig(globals,event){
 assertClockEvent(globals,event);
 const {Session,ScriptApp,PropertiesService}=globals||{};
 if(typeof Session?.getEffectiveUser!=='function'||typeof ScriptApp?.getScriptId!=='function'||typeof PropertiesService?.getScriptProperties!=='function')fail('SCHEDULED_IDENTITY_UNAVAILABLE');
 let effective,active='';
 try{
  effective=normalized(Session.getEffectiveUser().getEmail());
  // Active user is normally unavailable for a clock trigger. If supplied by
  // GAS, a contradictory identity still fails closed. Never read e.user.
  if(typeof Session.getActiveUser==='function')active=normalized(Session.getActiveUser().getEmail());
 }catch(_){fail('SCHEDULED_OWNER_UNVERIFIED');}
 if(effective!==SCHEDULED_OWNER_EMAIL||(active!==''&&active!==SCHEDULED_OWNER_EMAIL))fail('SCHEDULED_OWNER_UNVERIFIED');
 const writerScriptId=ScriptApp.getScriptId();
 let raw;try{raw=PropertiesService.getScriptProperties().getProperty(OWNER_STORE_PROPERTY);}catch(_){fail('SCHEDULED_CONFIG_UNRESOLVED');}
 const config=parsePinnedOwnerStoreConfig(raw,{ownerEmail:SCHEDULED_OWNER_EMAIL,writerScriptId,datasetGeneration:'1',acceptedEpochs:['default']});
 if(!config)fail('OWNER_BOOTSTRAP_REQUIRED');
 if(ScriptApp.getScriptId()!==writerScriptId)fail('SCHEDULED_SCRIPT_MISMATCH');
 // The existing owner-managed server secret is only read after all identity
 // and pinned-configuration guards. Never return/log it or persist progress in
 // properties. Legacy stores/no secret keep conservative anchor recovery.
 if(config.checkpointHintId||config.discoveryStateId){
  const secret=PropertiesService.getScriptProperties().getProperty('MYPACE_WRITER_SECRET');
  if(secret!==null&&secret!==undefined&&secret!=='')return {...config,...(config.checkpointHintId?{checkpointHintCodec:createGasCheckpointHintCodec({Utilities:globals.Utilities,secret}),preparationCodec:createGasPreparationCodec({Utilities:globals.Utilities,secret})}:{}),...(config.discoveryStateId?{discoveryStateCodec:createGasDiscoveryStateCodec({Utilities:globals.Utilities,secret})}:{})};
 }
 return config;
}
export function createScheduledImportRuntime(globals,options={}){
 const settings=optionsFor(options); // Construction is pure; check each tick.
 return Object.freeze({tick:event=>{
  const now=settings.now||(()=>Date.now()),started=now();
  const config=guardedConfig(globals,event);
  const limits={...OWNER_LIMITS,runtimeMs:OWNER_LIMITS.runtimeMs,calls:settings.calls,steps:settings.steps};
  const scheduler=createOwnerScheduler(globals,{...config,rangeBytes:settings.rangeBytes,finalizationBatchLimit:1,maxFreshOutputs:8,writerLimits:{checkpointEvery:settings.catchUp?16:(config.checkpointHintCodec?4:16)}},{now,deadlineMs:started+OWNER_LIMITS.runtimeMs,limits,scanIntervalMs:settings.scanIntervalMs,reserveMs:Math.min(15000,Math.floor(settings.sliceMs/4)),settleCalls:128,scheduledPolicy:{sliceMs:settings.sliceMs,rangeBytes:settings.rangeBytes,maxFreshOutputs:8,maxStalls:3,catchUp:settings.catchUp}});
  const result=scheduler.tick();result.usage.elapsedMs=Math.max(0,now()-started);return result;
 }});
}
