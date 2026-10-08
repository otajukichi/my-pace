/** Anchored, immutable and restartable app-write preparation. No new commit log:
 * the ordinary reserved frame remains the sole business publication boundary.
 * Work facts are accelerators. If authentication is unavailable after rotation,
 * exact deterministic transitions are replayed from the descriptor and old COW
 * nodes, then a current-key progress hint can resume that verified prefix.
 */
import {createPreparedTransaction} from './prepared-transaction.mjs';
import {PREPARATION_CERTIFICATE_PROTOCOL,PREPARATION_PROGRESS_PROTOCOL,PREPARATION_ATTESTED_PROGRESS_PROTOCOL,PREPARATION_WORK_PROTOCOL} from './preparation-codec.mjs';
import {FRAME_SCAN_HINT_PROTOCOL,ATTESTED_FRAME_HINT_PROTOCOL} from './checkpoint-hint.mjs';
import {encodeUtf8,decodeUtf8} from './codec.mjs';
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).sort().join(',')===keys.split(',').sort().join(',');
const ordinal=x=>Number.isSafeInteger(x)&&x>=1;
const pointer=f=>({id:f.id,hash:f.hash});
const objectBytes=o=>encodeUtf8(JSON.stringify(o));
export class PreparedWriter {
 constructor(writer,helpers){this.w=writer;Object.assign(this,helpers);this.hint=null;this.progress=null;this._verified=null;this.semanticFrame=null;}
 _error(code,retryable=false){return this.fail(code,retryable);}
 _parent(){const s=this.w._state;return {id:s.headId,hash:s.headHash,revision:s.revision};}
 _common(d){return {storeId:this.w.storeId,writerScriptId:this.w.writerScriptId,schemaVersion:this.w.schemaVersion,datasetGeneration:d.payload.datasetGeneration,preparation:pointer(d),parent:d.payload.parent,commitSlotId:d.payload.commitSlotId};}
 _ready(){if(!this.w.preparationCodec||!this.w.checkpointHintCodec||!this.w.checkpointHintId)this._error('WRITER_PREPARATION_AUTH_REQUIRED');}
 _adapter(d){if(d.payload.adapter==='checkpoint-v1')return null;if(typeof this.w.preparedAppAdapter!=='function')this._error('WRITER_PREPARATION_ADAPTER_REQUIRED',true);return this.w.preparedAppAdapter({command:d.payload.command,digest:d.payload.operation.digest,base:{storeId:this.w.storeId,datasetGeneration:d.payload.datasetGeneration,acceptedEpochs:d.payload.acceptedEpochs,writerFence:d.payload.writerFence}});}
 _checkDescriptor(d){
  const p=d.payload,s=this.w._state;
  if(!exact(p,'version,adapter,parent,commitSlotId,nextSlotId,nextPreparationId,firstWorkId,certificateId,manifestId,nextIndexId,operation,command,committedAt,stateRoot,receiptRoot,headReceiptHash,indexHead,indexId,datasetGeneration,acceptedEpochs,writerFence')||p.version!==1||!['app-command-v2','checkpoint-v1'].includes(p.adapter)||d.id!==s.nextPreparationId||!this.equal(p.parent,this._parent())||p.commitSlotId!==s.nextSlotId||p.datasetGeneration!==s.datasetGeneration||p.writerFence!==2||s.writerFence!==2||!this.equal(p.stateRoot,s.stateRoot)||!this.equal(p.receiptRoot,s.receiptRoot)||p.headReceiptHash!==(s.headReceipt?this.digest(s.headReceipt):null)||!this.refOk(p.indexHead)||!this.validId(p.indexId)||p.indexId!==s.nextIndexId||!this.equal(p.indexHead,s.indexHead)||!this.equal(p.acceptedEpochs,s.acceptedEpochs)||typeof p.committedAt!=='string'||!Number.isFinite(Date.parse(p.committedAt)))this._error('WRITER_PREPARATION_INVALID');
  const ids=['nextSlotId','nextPreparationId','firstWorkId','certificateId','manifestId','nextIndexId'].map(k=>p[k]);
  if(ids.some(id=>!this.validId(id)||[d.id,s.nextSlotId,s.headId,this.w.anchorId,this.w.checkpointHintId,s.nextIndexId].includes(id))||new Set(ids).size!==ids.length)this._error('WRITER_PREPARATION_INVALID');
  if(!exact(p.operation,'operationId,epoch,digest')||!this.validId(p.operation.operationId)||!this.validId(p.operation.epoch)||!s.acceptedEpochs.includes(p.operation.epoch)||!(/^[a-f0-9]{64}$/.test(p.operation.digest)))this._error('WRITER_PREPARATION_INVALID');
  if(p.adapter==='app-command-v2'){
   if(p.command?.operationId!==p.operation.operationId||p.command?.epoch!==p.operation.epoch||p.command?.store!==this.w.storeId||p.command?.generation!==s.datasetGeneration||this.digest(p.command)!==p.operation.digest)this._error('WRITER_PREPARATION_INVALID');
   const first=this._adapter(d).advance(this._adapter(d).initialState(),()=>this._error('WRITER_PREPARATION_INVALID'));
   if(first.kind!=='progress')this._error('WRITER_PREPARATION_INVALID');
  }else if(!exact(p.command,'operationId,epoch,digest,changes,references,result')||!Array.isArray(p.command.changes)||!Array.isArray(p.command.references)||p.command.changes.length||p.command.references.length||!this.equal(p.operation,{operationId:p.command.operationId,epoch:p.command.epoch,digest:p.command.digest}))this._error('WRITER_PREPARATION_INVALID');
  return d;
 }
 _createOrAdopt(id,kind,payload,check,{knownAbsent=false}={}){
  let file=knownAbsent?null:this.w._read(id,kind,null,true);if(file){check(file);return file;}
  const bytes=this.w._bytes(this.w._sealed(kind,payload));
  for(let attempt=0;attempt<this.w.limits.maxCreateAttempts;attempt++){
   try{this.w.io.createFile(id,bytes,kind);}catch(_){}
   file=this.w._read(id,kind,null,true);if(file){check(file);return file;}
  }
  this._error('WRITER_CREATE_UNRESOLVED',true);
 }
 _descriptor(command,digest,adapter,{knownAbsent=false}={}){
  const w=this.w,s=w._state;let existing=knownAbsent?null:w._read(s.nextPreparationId,'preparation',null,true);if(existing)return this._checkDescriptor(existing);
  const ids=Array.from({length:6},()=>w._id()),operation={operationId:command.operationId,epoch:command.epoch,digest};
  const payload={version:1,adapter,parent:this._parent(),commitSlotId:s.nextSlotId,nextSlotId:ids[0],nextPreparationId:ids[1],firstWorkId:ids[2],certificateId:ids[3],manifestId:ids[4],nextIndexId:ids[5],operation,command:this.clone(command),committedAt:w.clock(),stateRoot:this.clone(s.stateRoot),receiptRoot:this.clone(s.receiptRoot),headReceiptHash:s.headReceipt?this.digest(s.headReceipt):null,indexHead:this.clone(s.indexHead),indexId:s.nextIndexId,datasetGeneration:s.datasetGeneration,acceptedEpochs:s.acceptedEpochs.slice(),writerFence:2};
  // Admission precedes occupancy. The original large diary exists only here.
  w._bytes(w._sealed('preparation',payload));
  return this._createOrAdopt(s.nextPreparationId,'preparation',payload,file=>this._checkDescriptor(file),{knownAbsent:true});
 }
 _initial(d){return {phase:d.payload.adapter==='checkpoint-v1'?'cow':'domain',domain:this._adapter(d)?.initialState()||null,error:null,cow:null,assignment:null};}
 _expanded(d,state){
  if(state.error)return {changes:[],result:{preparationError:state.error}};
  if(d.payload.adapter==='checkpoint-v1')return {changes:[],result:this.clone(d.payload.command.result)};
  const out=this._adapter(d).advance(state.domain,()=>this._error('WRITER_PREPARATION_STATE_INVALID'));
  if(out.kind!=='ready')this._error('WRITER_PREPARATION_STATE_INVALID');return out;
 }
 _changes(d,state){
  const changes=this._expanded(d,state).changes,keys=new Set();if(!Array.isArray(changes)||changes.length>this.w.limits.maxChanges)this._error('WRITER_CHANGE_INVALID');
  return changes.map(c=>{this.w._key(c.key);if(keys.has(c.key)||!Number.isSafeInteger(c.expectedVersion)||c.expectedVersion<0||c.expectedVersion>=Number.MAX_SAFE_INTEGER||Object.keys(c).some(k=>!['key','expectedVersion','deleted','recreate','value'].includes(k)))this._error('WRITER_CHANGE_INVALID');keys.add(c.key);const value=c.deleted?null:this.clone(c.value);if(encodeUtf8(this.canonical(value)).length>this.w.limits.maxValueBytes)this._error('WRITER_VALUE_TOO_LARGE');return {key:c.key,expectedVersion:c.expectedVersion,entity:{key:c.key,version:c.expectedVersion+1,deleted:!!c.deleted,value}};});
 }
 _planner(d,state){
  const w=this.w,s=w._state,changes=this._changes(d,state),head=s.headReceipt,receiptUpdates=head?[{key:JSON.stringify([head.epoch,head.operationId]),value:head},{key:'@revision:'+d.payload.parent.revision,value:{revision:d.payload.parent.revision,hash:d.payload.parent.hash}}]:[];
  return createPreparedTransaction({slotId:d.payload.commitSlotId,stateRoot:d.payload.stateRoot,receiptRoot:d.payload.receiptRoot,stateUpdates:changes.map(c=>({key:c.key,value:c.entity})),receiptUpdates,readNode:(...args)=>w._node(...args),hashValue:this.digest,hashNode:p=>w._sealed('index-node',p).hash,nodeFits:p=>{try{w._bytes(w._sealed('index-node',p));return true;}catch(e){if(e.code==='WRITER_FILE_TOO_LARGE')return false;throw e;}},maxLeafEntries:w.limits.maxLeafEntries});
 }
 _validateState(state){if(!exact(state,'phase,domain,error,cow,assignment')||!['domain','cow','done'].includes(state.phase)||state.error!==null&&(typeof state.error!=='string'||!/^[_A-Z][_A-Z0-9]{1,80}$/.test(state.error))||state.assignment!==null&&(!exact(state.assignment,'nodes')||!Array.isArray(state.assignment.nodes)||state.assignment.nodes.length<1||state.assignment.nodes.length>4||state.assignment.nodes.some(n=>!exact(n,'id,recipe,cursor')||!this.validId(n.id))||new Set(state.assignment.nodes.map(n=>n.id)).size!==state.assignment.nodes.length))this._error('WRITER_PREPARATION_STATE_INVALID');}
 _transition(d,before,assignmentId=null,options={}){
  const writer=this.w,original=writer._node;writer._node=(ref,...args)=>{if(this._pageDependencies&&ref)this._pageDependencies.set(ref.id,this.clone(ref));return original.call(writer,ref,...args);};
  try{return this._advanceTransition(d,before,assignmentId,options);}finally{writer._node=original;}
 }
 _advanceTransition(d,before,assignmentId=null,{materialize=true}={}){
  this._validateState(before);const state=this.clone(before),w=this.w;
  if(state.phase==='domain'){
   const out=this._adapter(d).advance(state.domain,key=>w._get(d.payload.stateRoot,key));
   if(out.kind==='progress'){state.domain=out.state;return state;}
   if(out.kind==='rejected'){state.error=out.error;state.phase='cow';return state;}
   if(out.kind==='ready'){state.phase='cow';try{this._changes(d,state);if(encodeUtf8(this.canonical({changes:this._changes(d,state),result:out.result,references:[]})).length>w.limits.maxFileBytes-4096)state.error='WRITER_FILE_TOO_LARGE';}catch(error){if(['WRITER_VALUE_TOO_LARGE','WRITER_FILE_TOO_LARGE'].includes(error.code))state.error=error.code;else throw error;}return state;}
   this._error('WRITER_PREPARATION_STATE_INVALID');
  }
  if(state.phase==='done')this._error('WRITER_PREPARATION_COMPLETE');
  const planner=this._planner(d,state);
  if(!state.cow){state.cow=planner.initialState();return state;}
  if(state.assignment){
   if(materialize&&this._authenticatedAssignment&&this.equal(this._authenticatedAssignment.preparation,pointer(d))&&this.equal(this._authenticatedAssignment.parent,this._parent())&&this._authenticatedAssignment.stateHash===this.digest(before)){
    const assigned=state.assignment.nodes;
    if(typeof w.io.prefetchFiles==='function')w.io.prefetchFiles(assigned.map(n=>n.id),w.limits.maxFileBytes);
    const missing=[];
    for(const n of assigned){
     const found=w._read(n.id,'index-node',null,true);if(found){if(found.hash!==n.recipe.expectedHash||found.payload.slotId!==n.recipe.slotId||found.payload.type!==n.recipe.type)this._error('WRITER_PREPARATION_NODE_INVALID');w._node(pointer(found),n.recipe.tree,n.recipe.depth);continue;}
     // Only absent outputs need old-node reconstruction. Authenticated existing
     // outputs already bind the exact recipe hash, so rereading old paths here
     // would repeat proved facts and can starve a cold four-node assignment.
     const step=planner.nextRecipe(n.cursor);if(step.kind!=='node'||!this.equal(step.recipe,n.recipe))this._error('WRITER_PREPARATION_RECIPE_INVALID');missing.push({id:n.id,bytes:w._bytes(w._sealed('index-node',step.payload)),role:'index-node'});
    }
    if(missing.length)try{w.io.createMany(missing);}catch(error){if(!error?.retryable&&!['STORE_YIELD','STORE_CREATE_UNRESOLVED','STORE_REQUEST_UNRESOLVED'].includes(error.code||error.message))throw error;}
    if(typeof w.io.prefetchFiles==='function')w.io.prefetchFiles(assigned.map(n=>n.id),w.limits.maxFileBytes);
    for(const n of assigned){const found=w._read(n.id,'index-node',null,true);if(!found)this._error('WRITER_CREATE_UNRESOLVED',true);if(found.hash!==n.recipe.expectedHash||found.payload.slotId!==n.recipe.slotId||found.payload.type!==n.recipe.type)this._error('WRITER_PREPARATION_NODE_INVALID');w._node(pointer(found),n.recipe.tree,n.recipe.depth);state.cow=planner.completeAuthenticatedRecipe(n.cursor,n.recipe,pointer(found));}
    this._authenticatedAssignment=null;this._resumedAssignment=false;state.assignment=null;return state;
   }
   const nodes=state.assignment.nodes,plans=[];let frontier=state.cow;
   for(const node of nodes){let step;for(let n=0;n<256;n++){step=planner.nextRecipe(frontier);if(step.kind!=='progress')break;frontier=step.state;}if(step.kind!=='node'||!this.equal(frontier,node.cursor)||!this.equal(step.recipe,node.recipe))this._error('WRITER_PREPARATION_RECIPE_INVALID');plans.push({id:node.id,payload:step.payload,recipe:step.recipe,cursor:frontier});frontier=planner.completeRecipe(frontier,step.recipe,{id:node.id,hash:step.recipe.expectedHash});}
   // IDs and complete recipes were anchored in the preceding immutable page.
   // Parallel creation is staging only: no verified frontier advances until
   // every actual output has been privately read back at that exact ID/hash.
   if(materialize&&typeof w.io.createMany==='function'){
    let missing=plans;
    // A resumed assignment may already have durably created every output before
    // its progress-page response was lost. Read those pinned IDs first instead
    // of redispatching the whole immutable batch and spending the slice on409s.
    // Never use absence as exclusivity: remaining creates still adopt exact IDs.
    if(this._resumedAssignment){
     if(typeof w.io.prefetchFiles==='function')w.io.prefetchFiles(plans.map(n=>n.id),w.limits.maxFileBytes);
     missing=plans.filter(n=>{const existing=w._read(n.id,'index-node',null,true);if(existing&&existing.hash!==n.recipe.expectedHash)this._error('WRITER_PREPARATION_NODE_INVALID');return !existing;});
    }
    if(missing.length)try{w.io.createMany(missing.map(n=>({id:n.id,bytes:w._bytes(w._sealed('index-node',n.payload)),role:'index-node'})));}catch(error){if(!error?.retryable&&!['STORE_YIELD','STORE_CREATE_UNRESOLVED','STORE_REQUEST_UNRESOLVED'].includes(error.code||error.message))throw error;}
    if(typeof w.io.prefetchFiles==='function')w.io.prefetchFiles(plans.map(n=>n.id),w.limits.maxFileBytes);
    this._resumedAssignment=false;
   }
   for(const planned of plans){let node=w._read(planned.id,'index-node',null,true);if(!node&&materialize){w._createExact(planned.id,'index-node',planned.payload);node=w._read(planned.id,'index-node',{id:planned.id,hash:planned.recipe.expectedHash});}if(!node||node.hash!==planned.recipe.expectedHash)this._error('WRITER_PREPARATION_NODE_INVALID');w._node(pointer(node),planned.recipe.tree,planned.recipe.depth);state.cow=planner.completeRecipe(planned.cursor,planned.recipe,pointer(node));}
   state.assignment=null;return state;
  }
  const action=planner.nextRecipe(state.cow);
  if(action.kind==='progress'){state.cow=action.state;return state;}
  if(action.kind==='done'){state.phase='done';return state;}
  if(action.kind!=='node'||!Array.isArray(assignmentId)||assignmentId.length<1||assignmentId.length>4||assignmentId.some(id=>!this.validId(id))||new Set(assignmentId).size!==assignmentId.length)this._error('WRITER_PREPARATION_ASSIGNMENT_INVALID');
  const nodes=[];let frontier=state.cow;
  for(const id of assignmentId){
   if([d.id,d.payload.commitSlotId,d.payload.nextSlotId,d.payload.nextPreparationId,d.payload.firstWorkId,d.payload.certificateId,d.payload.manifestId,d.payload.nextIndexId,this.w.anchorId,this.w.checkpointHintId].includes(id))this._error('WRITER_PREPARATION_ASSIGNMENT_INVALID');
   let step;for(let n=0;n<256;n++){step=planner.nextRecipe(frontier);if(step.kind!=='progress')break;frontier=step.state;}if(step.kind==='done')break;if(step.kind!=='node')this._error('WRITER_PREPARATION_RECIPE_INVALID');
   nodes.push({id,recipe:step.recipe,cursor:this.clone(frontier)});
   // This is a planned frontier, not a verified one. Actual state.cow is kept
   // unchanged until all assigned nodes have exact same-ID proof on resume.
   frontier=planner.completeRecipe(frontier,step.recipe,{id,hash:step.recipe.expectedHash});
  }
  state.assignment={nodes};return state;
 }
 _workBody(p){const {auth,...body}=p;return body;}
 _workAuth(d,body){return {...this._common(d),protocol:PREPARATION_WORK_PROTOCOL,workOrdinal:body.ordinal,previousWorkRef:body.previousWorkRef,workStateHash:this.digest(body)};}
 _checkWork(d,file,{previous,priorState=null,trustedHint=false}={}){
  const p=file.payload;
  if(!exact(p,'version,preparation,ordinal,previousWorkRef,nextWorkId,state,steps,dependencies,auth')||p.version!==1||!Array.isArray(p.dependencies)||p.dependencies.length>128||p.dependencies.some(r=>!r||!this.refOk(r))||new Set(p.dependencies.map(r=>r.id)).size!==p.dependencies.length||!Array.isArray(p.steps)||p.steps.length<1||p.steps.length>16||p.steps.some(ids=>ids!==null&&(!Array.isArray(ids)||ids.length<1||ids.length>4||ids.some(id=>!this.validId(id))||new Set(ids).size!==ids.length))||!this.equal(p.preparation,pointer(d))||!ordinal(p.ordinal)||!this.validId(p.nextWorkId)||[file.id,d.id,d.payload.commitSlotId,d.payload.nextSlotId,d.payload.nextPreparationId,d.payload.certificateId,d.payload.manifestId,d.payload.nextIndexId,this.w.anchorId,this.w.checkpointHintId].includes(p.nextWorkId)||!this.refOk(p.previousWorkRef)||p.ordinal===1&&p.previousWorkRef!==null||p.ordinal>1&&p.previousWorkRef===null)this._error('WRITER_PREPARATION_WORK_INVALID');
  this._validateState(p.state);
  if(previous!==undefined){if((previous?.payload.ordinal||0)+1!==p.ordinal||!this.equal(p.previousWorkRef,previous?pointer(previous):null)||file.id!==(previous?previous.payload.nextWorkId:d.payload.firstWorkId))this._error('WRITER_PREPARATION_WORK_ORDER');}
  const decoded=this.w.preparationCodec?.decodeWork(objectBytes(p.auth)),authenticated=decoded&&this.equal(decoded,this._workAuth(d,this._workBody(p)));
  if(!authenticated&&!trustedHint){
   if(!priorState)this._error('WRITER_PREPARATION_PROOF_REQUIRED');
   // These bounded immutable IDs are merely prefetch candidates. Every proof
   // transition still re-derives the expected ref/hash and checks actual nodes.
   if(typeof this.w.io.prefetchFiles==='function')for(let at=0;at<p.dependencies.length;at+=16)this.w.io.prefetchFiles(p.dependencies.slice(at,at+16).map(r=>r.id),this.w.limits.maxFileBytes);
   let expected=priorState;for(let at=0;at<p.steps.length;at++){if(at&&expected.assignment)this._error('WRITER_PREPARATION_UNANCHORED_OUTPUT');expected=this._transition(d,expected,p.steps[at],{materialize:false});}
   if(!this.equal(expected,p.state))this._error('WRITER_PREPARATION_TRANSITION_INVALID');
  }
  return file;
 }
 _appendWork(d,previous,state,steps,dependencies){
  const id=previous?previous.payload.nextWorkId:d.payload.firstWorkId,body={version:1,preparation:pointer(d),ordinal:(previous?.payload.ordinal||0)+1,previousWorkRef:previous?pointer(previous):null,nextWorkId:this.w._id(),state:this.clone(state),steps:steps.slice(),dependencies:this.clone(dependencies)};
  const payload={...body,auth:JSON.parse(decodeUtf8(this.w.preparationCodec.encodeWork(this._workAuth(d,body))))};
  // If a delayed earlier page wins, validate/adopt that page before any output
  // assigned by our losing candidate can be created.
  return this._createOrAdopt(id,'preparation-work',payload,file=>this._checkWork(d,file,{previous,priorState:previous?.payload.state||this._initial(d)}),{knownAbsent:true});
 }
 _seed(){const s=this.w._state;return {anchorId:this.w.anchorId,anchorHash:s.anchorHash,hintFileId:this.w.checkpointHintId,indexRef:s.indexHead,indexLinks:s.indexLinks,frameRef:{id:s.headId,hash:s.headHash},frameRevision:s.revision,replayFrames:s.replayFrames,...(this.w._attestedPrefixReady?{writerFence:s.writerFence}: {})};}
 decodeHint(bytes){
  const p=this.w.preparationCodec?.decodeProgress(bytes);if(!p)return null;
  const s=this.w._state,r=p.recoverySeed;
  if(p.storeId!==this.w.storeId||p.writerScriptId!==this.w.writerScriptId||p.schemaVersion!==this.w.schemaVersion||p.datasetGeneration!==s.datasetGeneration||r.anchorId!==this.w.anchorId||r.anchorHash!==s.anchorHash||r.hintFileId!==this.w.checkpointHintId)return null;
  this.hint=p;return {protocol:p.protocol===PREPARATION_ATTESTED_PROGRESS_PROTOCOL?ATTESTED_FRAME_HINT_PROTOCOL:FRAME_SCAN_HINT_PROTOCOL,storeId:p.storeId,writerScriptId:p.writerScriptId,schemaVersion:p.schemaVersion,datasetGeneration:p.datasetGeneration,...r};
 }
 _saveProgress(d,page,startOrdinal,{force=false}={}){
  if(!page)return false;
  const payload={...this._common(d),protocol:this.w._attestedPrefixReady?PREPARATION_ATTESTED_PROGRESS_PROTOCOL:PREPARATION_PROGRESS_PROTOCOL,workOrdinal:page.payload.ordinal,workPage:pointer(page),recoverySeed:this._seed(),admission:this.admission&&this.equal(this.admission.parent,d.payload.parent)?this.clone(this.admission.operation):null};
  // Immutable work pages are already durable. Avoid repeatedly rewriting the
  // advisory file while a short command can finish in this invocation. Reserve
  // hint writes for the declining window or an explicit yield/error boundary.
  if((force||!this.w.canContinuePreparation(18000))&&(!this.hint||this.hint.protocol!==payload.protocol||!this.equal(this.hint.workPage,payload.workPage)||!this.equal(this.hint.admission,payload.admission))){try{this.w.io.writeCheckpointHint(this.w.preparationCodec.encodeProgress(payload));this.hint=payload;}catch(_){/* Immutable work still determines the only assigned output IDs. */}}
  // A current-key immutable work fact is resumable even if the advisory write
  // fails. Old-key semantic replay is resumable only after current-key advice
  // really persisted; an in-memory re-verification is not saved progress.
  const currentWork=this.w.preparationCodec.decodeWork(objectBytes(page.payload.auth));
  const authenticated=currentWork&&this.equal(currentWork,this._workAuth(d,this._workBody(page.payload)));
  const hinted=this.hint&&this.equal(this.hint.preparation,payload.preparation)&&this.equal(this.hint.parent,payload.parent)&&this.equal(this.hint.workPage,payload.workPage)&&this.hint.workOrdinal===payload.workOrdinal;
  const persisted=!!(authenticated||hinted);
  this.progress={phase:'preparation',ordinal:page.payload.ordinal,cursorPersisted:persisted,cursorAdvanced:persisted&&page.payload.ordinal>startOrdinal};
  return true;
 }
 _pending(d,page,startOrdinal){this._saveProgress(d,page,startOrdinal,{force:true});const e=Error('WRITER_RECOVERY_PENDING');e.code=e.message;e.retryable=true;if(this.progress)Object.assign(e,this.progress,{recovery:this.clone(this.progress)});throw e;}
 _locate(d){
  const hint=this.hint;let page=null,state=this._initial(d),startOrdinal=0;
  if(hint&&this.equal(hint.preparation,pointer(d))&&this.equal(hint.parent,this._parent())&&hint.commitSlotId===d.payload.commitSlotId){
   page=this.w._read(hint.workPage.id,'preparation-work',hint.workPage);this._checkWork(d,page,{previous:undefined,trustedHint:true});if(page.payload.ordinal!==hint.workOrdinal)this._error('WRITER_PREPARATION_HINT_INVALID');state=page.payload.state;startOrdinal=page.payload.ordinal;
  }
  while(true){
   if(!this.w.canContinuePreparation())this._pending(d,page,startOrdinal);
   const id=page?page.payload.nextWorkId:d.payload.firstWorkId,next=this.w._read(id,'preparation-work',null,true);if(!next)return {page,state,startOrdinal};
   this._checkWork(d,next,{previous:page,priorState:state});page=next;state=page.payload.state;
   this._saveProgress(d,page,startOrdinal);
  }
 }
 _core(d,state){
  const w=this.w,s=w._state,p=d.payload,expanded=this._expanded(d,state),changes=this._changes(d,state),roots=this._planner(d,state).nextRecipe(state.cow);
  if(state.phase!=='done'||roots.kind!=='done')this._error('WRITER_PREPARATION_INCOMPLETE');
  let checkpoint=null;
  if(p.adapter==='checkpoint-v1'){
   const cut={id:s.headId,hash:s.headHash,revision:s.revision,nextSlotId:s.nextSlotId,nextPreparationId:s.nextPreparationId};
   const manifest={datasetGeneration:s.datasetGeneration,cut,stateRoot:roots.stateRoot,receiptRoot:roots.receiptRoot,acceptedEpochs:s.acceptedEpochs,writerFence:2};
   checkpoint={indexId:p.indexId,nextIndexId:p.nextIndexId,previousIndex:p.indexHead,manifestRef:{id:p.manifestId,hash:w._sealed('checkpoint-manifest',manifest).hash},cut};
  }
  const core={datasetGeneration:p.datasetGeneration,revision:p.parent.revision+1,parent:{id:p.parent.id,hash:p.parent.hash},nextSlotId:p.nextSlotId,nextPreparationId:p.nextPreparationId,operation:p.operation,committedAt:p.committedAt,changes,stateRoot:roots.stateRoot,receiptRoot:roots.receiptRoot,result:expanded.result,references:[],checkpoint,acceptedEpochs:p.acceptedEpochs,writerFence:2,preparation:pointer(d)};
  w._bytes(w._sealed('frame',{...core,certificate:{id:p.certificateId,hash:'0'.repeat(64)}}));return core;
 }
 _certificatePayload(d,core,page){return {...this._common(d),protocol:PREPARATION_CERTIFICATE_PROTOCOL,frameCoreHash:this.digest(core),finalWorkRef:pointer(page),proofVersion:1};}
 _finish(d,page,{verifyOnly=false,expectedFrame=null}={}){
  const w=this.w,core=this._core(d,page.payload.state),p=d.payload;
  if(expectedFrame){const {certificate,...claimed}=expectedFrame.payload;if(!this.equal(core,claimed))this._error('WRITER_PREPARATION_FRAME_MISMATCH');return true;}
  if(verifyOnly)return core;
  if(core.checkpoint){const c=core.checkpoint;w._createExact(p.manifestId,'checkpoint-manifest',{datasetGeneration:core.datasetGeneration,cut:c.cut,stateRoot:core.stateRoot,receiptRoot:core.receiptRoot,acceptedEpochs:core.acceptedEpochs,writerFence:2});}
  const certBody={version:1,preparation:pointer(d),finalWorkRef:pointer(page),proof:JSON.parse(decodeUtf8(w.preparationCodec.encodeCertificate(this._certificatePayload(d,core,page))))};
  const cert=this._createOrAdopt(p.certificateId,'transition-certificate',certBody,file=>{
   const c=file.payload;if(!exact(c,'version,preparation,finalWorkRef,proof')||c.version!==1||!this.equal(c.preparation,pointer(d))||!this.equal(c.finalWorkRef,pointer(page)))this._error('WRITER_PREPARATION_CERTIFICATE_INVALID');
   const decoded=w.preparationCodec.decodeCertificate(objectBytes(c.proof));if(decoded&&!this.equal(decoded,this._certificatePayload(d,core,page)))this._error('WRITER_PREPARATION_CERTIFICATE_INVALID');
   // An old-key certificate can be adopted only here, after the whole exact
   // work prefix has been authenticated or independently semantically replayed.
   // Immutable certificate bytes are never replaced during key rotation.
  });
  const payload={...core,certificate:pointer(cert)},file=this._createOrAdopt(p.commitSlotId,'frame',payload,()=>{});
  w._frame(file,'readback');this.hint=null;this.progress=null;w._writeFrameScanHint();return w._receipt(p.operation.operationId,p.operation.epoch);
 }
 _resume(d){
  this._ready();const {page:located,state:initial,startOrdinal}=this._locate(d);let page=located,state=initial;
  // Upgrade advice only after the runtime completed the full original
  // recovery. The same authenticated work page/parent is preserved; this
  // changes a hint purpose, never invents an ordinal advance or business ACK.
  if(page&&this.w._attestedPrefixReady&&this.hint?.protocol!==PREPARATION_ATTESTED_PROGRESS_PROTOCOL)this._saveProgress(d,page,startOrdinal,{force:true});
  this._resumedAssignment=!!state.assignment;
  const signedWork=page&&this.w.preparationCodec.decodeWork(objectBytes(page.payload.auth));
  this._authenticatedAssignment=this.w.io._managedWritePhase&&state.assignment&&typeof this.w.io.createMany==='function'&&signedWork&&this.equal(signedWork,this._workAuth(d,this._workBody(page.payload)))?{preparation:pointer(d),parent:this.clone(this._parent()),stateHash:this.digest(page.payload.state),workPage:pointer(page)}:null;
  this._pathsPrefetched=false;
  if(!this.w.io._managedWritePhase&&state.phase==='cow'&&typeof this.w._prefetchMutationPaths==='function')this._pathsPrefetched=this.w._prefetchMutationPaths({operation:d.payload.operation,changes:this._changes(d,state),stateRoot:d.payload.stateRoot,receiptRoot:d.payload.receiptRoot},false);
  if(!this.w.io._managedWritePhase&&state.assignment&&typeof this.w.io.prefetchFiles==='function'&&page)for(let at=0;at<page.payload.dependencies.length;at+=16)this.w.io.prefetchFiles(page.payload.dependencies.slice(at,at+16).map(r=>r.id),this.w.limits.maxFileBytes);
  if(!page&&this.w._receipt(d.payload.operation.operationId,d.payload.operation.epoch)!==null)this._error('WRITER_PREPARATION_DUPLICATE_OPERATION');
  try{
   while(true){
    if(!this.w.canContinuePreparation())this._pending(d,page,startOrdinal);
    if(state.phase==='done')return this._finish(d,page);
    // Allocate only in memory here. The assignment cannot be used until its
    // immutable work page wins and has been read back and authenticated.
    let next=state;const steps=[];this._pageDependencies=new Map();
    do {
     const needAssignment=next.phase==='cow'&&next.cow&&!next.assignment&&this._planner(d,next).nextRecipe(next.cow).kind==='node';
     // Preserve earlier domain/verification progress before starting a fresh
     // multi-node planning unit late in the request. The next cold invocation
     // can use a full stable-ID batch instead of serial singleton batches.
     if(needAssignment&&steps.length&&typeof this.w.io.createMany==='function'&&!this.w.canContinuePreparation(this._pathsPrefetched?9000:18000))break;
     const batchFits=!needAssignment||!this.w.io._managedWritePhase||[d.payload.stateRoot,d.payload.receiptRoot].every((ref,i)=>!ref||this.w._node(ref,i?'receipts':'entities',0).type==='leaf');
     const assignedId=needAssignment?Array.from({length:typeof this.w.io.createMany==='function'&&this.w.canContinuePreparation(this._pathsPrefetched?9000:18000)?(batchFits?4:2):1},()=>this.w._id()):null;
     next=this._transition(d,next,assignedId);steps.push(assignedId);
     // Newly assigned IDs must first win an immutable page. An output assigned
     // in the PREVIOUS page may be verified and combined with later pure steps.
     if(next.assignment||next.phase==='done')break;
    } while(steps.length<16&&this.w.canContinuePreparation(13000));
    page=this._appendWork(d,page,next,steps,[...this._pageDependencies.values()]);this._pageDependencies=null;state=page.payload.state;
    this._saveProgress(d,page,startOrdinal);
    if(state.phase!=='done'&&!state.assignment&&typeof this.w.io.createMany==='function'&&!this.w.canContinuePreparation(this._pathsPrefetched?9000:18000))this._pending(d,page,startOrdinal);
   }
  }catch(error){
   if(['STORE_YIELD','WRITER_CREATE_UNRESOLVED','STORE_READ_UNRESOLVED','STORE_METADATA_UNRESOLVED','STORE_IDS_UNRESOLVED'].includes(error.code||error.message)){this._saveProgress(d,page,startOrdinal,{force:true});if(this.progress)Object.assign(error,{recovery:this.clone(this.progress),...this.progress});}
   throw error;
  }
 }
 requireVacant(){const d=this.w._read(this.w._state.nextPreparationId,'preparation',null,true);if(!d)return;this._checkDescriptor(d);this._resume(d);this._error('WRITER_CONTENTION',true);}
 command(command,digest){
  const w=this.w;this._ready();const phase=w.io.getVerifiedReadPhase?.();if(!phase||!w._state||w._verifiedPhase!==phase)w.recoveryBarrier();
  for(let attempt=0;attempt<w.limits.maxContention;attempt++){
   const s=w._state;let pending=null;
   if(this.hint&&this.equal(this.hint.parent,this._parent())&&this.hint.commitSlotId===s.nextSlotId&&this.hint.preparation.id===s.nextPreparationId)pending=this._checkDescriptor(w._read(s.nextPreparationId,'preparation',this.hint.preparation));
   const samePending=pending&&pending.payload.operation.operationId===command.operationId&&pending.payload.operation.epoch===command.epoch;
   const operation={operationId:command.operationId,epoch:command.epoch,digest},receiptAdmission=pending&&this.hint.admission&&this.equal(this.hint.admission,operation);
   if(!samePending&&!receiptAdmission){const prior=w._checkReplay(operation);if(prior)return prior;}else if(samePending&&pending.payload.operation.digest!==digest)this._error('OP_ID_REUSED');
   // Only an actual null lookup or an exact authenticated unchanged-parent fact
   // authorizes this accelerator. Advisory mismatches always fall back to IO.
   this.admission={parent:this.clone(this._parent()),operation};
   if(command.store!==w.storeId)this._error('STORE_ID_MISMATCH');if(command.generation!==s.datasetGeneration)this._error('DATASET_GENERATION_MISMATCH');if(!s.acceptedEpochs.includes(command.epoch))this._error('OPERATION_EPOCH_EXPIRED');if(!s.nextPreparationId||s.writerFence!==2)this._error('WRITER_FORMAT_FENCE_REQUIRED');if(!Number.isSafeInteger(command.expectedVersion)||command.expectedVersion<0||command.expectedVersion>=Number.MAX_SAFE_INTEGER)this._error('COMMAND_INVALID');if(this.digest(command)!==digest)this._error('WRITER_PREPARATION_DIGEST_INVALID');
   if(encodeUtf8(this.canonical(command.value)).length>w.limits.maxValueBytes)this._error('WRITER_VALUE_TOO_LARGE');
   // Validate permanent shape/key/scope without occupying the immutable slot.
   const adapter=w.preparedAppAdapter?.({command,digest,base:{storeId:w.storeId,datasetGeneration:s.datasetGeneration,acceptedEpochs:s.acceptedEpochs,writerFence:2}});if(!adapter)this._error('WRITER_PREPARATION_ADAPTER_REQUIRED');const admitted=adapter.advance(adapter.initialState(),()=>this._error('WRITER_PREPARATION_INVALID'));if(admitted.kind!=='progress')this._error(admitted.error||'COMMAND_INVALID');
   let d=pending||w._read(s.nextPreparationId,'preparation',null,true);
   if(!d&&s.replayFrames>=w.limits.checkpointEvery){w._automaticCheckpoint();w.recoveryBarrier();continue;}
   d=d?this._checkDescriptor(d):this._descriptor(command,digest,'app-command-v2',{knownAbsent:true});
   const same=d.payload.operation.operationId===command.operationId&&d.payload.operation.epoch===command.epoch;if(same&&d.payload.operation.digest!==digest)this._error('OP_ID_REUSED');
   const receipt=this._resume(d);if(same&&receipt)return receipt;w.recoveryBarrier();
  }this._error('WRITER_CONTENTION',true);
 }
 checkpoint(command){
  this._ready();let d=this.w._read(this.w._state.nextPreparationId,'preparation',null,true);d=d?this._checkDescriptor(d):this._descriptor({operationId:command.operationId,epoch:command.epoch,digest:command.digest,changes:[],references:[],result:command.result},command.digest,'checkpoint-v1',{knownAbsent:true});
  const receipt=this._resume(d);return d.payload.operation.operationId===command.operationId&&d.payload.operation.epoch===command.epoch?receipt:null;
 }
 verifyFrame(f,{verifiedTransition=false}={}){
  const p=f.payload;if(!p.certificate&&!p.preparation)return false;
  if(!p.certificate||!p.preparation||!Array.isArray(p.references)||p.references.length)this._error('WRITER_PREPARATION_CERTIFICATE_INVALID');
  const {certificate,...core}=p,cert=this.w._read(certificate.id,'transition-certificate',certificate),c=cert.payload;
  if(!exact(c,'version,preparation,finalWorkRef,proof')||c.version!==1||!this.equal(c.preparation,p.preparation)||!this.refOk(c.finalWorkRef)||!c.finalWorkRef)this._error('WRITER_PREPARATION_CERTIFICATE_INVALID');
  // Only the caller's exact current-INDEX authenticated descendant witness
  // may attest this already-verified publication transition. Certificate bytes,
  // hash, identity and current privacy were still checked above. This prevents
  // old-key checkpoint replay from starving the following preparation forever.
  const expected={storeId:this.w.storeId,writerScriptId:this.w.writerScriptId,schemaVersion:this.w.schemaVersion,datasetGeneration:p.datasetGeneration,preparation:p.preparation,parent:this._parent(),commitSlotId:f.id,protocol:PREPARATION_CERTIFICATE_PROTOCOL,frameCoreHash:this.digest(core),finalWorkRef:c.finalWorkRef,proofVersion:1};
  if(verifiedTransition){if(!exact(c.proof,'mac,payload')||typeof c.proof.mac!=='string'||!(/^[a-f0-9]{64}$/.test(c.proof.mac))||!this.equal(c.proof.payload,expected))this._error('WRITER_PREPARATION_CERTIFICATE_INVALID');return true;}
  const decoded=this.w.preparationCodec?.decodeCertificate(objectBytes(c.proof));if(decoded&&this.equal(decoded,expected))return true;
  // Key rotation never makes an immutable committed frame unreadable. Replay
  // actual work transitions, preserving current-key verified-prefix hints.
  this._ready();const s=this.w._state,saved={receiptRoot:s.receiptRoot,headReceipt:s.headReceipt,indexHead:s.indexHead,nextIndexId:s.nextIndexId,indexLinks:s.indexLinks,replayFrames:s.replayFrames};
  try{
   // A checkpoint manifest restores a cut with the previous head receipt
   // already carried. For independent proof replay, recover that exact old
   // parent by its cut hash, not an unauthenticated descriptor claim.
   if(p.checkpoint&&s.headReceipt===null&&s.revision>0){const parent=this.w._read(s.headId,'frame',{id:s.headId,hash:s.headHash});if(parent.payload.revision!==s.revision||!this.equal(parent.payload.stateRoot,s.stateRoot)||parent.payload.nextSlotId!==s.nextSlotId||parent.payload.nextPreparationId!==s.nextPreparationId)this._error('WRITER_PREPARATION_PARENT_INVALID');s.receiptRoot=parent.payload.receiptRoot;s.headReceipt=this.w._receiptFor(parent);if(s.indexHead?.id===p.checkpoint.indexId){
    s.indexHead=p.checkpoint.previousIndex;s.nextIndexId=p.checkpoint.indexId;s.indexLinks--;
    // Restore the original parent's replay ordinal as well as its receipt and
    // INDEX context. A manifest-restored cut has replayFrames=0, which cannot
    // encode a resumable signed frame seed for old-key semantic verification.
    let priorCut=0;
    if(s.indexHead){const previous=this.w._read(s.indexHead.id,'checkpoint-index',s.indexHead);this.w._indexPayload(previous.payload,previous.id,previous.payload.previousIndex);if(previous.payload.nextIndexId!==s.nextIndexId)this._error('WRITER_PREPARATION_PARENT_INVALID');priorCut=previous.payload.cut.revision;}
    s.replayFrames=s.revision-priorCut;
    if(!Number.isSafeInteger(s.replayFrames)||s.replayFrames<1||s.replayFrames>this.w.limits.maxReplayFrames)this._error('WRITER_PREPARATION_PARENT_INVALID');
   }}
   const d=this._checkDescriptor(this.w._read(p.preparation.id,'preparation',p.preparation)),located=this._locate(d);if(!located.page||!this.equal(pointer(located.page),c.finalWorkRef)||located.state.phase!=='done')this._error('WRITER_PREPARATION_PROOF_INCOMPLETE');const verified=this._finish(d,located.page,{expectedFrame:f});if(p.checkpoint)this.semanticFrame=pointer(f);return verified;
  }finally{Object.assign(s,saved);}
 }
}
