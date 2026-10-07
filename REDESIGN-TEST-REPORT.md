# Daily-scenes redesign verification

2026-10-07. Baseline: the latest local release with the GAS compatibility repair and OAuth disclosure pages. Apply the disclosure-page update before this design update.

## Passed on frozen source

- `npm run verify`: syntax/static checks, 1,312 tests passed, zero failures/skips, production build succeeded
- 36 explicit public assets built; the new presentation-only home summary module is in the canonical public allowlist
- Public import-graph closure, source serving and built-dist serving are regression-tested
- Existing persistence/security/domain coverage remains in the full suite
- Home lifetime totals are tested for selected-date cutoff, archived history, repeated same-day records, numeric zero, false checkboxes, sparse history, empty state and exclusion of separate CSV import metadata
- Existing quick entry handlers are reused; chart formulas and record storage are unchanged
- Source-resolved contrast samples: minimum 4.85:1 text, 3.83:1 essential graphics. These samples are not a WCAG certification or computed-browser measurement
- Chart paths explicitly use `fill:none`; wake missing days remain gaps. Graphs retain a 620px plotting floor, a keyboard-focusable horizontal scroll region, and 12px SVG labels rather than shrinking the text below that size
- The skip link has an opaque readable focus surface; tab navigation can reflow; rhythm has one layout grid rather than nested unequal grids

## Unchanged boundaries

Authentication, sync/outbox, storage, server/API/GAS, domain/reward calculations, dependencies and configuration were not modified. Existing about/privacy/terms HTML text is byte-identical; only their shared stylesheet changes. The public asset manifest adds the new presentation helper.

## Still pending

No permitted real browser was available. Static composition studies contain labeled fixtures and are not app screenshots. No browser restriction was bypassed. Actual clipping, computed contrast, keyboard interaction, scroll reachability, modal fit, 200% zoom, offline/error/busy states and persistence interactions must be checked locally.

Recommended viewports: 1366×768, 1440×900, 1920×1080, 1280×650, 1024×700, 820×650 and a narrow fallback. Check populated and empty Home, the busiest calendar/Drive/history view, each primary route, and a modal. Confirm all eight icon destinations, chart horizontal scrolling and the final stage action remain reachable. Secondary history/agenda views deliberately remain quieter than primary data views.
