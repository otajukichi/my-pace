import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const tests=[];
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const name=`${dir}/${entry.name}`;if(entry.isDirectory())walk(name);else if(/\.test\.[cm]?js$/.test(name))tests.push(name);}}
walk('tests');walk('storage');
const heavy=/\/(?:large|gas-large)\.test\.mjs$/;
const selected=tests.filter(p=>process.argv.includes('--heavy')?heavy.test(p):!heavy.test(p));
const result=spawnSync(process.execPath,['--test',...selected],{stdio:'inherit'});
process.exit(result.status??1);
