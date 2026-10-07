import {e,icon,sectionHead,smallLink,dayLabel,habitValue} from '../lib/ui.js';
import {isHabitComplete} from '../lib/domain.js';
import {gardenProgress} from '../lib/garden.js';
import {homeSummary} from '../lib/home-summary.js';

function lifetime(summary) {
  const scope=`生活の記録（DriveのCSVは含みません） · ${e(summary.anchor)}まで`;
  if (!summary.recordedDays) return `<section class="home-lifetime home-lifetime-empty" aria-label="選択日までの全記録"><div class="home-lifetime-heading"><span>これまでの積み重ね</span><p>${scope}</p></div><p class="home-lifetime-empty-message">まだ記録はありません。ひとつ残すところから。</p><div class="home-lifetime-empty-labels"><span>ランニング</span><span>起床</span><span>習慣</span><span>日記</span></div></section>`;
  return `<section class="home-lifetime" aria-label="選択日までの全記録"><div class="home-lifetime-heading"><span>これまでの積み重ね</span><strong>${summary.recordedDays}<small>日を記録</small></strong><p>${scope}</p></div><dl class="home-lifetime-metrics"><div><dt>走った距離</dt><dd>${summary.runCount?`${summary.distanceKm.toFixed(2)}<small>km</small>`:'未記録'}<p>${summary.runCount}回のラン</p></dd></div><div><dt>起床の記録</dt><dd>${summary.wakeDays}<small>日</small><p>${summary.latestWake?`直近 ${e(dayLabel(summary.latestWake.date,true))} · ${e(summary.latestWake.wake)}`:'時刻の記録はまだありません'}</p></dd></div><div><dt>習慣の記録</dt><dd>${summary.habitEntries}<small>件</small><p>${summary.habitDays}日分 · チェック済み ${summary.habitChecked}回</p><p>数値・時間の記録 ${summary.habitMeasured}件</p></dd></div><div><dt>日記の記録</dt><dd>${summary.diaryDays}<small>日</small><p>書き残した日々</p></dd></div></dl></section>`;
}
function history(summary,date) {
  const count=summary.week.filter(day=>day.recorded).length;
  return `<section class="home-history" aria-label="選択日までの7日間"><div class="home-history-heading"><h2>この7日間</h2>${smallLink('calendar','カレンダー')}</div><div class="home-history-days continuity-days">${summary.week.map(day=>{
    const details=[day.wake!==null?`起床 ${day.wake}`:'',day.runCount?`ラン ${day.distanceKm.toFixed(2)} km・${day.runCount}回`:'',day.habitEntries?`習慣 ${day.habitEntries}件を記録、チェック済み${day.habitChecked}件、数値・時間${day.habitMeasured}件`:'',day.diary?'日記あり':''].filter(Boolean).join('、')||'未記録';
    return `<button data-action="select-date" data-date="${day.date}" class="continuity-day ${day.recorded?'recorded':''}" aria-pressed="${day.date===date}" aria-label="${e(day.date+'、'+details)}" title="${e(details)}"><span>${['日','月','火','水','木','金','土'][new Date(day.date+'T12:00:00').getDay()]}</span><strong>${Number(day.date.slice(-2))}</strong><span class="continuity-mark" aria-hidden="true">${day.recorded?'●':'·'}</span></button>`;
  }).join('')}</div><p class="home-history-note">${count?`この7日間、${count}日を記録。`:'今日のひとつが、次につながる。'}<span>印は記録の有無です。習慣の未達成も含みます。</span></p></section>`;
}
function entryRow(name,iconName,value,note,action,link) {
  return `<div class="home-entry-row"><div class="home-entry-label">${icon(iconName,20)}<h3>${name}</h3>${link}</div><div class="home-entry-content"><div class="home-entry-value">${value}</div><p>${note}</p></div><div class="home-entry-actions">${action}</div></div>`;
}
export function renderDashboard({state,date,today,tab='today'}) {
  const summary=homeSummary(state,date),wake=state.wake[date],habits=state.habits.filter(h=>!h.archived);
  const completed=habits.filter(h=>isHabitComplete(h,state.habitLogs[h.id]?.[date])).length;
  const logged=habits.filter(h=>Object.hasOwn(state.habitLogs[h.id]??{},date)).length;
  const habitQuick=habits.slice(0,3).map(habit=>{
    const value=state.habitLogs[habit.id]?.[date],done=isHabitComplete(habit,value);
    return `<button class="home-habit-quick ${done?'done':''}" data-action="habit-log" data-id="${e(habit.id)}" aria-label="${e(habit.name)}を${habit.type==='check'&&done?'未完了にする':'記録する'}" ${habit.type==='check'?`aria-pressed="${done}"`:''}>${icon(done?'check':habit.type==='check'?'plus':'edit',16)}<span>${e(habit.name)}</span><small>${habitValue(habit,value)}</small></button>`;
  }).join('');
  const runs=state.runs.filter(r=>r.date===date),km=runs.reduce((n,r)=>n+r.distanceKm,0),garden=gardenProgress(state,today);
  const gardenLink=`<a class="home-garden-link" href="#garden">${icon('leaf',22)}<span><strong>現在の庭</strong><small>${e(garden.stageLabel)} · ${garden.totalDays}日分の力</small></span>${icon('arrow',18)}</a>`;
  if(tab==='rhythm') return `<div class="home-overview home-rhythm"><div class="home-dashboard-grid">${lifetime(summary)}<div class="home-context-stack">${history(summary,date)}${gardenLink}</div></div></div>`;
  const events=(state.events||[]).filter(item=>item.date===date),diary=state.diary?.[date];
  const diaryPreview=diary?.text?.trim();
  const preview=text=>e([...text].slice(0,70).join('')+([...text].length>70?'…':''));
  const planPreview=events.slice(0,2).map(event=>`${event.time?e(event.time)+' ':''}${preview(event.title)}`).join(' / ');
  return `<div class="home-overview"><div class="home-dashboard-grid"><section class="home-entry-sheet">${sectionHead(date===today?'今日の記録':'この日の記録',dayLabel(date))}${entryRow('起床','sun',wake?e(wake):'—<small>未記録</small>',wake?'記録した起床時刻':'目が覚めた時間を、ひとつ。',`${!wake&&date===today?`<button class="btn primary" data-action="wake-now">${icon('sun',17)} 今起きた</button>`:''}<button class="btn ${wake?'primary':'secondary'}" data-action="wake-edit">${wake?'時間を編集':'時間を入力'}</button>`,smallLink('wake','履歴'))}${entryRow('ランニング','run',runs.length?`${km.toFixed(2)}<small>km</small>`:'—<small>未記録</small>',runs.length?`${runs.length}回のランを記録`:'走った距離と時間を残す。',`<button class="btn secondary" data-action="run-add">${icon('plus',17)} ランを記録</button>`,smallLink('running','履歴'))}${entryRow('習慣','habits',habits.length?`${completed}<small>/ ${habits.length} 達成</small>`:'—<small>未設定</small>',habits.length?`${logged}件を記録 · 達成は現在の目標で集計`:'続けたいことを、ひとつ。',habits.length?`<div class="home-habit-quick-list">${habitQuick}<a href="#habits" class="text-link">すべての習慣 ${icon('arrow',17)}</a></div>`:`<button class="btn secondary" data-action="habit-add">${icon('plus',17)} 習慣を追加</button>`,smallLink('habits','一覧'))}<section class="home-reflection"><div class="home-reflection-copy"><h3>${icon('book',18)} 日記</h3><p>${diaryPreview?preview(diaryPreview):diary?'この日の日記を保存しています。':'今日のことを、ひと言でも。'}</p></div><button class="btn secondary" data-action="diary-edit">${diary?'日記を編集':'日記を書く'}</button><div class="home-plan-row"><a href="#calendar">予定 <strong>${events.length}件</strong>${planPreview?`<span class="home-plan-preview">${planPreview}</span>`:''}</a><button class="btn quiet" data-action="event-add">${icon('plus',16)} 予定を追加</button></div></section>${gardenLink}</section><div class="home-context-stack">${lifetime(summary)}${history(summary,date)}</div></div></div>`;
}
