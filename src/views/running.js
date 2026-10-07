import {e,icon,sectionHead,empty,dayLabel} from '../lib/ui.js';
import {runChart} from '../lib/charts.js';
import {recentDates,formatPace,formatDuration} from '../lib/domain.js';
import {routePath} from '../lib/gpx.js';
import {periodToggle} from './wake.js';
import {paginate,pager,summaryStat} from '../lib/workspace.js';
export function routeMap(points,source='GPX') {
  if(!points?.length)return '';
  return `<div class="route-map"><svg viewBox="0 0 600 230" role="img" aria-label="読み込んだ ${e(source)} のルートの形。背景地図なし。"><path d="${e(routePath(points,600,230,28))}" class="route-line"/></svg><span>${e(source)} ルート · 背景地図なし</span></div>`;
}
export function renderRunning({state,date,today,period=7,tab='record',page=0,pageSize=4}) {
  const dates=recentDates(period,date),records=state.runs.filter(run=>dates.includes(run.date));
  const total=records.reduce((n,r)=>n+r.distanceKm,0),duration=records.reduce((n,r)=>n+r.durationSec,0);
  if(tab==='history') {
    const rows=paginate([...state.runs].sort((a,b)=>b.date.localeCompare(a.date)||b.id.localeCompare(a.id)),page,pageSize);
    return `<section class="card list-panel">${sectionHead('ランニングの記録','全件を表示。記録を選ぶとメモとルートも確認できます。')}<div class="record-list">${rows.items.length?rows.items.map(run=>`<button class="record-row" data-action="run-edit" data-id="${e(run.id)}"><span class="record-icon">${icon('run')}</span><span class="record-label"><strong>${dayLabel(run.date)}</strong><small>${run.date.slice(0,4)}年 · ${formatDuration(run.durationSec)} · ${formatPace(run.distanceKm,run.durationSec)} /km${run.points?.length?' · GPX':''}${run.note?' · メモあり':''}</small></span><strong class="record-number">${run.distanceKm.toFixed(2)}<small>km</small></strong>${icon('right',17)}</button>`).join(''):empty('まだ、まっさらな道。','走った日に、ひとつずつ残しましょう。','run')+`<button class="btn secondary empty-action" data-action="run-add">${icon('plus',17)} ランを記録</button>`}</div>${pager(rows,'ランニング')}</section>`;
  }
  if(tab==='trends')return `<section class="card trend-panel running-trend">${sectionHead('走るリズム','日ごとの走行距離',periodToggle(period))}<div class="stats-grid">${summaryStat('走った距離',total.toFixed(2),'km')}${summaryStat('ランニング',records.length,'回',`合計 ${formatDuration(duration)}`)}${summaryStat('平均ペース',total?formatPace(total,duration):'--:--','/km')}</div><div class="chart-space">${runChart(state,period,date)}</div><p class="hint">平均ペースは合計時間 ÷ 合計距離。休んだ日にも、余白を。</p></section>`;
  const todays=state.runs.filter(r=>r.date===date),km=todays.reduce((n,r)=>n+r.distanceKm,0);
  return `<div class="run-workspace ${records.length?'has-history':'no-history'}"><section class="run-entry-sheet"><h2>この日のラン</h2><div class="hero-time">${todays.length?`${km.toFixed(2)}<small>km</small>`:'<span class="unrecorded">未記録</span>'}</div><p class="hero-note">${todays.length?`${todays.length}回のランニングを記録`:'走った距離と時間を残します。'}</p><div class="hero-actions"><button class="btn primary" data-action="run-add">${icon('plus',18)} ランを記録</button><button class="btn secondary" data-action="gpx-import">${icon('upload',18)} GPXを読み込む</button></div><div class="quiet-divider"></div><button class="text-link" data-action="view-tab" data-tab="history">すべての記録 ${icon('arrow',16)}</button><p class="hint">GPXは軌跡のみ。背景地図・GPS計測なし。</p></section><div class="run-context"><section class="run-chart-panel forest-panel">${sectionHead(`この${period}日間の走行距離`,'',`<button class="text-link" data-action="view-tab" data-tab="trends">推移を見る ${icon('arrow',16)}</button>`)}<div class="chart-space">${runChart(state,period,date)}</div></section>${records.length?`<section class="run-summary sky-panel" aria-label="ランニングの集計"><div class="stats-grid">${summaryStat('走った距離',total.toFixed(2),'km')}${summaryStat('ランニング',records.length,'回',`合計 ${formatDuration(duration)}`)}${summaryStat('平均ペース',total?formatPace(total,duration):'--:--','/km')}</div></section>`:''}</div></div>`;
}
