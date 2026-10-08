/**
 * Bounded, resumable postorder COW construction and inductive transition proof.
 * This module owns no Drive files and never creates IDs. The caller must:
 *  - bind the immutable descriptor to the verified parent and reserved slots;
 *  - authenticate a restored cursor (or replay its immutable work log);
 *  - persist recipe + assigned output ID before creating that output;
 *  - verify same-ID bytes/hash/private metadata before completeRecipe(); and
 *  - durably authenticate the returned cursor before trusting it in another call.
 *
 * Large input values live only in the descriptor/context, never in cursors or
 * recipes. A step reads at most one old node. A split leaf is reconstructed from
 * its original immutable leaf plus descriptor update indexes and a hash prefix.
 */
const PROTOCOL='mypace-prepared-cow-v1';
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const hash=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const ref=x=>x===null||!!(x&&Object.keys(x).sort().join(',')==='hash,id'&&id(x.id)&&hash(x.hash));
const plain=x=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const exact=(x,keys)=>plain(x)&&Object.keys(x).sort().join(',')===keys.split(',').sort().join(',');
const fail=code=>{const e=Error(code);e.code=code;throw e;};
const copy=x=>JSON.parse(JSON.stringify(x));
const uint=x=>Number.isSafeInteger(x)&&x>=0;
const sortedDigits=s=>typeof s==='string'&&s.length>=1&&s.length<=16&&/^[0-9a-f]+$/.test(s)&&s===[...new Set(s)].sort().join('');

