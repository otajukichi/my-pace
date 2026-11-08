import { icon, esc, pace, durationLabel, km } from './ui.js';

/** Keep gaps as gaps; the chart never invents pace for missing samples. */
export function paceSeries(run) {
  const duration = run?.summary?.durationSeconds;
  if (!(duration > 0)) return null;
  const series = [], values = []; let piece = [], previous = null;
  for (const sample of run.paceSamples || []) {
    if (!Number.isFinite(sample.elapsedSeconds) || sample.elapsedSeconds < 0 || sample.elapsedSeconds > duration
        || !Number.isFinite(sample.paceSecondsPerKm) || sample.paceSecondsPerKm <= 0 || sample.coverage < .5) {
      if (piece.length) series.push(piece); piece = []; previous = null; continue;
    }
    if (previous && (sample.elapsedSeconds <= previous.elapsedSeconds || sample.elapsedSeconds - previous.elapsedSeconds > 90)) {
      if (piece.length) series.push(piece); piece = [];
    }
    piece.push(sample); values.push(sample.paceSecondsPerKm); previous = sample;
  }
  if (piece.length) series.push(piece);
  if (!values.length) return null;
  const average = run.summary.paceSecondsPerKm;
  if (Number.isFinite(average) && average > 0) values.push(average);
  const low = Math.floor(Math.min(...values) / 30) * 30;
  const high = Math.max(low + 60, Math.ceil(Math.max(...values) / 30) * 30);
  return { series, low, high, duration, average };
}

function chart(run) {
  const model = paceSeries(run);
  if (!model) return '<div class="analysis-chart-empty">ペースの推移は記録されていません</div>';
  const x = sample => 2 + sample.elapsedSeconds / model.duration * 296;
  const y = value => 5 + (value - model.low) / (model.high - model.low) * 80;
  const average = Number.isFinite(model.average) && model.average > 0
    ? `<path d="M2 ${y(model.average).toFixed(2)}H298" class="analysis-average"/>` : '';
  const lines = model.series.map(series => {
    if (series.length === 1) return `<circle cx="${x(series[0]).toFixed(2)}" cy="${y(series[0].paceSecondsPerKm).toFixed(2)}" r="1.8" class="analysis-point"/>`;
    const line = series.map((sample, i) => `${i ? 'L' : 'M'}${x(sample).toFixed(2)} ${y(sample.paceSecondsPerKm).toFixed(2)}`).join(' ');
    return `<path d="${line}L${x(series.at(-1)).toFixed(2)} 90L${x(series[0]).toFixed(2)} 90Z" class="analysis-area"/><path d="${line}" class="analysis-line"/>`;
  }).join('');
  return `<div class="analysis-chart"><svg viewBox="0 0 300 90" preserveAspectRatio="none" role="img" aria-label="経過時間ごとのペース。上が速く、下が遅い。破線は平均ペース。欠測は線をつなぎません。"><defs><linearGradient id="analysis-fill" x2="0" y2="1"><stop stop-color="var(--anchor)" stop-opacity=".16"/><stop offset="1" stop-color="var(--anchor)" stop-opacity=".02"/></linearGradient></defs><path d="M2 5H298M2 45H298M2 85H298" class="analysis-grid"/>${average}${lines}</svg><div class="analysis-range"><span>${pace(model.low)}</span><span>${pace(model.high)}</span></div></div><div class="analysis-axis"><span>0:00</span><span>${durationLabel(model.duration)}</span></div>`;
}

export function runningAnalysis({ days, selectedDay, selectedRunId, splitPage = 0, splitPageSize = 5 }) {
  const runs = days.get(selectedDay)?.runs || [];
  const run = runs.find(item => item.id === selectedRunId) || runs[0];
  if (!run) return '';
  const splits = (run.splits || []).filter(s => Number.isFinite(s.distanceMeters) && s.distanceMeters > 0 && Number.isFinite(s.paceSecondsPerKm) && s.paceSecondsPerKm > 0);
  const pageSize = splitPageSize === 3 ? 3 : 5, pages = Math.ceil(splits.length / pageSize), page = Math.max(0, Math.min(splitPage, pages - 1));
  const fastest = Math.min(...splits.map(s => s.paceSecondsPerKm));
  const chooser = runs.length > 1 ? `<select id="analysis-run" aria-label="ペースと区間を見るラン">${runs.map((item, index) => `<option value="${esc(item.id)}" ${item.id === run.id ? 'selected' : ''}>ラン ${index + 1} · ${km(item.summary.distanceMeters)} km</option>`).join('')}</select>` : '';
  return `<section class="running-analysis" id="running-log-details" aria-label="ペースと区間"><div class="analysis-heading"><h3>ペースと区間</h3>${chooser}<span>停止時間を含む</span></div><div class="analysis-columns"><div class="analysis-pace"><div class="analysis-pace-heading"><span>平均ペース</span><strong>${pace(run.summary.paceSecondsPerKm)} <small>/km</small></strong></div>${chart(run)}<p class="analysis-caption">GPSから算出 · 60秒ごとの推定値</p></div><div class="analysis-splits"><div class="analysis-split-heading"><span>区間</span><span>ペース /km</span></div>${splits.length ? splits.slice(page * pageSize, (page + 1) * pageSize).map((s, index) => `<div class="analysis-split"><span>${s.partial ? km(s.distanceMeters) : s.kilometer ?? page * pageSize + index + 1}<small>km</small></span><i aria-hidden="true"><b style="width:${Math.round(fastest / s.paceSecondsPerKm * 100)}%"></b></i><strong>${pace(s.paceSecondsPerKm)}</strong></div>`).join('') : '<p class="analysis-no-splits">区間の記録はありません</p>'}${pages > 1 ? `<div class="analysis-pagination"><button class="icon-button" data-split-step="-1" aria-label="前の区間" ${page === 0 ? 'disabled' : ''}>${icon('left')}</button><span>${page * pageSize + 1}–${Math.min((page + 1) * pageSize, splits.length)} / ${splits.length}</span><button class="icon-button" data-split-step="1" aria-label="次の区間" ${page === pages - 1 ? 'disabled' : ''}>${icon('chevron')}</button></div>` : ''}</div></div></section>`;
}
