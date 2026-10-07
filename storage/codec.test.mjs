import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {CsvBytes} from './import-core.mjs';
import {decodeUtf8, encodeUtf8, IncrementalSha256} from './codec.mjs';

const nativeHash = bytes => createHash('sha256').update(bytes).digest('hex');
const restore = hash => new IncrementalSha256(JSON.parse(JSON.stringify(hash.snapshot())));
const nativeDecode = bytes => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
const nativeEncode = text => new TextEncoder().encode(text);

// These known FIPS examples complement the separately implemented Node crypto
// oracle; no expected digest is computed by this implementation.
const vectors = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ['abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'],
];

test('strict UTF-8 round trips all Unicode scalar boundary values and BOM', () => {
  const scalars = [0, 1, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xfeff, 0xffff, 0x10000, 0x10ffff];
  const text = '\ufeff' + String.fromCodePoint(...scalars) + '日本語\r\n"😀"';
  assert.deepEqual(encodeUtf8(text), nativeEncode(text));
  assert.equal(decodeUtf8(nativeEncode(text)), text);
  assert.equal(decodeUtf8(encodeUtf8('\ufeff')), '\ufeff');
  assert.equal(decodeUtf8([]), '');
  assert.deepEqual(encodeUtf8(''), new Uint8Array());
});

test('strict UTF-8 round trips every Unicode scalar, in bounded test chunks', () => {
  // Include noncharacters: they remain valid Unicode scalar values / UTF-8.
  for (let begin = 0; begin <= 0x10ffff; begin += 4096) {
    const values = [];
    for (let cp = begin; cp < Math.min(begin + 4096, 0x110000); cp++) {
      if (cp < 0xd800 || cp > 0xdfff) values.push(cp);
    }
    const text = String.fromCodePoint(...values);
    const encoded = nativeEncode(text);
    assert.deepEqual(encodeUtf8(text), encoded);
    assert.equal(decodeUtf8(encoded), text);
  }
});

test('UTF-8 handles GAS signed Byte[] and Int8Array without replacement', () => {
  const bytes = nativeEncode('日本😀\ufeff');
  const signed = Array.from(bytes, byte => byte > 127 ? byte - 256 : byte);
  assert.equal(decodeUtf8(signed), '日本😀\ufeff');
  assert.equal(decodeUtf8(Int8Array.from(signed)), '日本😀\ufeff');
});

test('UTF-8 rejects malformed continuation, overlong, surrogate and out-of-range encodings', () => {
  const invalid = [
    [0x80], [0xbf], [0xc0, 0x80], [0xc1, 0xbf], [0xc2], [0xdf], [0xe0], [0xf0],
    [0xc2, 0x20], [0xc2, 0xc0], [0xe0, 0x9f, 0xbf], [0xe0, 0x80, 0x80],
    [0xe1, 0x80], [0xe1, 0x80, 0x41], [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf],
    [0xf0, 0x8f, 0xbf, 0xbf], [0xf0, 0x80, 0x80, 0x80], [0xf1, 0x80, 0x80],
    [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xff], [0xfe],
    [0xf8, 0x88, 0x80, 0x80, 0x80], [0xfc, 0x84, 0x80, 0x80, 0x80, 0x80],
  ];
  for (const bytes of invalid) {
    assert.throws(() => decodeUtf8(bytes), /INVALID_UTF8/);
    assert.throws(() => decodeUtf8([0x41, ...bytes, 0x42]), /INVALID_UTF8/);
  }
  for (let first = 0; first <= 255; first++) {
    for (let second = 0; second <= 255; second++) {
      const bytes = Uint8Array.of(first, second);
      let expected;
      try { expected = nativeDecode(bytes); }
      catch { assert.throws(() => decodeUtf8(bytes), /INVALID_UTF8/); continue; }
      assert.equal(decodeUtf8(bytes), expected);
    }
  }
});

