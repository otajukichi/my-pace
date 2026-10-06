// UI-only state: never read or write the user's record/backup storage key.
export const SIDEBAR_STORAGE_KEY = 'my-pace.ui.sidebar-collapsed.v1';
export const SIDEBAR_MEDIA_QUERY = '(max-width: 600px)';

export function createSidebarController({document, window, editor, storage = () => globalThis.localStorage}) {
  const media = window.matchMedia?.(SIDEBAR_MEDIA_QUERY);
  let mobile = Boolean(media?.matches), mobileOpen = false, collapsed = false;
  try { collapsed = storage().getItem(SIDEBAR_STORAGE_KEY) === '1'; } catch { /* optional preference */ }
  const find = selector => document.querySelector(selector);
  const panel = () => find('#app-sidebar');
  const toggle = () => find('#sidebar-toggle');
  const isOpen = () => mobile ? mobileOpen : !collapsed;
  const focusable = () => [...panel().querySelectorAll('a[href],button:not([disabled]),[tabindex="0"]')]
    .filter(element => !element.hidden && !element.inert);
  const focusInside = () => (panel()?.querySelector('[aria-current="page"]') || focusable()[0])?.focus();

  function sync() {
    const sidebar = panel();
    if (!sidebar) return;
    const open = isOpen(), modal = mobile && open;
    sidebar.hidden = !open;
    sidebar.inert = !open;
    sidebar.setAttribute('role', modal ? 'dialog' : 'complementary');
    if (modal) sidebar.setAttribute('aria-modal', 'true');
    else sidebar.removeAttribute('aria-modal');
    const button = toggle();
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'メニューを閉じる' : 'メニューを開く');
    button.setAttribute('title', open ? 'メニューを閉じる' : 'メニューを開く');
    find('#sidebar-backdrop').hidden = !modal;
    find('.workspace').inert = modal;
    find('#notice').inert = modal;
    find('.skip-link').inert = modal;
    document.body.classList.toggle('sidebar-collapsed', !mobile && collapsed);
    document.body.classList.toggle('sidebar-drawer-open', modal);
    if (modal && !editor.open && !sidebar.contains(document.activeElement)) focusInside();
  }

  function close({restoreFocus = true} = {}) {
    if (!isOpen()) return;
    const hadFocus = panel()?.contains(document.activeElement);
    if (mobile) mobileOpen = false;
    else {
      collapsed = true;
      try { storage().setItem(SIDEBAR_STORAGE_KEY, '1'); } catch { /* usable without persistence */ }
    }
    sync();
    if (restoreFocus && !editor.open && (mobile || hadFocus)) {
      toggle()?.focus();
    }
  }

  function toggleSidebar() {
    // A native editor is always the topmost modal; do not disturb its draft or focus.
    if (editor.open) return;
    if (isOpen()) { close(); return; }
    if (mobile) mobileOpen = true;
    else {
      collapsed = false;
      try { storage().setItem(SIDEBAR_STORAGE_KEY, '0'); } catch { /* optional preference */ }
    }
    sync();
  }

  function navigation() {
    if (!mobile || !mobileOpen) return;
    close({restoreFocus:false});
    if (!editor.open) find('#main')?.focus();
  }

  document.addEventListener('click', event => {
    const control = event.target.closest('[data-sidebar]');
    if (control?.dataset.sidebar) {
      if (editor.open) return;
      event.preventDefault();
      if (control.dataset.sidebar === 'toggle') toggleSidebar();
      else if (control.dataset.sidebar === 'close') close();
      return;
    }
    const link = event.target.closest('#app-sidebar a[href^="#"]');
    if (link && !event.defaultPrevented && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && (!event.button || event.button === 0)) navigation();
  });
  document.addEventListener('keydown', event => {
    if (editor.open || !mobile || !mobileOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      const items = focusable(), first = items[0], last = items.at(-1), active = document.activeElement;
      if (!items.length) return;
      if (!panel().contains(active) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  });
  document.addEventListener('focusin', () => {
    if (mobile && mobileOpen && !editor.open && !panel()?.contains(document.activeElement)) focusInside();
  });
  media?.addEventListener('change', event => {
    const wasFocused = panel()?.contains(document.activeElement);
    mobile = event.matches;
    mobileOpen = false; // Every entry into the mobile layout starts closed.
    sync();
    if (wasFocused && !isOpen() && !editor.open) toggle()?.focus();
  });
  window.addEventListener('hashchange', navigation);
  window.addEventListener('storage', event => {
    if (event.key !== SIDEBAR_STORAGE_KEY && event.key !== null) return;
    try { collapsed = storage().getItem(SIDEBAR_STORAGE_KEY) === '1'; } catch { return; }
    const wasFocused = panel()?.contains(document.activeElement);
    sync();
    if (wasFocused && !isOpen() && !editor.open) toggle()?.focus();
  });
  return {sync, toggle:toggleSidebar, close, navigation};
}