export function createPreparedTransaction({slotId,stateRoot=null,receiptRoot=null,stateUpdates=[],receiptUpdates=[],readNode,hashValue,hashNode,nodeFits,maxLeafEntries=512,maxDepth=64,maxCursorBytes=248*1024}={}) {
 if(!id(slotId)||!ref(stateRoot)||!ref(receiptRoot)||[readNode,hashValue,hashNode,nodeFits].some(f=>typeof f!=='function')||!Number.isSafeInteger(maxLeafEntries)||maxLeafEntries<1||maxLeafEntries>512||!Number.isSafeInteger(maxDepth)||maxDepth<1||maxDepth>64||!Number.isSafeInteger(maxCursorBytes)||maxCursorBytes<1024||maxCursorBytes>1024*1024)fail('PREPARATION_CONFIG_INVALID');
 const trees=['entities','receipts'],roots=[copy(stateRoot),copy(receiptRoot)],updates=[copy(stateUpdates),copy(receiptUpdates)];
 for(const list of updates){if(!Array.isArray(list)||list.length>128)fail('PREPARATION_UPDATES_INVALID');const keys=new Set();for(const u of list){if(!exact(u,'key,value')||typeof u.key!=='string'||!u.key||keys.has(u.key))fail('PREPARATION_UPDATES_INVALID');keys.add(u.key);}}
 const keyHashes=updates.map(list=>list.map(u=>{const h=hashValue(u.key);if(!hash(h))fail('PREPARATION_HASH_INVALID');return h;}));
 const binding=hashValue({protocol:PROTOCOL,slotId,stateRoot,receiptRoot,stateUpdates:updates[0],receiptUpdates:updates[1],maxLeafEntries,maxDepth});
 if(!hash(binding))fail('PREPARATION_HASH_INVALID');
 const indexes=job=>updates[job].map((_,i)=>i);
 const visit=(oldRef,depth,indexes)=>({type:'visit',oldRef:copy(oldRef),depth,indexes:indexes.slice()});
 const utf8Length=s=>{let n=0;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c<128)n++;else if(c<2048)n+=2;else if(c>=0xd800&&c<=0xdbff&&i+1<s.length&&s.charCodeAt(i+1)>=0xdc00&&s.charCodeAt(i+1)<=0xdfff){n+=4;i++;}else n+=3;}return n;};
 function cursor(s){if(utf8Length(JSON.stringify(s))>maxCursorBytes)fail('PREPARATION_CURSOR_BOUND');return s;}
 function checkIndexes(xs,job){if(!Array.isArray(xs)||xs.length>updates[job].length)fail('PREPARATION_CURSOR_INVALID');let prev=-1;for(const x of xs){if(!uint(x)||x>=updates[job].length||x<=prev)fail('PREPARATION_CURSOR_INVALID');prev=x;}}
 function checkState(s){
  if(!exact(s,'protocol,binding,job,roots,stack')||s.protocol!==PROTOCOL||s.binding!==binding||!uint(s.job)||s.job>2||!Array.isArray(s.roots)||s.roots.length!==2||s.roots.some(r=>!ref(r))||!Array.isArray(s.stack)||s.stack.length>maxDepth+1||(s.job===2)!==(s.stack.length===0))fail('PREPARATION_CURSOR_INVALID');
  if(s.job<2)for(let i=0;i<s.stack.length;i++){
   const f=s.stack[i];if(!plain(f)||!uint(f.depth)||f.depth>maxDepth||(i&&f.depth!==s.stack[i-1].depth+1))fail('PREPARATION_CURSOR_INVALID');checkIndexes(f.indexes,s.job);
   if(f.type==='visit'){if(!exact(f,'type,oldRef,depth,indexes')||!ref(f.oldRef)||i!==s.stack.length-1)fail('PREPARATION_CURSOR_INVALID');}
   else if(f.type==='entries'){if(!exact(f,'type,sourceRef,sourceDepth,prefix,depth,indexes')||!ref(f.sourceRef)||!uint(f.sourceDepth)||f.sourceDepth>f.depth||typeof f.prefix!=='string'||!/^[0-9a-f]*$/.test(f.prefix)||f.prefix.length!==f.depth-f.sourceDepth||i!==s.stack.length-1)fail('PREPARATION_CURSOR_INVALID');}
   else if(f.type==='branch'||f.type==='split'){
    if(f.type==='branch'){if(!exact(f,'type,oldRef,depth,indexes,digits,results')||!f.oldRef||!ref(f.oldRef))fail('PREPARATION_CURSOR_INVALID');}
    else if(!exact(f,'type,sourceRef,sourceDepth,prefix,depth,indexes,digits,results')||!ref(f.sourceRef)||!uint(f.sourceDepth)||f.sourceDepth>f.depth||typeof f.prefix!=='string'||!/^[0-9a-f]*$/.test(f.prefix)||f.prefix.length!==f.depth-f.sourceDepth)fail('PREPARATION_CURSOR_INVALID');
    if(f.depth>=maxDepth||!sortedDigits(f.digits)||!Array.isArray(f.results)||f.results.length>f.digits.length)fail('PREPARATION_CURSOR_INVALID');
    for(let k=0;k<f.results.length;k++)if(!exact(f.results[k],'digit,ref')||f.results[k].digit!==f.digits[k]||!f.results[k].ref||!ref(f.results[k].ref))fail('PREPARATION_CURSOR_INVALID');
    if(i<s.stack.length-1&&f.results.length>=f.digits.length)fail('PREPARATION_CURSOR_INVALID');
   }else fail('PREPARATION_CURSOR_INVALID');
  }
  cursor(s);return s;
 }
 function initialState(){return cursor({protocol:PROTOCOL,binding,job:0,roots:[null,null],stack:[visit(roots[0],0,indexes(0))]});}
 function deliver(state,result){
  const s=copy(state);s.stack.pop();
  if(s.stack.length){const parent=s.stack[s.stack.length-1];if(!result||!['branch','split'].includes(parent.type)||parent.results.length>=parent.digits.length)fail('PREPARATION_CURSOR_INVALID');parent.results.push({digit:parent.digits[parent.results.length],ref:copy(result)});}
  else {s.roots[s.job]=copy(result);s.job++;if(s.job<2)s.stack.push(visit(roots[s.job],0,indexes(s.job)));}
  return cursor(s);
 }
 function read(refValue,tree,depth){
  const p=readNode(copy(refValue),tree,depth);
  if(!plain(p)||p.tree!==tree||p.depth!==depth||!id(p.slotId)||!['leaf','branch'].includes(p.type))fail('PREPARATION_OLD_NODE_INVALID');
  if(p.type==='leaf'){
   if(!exact(p,'tree,depth,type,entries,slotId')||!Array.isArray(p.entries)||!p.entries.length||p.entries.length>maxLeafEntries)fail('PREPARATION_OLD_NODE_INVALID');
   let previous=null;for(const e of p.entries){if(!exact(e,'key,value')||typeof e.key!=='string'||(previous!==null&&previous>=e.key))fail('PREPARATION_OLD_NODE_INVALID');previous=e.key;}
  }else{
   if(!exact(p,'tree,depth,type,children,slotId')||depth>=maxDepth||!Array.isArray(p.children)||!p.children.length||p.children.length>16)fail('PREPARATION_OLD_NODE_INVALID');
   let previous='';for(const c of p.children){if(!exact(c,'digit,ref')||typeof c.digit!=='string'||!/^[0-9a-f]$/.test(c.digit)||c.digit<=previous||!c.ref||!ref(c.ref))fail('PREPARATION_OLD_NODE_INVALID');previous=c.digit;}
  }return p;
 }
 function merge(entries,idxs,job){const m=new Map(entries.map(e=>[e.key,copy(e)]));for(const i of idxs)m.set(updates[job][i].key,copy(updates[job][i]));return [...m.values()].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);}
 const subset=(idxs,job,depth,digit)=>idxs.filter(i=>keyHashes[job][i][depth]===digit);
 function recipe(state,payload,source){
  const expectedHash=hashNode(copy(payload));if(!hash(expectedHash))fail('PREPARATION_HASH_INVALID');
  return {kind:'node',recipe:{protocol:PROTOCOL,binding,stateHash:hashValue(state),tree:trees[state.job],slotId,depth:payload.depth,type:payload.type,source:copy(source),updateIndexes:state.stack[state.stack.length-1].indexes.slice(),dependencies:payload.type==='branch'?payload.children.map(c=>copy(c.ref)):[],expectedHash},payload:copy(payload)};
 }
 function leafOrSplit(state,entries,source){
  const f=state.stack[state.stack.length-1],tree=trees[state.job],payload={tree,depth:f.depth,type:'leaf',entries,slotId};
  if(entries.length&&entries.length<=maxLeafEntries&&nodeFits(copy(payload))===true)return recipe(state,payload,source);
  if(!entries.length)fail('PREPARATION_EMPTY_NODE');if(f.depth>=maxDepth)fail('WRITER_INDEX_COLLISION_LIMIT');
  const groups=new Set();for(const e of entries){const h=hashValue(e.key);if(!hash(h))fail('PREPARATION_HASH_INVALID');groups.add(h[f.depth]);}
  const digits=[...groups].sort().join(''),s=copy(state);
  s.stack[s.stack.length-1]={type:'split',sourceRef:copy(source.ref),sourceDepth:source.depth,prefix:source.prefix,depth:f.depth,indexes:f.indexes.slice(),digits,results:[]};
  const digit=digits[0];s.stack.push({type:'entries',sourceRef:copy(source.ref),sourceDepth:source.depth,prefix:source.prefix+digit,depth:f.depth+1,indexes:subset(f.indexes,state.job,f.depth,digit)});
  return {kind:'progress',state:cursor(s)};
 }
 function nextRecipe(state){
  checkState(state);if(state.job===2)return {kind:'done',stateRoot:copy(state.roots[0]),receiptRoot:copy(state.roots[1])};
  const f=state.stack[state.stack.length-1],tree=trees[state.job];
  if(f.type==='visit'){
   if(!f.indexes.length)return {kind:'progress',state:deliver(state,f.oldRef)};
   const old=f.oldRef?read(f.oldRef,tree,f.depth):null;
   if(!old||old.type==='leaf')return leafOrSplit(state,merge(old?old.entries:[],f.indexes,state.job),{ref:f.oldRef,depth:f.depth,prefix:''});
   const digits=[...new Set(f.indexes.map(i=>keyHashes[state.job][i][f.depth]))].sort().join(''),s=copy(state),digit=digits[0];
   s.stack[s.stack.length-1]={type:'branch',oldRef:copy(f.oldRef),depth:f.depth,indexes:f.indexes.slice(),digits,results:[]};
   s.stack.push(visit(old.children.find(c=>c.digit===digit)?.ref||null,f.depth+1,subset(f.indexes,state.job,f.depth,digit)));
   return {kind:'progress',state:cursor(s)};
  }
  if(f.type==='entries'){
   const old=f.sourceRef?read(f.sourceRef,tree,f.sourceDepth):null;if(old&&old.type!=='leaf')fail('PREPARATION_SOURCE_NOT_LEAF');
   const entries=(old?old.entries:[]).filter(e=>{const h=hashValue(e.key);if(!hash(h))fail('PREPARATION_HASH_INVALID');return h.slice(f.sourceDepth,f.depth)===f.prefix;});
   return leafOrSplit(state,merge(entries,f.indexes,state.job),{ref:f.sourceRef,depth:f.sourceDepth,prefix:f.prefix});
  }
  if(f.type==='branch'){
   const old=read(f.oldRef,tree,f.depth);if(old.type!=='branch')fail('PREPARATION_SOURCE_NOT_BRANCH');
   const expectedDigits=[...new Set(f.indexes.map(i=>keyHashes[state.job][i][f.depth]))].sort().join('');if(f.digits!==expectedDigits)fail('PREPARATION_CURSOR_INVALID');
   if(f.results.length<f.digits.length){const digit=f.digits[f.results.length],s=copy(state);s.stack.push(visit(old.children.find(c=>c.digit===digit)?.ref||null,f.depth+1,subset(f.indexes,state.job,f.depth,digit)));return {kind:'progress',state:cursor(s)};}
   const children=new Map(old.children.map(c=>[c.digit,copy(c)]));for(const c of f.results)children.set(c.digit,copy(c));
   const payload={tree,depth:f.depth,type:'branch',children:[...children.values()].sort((a,b)=>a.digit<b.digit?-1:1),slotId};
   if(nodeFits(copy(payload))!==true)fail('WRITER_FILE_TOO_LARGE');return recipe(state,payload,{ref:f.oldRef,depth:f.depth,prefix:''});
  }
  if(f.results.length<f.digits.length){const digit=f.digits[f.results.length],s=copy(state);s.stack.push({type:'entries',sourceRef:copy(f.sourceRef),sourceDepth:f.sourceDepth,prefix:f.prefix+digit,depth:f.depth+1,indexes:subset(f.indexes,state.job,f.depth,digit)});return {kind:'progress',state:cursor(s)};}
  const payload={tree,depth:f.depth,type:'branch',children:copy(f.results),slotId};if(nodeFits(copy(payload))!==true)fail('WRITER_FILE_TOO_LARGE');
  return recipe(state,payload,{ref:f.sourceRef,depth:f.sourceDepth,prefix:f.prefix});
 }
 // Internal to a writer that has independently authenticated the complete
 // immutable work page containing this exact assignment. Unlike completeRecipe
 // this does not accept an untrusted recipe and does not reconstruct old bytes.
 // The caller MUST still read/hash/schema-check the exact assigned output ID.
 function completeAuthenticatedRecipe(state,planned,verifiedResult){
  checkState(state);
  if(!exact(planned,'protocol,binding,stateHash,tree,slotId,depth,type,source,updateIndexes,dependencies,expectedHash')||planned.protocol!==PROTOCOL||planned.binding!==binding||planned.stateHash!==hashValue(state)||planned.tree!==trees[state.job]||planned.slotId!==slotId||planned.depth!==state.stack[state.stack.length-1]?.depth||!['leaf','branch'].includes(planned.type)||!hash(planned.expectedHash)||!verifiedResult||!ref(verifiedResult)||verifiedResult.hash!==planned.expectedHash||hashValue(planned.updateIndexes)!==hashValue(state.stack[state.stack.length-1].indexes)||!Array.isArray(planned.dependencies)||planned.dependencies.some(r=>!r||!ref(r)))fail('PREPARATION_RESULT_MISMATCH');
  return deliver(state,verifiedResult);
 }
 function completeRecipe(state,planned,verifiedResult){
  checkState(state);if(!verifiedResult||!ref(verifiedResult))fail('PREPARATION_RESULT_INVALID');
  // Recompute this ONE recipe; never trust a caller-altered expected hash. The
  // writer's continuously-held read-phase cache makes repeat reads free, while
  // a cold resume freshly validates the one required old-node dependency.
  const expected=nextRecipe(state);
  if(expected.kind!=='node'||hashValue(expected.recipe)!==hashValue(planned)||verifiedResult.hash!==expected.recipe.expectedHash)fail('PREPARATION_RESULT_MISMATCH');
  return deliver(state,verifiedResult);
 }
 return Object.freeze({initialState,nextRecipe,completeRecipe,completeAuthenticatedRecipe,binding});
}
