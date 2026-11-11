import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { md5Update, md5Finish } from '../processing/running/md5.js';

test('portable MD5 matches independent native digest across byte and padding boundaries, after cold restarts', () => {
  const vectors = ['', 'a', 'abc', 'message digest', 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', '1234567890'.repeat(8), 'a'.repeat(1000000), '日本語のCSV\r\n'];
  const buffers = [...vectors.map(s => Buffer.from(s)), ...[1, 55, 56, 63, 64, 65, 127, 128, 129, 1048633].map(n => randomBytes(n))];
  for (const bytes of buffers) for (const chunk of [63, 65536, 1048576]) {
    let state;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      state = md5Update(state, Array.from(bytes.subarray(offset, offset + chunk), b => b > 127 ? b - 256 : b));
      state = JSON.parse(JSON.stringify(state));
    }
    const before = JSON.stringify(state);
    assert.equal(md5Finish(state), createHash('md5').update(bytes).digest('hex'));
    assert.equal(JSON.stringify(state), before);
  }
});

test('MD5 rejects an inconsistent restored offset', () => {
  assert.throws(() => md5Update({ h: [0, 0, 0, 0], length: 65, tail: [] }, []), /DIGEST_STATE_INVALID/);
});
