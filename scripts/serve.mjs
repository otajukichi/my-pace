/** Local-only static server. No dependencies, proxy, upload, or external calls. */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const PUBLIC_ASSETS=new Set(JSON.parse(await fs.readFile(new URL('./public-assets.json',import.meta.url),'utf8')));
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const getArg=(flag,fallback)=>{const index=args.indexOf(flag);return index<0?fallback:args[index+1]||fallback;};
const PORT=Number(getArg('--port',process.env.PORT||'5173'));
const HOST=getArg('--host','127.0.0.1');
const directory=args.includes('--dist')?path.join(ROOT,'dist'):ROOT;
if(!Number.isInteger(PORT)||PORT<1||PORT>65535)throw new Error('Port must be between 1 and 65535.');
const MIME={'.txt':'text/plain; charset=utf-8','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8'};
export function createStaticServer(root = ROOT) {
return http.createServer(async(req,res)=>{
  const directory = root;
  try {
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end('Method not allowed');return;}
    const requested=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const relative=requested==='/'?'index.html':requested.replace(/^\/+/, '');
    const parts=relative.split('/');
    if(parts.some(part=>part.startsWith('.')||part==='..')||relative.includes('\\')||!PUBLIC_ASSETS.has(relative)){res.writeHead(404);res.end('Not found');return;}
    const file=path.resolve(directory,relative);
    if(!file.startsWith(directory+path.sep)){res.writeHead(404);res.end('Not found');return;}
    const type=MIME[path.extname(file)];if(!type){res.writeHead(404);res.end('Not found');return;}
    let current=directory;
    if((await fs.lstat(current)).isSymbolicLink()){res.writeHead(404);res.end('Not found');return;}
    for(const part of parts){current=path.join(current,part);const stat=await fs.lstat(current);if(stat.isSymbolicLink()||(!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1))){res.writeHead(404);res.end('Not found');return;}}
    const body=await fs.readFile(file);
    res.writeHead(200,{'Content-Type':type,'Content-Length':body.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Opener-Policy':'same-origin-allow-popups','Referrer-Policy':'strict-origin-when-cross-origin','Content-Security-Policy':"default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' data: https://tile.openstreetmap.org https://cyberjapandata.gsi.go.jp; connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'"});
    res.end(req.method==='HEAD'?undefined:body);
  } catch(error){res.writeHead(error.code==='ENOENT'?404:400);res.end(error.code==='ENOENT'?'Not found':'Bad request');}
});
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const server = createStaticServer(directory);
server.on('error',error=>{console.error(`Could not start: ${error.message}`);process.exitCode=1;});
server.listen(PORT,HOST,()=>{console.log(`マイペース (My Pace)  http://${HOST}:${PORT}\nStop: Ctrl+C\nLocal static preview only. Cloud login/sync requires the configured Vercel API. Browser storage is per origin.`);if(HOST!=='127.0.0.1'&&HOST!=='localhost')console.warn('Network access enabled. No authentication is provided. Use a trusted private network only.');});

}
