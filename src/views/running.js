import  {
  e,icon,sectionHead,empty,dayLabel
}
from '../lib/ui.js';
import  {
  runChart
}
from '../lib/charts.js';
import  {
  recentDates,formatPace,formatDuration
}
from '../lib/domain.js';
import  {
  routePath
}
from '../lib/gpx.js';
import  {
  periodToggle
}
from './wake.js';
export function routeMap(points)  {
  if (!points?.length) return '';
  return `<div class="route-map"><svg viewBox="0 0 600 230" role="img" aria-label="読み込んだ GPX のルートの形。背景地図なし。"><defs><pattern id="route-grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" fill="none" stroke="currentColor" stroke-width=".5"/></pattern></defs><rect width="600" height="230" fill="url(#route-grid)" opacity=".12"/><path d="${e(routePath(points,600,230,28))}" class="route-line"/></svg><span>GPX ルート · 背景地図なし</span></div>`;
}
export function renderRunning( {
  state,date,period
}
)  {
  const dates=recentDates(period,date), records=state.runs.filter(run=>dates.includes(run.date));
  const total=records.reduce((sum,run)=>sum+run.distanceKm,0), duration=records.reduce((sum,run)=>sum+run.durationSec,0);
  const history=[...state.runs].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,30);
  return `<section class="card running-intro"><div><span class="eyebrow">KEEP MOVING</span><h2>走った日を、残そう。</h2><p class="muted">距離と時間を手入力。GPX の記録も読み込めます。</p></div><div class="row-actions"><button class="btn secondary" data-action="gpx-import">${icon('upload',18)} GPX を読込</button><button class="btn primary" data-action="run-add">${icon('plus',18)} ランを記録</button></div></section>
  <div class="stats-grid"><div class="stat card"><span>走った距離</span><strong>${total.toFixed(2)}<em>km</em></strong><small>過去${period}日間</small></div><div class="stat card"><span>ランニング</span><strong>${records.length}<em>回</em></strong><small>合計 ${formatDuration(duration)}</small></div><div class="stat card"><span>平均ペース</span><strong>${total?formatPace(total,duration):'--:--'}<em>/km</em></strong><small>合計時間 ÷ 合計距離</small></div></div>
  <section class="card chart-card">${sectionHead('走るリズム','日ごとの走行距離',periodToggle(period))}${runChart(state,period,date)}</section>
  <section class="card history-card">${sectionHead('ランニングの記録','直近30件。記録を選ぶと編集できます。')}${history.length?`<div class="run-list">${history.map(run=>`<article class="run-entry"><button class="run-entry-head" data-action="run-edit" data-id="${e(run.id)}"><span class="run-badge">${icon('run')}</span><span><strong>${dayLabel(run.date)}</strong><small>${run.date.slice(0,4)}年${run.points?.length?' · GPX':' · 手入力'}</small></span><span class="run-entry-distance">${run.distanceKm.toFixed(2)}<small>km</small></span>${icon('right',18)}</button><div class="run-entry-facts"><span>${icon('clock',16)} ${formatDuration(run.durationSec)}</span><span>${formatPace(run.distanceKm,run.durationSec)} /km</span></div>${run.note?`<p class="run-note">${e(run.note)}</p>`:''}${routeMap(run.points)}</article>`).join('')}</div>`:empty('まだ、まっさらな道。','最初のランニングを記録してみましょう。','run')}</section><p class="page-footnote">現在は手入力と GPX 読み込みに対応。地図表示・GPS 計測・自動取り込みは未実装です。</p>`;
}
