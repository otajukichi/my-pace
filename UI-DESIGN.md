> 過去の実装・検証資料です。本文中の手順・時間予算・制限・試験数は当時の記録で、今回の導入やロールバックを指示しません。現在の手順は [PRACTICAL-SYNC-INSTALL.md](PRACTICAL-SYNC-INSTALL.md)、設計は PRACTICAL-SYNC-DESIGN.md を優先してください。旧インストーラー、初期 bootstrap、ストア移動、秘密情報・OAuth・公開権限・トリガーの変更を今回の更新で繰り返さないでください。

# マイペース: 一日の風景

## Design decision

The latest local application is the baseline. The historical Vercel screenshot is feedback history, not a target. The redesigned workspace uses a stable Japanese date/title/navigation shell and different, data-led compositions within each route. Warm and cool hues coexist by role; there is no required color percentage and no page-wide category wash.

The 1366×768 static composition studies compare filled and empty wake, running and home views. They are drawn concepts with fixtures, not screenshots of the application and not evidence of browser layout correctness. The neutral first studies and decorative second studies were superseded before implementation.

## Visual system

- Shared ink, off-white reading surfaces and a quiet canvas; 12px principal surfaces, 8px controls
- Japanese-capable local fonts; 14px functional controls, secondary text at least 12px
- 26px page headings and restrained tabular metrics; no display-number growth on large monitors
- Eight equal icon navigation targets, persistent accessible names and hover/focus tooltips; no sidebar
- Bounded viewport with a focusable, internally scrolling content stage. Reflow instead of hiding controls or shrinking text at short heights or zoom
- Fixed focus/error/disabled semantics across routes, distinct from atmospheric art colors

## Content composition

Home: quick entry rows on one white sheet, a compact warm reflection/plans region, forest lifetime overview and sky seven-day trace. Lifetime totals are all records in the application through the selected date. Separate Drive import metadata cannot create invented distance. False/zero habit entries are records, not achievements. Numeric/time history is not retrospectively scored against changed targets. Planned events are not completed activity.

Wake: compact current time and optional target, a sky field containing the existing actual time chart, and warm actual statistics. Missing dates remain gaps. No sunrise, sleep-duration estimate, invented quality score or decorative sun.

Running: white entry controls alongside a forest chart with ochre bars and a sky summary. The plot comes from the existing distance records and existing aggregation functions. Empty days say unrecorded; genuine zero-valued recorded runs remain distinguishable. No invented route artwork.

Habits: white list, lilac weekly context, sage summary, plum actions. Completion retains checks and text. Calendar: white month grid with cool headings and a warm agenda region, distinguishable markers and an explicit selected date. Diary: neutral reading measure with lilac date/history and warm metadata. Garden: the existing scene is the only illustrated landscape; reward rules are unchanged. Settings: readable cool information and neutral controls, literal status text.

## Research references

- Things official interface: alignment, grouped records and quiet boundaries: https://culturedcode.com/things/features/
- Apple Headspace design article: shared neutral structure with bounded multicolor content, without copying cartoon decoration: https://developer.apple.com/news/?id=fkfnhq8u
- Apple Fitness: stable surface contrast with distinct hues attached to actual data: https://www.apple.com/apple-fitness-plus/
- Material 3 role-based colors: https://m3.material.io/styles/color/the-color-system
- Carbon spacing: https://www.carbondesignsystem.com/building-blocks/foundations/spacing/overview
- Albers contextual color: https://www.albersfoundation.org/alberses/teaching/interaction-of-color
- Getty warm/cool, saturation and area contrasts: https://www.getty.edu/research/exhibitions_events/exhibitions/bauhaus/new_artist/form_color/color/

## Verification boundary

Source-level tests can validate render content, record aggregation, action hooks, CSS contracts and sampled contrast. They do not validate actual computed styles, clipping, keyboard flow, browser layout or persistence interactions. A permitted browser was unavailable during this redesign; no browser security restrictions were bypassed. Visual signoff remains pending local screenshots and interaction checks at 1366×768, 1440×900, 1920×1080, 1280×650, 1024×700, 820×650 and narrow/200% zoom layouts. Test populated, empty, long Japanese text, errors, busy/offline, sync conflict and modal states. Verify the last action remains reachable by stage scrolling.
