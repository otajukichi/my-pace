import {e,icon,sectionHead,empty,dayLabel} from '../lib/ui.js';
import {runChart} from '../lib/charts.js';
import {recentDates,formatPace,formatDuration} from '../lib/domain.js';
import {routePath} from '../lib/gpx.js';
import {periodToggle} from './wake.js';
import {paginate,pager,summaryStat} from '../lib/workspace.js';
export function routeMap(points) {
  if(!points?.length)return '';
  return `<div class="route-map"><svg viewBox="0 0 600 230" role="img" aria-label="読み込んだ GPX のルートの形。背景地図なし。"><path d="${e(routePath(points,600,230,28))}" class="route-line"/></svg><span>GPX ルート · 背景地図なし</span></div>`;
}
export function renderRunning({state,date,today,period=7,tab='record',page=0,pageSize=4}) {
  const dates=recentDates(period,date),records=state.runs.filter(run=>dates.includes(run.date));
  const total=records.reduce((n,r)=>n+r.distanceKm,0),duration=records.reduce((n,r)=>n+r.durationSec,0);
  if(tab==='history') {
    const rows=paginate([...state.runs].sort((a,b)=>b.date.localeCompare(a.date)||b.id.localeCompare(a.id)),page,pageSize);
    return `<section class="card list-panel">${sectionHead('ランニングの記録','全件を表示。記録を選ぶとメモとルートも確認できます。')}<div class="record-list">${rows.items.length?rows.items.map(run=>`<button class="record-row" data-action="run-edit" data-id="${e(run.id)}"><span class="record-icon">${icon('run')}</span><span class="record-label"><strong>${dayLabel(run.date)}</strong><small>${run.date.slice(0,4)}年 · ${formatDuration(run.durationSec)} · ${formatPace(run.distanceKm,run.durationSec)} /km${run.points?.length?' · GPX':''}${run.note?' · メモあり':''}</small></span><strong class="record-number">${run.distanceKm.toFixed(2)}<small>km</small></strong>${icon('right',17)}</button>`).join(''):empty('まだ、まっさらな道。','走った日に、ひとつずつ残しましょう。','run')}</div>${pager(rows,'ランニング')}</section>`;
  }
  if(tab==='trends')return `<section class="card trend-panel">${sectionHead('走るリズム','日ごとの走行距離',periodToggle(period))}<div class="stats-grid">${summaryStat('走った距離',total.toFixed(2),'km')}${summaryStat('ランニング',records.length,'回',`合計 ${formatDuration(duration)}`)}${summaryStat('平均ペース',total?formatPace(total,duration):'--:--','/km')}</div><div class="chart-space">${runChart(state,period,date)}</div><p class="hint">平均ペースは合計時間 ÷ 合計距離。休んだ日にも、余白を。</p></section>`;
  const todays=state.runs.filter(r=>r.date===date),km=todays.reduce((n,r)=>n+r.distanceKm,0);
  return `<div class="record-layout"><section class="card running-focus"><div class="card-eyebrow">${icon('run')} <span>ONE STEP, YOUR PACE</span></div><div class="trail-art" aria-hidden="true"><svg viewBox="0 0 460 160"><path d="M-20 135C95 180 28 38 142 55S207 179 300 113s58-82 170-99"/><circle cx="142" cy="55" r="7"/><circle cx="300" cy="113" r="7"/></svg></div><p class="hero-caption">${date===today?'今日':'選んだ日'}の距離</p><div class="hero-time">${km.toFixed(2)}<small>km</small></div><p class="hero-note">${todays.length?`${todays.length}回のランニングを記録しました。`:'走った距離も、その日の気持ちも。'}</p><div class="hero-actions"><button class="btn primary" data-action="run-add">${icon('plus',18)} ランを記録</button><button class="btn secondary" data-action="gpx-import">${icon('upload',18)} GPX</button></div></section><section class="card quiet-card">${sectionHead('積み重ねた距離',`選んだ日までの${period}日間`)}<p class="quiet-summary">${total.toFixed(2)}<small>km</small></p><div class="fact-pair"><span>${records.length}回のラン</span><span>${total?formatPace(total,duration):'--:--'} /km</span></div><button class="text-link" data-action="view-tab" data-tab="trends">推移を見る ${icon('arrow',16)}</button><div class="quiet-divider"></div><p class="hint">手入力とGPX読み込みに対応。GPXは背景地図なしの軌跡です。GPS計測・自動連携はありません。</p><button class="text-link" data-action="view-tab" data-tab="history">すべての記録 ${icon('arrow',16)}</button></section></div>`;
}
