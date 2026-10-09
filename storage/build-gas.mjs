// Local packaging only. Does not deploy, authorize, create triggers or call Drive.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const storageModules=['import-core','codec','bounded-import','transport','immutable-assets','checkpoint-hint','preparation-codec','prepared-transaction','prepared-writer','reserved-writer','app-sync-protocol','sync-v2-activation','gas-drive-rest','gas-store-io','import-store','import-runner','gas-import-runtime','web-read-preparation','owner-bootstrap','discovery-state','idle-reconciliation','owner-scheduler','scheduled-runtime','import-reader','incremental-backup','gas-backup-adapter','backup-schedule'];
// Private application rules are needed by owner/scheduled key-rotation recovery.
// Keep their public names (notably LIMITS) out of the storage namespace.
const modules=['../src/lib/domain.js','../src/lib/entity-codec.js',...storageModules.map(m=>m+'.mjs')];
modules.splice(modules.indexOf('app-sync-protocol.mjs')+1,0,'../gas/prepared-app-domain.mjs');
const names=new Map(modules.map((m,i)=>[path.resolve(dir,m),'m'+i]));
let result='/** Local storage integration milestone. NOT DEPLOYED. No public endpoint or trigger installer. */\nvar MyPaceFolderImport = (function () {\n"use strict";\n';
for(const m of modules){
 let s=fs.readFileSync(path.resolve(dir,m),'utf8');const exports=[...s.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/g)].map(x=>x[1]);
 s=s.replace(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/g,(_,keys,dep)=>{const resolved=path.resolve(dir,path.dirname(m),dep),name=names.get(resolved);if(!name)throw Error('UNKNOWN_IMPORT '+m+' -> '+dep);if(modules.indexOf(path.relative(dir,resolved))>=modules.indexOf(m))throw Error('IMPORT_ORDER '+m+' -> '+dep);return 'const {'+keys+'} = '+name+';';});
 s=s.replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let)\b)/g,'');
 if(/\bimport\s/.test(s.replace(/\/\/[^\n]*/g,'')))throw Error('UNHANDLED_IMPORT '+m);
 result+='const '+names.get(path.resolve(dir,m))+' = (function(){\n'+s+'\nreturn {'+exports.join(',')+'};\n})();\n';
}
result+='return Object.assign({},'+modules.filter(m=>!m.startsWith('../src/')).map(m=>names.get(path.resolve(dir,m))).join(',')+');\n})();\n';
// Concurrent test builders publish complete files atomically; readers never
// observe truncated source while another process regenerates the same bundle.
function publish(name,body){const target=path.join(dir,'gas',name);if(process.argv.includes('--check')){if(!fs.existsSync(target)||fs.readFileSync(target,'utf8')!==body)throw Error('STALE_GENERATED_GAS '+name);return;}const temporary=target+'.tmp-'+process.pid+'-'+Math.random().toString(16).slice(2);try{fs.writeFileSync(temporary,body);fs.renameSync(temporary,target);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}}
fs.mkdirSync(path.join(dir,'gas'),{recursive:true});publish('FolderImport.gs',result);publish('OwnerImportKit.gs',result+'\n'+fs.readFileSync(path.join(dir,'owner-entry.gs'),'utf8')+'\n'+fs.readFileSync(path.join(dir,'owner-maintenance-entry.gs'),'utf8')+'\n'+fs.readFileSync(path.join(dir,'scheduled-entry.gs'),'utf8')+'\n'+fs.readFileSync(path.join(dir,'backup-owner-entry.gs'),'utf8'));console.log('Built gas/FolderImport.gs and gas/OwnerImportKit.gs (editor entry points only, no deployment)');
