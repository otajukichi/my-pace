import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root=fs.realpathSync(process.cwd());
const assets=JSON.parse(fs.readFileSync(new URL('./public-assets.json',import.meta.url),'utf8'));
const exists=p=>{try{return fs.lstatSync(p)}catch(e){if(e.code==='ENOENT')return null;throw e}};
function inspect(p){const s=fs.lstatSync(p);if(s.isSymbolicLink()||(!s.isDirectory()&&(!s.isFile()||s.nlink!==1)))throw Error('Unsafe build path: '+p);if(s.isDirectory())for(const n of fs.readdirSync(p))inspect(path.join(p,n));}
inspect(path.join(root,'src'));
const dist=path.join(root,'dist');if(exists(dist)){if(!fs.lstatSync(dist).isDirectory())throw Error('dist must be a real directory');inspect(dist)}
if(!Array.isArray(assets)||new Set(assets).size!==assets.length)throw Error('Invalid public asset manifest');
for(const rel of assets){if(typeof rel!=='string'||!['index.html','favicon.svg','about.html','privacy.html','terms.html','src/vendor/LICENSE.txt'].includes(rel)&&!/^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:js|css)$/.test(rel))throw Error('Invalid public asset: '+rel);inspect(path.join(root,rel));}
const stage=fs.mkdtempSync(path.join(root,'.mypace-dist-stage-'));
let backup=null;
try{
 for(const rel of assets){const out=path.join(stage,rel);fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(path.join(root,rel),out,fs.constants.COPYFILE_EXCL);const a=fs.readFileSync(path.join(root,rel)),b=fs.readFileSync(out);if(!crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(),crypto.createHash('sha256').update(b).digest()))throw Error('Build copy changed: '+rel)}
 if(exists(dist)){inspect(dist);backup=fs.mkdtempSync(path.join(path.dirname(root),'my-pace-dist-backup.'));fs.chmodSync(backup,0o700);fs.renameSync(dist,path.join(backup,'previous-dist'))}
 try{fs.renameSync(stage,dist)}catch(e){if(backup&&!exists(dist))fs.renameSync(path.join(backup,'previous-dist'),dist);throw e}
 console.log(`Built dist/ from ${assets.length} explicitly listed public assets. No server, environment, or unlisted files copied.`);
 if(backup)console.log('Previous dist preserved outside this project: '+backup);
}finally{if(exists(stage))fs.rmSync(stage,{recursive:true})}
