import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { privatePath } from '../processing/running/private-path.mjs';
import { atomic, json } from '../processing/running/cache.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--client', '--tokens'].includes(args[i]) || !args[i + 1]) throw Error('Usage: npm run authorize:running -- --client data/google-client.json');
  options[args[i]] = args[i + 1];
}
if (!options['--client']) throw Error('GOOGLE_DESKTOP_CLIENT_FILE_REQUIRED');
const credential = JSON.parse(await readFile(await privatePath(options['--client']), 'utf8')).installed;
if (!credential?.client_id) throw Error('GOOGLE_DESKTOP_CLIENT_REQUIRED');
const tokenPath = await privatePath(options['--tokens'] || 'data/running-worker/oauth.json');
const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
let redirect, finish;
const done = new Promise(resolve => { finish = resolve; });
let used = false;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, redirect);
  if (url.pathname !== '/callback' || url.searchParams.get('state') !== state || used) { response.writeHead(400); response.end('Invalid authorization callback.'); return; }
  used = true;
  try {
    if (!url.searchParams.get('code') || url.searchParams.has('error')) throw Error('GOOGLE_AUTH_NOT_GRANTED');
    const result = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        code: url.searchParams.get('code'), client_id: credential.client_id, client_secret: credential.client_secret || '',
        redirect_uri: redirect, code_verifier: verifier, grant_type: 'authorization_code',
      }) });
    if (!result.ok) throw Error('GOOGLE_AUTH_EXCHANGE_FAILED');
    const token = await result.json();
    if (!token.refresh_token) throw Error('GOOGLE_REFRESH_TOKEN_REQUIRED');
    await atomic(tokenPath, json({ client_id: credential.client_id, client_secret: credential.client_secret || '', refresh_token: token.refresh_token }));
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" });
    response.end('MyPace の認証が完了しました。このタブを閉じてください。');
    console.log('DRIVE_AUTH_READY');
  } catch {
    response.writeHead(400); response.end('Authorization failed. Return to the terminal and try again.');
    console.error('DRIVE_AUTH_FAILED'); process.exitCode = 1;
  } finally { finish(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
redirect = `http://127.0.0.1:${server.address().port}/callback`;
const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
for (const [key, value] of Object.entries({ client_id: credential.client_id, redirect_uri: redirect, response_type: 'code',
  scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file',
  access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
console.log('同じPCのブラウザーで開き、記録を保存しているGoogleアカウントで許可してください。');
console.log(url.href);
const timer = setTimeout(() => { console.error('DRIVE_AUTH_TIMEOUT'); process.exitCode = 1; finish(); }, 300000);
await done; clearTimeout(timer); server.close();
