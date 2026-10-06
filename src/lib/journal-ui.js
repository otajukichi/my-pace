import {e, icon} from './ui.js';

/** Pagination is shared by journal views; every record remains reachable. */
export function pageItems(items, requested = 0, size = 3) {
  const pageSize = Number.isInteger(size) && size > 0 ? size : 3;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(totalPages - 1, Math.max(0, Number.isFinite(requested) ? Math.floor(requested) : 0));
  const start = page * pageSize;
  return {items: items.slice(start, start + pageSize), page, totalPages, start,
    end: Math.min(start + pageSize, items.length), total: items.length};
}

export function pageControls(pagination, label = '記録') {
  const {page, totalPages, start, end, total} = pagination;
  if (!total) return '';
  return `<nav class="pagination" aria-label="${e(label)}のページ切り替え"><span class="pagination-summary">${start + 1}–${end} / ${total}</span><div class="pagination-actions"><button class="icon-button" type="button" data-action="view-page" data-page="${page - 1}" aria-label="前のページ" ${page === 0 ? 'disabled' : ''}>${icon('left',18)}</button><span class="pagination-position" aria-live="polite">${page + 1} / ${totalPages}</span><button class="icon-button" type="button" data-action="view-page" data-page="${page + 1}" aria-label="次のページ" ${page === totalPages - 1 ? 'disabled' : ''}>${icon('right',18)}</button></div></nav>`;
}

/** Preserve every character, including whitespace, without splitting surrogate pairs. */
export function textPages(text = '', maxCharacters = 220, maxLines = 8, maxColumns = 36) {
  if (!text) return [];
  const limit = Math.max(1, Number.isInteger(maxCharacters) ? maxCharacters : 220);
  const lineLimit = Math.max(1, Number.isInteger(maxLines) ? maxLines : 8);
  const columns = Math.max(4, Number.isInteger(maxColumns) ? maxColumns : 36);
  const pages = [];
  let part = '', characters = 0, lines = 1, column = 0;
  for (const character of Array.from(String(text))) {
    // A conservative line budget also keeps Japanese text readable in narrow panes.
    const width = character === '\t' ? 4 : character.codePointAt(0) >= 0x1100 ? 2 : 1;
    const lineBreak = character === '\n' || column + width > columns;
    if (part && (characters >= limit || (lineBreak && lines >= lineLimit))) {
      pages.push(part); part = ''; characters = 0; lines = 1; column = 0;
    }
    part += character; characters += 1;
    if (character === '\n') { lines += 1; column = 0; }
    else {
      if (column + width > columns) { lines += 1; column = 0; }
      column += width;
    }
  }
  if (part) pages.push(part);
  return pages;
}

export const MOOD_LABELS = Object.freeze({bright:'晴れやか', calm:'おだやか', tired:'おつかれ', low:'しずかに'});
export function moodPill(mood) {
  return MOOD_LABELS[mood] ? `<span class="mood-pill mood-${e(mood)}"><i aria-hidden="true"></i>${e(MOOD_LABELS[mood])}</span>` : '';
}
export function shortText(text, limit = 72) {
  const characters = Array.from(String(text || '').replace(/\s+/g, ' ').trim());
  return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : characters.join('');
}
