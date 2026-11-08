import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/weather-area.js';

function request(method, body) {
  const result = {};
  handler({ method, body }, {
    setHeader() {},
    writeHead(status, headers) { Object.assign(result, { status, headers }); },
    end(text) { result.body = JSON.parse(text); },
  });
  return result;
}

test('hosted weather stays on the public area and never selects a private location', () => {
  const initial = request('GET');
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.center, { lat: 35.7, lon: 139.8 });
  assert.equal(request('POST', { useRecordedLocation: true }).status, 503);
  assert.deepEqual(request('GET').body, initial.body);
  assert.deepEqual(request('POST', '{"useRecordedLocation":false}').body, initial.body);
  for (const body of [null, [], {}, 'broken', { useRecordedLocation: 'true' }, { useRecordedLocation: false, extra: 1 }]) {
    assert.equal(request('POST', body).status, 400);
  }
  assert.equal(request('DELETE').status, 405);
});
