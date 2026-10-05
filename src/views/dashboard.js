import  {
  e, icon, sectionHead, smallLink, habitValue, isDone
}
from '../lib/ui.js';
import  {
  recentDates, formatPace
}
from '../lib/domain.js';
export function renderDashboard( {
  state, date, today
}
)  {
  const wake = state.wake[date];
  const habits = state.habits.filter(h => !h.archived);
  const completed = habits.filter(h=>isDone(h,state.habitLogs[h.id]?.[date])).length;
  const runs = state.runs.filter(run=>run.date===date);
  const km = runs.reduce((sum,run)=>sum+run.distanceKm,0);
  const dates = recentDates(7,date);
  return `<div class="dashboard-grid">
    <section class="card morning-card">
      <div class="card-eyebrow">${icon('sun')} <span>朝を、ひとつ。</span><a class="icon-link" href="#wake" aria-label="早起きのページへ">${icon('arrow')}</a></div>
      <div class="morning-orbit" aria-hidden="true"><div class="orbit-sun"></div></div>
      <p class="hero-caption">${wake ? '起きた時間' : '今日の起床時間'}</p>
      <div class="hero-time">${wake ? e(wake) : '<span class="unrecorded">--<span>:</span>--</span>'}</div>
      <p class="hero-note">${wake ? 'おはよう。今日も、自分のペースで。' : '目が覚めたら、ここから一日を。'}</p>
      <div class="hero-actions">${!wake && date === today ? `<button class="btn primary" data-action="wake-now">${icon('sun',18)} 今起きた</button>`:''}<button class="btn ${wake || date !== today ? 'primary' : 'ghost'}" data-action="wake-edit">${wake ? '時間を編集' : '時間を入力'} ${icon('edit',16)}</button></div>
    </section>
    <section class="card daily-habits">
      ${sectionHead('今日の習慣',habits.length ? `${completed} / ${habits.length} できた` : '小さく始めて、ゆっくり続ける。',smallLink('habits','一覧'))}
      ${habits.length ? `<div class="compact-habits">${habits.slice(0,4).map(h=>{const value=state.habitLogs[h.id]?.[date];const done=isDone(h,value);return `<div class="compact-habit ${done?'done':''}"><button class="habit-toggle" data-action="habit-log" data-id="${e(h.id)}" aria-label="${e(h.name)}を${h.type==='check'&&done?'未完了にする':'記録する'}" ${h.type==='check'?`aria-pressed="${done}"`:''}>${done?icon('check',18):h.type==='check'?'':icon(h.type==='time'?'clock':'plus',18)}</button><button class="habit-label" data-action="habit-log" data-id="${e(h.id)}"><strong>${e(h.name)}</strong><span>${habitValue(h,value)}</span></button></div>`;}).join('')}</div>` : `<div class="habit-invite"><div class="invite-pattern" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><p>読書も、ストレッチも。<br>続けたいことをひとつ。</p><button class="btn secondary" data-action="habit-add">${icon('plus',17)} 習慣を追加</button></div>`}
    </section>
    <section class="card run-summary">
      <div class="card-eyebrow">${icon('run')} <span>ランニング</span><a class="icon-link" href="#running" aria-label="ランニングのページへ">${icon('arrow')}</a></div>
      <div class="run-summary-inner"><div><p class="hero-caption">今日の距離</p><div class="distance">${km ? km.toFixed(2) : '0.00'} <span>km</span></div><p class="muted">${runs.length ? `${runs.length} 回のランニングを記録` : '走った日の気持ちも、一緒に。'}</p></div><div class="route-doodle" aria-hidden="true"><svg viewBox="0 0 150 90"><path d="M15 70C35 70 20 20 50 25S50 80 85 60s15-50 45-40"/><circle cx="15" cy="70" r="5"/><circle cx="130" cy="20" r="5"/></svg></div></div>
      <button class="btn secondary" data-action="run-add">${icon('plus',18)} ランを記録</button>
    </section>
    <section class="card week-summary">${sectionHead('この7日間','続けた日も、休んだ日も。')}
      <div class="week-strip">${dates.map(day=>{const count=(state.wake[day]?1:0)+state.runs.filter(r=>r.date===day).length+Object.values(state.habitLogs).filter(logs=>logs[day]!==undefined&&logs[day]!==false).length;return `<button class="week-day ${day===today?'today':''} ${count?'has-record':''}" data-action="select-date" data-date="${day}" aria-label="${e(day)}、${count}件の記録"><span>${['日','月','火','水','木','金','土'][new Date(day+'T12:00:00').getDay()]}</span><strong>${Number(day.slice(-2))}</strong><i>${count?icon('check',14):''}</i></button>`;}).join('')}</div>
      <p class="week-footnote">${dates.filter(d=>state.wake[d]||state.runs.some(r=>r.date===d)||Object.values(state.habitLogs).some(log=>log[d]!==undefined&&log[d]!==false)).length}日分の記録があります。</p>
    </section>
  </div>`;
}
