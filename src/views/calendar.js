import {e, icon, sectionHead, empty, dayLabel} from '../lib/ui.js';
import {isDateKey, todayKey} from '../lib/domain.js';
import {pageItems, pageControls, shortText, moodPill} from '../lib/journal-ui.js';

const pad = value => String(value).padStart(2, '0');
const weekdays = ['月', '火', '水', '木', '金', '土', '日'];

/** Six complete weeks with safe blanks outside the supported 1900–2200 range. */
export function calendarCells(month) {
  if (!/^\d{4}-\d{2}$/.test(month) || !isDateKey(`${month}-01`)) return [];
  const [year, number] = month.split('-').map(Number);
  const first = new Date(year, number - 1, 1, 12);
  const offset = (first.getDay() + 6) % 7;
  return Array.from({length:42}, (_, index) => {
    const value = new Date(year, number - 1, 1 - offset + index, 12);
    const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    return isDateKey(date) ? {date, day:value.getDate(), inMonth:date.startsWith(month)} : null;
  });
}

export function dailySummary(state, date) {
  const runs = (state.runs || []).filter(run => run.date === date).length;
  const habits = Object.values(state.habitLogs || {}).filter(log => Object.hasOwn(log, date)).length;
  const events = (state.events || []).filter(event => event.date === date).length;
  return {wake:state.wake?.[date] || null, runs, habits, events, diary:state.diary?.[date] || null};
}

function eventRow(event) {
  return `<article class="event-row"><div class="event-date"><span>${e(event.date.slice(0,4))}</span><strong>${e(event.date.slice(5).replace('-', '/'))}</strong><span>${event.time ? e(event.time) : '終日'}</span></div><div class="event-body"><h3>${e(event.title)}</h3>${event.note ? `<p class="event-note">${e(shortText(event.note,80))}</p>` : '<p class="event-note muted">メモなし</p>'}</div><div class="event-actions"><button class="icon-button" type="button" data-action="event-edit" data-id="${e(event.id)}" aria-label="${e(event.title)}の詳細・編集">${icon('edit',18)}</button></div></article>`;
}

