// Fresh metadata-only ancestry checks. No global/cache persistence: moves are
// rechecked before every source read. Output/store trees are always excluded.
export function createDriveFolderScope({Drive,rootId,excludedIds=[],canContinue=()=>true,maxDepth=32}){
 const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(x);
 if(!id(rootId)||!Array.isArray(excludedIds)||excludedIds.some(x=>!id(x))||excludedIds.includes(rootId)||!Number.isSafeInteger(maxDepth)||maxDepth<1||maxDepth>64)throw Error('DRIVE_SCOPE_CONFIG');
 const excluded=new Set(excludedIds);
 return file=>{
  const seen=new Set();let frontier=[file];
  for(let depth=0;frontier.length&&depth<=maxDepth;depth++){
   const next=[];
   for(const f of frontier){
    if(!f||!id(f.id)||f.trashed!==false||excluded.has(f.id))continue;
    if(f.id===rootId)return true;
    if(seen.has(f.id))continue;seen.add(f.id);
    if(!Array.isArray(f.parents)||f.parents.length>1)throw Error('DRIVE_SCOPE_PARENTS');
    for(const parent of f.parents){
     if(!id(parent))throw Error('DRIVE_SCOPE_PARENTS');
     if(excluded.has(parent))continue;
     if(parent===rootId)return true;
     if(!canContinue())throw Error('OWNER_BUDGET_YIELD');
     const p=Drive.Files.get(parent,{fields:'id,parents,trashed,mimeType',supportsAllDrives:true});
     if(p?.mimeType!=='application/vnd.google-apps.folder')throw Error('DRIVE_SCOPE_PARENT_INVALID');
     next.push(p);
    }
   }
   frontier=next;
  }
  if(frontier.length)throw Error('DRIVE_SCOPE_DEPTH');
  return false;
 };
}
