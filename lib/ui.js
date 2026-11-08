const paths = {
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-3 5-5 3 3-5 5-3z"/>',
  turn: '<path d="M7 20V8a5 5 0 0 1 10 0v7m-4-4 4 4 4-4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  chat: '<path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-7a8 8 0 1 1 18-3Z"/><path d="M7 9h8M7 13h5"/>',
  run: '<circle cx="15" cy="4" r="2"/><path d="m12 8 4 3 4-1M7 21l4-6-3-3 4-5-5 2-2 4m7 2 4 2 1 4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5h2m4 0h2"/>',
  note: '<path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9M8 16l1-4L18 3l3 3-9 9z"/>',
  settings: '<path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 16v-3a4 4 0 0 1 4-4h4a4 4 0 0 0 4-4M8 18h7a3 3 0 0 0 0-6h-5"/>',
  pace: '<path d="M3 16a9 9 0 1 1 18 0M12 14l5-6"/><circle cx="12" cy="14" r="1.5"/>',
  star: '<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4L2.8 9.7l6.4-.9z"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  book: '<path d="M12 6s-4-3-9-2v15s5-1 9 2c4-3 9-2 9-2V4c-5-1-9 2-9 2zM12 6v15"/>',
  stretch: '<circle cx="12" cy="4" r="2"/><path d="m4 8 8 3 8-3M12 10v6m-6 6 6-6 6 6"/>',
  headphones: '<path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  cloud: '<path d="M6 18h12a4 4 0 0 0 0-8h-1a6 6 0 0 0-11-2 5 5 0 0 0 0 10z"/>',
  rain: '<path d="M6 15a5 5 0 0 1 0-10 6 6 0 0 1 11 2 4 4 0 0 1 1 8M8 18l-1 3m6-3-1 3m6-3-1 3"/>',
  snow: '<path d="M12 3v18M4 7l16 10M4 17 20 7m-12-2 4 3 4-3M8 19l4-3 4 3"/>',
  storm: '<path d="M7 15a5 5 0 0 1 0-10 6 6 0 0 1 10 2 4 4 0 0 1 1 8m-6-4-3 6h5l-3 5"/>',
  leaf: '<path d="M20 3C9 2 2 7 4 15c2 8 16 8 16-12zM5 19 15 9"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
};
export const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.leaf}</svg>`;
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export const $ = (selector, root = document) => root.querySelector(selector);
export const shortDate = value => `${Number(value.slice(5,7))}/${Number(value.slice(8,10))}`;
export const dayLabel = value => new Intl.DateTimeFormat('ja-JP',{month:'numeric',day:'numeric',weekday:'short',timeZone:'Asia/Tokyo'}).format(new Date(`${value}T12:00:00+09:00`));
export const pace = seconds => {const s=Math.round(seconds||0);return `${Math.floor(s/60)}′${String(s%60).padStart(2,'0')}″`;};
export const durationLabel = seconds => {const s=Math.round(seconds||0);return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;};
export const km = meters => (meters/1000).toFixed(2);
