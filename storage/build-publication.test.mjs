import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const run=promisify(execFile),cwd=new URL('.',import.meta.url);
test('concurrent builders publish complete readable GAS files atomically',async()=>{
 await run(process.execPath,['build-gas.mjs'],{cwd});let completed=false,reads=0;
 const builders=Promise.all(Array.from({length:4},()=>run(process.execPath,['build-gas.mjs'],{cwd}))).finally(()=>{completed=true;});
 while(!completed){
  for(const file of ['FolderImport.gs','OwnerImportKit.gs']){const source=fs.readFileSync(new URL('gas/'+file,import.meta.url),'utf8');assert(source.length>100000);new vm.Script(source);reads++;}
  await new Promise(resolve=>setTimeout(resolve,1));
 }
 await builders;assert(reads>=2); // Other concurrent suites may still have their own active temporary build files.
});
