import test from 'node:test';
import assert from 'node:assert/strict';
import {createDriveSourceTransport, SOURCE_FOLDER_ID, MAX_RANGE_BYTES,
  SOURCE_FIELDS, validateSourceIdentity, normalizeGasBytes} from './transport.mjs';

const source = (overrides = {}) => ({id: 'test_file', name: 'synthetic.CSV', mimeType: 'text/csv',
  parents: [SOURCE_FOLDER_ID], trashed: false, size: '8', version: '42',
  md5Checksum: '0123456789abcdef0123456789abcdef', ...overrides});
const code = wanted => error => error?.code === wanted && error.message === wanted;
function fixture({pages, metadata, responses, options = {}, token = 'fake-test-token'} = {}) {
  const events = []; let time = 0; let bodyReads = 0;
  let listIndex = 0, metadataIndex = 0, responseIndex = 0;
  function take(values, index, fallback) {
    const value = values ? values[Math.min(index, values.length - 1)] : fallback;
    if (value instanceof Error || value?.throw) throw (value.throw || value);
    if (typeof value === 'function') return value();
    return value;
  }
  const globals = {
    now: () => time, random: () => 0,
    Drive: {Files: {
      list(args) { events.push(['list', args]); return take(pages, listIndex++, {files: [source()]}); },
      get(id, args) { events.push(['metadata', id, args]); return take(metadata, metadataIndex++, source()); },
      create() { throw Error('MUTATION'); }, update() { throw Error('MUTATION'); },
      remove() { throw Error('MUTATION'); }, copy() { throw Error('MUTATION'); }
    }},
    ScriptApp: {getOAuthToken() {events.push(['token']); return token;}},
    Utilities: {sleep(ms) {events.push(['sleep', ms]); time += ms;}},
    UrlFetchApp: {fetch(url, args) {
      events.push(['fetch', url, args]);
      const data = take(responses, responseIndex++, {status: 206, headers: {'Content-Range': 'bytes 0-3/8'}, bytes: [0, 127, -128, -1]});
      if (data.advance) time += data.advance;
      return {getResponseCode: () => data.status,
        getAllHeaders: () => data.headers || {},
        getContent: () => {bodyReads++; return data.bytes;}};
    }}
  };
  return {transport: createDriveSourceTransport(globals, {reserveMs: 0, ...options}),
    events, globals, bodyReads: () => bodyReads, advance: ms => {time += ms;}};
}

test('list reads one bounded fixed-folder page, includes mandatory metadata and filters ineligible sources', () => {
  const f = fixture({pages: [{files: [source(), source({id: 'nested', parents: ['elsewhere']}),
    source({id: 'native', mimeType: 'application/vnd.google-apps.document'}),
    source({id: 'shortcut', mimeType: 'application/vnd.google-apps.shortcut'}),
    source({id: 'folder', mimeType: 'application/vnd.google-apps.folder'}),
    source({id: 'trash', trashed: true}), source({id: 'other', name: 'file.txt'})], nextPageToken: 'next'}]});
  const page = f.transport.listPage();
  assert.equal(page.files.length, 1); assert.equal(page.files[0].id, 'test_file');
  assert.equal(page.done, false); assert.equal(page.nextPageToken, 'next');
  assert.equal(f.events.length, 1);
  const args = f.events[0][1];
  assert.equal(args.q, `'${SOURCE_FOLDER_ID}' in parents and trashed = false`);
  assert.equal(args.pageSize, 100); assert.equal(args.corpora, 'user');
  assert.ok(args.fields.includes(SOURCE_FIELDS));
  assert.ok(!('alt' in args));
});

test('pagination honors empty nonterminal pages and explicit continuation without accumulating files', () => {
  const f = fixture({pages: [{files: [], nextPageToken: 'next'}, {files: [source()]}]});
  assert.deepEqual(f.transport.listPage(), {files: [], nextPageToken: 'next', done: false});
  assert.equal(f.transport.listPage({pageToken: 'next'}).done, true);
  assert.equal(f.events[1][1].pageToken, 'next');
});

