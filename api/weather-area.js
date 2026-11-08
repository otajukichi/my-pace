// The hosted app has no private GPS or mutable server-side preferences.
const PUBLIC_AREA = { mode: 'demo', areaName: '東京駅周辺（公開サンプル）', center: { lat: 35.7, lon: 139.8 } };

export default function handler(request, response) {
  const send = (status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  if (request.method === 'GET') return send(200, PUBLIC_AREA);
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'GET, POST');
    return send(405, { error: { message: 'この操作には対応していません。' } });
  }
  let body = request.body;
  try { if (typeof body === 'string') body = JSON.parse(body); } catch { body = null; }
  if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.useRecordedLocation !== 'boolean') {
    return send(400, { error: { message: '天気のエリアを選んでください。' } });
  }
  if (body.useRecordedLocation) return send(503, { error: { message: '公開画面には位置の記録がありません。東京駅周辺の天気を表示します。' } });
  return send(200, PUBLIC_AREA);
}
