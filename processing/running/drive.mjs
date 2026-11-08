import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const API = 'https://www.googleapis.com/drive/v3/';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/';
const FIELDS = 'id,name,mimeType,size,version,md5Checksum,parents,trashed';
const id = value => { if (typeof value !== 'string' || !/^[\w-]+$/.test(value)) throw Error('DRIVE_ID_INVALID'); return value; };

export function contentRevision(file) {
  if (!/^\d+$/.test(String(file.size)) || !/^[a-f0-9]{32}$/.test(file.md5Checksum || '')) throw Error('DRIVE_BINARY_CHECKSUM_REQUIRED');
  return `${file.size}:${file.md5Checksum}`;
}

/** Keep OAuth credentials on the worker, never in viewer artifacts or logs. */
export function oauthTokenProvider(tokenPath, fetchImpl = fetch) {
  let token, expires = 0;
  return async (force = false) => {
    if (!force && token && Date.now() + 60000 < expires) return token;
    const credential = JSON.parse(await readFile(tokenPath, 'utf8'));
    if (!credential.client_id || !credential.refresh_token) throw Error('DRIVE_AUTH_SETUP_REQUIRED');
    const response = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(30000),
      body: new URLSearchParams({ client_id: credential.client_id, client_secret: credential.client_secret || '',
        refresh_token: credential.refresh_token, grant_type: 'refresh_token' }) });
    if (!response.ok) throw Error(`DRIVE_AUTH_${response.status}`);
    const value = await response.json();
    if (!value.access_token || !Number.isFinite(value.expires_in)) throw Error('DRIVE_AUTH_RESPONSE_INVALID');
    token = value.access_token; expires = Date.now() + value.expires_in * 1000; return token;
  };
}

async function boundedBytes(response, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw Error('DRIVE_RESPONSE_SIZE_LIMIT');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createDriveClient({ accessToken, fetchImpl = fetch, wait = sleep, stats = {} }) {
  async function request(path, { query = {}, method = 'GET', headers = {}, body, upload = false, retry = true } = {}) {
    const url = new URL(path, upload ? UPLOAD : API);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    let refresh = false;
    for (let attempt = 0; ; attempt++) {
      stats.requests = (stats.requests || 0) + 1;
      const token = await accessToken(refresh); refresh = false;
      let response;
      try {
        response = await fetchImpl(url, { method, body, headers: { ...headers, Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(45000), redirect: 'error' });
      } catch {
        if (!retry || attempt >= 4) throw Error('DRIVE_NETWORK_ERROR');
        await wait(Math.min(30000, 1000 * 2 ** attempt)); continue;
      }
      if (response.ok) return response;
      const status = response.status;
      let rateLimited = false;
      if (status === 403) {
        try { const error = JSON.parse((await boundedBytes(response, 65536)).toString());
          rateLimited = error.error?.errors?.some(e => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(e.reason));
        } catch { /* Do not copy remote messages, which can contain personal metadata. */ }
      } else await response.body?.cancel();
      if (retry && attempt < 4 && (status === 401 && attempt === 0 || status === 429 || status >= 500 || rateLimited)) {
        refresh = status === 401;
        const retryAfter = Number(response.headers.get('retry-after'));
        await wait(Math.min(30000, Math.max(1000 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0))); continue;
      }
      throw Object.assign(Error(`DRIVE_HTTP_${status}`), { status });
    }
  }
  async function get(path, query) { return JSON.parse((await boundedBytes(await request(path, { query }), 8 * 1024 * 1024)).toString('utf8')); }
  async function list(q) {
    const files = [], seen = new Set(); let pageToken;
    do {
      if (seen.has(pageToken)) throw Error('DRIVE_PAGE_LOOP'); seen.add(pageToken);
      const result = await get('files', { q, fields: `nextPageToken,incompleteSearch,files(${FIELDS},appProperties)`, pageSize: 1000, pageToken, spaces: 'drive' });
      if (result.incompleteSearch || !Array.isArray(result.files)) throw Error('DRIVE_INCOMPLETE_INVENTORY');
      files.push(...result.files); pageToken = result.nextPageToken;
    } while (pageToken);
    return files;
  }
  return {
    stats,
    metadata: fileId => get(`files/${id(fileId)}`, { fields: FIELDS }),
    folder: folderId => list(`'${id(folderId)}' in parents and trashed = false`),
    startToken: async () => (await get('changes/startPageToken', {})).startPageToken,
    async changes(pageToken) {
      return get('changes', { pageToken, pageSize: 1000, spaces: 'drive', includeRemoved: true,
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))` });
    },
    async range(fileId, start, end, size) {
      const response = await request(`files/${id(fileId)}`, { query: { alt: 'media' }, headers: { Range: `bytes=${start}-${end}` } });
      if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${size}`) {
        await response.body?.cancel(); throw Error('DRIVE_RANGE_NOT_HONORED');
      }
      const bytes = await boundedBytes(response, end - start + 1);
      if (bytes.length !== end - start + 1) throw Error('DRIVE_RANGE_TRUNCATED');
      stats.downloadBytes = (stats.downloadBytes || 0) + bytes.length; return bytes;
    },
    // New app-owned files only. A generated ID makes retries after a lost
    // response idempotent; callers persist that ID before attempting upload.
    async newId() { return (await get('files/generateIds', { count: 1, space: 'drive', type: 'files' })).ids[0]; },
    async create(metadata, bytes) {
      const boundary = 'mypace_running_upload_boundary';
      const header = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`);
      const body = Buffer.concat([header, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const response = await request('files', { upload: true, method: 'POST', query: { uploadType: 'multipart', fields: FIELDS },
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body, retry: false });
      return JSON.parse((await boundedBytes(response, 65536)).toString());
    },
    async createFolder(metadata) {
      const response = await request('files', { method: 'POST', query: { fields: FIELDS },
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata), retry: false });
      return JSON.parse((await boundedBytes(response, 65536)).toString());
    },
    async replace(fileId, bytes) {
      const response = await request(`files/${id(fileId)}`, { upload: true, method: 'PATCH', query: { uploadType: 'media', fields: FIELDS },
        headers: { 'Content-Type': 'application/json' }, body: bytes });
      return JSON.parse((await boundedBytes(response, 65536)).toString());
    },
    async assertPrivate(folderId) {
      const result = await get(`files/${id(folderId)}/permissions`, { fields: 'nextPageToken,permissions(type,role)', pageSize: 100 });
      if (result.nextPageToken || !result.permissions?.length || result.permissions.some(p => p.type !== 'user' || p.role !== 'owner')) throw Error('DRIVE_OUTPUT_MUST_BE_OWNER_ONLY');
    },
  };
}