test('identity validation requires all mandatory fields and exact safe size, even on listing', () => {
  for (const field of ['id', 'version', 'size', 'md5Checksum']) {
    const file = source(); delete file[field];
    assert.throws(() => validateSourceIdentity(file), code('SOURCE_IDENTITY_REQUIRED'));
    assert.throws(() => fixture({pages: [{files: [file]}]}).transport.listPage(), code('SOURCE_IDENTITY_REQUIRED'));
  }
  for (const value of [8, '-1', '01', '8.1', '', 'NaN']) {
    assert.throws(() => validateSourceIdentity(source({size: value})), code('SOURCE_IDENTITY_REQUIRED'));
  }
  assert.throws(() => validateSourceIdentity(source({size: '9007199254740992'})), code('SOURCE_SIZE_UNSUPPORTED'));
  assert.equal(validateSourceIdentity(source({size: '0'})).size, '0');
  assert.equal(validateSourceIdentity(source({version: '9007199254740993'})).version, '9007199254740993');
});

test('successful exact range uses read-only fixed URL and signed-byte normalization, bracketed by metadata', () => {
  const f = fixture();
  assert.deepEqual([...f.transport.readRange(source(), 0, 4)], [0, 127, 128, 255]);
  assert.deepEqual(f.events.map(e => e[0]), ['metadata', 'token', 'fetch', 'metadata']);
  const fetch = f.events[2];
  assert.equal(fetch[1], 'https://www.googleapis.com/drive/v3/files/test_file?alt=media');
  assert.equal(fetch[2].method, 'get'); assert.equal(fetch[2].headers.Range, 'bytes=0-3');
  assert.equal(fetch[2].followRedirects, false); assert.equal(fetch[2].validateHttpsCertificates, true);
  assert.equal(fetch[2].muteHttpExceptions, true); assert.equal(fetch[2].headers['Accept-Encoding'], 'identity');
  assert.equal(f.bodyReads(), 1);
});

test('range length is clamped to EOF, never exceeds 256 KiB, and requests no media for invalid inputs', () => {
  const f = fixture({responses: [{status: 206, headers: {'content-range': ['bytes 6-7/8'], 'content-length': 2}, bytes: [1, 2]}]});
  assert.deepEqual([...f.transport.readRange(source(), 6, 4)], [1, 2]);
  for (const [start, length] of [[-1, 1], [8, 1], [0, 0], [0, MAX_RANGE_BYTES + 1], [0.5, 1]]) {
    const noRead = fixture();
    assert.throws(() => noRead.transport.readRange(source(), start, length), code('RANGE_REQUEST_INVALID'));
    assert.equal(noRead.events.length, 0);
  }
});

test('bare IDs and out-of-folder or native identities never cause a media request', () => {
  for (const value of ['test_file', source({parents: ['elsewhere']}), source({mimeType: 'application/vnd.google-apps.document'})]) {
    const f = fixture(); assert.throws(() => f.transport.readRange(value, 0, 1), code('SOURCE_OUT_OF_SCOPE'));
    assert.equal(f.events.length, 0);
  }
  assert.throws(() => fixture({options: {folderId: 'elsewhere'}}), code('SOURCE_FOLDER_FIXED'));
});

test('freshness checks fail closed for every identity component and folder membership before and after media', () => {
  const changes = [{version: '43'}, {md5Checksum: 'f'.repeat(32)}, {size: '9'}, {id: 'different'},
    {parents: ['elsewhere']}, {trashed: true}, {name: 'changed.txt'}, {mimeType: 'application/vnd.google-apps.shortcut'}];
  for (const delta of changes) {
    const before = fixture({metadata: [source(delta)]});
    assert.throws(() => before.transport.readRange(source(), 0, 4), code('SOURCE_CHANGED'));
    assert.equal(before.events.filter(e => e[0] === 'fetch').length, 0);
    const after = fixture({metadata: [source(), source(delta)]});
    assert.throws(() => after.transport.readRange(source(), 0, 4), code('SOURCE_CHANGED'));
    assert.equal(after.bodyReads(), 0);
  }
});

