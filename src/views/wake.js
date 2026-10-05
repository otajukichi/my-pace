import  {
  e,icon,sectionHead,empty,dayLabel
}
from '../lib/ui.js';
import  {
  wakeChart
}
from '../lib/charts.js';
import  {
  wakeStats
}
from '../lib/domain.js';
export function renderWake( {
  state,date,today,period
}
)  {
  const value=state.wake[date], stats=wakeStats(state,period,date);
  const history=Object.entries(state.wake).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,30);
  return `<section class="card wake-today"><div><span class="eyebrow">WAKE UP</span><h2>${value?'今日の朝':'朝の始まりを、記録する。'}</h2><p class="muted">毎日の入力は、起きた時間だけ。</p></div><div class="wake-today-time">${value?e(value):'--:--'}</div><div class="stack-actions">${!value&&date===today?`<button class="btn primary" data-action="wake-now">${icon('sun',18)} 今起きた</button>`:''}<button class="btn ${value?'primary':'secondary'}" data-action="wake-edit">${icon('edit',17)} ${value?'時間を編集':'時間を入力'}</button></div></section>
  <div class="stats-grid"><div class="stat card"><span>平均の起床時間</span><strong>${stats.averageTime||'--:--'}</strong><small>過去${period}日の記録から</small></div><div class="stat card"><span>記録した朝</span><strong>${stats.count}<em>日</em></strong><small>過去${period}日間</small></div><div class="stat card"><span>起床の目安</span><strong>${state.settings.wakeTarget?e(state.settings.wakeTarget):'自由に'}</strong><button class="text-link" data-action="target-edit">目安を${state.settings.wakeTarget?'変更':'設定'} ${icon('edit',14)}</button></div></div>
  <section class="card chart-card">${sectionHead('朝のリズム','起きる時間を、ゆるやかに眺める。',periodToggle(period))}${wakeChart(state,period,date)}</section>
  <section class="card history-card">${sectionHead('これまでの朝', '直近30件。日付を選ぶと編集できます。')}${history.length?`<div class="wake-history">${history.map(([day,time])=>`<button class="history-row" data-action="wake-history" data-date="${day}"><span>${dayLabel(day)}<small>${day.slice(0,4)}年</small></span><strong>${e(time)}</strong>${icon('right',18)}</button>`).join('')}</div>`:empty('まだ記録はありません。','最初の記録を楽しみにしています。','sun')}</section>`;
}
export const periodToggle = period => `<div class="segmented" aria-label="集計期間"><button data-action="period" data-days="7" aria-pressed="${period===7}">7日</button><button data-action="period" data-days="30" aria-pressed="${period===30}">30日</button></div>`;
