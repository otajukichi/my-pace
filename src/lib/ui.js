import {isHabitComplete} from './domain.js';
/** Markup utilities. All user-controlled values must pass through escapeHTML. */
export function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
export const e = escapeHTML;
const paths = {
  home: '<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
  run: '<circle cx="15" cy="4" r="2"/><path d="m6 10 4-3 5 3 3 1 3-2M9 21l3-7m-8 4 4-2 2-5m2 3 4 3v5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  habits: '<rect x="4" y="4" width="16" height="17" rx="4"/><path d="M8 2v4m8-4v4M8 12l2 2 5-5m-7 8h7"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="12" r="2" fill="currentColor"/><circle cx="10" cy="18" r="2" fill="currentColor"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  left: '<path d="m15 6-6 6 6 6"/>', right: '<path d="m9 6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', close:'<path d="m6 6 12 12M6 18 18 6"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 16v5h16v-5"/>',
  leaf: '<path d="M20 3C5 2 2 9 6 16s15 6 14-13ZM6 19l9-11"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',
  archive: '<path d="M4 8v13h16V8M3 3h18v5H3Zm6 9h6"/>',
};
export function icon(name, size = 22) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.leaf}</svg>`;
}
export function dayLabel(day, short = false) {
  const date = new Date(`${day}T12:00:00`);
  return new Intl.DateTimeFormat('ja-JP', short ? {month:'numeric',day:'numeric'} : {month:'long',day:'numeric',weekday:'long'}).format(date);
}
export function empty(title, description, iconName = 'leaf') {
  return `<div class="empty"><span class="empty-icon">${icon(iconName,28)}</span><p>${e(title)}</p><span>${e(description)}</span></div>`;
}
export function sectionHead(title, subtitle = '', action = '') {
  return `<div class="section-head"><div><h2>${e(title)}</h2>${subtitle ? `<p>${e(subtitle)}</p>`:''}</div>${action}</div>`;
}
export const smallLink = (href, label) => `<a class="text-link" href="#${href}">${e(label)} ${icon('arrow',17)}</a>`;
export function habitValue(habit, value) {
  if (value === undefined) return 'まだ';
  return habit.type === 'check' ? (value ? 'できた' : 'まだ') : `${Number(value).toLocaleString('ja-JP')} ${habit.type === 'time' ? '分' : e(habit.unit || '')}`;
}
export function isDone(habit, value) {
  return isHabitComplete(habit, value);
}
