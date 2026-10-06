import {e, icon} from './ui.js';

/** Ordinary links retain native Tab/Enter, modified-click and browser history behavior. */
export function renderNavigation(routes, current) {
  return `<nav id="page-navigation" class="page-navigation" aria-label="メインナビゲーション">${Object.entries(routes).map(([key, route]) => `<a class="page-link" data-route="${e(key)}" href="#${e(key)}" aria-label="${e(route.label)}"${current === key ? ' aria-current="page"' : ''}>${icon(route.icon, 22)}<span class="page-current" aria-hidden="true"></span><span class="page-tooltip" role="tooltip" aria-hidden="true">${e(route.label)}</span></a>`).join('')}</nav>`;
}

/** Tooltip dismissal never rebuilds the app or touches record/editor state. */
export function bindNavigationTooltips(document) {
  const linkFor = target => target?.closest?.('#page-navigation .page-link');
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const visible = document.querySelectorAll?.('#page-navigation .page-link:hover, #page-navigation .page-link:focus-visible') || [];
    const links = new Set([linkFor(event.target), ...visible]);
    for (const link of links) link?.setAttribute('data-tooltip-dismissed', 'true');
  });
  document.addEventListener('focusout', event => {
    linkFor(event.target)?.removeAttribute('data-tooltip-dismissed');
  });
  document.addEventListener('pointerout', event => {
    const link = linkFor(event.target);
    if (link && !link.contains(event.relatedTarget)) link.removeAttribute('data-tooltip-dismissed');
  });
}
