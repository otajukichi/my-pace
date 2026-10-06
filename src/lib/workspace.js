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
export function pageCapacity(width = 1024, height = 768) {
  // Budget includes header, title, tabs, list title, pager, and safe-area breathing room.
  return Math.max(1, Math.min(7, Math.floor((height - (width <= 600 ? 350 : 425)) / 80)));
}
export const summaryStat=(label,value,unit='',detail='')=>`<div class="stat"><span>${e(label)}</span><strong>${e(value)}${unit?`<em>${e(unit)}</em>`:''}</strong>${detail?`<small>${e(detail)}</small>`:''}</div>`;
