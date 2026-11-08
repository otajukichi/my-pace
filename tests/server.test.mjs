import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePublicPath, listPublicFiles } from '../scripts/serve.mjs';
import { build } from '../scripts/build.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'my-pace-server-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'index.html': '<!doctype html><title>MyPace</title>', 'app.js': 'export const app = true;',
    'styles.css': 'body { color: #123; }', 'lib/state.js': 'export const state = {};',
    'lib/map.css': '.route { display: block; }',
    'assets/mark.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'assets/vendor/leaflet.js': '// local vendor', 'assets/vendor/LICENSE.txt': 'Vendor license',
    'data/running.json': '{"days":[]}', '.env': 'SECRET=private',
    '.git/config': 'private git configuration', '旧my-pace/index.html': 'old app',
    '旧my-pace/gas/secret.js': 'private integration settings', 'docs/design.md': 'private notes',
    'tests/private.test.mjs': 'test source', 'data/other.json': 'private data',
    'assets/private.json': 'private metadata', 'assets/.env': 'private secret',
    'assets/docs/private.svg': '<svg/>', 'lib/tests/private.js': 'test fixture',
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents);
  }
  return root;
}

test('only the new app public routes resolve, with query strings and correct MIME', async t => {
  const root = await fixture(t);
  for (const [route, relativePath, mimeType] of [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js?v=1', 'app.js', 'text/javascript; charset=utf-8'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
    ['/lib/state.js', 'lib/state.js', 'text/javascript; charset=utf-8'],
    ['/lib/map.css', 'lib/map.css', 'text/css; charset=utf-8'],
    ['/assets/mark.svg', 'assets/mark.svg', 'image/svg+xml'],
    ['/assets/vendor/LICENSE.txt', 'assets/vendor/LICENSE.txt', 'text/plain; charset=utf-8'],
    ['/data/running.json', 'data/running.json', 'application/json; charset=utf-8'],
  ]) {
    const file = await resolvePublicPath(route, { root });
    assert.equal(file.relativePath, relativePath);
    assert.equal(file.mimeType, mimeType);
    assert.ok(file.size > 0);
  }
});

test('archive, configuration, other data, tests and docs stay unservable even when present', async t => {
  const root = await fixture(t);
  for (const route of [
    '/.env', '/.git/config', '/旧my-pace/index.html', '/旧my-pace/gas/secret.js',
    '/docs/design.md', '/tests/private.test.mjs', '/scripts/serve.mjs', '/package.json',
    '/data/other.json', '/assets/private.json', '/assets/.env', '/assets/docs/private.svg',
    '/lib/tests/private.js', '/assets/', '/assets/vendor', '/lib', '/data', '/missing.html',
    '/dist/index.html', '/README-LOCAL.txt',
  ]) assert.equal(await resolvePublicPath(route, { root }), null, route);
});

test('raw, encoded and double-encoded traversal is rejected before path normalization', async t => {
  const root = await fixture(t);
  for (const route of [
    '/../index.html', '/assets/../index.html', '/assets/./mark.svg', '/assets//mark.svg',
    '/%2e%2e/index.html', '/assets/%2e%2e/index.html', '/%252e%252e/index.html',
    '/assets%2fmark.svg', '/assets%5cmark.svg', '/assets\\mark.svg',
    '/index.html%00', '/index.html\n', '/%ZZ', '/index.html#fragment',
    '//index.html', 'https://localhost/index.html', 'index.html', '/'.repeat(4097),
  ]) assert.equal(await resolvePublicPath(route, { root }), null, route);
});

test('symlinked files and directories cannot expose private files or bypass public roots', async t => {
  const root = await fixture(t);
  await symlink(join(root, '.env'), join(root, 'assets', 'secret.js'));
  await symlink(join(root, '旧my-pace', 'gas'), join(root, 'assets', 'integration'));
  await symlink(join(root, 'assets', 'mark.svg'), join(root, 'assets', 'alias.svg'));
  for (const route of ['/assets/secret.js', '/assets/integration/secret.js', '/assets/alias.svg']) {
    assert.equal(await resolvePublicPath(route, { root }), null);
  }
  const listed = (await listPublicFiles({ root })).map(file => file.relativePath);
  assert.ok(!listed.some(path => /secret|integration|alias|private/.test(path)));
});

test('build copies actual public data and notice, excluding archived/private/source-only files', async t => {
  const root = await fixture(t);
  await symlink(join(root, '.env'), join(root, 'assets', 'secret.js'));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'obsolete.js'), 'remove old output');
  const result = await build({ root });
  assert.equal(result.output, join(root, 'dist'));
  assert.deepEqual(result.files, [
    'app.js', 'assets/mark.svg', 'assets/vendor/LICENSE.txt', 'assets/vendor/leaflet.js',
    'data/running.json', 'index.html', 'lib/map.css', 'lib/state.js', 'styles.css',
  ]);
  assert.equal(await readFile(join(root, 'dist/data/running.json'), 'utf8'), '{"days":[]}');
  const notice = await readFile(join(root, 'dist/README-LOCAL.txt'), 'utf8');
  assert.match(notice, /Do not publish/);
  assert.match(notice, /GPS/);
  assert.equal((await readdir(join(root, 'dist'))).includes('obsolete.js'), false);
  assert.equal((await readdir(root)).some(name => name.startsWith('.my-pace-build-')), false);
});

test('an incomplete source never destroys an existing build', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/index.html'), 'existing valid build');
  await rm(join(root, 'index.html'));
  await assert.rejects(build({ root }), /Build requires: index\.html/);
  assert.equal(await readFile(join(root, 'dist/index.html'), 'utf8'), 'existing valid build');
});

test('a source checkout without private GPS builds empty records without creating source data', async t => {
  const root = await fixture(t);
  await rm(join(root, 'data/running.json'));
  const result = await build({ root });
  assert.equal(result.privateData, false);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'dist/data/running.json'), 'utf8')), { days: [] });
  await assert.rejects(readFile(join(root, 'data/running.json')), { code: 'ENOENT' });
});

test('the public build excludes private GPS even when it exists locally and in a previous build', async t => {
  const root = await fixture(t);
  const privateRecord = JSON.stringify({ days: [{ id: 'private-fixture', segments: [{ points: [[35.681236, 139.767125]] }] }] });
  await writeFile(join(root, 'data/running.json'), privateRecord);
  await build({ root });
  const result = await build({ root, publicBuild: true });
  assert.equal(result.privateData, false);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'dist/data/running.json'), 'utf8')), { days: [] });
  assert.equal(await readFile(join(root, 'data/running.json'), 'utf8'), privateRecord);
  await assert.rejects(readFile(join(root, 'dist/README-LOCAL.txt')), { code: 'ENOENT' });
});

test('build refuses a symlink output directory without altering its destination', async t => {
  const root = await fixture(t);
  await symlink(join(root, '旧my-pace'), join(root, 'dist'));
  await assert.rejects(build({ root }), /dist must be a regular directory/);
  assert.equal(await readFile(join(root, '旧my-pace/index.html'), 'utf8'), 'old app');
});
