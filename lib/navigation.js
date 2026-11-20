import { icon, esc } from './ui.js';

// Shared navigation metadata. Each activity owns its contents and state.
export const PAGES = Object.freeze([
  { id: 'home', href: '#home', label: 'ホーム', icon: 'home', category: false },
  { id: 'records', href: '#records', label: 'ランニング', icon: 'run', category: true },
  { id: 'english', href: '#english', label: '英会話', icon: 'chat', category: true },
].map(Object.freeze));

export function pageForHash(hash) {
  if (!hash || hash === '#') return PAGES.find(page => page.id === 'home');
  // Preserve the running entry point and bookmarks for the retired planner.
  return PAGES.find(page => page.href === hash) || PAGES.find(page => page.id === 'records');
}

export function categoryNavigation(activeId) {
  return PAGES.filter(page => page.category).map(page =>
    `<a class="nav-link ${page.id === activeId ? 'active' : ''}" href="${page.href}" ${page.id === activeId ? 'aria-current="page"' : ''}>${icon(page.icon)}<span>${esc(page.label)}</span></a>`
  ).join('');
}

export function placeholderPage(page) {
  return `<div class="category-placeholder"><div class="category-symbol" aria-hidden="true">${icon(page.icon)}</div><h1 id="category-title">${esc(page.label)}</h1><p>このページは準備中です。</p></div>`;
}
