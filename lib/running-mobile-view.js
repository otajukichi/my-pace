import { monthSummary, shiftMonth } from './running-calendar.js';
import { runningCalendar, runningMonthLabel, runningSelectionData, runningWeather, runningSpeedLegend } from './running-view.js';
import { runningSlot, runSlotModel } from './run-slots.js';
import { runningAnalysis } from './run-analysis.js';
import { localDate } from './state.js';
import { icon, dayLabel, durationLabel, pace, km } from './ui.js';

function distance(meters) {
  const [whole, fraction] = km(meters).split('.');
  return `${whole}${fraction ? `<span class="distance-fraction">.${fraction}</span>` : ''}<span class="distance-unit">km</span>`;
}
function summary(context) {
  const { days, month, selectedDay } = context;
  const { metrics, count, monthly, fresh } = runningSelectionData(context);
  const title = selectedDay ? dayLabel(selectedDay) : runningMonthLabel(month);
  const slot = selectedDay ? runSlotModel(context) : null;
  const atLatest = slot ? !slot.next : month >= localDate().slice(0, 7);
  const period = selectedDay ? '走った日' : '月';
  const countLabel = !count ? '記録なし' : selectedDay ? (count > 1 ? `${count}件の記録` : '走った記録') : `${monthly.dayCount}日 · ${count}件`;
  return `<section class="mobile-run-summary" aria-label="${title}のサマリー">
    <div class="mobile-run-heading"><div><span class="mobile-run-kicker">${selectedDay ? `${selectedDay.slice(0, 4)} · RUNNING LOG` : 'MONTHLY MAP'}</span><div class="mobile-run-title"><h2>${title}</h2><span class="mobile-run-count">${countLabel}</span></div></div><div class="mobile-run-navigation" role="group" aria-label="表示する${selectedDay ? '記録' : '月'}を変更"><button type="button" id="mobile-run-previous" data-running-step="-1" aria-label="前の${period}" ${slot && !slot.previous ? 'disabled' : ''}>${icon('left')}</button><button type="button" id="mobile-run-next" data-running-step="1" aria-label="次の${period}" ${atLatest ? 'disabled' : ''}>${icon('chevron')}</button></div></div>
    ${count ? `<div class="mobile-run-metrics">
      <div><strong class="num">${distance(metrics.distanceMeters)}</strong><small>${selectedDay ? '距離' : '月間距離'}</small></div>
      <div><strong class="num">${durationLabel(metrics.durationSeconds)}</strong><small>経過時間</small></div>
      <div><strong class="num">${pace(metrics.paceSecondsPerKm)}</strong><small>平均ペース /km</small></div>
      <button class="mobile-run-fresh" data-action="exploration-help" aria-label="新しく走った道 ${fresh === null ? '算出できません' : `推定${km(fresh)}キロ`}。計算について"><strong class="num">${fresh === null ? '—' : `<span class="approx">約</span>${distance(fresh)}`}</strong><small>新しく走った道 ${icon('note')}</small></button>
    </div>` : `<div class="mobile-run-empty"><p>${days.size ? `この${selectedDay ? '日' : '月'}の取得済み記録はありません。` : 'まだランニングの記録がありません。'}</p>${days.size ? `<button class="text-button" data-action="running-latest">最新の記録へ ${icon('arrow')}</button>` : ''}</div>`}
  </section>`;
}
function month(context) {
  const { month, days } = context, value = monthSummary(days, month);
  return `<section class="mobile-month-summary" aria-label="${runningMonthLabel(month)}の集計">
    <div class="mobile-month-navigation"><button class="icon-button" data-running-month="${shiftMonth(month, -1)}" aria-label="集計の前の月">${icon('left')}</button><strong>${Number(month.slice(5))}<small>月</small></strong><button class="icon-button" data-running-month="${shiftMonth(month, 1)}" aria-label="集計の次の月" ${month >= localDate().slice(0, 7) ? 'disabled' : ''}>${icon('chevron')}</button></div>
    <div class="mobile-month-distance"><strong class="num">${distance(value.distanceMeters)}</strong><small>この月の距離</small></div>
    <div class="mobile-month-facts"><span><strong>${value.dayCount}</strong> 日走った</span><span>最長 <strong>${km(value.longest?.distanceMeters || 0)}</strong> km</span></div>
  </section>`;
}
/** One continuous panel. The pace disclosure borrows the history's space;
 * its still-visible heading restores the calendar and route reel in one tap. */
export function runningMobilePanel(context) {
  const { mobileExpanded = false, mobileAnalysis = false } = context;
  const canAnalyze = !!context.days.get(context.selectedDay)?.runs.length;
  const analysis = mobileAnalysis && canAnalyze;
  return `<div class="running-mobile-panel">
    ${summary(context)}
    <div id="mobile-running-content" ${mobileExpanded ? '' : 'hidden'}>
      <button class="mobile-history-disclosure" ${analysis ? '' : 'hidden'} data-mobile-history aria-expanded="${!analysis}" aria-controls="mobile-running-history"><span>${icon('calendar')}走った日とルート</span>${icon(analysis ? 'down' : 'up')}</button>
      <div id="mobile-running-history" class="mobile-running-history" ${analysis ? 'hidden' : ''}>
        <section id="annual-calendar" class="running-calendar" aria-label="ランニングのカレンダー">${runningCalendar(context)}</section>
        <div class="mobile-history-lower"><div class="mobile-month-weather">${month(context)}<section id="running-weather" class="running-weather" aria-label="今からの天気予報" aria-live="polite">${runningWeather(context)}</section></div>${runningSlot(context)}</div>
      </div>
      <div class="mobile-disclosure-footer"><div class="mobile-speed-legend">${runningSpeedLegend()}</div>${canAnalyze ? `<button class="mobile-pace-disclosure" data-mobile-analysis aria-expanded="${analysis}" aria-controls="mobile-pace-content"><span>${icon('pace')}ペースと区間</span><small>${analysis ? '閉じる' : '詳細を見る'}</small>${icon(analysis ? 'up' : 'down')}</button>` : ''}</div><div id="mobile-pace-content" class="mobile-running-analysis" ${analysis ? '' : 'hidden'}>${analysis ? runningAnalysis(context) : ''}</div>
    </div>
  </div>`;
}
