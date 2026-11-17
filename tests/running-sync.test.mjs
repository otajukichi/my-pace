import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSyncStatus,syncPresentation} from '../lib/running-sync.js';
export const sample=()=>({schema:1,kind:'running-sync-status',updatedAt:Date.UTC(2026,10,18),status:'WATCHING',enabled:true,phase:'watch',sources:7,importedSources:4,pendingSources:3,nextRunAt:null,waitReason:null,lastSuccessfulUpdate:null,catalogHash:'a'.repeat(64),budget:{limitMinutes:90,usedMinutes:23.76,reserveMinutes:6,requestLimit:19800,requests:1302},errorCode:null});
test('status accepts summaries and rejects coordinates, arbitrary strings, missing fields and invalid numbers',()=>{
 const s=sample();assert.deepEqual(validateSyncStatus(s),s);
 for(const bad of [{...s,latitude:35},{...s,errorCode:'private@example.com'},{...s,sources:-1},{...s,budget:{...s.budget,token:'secret'}},{...s,nextRunAt:NaN}])assert.throws(()=>validateSyncStatus(bad));
 assert.equal(validateSyncStatus({schema:1,kind:'running-sync-status',available:false}),null);
});
test('budget wait shows a resume date and keeps records, but an overdue heartbeat never claims healthy sync',()=>{
 const s={...sample(),status:'BUDGET_WAIT',waitReason:'EXECUTION_BUDGET',nextRunAt:Date.UTC(2026,10,19)};
 let v=syncPresentation(s,{now:s.updatedAt+8*3600000});assert.equal(v.label,'上限回復待ち');assert.match(v.detail,/11\/19/);assert.match(v.detail,/自動再開予定/);assert.match(v.detail,/そのまま/);
 v=syncPresentation(s,{now:s.nextRunAt+16*60000});assert.match(v.label,/届いていません/);
 assert.match(syncPresentation(sample(),{now:s.updatedAt+16*60000}).label,/届いていません/);
});
test('ready, missing status, connection failure, refresh failure and stopped states remain distinct',()=>{
 const s=sample(),opts={now:s.updatedAt};
 assert.match(syncPresentation({...s,status:'READY',enabled:false},opts).label,/開始待ち/);
 assert.match(syncPresentation(null,opts).label,/未接続/);
 assert.match(syncPresentation(s,{...opts,error:'offline'}).label,/確認できません/);
 assert.match(syncPresentation(s,{...opts,refreshError:'failed'}).detail,/前回/);
 assert.match(syncPresentation({...s,status:'STOPPED',enabled:false},opts).label,/停止中/);
 assert.match(syncPresentation({...s,status:'OWNER_PRIVATE_REQUIRED',enabled:false,errorCode:'OWNER_PRIVATE_REQUIRED'},opts).label,/確認が必要/);
});
