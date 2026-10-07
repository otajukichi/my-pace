import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
async function files(dir){return(await Promise.all((await fs.readdir(dir,{withFileTypes:true})).map(entry=>entry.isDirectory()?files(path.join(dir,entry.name)):[path.join(dir,entry.name)]))).flat();}
let failed=false;
for(const file of [...await files('src'),...await files('scripts'),...await files('tests'),...await files('api'),...await files('server'),...await files('gas'),...await files('storage')].filter(file=>/\.m?js$/.test(file))){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status!==0){failed=true;console.error(result.stderr);}else console.log(`syntax OK ${file}`);}
if(failed)process.exit(1);
