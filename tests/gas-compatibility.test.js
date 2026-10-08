import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {gasParser,restrictGasContext} from './helpers/gas-compat.js';
import {utf8ByteLength} from '../src/lib/domain.js';
const parser=gasParser();
const bundles=['gas/SecureSync.gs','gas/MyPaceComplete.gs','storage/gas/FolderImport.gs','storage/gas/OwnerImportKit.gs'];
const forbidden=new Set(['TextEncoder','TextDecoder','structuredClone','crypto','SubtleCrypto','Buffer','process','require','fetch','URL','URLSearchParams','FormData','File','Blob','DOMException','atob','btoa','window','navigator','performance','setTimeout','setInterval','clearTimeout','clearInterval','ReadableStream','WritableStream']);
function audit(node){
 if(!node||typeof node!=='object')return;
 if(node.type==='Identifier')assert.ok(!forbidden.has(node.name),'Unavailable GAS identifier: '+node.name);
 if(node.type==='MemberExpression'&&!node.computed)assert.ok(!['at','hasOwn','replaceAll','findLast','findLastIndex','toSorted','toReversed','toSpliced','with','groupBy'].includes(node.property.name),'Post-ES2020 builtin: '+node.property.name);
 for(const [key,value] of Object.entries(node)){if(!node.computed&&((node.type==='MemberExpression'&&key==='property')||((node.type==='Property'||node.type==='MethodDefinition')&&key==='key')))continue;if(Array.isArray(value))value.forEach(audit);else if(value&&typeof value==='object')audit(value);}
}
for(const file of bundles){
 test(file+' parses as ES2020 and avoids unsupported host APIs',{skip:!parser&&'Installed Node omits Acorn; ES2020 parser check unavailable (restricted-runtime tests still run)'},()=>{
  const source=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
  audit(parser.parse(source,{ecmaVersion:2020,sourceType:'script'}));
 });
 test(file+' loads without unsupported host APIs',()=>{
  const source=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
  vm.runInContext(source,restrictGasContext(vm.createContext({})),{filename:file});
 });
}
test('missing optional Acorn does not disable runtime verification',()=>{
 assert.equal(gasParser(null),null);
 const context=restrictGasContext(vm.createContext({}));
 assert.equal(vm.runInContext('typeof TextEncoder+","+typeof Object.hasOwn',context),'undefined,undefined');
});
test('compatibility guard rejects the original logical assignment and newer builtins',{skip:!parser&&'Installed Node omits Acorn; parser rejection check unavailable'},()=>{
 assert.throws(()=>parser.parse('x ??= {}',{ecmaVersion:2020}));
 for(const source of ['new TextEncoder()','Object.hasOwn(a,b)','a.at(-1)','structuredClone(a)','crypto.randomUUID()'])assert.throws(()=>audit(parser.parse(source,{ecmaVersion:2020})));
});
test('portable UTF-8 byte count matches Encoding API including lone surrogates',()=>{
 for(const text of ['', 'ASCII', '日本語🌱', '\ud800', '\udc00', '\ud800A', '\ud800\ud800\udc00', '\ufeff', String.fromCharCode(...Array.from({length:65536},(_,i)=>i))])assert.equal(utf8ByteLength(text),new TextEncoder().encode(text).length);
});
test('generated domain and codec round trip habits and backups in restricted context',()=>{
 // Expose private bundle modules only in this test; execute their real generated code.
 const source=fs.readFileSync(new URL('../gas/SecureSync.gs',import.meta.url),'utf8').replace(/return Object\.assign\(\{\},(m\d+(?:,m\d+)*)\);/,'return Object.assign({},m0,m1,$1);');
 const context=restrictGasContext(vm.createContext({}));vm.runInContext(source,context);
 const result=vm.runInContext(`(()=>{const a=MyPaceSecureSync,s=a.createInitialState();s.habits=[{id:'walk',name:'散歩🌱',type:'check',unit:'',target:1,archived:false}];s.habitLogs={walk:{'2026-10-06':false,'2026-10-07':true}};s.diary={'2026-10-07':{text:'日本語🌱',mood:'calm'}};const copy=a.entitiesToState(a.stateToEntities(s));const backup=a.parseBackup(a.serializeBackup(copy));const next=a.clone(copy);next.habitLogs.walk['2026-10-07']=false;return JSON.stringify({s,copy,backup,diff:a.diffEntities(copy,next)});})()`,context);
 const r=JSON.parse(result);assert.deepEqual(r.copy,r.s);assert.deepEqual(r.backup,r.s);assert.equal(r.diff.length,1);assert.equal(r.diff[0].value,false);
});
test('complete restricted bundle imports source, resumes checkpoint and verifies normalized output',async()=>{
 const {runtimeFixture}=await import('../storage/runtime-fixture.mjs');
 const context=restrictGasContext(vm.createContext({}));
 vm.runInContext(fs.readFileSync(new URL('../gas/MyPaceComplete.gs',import.meta.url),'utf8'),context);
 const f=runtimeFixture();const api=context.MyPaceFolderImport;
 const open=()=>api.createGasImportRuntime(f.globals,f.config);
 let r=open();r.locked(()=>r.writer.bootstrap());r.locked(()=>r.store.registerJob({operationId:'register',jobId:'job',sourceIdentity:f.source}));
 assert.equal(r.runner.stepJob('job').status,'parsed');
 // Recreate the runtime for every phase, forcing durable checkpoint decoding.
 for(let i=0;i<4;i++){r=open();r.runner.finalizeJobStep('job');}
 r=open();const restored=r.locked(()=>r.store.resumeJob('job'));
 assert.equal(restored.job.status,'completed');
 const run=r.locked(()=>r.writer.get(api.importKeys.run(restored.job.runId)));
 assert.equal(run.value.imported.sampleCount,1);
 assert.equal(f.calls.filter(c=>c[0]==='create'&&c[1]==='source').length,0);
 assert.equal(vm.runInContext('typeof TextEncoder+","+typeof Object.hasOwn+","+typeof Array.prototype.at+","+typeof crypto+","+typeof structuredClone',context),'undefined,undefined,undefined,undefined,undefined');
});
