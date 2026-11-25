import { HOME_ACTIVITIES, buildHomeMonth, toggleHabit } from './home-model.js';
import { createHomeMotion, orbitPath } from './home-motion.js';
import { createEnglishStore, ENGLISH_STORAGE_KEY } from './english-model.js';
import { localDate, addDays } from './state.js';
import { shiftMonth, dayInMonth } from './running-calendar.js';
import { esc, icon, dayLabel } from './ui.js';

const quantity = value => new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 }).format(value);
const dateTitle = date => `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`;
const weekday = date => new Intl.DateTimeFormat('ja-JP', { weekday: 'long', timeZone: 'Asia/Tokyo' }).format(new Date(`${date}T12:00:00+09:00`));

function orbit(day, large = false) {
  const sector = 100 / HOME_ACTIVITIES.length, length = sector - 5;
  return `<svg class="home-orbit ${large ? 'is-large' : ''}" viewBox="0 0 100 100" aria-hidden="true">${HOME_ACTIVITIES.map((activity, index) => {
    const start = index * sector + 2.5, filled = length * (day.ratios[activity.id] || 0);
    return `<g class="home-color-${activity.id}"><path data-orbit-track d="${orbitPath()}" pathLength="100" stroke-dasharray="${length} 100" stroke-dashoffset="${-start}"/><path data-orbit-arc data-length="${filled}" data-start="${start}" d="${orbitPath()}" pathLength="100" stroke-dasharray="${filled} 100" stroke-dashoffset="${-start}"/></g>`;
  }).join('')}</svg>`;
}

