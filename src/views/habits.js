import  {
  e,icon,sectionHead,empty,habitValue,isDone
}
from '../lib/ui.js';
import  {
  recentDates,habitStreak
}
from '../lib/domain.js';
export function renderHabits( {
  state,date
}
)  {
  const active=state.habits.filter(h=>!h.archived), archived=state.habits.filter(h=>h.archived), days=recentDates(7,date);
  return `<div class="habit-page-heading"><p class="muted">小さな「できた」を、毎日に。</p><button class="btn primary" data-action="habit-add">${icon('plus',18)} 習慣を追加</button></div>
  ${active.length?`<div class="habit-grid">${active.map(h=>{const value=state.habitLogs[h.id]?.[date],done=isDone(h,value);return `<section class="card habit-card ${done?'completed':''}"><div class="habit-card-head"><span class="habit-kind">${icon(h.type==='check'?'check':h.type==='time'?'clock':'leaf',20)} ${h.type==='check'?'チェック':h.type==='time'?'時間':'数値'}</span><button class="icon-button" data-action="habit-edit" data-id="${e(h.id)}" aria-label="${e(h.name)}の設定">${icon('dots')}</button></div><h2>${e(h.name)}</h2><p class="habit-target">${h.type==='check'?'できた日にチェック':`目安 ${h.target} ${h.type==='time'?'分':e(h.unit||'')}`}</p><button class="habit-record ${done?'is-done':''}" data-action="habit-log" data-id="${e(h.id)}" ${h.type==='check'?`aria-pressed="${done}"`:''}><span>${done?icon('check',22):icon('plus',22)}</span><strong>${value!==undefined?habitValue(h,value):'今日の記録'}</strong>${h.type!=='check'?icon('edit',16):''}</button><div class="habit-week">${days.map(d=>{const done=isDone(h,state.habitLogs[h.id]?.[d]);return `<div title="${d}: ${done?'達成':'未達成'}"><span>${['日','月','火','水','木','金','土'][new Date(d+'T12:00:00').getDay()]}</span><i class="${done?'filled':''}">${done?icon('check',12):''}</i></div>`;}).join('')}</div><div class="habit-card-footer"><span>${habitStreak(state,h.id,date)}日 継続中</span><button class="text-link" data-action="habit-archive" data-id="${e(h.id)}">お休みする</button></div></section>`;}).join('')}</div>`:`<section class="card">${empty('続けたいことを、ひとつ。','「本を読む」「水を飲む」など、自分に合った習慣をつくれます。','habits')}</section>`}
  ${archived.length?`<section class="card archive-card">${sectionHead('お休み中の習慣','記録はそのまま。いつでも再開できます。')}<div>${archived.map(h=>`<div class="archive-row"><span>${e(h.name)}</span><button class="btn secondary small" data-action="habit-restore" data-id="${e(h.id)}">再開する</button></div>`).join('')}</div></section>`:''}`;
}
