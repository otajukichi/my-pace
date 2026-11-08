import { calendarWindow, monthSummary, shiftMonth } from './running-calendar.js';
import { localDate } from './state.js';
import { icon, esc, dayLabel, durationLabel, pace, km } from './ui.js';
import { SPEED_STOPS } from './route-speed.js';
import { weatherLabel, upcomingHours } from './weather.js';
import { weatherGlyph, weatherTone } from './weather-view.js';
import { runningAnalysis } from './run-analysis.js';
import { runningSlot } from './run-slots.js';

export function runningMonthLabel(month) { return `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月`; }
function distanceValue(meters) {
  const [whole,fraction]=km(meters).split('.');
  return `${whole}${fraction?`<span class="distance-fraction">.${fraction}</span>`:''}<span class="distance-unit">km</span>`;
}
export function runningPanel(context) {
  const {days,month,name='',latestRun}=context,summary=monthSummary(days,month),today=localDate();
  return `<div class="running-dashboard">
  <section class="running-message" aria-label="あなたへのメッセージ"><svg class="message-lanes" viewBox="0 0 240 160" fill="none" aria-hidden="true" focusable="false"><path d="M260 24H146a68 68 0 0 0-68 68v95M260 40H146a52 52 0 0 0-52 52v95M260 56H146a36 36 0 0 0-36 36v95M260 72H146a20 20 0 0 0-20 20v95"/></svg><div class="message-mark" aria-hidden="true">${icon('run')}</div><div><span class="message-kicker">FOR YOU</span><h1>おかえりなさい${name?`、${esc(name)}さん`:""}。</h1><p>${latestRun?`前回は${dayLabel(latestRun.date)}、${km(latestRun.summary.distanceMeters)} km。今日はどんな道を走ろう。`:'最初のランから、ここに記録が増えていきます。'}</p></div></section>
  <section id="annual-calendar" class="running-calendar" aria-label="ランニングのカレンダー">${runningCalendar(context)}</section>
  <div class="running-summary-grid"><div class="running-overview-stack"><section class="running-month-summary" aria-label="${runningMonthLabel(month)}の集計">
    <div class="running-month-nav"><div class="running-month-label"><small>${month.slice(0,4)}</small><h2>${Number(month.slice(5))}<span>月</span></h2></div><div class="running-month-arrows"><button class="icon-button" data-running-month="${shiftMonth(month,-1)}" aria-label="集計の前の月">${icon('left')}</button><button class="icon-button" data-running-month="${shiftMonth(month,1)}" aria-label="集計の次の月" ${month>=today.slice(0,7)?'disabled':''}>${icon('chevron')}</button></div></div>
    <div class="running-month-distance"><span class="metric-caption">この月の距離</span><strong class="num">${distanceValue(summary.distanceMeters)}</strong></div>
    <div class="running-month-facts"><div><strong>${summary.dayCount}<span>日</span></strong><small>走った日</small></div><div><strong>${km(summary.longest?.distanceMeters||0)}<span>km</span></strong><small>1日の最長距離</small></div></div>
  </section>
  <section id="running-weather" class="running-weather" aria-label="今からの天気予報" aria-live="polite">${runningWeather(context)}</section></div>
  <div class="running-selected-panel">${runningSlot(context)}</div></div></div>
`;
}

export function runningWeather({weather=null,weatherBusy=false,weatherError='',area={}}) {
  const location=area.mode==='recorded'?'記録の周辺':area.areaName||'東京駅周辺（公開サンプル）';
  const header=`<div class="running-weather-heading"><h2>今からの天気</h2><span class="weather-location" title="${esc(location)}">${esc(location)}</span><button class="text-button" data-action="weather">時間別 ${icon('chevron')}</button></div>`;
  if(!weather)return `${header}<div class="running-weather-empty">${weatherBusy?'<span class="spinner"></span><span>予報を取得しています</span>':`<span>${esc(weatherError||'予報を準備しています')}</span><button class="text-button" data-action="retry-weather">再取得 ${icon('arrow')}</button>`}</div>`;
  const current=weather.current,hours=upcomingHours(weather,{limit:3});
  const rain=weather.hours.find(h=>Date.parse(h.time)+3600000>Date.now())?.rainProbability;
  return `${header}<div class="running-weather-body"><button class="weather-now" data-weather="${weatherTone(current,weather)}" data-action="weather" aria-label="現在の天気 ${weatherLabel(current.code)}、${Math.round(current.temperature)}度。時間別予報を開く">${weatherGlyph(current,weather)}<div class="weather-reading"><strong>${Math.round(current.temperature)}<span>°C</span></strong><small>${weatherLabel(current.code)}</small></div><span class="weather-now-detail"><span class="weather-rain">降水 ${rain??'—'}%</span><span>風 ${current.wind} m/s</span></span></button><div class="running-weather-hours">${hours.map((h,i)=>`<button data-weather="${weatherTone(h,weather)}" data-weather-hour="${i}" aria-label="${h.time.slice(0,10)} ${h.time.slice(11,16)}、${weatherLabel(h.code)}、${Math.round(h.temperature)}度、降水確率${h.rainProbability??'不明'}${h.rainProbability==null?'':'パーセント'}"><small>${h.time.slice(0,10)!==current.time.slice(0,10)?'翌日 ':''}${h.time.slice(11,16)}</small><span>${weatherGlyph(h,weather)}<strong>${Math.round(h.temperature)}°</strong></span><small>降水 ${h.rainProbability??'—'}%</small></button>`).join('')}</div></div><div class="running-weather-credit"><span>${current.time.slice(5,10).replace('-','/')} ${current.time.slice(11,16)} 時点</span><a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo ↗</a></div>`;
}

