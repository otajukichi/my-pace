import {e,icon} from './ui.js';
/** Every record remains reachable: page is clamped after delete, undo, and resize. */
export function paginate(items, page = 0, size = 4) {
  const perPage = Number.isInteger(size) ? Math.max(1, Math.min(12, size)) : 4;
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.max(0, Math.min(pages - 1, Number.isInteger(page) ? page : 0));
  return {items:items.slice(current * perPage, (current + 1) * perPage),page:current,pages,total:items.length,size:perPage};
}
export function pager(result, label = '記録') {
  return `<nav class="pagination" aria-label="${e(label)}のページ"><span>${result.total ? `${result.page*result.size+1}–${Math.min(result.total,(result.page+1)*result.size)} / ${result.total}件` : '0件'}</span><div><button class="icon-button" data-action="view-page" data-page="${result.page-1}" aria-label="前のページ" ${result.page===0?'disabled':''}>${icon('left',18)}</button><span aria-live="polite">${result.page+1} / ${result.pages}</span><button class="icon-button" data-action="view-page" data-page="${result.page+1}" aria-label="次のページ" ${result.page===result.pages-1?'disabled':''}>${icon('right',18)}</button></div></nav>`;
}
/** Matches the three topbar layouts; mobile keeps all eight 44px targets visible. */
export function navigationHeight(width = 1024) {
  return width <= 419 ? 144 : width <= 759 ? 96 : 56;
}
function navigationExtra(width) {
  return navigationHeight(width) - (width <= 600 ? 52 : 56);
}
export function pageCapacity(width = 1024, height = 768) {
  // Header, title, tabs, list title, pager, and safe-area breathing room.
  return Math.max(1, Math.min(7, Math.floor((height - (width <= 600 ? 350 : 425) - navigationExtra(width)) / 80)));
}
export function habitPageCapacity(width = 1024, height = 768) {
  return Math.max(1, Math.min(3, Math.floor((height - 390 - navigationExtra(width)) / 110)));
}
export const summaryStat=(label,value,unit='',detail='')=>`<div class="stat"><span>${e(label)}</span><strong>${e(value)}${unit?`<em>${e(unit)}</em>`:''}</strong>${detail?`<small>${e(detail)}</small>`:''}</div>`;