test('missing post-range metadata identity or failed post-read verification never exposes bytes', () => {
  const bad = source(); delete bad.md5Checksum;
  const f = fixture({metadata: [source(), bad]});
  assert.throws(() => f.transport.readRange(source(), 0, 4), code('SOURCE_IDENTITY_REQUIRED'));
  assert.equal(f.bodyReads(), 0);
  const lost = fixture({metadata: [source(), {throw: {code: 404}}]});
  assert.throws(() => lost.transport.readRange(source(), 0, 4), code('SOURCE_NOT_FOUND'));
  assert.equal(lost.bodyReads(), 0);
});

test('full-file 200, redirects and every unexpected status are rejected without reading the body', () => {
  for (const status of [200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 416, 418, 501]) {
    const f = fixture({responses: [{status, bytes: new Array(300000).fill(1)}]});
    const expected = status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'SOURCE_NOT_FOUND' : 'RANGE_STATUS_INVALID';
    assert.throws(() => f.transport.readRange(source(), 0, 4), code(expected));
    assert.equal(f.bodyReads(), 0); assert.equal(f.events.filter(e => e[0] === 'fetch').length, 1);
  }
});

test('exact Content-Range, headers, encoding and actual byte count are mandatory', () => {
  const tests = [
    [{}, [1, 2, 3, 4], 'RANGE_HEADERS_INVALID'],
    [{'Content-Range': 'bytes 1-4/8'}, [1, 2, 3, 4], 'RANGE_CONTENT_RANGE_INVALID'],
    [{'Content-Range': 'bytes 0-2/8'}, [1, 2, 3], 'RANGE_CONTENT_RANGE_INVALID'],
    [{'Content-Range': 'bytes 0-3/9'}, [1, 2, 3, 4], 'RANGE_CONTENT_RANGE_INVALID'],
    [{'Content-Range': 'bytes 0-3/*'}, [1, 2, 3, 4], 'RANGE_CONTENT_RANGE_INVALID'],
    [{'Content-Range': 'bytes 00-3/8'}, [1, 2, 3, 4], 'RANGE_CONTENT_RANGE_INVALID'],
    [{'Content-Range': ['bytes 0-3/8', 'bytes 0-3/8']}, [], 'RANGE_HEADERS_INVALID'],
    [{'Content-Range': 'bytes 0-3/8', 'content-range': 'bytes 0-3/8'}, [], 'RANGE_HEADERS_INVALID'],
    [{'Content-Range': 'bytes 0-3/8', 'Content-Length': '5'}, [], 'RANGE_LENGTH_MISMATCH'],
    [{'Content-Range': 'bytes 0-3/8', 'Content-Encoding': 'gzip'}, [], 'RANGE_ENCODING_INVALID'],
    [{'Content-Range': 'bytes 0-3/8', 'Content-Type': 'multipart/byteranges'}, [], 'RANGE_MULTIPART_INVALID'],
    [{'Content-Range': 'bytes 0-3/8'}, [1, 2, 3], 'RANGE_LENGTH_MISMATCH'],
    [{'Content-Range': 'bytes 0-3/8'}, [1, 2, 3, 4, 5], 'RANGE_LENGTH_MISMATCH'],
    [{'Content-Range': 'bytes 0-3/8'}, [1, 2, 3, 256], 'RANGE_BYTES_INVALID']
  ];
  for (const [headers, bytes, expected] of tests) {
    const f = fixture({responses: [{status: 206, headers, bytes}]});
    assert.throws(() => f.transport.readRange(source(), 0, 4), code(expected));
  }
  for (const value of [-129, 256, 1.2, NaN, '1', undefined]) {
    assert.throws(() => normalizeGasBytes([value], 1), code('RANGE_BYTES_INVALID'));
  }
});

