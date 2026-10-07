/**
 * Portable Apps Script V8 primitives; no Node, TextDecoder, TextEncoder, Blob,
 * Utilities, Web Crypto, I/O, or dependencies. Remove ES-module `export` when
 * bundling for GAS. UTF functions operate on one bounded field/output batch;
 * SHA-256 never accumulates the complete input.
 *
 * UTF-8 validity: RFC 3629, sections 3-4 (surrogates and non-shortest encodings
 * are rejected): https://www.rfc-editor.org/rfc/rfc3629.html#section-4
 * SHA-256: NIST FIPS 180-4, sections 5 and 6.2:
 * https://doi.org/10.6028/NIST.FIPS.180-4
 *
 * Byte inputs are Uint8Array, Int8Array, or ordinary integer arrays. Signed
 * GAS Byte[] values -128..-1 are normalized to 128..255. Other values fail.
 */

const SHA256_VERSION = 'sha256-v1';
const SHA256_IV = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function checkBytes(bytes) {
  if (bytes instanceof Uint8Array || bytes instanceof Int8Array) return;
  if (!Array.isArray(bytes)) throw Error('INVALID_BYTES');
  for (let i = 0; i < bytes.length; i++) {
    if (!Number.isInteger(bytes[i]) || bytes[i] < -128 || bytes[i] > 255) {
      throw Error('INVALID_BYTES');
    }
  }
}

/** Decode exactly one complete UTF-8 value; preserve U+FEFF, including a BOM. */
export function decodeUtf8(bytes) {
  checkBytes(bytes);
  const parts = [];
  let part = '';
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++] & 255;
    let scalar, extra, minimum;
    if (first < 0x80) { scalar = first; extra = 0; minimum = 0; }
    else if (first >= 0xc2 && first <= 0xdf) { scalar = first & 0x1f; extra = 1; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { scalar = first & 0x0f; extra = 2; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { scalar = first & 0x07; extra = 3; minimum = 0x10000; }
    else throw Error('INVALID_UTF8');
    if (i + extra > bytes.length) throw Error('INVALID_UTF8');
    for (let j = 0; j < extra; j++) {
      const next = bytes[i++] & 255;
      if ((next & 0xc0) !== 0x80) throw Error('INVALID_UTF8');
      scalar = scalar * 64 + (next & 0x3f);
    }
    if (scalar < minimum || scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) {
      throw Error('INVALID_UTF8');
    }
    if (scalar < 0x10000) part += String.fromCharCode(scalar);
    else {
      const pair = scalar - 0x10000;
      part += String.fromCharCode(0xd800 + (pair >>> 10), 0xdc00 + (pair & 0x3ff));
    }
    // No unbounded argument spread / apply, even on a large permitted field.
    if (part.length >= 4096) { parts.push(part); part = ''; }
  }
  parts.push(part);
  return parts.join('');
}

/** Encode Unicode scalar values; reject lone UTF-16 surrogates, never replace. */
export function encodeUtf8(text) {
  if (typeof text !== 'string') throw Error('TEXT_REQUIRED');
  let size = 0;
  // Validate before allocating or emitting any output.
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) size++;
    else if (unit < 0x800) size += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw Error('INVALID_UTF16');
      size += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw Error('INVALID_UTF16');
    else size += 3;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    let scalar = text.charCodeAt(i);
    if (scalar < 0x80) out[at++] = scalar;
    else if (scalar < 0x800) {
      out[at++] = 0xc0 | (scalar >>> 6);
      out[at++] = 0x80 | (scalar & 0x3f);
    } else if (scalar >= 0xd800 && scalar <= 0xdbff) {
      scalar = 0x10000 + (scalar - 0xd800) * 0x400 + text.charCodeAt(++i) - 0xdc00;
      out[at++] = 0xf0 | (scalar >>> 18);
      out[at++] = 0x80 | ((scalar >>> 12) & 0x3f);
      out[at++] = 0x80 | ((scalar >>> 6) & 0x3f);
      out[at++] = 0x80 | (scalar & 0x3f);
    } else {
      out[at++] = 0xe0 | (scalar >>> 12);
      out[at++] = 0x80 | ((scalar >>> 6) & 0x3f);
      out[at++] = 0x80 | (scalar & 0x3f);
    }
  }
  return out;
}

