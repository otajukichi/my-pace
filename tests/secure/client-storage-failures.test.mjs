import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudEndpointFixture} from '../helpers/cloud-endpoint-fixture.mjs';
import {keyedIndexedDBDouble} from '../helpers/indexeddb-keyed-double.js';
const date='2026-10-07',edit=(a,text)=>({...a.state(),diary:{[date]:{text,mood:null}}});
const httpError=(status,reason)=>{const bytes=Buffer.from(JSON.stringify({error:{code:status,errors:[{reason}]}}));return {getResponseCode:()=>status,getContent:()=>Uint8Array.from(bytes),getContentText:()=>bytes.toString(),getAllHeaders:()=>({'Content-Length':String(bytes.length)})};};
for(const [status,reason]of [[401,'authError'],[403,'insufficientFilePermissions'],[403,'storageQuotaExceeded'],[429,'rateLimitExceeded'],[503,'backendError']])for(const scope of ['metadata','create'])test(`Drive ${status}/${reason} during ${scope} preserves original pending edit and receipt-safe retry`,async()=>{
 let blocked=false,hits=0;const f=cloudEndpointFixture({activate:true,aroundRequest(call,perform){if(blocked&&call.kind===scope){hits++;return httpError(status,reason);}return perform();}}),c=f.profile();await c.a.init();await c.a.maintenance();
 const before=c.idb.read();blocked=true;await c.a.commit(c.a.state(),edit(c.a,'exact unsent diary '+status+' '+scope));await c.a.sync({automatic:true});
 assert(hits>0);assert.equal(c.a.view().pending,1);assert.equal(c.a.view().conflicts.length,0);assert.equal(c.idb.read().outbox[0].status,'pending');assert.equal(c.a.view().verified,false);assert(c.a.view().retryAt>0);assert.equal(c.idb.read().syncCheckpoint.seq,before.syncCheckpoint.seq);
 const original=structuredClone(c.idb.read().outbox[0].command);c.a.destroy();blocked=false;const next=f.profile({idb:c.idb});await next.a.init();assert.equal(next.a.view().pending,0);assert.equal(next.a.view().conflicts.length,0);assert.equal(next.a.view().error,null);assert.equal(next.idb.read().entities['diary:'+date].version,1);assert.equal(next.idb.read().syncCheckpoint.seq,1);
 const sent=f.calls.filter(call=>call.action==='command').map(call=>call.payload);assert(sent.length>=2);assert(sent.every(command=>JSON.stringify(command)===JSON.stringify(original)));next.a.destroy();
});

test('Drive access loss after a confirmed baseline keeps every cached record and checkpoint unchanged',async()=>{
 let denied=false;const f=cloudEndpointFixture({activate:true,aroundRequest(call,perform){return denied&&call.kind==='metadata'?httpError(403,'insufficientFilePermissions'):perform();}}),c=f.profile();await c.a.init();await c.a.commit(c.a.state(),edit(c.a,'already confirmed'));await c.a.sync();await c.a.maintenance();const before=c.idb.read();denied=true;await c.a.sync();
 assert.equal(c.a.view().verified,false);assert.equal(c.a.view().recordsConfirmed,true);assert.equal(c.a.view().pending,0);assert.deepEqual(c.idb.read().entities,before.entities);assert.deepEqual(c.idb.read().syncCheckpoint,before.syncCheckpoint);assert.deepEqual(c.idb.read().minimumObserved,before.minimumObserved);assert.equal(c.a.state().diary[date].text,'already confirmed');denied=false;await c.a.sync();assert.equal(c.a.view().verified,true);c.a.destroy();
});

test('aborted v1 upgrade preserves the original owner and UUID before any authenticated network work',async()=>{
 const f=cloudEndpointFixture({activate:true}),first=f.profile();await first.a.init();first.n.offline=true;await first.a.commit(first.a.state(),edit(first.a,'pending before upgrade'));await first.a.sync({automatic:true});const legacy=first.idb.read();delete legacy.localRevision;const original=structuredClone(legacy.outbox[0].command);first.a.destroy();
 const idb=keyedIndexedDBDouble(legacy),c=f.profile({idb});idb.failUpgrade();const count=f.calls.length;await assert.rejects(c.a.init(),/IDB_UPGRADE_ABORT/);assert.equal(f.calls.length,count);assert.equal(idb.version,1);assert.deepEqual(idb.read(),legacy);assert.deepEqual(idb.rows('state'),[legacy]);
 await c.a.init();assert.equal(idb.version,2);assert.equal(c.a.view().pending,0);assert.deepEqual(f.calls.filter(call=>call.action==='command').at(-1).payload,original);assert.deepEqual(idb.rows('state'),[legacy]);assert.equal(c.idb.read().entities['diary:'+date].version,1);c.a.destroy();
});