export function renderCalendar({state, date, today = todayKey(), tab = 'month', page = 0, pageSize = 3, month} = {}) {
  const selected = isDateKey(date) ? date : today;
  const currentMonth = /^\d{4}-\d{2}$/.test(month || '') && isDateKey(`${month}-01`) ? month : selected.slice(0,7);
  const events = [...(state.events || [])].sort((a,b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '') || a.id.localeCompare(b.id));
  if (tab === 'agenda') {
    const pagination = pageItems(events, page, pageSize);
    return `<div class="view-stack calendar-view"><section class="card agenda-card">${sectionHead('予定の一覧', `${events.length}件の予定 · すべての日付`, `<button class="btn primary small" type="button" data-action="event-add">${icon('plus',17)} 予定を追加</button>`)}${events.length ? `<div class="event-list">${pagination.items.map(eventRow).join('')}</div>${pageControls(pagination,'予定')}` : empty('予定も、余白も。','予定や忘れたくないことを、日付と一緒に残せます。','clock')}</section></div>`;
  }
  const [year, number] = currentMonth.split('-').map(Number);
  const summary = dailySummary(state, selected);
  const selectedEvents = events.filter(event => event.date === selected);
  const monthEvents = new Map();
  for (const event of events) monthEvents.set(event.date, (monthEvents.get(event.date) || 0) + 1);
  const recordedDates = new Set([...Object.keys(state.wake || {}), ...(state.runs || []).map(run => run.date),
    ...Object.values(state.habitLogs || {}).flatMap(log => Object.keys(log))]);
  return `<div class="view-stack calendar-view"><div class="calendar-workspace"><section class="card calendar-board"><div class="calendar-toolbar"><div><span class="eyebrow">月の予定</span><h2>${year}<span>年</span> ${number}<span>月</span></h2></div><div class="row-actions"><button class="icon-button" type="button" data-action="calendar-month" data-offset="-1" aria-label="前の月" ${currentMonth === '1900-01' ? 'disabled' : ''}>${icon('left',18)}</button><button class="btn secondary small" type="button" data-action="calendar-today">今日</button><button class="icon-button" type="button" data-action="calendar-month" data-offset="1" aria-label="次の月" ${currentMonth === '2200-12' ? 'disabled' : ''}>${icon('right',18)}</button></div></div><div class="calendar-weekdays" aria-hidden="true">${weekdays.map(day => `<span>${day}</span>`).join('')}</div><div class="calendar-grid" role="group" aria-label="${year}年${number}月の日付">${calendarCells(currentMonth).map(cell => {
    if (!cell) return '<span class="calendar-day calendar-blank" aria-hidden="true"></span>';
    const eventCount = monthEvents.get(cell.date) || 0, hasDiary = Boolean(state.diary?.[cell.date]), hasRecord = recordedDates.has(cell.date);
    const label = `${cell.date}${cell.date === today ? '、今日' : ''}、予定${eventCount}件${hasDiary ? '、日記あり' : ''}${hasRecord ? '、生活の記録あり' : ''}`;
    return `<button class="calendar-day ${cell.inMonth ? '' : 'outside-month'} ${cell.date === today ? 'is-today' : ''} ${cell.date === selected ? 'is-selected' : ''} ${eventCount ? 'has-events' : ''}" type="button" data-action="calendar-day" data-date="${cell.date}" aria-label="${e(label)}" aria-pressed="${cell.date === selected}" ${cell.date === today ? 'aria-current="date"' : ''}><span>${cell.day}</span><span class="calendar-markers" aria-hidden="true">${eventCount ? '<i class="event-marker"></i>' : ''}${hasDiary ? '<i class="diary-marker"></i>' : ''}${hasRecord ? '<i class="record-marker"></i>' : ''}</span></button>`;
  }).join('')}</div><div class="calendar-legend"><span><i class="event-marker"></i>予定</span><span><i class="diary-marker"></i>日記</span><span><i class="record-marker"></i>生活の記録</span></div></section><section class="card calendar-day-panel">${sectionHead(dayLabel(selected), selected === today ? '今日のページ' : selected > today ? 'これからの一日' : 'この日のページ')}<div class="day-record-summary"><span>${icon('clock',17)} ${summary.events}件の予定</span><span>${icon('sun',17)} ${summary.wake ? e(summary.wake) : '起床の記録なし'}</span><span>${icon('run',17)} ラン ${summary.runs}件</span><span>${icon('habits',17)} 習慣 ${summary.habits}件の記録</span></div><div class="calendar-event-peek">${selectedEvents.length ? `<span class="eyebrow">この日の予定</span><button class="calendar-peek-button" type="button" data-action="event-edit" data-id="${e(selectedEvents[0].id)}"><span>${selectedEvents[0].time ? e(selectedEvents[0].time) : '終日'}</span><strong>${e(selectedEvents[0].title)}</strong>${icon('right',16)}</button>${selectedEvents.length > 1 ? `<button class="text-link" type="button" data-action="view-tab" data-tab="agenda">ほか${selectedEvents.length - 1}件 · 一覧を開く ${icon('arrow',15)}</button>` : ''}` : '<p class="muted">この日の予定は、まだありません。</p>'}</div><div class="calendar-diary-peek">${summary.diary ? moodPill(summary.diary.mood) : ''}<button class="text-link" type="button" data-action="diary-day" data-date="${selected}">${summary.diary ? 'この日の日記を読む' : 'この日の日記を書く'} ${icon('arrow',15)}</button></div><div class="row-actions"><button class="btn primary small" type="button" data-action="event-add" data-date="${selected}">${icon('plus',17)} 予定を追加</button></div></section></div></div>`;
}
