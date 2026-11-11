// Serializable incremental MD5 for Drive's binary-file checksum. This is an
// integrity check against Drive metadata, not a signature or password hash.
const SHIFT = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const TABLE = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0);
function block(h, input, offset) {
  const x = new Int32Array(16);
  for (let i = 0; i < 64; i++) x[i >>> 2] |= (input[offset + i] & 255) << ((i & 3) * 8);
  let [a, b, c, d] = h;
  for (let i = 0; i < 64; i++) {
    const group = i >>> 4;
    const f = group === 0 ? (b & c) | (~b & d) : group === 1 ? (d & b) | (~d & c) : group === 2 ? b ^ c ^ d : c ^ (b | ~d);
    const g = group === 0 ? i : group === 1 ? (5 * i + 1) & 15 : group === 2 ? (3 * i + 5) & 15 : (7 * i) & 15;
    const n = (a + f + TABLE[i] + x[g]) | 0, shift = SHIFT[group * 4 + (i & 3)];
    a = d; d = c; c = b; b = (b + ((n << shift) | (n >>> (32 - shift)))) | 0;
  }
  h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
}
export function md5Update(previous, bytes) {
  const state = previous ? { h: [...previous.h], tail: [...previous.tail], length: previous.length } : { h: [1732584193, -271733879, -1732584194, 271733878], tail: [], length: 0 };
  if (!Number.isSafeInteger(state.length) || state.length < 0 || state.h.length !== 4 || state.tail.length !== state.length % 64) throw Error('DIGEST_STATE_INVALID');
  state.length += bytes.length;
  let offset = 0;
  if (state.tail.length) {
    const take = Math.min(64 - state.tail.length, bytes.length);
    for (; offset < take; offset++) state.tail.push(bytes[offset] & 255);
    if (state.tail.length === 64) { block(state.h, state.tail, 0); state.tail = []; }
  }
  for (; offset + 64 <= bytes.length; offset += 64) block(state.h, bytes, offset);
  for (; offset < bytes.length; offset++) state.tail.push(bytes[offset] & 255);
  return state;
}
export function md5Finish(state) {
  state = state || md5Update(null, []);
  const padding = [128];
  while ((state.length + padding.length) % 64 !== 56) padding.push(0);
  const low = (state.length * 8) >>> 0, high = Math.floor(state.length / 536870912);
  for (const value of [low, high]) for (let i = 0; i < 4; i++) padding.push((value >>> (i * 8)) & 255);
  const h = md5Update(state, padding).h;
  return h.map(value => [0, 8, 16, 24].map(shift => ((value >>> shift) & 255).toString(16).padStart(2, '0')).join('')).join('');
}
