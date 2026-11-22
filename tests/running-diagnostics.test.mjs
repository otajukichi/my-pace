import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('../processing/running/gas/production-diagnostics.gs', import.meta.url), 'utf8');
function diagnose(error, step = 'trigger_check') {
  const context = vm.createContext({ error, pr: { step }, MYPACE_BUILD_ID: 'gas-test-build' });
  new vm.Script(code).runInContext(context);
  return JSON.parse(JSON.stringify(new vm.Script('prFailure(error, prErrorCode(error))').runInContext(context)));
}

test('native errors retain categories and code locations, never provider text or private data', () => {
  const cases = [
    [Error('Service using too much computer time for one day.'), 'GOOGLE_DAILY_RUNTIME_LIMIT'],
    [Error('Exceeded maximum execution time'), 'GOOGLE_EXECUTION_TIME_LIMIT'],
    [Error('Service invoked too many times for one day: properties.'), 'GOOGLE_SERVICE_LIMIT'],
    [Error("We're sorry, a server error occurred. Please try again."), 'GOOGLE_SERVICE_ERROR'],
    [new TypeError('Cannot read properties of undefined'), 'JAVASCRIPT_TYPE_ERROR'],
    [new SyntaxError('Unexpected token in JSON'), 'JAVASCRIPT_SYNTAX_ERROR'],
  ];
  for (const [error, reason] of cases) {
    error.message += ' private@example.com latitude:33.123 secret-file-id';
    error.stack = `${error.message}\n at prSchedule (private-code.gs:123:8)\n at prRun (secret-path:456)\n at secretFilename (hidden:789:2)`;
    error.driveReasons = ['rateLimitExceeded', 'https://private.example/secret'];
    const result = diagnose(error);
    assert.equal(result.code, 'UNEXPECTED_ERROR');
    assert.equal(result.diagnostic.reason, reason);
    assert.equal(result.diagnostic.step, 'trigger_check');
    assert.deepEqual(result.diagnostic.frames, [{ function: 'prSchedule', line: 123 }, { function: 'prRun', line: 456 }]);
    assert.deepEqual(result.driveReasons, ['rateLimitExceeded']);
    assert(!/secret|private|latitude|hidden|https|undefined/.test(JSON.stringify(result)));
    assert.equal(Object.hasOwn(result, 'message'), false);
  }
});

test('known guard codes keep their identity; unknown and primitive throws remain bounded diagnostics', () => {
  const guard = diagnose(Error('FOLDER_LOCATION_CHANGED'), 'folder_check');
  assert.equal(guard.code, 'FOLDER_LOCATION_CHANGED');
  assert.equal(guard.diagnostic.reason, 'APPLICATION_CODE');
  for (const error of [null, 'private error text', { message: 'a'.repeat(10000), name: 'secret-name', stack: 'private-id' }]) {
    const result = diagnose(error, 'private-id');
    assert.equal(result.code, 'UNEXPECTED_ERROR');
    assert.equal(result.diagnostic.type, 'Unknown');
    assert.equal(result.diagnostic.step, 'initializing');
    assert.deepEqual(result.diagnostic.frames, []);
    assert(JSON.stringify(result).length < 500);
  }
});
