import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';import {fileURLToPath}from 'node:url';
const project=path.dirname(path.dirname(fileURLToPath(import.meta.url))),script=path.join(project,'scripts/build.mjs'),assets=JSON.parse(fs.readFileSync(path.join(project,'scripts/public-assets.json')));
function fixture(){const outer=fs.mkdtempSync(path.join(os.tmpdir(),'mypace-build-')),root=path.join(outer,'repo');fs.mkdirSync(root);for(const r of assets){fs.mkdirSync(path.dirname(path.join(root,r)),{recursive:true});fs.copyFileSync(path.join(project,r),path.join(root,r))}return {outer,root,run:()=>spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8'})}}
test('build allowlist excludes private/unlisted files and replaces stale dist without losing its backup',()=>{const f=fixture();try{for(const r of ['src/secrets.env','src/private.json','src/private.js'])fs.writeFileSync(path.join(f.root,r),'private');fs.mkdirSync(path.join(f.root,'dist'));fs.writeFileSync(path.join(f.root,'dist/secrets.env'),'old private');const result=f.run();assert.equal(result.status,0,result.stderr);for(const r of ['src/secrets.env','src/private.json','src/private.js','secrets.env'])assert.equal(fs.existsSync(path.join(f.root,'dist',r)),false);const backup=fs.readdirSync(f.outer).find(n=>n.startsWith('my-pace-dist-backup.'));assert.equal(fs.readFileSync(path.join(f.outer,backup,'previous-dist/secrets.env'),'utf8'),'old private');assert.equal(fs.statSync(path.join(f.outer,backup)).mode&0o777,0o700);for(const r of assets)assert(fs.existsSync(path.join(f.root,'dist',r)))}finally{fs.rmSync(f.outer,{recursive:true})}});
test('build rejects nested source symlinks before changing dist',()=>{const f=fixture();try{fs.mkdirSync(path.join(f.root,'src/extra'));fs.symlinkSync('/tmp',path.join(f.root,'src/extra/link'));fs.mkdirSync(path.join(f.root,'dist'));fs.writeFileSync(path.join(f.root,'dist/keep'),'keep');assert.notEqual(f.run().status,0);assert.equal(fs.readFileSync(path.join(f.root,'dist/keep'),'utf8'),'keep')}finally{fs.rmSync(f.outer,{recursive:true})}});
test('build rejects existing dist symlinks instead of following or erasing them',()=>{const f=fixture();try{fs.mkdirSync(path.join(f.root,'dist'));fs.symlinkSync('/tmp',path.join(f.root,'dist/link'));assert.notEqual(f.run().status,0);assert(fs.lstatSync(path.join(f.root,'dist/link')).isSymbolicLink())}finally{fs.rmSync(f.outer,{recursive:true})}});

test('static serving uses the same public allowlist and rejects known-path symlinks in source and dist',async()=>{const {createStaticServer}=await import('../scripts/serve.mjs');const f=fixture();try{assert.equal(f.run().status,0);for(const directory of [f.root,path.join(f.root,'dist')]){for(const r of ['src/secrets.env','src/private.json','src/private.js'])fs.writeFileSync(path.join(directory,r),'private secret');const publicJs=assets.find(p=>p.startsWith('src/')&&p.endsWith('.js'));fs.unlinkSync(path.join(directory,publicJs));fs.symlinkSync(path.join(f.root,'src/private.js'),path.join(directory,publicJs));const server=createStaticServer(directory);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{const base=`http://127.0.0.1:${server.address().port}`;for(const r of ['src/secrets.env','src/private.json','src/private.js',publicJs,'.env','api/auth/session']){const response=await fetch(base+'/'+r);assert.equal(response.status,404,r);assert.doesNotMatch(await response.text(),/private secret/)}assert.equal((await fetch(base+'/')).status,200)}finally{await new Promise(resolve=>server.close(resolve))}}}finally{fs.rmSync(f.outer,{recursive:true})}});

test('public browser module graph is closed under local imports and home aggregation is served in source and build',async()=>{
  const {createStaticServer}=await import('../scripts/serve.mjs');
  for(const asset of assets.filter(name=>name.endsWith('.js'))){
    const source=fs.readFileSync(path.join(project,asset),'utf8');
    for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g)){
      const dependency=path.posix.normalize(path.posix.join(path.posix.dirname(asset),match[1]));
      assert.ok(assets.includes(dependency),`${asset} imports unlisted public dependency ${dependency}`);
    }
  }
  assert.ok(assets.includes('src/lib/home-summary.js'),'home aggregation is a deployable public module');
  const f=fixture();try{
    assert.equal(f.run().status,0);
    for(const directory of [f.root,path.join(f.root,'dist')]){
      const server=createStaticServer(directory);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      try{
        const response=await fetch(`http://127.0.0.1:${server.address().port}/src/lib/home-summary.js`);
        assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);
        assert.equal(await response.text(),fs.readFileSync(path.join(project,'src/lib/home-summary.js'),'utf8'));
      }finally{await new Promise(resolve=>server.close(resolve));}
    }
  }finally{fs.rmSync(f.outer,{recursive:true});}
});