function calendarBlock({days,month,selectedDay,calendar,focusDay,compactLabels=false}) {
  const cells=calendar.cells.map(cell=>{
    if(cell.outside)return '<span class="run-cell-gap" aria-hidden="true"></span>';
    const selected=cell.date===selectedDay;
    const description=`${cell.date}、${cell.future?'未来の日付':cell.day?`${km(cell.day.distanceMeters)}キロ、${cell.day.runs.length}件の記録`:'取得済みの記録なし'}`;
    return `<button class="run-cell level-${cell.day?.level||0} ${selected?'selected':''} ${cell.date.startsWith(month)?'in-month':''} ${cell.future?'future':''}" data-calendar-day="${cell.date}" title="${description}" aria-label="${description}" aria-pressed="${selected}" ${cell.date===localDate()?'aria-current="date"':''} tabindex="${cell.date===focusDay&&!cell.future?'0':'-1'}" ${cell.future?'disabled':''}><span></span></button>`;
  }).join('');
  return `<div class="calendar-block" style="--weeks:${calendar.weeks}"><div class="calendar-months" style="--weeks:${calendar.weeks}">${calendar.labels.map(label=>`<button data-map-month="${label.month}" class="${label.month===month?'active':''}" style="grid-column:${label.column+1}/span ${Math.min(3,calendar.weeks-label.column)}" aria-label="${runningMonthLabel(label.month)}の経路を表示" ${label.month>localDate().slice(0,7)?'disabled':''}>${compactLabels?label.label.replace('月',''):label.label}</button>`).join('')}</div><div class="calendar-body"><div class="calendar-weekdays" aria-hidden="true">${['月','','水','','金','','日'].map(d=>`<span>${d}</span>`).join('')}</div><div class="running-heatmap" style="--weeks:${calendar.weeks}" role="group" aria-label="距離の色で見る日別カレンダー。矢印キーで日付を移動できます">${cells}</div></div></div>`;
}
export function runningCalendar({days,month,selectedDay,calendarEnd,calendarMonths=6,mobile}) {
  const today=localDate(),end=calendarEnd||month;
  const calendars=[calendarWindow(days,end,{months:calendarMonths,today})];
  const validDates=calendars.flatMap(c=>c.cells).filter(c=>!c.outside&&!c.future).map(c=>c.date);
  const focusDay=validDates.includes(selectedDay)?selectedDay:[...validDates].reverse().find(date=>days.has(date))||validDates.at(-1);
  const first=calendars[0].first,last=calendars.at(-1).last;
  const periodDays=[...days.values()].filter(d=>d.date>=first&&d.date<=last);
  const periodLabel=first.slice(0,4)===last.slice(0,4)?`${first.slice(0,4)}年 ${Number(first.slice(5,7))}–${Number(last.slice(5,7))}月`:`${first.slice(0,4)}.${Number(first.slice(5,7))}–${last.slice(0,4)}.${Number(last.slice(5,7))}`;
  return `<div class="running-calendar-heading"><div><h2>走った日</h2><span class="calendar-year-summary">${periodDays.length}日 <i>·</i> ${km(periodDays.reduce((s,d)=>s+d.distanceMeters,0))} km</span></div><div class="calendar-range-options" role="group" aria-label="カレンダーの表示期間">${[6,12].map(n=>`<button data-calendar-months="${n}" aria-pressed="${calendarMonths===n}">${n===12?'1年':'6か月'}</button>`).join('')}</div></div>
  <div class="calendar-period-heading"><div class="calendar-year-nav"><button class="icon-button" data-calendar-step="-1" aria-label="カレンダーの前の期間">${icon('left')}</button><strong>${periodLabel}</strong><button class="icon-button" data-calendar-step="1" aria-label="カレンダーの次の期間" ${end>=today.slice(0,7)?'disabled':''}>${icon('chevron')}</button></div><button class="text-button" data-action="calendar-help" aria-label="カレンダーの色と操作について">${icon('note')}</button></div>
  <div class="calendar-blocks">${calendars.map(calendar=>calendarBlock({days,month,selectedDay,calendar,focusDay,compactLabels:mobile&&calendarMonths===12})).join('')}</div>
  <div class="calendar-footer"><p class="calendar-inspection" id="calendar-inspection" aria-live="polite">${selectedDay&&selectedDay>=first&&selectedDay<=last?`${dayLabel(selectedDay)} · ${days.has(selectedDay)?`${km(days.get(selectedDay).distanceMeters)} km`:'取得済みの記録なし'}`:'日付を選ぶと、その日の経路へ'}</p><div class="calendar-scale" aria-label="記録なし、2キロ未満、2から4キロ未満、4から6キロ未満、6キロ以上"><small>距離 少</small>${[0,1,2,3,4].map(n=>`<i class="level-${n}" aria-hidden="true"></i>`).join('')}<small>多</small></div></div>`;
}
export function runningSelectionData({days,month,selectedDay,explorationStats=new Map()}) {
  const selected=selectedDay?days.get(selectedDay):null,monthly=monthSummary(days,month);
  const metrics=selected??monthly;
  const count=selectedDay?selected?.runs.length??0:monthly.runCount;
  const shown=selectedDay?selected?.runs||[]:monthly.days.flatMap(day=>day.runs);
  const values=shown.map(item=>explorationStats.get(item.id)).filter(Boolean);
  const fresh=values.some(value=>value.total>0)?values.reduce((sum,value)=>sum+value.fresh,0):null;
  return {metrics,count,monthly,fresh};
}
export function runningSelectionCard(context) {
  const {days,month,selectedDay,logExpanded=false}=context,{metrics,count,monthly,fresh}=runningSelectionData(context);
  const title=selectedDay?`${dayLabel(selectedDay)}`:runningMonthLabel(month);
  const detail=selectedDay&&count?`<div class="selection-disclosure"><details id="running-log-disclosure" class="running-log-disclosure" ${logExpanded?'open':''}><summary class="selection-detail" data-action="run-detail" aria-controls="running-log-details" aria-expanded="${logExpanded}"><span class="detail-label-open">詳細を見る</span><span class="detail-label-close">詳細を閉じる</span>${icon('down')}</summary>${runningAnalysis(context)}</details><div class="selection-foot selection-disclosure-legend">${runningSpeedLegend()}</div></div>`:`<div class="selection-foot">${runningSpeedLegend()}${!selectedDay&&count?'<span class="selection-month-hint">左のルートから日別へ</span>':''}</div>`;
  return `<article class="running-selection ${!count?'no-record':''}" aria-label="${title}のサマリー"><div class="selection-top"><div><span class="selection-kicker">${selectedDay?`${selectedDay.slice(0,4)} · RUNNING LOG`:'MONTHLY MAP'}</span><h2>${title}</h2></div><span class="selection-count">${!count?'':selectedDay?(count>1?`${count}件の記録`:'走った記録'):`${monthly.dayCount}日 · ${count}件の記録`}</span></div>${!count?`<div class="selection-empty"><p>${days.size?`この${selectedDay?'日':'月'}の取得済み記録はありません。`:'まだランニングの記録がありません。'}</p>${days.size?`<button class="text-button" data-action="running-latest">最新の記録へ ${icon('arrow')}</button>`:''}</div>`:`<div class="selection-metrics"><div><strong class="num">${distanceValue(metrics.distanceMeters)}</strong><small>${selectedDay?'距離':'月間距離'}</small></div><div><strong class="num">${durationLabel(metrics.durationSeconds)}</strong><small>経過時間</small></div><div><strong class="num">${pace(metrics.paceSecondsPerKm)}</strong><small>平均ペース /km</small></div><button class="selection-fresh" data-action="exploration-help" aria-label="新しく走った道 ${fresh===null?'算出できません':`推定${km(fresh)}キロ`}。計算について"><strong class="num">${fresh===null?'—':`<span class="approx">約</span>${distanceValue(fresh)}`}</strong><small>新しく走った道 ${icon('note')}</small></button></div>`}${detail}</article>`;
}
export function runningMapHeading({month,selectedDay}) {
  const daily=!!selectedDay,today=localDate(),atLatest=daily?selectedDay>=today:month>=today.slice(0,7);
  return `<div class="running-period-nav"><button class="icon-button" data-running-step="-1" aria-label="${daily?'前の日':'前の月'}">${icon('left')}</button><strong>${daily?dayLabel(selectedDay):runningMonthLabel(month)}</strong><button class="icon-button" data-running-step="1" aria-label="${daily?'次の日':'次の月'}" ${atLatest?'disabled':''}>${icon('chevron')}</button></div><div class="running-map-actions"><div class="running-view-mode" role="group" aria-label="経路の表示単位"><button data-running-mode="day" aria-pressed="${daily}" class="${daily?'active':''}">日別</button><button data-running-mode="month" aria-pressed="${!daily}" class="${!daily?'active':''}">月全体</button></div></div>`;
}
export function runningSpeedLegend() {
  return `<button class="running-speed-legend" data-action="speed-help" aria-label="経路の速度と色について"><span>速度 <small>km/h</small></span><span class="speed-scale"><i style="background:linear-gradient(90deg,${SPEED_STOPS.map(s=>s[1]).join(',')})"></i><span><small>≤6</small><small>10</small><small>14+</small></span></span>${icon('note')}</button>`;
}