test('media 429 and documented 5xx statuses back off with a finite attempt budget and revalidate each retry', () => {
  for (const status of [429, 500, 502, 503, 504]) {
    const f = fixture({responses: [{status}, {status: 206, headers: {'Content-Range': 'bytes 0-3/8'}, bytes: [1, 2, 3, 4]}]});
    assert.equal(f.transport.readRange(source(), 0, 4).length, 4);
    assert.equal(f.events.filter(e => e[0] === 'fetch').length, 2);
    assert.equal(f.events.filter(e => e[0] === 'metadata').length, 4);
    assert.deepEqual(f.events.filter(e => e[0] === 'sleep'), [['sleep', 250]]);
  }
  const exhausted = fixture({responses: [{status: 503}]});
  assert.throws(() => exhausted.transport.readRange(source(), 0, 4), code('RETRY_EXHAUSTED'));
  assert.equal(exhausted.events.filter(e => e[0] === 'fetch').length, 3);
  assert.equal(exhausted.bodyReads(), 0);
});

test('a changed source during transient media failure is never retried or returned', () => {
  const f = fixture({metadata: [source(), source({version: '43'})], responses: [{status: 503}]});
  assert.throws(() => f.transport.readRange(source(), 0, 4), code('SOURCE_CHANGED'));
  assert.equal(f.events.filter(e => e[0] === 'sleep').length, 0);
});

test('long Retry-After, exhausted sleep budget, near deadlines and call budgets yield safely', () => {
  const retry = fixture({responses: [{status: 429, headers: {'Retry-After': '120'}}]});
  assert.throws(() => retry.transport.readRange(source(), 0, 4), e => e.code === 'TRANSPORT_YIELD' && e.retryAfterMs === 120000);
  assert.equal(retry.events.filter(e => e[0] === 'sleep').length, 0);
  const noSleep = fixture({responses: [{status: 503}], options: {maxSleepMs: 0}});
  assert.throws(() => noSleep.transport.readRange(source(), 0, 4), code('TRANSPORT_YIELD'));
  const deadline = fixture({responses: [{status: 503}]});
  assert.throws(() => deadline.transport.readRange(source(), 0, 4, {deadlineMs: 200}), code('TRANSPORT_YIELD'));
  assert.equal(deadline.events.filter(e => e[0] === 'sleep').length, 0);
  const noTime = fixture();
  assert.throws(() => noTime.transport.listPage({deadlineMs: 0}), code('TRANSPORT_YIELD'));
  assert.equal(noTime.events.length, 0);
  const calls = fixture({options: {maxCalls: 2}});
  assert.throws(() => calls.transport.readRange(source(), 0, 4), code('TRANSPORT_YIELD'));
  assert.equal(calls.bodyReads(), 0);
  const slow = fixture({responses: [{status: 206, advance: 120001, headers: {'Content-Range': 'bytes 0-3/8'}, bytes: [1, 2, 3, 4]}]});
  assert.throws(() => slow.transport.readRange(source(), 0, 4), code('TRANSPORT_YIELD'));
  assert.equal(slow.bodyReads(), 0);
});

test('advanced metadata transient retries are bounded; authorization and unknown exceptions fail closed without leaking text', () => {
  const transient = fixture({metadata: [{throw: {details: {code: 503}}}, source()]});
  assert.equal(transient.transport.getSource(source()).id, 'test_file');
  for (const failure of [{code: 401}, {code: 403}, Error('sensitive exception text fake-test-token')]) {
    const f = fixture({metadata: [{throw: failure}]});
    assert.throws(() => f.transport.getSource(source()), e =>
      e.code === (failure.code === 401 ? 'AUTH_REQUIRED' : failure.code === 403 ? 'FORBIDDEN' : 'DRIVE_REQUEST_FAILED') && !JSON.stringify(e).includes('fake-test-token'));
    assert.equal(f.events.filter(e => e[0] === 'metadata').length, 1);
    assert.equal(f.events.filter(e => e[0] === 'sleep').length, 0);
  }
});

test('lost media responses and invalid authentication never fall back to a whole-file download', () => {
  const f = fixture({responses: [{throw: Error('lost response')}]});
  assert.throws(() => f.transport.readRange(source(), 0, 4), code('MEDIA_REQUEST_FAILED'));
  assert.deepEqual(f.events.map(e => e[0]), ['metadata', 'token', 'fetch', 'metadata']);
  for (const token of ['', undefined, 'bad token', 'bad\r\ntoken']) {
    const bad = fixture({token: token === undefined ? null : token});
    assert.throws(() => bad.transport.readRange(source(), 0, 4), code('AUTH_REQUIRED'));
    assert.equal(bad.events.filter(e => e[0] === 'fetch').length, 0);
  }
});