test('UTF-8 random byte differential against strict platform decoder', () => {
  const bytes = randomBytes(30000);
  for (let at = 0; at < bytes.length - 8; at += 3) {
    const part = bytes.subarray(at, at + 3 + bytes[at] % 6);
    let expected;
    try { expected = nativeDecode(part); }
    catch { assert.throws(() => decodeUtf8(part), /INVALID_UTF8/); continue; }
    assert.equal(decodeUtf8(part), expected);
  }
});

test('UTF-16 encoder rejects all lone surrogate ranges and non-string input', () => {
  for (let unit = 0xd800; unit <= 0xdfff; unit++) {
    const invalid = String.fromCharCode(unit);
    for (const text of [invalid, 'x' + invalid, invalid + 'x']) {
      assert.throws(() => encodeUtf8(text), /INVALID_UTF16/);
    }
  }
  for (const text of ['\ud800\ud800', '\udfff\ud800', '\udfff\udfff']) {
    assert.throws(() => encodeUtf8(text), /INVALID_UTF16/);
  }
  for (const text of [null, undefined, 42, {}, ['x'], new String('x')]) {
    assert.throws(() => encodeUtf8(text), /TEXT_REQUIRED/);
  }
});

test('invalid byte representations reject rather than silently coerce', () => {
  const invalid = [undefined, null, 'abc', 1, {}, {0: 65, length: 1},
    new Uint16Array([65]), new Float64Array([65]), [256], [-129], [1.5], [NaN],
    [Infinity], ['65'], [null], [undefined], [true], new Array(2)];
  for (const bytes of invalid) {
    assert.throws(() => decodeUtf8(bytes), /INVALID_BYTES/);
    const hash = new IncrementalSha256().update([1, 2, 3]);
    const saved = hash.snapshot();
    assert.throws(() => hash.update(bytes), /INVALID_BYTES/);
    assert.deepEqual(hash.snapshot(), saved);
  }
  const hash = new IncrementalSha256().update([1]);
  const saved = hash.snapshot();
  assert.throws(() => hash.update([...Array(100).fill(65), 300]), /INVALID_BYTES/);
  assert.deepEqual(hash.snapshot(), saved);
});

