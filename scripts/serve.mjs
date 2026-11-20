import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { lstat, realpath, readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createWeatherApiHandler } from './weather-area.mjs';
import { createDriveService } from '../server/drive-auth.js';
import { createEnglishService } from '../server/english-service.js';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_FILES = new Set(['index.html', 'app.js', 'styles.css']);
const EXCLUDED_SEGMENTS = new Set(['旧my-pace', 'tests', 'docs', 'scripts', 'node_modules', 'dist']);
const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.gif', 'image/gif'], ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'], ['.otf', 'font/otf'],
  ['.txt', 'text/plain; charset=utf-8'],
]);
const ASSET_EXTENSIONS = new Set([
  '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
]);

function safeSegments(relativePath) {
  const segments = relativePath.split('/');
  return segments.every(segment => segment && !segment.startsWith('.')
    && !EXCLUDED_SEGMENTS.has(segment) && !/[\\%\x00-\x1f\x7f:#?]/.test(segment));
}

function allowed(relativePath) {
  if (!safeSegments(relativePath)) return false;
  if (ROOT_FILES.has(relativePath) || relativePath === 'data/running.json') return true;
  if (relativePath.startsWith('lib/')) return ['.js', '.css'].includes(extname(relativePath));
  if (relativePath.startsWith('assets/')) {
    return ASSET_EXTENSIONS.has(extname(relativePath)) || relativePath.endsWith('/LICENSE.txt');
  }
  return false;
}

function requestPath(requestTarget) {
  // Parse the original request target before URL normalization can erase "..".
  if (typeof requestTarget !== 'string' || requestTarget.length > 4096
      || !requestTarget.startsWith('/') || requestTarget.startsWith('//')) return null;
  const encoded = requestTarget.split('?', 1)[0];
  if (/%(?:2f|5c)/i.test(encoded)) return null;
  let path;
  try { path = decodeURIComponent(encoded); } catch { return null; }
  if (path === '/') return 'index.html';
  const relativePath = path.slice(1);
  return allowed(relativePath) ? relativePath : null;
}

/** Resolve an allowlisted, regular public file; null means 404. Never follows symlinks. */
export async function resolvePublicPath(requestTarget, { root = PROJECT_ROOT } = {}) {
  const relativePath = requestPath(requestTarget);
  if (!relativePath) return null;
  try {
    const canonicalRoot = await realpath(root);
    let filePath = canonicalRoot;
    const segments = relativePath.split('/');
    let stat;
    for (let index = 0; index < segments.length; index++) {
      filePath = join(filePath, segments[index]);
      stat = await lstat(filePath);
      if (stat.isSymbolicLink() || (index < segments.length - 1 && !stat.isDirectory())) return null;
    }
    if (!stat?.isFile()) return null;
    return { filePath, relativePath, mimeType: MIME_TYPES.get(extname(relativePath)), size: stat.size };
  } catch { return null; }
}

/** Shared server/build policy: omitted paths can never be copied into a build. */
export async function listPublicFiles({ root = PROJECT_ROOT } = {}) {
  const candidates = [...ROOT_FILES, 'data/running.json'];
  async function visit(relativeDirectory) {
    if (!safeSegments(relativeDirectory)) return;
    const directory = join(root, relativeDirectory);
    let entries;
    try {
      if (!(await lstat(directory)).isDirectory()) return;
      entries = await readdir(directory, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      const relativePath = relativeDirectory + '/' + entry.name;
      if (!safeSegments(relativePath) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(relativePath);
      else if (entry.isFile() && allowed(relativePath)) candidates.push(relativePath);
    }
  }
  await visit('lib');
  await visit('assets');
  const files = [];
  for (const relativePath of candidates.sort()) {
    const file = await resolvePublicPath('/' + relativePath, { root });
    if (file) files.push(file);
  }
  return files;
}

function plain(response, status, text) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(text);
}

/** Constructs a server without listening. The CLI below binds only to 127.0.0.1. */
export function createStaticServer({ root = PROJECT_ROOT, weatherArea } = {}) {
  const handleApi = createWeatherApiHandler({ root, weatherArea });
  const drive = createDriveService();
  const english = createEnglishService();
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (await handleApi(request, response)) return;
    // Keep this personal-data server inaccessible through a rebound public hostname.
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(request.headers.host ?? '')) {
      plain(response, 403, 'Local access only.\n');
      return;
    }
    const pathname = request.url.split('?')[0];
    if (pathname === '/api/google-auth') return drive.auth(request, response);
    if (pathname === '/api/running-drive') return drive.artifact(request, response);
    if (pathname === '/api/english') return english.handle(request, response);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      plain(response, 405, 'Method not allowed.\n');
      return;
    }
    const file = await resolvePublicPath(request.url, { root });
    if (!file) { plain(response, 404, 'Not found.\n'); return; }
    response.writeHead(200, { 'Content-Type': file.mimeType, 'Content-Length': file.size });
    if (request.method === 'HEAD') { response.end(); return; }
    try { await pipeline(createReadStream(file.filePath), response); }
    catch { if (!response.destroyed) response.destroy(); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile?.(join(PROJECT_ROOT, '.env.local')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const value = process.env.PORT ?? '4173';
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be a whole number between 1 and 65535.');
    process.exitCode = 1;
  } else {
    const server = createStaticServer();
    server.once('error', error => {
      console.error(error.code === 'EADDRINUSE'
        ? `Port ${port} is in use. Choose another PORT.` : 'The local server could not start.');
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`MyPace: http://127.0.0.1:${port}`);
      console.log('Private local preview. The running data and dist build must not be published.');
    });
  }
}
