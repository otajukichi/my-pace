import fs from 'node:fs/promises';
await fs.mkdir('dist',{recursive:true});
for(const file of ['index.html','favicon.svg'])await fs.copyFile(file,`dist/${file}`);
await fs.cp('src','dist/src',{recursive:true});
console.log('Built dist/ (static ES modules; Google SDKs load only after opt-in).');
