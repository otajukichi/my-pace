// Deterministic IndexedDB *protocol* double. This exercises API calls, rollback,
// serialization and IO counts, not browser transaction scheduling or disk durability.
const copy=value=>structuredClone(value);
const keyString=key=>JSON.stringify(key);
const keyAt=(value,path)=>Array.isArray(path)?path.map(p=>value[p]):value[path];
export function keyedIndexedDBDouble(seed){
 let version=seed===undefined?0:1,stores=new Map(),running=false,upgrading=false,pause=false,hold=null,failWrite=false,failUpgrade=false,writes=0;
 if(seed!==undefined)stores.set('state',{keyPath:null,indexes:new Map(),rows:new Map([[keyString('owner'),{key:'owner',value:copy(seed)}]])});
 const connections=new Set(),queue=[],opens=[],metrics={};
 const stats=name=>metrics[name]??=( {get:0,getAll:0,openCursor:0,put:0,delete:0,rowsRead:0,rowsWritten:0,bytesRead:0,bytesWritten:0});
 function count(name,method,values=[]){const m=stats(name);m[method]=(m[method]||0)+1;const bytes=values.reduce((n,v)=>n+JSON.stringify(v??null).length,0);if(method==='get'||method==='getAll'||method==='cursorRead'){m.rowsRead+=values.filter(v=>v!==undefined).length;m.bytesRead+=bytes;}if(method==='put'){m.rowsWritten+=values.length;m.bytesWritten+=bytes;}}
 function pump(){if(running||!queue.length)return;running=true;queue.shift()();}
 function txFor(db,names,mode,onEnd){
  const tx={error:null,db,mode},scope=Array.isArray(names)?names:[names];let active=false,ended=false,pending=0,ticket=0,ready=false,released=false;
  let schema,overlays=new Map();
  const writing=mode!=='readonly';
  const held=writing&&mode!=='versionchange'&&pause;if(held){pause=false;hold=()=>{released=true;hold=null;if(ready)finish();};}
  function finish(){if(ended)return;if(held&&!released){ready=true;return;}ended=true;
   const injected=mode==='versionchange'?failUpgrade:writing&&failWrite;if(mode==='versionchange')failUpgrade=false;else if(writing)failWrite=false;
   if(injected){tx.error=Error(mode==='versionchange'?'IDB_UPGRADE_ABORT':'IDB_QUOTA');tx.onabort?.();onEnd?.(false);}
   else{if(writing){for(const [name,changes] of overlays){const target=schema.get(name);for(const [key,row] of changes)if(row===undefined)target.rows.delete(key);else target.rows.set(key,row);}stores=schema;if(mode!=='versionchange')writes++;}tx.oncomplete?.();onEnd?.(true);}
   running=false;pump();drainOpens();
  }
  function idle(){const own=++ticket;queueMicrotask(()=>queueMicrotask(()=>queueMicrotask(()=>queueMicrotask(()=>{if(active&&!ended&&!pending&&ticket===own)finish();}))));}
  function operate(fn,existing){if(ended)throw Error('TransactionInactiveError');const r=existing||{};pending++;ticket++;
   const work=()=>queueMicrotask(()=>{if(ended){pending--;return;}try{const value=fn();r.result=value?._cursor?value:copy(value);r.onsuccess?.({target:r});}catch(e){r.error=e;r.onerror?.({target:r});tx.error=e;tx.abort();}pending--;idle();});
   if(active)work();else workQueue.push(work);return r;
  }
  const workQueue=[];
  function descriptor(name){const s=(schema||stores).get(name);if(!s)throw Error('NotFoundError');return s;}
  function current(name,key){const changes=overlays.get(name);return changes?.has(key)?changes.get(key):descriptor(name).rows.get(key);}
  function all(name){const rows=new Map(descriptor(name).rows);for(const [key,value]of overlays.get(name)||[])if(value===undefined)rows.delete(key);else rows.set(key,value);return [...rows.values()];}
  function cursorFor(name,query,indexPath){
   const r={};let entries=null,position=0;stats(name).openCursor++;
   const next=()=>operate(()=>{
    if(!entries)entries=all(name).filter(row=>query===undefined||keyString(indexPath?keyAt(row.value,indexPath):row.key)===keyString(query)).sort((a,b)=>keyString(a.key).localeCompare(keyString(b.key)));
    const row=entries[position++];if(!row)return undefined;count(name,'cursorRead',[row.value]);
    return {_cursor:true,key:copy(indexPath?keyAt(row.value,indexPath):row.key),primaryKey:copy(row.key),value:copy(row.value),continue(){next();},delete(){return storeFor(name).delete(row.key);}};
   },r);next();return r;
  }
  function storeFor(name){if(mode!=='versionchange'&&!scope.includes(name))throw Error('NotFoundError');return {
   openCursor(query){return cursorFor(name,query);},
   get(key){return operate(()=>{const value=current(name,keyString(key))?.value;count(name,'get',[value]);return value;});},
   getAll(query){return operate(()=>{const values=all(name).filter(row=>query===undefined||keyString(row.key)===keyString(query)).map(row=>row.value);count(name,'getAll',values);return values;});},
   put(value,key){if(!writing)throw Error('ReadOnlyError');const cloned=copy(value);return operate(()=>{const path=descriptor(name).keyPath,id=path?keyAt(cloned,path):key;if(id===undefined)throw Error('DataError');if(!overlays.has(name))overlays.set(name,new Map());overlays.get(name).set(keyString(id),{key:copy(id),value:cloned});count(name,'put',[cloned]);return id;});},
   delete(key){if(!writing)throw Error('ReadOnlyError');return operate(()=>{if(!overlays.has(name))overlays.set(name,new Map());overlays.get(name).set(keyString(key),undefined);count(name,'delete');});},
   createIndex(index,path){descriptor(name).indexes.set(index,path);return this.index(index);},
   index(index){const path=descriptor(name).indexes.get(index);if(path===undefined)throw Error('NotFoundError');return {openCursor(query){return cursorFor(name,query,path);},getAll(query){return operate(()=>{const values=all(name).map(r=>r.value).filter(value=>keyString(keyAt(value,path))===keyString(query));count(name,'getAll',values);return values;});}};}
  };}
  tx.objectStore=storeFor;
  tx.abort=()=>{if(ended)throw Error('InvalidStateError');ended=true;tx.error ||= Error('IDB_ABORT');if(held)hold=null;queueMicrotask(()=>{tx.onabort?.();onEnd?.(false);running=false;pump();drainOpens();});};
  tx._create=(name,options={})=>{if(schema.has(name))throw Error('ConstraintError');schema.set(name,{keyPath:options.keyPath??null,indexes:new Map(),rows:new Map()});return storeFor(name);};
  queue.push(()=>{active=true;schema=writing?new Map(stores):stores;for(const work of workQueue)work();idle();});pump();return tx;
 }
 function connection(){const db={closed:false,onversionchange:null,onclose:null,get version(){return version;},get objectStoreNames(){const names=[...stores.keys()];names.contains=name=>stores.has(name);return names;},close(){if(this.closed)return;this.closed=true;connections.delete(this);drainOpens();},transaction(names,mode){if(this.closed)throw Error('InvalidStateError');return txFor(this,names,mode);},createObjectStore(name,options){return db._upgrade._create(name,options);}};connections.add(db);return db;}
 function drainOpens(){for(const resume of [...opens])resume();}
 const api={
  open(_name,requested=version||1){const r={};let blocked=false,completed=false;
   const resume=()=>{if(completed||upgrading)return;if(requested<version){completed=true;r.error=Object.assign(Error('VersionError'),{name:'VersionError'});queueMicrotask(()=>r.onerror?.());return;}
    if(requested>version&&connections.size){for(const c of [...connections])c.onversionchange?.({oldVersion:version,newVersion:requested});if(completed)return;if(connections.size){if(!blocked){blocked=true;queueMicrotask(()=>r.onblocked?.());}return;}}
    completed=true;const i=opens.indexOf(resume);if(i>=0)opens.splice(i,1);const db=connection();r.result=db;
    if(requested>version){upgrading=true;const oldVersion=version,tx=txFor(db,[],'versionchange',ok=>{upgrading=false;db._upgrade=null;if(ok){version=requested;queueMicrotask(()=>r.onsuccess?.());}else{db.close();r.error=tx.error;queueMicrotask(()=>r.onerror?.());}});db._upgrade=tx;r.transaction=tx;queueMicrotask(()=>r.onupgradeneeded?.({oldVersion,newVersion:requested}));}
    else queueMicrotask(()=>r.onsuccess?.());
   };opens.push(resume);queueMicrotask(resume);return r;
  },
  pause(){pause=true;},release(){hold?.();},fail(){failWrite=true;},failUpgrade(){failUpgrade=true;},
  get pending(){return !!hold;},get writes(){return writes;},get version(){return version;},get metrics(){return copy(metrics);},resetMetrics(){for(const name of Object.keys(metrics))delete metrics[name];},
  rows(name){return [...(stores.get(name)?.rows.values()||[])].map(row=>copy(row.value));},
  read(){const row=stores.get('metadata')?.rows.get(keyString('owner'))?.value;if(!row)return copy(stores.get('state')?.rows.get(keyString('owner'))?.value);return {...copy(row.value),localRevision:row.localRevision,entities:Object.fromEntries(this.rows('entities').filter(e=>e.baseline===row.baseline).map(e=>[e.key,e.value])),outbox:this.rows('outbox').sort((a,b)=>a.order-b.order).map(q=>q.value),conflicts:this.rows('conflicts').sort((a,b)=>a.order-b.order).map(c=>c.value)};},
  versionchange(newVersion=version+1){for(const c of [...connections])c.onversionchange?.({oldVersion:version,newVersion});},
  closeConnections(){for(const c of [...connections])c.close();}
 };return api;
}
