// Prepared daily read model only. No CSV parsing, source-page reads or GPS arithmetic.
export const DAILY_SCHEMA=1;
export function runningDayKey(now=new Date()) { return new Date(now.getTime()+6*3600000).toISOString().slice(0,10); }
const dateValid=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
export function validateDaily(value,date,identity) {
  if(!value||value.schema!==DAILY_SCHEMA||value.date!==date||!dateValid(date)||typeof value.store!=='string'||!value.store||typeof value.generation!=='string'||!value.generation||!['ready','preparing','empty','failed'].includes(value.status)||typeof value.pending!=='boolean')throw Error('DAILY_RESPONSE_INVALID');
  if(identity?.store&&value.store!==identity.store||identity?.generation&&value.generation!==identity.generation)throw Error('DAILY_IDENTITY_CHANGED');
  if(value.notModified===true)return value;
  if(value.status==='ready'){
    const s=value.summary;
    if(typeof value.hash!=='string'||!value.hash||!s||!Number.isFinite(s.distanceMeters)||s.distanceMeters<0||!Number.isFinite(s.durationSeconds)||s.durationSeconds<0||s.averageSpeedKmh!==null&&(!Number.isFinite(s.averageSpeedKmh)||s.averageSpeedKmh<0)||!Array.isArray(value.segments))throw Error('DAILY_RESPONSE_INVALID');
    let count=0;
    for(const segment of value.segments){if(!Array.isArray(segment.points)||!segment.points.length||!Array.isArray(segment.colors)||segment.colors.length!==segment.points.length-1||segment.colors.some(c=>!/^#[0-9a-f]{6}$/i.test(c))||segment.points.some(p=>!Array.isArray(p)||p.length!==2||!Number.isFinite(p[0])||Math.abs(p[0])>90||!Number.isFinite(p[1])||Math.abs(p[1])>540))throw Error('DAILY_RESPONSE_INVALID');count+=segment.points.length;}
    if(count>100000)throw Error('DAILY_RESPONSE_TOO_LARGE');
  }
  return value;
}
// Bounded memory plus optional isolated derived storage. No legacy record or
// outbox database is touched. Authenticated owner/store/generation/schema bind keys.
export function createDailyRunning({read,storage=null,onChange=()=>{},now=()=>Date.now(),maxDays=16,maxBytes=4*1024*1024,refreshMs=60000}={}){
  let identity=null,scope=null,date=null,serial=0,view={status:'signed-out',daily:null},inflight=null;
  const cache=new Map(),attempts=new Map();
  const key=(d)=>JSON.stringify([identity.owner,identity.store,identity.generation,DAILY_SCHEMA,d]);
  const trimCache=()=>{while(cache.size>maxDays||[...cache.values()].reduce((n,v)=>n+v.bytes,0)>maxBytes)cache.delete(cache.keys().next().value);};
  const publish=next=>{view=next;onChange();};
  function reset(next){++serial;inflight=null;cache.clear();attempts.clear();identity=next?{...next}:null;scope=next?JSON.stringify(next):null;date=null;view={status:next?'idle':'signed-out',daily:null};}
  function setIdentity(next){storage?.setScope(next?.persistent?next.owner:null);const value=next?JSON.stringify(next):null;if(value===scope)return;if(next&&identity&&next.owner===identity.owner&&next.store===identity.store&&next.generation===identity.generation){scope=value;return;}reset(next);}
  function select(nextDate,{force=false}={}){
    if(!identity)return Promise.resolve();
    if(!dateValid(nextDate))throw Error('DAILY_DATE_INVALID');
    const k=key(nextDate),changed=date!==nextDate;let cached=cache.get(k);
    if(changed){++serial;inflight=null;date=nextDate;view=cached?{status:cached.daily.status,daily:cached.daily,cached:true}:{status:'loading',daily:null};}
    if(inflight?.key===k)return inflight.promise;
    if(!force&&(cached||!changed&&view.status==='failure')&&attempts.has(k)&&now()-attempts.get(k)<refreshMs)return Promise.resolve();
    attempts.set(k,now());while(attempts.size>maxDays*2)attempts.delete(attempts.keys().next().value);
    const sequence=++serial,expected={...identity};
    const promise=(async()=>{
      try{
        if(!cached&&expected.persistent&&expected.store&&expected.generation&&storage){
          const row=await storage.get(k,expected.owner).catch(()=>null);
          if(sequence!==serial||date!==nextDate)return;
          if(row){try{const daily=validateDaily(row.daily,nextDate,expected);if(daily.status!=='ready'||daily.notModified)throw Error('DAILY_CACHE_INVALID');const bytes=new TextEncoder().encode(JSON.stringify(daily)).byteLength;if(bytes>maxBytes||bytes!==row.bytes)throw Error('DAILY_CACHE_INVALID');cached={daily,bytes,checkedAt:0};cache.set(k,cached);trimCache();publish({status:'ready',daily,cached:true,revalidating:true});}catch{void storage.remove(k).catch(()=>{});}}
        }
        const response=validateDaily(await read(nextDate,cached?.daily.hash??null),nextDate,expected);
        if(sequence!==serial||date!==nextDate)return;
        let daily=response;
        if(response.notModified){if(!cached||response.hash!==cached.daily.hash)throw Error('DAILY_CACHE_MISS');daily={...cached.daily,...response,summary:cached.daily.summary,segments:cached.daily.segments};delete daily.notModified;}
        // A provisional response cannot erase the last complete route and stats.
        if(cached?.daily.status==='ready'&&daily.status!=='ready'&&daily.status!=='empty')daily={...cached.daily,pending:daily.status==='preparing',error:daily.error||null,preparationState:daily.preparationState};
        identity={...identity,store:response.store,generation:response.generation};
        const resolvedKey=key(nextDate),bytes=new TextEncoder().encode(JSON.stringify(daily)).byteLength;
        if(bytes>maxBytes)throw Error('DAILY_RESPONSE_TOO_LARGE');
        cache.delete(k);cache.delete(resolvedKey);cache.set(resolvedKey,{daily,checkedAt:now(),bytes});attempts.set(resolvedKey,now());
        trimCache();
        if(expected.persistent&&storage&&daily.status==='ready')void storage.put({key:resolvedKey,owner:expected.owner,daily,bytes,savedAt:now()}).catch(()=>{});
        publish({status:daily.status,daily,cached:false});
      }catch(error){if(sequence!==serial||date!==nextDate)return;const auth=['AUTH_REQUIRED','SESSION_CHANGED','SESSION_LOCKED','UNAUTHENTICATED'].includes(error.message)||error.status===401;
        if(error.message==='DAILY_IDENTITY_CHANGED'){cache.clear();void storage?.remove(k)?.catch(()=>{});publish({status:'failure',daily:null,error:error.message});}
        else if(auth){storage?.setScope(null);reset(null);publish({status:'signed-out',daily:null,error:error.message});}
        else publish({status:'failure',daily:cached?.daily??null,error:error.message,cached:!!cached});
      }finally{if(inflight?.sequence===sequence)inflight=null;}
    })();
    inflight={key:k,promise,sequence};return promise;
  }
  return {setIdentity,select,view:()=>view,clear:()=>{storage?.setScope(null);reset(null);},cancel(){++serial;inflight=null;date=null;},cacheSize:()=>cache.size};
}
