import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { bundleProbe } from '../../scripts/build-running-gas-probe.mjs';

const md5 = bytes => createHash('md5').update(bytes).digest('hex');
const blob = value => {
  const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value || []);
  return { getBytes: () => Array.from(bytes, b => b > 127 ? b - 256 : b), getDataAsString: () => bytes.toString('utf8') };
};

/** Simulates persistence and failures, NOT Google's latency, quota or memory.
 * Each invocation gets a completely new VM, like a cold Apps Script run. */
export async function gasProbeHarness(config, sourceBytes, { requestMs = 5, beforeRequest, afterRequest } = {}) {
  const code = await bundleProbe({ ...config, environment: 'simulation' }), files = new Map(), properties = new Map(), requests = [], logs = [];
  let sequence = 0, clock = Date.parse('2026-01-01T00:00:00Z'), locked = false;
  const triggers = [{ handler: 'unrelatedExistingTestHandler' }];
  files.set(config.sourceFolder, { meta: { id: config.sourceFolder, mimeType: 'application/vnd.google-apps.folder', ownedByMe: true, shared: false, version: '1' }, bytes: Buffer.alloc(0) });
  for (const source of config.sources) {
    const bytes = sourceBytes.get(source.id);
    files.set(source.id, { bytes, meta: { id: source.id, name: source.id + '.csv', mimeType: 'text/csv', size: String(bytes.length), md5Checksum: md5(bytes),
      parents: [config.sourceFolder], ownedByMe: true, shared: false, version: '1' } });
  }
  function response(status, bytes, headers = {}) {
    bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(JSON.stringify(bytes));
    return { getResponseCode: () => status, getContentText: () => bytes.toString('utf8'), getAllHeaders: () => headers, getBlob: () => blob(bytes) };
  }
  function fetch(url, options = {}) {
    clock += requestMs;
    const uri = new URL(url), method = options.method || 'get', path = uri.pathname.replace(/^\/(?:upload\/)?drive\/v3\//, '');
    requests.push({ method, path, range: options.headers?.Range });
    beforeRequest?.({ method, path, options, files });
    let answer;
    if (path === 'files/generateIds') answer = response(200, { ids: Array.from({ length: Number(uri.searchParams.get('count')) }, () => 'reserved_' + String(++sequence).padStart(5, '0')) });
    else if (path === 'files' && method === 'post') {
      let metadata, content = Buffer.alloc(0);
      if (uri.searchParams.get('uploadType') === 'multipart') {
        const boundary = options.contentType.split('boundary=')[1];
        const parts = options.payload.split('--' + boundary);
        metadata = JSON.parse(parts[1].split('\r\n\r\n')[1]);
        content = Buffer.from(parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4, -2));
      } else metadata = JSON.parse(options.payload);
      if (files.has(metadata.id)) return response(409, {});
      const meta = { ...metadata, ownedByMe: true, shared: false, trashed: false, version: '1', size: String(content.length), md5Checksum: md5(content) };
      files.set(meta.id, { meta, bytes: content }); answer = response(200, meta);
    } else if (path.startsWith('files/')) {
      const file = files.get(path.slice(6));
      if (!file) return response(404, {});
      if (method === 'patch') {
        file.bytes = Buffer.from(options.payload); file.meta.size = String(file.bytes.length); file.meta.md5Checksum = md5(file.bytes);
        file.meta.version = String(Number(file.meta.version) + 1); answer = response(200, file.meta);
      } else if (uri.searchParams.get('alt') === 'media') {
        const range = options.headers?.Range;
        if (range) {
          const [, a, b] = range.match(/^bytes=(\d+)-(\d+)$/), start = Number(a), end = Number(b);
          answer = response(206, file.bytes.subarray(start, end + 1), { 'Content-Range': `bytes ${start}-${end}/${file.bytes.length}` });
        } else answer = response(200, file.bytes);
      } else answer = response(200, file.meta);
    } else throw Error('UNEXPECTED_TEST_REQUEST');
    afterRequest?.({ method, path, options, files }); return answer;
  }
  const api = {
    UrlFetchApp: { fetch },
    Utilities: { newBlob: blob, getUuid: () => '00000000-0000-4000-8000-000000000001', DigestAlgorithm: { SHA_256: 'sha256', MD5: 'md5' },
      computeDigest: (algorithm, bytes) => Array.from(createHash(algorithm).update(Buffer.from(bytes)).digest(), b => b > 127 ? b - 256 : b) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) ?? null, setProperty(key, value) {
      if (Buffer.byteLength(value) > 9000) throw Error('PROPERTY_TOO_LARGE'); properties.set(key, value);
    }, deleteProperty: key => properties.delete(key) }) },
    LockService: { getScriptLock: () => ({ tryLock() { if (locked) return false; locked = true; return true; }, releaseLock() { locked = false; } }) },
    ScriptApp: { getScriptId: () => 'synthetic-probe-project', getOAuthToken: () => 'synthetic-not-a-token',
      getProjectTriggers: () => triggers.map(t => ({ item: t, getHandlerFunction: () => t.handler })),
      deleteTrigger: t => triggers.splice(triggers.indexOf(t.item), 1),
      newTrigger: handler => ({ timeBased() { return this; }, everyMinutes(n) { if (n !== 5) throw Error('TEST_CADENCE'); return this; }, create() { triggers.push({ handler }); } }) },
    console: { log: text => { try { logs.push(JSON.parse(text)); } catch { logs.push({ message: text }); } } },
    Date: class extends Date { static now() { return clock; } },
  };
  function invoke(name, extra = {}) {
    const context = vm.createContext({ ...api, ...extra }); new vm.Script(code).runInContext(context);
    return new vm.Script(name + '()').runInContext(context, { timeout: 60000 });
  }
  return { invoke, files, properties, requests, logs, triggers, advance: milliseconds => { clock += milliseconds; },
    get state() { const f = [...files.values()].find(f => f.meta.appProperties?.role === 'state'); return f ? JSON.parse(f.bytes) : null; },
    get report() { const f = [...files.values()].find(f => f.meta.appProperties?.role === 'report'); return f ? JSON.parse(f.bytes) : null; },
    code };
}
