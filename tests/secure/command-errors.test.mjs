import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudSync,createIndexedDBStorage} from '../../src/lib/cloud-sync.js';
import {keyedIndexedDBDouble} from '../helpers/indexeddb-keyed-double.js';
import {fixture} from './fixture.mjs';

// HTTP status describes the endpoint response, not whether the user made a
// conflicting record edit. Infrastructure/protocol failures must preserve the
// original pending operation for replay once the deployment is repaired.
for(const status of [400,409])for(const code of ['ACTION_INVALID','UNSUPPORTED_ACTION','REQUEST_FORBIDDEN','PAYLOAD_INVALID','VALIDATION_FAILED','CATALOG_CORRUPT','APP_JOURNAL_CORRUPT','APP_SEQUENCE_EXHAUSTED']){
 test(`${status} ${code} never becomes a user record conflict or replacement UUID`,async()=>{
  const f=fixture(),idb=keyedIndexedDBDouble(),commands=[];let failure=null;
  const fetcher=async(path,options)=>{
   if(path==='/api/auth/session')return Response.json({ok:true,authenticated:true,csrf:'test'});
   const {action,payload}=JSON.parse(options.body);
   if(['pull','recover'].includes(action))return Response.json({ok:false,error:'ACTION_INVALID'},{status:400});
   if(action==='command'){
    commands.push(structuredClone(payload));
    if(failure)return Response.json({ok:false,error:failure},{status});
    return Response.json({ok:true,result:f.api.command(payload)});
   }
   const result=action==='snapshot'?f.api.snapshot(payload):action==='imports'?{revision:f.writer.status().revision,runs:[],nextCursor:null}:{status:'idle'};
   return Response.json({ok:true,result});
  };
  const a=createCloudSync({storage:createIndexedDBStorage(idb),fetcher});await a.init();failure=code;
  await a.commit(a.state(),{...a.state(),diary:{'2026-10-07':{text:'Keep this exact edit',mood:null}}});await a.sync({automatic:true});
  const original=structuredClone(idb.read().outbox[0].command);
  assert.equal(a.view().pending,1);assert.equal(a.view().conflicts.length,0);assert.equal(idb.read().outbox[0].status,'pending');
  assert.equal(a.state().diary['2026-10-07'].text,'Keep this exact edit');assert.equal(a.view().verified,false);assert.equal(a.view().error,code);
  failure=null;await a.sync();assert.equal(a.view().pending,0);assert.equal(a.view().error,null);assert(commands.every(value=>JSON.stringify(value)===JSON.stringify(original)));a.destroy();
 });
}
