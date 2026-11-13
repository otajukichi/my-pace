import { createRunningRepository, decodeRoute, joinRouteParts, decodeMask } from './running-artifacts.js';

const messages = {
  NOT_CONFIGURED: 'Google接続の設定がまだありません。現在の表示に戻れます。',
  SIGN_IN: 'Googleでログインすると、Driveの記録を表示できます。',
  OWNER_ONLY: 'この表示用フォルダを所有するGoogleアカウントでログインしてください。',
  DRIVE_ACCESS: '表示用フォルダを読み込めません。接続先とGoogleアカウントを確認してください。',
  DISPLAY_NOT_UNIQUE: '接続先の表示用ファイルを特定できませんでした。',
};
export async function driveRequest(path, body, fetchImpl = fetch) {
  const r = await fetchImpl(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  let value; try { value = await r.json(); } catch { throw Error('Google接続を読み込めませんでした。'); }
  if (!r.ok) { const e = Error(messages[value.error?.code] || 'Driveの記録を読み込めませんでした。時間をおいて、読み込み直してください。'); e.code = value.error?.code; throw e; }
  return value;
}

// Keep metadata/relative thumbnails; load GPS only for the selected day/month.
// No raw-file transport, persistent browser storage, or processing job here.
export function createDriveRunningSource({ fetchJson = path => driveRequest('/api/running-drive', { path }) } = {}) {
  const repository = createRunningRepository({ fetchJson });
  let catalog, runs = [], monthRefs = new Map();
  const pendingMasks = new Map();
  async function pool(items, action, concurrency = 4) {
    const results = new Array(items.length); let at = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (at < items.length) { const i = at++; results[i] = await action(items[i]); }
    })); return results;
  }
  async function load() {
    catalog = await repository.catalog();
    if (catalog.exploration?.zoom !== 16 || catalog.exploration?.size !== 64 || catalog.exploration?.blockTiles !== 16) throw Error('探索範囲の形式に対応していません。');
    const years = await pool(Object.values(catalog.years), ref => repository.year(ref));
    monthRefs = new Map(years.flatMap(y => y.months).map(m => [m.month, m]));
    const lists = await pool([...monthRefs.values()].flatMap(m => m.lists), ref => repository.month(ref));
    // The previous Google experiment retains a deliberately synthetic control.
    // Exclude that exact fixture only; never discard a user's date/year broadly.
    runs = lists.flatMap(m => m.runs).filter(r => r.id !== 'r_' + CONTROL_KEY + '_2001-01-01').sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    return { runs, explorationStats: new Map(runs.filter(r => r.freshMeters !== null).map(r => [r.id, { total: r.summary.distanceMeters, fresh: r.freshMeters }])) };
  }
  async function view({ day, month, analysis = false, runId }) {
    const selected = runs.filter(r => day ? r.date === day : r.date.startsWith(month));
    let routes;
    if (day) routes = await pool(selected, async run => ({ ...run, ...await repository.route(run.route) }));
    else {
      const pages = await repository.overview(monthRefs.get(month)?.overview || []), groups = new Map();
      for (const page of pages) for (const route of page.routes) {
        if (!groups.has(route.id)) groups.set(route.id, []); groups.get(route.id).push(decodeRoute(route));
      }
      routes = selected.map(run => ({ ...run, ...joinRouteParts(groups.get(run.id) || []) }));
    }
    const current = selected.find(r => r.id === runId) || selected[0];
    let detail = null;
    if (day && analysis && current) {
      const a = await repository.analysis(current.analysis);
      if (a.id !== current.id) throw Error('記録の詳細が一致しません。');
      detail = { id: a.id, paceSamples: a.paceSamples.map(([elapsedSeconds, paceSecondsPerKm, coverage]) => ({ elapsedSeconds, paceSecondsPerKm, coverage })),
        splits: a.splits.map(([kilometer, distanceMeters, durationSeconds, paceSecondsPerKm, coverage, partial]) => ({ kilometer, distanceMeters, durationSeconds, paceSecondsPerKm, coverage, partial })) };
    }
    return { routes, detail };
  }
  async function maskTiles({ x, y, z }) {
    if (!catalog) return [];
    const n = 2 ** z, scale = 2 ** (16 - z), left = ((x % n + n) % n) * scale, top = y * scale;
    const right = left + scale, bottom = top + scale;
    const blocks = Object.entries(catalog.exploration.blocks).filter(([key]) => {
      const [bx, by] = key.split('/').map(Number); return bx * 16 < right && (bx + 1) * 16 > left && by * 16 < bottom && (by + 1) * 16 > top;
    });
    const tiles = await pool(blocks, async ([key, refs]) => {
      let pending = pendingMasks.get(key);
      if (!pending) {
        pending = repository.exploration(refs).then(pages => pages.flatMap(p => p.tiles).map(t => ({ ...t, cells: decodeMask(t.rle) })));
        pendingMasks.set(key, pending);
        pending.catch(() => { if (pendingMasks.get(key) === pending) pendingMasks.delete(key); });
        if (pendingMasks.size > 24) pendingMasks.delete(pendingMasks.keys().next().value);
      }
      return (await pending).filter(t => t.x < right && t.x + 1 > left && t.y < bottom && t.y + 1 > top);
    });
    return tiles.flat();
  }
  return { load, view, maskTiles, clear() { repository.clear(); pendingMasks.clear(); runs = []; catalog = null; monthRefs.clear(); } };
}
// SHA-256 of the public fixture key "control", truncated by the existing writer.
const CONTROL_KEY = '0fcd568a5cb9bdb4677b6935';