test('incomplete/oversized pages, stalled tokens, and rejected continuation do not masquerade as a completed scan', () => {
  for (const [page, error, args] of [
    [{files: [], incompleteSearch: true}, 'LIST_INCOMPLETE', {}],
    [{files: new Array(101).fill(source())}, 'LIST_RESPONSE_INVALID', {}],
    [{files: [], nextPageToken: 'same'}, 'PAGE_TOKEN_STALLED', {pageToken: 'same'}],
    [{files: [], nextPageToken: 'x'.repeat(4097)}, 'PAGE_TOKEN_INVALID', {}]
  ]) assert.throws(() => fixture({pages: [page]}).transport.listPage(args), code(error));
  const rejected = fixture({pages: [{throw: {code: 400}}]});
  assert.throws(() => rejected.transport.listPage({pageToken: 'expired'}), e => e.code === 'PAGE_TOKEN_REJECTED' && e.restartScan === true);
  assert.equal(rejected.events.length, 1);
});


test('structured 403 rate-limit errors back off, while unknown and mixed reasons stay FORBIDDEN', () => {
  for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded']) {
    const f = fixture({metadata: [{throw: {code: 403, details: {errors: [{reason}]}}}, source()]});
    assert.equal(f.transport.getSource(source()).id, 'test_file');
    assert.deepEqual(f.events.filter(e => e[0] === 'sleep'), [['sleep', 250]]);
    const bytes = [...Buffer.from(JSON.stringify({error: {errors: [{reason}]}}))];
    const media = fixture({responses: [{status: 403, headers: {'Content-Type': 'application/json; charset=UTF-8',
      'Content-Length': String(bytes.length)}, bytes},
      {status: 206, headers: {'Content-Range': 'bytes 0-3/8'}, bytes: [1, 2, 3, 4]}]});
    assert.equal(media.transport.readRange(source(), 0, 4).length, 4);
    assert.equal(media.events.filter(e => e[0] === 'fetch').length, 2);
    assert.equal(media.events.filter(e => e[0] === 'metadata').length, 4);
  }
  for (const reasons of [[{reason: 'insufficientFilePermissions'}], [{reason: 'rateLimitExceeded'}, {reason: 'forbidden'}],
    new Array(9).fill({reason: 'rateLimitExceeded'})]) {
    const f = fixture({metadata: [{throw: {code: 403, errors: reasons}}]});
    assert.throws(() => f.transport.getSource(source()), code('FORBIDDEN'));
    assert.equal(f.events.filter(e => e[0] === 'sleep').length, 0);
  }
});

test('403 error-body inspection is limited to declared small JSON and rejects malformed or unstructured data', () => {
  for (const headers of [{}, {'Content-Length': '8193', 'Content-Type': 'application/json'},
    {'Content-Length': '10', 'Content-Type': 'text/html'}, {'Content-Length': 'unknown', 'Content-Type': 'application/json'}]) {
    const f = fixture({responses: [{status: 403, headers, bytes: new Array(8193).fill(0)}]});
    assert.throws(() => f.transport.readRange(source(), 0, 4), code('FORBIDDEN'));
    assert.equal(f.bodyReads(), 0);
  }
  for (const bytes of [[123], [...Buffer.from('{"error":{"errors":[{"reason":"forbidden"}]}}')]]) {
    const f = fixture({responses: [{status: 403, headers: {'Content-Type': 'application/json', 'Content-Length': String(bytes.length)}, bytes}]});
    assert.throws(() => f.transport.readRange(source(), 0, 4), code('FORBIDDEN'));
    assert.equal(f.events.filter(e => e[0] === 'fetch').length, 1);
  }
});

test('malformed metadata entries cannot silently turn an incomplete list into a successful empty scan', () => {
  for (const file of [null, {}, source({parents: undefined}), source({trashed: undefined})]) {
    assert.throws(() => fixture({pages: [{files: [file]}]}).transport.listPage(), code('LIST_RESPONSE_INVALID'));
  }
});
