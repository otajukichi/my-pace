# Prepared daily running backend (local candidate, not activated)

## Runtime/API

`dailyRun({date:"YYYY-MM-DD",knownHash:null|string})` is an authenticated POST through the existing session+CSRF API and signed owner/store dispatcher. No arbitrary asset IDs or public GPS URLs. The GAS branch constructs only a signed daily read-head reader, not the reserved writer/import runtime. A cold date reads three immutable assets: root, one month, one day; native Drive privacy/metadata verification + bounded authenticated media is six requests. Matching hash avoids day retrieval. Server error `DAILY_NOT_ENABLED` means owner activation has not produced a publication. Older dispatcher rejection means deployed server update is required.

Response: schema1, store, generation, date, hash, updatedAt, status ready/preparing/empty/failed, pending, error, preparationState working/complete/unknown/paused/failed, summary distanceMeters/durationSeconds/averageSpeedKmh, segments of opaque sourceKey + points [lat,lon] + per-edge colors, overlap notice and quality codes. Matching hash returns notModified and current identity/status. Old ready data remains visible while pending or failed additions. Empty requires settled discovery and no unfinished imported jobs. Classified relevant source changes invalidate empty coverage in the owner discovery slice before source parsing completes. Generic Drive notifications are hints only: they must not mutate the writer or daily status, because prepared-output writes themselves generate notifications. Authenticated login/session returns non-secret cacheScope, domain-separated HMAC of owner/origin/security generation/store; frontend persistent caches must still bind dataset generation and revalidate.

## Durable preparation

Owner activation creates `daily/source-revision`; only thereafter existing importer commits atomically advance its version when jobs or imported runs change. This does not change storage format, writerFence2, CSV parser identities, source files, import pins, or app records. A compact source cut includes this revision, job directory version and discovery queue/coverage state. No complete source-tree scan on ordinary viewing.

`daily/owner-scheduler` stores bounded resumable state. Normalized immutable source outputs, not raw CSV, feed one processing unit at a time. File summaries and preparation checkpoints are private immutable assets. Known source metadata is processed in bounded pages with progress checkpointing; at most one source summary is added to a dirty day per unit. Completed file summaries are reused. Accepted/excluded file fingerprints reuse unchanged day assets; unchanged months are reused. All dirty days and affected overlap decisions publish together through one root descriptor. A stale source cut restarts preparation without replacing the old ready root.

Root: `{schema:1,storeId,generation,months:{YYYY-MM:{asset,hash}}}`. Month page: `{schema:1,storeId,generation,month,days:{date:{asset,hash,updatedAt,fingerprint}}}`. Day bodies contain all statistics/geometry, without external provenance dependencies. Legacy flat directory reading remains for fixture/upgrade compatibility. Private flat planning catalog is a checkpoint asset; it is not needed for public reads or restored completed display.

Every asset is reserved under a durable `daily/pin/<id>`, uploaded only to its fixed ID, then byte/hash/private-metadata verified. A complete writer `daily/head` is authoritative. Detached signed head slots and a separate trusted identity/hash/publication floor provide lightweight reads. The inactive slot is chosen relative to the trusted slot, so failed floor writes (including skipped publication numbers) retain the last complete head. Retrying owner work republishes the authoritative head. No staging asset is visible in a ready daily response.

## Numeric/display policy (algorithm2)

