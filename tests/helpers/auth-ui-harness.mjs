/** Controller tests with a deliberately minimal event/DOM double.
 * They cover state transitions and interruption safety, not native browser rendering,
 * validation, focus trapping, keyboard behavior, file pickers, or accessibility layout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState, serializeBackup, todayKey, addDays} from '../../src/lib/domain.js';
import {STORAGE_KEY} from '../../src/lib/storage.js';
import {indexedDBDouble} from './indexeddb-double.js';
import {stateToEntities} from '../../src/lib/entity-codec.js';
import {createIndexedDBStorage} from '../../src/lib/cloud-local-storage.js';

let instance=0;
class EventNode {
  constructor(){this.dataset={};this.handlers=new Map();this._innerHTML='';this.htmlWrites=0;this.hidden=true;this.open=false;this.fields=new Map();this.focused=false;this.focusCalls=0;}
  get innerHTML(){return this._innerHTML;}
  set innerHTML(value){this._innerHTML=value;this.htmlWrites++;this.fields.clear();}
  addEventListener(type,handle){this.handlers.set(type,[...(this.handlers.get(type)||[]),handle]);}
  removeEventListener(type,handle){this.handlers.set(type,(this.handlers.get(type)||[]).filter(item=>item!==handle));}
  async emit(type,event={}){for(const handle of this.handlers.get(type)||[]) await handle(event);}
  showModal(){this.open=true;}
  close(){if(this.open){this.open=false;for(const handle of this.handlers.get('close')||[])handle({});}}
  focus(){this.focused=true;this.focusCalls++;}
  querySelector(selector){if(!this.fields.has(selector))this.fields.set(selector,new EventNode());return this.fields.get(selector);}
  click(){this.clicked=true;}
}
async function launch(t,{initial=createInitialState(),raw:initialRaw,hash='#home',denyRead=false,width=1280,height=900,idb,fetcher,modePreference=null,timers,pullSupported=false,legacySchema=false}={}) {
  // Ordinary controller fixtures represent an already upgraded cache. Explicit
  // legacySchema tests exercise the app migration consent boundary separately.
  if(idb?.version===1&&!legacySchema){const migrated=createIndexedDBStorage(idb);await migrated.read();migrated.close();}
  const originals=new Map(), app=new EventNode(), editor=new EventNode(), notice=new EventNode(), main=new EventNode();
  const document=new EventNode(), window=new EventNode(), created=[];
  window.innerWidth=width;window.innerHeight=height;
  const location={hash}; let raw=initialRaw===undefined?serializeBackup(initial):initialRaw, deniedRead=denyRead, deniedWrite=false, writes=0;
  document.documentElement = {dataset: {}};
  document.querySelector=selector=>({'#app':app,'#editor':editor,'#notice':notice,main}[selector]||null);
  document.createElement=tag=>{const node=new EventNode();node.tag=tag;created.push(node);return node;};
  const localStorage={getItem(key){if(key==='mypace.persistence.mode.v1')return modePreference;assert.equal(key,STORAGE_KEY);if(deniedRead)throw new Error('Storage denied');return raw;},setItem(key,value){if(key==='mypace.persistence.mode.v1'){modePreference=value;return;}assert.equal(key,STORAGE_KEY);if(deniedWrite)throw new Error('Quota exceeded');raw=value;writes++;}};
  const FormData=class{constructor(form){this.values=form.values;}get(key){return this.values[key]??null;}getAll(key){return this.values[key]??[];}};
  for(const [key,value] of Object.entries({document,window,location,localStorage,FormData,indexedDB:idb,fetch:async(path,options)=>{if(!pullSupported&&path==='/api/sync'&&['pull','recover'].includes(JSON.parse(options.body).action))return Response.json({ok:false,error:'ACTION_INVALID'},{status:400});return (fetcher||originals.get('fetch')?.value)(path,options);},requestAnimationFrame:callback=>callback(),addEventListener:window.addEventListener.bind(window),removeEventListener:window.removeEventListener.bind(window),...(timers?{setInterval:(callback,delay)=>{const timer={callback,delay,unref(){}};timers.push(timer);return timer;},clearInterval:timer=>{const i=timers.indexOf(timer);if(i>=0)timers.splice(i,1);}}:{})})) {
    originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  t.after(()=>{for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  await import(`../../src/app.js?auth-ui-controller-test=${instance++}`);
  const click=async(action,data={})=>{const button={dataset:{action,...data},disabled:false};await document.emit('click',{target:{closest:selector=>selector==='[data-action]'?button:null},preventDefault(){}});};
  const form=(type,values,valid=true)=>({dataset:{form:type},values,closest(){return this;},reportValidity(){return valid;}});
  const submitForm=form=>editor.emit('submit',{target:form,preventDefault(){}});
  const submit=(type,values,valid=true)=>submitForm(form(type,values,valid));
  const changeDate=value=>document.emit('change',{target:{id:'selected-date',value}});
  const changeHash=async value=>{location.hash=value;await window.emit('hashchange');};
  const resize=async(width,height)=>{window.innerWidth=width;window.innerHeight=height;await window.emit('resize');};
  const cancelDialog=async()=>{
    const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};
    await editor.emit('cancel',event);
    // Explicitly model the dialog cancel default action. This does not exercise
    // a real Escape key, focus restoration, or the browser's native dialog stack.
    if(!event.defaultPrevented)editor.close();
    return event;
  };
  const fileInput=()=>created.filter(node=>node.type==='file').at(-1);
  const selectFile=async(file,input=fileInput())=>{assert.ok(input,'file input opened');input.files=[file];await input.emit('change');};
  return {app,editor,notice,main,document,window,location,click,form,submit,submitForm,changeDate,changeHash,resize,cancelDialog,fileInput,selectFile,
    mode:()=>modePreference,get raw(){return raw;},get writes(){return writes;},state:()=>JSON.parse(raw),setRaw:value=>{raw=value;},denyWrite:value=>{deniedWrite=value;},denyRead:value=>{deniedRead=value;}};
}

export {launch,EventNode};
