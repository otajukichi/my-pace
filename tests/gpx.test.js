import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseGPX, parseGpx, haversineKm, routePath } from '../src/lib/gpx.js';

const point = (lat, lon, time = '') => `<trkpt lat="${lat}" lon="${lon}">${time ? `<time>${time}</time>` : ''}</trkpt>`;
const segment = (points) => `<trkseg>${points}</trkseg>`;
const gpx = (segments) => `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk>${segments}</trk></gpx>`;

test('GPX computes great-circle distance and timestamp duration', () => {
  const result = parseGPX(gpx(segment(point(0, 0, '2026-10-05T00:00:00Z') + point(0, 0.01, '2026-10-05T00:10:00Z'))));
  assert.ok(Math.abs(result.distanceKm - 1.11195) < 0.0001);
  assert.equal(result.durationSec, 600);
  assert.equal(result.points.length, 2);
  assert.deepEqual(result.warnings, []);
  assert.equal(parseGpx, parseGPX);
});
test('distance and duration never bridge separate track segments or tracks', () => {
  const xml = gpx(segment(point(0, 0, '2026-10-05T00:00:00Z') + point(0, 0.01, '2026-10-05T00:10:00Z')) +
    segment(point(50, 100, '2026-10-05T01:00:00Z') + point(50, 100.01, '2026-10-05T01:10:00Z')));
  const result = parseGPX(xml);
  assert.ok(result.distanceKm > 1.8 && result.distanceKm < 1.9);
  assert.equal(result.durationSec, 1200);
  assert.notEqual(result.points[1].segment, result.points[2].segment);
  assert.equal((routePath(result.points).match(/M/g) ?? []).length, 2);
  const tracks = parseGPX('<gpx><trk>' + segment(point(0, 0)) + '</trk><trk>' + segment(point(10, 10)) + '</trk></gpx>');
  assert.equal(tracks.distanceKm, 0);
});
test('namespace-prefixed GPX, route points, CDATA, comments, quoted attributes work', () => {
  const xml = `<?xml version='1.0'?><g:gpx xmlns:g='http://www.topografix.com/GPX/1/1' creator="A &amp; B > C"><!-- hello --><g:rte><g:rtept lon='139' lat='35'><g:time><![CDATA[2026-10-05T06:00:00+09:00]]></g:time></g:rtept><g:rtept lat='35.01' lon='139'><g:time>2026-10-05T06:10:00+09:00</g:time></g:rtept></g:rte></g:gpx>`;
  const result = parseGPX(xml);
  assert.equal(result.durationSec, 600);
  assert.equal(result.points[0].time, '2026-10-04T21:00:00.000Z');
  assert.ok(result.distanceKm > 1);
});
test('GPX date uses local day rather than timestamp substring or UTC day', () => {
  const moduleUrl = new URL('../src/lib/gpx.js', import.meta.url).href;
  const xml = gpx(segment(point(35, 139, '2026-10-04T22:30:00Z') + point(35.01, 139, '2026-10-04T22:40:00Z')));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {parseGPX} from ${JSON.stringify(moduleUrl)}; console.log(parseGPX(${JSON.stringify(xml)}).date)`], { env: { ...process.env, TZ: 'Asia/Tokyo' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '2026-10-05');
});
test('no timestamps produces explicit missing date and duration with warning', () => {
  const result = parseGPX(gpx(segment(point(35, 139) + point(35.01, 139))));
  assert.equal(result.date, null);
  assert.equal(result.durationSec, 0);
  assert.ok(result.warnings.some((warning) => warning.includes('時刻がない')));
});
test('invalid coordinates are removed without joining across their gap', () => {
  const result = parseGPX(gpx(segment(point(0, 0) + point('oops', 1) + point(0, 100))));
  assert.equal(result.points.length, 2);
  assert.equal(result.distanceKm, 0);
  assert.notEqual(result.points[0].segment, result.points[1].segment);
  assert.ok(result.warnings.some((warning) => warning.includes('不正な座標')));
  for (const coords of [[91,0], [0,181], ['',0], ['Infinity',0]]) assert.throws(() => parseGPX(gpx(segment(point(...coords)))));
});
test('invalid, timezone-less, and reversed timestamps are not used silently', () => {
  const invalid = parseGPX(gpx(segment(point(0, 0, '2026-02-30T10:00:00Z') + point(0, 1, '2026-10-05T06:00:00'))));
  assert.equal(invalid.durationSec, 0);
  assert.equal(invalid.date, null);
  assert.ok(invalid.warnings.some((warning) => warning.includes('不正な時刻')));
  const reversed = parseGPX(gpx(segment(point(0, 0, '2026-10-05T01:00:00Z') + point(0, 0.01, '2026-10-05T00:00:00Z'))));
  assert.equal(reversed.durationSec, 0);
  assert.ok(reversed.warnings.some((warning) => warning.includes('逆順')));
});
test('DTD and entity definitions are blocked, no external access is possible', () => {
  for (const prefix of ['<!DOCTYPE gpx SYSTEM "https://example.com/evil.dtd">', '<!DOCTYPE gpx [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>']) assert.throws(() => parseGPX(prefix + gpx(segment(point(0, 0)))), /DTD/);
  assert.throws(() => parseGPX('<gpx><name>&unknown;</name><trk>' + segment(point(0,0)) + '</trk></gpx>'));
  assert.throws(() => parseGPX('<gpx><name>&#0;</name><trk>' + segment(point(0,0)) + '</trk></gpx>'));
});
test('malformed XML and wrong root are rejected completely', () => {
  for (const xml of ['<gpx><trk></gpx>', '<gpx><trk>', '<html></html>', '<gpx/><gpx/>', '<gpx><trkpt lat="0" lat="1"/></gpx>', '<gpx><name>x & y</name></gpx>', '<gpx><!-- unclosed</gpx>', '<gpx><![CDATA[unclosed</gpx>', '<gpx x=3></gpx>', '<gpx><name>bad]]></name></gpx>']) assert.throws(() => parseGPX(xml), undefined, xml);
});
test('point, nesting and file size limits are bounded', () => {
  assert.throws(() => parseGPX('x'.repeat(12 * 1024 * 1024 + 1)), /12MiB/);
  assert.throws(() => parseGPX(gpx(segment(point(0, 0).repeat(20001)))), /20,000/);
  assert.throws(() => parseGPX('<gpx>' + '<x>'.repeat(102) + '</x>'.repeat(102) + '</gpx>'), /入れ子/);
});
test('route path handles stationary, antimeridian, and empty tracks without NaN', () => {
  assert.equal(routePath([]), '');
  assert.equal(routePath([{lat:0,lon:0,segment:0}]), 'M300.00,120.00');
  const path = routePath([{lat:0,lon:179.9,segment:0},{lat:0,lon:-179.9,segment:0}]);
  assert.equal(path, 'M16.00,120.00 L584.00,120.00');
  assert.equal(path.includes('NaN'), false);
  assert.throws(() => routePath([{lat:0,lon:0}], 10, 10, 16));
  assert.ok(haversineKm({lat:0,lon:179.9},{lat:0,lon:-179.9}) < 23);
});