- Day begins03:00 Japan time, computed as UTC timestamp+6h calendar date.
- Elapsed duration includes within-file stops/gaps, excludes gaps between separate files.
- Statistics use all accepted source points before display reduction; recorder speed column is ignored because its unit is undeclared.
- Strictly increasing valid UTC timestamps and finite in-range GPS coordinates are required. Unsorted/duplicate timestamps fail with DAILY_TIME_ORDER; invalid GPS fails with DAILY_POINT_INVALID. There is no salvage-sort engine.
- Edges over120seconds or15m/s are omitted from distance and geometry, keep elapsed duration, retain isolated GPS markers and emit GPS_GAP_OR_IMPLAUSIBLE_SPEED. This is an explicitly versioned quality policy, not a claim that every retained GPS reading is exact.
- Valid edges crossing03:00 are proportionally split with longitude-wrap-aware interpolation.
- Globally sort files by earliest timestamp and stable opaque source identity/version. Greedy earlier-file inclusion excludes the whole later overlapping file on every affected day. Touching half-open intervals are allowed. Original CSV is retained. Exact overlap notice is preserved.
- Streaming display spans aggregate original-edge distance/time while every removed sample remains within5m of the retained anchor. Span endpoints are committed at the5m threshold or a speed shift of at least2km/h from the span-start or preceding original edge. Small quantization-boundary fluctuations are averaged inside the span; meaningful changes such as7→9→11km/h retain separate colors. Span accumulators survive checkpoints and are removed from final map segments. Colors interpolate RGB between the0/6/12/18/24km/h palette anchors, after rounding display speed to the nearest0.5km/h (49colors, clamped at24km/h). Distance, duration and average speed are never quantized. Very frequent meaningful speed shifts can still exhaust the geometry bound sooner; failure remains explicit rather than silently dropping points. Algorithm2 invalidates old five-band file summaries/source cuts/day fingerprints and rebuilds from normalized assets while keeping the old ready publication. Separate files and GPS interruptions stay separate segments.

Explicit safe bounds:6000 retained points per source/day,256KiB day/month/root asset,2MiB checkpoint/planning asset,128 contributing files per day,4096 dates,240 months,366-day maximum span per source. Oversized geometry or catalog fails visibly, retains the previous ready publication and requires owner review. There are no exceptional-day chunks or silent truncation. Ordinary1000-date month-catalog reading, a two-hour2Hz noisy16km route, and a one-hour real-precision GPS route are tested.100k stationary samples preserve exact elapsed statistics with tiny geometry. The bounds are not promises that all records at the maximum fit every byte limit.

## Owner actions / rollout

No action runs on source save, deployment, sign-in or view. No live action was performed to build this candidate.

- `MyPaceDailyRoutesActivate()` explicitly enables derived preparation/backfill from completed normalized imports.
- `MyPaceDailyRoutesStatus()` inspects durable state.
- `MyPaceDailyRoutesResume()` performs one owner work unit.
- `MyPaceDailyRoutesPause()` pauses; to retry a terminal failed projection, inspect/correct the source problem, then explicitly pause and activate.
- Discovery/watch activation is separate; see DRIVE-CHANGE-DISCOVERY.md.
- Existing scheduled owner runtime shares its call/time quotas with discovery, importer and up to16 daily work units, retaining completion headroom. It does not install or alter triggers.

Deploy matching GAS/server/UI only after local regression and backup/isolated-restore checks, then separately approve watch credentials/endpoint and schedule, activate discovery and daily preparation, inspect coverage/errors, and qualify real recordings.30-minute save-to-ready and2-second first-date are measured targets, not verified guarantees. Mock tests and request counts are not live Google/Vercel latency measurements. Initial historical backfill may exceed one ordinary cycle.

## Backup, restore and rollback

Matching backup code captures the root/month/day reachable asset closure and imported normalized assets, not original CSV. Restored heads rebind the new target store/generation while immutable bytes retain original identity. Signed archive manifest ID/hash and exact copy mappings authorize restored reads; missing mapping/corruption is fatal and never falls back to original assets. Restored jobs stay paused, old complete data remains readable with DAILY_PAUSED. Explicit rebuilding uses archived normalized assets and native new projection assets; it does not reimport original CSV.

`daily/head` schema1 is the feature capability marker. Older GAS/backup versions do not support this namespace and must not be presented as fully qualified daily backups. Do not use an old backup controller after activation. Source rollback is not data rollback: pause new background work, retain the compatible backup/read backend or explicitly rebuild with the matched version. No irreversible writer fence bump was introduced; legacy records/import pins remain intact. Never reset the original store to roll back this display feature.