/** Home is a projection of activity records; it never generates practice history. */
export function mountHome(root, { getContext, updateWorkspace, openDiary, openDialog, dialog, onRunningDay, onRunningMonth, openAccount, retryRunning, ui = {} }) {
  let context = getContext(), english = createEnglishStore(), englishState = english.get();
  let today = localDate(), month = ui.month || today.slice(0, 7), selected = ui.selected || today;
  let model, signature = '', habitPage = 0, editedHabit = null, destroyed = false;
  const motion = createHomeMotion(root);
  const phone = window.matchMedia('(max-width:760px)');
  let habitPageSize = phone.matches ? 2 : 3;
  const q = selector => root.querySelector(selector);

  root.classList.add('home-page');
  root.setAttribute('aria-labelledby', 'home-title');
  root.innerHTML = `<div class="home-shell">
    <header class="home-intro home-reveal"><div><span class="home-eyebrow">MY SPACE</span><h1 id="home-title"></h1><p class="home-today-label"></p></div><div class="home-intro-flourish" aria-hidden="true"><span></span><span></span><span></span><i></i></div><div class="home-month-heading"><span>この月に取り組んだ日</span><div><strong class="home-active-days">0</strong><small>日</small></div></div></header>
    <div class="home-layout">
      <section class="home-calendar home-reveal" aria-label="取り組みのカレンダー">
        <div class="home-calendar-heading"><div><span class="home-eyebrow">DAY BY DAY</span><h2>日々の積み重ね</h2></div><div class="home-month-nav"><button data-home-action="previous-month" aria-label="前の月">${icon('left')}</button><span class="home-month-label" aria-live="polite"></span><button data-home-action="next-month" aria-label="次の月">${icon('chevron')}</button></div></div>
        <div class="home-calendar-tools"><div class="home-legend">${HOME_ACTIVITIES.map(activity => `<span class="home-color-${activity.id}"><i></i>${esc(activity.label)}</span>`).join('')}</div><button class="home-calendar-help" data-home-action="help" aria-label="円の見方">円の見方 <span>?</span></button></div>
        <div class="home-weekdays" aria-hidden="true">${['月', '火', '水', '木', '金', '土', '日'].map(day => `<span>${day}</span>`).join('')}</div>
        <div class="home-calendar-grid" role="group" aria-label="日付を選ぶ"></div>
        <div class="home-month-totals"></div><div class="home-source-status" role="status"></div>
      </section>
      <aside class="home-aside" aria-label="選んだ日の記録">
        <section class="home-day-detail home-reveal" aria-label="この日の取り組み"></section>
        <section class="home-habits home-reveal" aria-labelledby="home-habits-title"></section>
        <section class="home-diary home-reveal" aria-label="日記"></section>
      </aside>
    </div>
  </div>`;

  function build() {
    return buildHomeMonth({ month, today, runs: context.runs, englishRecords: englishState.records, workspace: context.workspace });
  }
  function selectedRecord() { return model.days.get(selected); }
  function persistUI() { ui.month = month; ui.selected = selected; }
  function updateGreeting() {
    q('#home-title').textContent = context.name ? `おかえりなさい、${context.name}さん。` : 'おかえりなさい。';
    q('.home-today-label').textContent = `${dateTitle(today)} ${weekday(today)}`;
    q('.home-active-days').textContent = model.summary.activeDays;
  }
  function sourceStatus() {
    let message = '', action = '', label = '';
    if (context.source === 'checking') message = 'ランニングの接続を確認しています';
    else if (context.source === 'guest') { message = 'ランニングはGoogleログイン後に表示'; action = 'account'; label = 'ログイン'; }
    else if (context.source === 'unavailable') { message = 'ランニングの接続を確認できませんでした'; action = 'retry'; label = '再確認'; }
    else if (context.runsError) { message = 'ランニングを読み込めませんでした'; action = 'retry'; label = '再読込'; }
    else if (!context.runsLoaded) message = 'ランニングの記録を読み込み中';
    else message = '空白は、取り込まれた記録がない日。';
    if (english.status().error) message += ' 英会話の保存データを読み込めませんでした。';
    return `<span>${esc(message)}</span>${action ? `<button data-home-action="${action}">${label} ${icon('arrow')}</button>` : `<span class="home-diary-key">${icon('note')} 日記あり</span>`}`;
  }
  function calendar() {
    q('.home-month-label').innerHTML = `<small>${month.slice(0, 4)}</small><strong>${Number(month.slice(5))}月</strong>`;
    q('[data-home-action="next-month"]').disabled = month >= today.slice(0, 7);
    q('.home-calendar-grid').style.setProperty('--home-weeks', model.weeks);
    q('.home-calendar-grid').innerHTML = model.cells.map(day => {
      const description = [day.running.count ? `${quantity(day.running.distanceMeters / 1000)} km` : '', day.english.count ? `英語 ${day.english.count}回` : '', day.habits.completed ? `習慣 ${day.habits.completed}/${day.habits.total}` : '', day.diary.hasEntry ? '日記あり' : ''].filter(Boolean).join('、');
      return `<button type="button" class="home-day ${day.inMonth ? '' : 'outside'} ${day.future ? 'future' : ''} ${day.activeCount ? 'has-record' : ''} ${day.date === selected ? 'selected' : ''}" data-home-day="${day.date}" ${!day.inMonth || day.future ? 'disabled' : ''} tabindex="${day.date === selected ? 0 : -1}" aria-pressed="${day.date === selected}" ${day.date === today ? 'aria-current="date"' : ''} aria-label="${dayLabel(day.date)}、${description || (day.future ? 'これからの日' : '記録なし')}" title="${dayLabel(day.date)} · ${description || '記録なし'}"><span class="home-day-disc">${orbit(day)}<span class="home-day-number">${day.dayNumber}</span></span><span class="home-day-foot">${day.diary.hasEntry ? icon('note') : '<i></i>'}${day.date === today ? '<span>今日</span>' : ''}</span></button>`;
    }).join('');
    const totals = model.summary;
    const runningReady = context.runsLoaded && !context.runsError && ['local', 'drive'].includes(context.source);
    const englishReady = !english.status().error;
    q('.home-month-totals').innerHTML = `<button class="home-color-running" data-home-action="running-month"><span>${icon('run')}走った距離</span><strong>${runningReady ? quantity(totals.distanceMeters / 1000) : '—'}<small>${runningReady ? 'km' : ''}</small></strong></button><a class="home-color-english" href="#english"><span>${icon('chat')}英語の練習</span><strong>${englishReady ? totals.englishSessions : '—'}<small>${englishReady ? '回' : ''}</small></strong></a><div class="home-color-habits"><span>${icon('check')}習慣のチェック</span><strong>${totals.habitChecks}<small>個</small></strong></div>`;
    q('.home-source-status').innerHTML = sourceStatus();
    updateGreeting();
  }
  function detail() {
    const day = selectedRecord();
    const unavailable = ['guest', 'checking', 'unavailable'].includes(context.source) || !context.runsLoaded || context.runsError;
    q('.home-day-detail').innerHTML = `<div class="home-detail-heading"><div><span class="home-eyebrow">${selected === today ? 'TODAY' : 'YOUR DAY'}</span><h2><time datetime="${selected}">${dateTitle(selected)}</time><small>${weekday(selected)}</small></h2></div>${selected === today ? `<span class="home-today-dot">今日</span>` : '<button class="home-today-button" data-home-action="today">今日へ戻る</button>'}</div>
      <div class="home-day-overview"><div class="home-large-disc">${orbit(day, true)}<div class="home-orbit-center"><strong>${day.activeCount || '—'}</strong><span>${day.activeCount ? '取り組みの記録' : 'まだ記録なし'}</span></div></div>
      <div class="home-day-facts"><button class="home-color-running" data-home-action="running-day"><span><i></i>ランニング ${icon('chevron')}</span><strong>${unavailable ? '—' : quantity(day.running.distanceMeters / 1000)}<small>${unavailable ? '' : 'km'}</small></strong></button><a class="home-color-english" href="#english"><span><i></i>英会話 ${icon('chevron')}</span><strong>${english.status().error ? '—' : day.english.count}<small>${english.status().error ? '' : '回'}</small></strong></a><button class="home-color-habits" data-home-action="focus-habits"><span><i></i>小さな習慣</span><strong>${day.habits.completed}<small>/ ${day.habits.total}</small></strong></button></div></div>`;
  }
  function habits() {
    const all = context.workspace.habits, day = selectedRecord();
    habitPage = Math.min(habitPage, Math.max(0, Math.ceil(all.length / habitPageSize) - 1));
    const visible = all.slice(habitPage * habitPageSize, (habitPage + 1) * habitPageSize);
    q('.home-habits').innerHTML = `<div class="home-section-heading"><h2 id="home-habits-title">小さな習慣 <span>${day.habits.completed}<small> / ${all.length}</small></span></h2><button data-home-action="add-habit" aria-label="習慣を追加" ${all.length >= 100 ? 'disabled' : ''}>${icon('plus')}</button></div>
      <div class="home-habit-list" style="--home-habit-rows:${habitPageSize}">${visible.length ? visible.map(habit => {
        const checked = day.habits.ids.includes(habit.id);
        return `<div class="home-habit-row ${checked ? 'is-checked' : ''}"><button role="checkbox" aria-checked="${checked}" class="home-habit-check" data-home-habit="${esc(habit.id)}"><span class="home-check-box">${icon('check')}</span><span>${esc(habit.name)}</span></button><button class="home-habit-edit" data-home-edit="${esc(habit.id)}" aria-label="${esc(habit.name)}を編集">${icon('note')}</button></div>`;
      }).join('') : '<button class="home-habit-empty" data-home-action="add-habit">ひとつ、習慣を置いてみる。 '+icon('plus')+'</button>'}</div>
      <div class="home-habit-foot"><span>${selected === today ? '今日' : dateTitle(selected)}のチェック · このブラウザに保存</span>${all.length > habitPageSize ? `<div class="home-habit-pager"><button data-home-action="previous-habits" aria-label="前の習慣" ${habitPage === 0 ? 'disabled' : ''}>${icon('left')}</button><span>${habitPage + 1}/${Math.ceil(all.length / habitPageSize)}</span><button data-home-action="next-habits" aria-label="次の習慣" ${(habitPage + 1) * habitPageSize >= all.length ? 'disabled' : ''}>${icon('chevron')}</button></div>` : ''}</div>`;
  }
  function diary() {
    const day = selectedRecord();
    q('.home-diary').innerHTML = `<button class="home-diary-open" data-home-action="diary"><div class="home-diary-heading"><span>${icon('note')} ${selected === today ? '今日の日記' : dateTitle(selected)+'の日記'}</span>${icon('arrow')}</div><p>${day.diary.hasEntry ? esc(day.diary.text.replace(/\s+/g, ' ').slice(0, 160)) : '今日あったこと、考えたこと。'}</p><small>${day.diary.hasEntry ? '続きを書く' : 'ひとことから、自由に。'}<span>このブラウザに保存</span></small></button>`;
  }
  function renderSelected() { detail(); habits(); diary(); }
  function focusDate(date) { q(`[data-home-day="${date}"]`)?.focus({ preventScroll: true }); }
  function selectDate(date, { focus = false } = {}) {
    if (date > today || !model.days.has(date)) return;
    if (!date.startsWith(month)) { setMonth(date.slice(0, 7), date); return; }
    if (date === selected) { if (focus) focusDate(date); return; }
    selected = date; persistUI();
    root.querySelectorAll('[data-home-day]').forEach(button => {
      const active = button.dataset.homeDay === selected;
      button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); button.tabIndex = active ? 0 : -1;
    });
    renderSelected(); motion.detail({ fromDate: date }); if (focus) focusDate(date);
  }
  function setMonth(next, date) {
    if (next > today.slice(0, 7)) return;
    const direction = next < month ? -1 : 1;
    month = next; selected = date || dayInMonth(selected, month, today); habitPage = 0; persistUI();
    model = build(); signature = dataSignature(); calendar(); renderSelected(); motion.calendar(direction);
  }
  function habitEditor(id = null) {
    editedHabit = id;
    const habit = context.workspace.habits.find(item => item.id === id);
    openDialog(habit ? '習慣を編集' : '小さな習慣を追加', `<form id="home-habit-form" class="form"><label class="field">習慣の名前<input name="habit" required maxlength="80" placeholder="例：寝る前にストレッチ" value="${esc(habit?.name || '')}"></label><p class="form-hint">毎日のチェックを、このブラウザに保存します。</p><div class="form-actions">${habit ? '<button class="text-button" type="button" data-home-action="remove-habit">'+icon('trash')+' リストから外す</button>' : ''}<button class="button" type="submit">${habit ? '保存する' : '追加する'} ${icon('check')}</button></div><p id="home-habit-error" class="form-hint" role="alert"></p></form>`);
  }
  function help() {
    openDialog('円の見方', `<div class="home-ring-help"><p>ひとつの円が、ひとつの日。色ごとに別の取り組みを表します。</p>${HOME_ACTIVITIES.map(activity => `<div class="home-color-${activity.id}"><i></i><strong>${activity.label}</strong><span>${activity.id === 'running' ? 'その日に走った記録があると、赤い円弧がつきます。距離は詳細に表示します。' : activity.id === 'english' ? '会話か音読を実施済みにすると、青い円弧がつきます。練習回数は詳細に表示します。' : 'チェックした数に合わせて、金色の円弧が伸びます。'}</span></div>`).join('')}<p>すべての色を毎日埋める必要はありません。空白は、このアプリに記録がない日です。日記は独立した記録として、小さなペンの印で表示します。</p><small>英会話・習慣・日記は、このブラウザに保存した記録です。</small></div>`);
  }
  function click(event) {
    const button = event.target.closest('button, a'); if (!button) return;
    if (button.dataset.homeDay) { selectDate(button.dataset.homeDay); return; }
    if (button.dataset.homeHabit) {
      const id = button.dataset.homeHabit;
      updateWorkspace(state => toggleHabit(state, selected, id, { today }));
      update(); q(`[data-home-habit="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
      motion.refreshDay(selected); motion.detail(); return;
    }
    if (button.dataset.homeEdit) { habitEditor(button.dataset.homeEdit); return; }
    switch (button.dataset.homeAction) {
      case 'previous-month': setMonth(shiftMonth(month, -1)); break;
      case 'next-month': setMonth(shiftMonth(month, 1)); break;
      case 'today': if (month !== today.slice(0, 7)) setMonth(today.slice(0, 7), today); else selectDate(today); break;
      case 'diary': openDiary(selected); break;
      case 'help': help(); break;
      case 'account': openAccount(); break;
      case 'retry': retryRunning(); break;
      case 'running-day': onRunningDay(selected); break;
      case 'running-month': onRunningMonth(month); break;
      case 'focus-habits': q('.home-habit-check, .home-habit-empty')?.focus({ preventScroll: true }); break;
      case 'add-habit': habitEditor(); break;
      case 'previous-habits': habitPage = Math.max(0, habitPage - 1); habits(); q('[data-home-action="next-habits"]')?.focus({ preventScroll: true }); break;
      case 'next-habits': habitPage++; habits(); q('[data-home-action="previous-habits"]')?.focus({ preventScroll: true }); break;
      case 'remove-habit':
        if (!editedHabit) break;
        updateWorkspace(state => { state.habits = state.habits.filter(item => item.id !== editedHabit); });
        dialog.close(); update(); motion.refreshDay(selected); motion.detail(); break;
    }
  }
  function submit(event) {
    if (event.target.id !== 'home-habit-form') return;
    event.preventDefault();
    const name = String(new FormData(event.target).get('habit') || '').trim();
    if (!name) return;
    try {
      updateWorkspace(state => {
        const habit = state.habits.find(item => item.id === editedHabit);
        if (habit) habit.name = name;
        else if (!editedHabit && state.habits.length < 100) state.habits.push({ id: `habit-${crypto.randomUUID()}`, name, icon: 'check' });
      });
      dialog.close(); update();
    } catch { dialog.querySelector('#home-habit-error').textContent = '保存できませんでした。名前を確認してください。'; }
  }
  function keydown(event) {
    const button = event.target.closest('[data-home-day]'); if (!button) return;
    const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 }[event.key];
    if (delta === undefined && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const date = event.key === 'Home' ? `${month}-01` : event.key === 'End' ? (month === today.slice(0, 7) ? today : addDays(`${shiftMonth(month, 1)}-01`, -1)) : addDays(button.dataset.homeDay, delta);
    if (date > today) return;
    if (!date.startsWith(month)) setMonth(date.slice(0, 7), date); else selectDate(date);
    focusDate(date);
  }
  function dataSignature() { return JSON.stringify([today, model.cells, context.name, context.workspace.habits, context.source, context.runsLoaded, context.runsError, english.status().error]); }
  function update() {
    if (destroyed) return;
    const previousRunning = JSON.stringify([context.source, context.runsLoaded, context.runsError, model.summary.distanceMeters]);
    const focus = root.ownerDocument.activeElement?.closest('[data-home-day]')?.dataset.homeDay;
    context = getContext(); today = localDate();
    model = build(); const next = dataSignature(); if (signature === next) return;
    signature = next; calendar(); renderSelected();
    if (focus) focusDate(focus);
    if (previousRunning !== JSON.stringify([context.source, context.runsLoaded, context.runsError, model.summary.distanceMeters]) && context.runsLoaded && !context.runsError) motion.calendar();
  }
  function refreshEnglish(event) {
    if (event?.type === 'storage' && event.key !== ENGLISH_STORAGE_KEY) return;
    english = createEnglishStore(); englishState = english.get(); update();
  }
  function resizeHabits() {
    const previousSize = habitPageSize;
    habitPageSize = phone.matches ? 2 : 3;
    habitPage = Math.floor(habitPage * previousSize / habitPageSize);
    habits();
  }
  phone.addEventListener('change', resizeHabits);
  root.addEventListener('click', click); root.addEventListener('keydown', keydown);
  dialog.addEventListener('click', click); dialog.addEventListener('submit', submit);
  window.addEventListener('storage', refreshEnglish); window.addEventListener('focus', refreshEnglish);
  model = build(); signature = dataSignature(); persistUI(); calendar(); renderSelected(); motion.enter();
  return { update, destroy() {
    destroyed = true; persistUI(); motion.destroy();
    root.removeEventListener('click', click); root.removeEventListener('keydown', keydown);
    dialog.removeEventListener('click', click); dialog.removeEventListener('submit', submit);
    window.removeEventListener('storage', refreshEnglish); window.removeEventListener('focus', refreshEnglish);
    phone.removeEventListener('change', resizeHabits);
    root.classList.remove('home-page');
  } };
}
