import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createStaticServer} from '../scripts/serve.mjs';

async function withInstallerFixture(run){
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'my-pace-install-'));
  const source=path.join(temporary,'source');
  const root=fileURLToPath(new URL('../',import.meta.url));
  try{
    // The installer accepts a distribution, not a Git checkout or generated output.
    await fs.cp(root,source,{recursive:true,filter(file){
      const relative=path.relative(root,file);
      const parts=relative.split(path.sep);
      return !parts.some(part=>['.git','node_modules','dist','.DS_Store'].includes(part))
        && relative!==path.join('qa','screenshots')
        && !/^(?:SOURCE-MANIFEST\.sha256|\.env(?:\..*)?|(?:rhythm|my-pace)-(?:backup|recovery)-.*\.json)$/.test(relative)
        && !relative.endsWith('.log');
    }});
    const checksums=[];
    async function hashFiles(directory){
      for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
        const file=path.join(directory,entry.name);
        if(entry.isDirectory())await hashFiles(file);
        else checksums.push(`${createHash('sha256').update(await fs.readFile(file)).digest('hex')}  ${path.relative(source,file).split(path.sep).join('/')}`);
      }
    }
    await hashFiles(source);
    await fs.writeFile(path.join(source,'SOURCE-MANIFEST.sha256'),checksums.join('\n')+'\n');
    await run({source,destination:path.join(temporary,'empty-repo'),install(destination){
      return spawnSync('bash',[path.join(source,'scripts','install-wsl.sh'),destination],{encoding:'utf8'});
    }});
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
}

test('static server serves app with safe MIME/CSP and refuses private or non-read routes',async()=>{
  const server=createStaticServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    const index=await fetch(base);assert.equal(index.status,200);assert.match(await index.text(),/lang="ja"/);assert.match(index.headers.get('content-security-policy'),/connect-src 'none'/);
    const js=await fetch(base+'/src/app.js');assert.equal(js.status,200);assert.match(js.headers.get('content-type'),/javascript/);
    for(const uri of ['/README.md','/.git/config','/package.json','/src/%2e%2e/README.md','/src/%5cREADME.md','/src/no-file.js'])assert.equal((await fetch(base+uri)).status,404,uri);
    assert.equal((await fetch(base,{method:'POST',body:'no'})).status,405);
    const head=await fetch(base,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('WSL installer preserves .git and refuses to overwrite existing user files',async()=>{
  await withInstallerFixture(async({destination,install})=>{
    await fs.mkdir(path.join(destination,'.git'),{recursive:true});
    await fs.writeFile(path.join(destination,'.git','sentinel'),'existing history');
    const installed=install(destination);assert.equal(installed.status,0,installed.stderr);
    assert.equal(await fs.readFile(path.join(destination,'.git','sentinel'),'utf8'),'existing history');
    assert.match(await fs.readFile(path.join(destination,'package.json'),'utf8'),/my-pace/);
    const integrity=spawnSync('sha256sum',['-c','SOURCE-MANIFEST.sha256'],{cwd:destination,encoding:'utf8'});assert.equal(integrity.status,0,integrity.stderr);
    await fs.writeFile(path.join(destination,'user-file.txt'),'keep me');
    const repeated=install(destination);assert.equal(repeated.status,1);assert.match(repeated.stderr,/既存ファイル/);
    assert.equal(await fs.readFile(path.join(destination,'user-file.txt'),'utf8'),'keep me');
  });
});

test('WSL installer rejects a distribution containing source Git metadata',async()=>{
  await withInstallerFixture(async({source,destination,install})=>{
    await fs.mkdir(path.join(source,'.git'));
    await fs.writeFile(path.join(source,'.git','sentinel'),'source history');
    const rejected=install(destination);assert.equal(rejected.status,1);assert.match(rejected.stderr,/配布元に \.git/);
    await assert.rejects(fs.access(destination),{code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(source,'.git','sentinel'),'utf8'),'source history');
  });
});

for(const change of ['modified','missing'])test(`WSL installer rejects a ${change} manifest-listed source file before copying`,async()=>{
  await withInstallerFixture(async({source,destination,install})=>{
    const file=path.join(source,'package.json');
    if(change==='modified')await fs.appendFile(file,'\n');else await fs.rm(file);
    const rejected=install(destination);assert.equal(rejected.status,1);assert.match(rejected.stderr,/sha256sum:/);
    await assert.rejects(fs.access(destination),{code:'ENOENT'});
  });
});
