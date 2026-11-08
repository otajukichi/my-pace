import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

class AreaError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new AreaError(status, message); };
const validPoint = point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])
  && Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180;
const coarse = value => Math.round(value * 10) / 10;

/** Local-only weather preference. No place search, routing, or external requests. */
export function createWeatherArea({ root }) {
  let useRecordedLocation = false;
  async function describe(recorded) {
    if (!recorded) return { mode: 'demo', areaName: '東京駅周辺（公開サンプル）', center: { lat: 35.7, lon: 139.8 } };
    let data;
    try { data = JSON.parse(await readFile(join(root, 'data', 'running.json'), 'utf8')); }
    catch { fail(503, '天気のエリアに使う記録を読み込めませんでした。'); }
    const days = Array.isArray(data?.days) ? [...data.days].sort((a, b) => String(b?.date).localeCompare(String(a?.date))) : [];
    for (const day of days) {
      for (const segment of Array.isArray(day?.segments) ? day.segments : []) {
        const point = Array.isArray(segment?.points) ? segment.points.find(validPoint) : null;
        if (point) return { mode: 'recorded', areaName: '記録の周辺', center: { lat: coarse(point[0]), lon: coarse(point[1]) } };
      }
    }
    fail(503, '天気のエリアに使える位置の記録がありません。');
  }
  return {
    get: () => describe(useRecordedLocation),
    async set(recorded) {
      if (typeof recorded !== 'boolean') fail(400, '天気のエリアを選んでください。');
      const result = await describe(recorded);
      useRecordedLocation = recorded;
      return result;
    },
  };
}

/** Own all /api responses so retired endpoints can never trigger a request. */
export function createWeatherApiHandler({ root, weatherArea = createWeatherArea({ root }) }) {
  return async (request, response) => {
    if (typeof request.url !== 'string' || !(request.url === '/api' || request.url.startsWith('/api/'))) return false;
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    try {
      const host = request.headers.host ?? '', origin = request.headers.origin;
      if (!/^(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(host)) fail(403, 'ローカル接続だけ利用できます。');
      const port = Number(host.slice(host.lastIndexOf(':') + 1));
      if (port < 1 || port > 65535 || (request.socket?.localPort && port !== request.socket.localPort)) fail(403, 'ローカル接続だけ利用できます。');
      if ((origin && origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') fail(403, 'この画面から操作し直してください。');
      if (request.url !== '/api/weather-area') fail(404, 'API が見つかりません。');
      if (!['GET', 'POST'].includes(request.method)) fail(405, 'この操作には対応していません。');
      if (request.method === 'GET') { send(200, await weatherArea.get()); return true; }
      if (origin !== `http://${host}`) fail(403, 'この画面から操作し直してください。');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) fail(415, 'JSON のリクエストが必要です。');
      if (Number(request.headers['content-length']) > 1024) fail(413, '入力が長すぎます。');
      let text = '', size = 0;
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > 1024) fail(413, '入力が長すぎます。');
        text += chunk;
      }
      let body;
      try { body = JSON.parse(text); } catch { fail(400, '入力を読み込めませんでした。'); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.useRecordedLocation !== 'boolean') fail(400, '天気のエリアを選んでください。');
      send(200, await weatherArea.set(body.useRecordedLocation));
    } catch (error) {
      send(error instanceof AreaError ? error.status : 500, { error: { message: error instanceof AreaError ? error.message : '天気のエリアを読み込めませんでした。' } });
    }
    return true;
  };
}
