// Local packaging only. Does not deploy, authorize, create triggers or call Drive.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const modules=['import-core','codec','bounded-import','transport','immutable-assets','checkpoint-hint','reserved-writer','gas-store-io','import-store','import-runner','gas-import-runtime','owner-bootstrap','discovery-state','idle-reconciliation','owner-scheduler','scheduled-runtime','import-reader'];
const names=Object.fromEntries(modules.map((m,i)=>[m,'m'+i]));
let result='/** Local storage integration milestone. NOT DEPLOYED. No public endpoint or trigger installer. */\nvar MyPaceFolderImport = (function () {\n"use strict";\n';
for(const m of modules){
 let s=fs.readFileSync(path.join(dir,m+'.mjs'),'utf8');const exports=[...s.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/g)].map(x=>x[1]);
 s=s.replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/([^'"]+)\.mjs['"];?/g,(_,keys,dep)=>{if(!names[dep])throw Error('UNKNOWN_IMPORT');return 'const {'+keys+'} = '+names[dep]+';';});
 s=s.replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let)\b)/g,'');
 if(/\bimport\s/.test(s.replace(/\/\/[^\n]*/g,'')))throw Error('UNHANDLED_IMPORT '+m);
 result+='const '+names[m]+' = (function(){\n'+s+'\nreturn {'+exports.join(',')+'};\n})();\n';
}
result+='return Object.assign({},'+modules.map(m=>names[m]).join(',')+');\n})();\n';
// Concurrent test builders publish complete files atomically; readers never
// observe truncated source while another process regenerates the same bundle.
function publish(name,body){const target=path.join(dir,'gas',name),temporary=target+'.tmp-'+process.pid+'-'+Math.random().toString(16).slice(2);try{fs.writeFileSync(temporary,body);fs.renameSync(temporary,target);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}}
fs.mkdirSync(path.join(dir,'gas'),{recursive:true});publish('FolderImport.gs',result);publish('OwnerImportKit.gs',result+'\n'+fs.readFileSync(path.join(dir,'owner-entry.gs'),'utf8')+'\n'+fs.readFileSync(path.join(dir,'owner-maintenance-entry.gs'),'utf8')+'\n'+fs.readFileSync(path.join(dir,'scheduled-entry.gs'),'utf8'));console.log('Built gas/FolderImport.gs and gas/OwnerImportKit.gs (editor entry points only, no deployment)');
