// Shared data contract. This module performs no IO and never activates a store.
export const SYNC_APP_CHANGE_HEAD='app/change-head';
export const SYNC_APP_CHANGE_CAPACITY=1024;
export function syncAppChangeSlot(seq){return 'app/change-slot/'+(seq%SYNC_APP_CHANGE_CAPACITY);}
export function initialSyncAppChangeHead(){return {protocol:2,seq:0,floor:1,capacity:SYNC_APP_CHANGE_CAPACITY};}
export function validateSyncAppChangeHead(entity){
 const fail=()=>{const e=Error('APP_JOURNAL_CORRUPT');e.code=e.message;throw e;};
 if(!entity||entity.deleted)fail();const h=entity.value;
 if(!h||typeof h!=='object'||Array.isArray(h)||Object.keys(h).sort().join(',')!=='capacity,floor,protocol,seq'||h.protocol!==2||!Number.isSafeInteger(h.seq)||h.seq<0||h.capacity!==SYNC_APP_CHANGE_CAPACITY||h.floor!==Math.max(1,h.seq-SYNC_APP_CHANGE_CAPACITY+1))fail();
 return h;
}
