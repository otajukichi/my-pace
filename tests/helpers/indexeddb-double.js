// Transactional protocol double, not a browser IndexedDB implementation.
// Tests controller acknowledgement ordering; real browser storage QA is separate.
export function indexedDBDouble(seed){
 let data=structuredClone(seed),pending=null,pause=false,fail=false,writes=0;
 const api={
   open(){const request={};queueMicrotask(()=>{request.result={close(){},transaction(_name,mode){const tx={error:null};let staged;
     const store={get(){const read={};queueMicrotask(()=>{read.result=structuredClone(data);read.onsuccess?.();if(mode==='readwrite'){
       const finish=()=>{if(fail){fail=false;tx.error=Error('IDB_QUOTA');tx.onabort?.();}else{if(staged!==undefined)data=staged;writes++;tx.oncomplete?.();}};
       if(pause){pause=false;pending=finish;}else queueMicrotask(finish);
     }});return read;},put(value){staged=structuredClone(value);}};
     tx.objectStore=()=>store;tx.abort=()=>{tx.error=Error('IDB_ABORT');queueMicrotask(()=>tx.onabort?.());};return tx;
   }};request.onsuccess?.();});return request;},
   pause(){pause=true;},release(){const finish=pending;pending=null;finish?.();},fail(){fail=true;},
   get pending(){return !!pending;},get writes(){return writes;},read(){return structuredClone(data);}
 };return api;
}
