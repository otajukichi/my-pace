import {e, icon, sectionHead, empty, dayLabel} from '../lib/ui.js';
import {isDateKey, todayKey} from '../lib/domain.js';
import {pageItems, pageControls, textPages, shortText, moodPill} from '../lib/journal-ui.js';

export function renderDiary({state, date, today = todayKey(), tab = 'entry', page = 0, pageSize = 3} = {}) {
  const selected = isDateKey(date) ? date : today;
  const diary = state.diary || {};
  const entries = Object.entries(diary).sort(([a], [b]) => b.localeCompare(a));
  if (tab === 'history') {
    const pagination = pageItems(entries, page, pageSize);
    return `<div class="view-stack diary-view"><section class="card diary-history-card">${sectionHead('日々のことば', `${entries.length}日分の日記`, `<button class="btn primary small" type="button" data-action="diary-edit" data-date="${selected}">${icon('edit',17)} 日記を書く</button>`)}${entries.length ? `<div class="diary-history-list">${pagination.items.map(([day, entry]) => `<button class="diary-history-row" type="button" data-action="diary-day" data-date="${e(day)}" aria-label="${e(day)}の日記を開く"><span class="diary-history-date"><span>${e(day.slice(0,4))}</span><strong>${e(day.slice(5).replace('-', '/'))}</strong></span><span class="diary-history-copy">${moodPill(entry.mood)}<span>${e(shortText(entry.text,70) || '気分の記録')}</span></span>${icon('right',18)}</button>`).join('')}</div>${pageControls(pagination,'日記')}` : empty('何でもない日も、残しておこう。','その日の気分や、心に残ったことをひとことから。','edit')}</section></div>`;
  }
  const entry = diary[selected];
  const pages = textPages(entry?.text || '',220,Math.min(8,Math.max(3,pageSize+1)));
  const pagination = pageItems(pages, page, 1);
  return `<div class="view-stack diary-view"><section class="card diary-card"><div class="diary-heading"><div><span class="eyebrow">A PAGE OF MY DAY</span><h2>${e(dayLabel(selected))}</h2><p class="muted">${selected === today ? '今日のこと、今の気持ち。' : 'この日のことを、ゆっくりと。'}</p></div>${entry ? moodPill(entry.mood) : ''}</div>${entry ? `<div class="diary-paper"><div class="diary-paper-label">${icon('edit',15)} ${e(selected)}</div><p class="diary-text">${pages.length ? e(pagination.items[0]) : '気分だけを残した日。'}</p></div>${pages.length > 1 ? pageControls(pagination,'本文') : ''}<div class="diary-footer"><span class="muted">${Array.from(entry.text || '').length.toLocaleString('ja-JP')}文字${pages.length > 1 ? ' · 本文はページでめくれます' : ''}</span><button class="btn secondary small" type="button" data-action="diary-edit" data-date="${selected}">${icon('edit',16)} 編集する</button></div>` : `<div class="diary-paper diary-paper-empty"><span class="diary-empty-mark" aria-hidden="true">${icon('leaf',38)}</span><h3>一日の、小さなしおり。</h3><p>うれしかったこと。おいしかったもの。<br>今日は休んだ、のひとことでも。</p><button class="btn primary" type="button" data-action="diary-edit" data-date="${selected}">${icon('plus',18)} この日の日記を書く</button></div><div class="diary-footer"><span class="muted">書いた内容は、このブラウザーに保存されます。</span></div>`}</section></div>`;
}
