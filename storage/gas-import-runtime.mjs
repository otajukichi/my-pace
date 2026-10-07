// Composition root for the one owner-authorized Apps Script project. Constructing
// this runtime does not bootstrap, import, publish, deploy or install a trigger.
import {GasStoreIO} from './gas-store-io.mjs';
import {ReservedSlotWriter} from './reserved-writer.mjs';
import {ImportStoreBinding} from './import-store.mjs';
import {ImportCheckpointCoordinator,ImmutableAssetAdapter,createGasAssetMediaReader} from './immutable-assets.mjs';
import {createDriveSourceTransport} from './transport.mjs';
import {ImportRunner} from './import-runner.mjs';
const fail=code=>{throw Error(code);};
export function createGasImportRuntime(globals,config){
 const {Drive,Utilities,UrlFetchApp,ScriptApp,LockService}=globals||{};
 if(!config||typeof config.checkBudget!=='function'||typeof LockService?.getScriptLock!=='function')fail('RUNTIME_CONFIG');
 const scriptLock=LockService.getScriptLock();let io;
 // All runtime and coordinator lock phases pass through this facade. A lock
 // already held by an external caller never activates a cache: its release and
 // reacquisition cannot be observed here. No cache survives our own release,
 // failed acquisition, exception, or observed loss of ownership.
 const lock={
  hasLock(){const held=scriptLock.hasLock();if(held!==true)io?.endReadPhase();return held;},
  tryLock(ms){io?.endReadPhase();const acquired=scriptLock.tryLock(ms);if(acquired===true)io?.beginReadPhase();return acquired;},
  releaseLock(){io?.endReadPhase();return scriptLock.releaseLock();}
 };
 const locked=fn=>{if(lock.hasLock())return fn();let acquired=false;try{acquired=lock.tryLock(1000)===true;if(!acquired){const e=Error('WRITER_BUSY');e.retryable=true;throw e;}return fn();}finally{if(acquired)lock.releaseLock();}};
 io=new GasStoreIO({Drive,Utilities,UrlFetchApp,ScriptApp,lock,storeId:config.storeId,managedParentId:config.metadataParentId,checkBudget:config.checkBudget,protocolReadCache:config.protocolReadCache,checkpointHintId:config.checkpointHintId});
 const writer=new ReservedSlotWriter({io,storeId:config.storeId,writerScriptId:config.writerScriptId,anchorId:config.anchorId,limits:config.writerLimits,checkpointHintId:config.checkpointHintId,checkpointHintCodec:config.checkpointHintCodec,checkpointHintAnchorHash:config.checkpointHintAnchorHash});
 const source=createDriveSourceTransport(globals,{pageSize:32});
 const budget=()=>{if(config.checkBudget('runtime')!==true){const e=Error('IMPORT_YIELD');e.retryable=true;throw e;}};
 const validateSource=s=>{budget();source.getSource(s,{deadlineMs:config.deadlineMs});return true;};
 let store;
 const reservationRead=fn=>lock.hasLock()?fn():locked(()=>{store.recoveryBarrier();return fn();});
 const reader=createGasAssetMediaReader({UrlFetchApp,ScriptApp,checkBudget:config.checkBudget,assertReadableAsset:(...args)=>reservationRead(()=>store.assertReadableAsset(...args))});
 const readManaged=r=>{
  if(store.assertReadableAsset(r.fileId,r.byteLength,2097152)!==true)fail('ASSET_MEDIA_NOT_RESERVED');
  budget();const m=Drive.Files.get(r.fileId,{fields:'id,parents,appProperties,size,trashed,mimeType,ownedByMe,shared'});
  const markers={'mypace.store':r.storeId,'mypace.job':r.jobId,'mypace.pin':r.pinId,'mypace.role':r.role,'mypace.sha256':r.sha256};
  if(!m||m.id!==r.fileId||m.trashed!==false||m.ownedByMe!==true||m.shared!==false||m.mimeType!=='application/octet-stream'||!Array.isArray(m.parents)||m.parents.length!==1||m.parents[0]!==config.assetsParentId||String(m.size)!==String(r.byteLength)||Object.keys(markers).some(k=>m.appProperties?.[k]!==markers[k]))fail('ASSET_METADATA_MISMATCH');
  return reader(r.fileId,r.byteLength,2097152);
 };
 store=new ImportStoreBinding({writer,storeId:config.storeId,readAsset:readManaged,validateSourceCurrent:validateSource});
 const assets=new ImmutableAssetAdapter({Drive,Utilities,readAssetBytes:reader,managedParentId:config.assetsParentId,storeId:config.storeId,assertReservation:r=>reservationRead(()=>store.assertReservation(r))});
 const coordinator=new ImportCheckpointCoordinator({writer:store,assets,getScriptLock:()=>lock,validateSourceCurrent:validateSource,checkBudget:config.checkBudget});
 const runner=new ImportRunner({store,coordinator,source,allocateIds:n=>io.allocateIds(n),locked,checkBudget:config.checkBudget,rangeBytes:config.rangeBytes,finalizationBatchLimit:config.finalizationBatchLimit,maxFreshOutputs:config.maxFreshOutputs});
 return Object.freeze({writer,store,source,assets,coordinator,runner,locked});
}
