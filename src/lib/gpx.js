import { LIMITS, isDateKey, localDateKey } from './domain.js';

const MAX_XML_CHARS = 12 * 1024 * 1024;
const EARTH_RADIUS_KM = 6371.0088;
const radians = (degrees) => degrees * Math.PI / 180;
const xmlError = () => { throw new Error('GPXのXML形式が正しくありません。'); };
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/;
const localName = (name) => name.split(':').at(-1);

/** Great-circle distance; longitude differences wrap naturally at the antimeridian. */
export function haversineKm(a, b) {
  const dLat = radians(b.lat - a.lat), dLon = radians(b.lon - a.lon);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(Math.max(0, value)), Math.sqrt(Math.max(0, 1 - value)));
}

function decodeXml(text) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(text)) xmlError();
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ||
        (code < 0x20 && ![9, 10, 13].includes(code)) || code === 0xfffe || code === 0xffff) xmlError();
    return String.fromCodePoint(code);
  });
}
function parseAttributes(source) {
  const attributes = Object.create(null);
  let rest = source;
  while (rest.length) {
    const whitespace = /^\s+/.exec(rest);
    if (!whitespace) xmlError();
    rest = rest.slice(whitespace[0].length);
    if (!rest.length) break;
    const match = NAME.exec(rest);
    if (!match) xmlError();
    const name = match[0];
    rest = rest.slice(name.length);
    const equals = /^\s*=\s*/.exec(rest);
    if (!equals) xmlError();
    rest = rest.slice(equals[0].length);
    const quote = rest[0];
    if (quote !== '"' && quote !== "'") xmlError();
    const end = rest.indexOf(quote, 1);
    if (end < 0 || Object.hasOwn(attributes, name)) xmlError();
    const raw = rest.slice(1, end);
    if (raw.includes('<')) xmlError();
    attributes[name] = decodeXml(raw);
    rest = rest.slice(end + 1);
  }
  return attributes;
}
function parseTime(value) {
  // A timezone is mandatory: never reinterpret a timezone-less GPX timestamp as local time.
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !isDateKey(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
  if (match[5] !== 'Z' && (Number(match[5].slice(1, 3)) > 23 || Number(match[5].slice(4, 6)) > 59)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
function coordinate(value, min, max) {
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/**
 * Small bounded XML reader, shared by browsers and Node without DOM/dependencies.
 * It reads GPX track segments and routes, never external entities, DTDs or remote resources.
 * Comments, CDATA, namespace prefixes, and the five XML entities are supported.
 * Unknown GPX extension elements are skipped; malformed XML is rejected atomically.
 */
export function parseGPX(xml) {
  if (typeof xml !== 'string' || xml.length === 0 || xml.length > MAX_XML_CHARS || new TextEncoder().encode(xml).byteLength > MAX_XML_CHARS) throw new Error('GPXは12MiB以下のファイルにしてください。');
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('外部参照やDTDを含むGPXは読み込めません。');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml)) xmlError();
  const stack = [], points = [], warnings = [];
  let position = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  let rootSeen = false, rootClosed = false, nextSegment = 0, invalidPoints = 0, invalidTimes = 0, pointElements = 0;
  const appendText = (text, cdata = false) => {
    if (!stack.length) { if (text.trim()) xmlError(); return; }
    const decoded = cdata ? text : decodeXml(text);
    if (stack.at(-1).local === 'time') {
      stack.at(-1).text += decoded;
      if (stack.at(-1).text.length > 128) xmlError();
    }
  };
  const finish = (node) => {
    const parent = stack.at(-1);
    if (node.local === 'time' && parent?.isPoint) {
      const value = parseTime(node.text.trim());
      if (value) parent.time = value;
      else invalidTimes++;
    }
    if (node.isPoint) {
      if (node.lat === null || node.lon === null) {
        invalidPoints++;
        // A missing coordinate is a route break, not permission to bridge the missing section.
        parent.segment = nextSegment++;
      } else {
        const point = { lat: node.lat, lon: node.lon, segment: node.segment };
        if (node.time) point.time = node.time;
        points.push(point);
      }
    }
    if (!stack.length) rootClosed = true;
  };
  while (position < xml.length) {
    if (xml[position] !== '<') {
      const end = xml.indexOf('<', position);
      const until = end === -1 ? xml.length : end;
      const text = xml.slice(position, until);
      if (text.includes(']]>')) xmlError();
      appendText(text);
      position = until;
      continue;
    }
    if (xml.startsWith('<!--', position)) {
      const end = xml.indexOf('-->', position + 4);
      if (end < 0 || xml.slice(position + 4, end).includes('--')) xmlError();
      position = end + 3; continue;
    }
    if (xml.startsWith('<![CDATA[', position)) {
      if (!stack.length) xmlError();
      const end = xml.indexOf(']]>', position + 9);
      if (end < 0) xmlError();
      appendText(xml.slice(position + 9, end), true);
      position = end + 3; continue;
    }
    if (xml.startsWith('<?', position)) {
      const end = xml.indexOf('?>', position + 2);
      if (end < 0) xmlError();
      const instruction = xml.slice(position + 2, end);
      if (!NAME.test(instruction) || (/^xml(?:\s|$)/i.test(instruction) && rootSeen)) xmlError();
      position = end + 2; continue;
    }
    if (xml.startsWith('<!', position)) xmlError();
    let end = position + 1, quote = null;
    for (; end < xml.length; end++) {
      const char = xml[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      else if (char === '<') xmlError();
    }
    if (end >= xml.length || quote) xmlError();
    const raw = xml.slice(position + 1, end);
    position = end + 1;
    if (raw.startsWith('/')) {
      const closing = /^\/([A-Za-z_][A-Za-z0-9_.:-]*)\s*$/.exec(raw);
      if (!closing || !stack.length || stack.at(-1).name !== closing[1]) xmlError();
      finish(stack.pop());
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const content = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = NAME.exec(content);
    if (!nameMatch) xmlError();
    const name = nameMatch[0], local = localName(name);
    const attrs = parseAttributes(content.slice(name.length));
    if (!stack.length) {
      if (rootSeen || rootClosed || local !== 'gpx') throw new Error('GPXファイルを選んでください。');
      rootSeen = true;
    }
    if (stack.length > 100) throw new Error('GPXの入れ子が深すぎます。');
    const parent = stack.at(-1);
    const node = { name, local, attrs, text: '' };
    if ((local === 'trkseg' && parent?.local === 'trk') || (local === 'rte' && parent?.local === 'gpx')) node.segment = nextSegment++;
    if ((local === 'trkpt' && parent?.local === 'trkseg' && Number.isInteger(parent.segment)) ||
        (local === 'rtept' && parent?.local === 'rte' && Number.isInteger(parent.segment))) {
      if (++pointElements > LIMITS.pointsPerRun) throw new Error(`GPXは${LIMITS.pointsPerRun.toLocaleString('ja-JP')}点以下にしてください。`);
      node.isPoint = true;
      node.segment = parent.segment;
      node.lat = coordinate(attrs.lat, -90, 90);
      node.lon = coordinate(attrs.lon, -180, 180);
    }
    stack.push(node);
    if (selfClosing) finish(stack.pop());
  }
  if (!rootSeen || !rootClosed || stack.length) xmlError();
  if (!points.length) throw new Error('GPXに有効な走行ルートがありません。');
  let distanceKm = 0, durationSec = 0, backwards = false, missing = false;
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1], point = points[i];
    if (previous.segment !== point.segment) continue;
    distanceKm += haversineKm(previous, point);
    if (previous.time && point.time) {
      const elapsed = (Date.parse(point.time) - Date.parse(previous.time)) / 1000;
      if (elapsed >= 0) durationSec += elapsed;
      else backwards = true;
    } else missing = true;
  }
  const firstTimedPoint = points.find((point) => point.time);
  const date = firstTimedPoint ? localDateKey(new Date(firstTimedPoint.time)) : null;
  if (invalidPoints) warnings.push(`${invalidPoints}点の不正な座標を除き、その前後は接続していません。`);
  if (invalidTimes) warnings.push(`${invalidTimes}件の不正な時刻を除きました。`);
  if (missing || !firstTimedPoint) warnings.push('一部または全部の時刻がないため、所要時間を確認してください。');
  if (backwards) warnings.push('逆順の時刻があるため、その区間の時間を除いています。');
  if (distanceKm === 0) warnings.push('距離を計算できませんでした。距離を入力してください。');
  if (durationSec > 31 * 24 * 3600) warnings.push('所要時間が31日を超えています。時刻を確認してください。');
  return { date, distanceKm, durationSec: Math.round(durationSec), points, warnings };
}
export const parseGpx = parseGPX;

/** Pure SVG path, with a separate move command for every track segment. No map/network access. */
export function routePath(points, width = 600, height = 240, padding = 16) {
  if (!Array.isArray(points) || !points.length) return '';
  if (![width, height, padding].every(Number.isFinite) || width <= padding * 2 || height <= padding * 2 || padding < 0) throw new Error('ルートの表示サイズが正しくありません。');
  const valid = points.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
  if (!valid.length) return '';
  const meanLat = valid.reduce((sum, p) => sum + p.lat, 0) / valid.length;
  const cos = Math.max(0.001, Math.cos(radians(meanLat)));
  let previousLon = valid[0].lon;
  const projected = valid.map((point) => {
    let lon = point.lon;
    while (lon - previousLon > 180) lon -= 360;
    while (lon - previousLon < -180) lon += 360;
    previousLon = lon;
    return { x: lon * cos, y: -point.lat, segment: point.segment ?? 0 };
  });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of projected) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const dx = maxX - minX, dy = maxY - minY;
  const scale = Math.min((width - 2 * padding) / (dx || 1e-12), (height - 2 * padding) / (dy || 1e-12));
  const offsetX = (width - dx * scale) / 2, offsetY = (height - dy * scale) / 2;
  return projected.map((p, i) => `${i === 0 || p.segment !== projected[i - 1].segment ? 'M' : 'L'}${(offsetX + (p.x - minX) * scale).toFixed(2)},${(offsetY + (p.y - minY) * scale).toFixed(2)}`).join(' ');
}
