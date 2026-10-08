// Test-only compact historical cut. Uses production COW encoding and immutable
// file IO; omits pre-cut frames. Optional receipts are shape/cost fixtures,
// not evidence that the omitted historical frame chain was actually replayed.
import {writerDigest} from '../../storage/reserved-writer.mjs';
import {APP_CHANGE_HEAD,APP_CHANGE_CAPACITY,appChangeSlot} from '../../gas/app-domain.mjs';
export function syntheticCut(writer,count,{internalPerRecord=1,largeValue=false,paired=false,receiptCount=0}={}){
 const entries=[],expected=new Map();let previous=null,changed;
 for(let i=0;i<count;i++){
  const date=new Date(Date.UTC(2000,0,1+Math.floor(i/2))).toISOString().slice(0,10),key=(i%2?'diary:':'wake:')+date,value=i%2?{text:largeValue?'日'.repeat(39000):'retained fixture record '+i,mood:null}:'07:00';
  const e={key:'app/data/'+key,version:1,deleted:false,value};entries.push({key:e.key,value:e});expected.set(key,{...e,key});
  for(let j=0;j<internalPerRecord;j++){const nk=j?'import/synthetic/'+i+'/'+j:'app/catalog/'+key,n={key:nk,version:1,deleted:false,value:{key,next:previous}};entries.push({key:n.key,value:n});}
  previous=key;changed??=key;
 }
 const add=(key,value)=>entries.push({key,value:{key,version:1,deleted:false,value}});
 add('app/catalog/head',{first:previous});add(APP_CHANGE_HEAD,{protocol:2,seq:1,floor:1,capacity:APP_CHANGE_CAPACITY});add(appChangeSlot(1),{seq:1,key:changed,version:1,deleted:false});entries.sort((a,b)=>a.key.localeCompare(b.key,'en'));
 const root=writer._writeEntries(entries,'entities','history_cut',0),status=writer.status(),cut={id:'history_cut',hash:'a'.repeat(64),revision:100000,nextSlotId:'synthetic_publication',...(paired?{nextPreparationId:'synthetic_history_preparation'}:{})},manifestId='synthetic_manifest',indexId=status.nextIndexId;
 const history=[],receiptSamples=new Map();
 for(let n=1;n<=receiptCount;n++){
  const operationId='history_receipt_'+String(n).padStart(12,'0'),hash=writerDigest({historyFrame:n}),receipt={operationId,epoch:'default',digest:writerDigest({historyOperation:n}),revision:n,frameId:'history_frame_'+n,frameHash:hash,committedAt:'2026-10-07T16:00:00.000Z',result:{historicalImport:n},entityVersions:[]};
  const key=JSON.stringify(['default',operationId]);history.push({key,value:receipt},{key:'@revision:'+n,value:{revision:n,hash}});
  if([1,Math.floor(receiptCount/2),receiptCount].includes(n))receiptSamples.set(key,receipt);
 }
 history.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);const receiptRoot=history.length?writer._writeEntries(history,'receipts','history_receipt_cut',0):null;
 const manifest=writer._sealed('checkpoint-manifest',{datasetGeneration:status.datasetGeneration,cut,stateRoot:root,receiptRoot,acceptedEpochs:status.acceptedEpochs,writerFence:2});writer.io.createFile(manifestId,writer._bytes(manifest),'checkpoint-manifest');const manifestRef={id:manifestId,hash:manifest.hash};
 const pub=writer._sealed('frame',{writerFence:2,datasetGeneration:status.datasetGeneration,revision:100001,parent:{id:cut.id,hash:cut.hash},nextSlotId:'synthetic_absent_frame',...(paired?{nextPreparationId:'synthetic_preparation_slot'}:{}),operation:{operationId:'cut_checkpoint',epoch:status.acceptedEpochs.at(-1),digest:writerDigest('cut')},committedAt:'2026-10-07T17:00:00Z',changes:[],stateRoot:root,receiptRoot,result:{checkpoint:true},references:[],checkpoint:{indexId,nextIndexId:'synthetic_absent_index',previousIndex:null,manifestRef,cut},acceptedEpochs:status.acceptedEpochs});writer.io.createFile('synthetic_publication',writer._bytes(pub),'frame');
 const index=writer._sealed('checkpoint-index',{previousIndex:null,nextIndexId:'synthetic_absent_index',manifestRef,cut,publishingFrame:{id:'synthetic_publication',hash:pub.hash,revision:100001}});writer.io.createFile(indexId,writer._bytes(index),'checkpoint-index');
 return {expected,root,receiptRoot,receiptSamples};
}