test('known SHA-256 vectors and million-a vector survive JSON restore', () => {
  for (const [text, digest] of vectors) {
    assert.equal(new IncrementalSha256().update(encodeUtf8(text)).digestHex(), digest);
    const bytes = nativeEncode(text);
    for (let split = 0; split <= bytes.length; split++) {
      const hash = restore(new IncrementalSha256().update(bytes.subarray(0, split)));
      assert.equal(hash.update(bytes.subarray(split)).digestHex(), digest);
    }
  }
  let hash = new IncrementalSha256();
  const thousand = nativeEncode('a'.repeat(1000));
  for (let i = 0; i < 1000; i++) hash = restore(hash.update(thousand));
  assert.equal(hash.digestHex(), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('SHA-256 every split at block and padding boundaries matches independent crypto', () => {
  const lengths = [0, 1, 2, 3, 31, 32, 54, 55, 56, 57, 62, 63, 64, 65, 66,
    95, 111, 119, 120, 121, 127, 128, 129, 191, 192, 193, 255, 256, 257];
  for (const length of lengths) {
    const bytes = Uint8Array.from({length}, (_, i) => (i * 79 + 233) & 255);
    const digest = nativeHash(bytes);
    for (let split = 0; split <= bytes.length; split++) {
      const hash = new IncrementalSha256().update(bytes.subarray(0, split));
      const restored = restore(hash);
      assert.equal(restored.update(bytes.subarray(split)).digestHex(), digest);
      assert.equal(hash.digestHex(), nativeHash(bytes.subarray(0, split)));
    }
  }
});

test('SHA-256 independent random vectors and randomized resumable chunk boundaries', () => {
  for (let trial = 0; trial < 50; trial++) {
    const bytes = randomBytes(trial * 377 + (trial % 3));
    let hash = new IncrementalSha256();
    for (let at = 0; at < bytes.length;) {
      const size = 1 + bytes[at] * 3;
      hash = restore(hash.update(bytes.subarray(at, at + size)));
      at += size;
      const s = hash.snapshot();
      assert.equal(s.tail.length, s.totalBytes % 64);
      assert.ok(s.tail.length < 64);
      assert.ok(JSON.stringify(s).length < 512);
    }
    assert.equal(hash.digestHex(), nativeHash(bytes));
    assert.equal(Buffer.from(hash.digestBytes()).toString('hex'), nativeHash(bytes));
  }
});

test('SHA-256 signed GAS byte arrays hash the same raw bytes', () => {
  const bytes = randomBytes(513);
  const signed = Array.from(bytes, byte => byte > 127 ? byte - 256 : byte);
  assert.equal(new IncrementalSha256().update(signed).digestHex(), nativeHash(bytes));
  assert.equal(new IncrementalSha256().update(Int8Array.from(signed)).digestHex(), nativeHash(bytes));
});

test('digest and snapshot are nonmutating; caller cannot mutate saved or restored hash', () => {
  const input = Array.from(nativeEncode('abc'));
  const hash = new IncrementalSha256().update(input);
  input.fill(0);
  const saved = hash.snapshot();
  const before = JSON.parse(JSON.stringify(saved));
  const copy = new IncrementalSha256(saved);
  saved.h.fill(0); saved.tail.fill(0); saved.totalBytes = 0;
  assert.deepEqual(hash.snapshot(), before);
  assert.deepEqual(copy.snapshot(), before);
  for (let i = 0; i < 3; i++) {
    const digest = hash.digestBytes(); digest.fill(0);
    assert.equal(hash.digestHex(), vectors[1][1]);
    assert.deepEqual(hash.snapshot(), before);
  }
  hash.update(nativeEncode('def'));
  assert.equal(hash.digestHex(), nativeHash(Buffer.from('abcdef')));
  assert.equal(copy.digestHex(), vectors[1][1]);
});

test('SHA-256 restore rejects malformed or incompatible state', () => {
  const valid = new IncrementalSha256().update([1, 2, 3]).snapshot();
  const invalid = [null, false, 1, 'state', [], {},
    {...valid, version: 'sha256-v2'}, {...valid, extra: []},
    {...valid, totalBytes: -1}, {...valid, totalBytes: 3.5},
    {...valid, totalBytes: Infinity}, {...valid, totalBytes: NaN},
    {...valid, totalBytes: Number.MAX_SAFE_INTEGER + 1}, {...valid, totalBytes: '3'},
    {...valid, h: []}, {...valid, h: new Uint32Array(valid.h)},
    {...valid, h: Array(8).fill(-1)}, {...valid, h: Array(8).fill(0xffffffff + 1)},
    {...valid, h: Array(8).fill(0)}, {...valid, h: [NaN, ...valid.h.slice(1)]},
    {...valid, h: [1.5, ...valid.h.slice(1)]}, {...valid, h: new Array(8)},
    {...valid, tail: new Uint8Array([1, 2, 3])}, {...valid, tail: [1, 2]},
    {...valid, tail: [1, 2, 256]}, {...valid, tail: [1, 2, -1]},
    {...valid, tail: [1, 2, 1.5]}, {...valid, tail: new Array(3)},
    {...valid, tail: Array(64).fill(0), totalBytes: 64},
  ];
  for (const state of invalid) assert.throws(() => new IncrementalSha256(state), /INVALID_SHA256_STATE/);
  for (const key of Object.keys(valid)) {
    const state = {...valid}; delete state[key];
    assert.throws(() => new IncrementalSha256(state), /INVALID_SHA256_STATE/);
  }
});

test('safe length counters cross 32-bit bit/byte boundaries and fail before overflow', () => {
  const initial = new IncrementalSha256().snapshot();
  for (const total of [2 ** 29 - 1, 2 ** 32 - 1, 2 ** 32, 2 ** 52, Number.MAX_SAFE_INTEGER - 1]) {
    const state = {...initial, totalBytes: total, tail: Array(total % 64).fill(0xa5)};
    const hash = new IncrementalSha256(state).update([1]);
    assert.equal(hash.snapshot().totalBytes, total + 1);
    assert.equal(hash.snapshot().tail.length, (total + 1) % 64);
    assert.deepEqual(restore(hash).snapshot(), hash.snapshot());
  }
  const total = Number.MAX_SAFE_INTEGER;
  const hash = new IncrementalSha256({...initial, totalBytes: total, tail: Array(total % 64).fill(0)});
  const saved = hash.snapshot();
  assert.throws(() => hash.update([0]), /SHA256_LENGTH_OVERFLOW/);
  assert.deepEqual(hash.snapshot(), saved);
  hash.update([]);
  assert.deepEqual(hash.snapshot(), saved);
});

test('final bit length is encoded exactly at high counters without unsafe multiplication', () => {
  // Synthetic states test length serialization, not a claim that huge data was
  // streamed. BigInt here is an independent test oracle, never implementation.
  const original = IncrementalSha256.prototype._compress;
  const captured = [];
  IncrementalSha256.prototype._compress = function (bytes, offset) {
    captured.push(Array.from(bytes.slice(offset, offset + 64)));
    return original.call(this, bytes, offset);
  };
  try {
    for (const total of [0, 55, 56, 63, 64, 2 ** 29 - 1, 2 ** 29, 2 ** 32 - 1, 2 ** 32, 2 ** 52 + 7, Number.MAX_SAFE_INTEGER]) {
      captured.length = 0;
      const initial = new IncrementalSha256().snapshot();
      const hash = new IncrementalSha256({...initial, totalBytes: total, tail: Array(total % 64).fill(0xa5)});
      hash.digestBytes();
      const last = captured.at(-1).slice(-8);
      let encoded = 0n;
      for (const byte of last) encoded = (encoded << 8n) | BigInt(byte);
      assert.equal(encoded, BigInt(total) * 8n);
      assert.equal(captured.length, total % 64 < 56 ? 1 : 2);
      assert.equal(captured.flat()[total % 64], 0x80);
    }
  } finally { IncrementalSha256.prototype._compress = original; }
});

test('bounded residual state survives multi-megabyte stream and thousands of restores', () => {
  const chunk = randomBytes(4093);
  const expected = createHash('sha256');
  let hash = new IncrementalSha256();
  let maxState = 0;
  for (let i = 0; i < 1500; i++) {
    expected.update(chunk);
    hash = restore(hash.update(chunk));
    const state = hash.snapshot();
    assert.ok(state.tail.length < 64);
    assert.equal(hash._w.length, 64);
    maxState = Math.max(maxState, JSON.stringify(state).length);
  }
  assert.equal(hash.snapshot().totalBytes, 4093 * 1500);
  assert.ok(maxState < 512);
  assert.equal(hash.digestHex(), expected.digest('hex'));
});

test('portable codec works with no Node or web codec globals and integrates at every CSV byte split', () => {
  const source = readFileSync(new URL('./codec.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
  const isolated = vm.createContext({});
  vm.runInContext(source + '\nthis.codec = {decodeUtf8, encodeUtf8, IncrementalSha256};', isolated);
  assert.equal(vm.runInContext('typeof Buffer + "," + typeof TextDecoder + "," + typeof TextEncoder + "," + typeof Utilities', isolated),
    'undefined,undefined,undefined,undefined');
  assert.equal(vm.runInContext('new IncrementalSha256().update(encodeUtf8("abc")).digestHex()', isolated), vectors[1][1]);
  assert.equal(vm.runInContext('decodeUtf8(encodeUtf8("日本😀"))', isolated), '日本😀');
  const bytes = encodeUtf8('\ufeff"日本😀",b\r\n"quoted\nrow","x""y"\r\n');
  for (let split = 0; split <= bytes.length; split++) {
    const rows = [];
    const parser = new CsvBytes({decode: decodeUtf8});
    parser.feed(bytes.subarray(0, split), row => rows.push(row));
    const resumed = new CsvBytes({decode: decodeUtf8, state: JSON.parse(JSON.stringify(parser.snapshot()))});
    resumed.feed(bytes.subarray(split), row => rows.push(row), true);
    assert.deepEqual(rows, [['日本😀', 'b'], ['quoted\nrow', 'x"y']]);
  }
});
