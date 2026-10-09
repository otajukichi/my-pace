// Explicit owner installation only. Loading this module never installs a trigger.
// Google clock triggers are approximate (nearMinute ±15 minutes), not an SLA.
export const BACKUP_SCHEDULE_PROPERTY='mypace.backup.schedule.v1';
export const BACKUP_DAILY_HANDLER='MyPaceBackupDailyTick';
export const BACKUP_CONTINUE_HANDLER='MyPaceBackupContinueTick';
const fail=code=>{throw Error(code);};
export function createBackupSchedule(globals,{ownerEmail,now=Date.now}={}){
 const {ScriptApp,Session,PropertiesService,LockService}=globals||{};
 const owner=String(ownerEmail||'').toLowerCase();
 function ownerGuard(){if(Session.getActiveUser().getEmail().toLowerCase()!==owner||Session.getEffectiveUser().getEmail().toLowerCase()!==owner||!owner)fail('BACKUP_OWNER_REQUIRED');}
 function read(){const raw=PropertiesService.getScriptProperties().getProperty(BACKUP_SCHEDULE_PROPERTY);if(!raw)return null;let s;try{s=JSON.parse(raw);}catch(_){fail('BACKUP_SCHEDULE_INVALID');}if(s.protocol!=='mypace-backup-schedule-v1'||s.owner!==owner||s.scriptId!==ScriptApp.getScriptId()||typeof s.triggerId!=='string'||!s.triggerId)fail('BACKUP_SCHEDULE_INVALID');return s;}
 function save(s){const p=PropertiesService.getScriptProperties(),raw=JSON.stringify(s);p.setProperty(BACKUP_SCHEDULE_PROPERTY,raw);if(p.getProperty(BACKUP_SCHEDULE_PROPERTY)!==raw)fail('BACKUP_SCHEDULE_WRITE_UNCONFIRMED');}
 function enable(){ownerGuard();const lock=LockService.getScriptLock();if(!lock.tryLock(1000))fail('BACKUP_BUSY');try{
  const existing=read(),triggers=ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()===BACKUP_DAILY_HANDLER);
  // Unknown existing trigger is not silently adopted: cadence cannot be inspected.
  if(existing){const matching=triggers.filter(t=>t.getUniqueId()===existing.triggerId);if(matching.length===1&&triggers.length===1)return {...existing,status:'backup-schedule-enabled',alreadyEnabled:true};if(triggers.length)fail('BACKUP_SCHEDULE_REVIEW_REQUIRED');}
  if(triggers.length)fail('BACKUP_SCHEDULE_REVIEW_REQUIRED');
  const trigger=ScriptApp.newTrigger(BACKUP_DAILY_HANDLER).timeBased().atHour(3).nearMinute(0).everyDays(1).inTimezone('Asia/Tokyo').create();
  const s={protocol:'mypace-backup-schedule-v1',owner,scriptId:ScriptApp.getScriptId(),triggerId:String(trigger.getUniqueId()),timezone:'Asia/Tokyo',hour:3,minute:0,installedAt:now()};save(s);
  return {...s,status:'backup-schedule-enabled',alreadyEnabled:false};
 }finally{lock.releaseLock();}}
 function authorizeEvent(event){const s=read();const uid=String(event?.triggerUid||'');const handler=uid===s?.triggerId?BACKUP_DAILY_HANDLER:uid===s?.continuationId?BACKUP_CONTINUE_HANDLER:null;if(!handler||Session.getEffectiveUser().getEmail().toLowerCase()!==owner)fail('BACKUP_TRIGGER_UNAUTHORIZED');const active=Session.getActiveUser().getEmail().toLowerCase();if(active&&active!==owner)fail('BACKUP_TRIGGER_UNAUTHORIZED');if(event.authMode!==ScriptApp.AuthMode.FULL)fail('BACKUP_TRIGGER_UNAUTHORIZED');const matching=ScriptApp.getProjectTriggers().filter(t=>t.getUniqueId()===uid&&t.getHandlerFunction()===handler);if(matching.length!==1)fail('BACKUP_TRIGGER_UNAUTHORIZED');return s;}
 function continueAfter(event,pending){authorizeEvent(event);const lock=LockService.getScriptLock();if(!lock.tryLock(1000))fail('BACKUP_BUSY');try{const s=read(),uid=String(event.triggerUid),isDaily=uid===s.triggerId;const existing=ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()===BACKUP_CONTINUE_HANDLER);for(const t of existing){if(t.getUniqueId()!==s.continuationId)fail('BACKUP_SCHEDULE_REVIEW_REQUIRED');ScriptApp.deleteTrigger(t);}delete s.continuationId;if(isDaily||!s.cycleStartedAt)s.cycleStartedAt=now();if(pending&&now()-s.cycleStartedAt<60*60*1000){const t=ScriptApp.newTrigger(BACKUP_CONTINUE_HANDLER).timeBased().after(5*60*1000).create();s.continuationId=String(t.getUniqueId());}save(s);return {continuationScheduled:!!s.continuationId,continuationWindowExpired:pending&&!s.continuationId};}finally{lock.releaseLock();}}
 function status(){ownerGuard();const s=read();return s?{...s,status:ScriptApp.getProjectTriggers().some(t=>t.getUniqueId()===s.triggerId&&t.getHandlerFunction()===BACKUP_DAILY_HANDLER)?'backup-schedule-enabled':'backup-schedule-missing'}:{status:'backup-schedule-disabled'};}
 return Object.freeze({enable,authorizeEvent,continueAfter,status});
}
