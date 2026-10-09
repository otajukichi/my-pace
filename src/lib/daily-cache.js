// A disposable derived cache. This database is isolated from all records/outbox
// databases: opening it never upgrades, deletes or rewrites the user's records.
export const DAILY_CACHE_DATABASE='mypace.daily-derived.v1';
export function createDailyCacheStorage(indexedDB=globalThis.indexedDB,{maxDays=16,maxBytes=4*1024*1024,openTimeoutMs=250}={}){
  let owner=null,opening=null,closed=false;
  const digest=async value=>{try{const data=new TextEncoder().encode(JSON.stringify(value));const hash=await globalThis.crypto.subtle.digest('SHA-256',data);return [...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('');}catch{return null;}};
  function open(){
    if(closed||!indexedDB?.open)return Promise.resolve(null);
    if(opening)return opening;
    opening=new Promise(resolve=>{let finished=false,request,timer;const done=db=>{if(finished){db?.close();return;}finished=true;clearTimeout(timer);resolve(db);};
      try{request=indexedDB.open(DAILY_CACHE_DATABASE,1);request.onupgradeneeded=()=>request.result.createObjectStore('days',{keyPath:'key'});request.onerror=()=>done(null);request.onblocked=()=>done(null);request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();opening=null;};done(db);};timer=setTimeout(()=>done(null),openTimeoutMs);}catch{done(null);}
    });return opening;
  }
  async function get(key,expectedOwner){
    if(!expectedOwner||owner!==expectedOwner)return null;const db=await open();if(!db||owner!==expectedOwner||closed)return null;
    const row=await new Promise(resolve=>{let timer;const done=value=>{clearTimeout(timer);resolve(value);};try{const tx=db.transaction('days','readonly'),request=tx.objectStore('days').get(key);let value=null;request.onsuccess=()=>{const row=request.result;if(row?.owner===expectedOwner&&row.key===key&&Number.isFinite(row.bytes)&&row.bytes>0&&row.bytes<=maxBytes)value=row;};tx.oncomplete=()=>done(owner===expectedOwner&&!closed?value:null);tx.onerror=tx.onabort=()=>done(null);timer=setTimeout(()=>{done(null);try{tx.abort();}catch{}},250);}catch{done(null);}});
    if(!row)return null;const checksum=await digest(row.daily);if(owner!==expectedOwner||closed)return null;if(!checksum||checksum!==row.checksum){void remove(key);return null;}const {checksum:ignored,...value}=row;return value;
  }
  async function put(row){
    if(!row?.owner||owner!==row.owner||row.bytes>maxBytes)return false;const checksum=await digest(row.daily);if(!checksum)return false;row={...row,checksum};const db=await open();if(!db||owner!==row.owner||closed)return false;
    return new Promise(resolve=>{try{const tx=db.transaction('days','readwrite'),store=tx.objectStore('days'),request=store.getAll();request.onsuccess=()=>{if(owner!==row.owner||closed){tx.abort();return;}const rows=(request.result||[]).filter(r=>r.key!==row.key&&r.owner===owner&&Number.isFinite(r.bytes)&&r.bytes>0&&r.bytes<=maxBytes).sort((a,b)=>b.savedAt-a.savedAt);const keep=[row];let bytes=row.bytes;for(const candidate of rows)if(keep.length<maxDays&&bytes+candidate.bytes<=maxBytes){keep.push(candidate);bytes+=candidate.bytes;}const keys=new Set(keep.map(r=>r.key));for(const old of request.result||[])if(!keys.has(old.key))store.delete(old.key);store.put(row);};tx.oncomplete=()=>resolve(true);tx.onerror=tx.onabort=()=>resolve(false);}catch{resolve(false);}});
  }
  async function remove(key){const db=await open();if(!db||closed)return;await new Promise(resolve=>{try{const tx=db.transaction('days','readwrite');tx.objectStore('days').delete(key);tx.oncomplete=tx.onerror=tx.onabort=resolve;}catch{resolve();}});}
  async function clear(){const db=await open();if(!db||closed)return;await new Promise(resolve=>{try{const tx=db.transaction('days','readwrite'),store=tx.objectStore('days'),request=store.getAll();request.onsuccess=()=>{for(const row of request.result||[])store.delete(row.key);};tx.oncomplete=tx.onerror=tx.onabort=resolve;}catch{resolve();}});}
  return {get,put,remove,clear,setScope(next){owner=typeof next==='string'&&next?next:null;},close(){closed=true;owner=null;opening?.then(db=>db?.close());}};
}
