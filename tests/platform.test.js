import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createStaticServer} from '../scripts/serve.mjs';

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
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'my-pace-install-'));
  const destination=path.join(temporary,'empty-repo');await fs.mkdir(path.join(destination,'.git'),{recursive:true});
  await fs.writeFile(path.join(destination,'.git','sentinel'),'existing history');
  try{
    const installed=spawnSync('bash',['scripts/install-wsl.sh',destination],{encoding:'utf8'});assert.equal(installed.status,0,installed.stderr);
    assert.equal(await fs.readFile(path.join(destination,'.git','sentinel'),'utf8'),'existing history');
    assert.match(await fs.readFile(path.join(destination,'package.json'),'utf8'),/my-pace/);
    await fs.writeFile(path.join(destination,'user-file.txt'),'keep me');
    const repeated=spawnSync('bash',['scripts/install-wsl.sh',destination],{encoding:'utf8'});assert.equal(repeated.status,1);assert.match(repeated.stderr,/既存ファイル/);
    assert.equal(await fs.readFile(path.join(destination,'user-file.txt'),'utf8'),'keep me');
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
});