function checkedHashState(state) {
  const fail = () => { throw Error('INVALID_SHA256_STATE'); };
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail();
  const keys = Object.keys(state).sort();
  if (keys.join(',') !== 'h,tail,totalBytes,version' || state.version !== SHA256_VERSION) fail();
  if (!Number.isSafeInteger(state.totalBytes) || state.totalBytes < 0) fail();
  if (!Array.isArray(state.h) || state.h.length !== 8) fail();
  for (let i = 0; i < 8; i++) {
    if (!Number.isInteger(state.h[i]) || state.h[i] < 0 || state.h[i] > 0xffffffff) fail();
  }
  if (!Array.isArray(state.tail) || state.tail.length >= 64 || state.tail.length !== state.totalBytes % 64) fail();
  for (let i = 0; i < state.tail.length; i++) {
    if (!Number.isInteger(state.tail[i]) || state.tail[i] < 0 || state.tail[i] > 255) fail();
  }
  if (state.totalBytes < 64 && state.h.some((word, i) => word !== SHA256_IV[i])) fail();
  return {h: state.h.slice(), tail: state.tail.slice(), totalBytes: state.totalBytes};
}

function rotr(word, count) { return (word >>> count) | (word << (32 - count)); }

/**
 * Serializable incremental SHA-256. update() retains at most 63 input bytes;
 * snapshots have exactly four fields and are <512 ASCII JSON bytes. The live
 * compression scratchpad is 64 words and is never serialized.
 *
 * totalBytes is capped at 2^53-1; this is lower than SHA-256's standard limit,
 * but keeps every byte offset exact using GAS Number arithmetic. Length bits
 * are split without computing totalBytes * 8 as an unsafe JS integer.
 *
 * A valid-shaped saved state does not prove its authenticity or source
 * provenance. Persist it through the same integrity-protected checkpoint
 * protocol as the parser/source identity. Never resume untrusted state.
 * digestBytes()/digestHex() finalize a copy; update() can continue afterwards.
 */
export class IncrementalSha256 {
  constructor(state) {
    const saved = state === undefined
      ? {h: SHA256_IV.slice(), tail: [], totalBytes: 0}
      : checkedHashState(state);
    this._h = saved.h;
    this._tail = saved.tail;
    this._totalBytes = saved.totalBytes;
    this._w = new Uint32Array(64);
  }

  snapshot() {
    return {version: SHA256_VERSION, h: this._h.slice(), tail: this._tail.slice(), totalBytes: this._totalBytes};
  }

  update(bytes) {
    // Invalid input and overflow leave state unchanged.
    checkBytes(bytes);
    if (bytes.length > Number.MAX_SAFE_INTEGER - this._totalBytes) throw Error('SHA256_LENGTH_OVERFLOW');
    let at = 0;
    if (this._tail.length) {
      while (this._tail.length < 64 && at < bytes.length) this._tail.push(bytes[at++] & 255);
      if (this._tail.length === 64) { this._compress(this._tail, 0); this._tail.length = 0; }
    }
    while (at + 64 <= bytes.length) { this._compress(bytes, at); at += 64; }
    while (at < bytes.length) this._tail.push(bytes[at++] & 255);
    this._totalBytes += bytes.length;
    return this;
  }

  _compress(bytes, offset) {
    const w = this._w;
    for (let i = 0; i < 16; i++, offset += 4) {
      w[i] = ((bytes[offset] & 255) << 24) | ((bytes[offset + 1] & 255) << 16)
        | ((bytes[offset + 2] & 255) << 8) | (bytes[offset + 3] & 255);
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this._h;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + sum1 + choose + SHA256_K[i] + w[i]) >>> 0;
      const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const mixed = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) this._h[i] = (this._h[i] + mixed[i]) >>> 0;
  }

  digestBytes() {
    const copy = new IncrementalSha256(this.snapshot());
    const paddingSize = copy._tail.length < 56 ? 64 : 128;
    const finalBlocks = new Uint8Array(paddingSize);
    finalBlocks.set(copy._tail);
    finalBlocks[copy._tail.length] = 0x80;
    const bitHigh = Math.floor(copy._totalBytes / 0x20000000);
    const bitLow = (copy._totalBytes % 0x20000000) * 8;
    for (let i = 0; i < 4; i++) {
      finalBlocks[paddingSize - 8 + i] = (bitHigh >>> (24 - 8 * i)) & 255;
      finalBlocks[paddingSize - 4 + i] = (bitLow >>> (24 - 8 * i)) & 255;
    }
    for (let at = 0; at < paddingSize; at += 64) copy._compress(finalBlocks, at);
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 4; j++) out[i * 4 + j] = (copy._h[i] >>> (24 - 8 * j)) & 255;
    }
    return out;
  }

  digestHex() {
    let hex = '';
    for (const byte of this.digestBytes()) hex += ('0' + byte.toString(16)).slice(-2);
    return hex;
  }
}
