import { THEME_PACKS, DEFAULT_THEME_PACK, THEME_MODES, THEME_NAMES, resolveTheme } from './theme-packs.js';
import { icon, esc } from './ui.js';

const PAGES = [
  { id: 'home', label: 'ホーム', icon: 'home' },
  { id: 'records', label: 'ランニング', icon: 'run' },
  { id: 'english', label: '英会話', icon: 'chat' },
];
const pageFor = value => PAGES.find(page => page.id === value) || PAGES[0];
const packFor = value => THEME_PACKS.find(pack => pack.id === value) || THEME_PACKS.find(pack => pack.id === DEFAULT_THEME_PACK);
const modeIcon = mode => ({ auto: 'clock', morning: 'sun', day: 'sun', night: 'moon' })[mode];
const packSubtitle = pack => pack.timeAware
  ? (pack.pageAware ? 'ページと時間、それぞれの表情' : '朝・昼・晩、いつもの配色')
  : (pack.pageAware ? 'ページに合わせて切り替わる配色' : 'いつでも同じ配色');

function previewStyle(theme) {
  const keys = ['paper', 'surface', 'panel', 'bg', 'ink', 'muted', 'line', 'header', 'header-ink', 'track', 'primary', 'gold', 'anchor'];
  return keys.map(key => `--preview-${key}:${esc(theme.tokens[key])}`).join(';');
}

function swatches(theme, className = '') {
  return `<span class="theme-palette ${className}" aria-hidden="true">${['paper', 'bg', 'panel', 'track', 'header', 'gold'].map(key => `<i style="background:${esc(theme.tokens[key])}"></i>`).join('')}</span>`;
}

function miniApp(page, theme) {
  let body;
  if (page === 'records') {
    body = `<span class="theme-mini-running"><span class="theme-mini-sidebar"><i></i><strong></strong><span class="theme-mini-heat">${Array.from({ length: 28 }, (_, i) => `<i class="${[1, 4, 8, 11, 15, 17, 19, 22, 26].includes(i) ? 'is-lit' : ''}"></i>`).join('')}</span><span class="theme-mini-stats"><i></i><i></i></span></span><span class="theme-mini-map"><svg viewBox="0 0 180 120" fill="none"><path class="theme-mini-roads" d="M0 27 180 66M24 0 62 120M104 0 77 120M0 87 180 28M163 0 132 120"/><path class="theme-mini-route" d="M125 29 77 22 39 46 48 90 113 99 140 69 125 29Z"/><circle cx="125" cy="29" r="4"/></svg><i></i></span></span>`;
  } else if (page === 'english') {
    body = `<span class="theme-mini-english"><span class="theme-mini-orbit"><svg viewBox="0 0 170 130" fill="none"><ellipse cx="85" cy="65" rx="61" ry="46"/><ellipse cx="85" cy="65" rx="29" ry="46" transform="rotate(-28 85 65)"/><path d="M24 65c18-28 105-28 122 0M24 65c18 28 105 28 122 0"/></svg><i></i><i></i><i></i><i></i></span><span class="theme-mini-room"><span>${icon('chat')}</span><i></i><i></i><b></b></span></span>`;
  } else {
    body = `<span class="theme-mini-home"><span class="theme-mini-calendar"><i class="theme-mini-title"></i><span>${Array.from({ length: 14 }, (_, i) => `<i class="${[2, 5, 7, 10, 13].includes(i) ? 'is-quiet' : ''}"></i>`).join('')}</span></span><span class="theme-mini-day"><i class="theme-mini-ring"></i><span><i></i><i></i><i></i></span></span></span>`;
  }
  return `<span class="theme-mini-app" style="${previewStyle(theme)}" aria-hidden="true"><span class="theme-mini-header"><i></i><span></span><b></b></span>${body}</span>`;
}

/** Compact entry inside the existing account settings. */
export function themeSettings(state) {
  const pack = packFor(state.pack);
  const theme = resolveTheme({ pack: pack.id, mode: state.active || 'day', page: state.page || 'home' });
  const status = pack.timeAware ? (state.mode === 'auto' ? '時間に合わせて' : `${THEME_NAMES[state.active] || ''}の配色に固定`) : pack.pageAware ? 'ページに合わせて' : '固定の配色';
  return `<section class="theme-settings theme-settings-entry" id="theme-settings"><div class="between"><h3>テーマ</h3><span class="form-hint">${status}</span></div><button class="theme-settings-open" data-action="theme-picker"><span class="theme-entry-art" style="${previewStyle(theme)}" aria-hidden="true"><i></i><i></i><i></i></span><span class="theme-entry-copy"><strong>${esc(pack.name)}</strong><small>${packSubtitle(pack)}</small></span>${swatches(theme)}${icon('chevron')}</button></section>`;
}

/** Palette previews are isolated; only choosing a pack or time mode applies it. */
export function themePicker(state, { previewPage = state.page, previewTime = state.active } = {}) {
  const page = pageFor(previewPage), actualPage = pageFor(state.page), pack = packFor(state.pack);
  const time = ['morning', 'day', 'night'].includes(previewTime) ? previewTime : 'day';
  const currentTheme = resolveTheme({ pack: pack.id, mode: state.active || 'day', page: state.page || 'home' });
  return `<div class="theme-picker" id="theme-picker">
    <div class="theme-picker-intro"><p>いつもの場所を、好きな色で。</p><span>パックを選ぶと、そのまま画面に反映します。</span></div>
    <div class="theme-preview-toolbar"><span>ページの配色見本</span><div class="theme-preview-pages" role="group" aria-label="見本のページ">${PAGES.map(item => `<button type="button" data-theme-preview-page="${item.id}" aria-pressed="${page.id === item.id}">${icon(item.icon)}<span>${item.label}</span></button>`).join('')}</div></div>
    <div class="theme-pack-list" role="group" aria-label="テーマパック">${THEME_PACKS.map(item => {
      const theme = resolveTheme({ pack: item.id, mode: time, page: page.id });
      const chosen = pack.id === item.id;
      return `<button class="theme-pack-card ${chosen ? 'is-selected' : ''}" type="button" data-theme-pack="${esc(item.id)}" aria-pressed="${chosen}" aria-label="${esc(item.name)}${chosen ? '、使用中' : 'を使う'}">${miniApp(page.id, theme)}<span class="theme-pack-copy"><span class="theme-pack-name"><strong>${esc(item.name)}</strong><span class="theme-pack-selected">${chosen ? icon('check') + '使用中' : '<i></i>'}</span></span><span class="theme-pack-description">${esc(item.description)}</span><span class="theme-pack-foot"><span class="theme-pack-capabilities">${item.timeAware ? `${icon('clock')}時間` : ''}${item.pageAware ? `${icon('grid')}ページ` : ''}${!item.timeAware && !item.pageAware ? 'いつでも同じ配色' : ''}</span>${swatches(theme)}</span></span></button>`;
    }).join('')}</div>
    <section class="theme-time-section" aria-labelledby="theme-time-heading"><div class="theme-time-heading"><h3 id="theme-time-heading">時間による変化</h3><span>${pack.timeAware ? `${THEME_NAMES[time]}の配色を表示中` : 'このパックでは変わりません'}</span></div>${pack.timeAware ? `<div class="theme-time-options" role="group" aria-label="時間帯の設定">${THEME_MODES.map(mode => `<button type="button" data-theme-mode="${mode}" aria-pressed="${state.mode === mode}">${icon(modeIcon(mode))}<span>${mode === 'auto' ? '自動' : THEME_NAMES[mode]}</span>${mode === 'auto' ? '<small>日本時間</small>' : ''}</button>`).join('')}</div><p class="theme-time-note">自動：朝 5–11時 / 昼 11–18時 / 晩 18–翌5時。選んだ時間帯で固定もできます。</p>` : `<p class="theme-time-note">${pack.pageAware ? 'ページごとに決まった配色を使います。' : 'どのページでも同じ配色を使います。'}時間帯で変わるパックへ戻すと、前の時間設定を引き継ぎます。</p>`}</section>
    <div class="theme-picker-footer"><button class="text-button" data-action="settings">${icon('left')} 設定に戻る</button><span class="theme-applied-state" role="status"><i style="background:${esc(currentTheme.tokens.track)}"></i>${esc(pack.name)} · ${esc(actualPage.label)}${pack.timeAware ? ` · ${THEME_NAMES[state.active] || THEME_NAMES[time]}${state.mode === 'auto' ? '（自動）' : '（固定）'}` : ''}<small>このブラウザに保存</small></span></div>
  </div>`;
}
