> 過去の実装・検証資料です。本文中の手順・時間予算・制限・試験数は当時の記録で、今回の導入やロールバックを指示しません。現在の手順は [PRACTICAL-SYNC-INSTALL.md](PRACTICAL-SYNC-INSTALL.md)、設計は PRACTICAL-SYNC-DESIGN.md を優先してください。旧インストーラー、初期 bootstrap、ストア移動、秘密情報・OAuth・公開権限・トリガーの変更を今回の更新で繰り返さないでください。

# Client sync v2 implementation notes

Status (2026-10-07 20:11 UTC): local implementation and deterministic tests; qualification is ongoing through the requested work window. No production deployment, live data mutation, browser authorization change, or storage reset was performed.

## What changed

- Record acknowledgements, record reads, imported-run reads, and import-status reads have separate status semantics. A validated, durably stored command acknowledgement can say that the sent record is saved even if the subsequent read is delayed. It still says the latest records are awaiting confirmation. Imported-run/status failures remain visible without changing successful record confirmation into a general save failure.
- An empty outbox alone is never proof of a successful cloud save/read. An additive confirmation marker is bound to the local store, dataset generation, epoch, and writer revision. Legacy markerless caches remain usable but unconfirmed until a validated receipt or complete snapshot establishes confirmation.
- The client negotiates `pull` v2. Only explicit `ACTION_INVALID`/`UNSUPPORTED_ACTION` may fall back before v2 has ever been observed. After durable v2 observation, unsupported replies are a deployment mismatch. Malformed data, forbidden requests, authentication failures, and owner migration requirements never trigger fallback or activation.
- Successful v2 bootstrap stages raw pages in an isolated local baseline. A final atomic pointer swap publishes the entire baseline, checkpoint, read proof, and confirmation. Interrupted pages are resumed from durable opaque continuation metadata.
- Delta entities/tombstones and their continuation commit atomically. The completed checkpoint is advanced only at the final page. Repeated target-root versions are idempotent; older versions cannot overwrite newer accepted values. Raw parentless habit logs remain stored until their parents arrive; UI projection never rewrites raw storage.
- Initial and final application compare the cut with the latest durable local revision/proof, including receipts from another tab. A delayed asynchronous read cannot regress an already newer in-memory local revision. Local mutation uses a compare-and-set on a local revision counter.
- Generic HTTP 400/409 responses never imply a user record conflict. Only explicit business-record conflict codes enter the conflict queue; protocol, permission, quota, deployment and server-integrity failures preserve the original pending UUID.
- A rapid logout/relogin rearms a fresh current-session sync. Server-derived requests and local receipt/cursor writes carry their originating session generation; an obsolete session cannot begin a derived write after login changes. A transaction already underway can finish durably without showing stale authenticated success.
- An explicit, preview-bound “keep local” choice for a deletion already confirmed remotely retires the chosen pending deletion without issuing a failing replacement delete. Other conflicts still require an explicit choice.
- Proofs sent to the server include store and dataset generation. A retention or expired-cursor restart preserves the same-domain proof. Only an explicit identity-changed reset allows bootstrap without the old-domain proof; old pending operations remain intact and are presented as conflicts against the new baseline.

## Local storage

The database name stays `mypace.owner-sync.v1`; the IndexedDB database version becomes 2. The previous `state/owner` value is retained unchanged as a migration safety copy. One upgrade transaction copies its logical state into keyed entity, outbox, conflict, metadata, staging, and bounded local-change-log stores. A failed upgrade leaves the old database intact. A blocked/old-version connection asks for closing old tabs or reloading; no database deletion is used as a repair.

Normal entity, receipt, pending-operation and delta writes touch only changed keys. A bounded local log lets another active tab reread those keys rather than the entire baseline. Initial hydration, completed baseline replacement, or a tab older than the local log must hydrate the full current baseline.

A separate cooperative cleanup deletes only inactive v2 snapshot copies, at most 64 entity/staging rows per transaction. It rechecks the active and live-staged baselines inside every transaction. Original v1 state, pending operations, conflicts, checkpoints and acknowledgement proofs are not deleted by cleanup. The client has one yielding cleanup drain and stops it on logout, destruction, or cleanup error. Cleanup does not affect cloud-save labels.

## Timing and retries

- Core failures use independent capped exponential backoff: 1, 2, 4, 8, then 15 minutes. Newly observed, strictly advancing verified recovery progress resets that delay to one minute; repeated/regressed or unproven progress does not. HTTP 401/403/429 never borrows the progress reset.
- Import checks have their own backoff and owner-action pause. An import issue does not stop the next diary edit.
- `STORE_YIELD` no longer creates a permanent manual-repair pause. A first-page v2 `STORE_YIELD` or `SYNC_BUDGET_YIELD` can use one wider, bounded `recover({pull: originalPayload})` request per sync. It returns the requested page directly; a diagnostic ready response is not treated as a page and no redundant cold pull follows it. The backend budgets ordinary reads at 20 seconds and command/recovery requests at 35 seconds. A request may get a bounded short identical continuation only when the server explicitly reports newly persisted, strictly advancing recovery progress. Repeated or unproven progress falls back to the ordinary retry schedule.
- Validated frame, index, checkpoint and preparation progress can each earn a short burst of at most eight identical requests. The client yields earlier when another request of the observed duration would exceed about one minute of active work; the independent network deadline still bounds a single request. Session-local high-water marks are bound to the exact authenticated action/payload and survive retry windows. Frame/checkpoint revisions share a strict root watermark, and only a genuinely newer root permits preparation ordinals to restart. Phase changes alone, repeated/regressed/malformed counters, missing persistence/advance flags or owner-action requirements cannot earn a fresh continuation. A completed burst with new progress waits one minute; a stalled burst follows ordinary exponential backoff. Preparation remains local/pending, never a receipt or saved confirmation. These are synthetic/protocol tests; final deep-write and frozen-package qualification remain separate gates.
- Setup/migration-required and local reload-required failures pause automatic attempts. The client never activates a server format fence.
- A client deadline covers both fetch and JSON response-body completion: 45 seconds for ordinary reads and 55 seconds for command/recovery requests. An interrupted write remains pending/unknown and retries the original operation ID; a timeout never creates a replacement ID or means the remote write failed.
- Empty deltas at the same application checkpoint pace idle polling to nominal 60/120/300-second intervals with 10% jitter. The current UI uses a 60-second wake tick, so actual idle intervals can round up by one tick. Unrelated writer maintenance and import-status changes do not reset this application-idle counter. Edits, manual sync, focus, and reconnect bypass idle pacing but do not bypass recovery backoff. Hidden tabs do not poll.

## Evidence

Focused test files:

- `tests/secure/sync-phases.test.mjs`: acknowledged write plus failed read, markerless and mismatched caches, lost/invalid acknowledgement, independent browser read with busy CSV status, ancillary backoff, editing during ancillary requests, conflicts, logout.
- `tests/secure/pull-client.test.mjs`: deterministic protocol/client cases including frozen pagination, restart, atomic rollback, cross-tab stale-cut rejection, proof-domain resets, pacing, timeout, recovery deduplication, and client cleanup.
- `tests/secure/local-storage.test.mjs`: 22 IndexedDB protocol-double cases including migration failure, blocked/version changes, data/cursor/outbox atomicity, concurrent CAS, bounded change log, cleanup interruption, and cleanup protection.
- `tests/secure/sync-v2-integration.test.mjs`: actual reserved writer + actual domain + actual v2 pull + client + keyed IndexedDB protocol-double integration. Includes bootstrap/delta/idle, original receipt replay after response loss, two isolated profiles with explicit conflict resolution, opaque continuation across restart, and tombstone/recreate versions. The fixture explicitly enables the format fence before v2 reads.
- `tests/secure/client-public-integration.test.mjs`: actual auth handler and sync API, generated GAS and HTTP-shaped Drive fixture, with isolated IndexedDB profiles. Includes offline conflict convergence, local receipt-transaction abort after remote commit, explicit migration pause, absolute snapshot expiry/restart, rapid relogin, session change before local receipt storage, 750–1,000 ms/service recovery pages and explicit 2,000 ms/service failure, and concurrent duplicate deletion resolution. Google token verification is a synthetic fixture; real Google login is not tested here.
- `tests/secure/client-convergence.test.mjs`: three deterministic 100-action schedules across three isolated profiles, including offline edits, reloads, acknowledgement loss, explicit conflict choices and final convergence. Every removed original operation must have a receipt or explicit resolution; duplicate receipt replay must retain original identity.
- `tests/secure/client-storage-failures.test.mjs`: Drive 401, permission/quota 403, 429 and 503 on metadata reads and creates; cached-baseline preservation on revoked access; failed v1 upgrade followed by safe retry with exact original UUID.
- `tests/secure/command-errors.test.mjs`: 16 protocol/infrastructure error classification cases at HTTP 400/409.
- `tests/secure/prepared-app-domain.test.mjs`: cold-resumed pure domain expansion, one entity lookup per microstep, compact metadata-only cursors, original digest binding, strict command admission, catalog/journal integrity and absolute ring wrap, genuine rejection versus corruption, terminal receipt replay, and version exhaustion.
- `tests/secure/preparation-progress.test.mjs`: preparation progress through guarded public services and signed dispatch, strict counters, and stripping private descriptor fields. Client preparation cases in `pull-client.test.mjs` cover bounded monotonic continuation, repetition/regression, malformed progress, logout/reload, no premature save, and final receipt identity/deletion checks.
- Existing outbox/controller/retry suites remain regression gates.

The keyed storage adapter's measured ordinary one-key patch + incremental read uses the same counts at 1, 1,000, and 50,000 stored entities: 2 entity gets, 1 entity put, and 8 total storage requests. The test reports identical entity byte counts for its fixed-size synthetic rows. An idle incremental read does not enumerate entity/outbox/conflict stores. This is instrumented storage-protocol evidence, not browser performance or proof that every synthetic 50,000-entity fixture is a valid application state.

## Limits and remaining gates

- Native browser/real IndexedDB lifecycle and rendering/motion QA could not run because browser execution was blocked in this environment. The verified Chromium launch failure was an AF_UNIX/socket operation denial; no alternate launch route was attempted after that denial. The test double validates transaction protocol/rollback but cannot prove browser scheduling, eviction, disk durability, accessibility, or layout.
- Complete initial hydration and rendering/projecting a changed full application state still require work proportional to its size. Network deltas and keyed persistence do not imply constant-time UI rendering. Existing application record/backup limits remain unchanged. Cloud-state equality no longer invokes the 12 MiB JSON export/import gate; a controller regression test exercises a valid larger cached diary followed by a one-record cloud delta.
- The imported-run list still has its original paginated full refresh and metadata-array persistence. It is isolated from core record confirmation but is not a separate incremental local collection yet.
- Snapshot cursors now have a fixed absolute 24-hour lease; delta cursors have a fixed 15-minute lease. Expiry is not renewed per page. The client resumes within that lease or safely restarts without discarding its previous baseline/outbox. These finite leases do not guarantee completion through arbitrary prolonged offline periods or arbitrarily slow services. Full-path tests confirm explicit budget failure, rather than a false ready/saved claim, at sustained synthetic 2-second service latency.
- No claim is made of bounded physical Drive history. The local duplicate-baseline cleanup and bounded application delta window are different from Drive history/receipt garbage collection.
- The final aggregate suite, generated GAS bundle, activation path, packaging and deployment verification remain release gates after the backend integration is finalized.

## Synthetic state-path measurement

`node --expose-gc qa/client-state-benchmark.mjs` (Node + in-memory IndexedDB double, excluding DOM rendering and Drive latency) measured the initial implementation at 1,000 vs 50,000 valid synthetic records:

- Load: 33.49 ms vs 1,000.06 ms
- Idle sync: 2.16 ms vs 1.85 ms; zero entity rows read and zero projected-state callbacks at both sizes
- One sparse changed record: 7.64 ms vs 286.07 ms, including 1.20 ms vs 89.62 ms in the app-style whole-state validation/equality step
- Retained heap growth including the in-memory database double: 1.19 MiB vs 46.45 MiB

These are a diagnostic baseline for a conservative sparse-projection optimization, not browser performance promises or a maximum supported dataset size.


## Rechecked sparse-path measurement, 18:00 UTC

After the conservative wake/diary/settings/garden projection optimization, the same Node/protocol-double benchmark measured 1,000 vs 50,000 valid synthetic records:

- Load: 33.96 ms vs 1,033.40 ms
- Idle sync: 2.25 ms vs 2.11 ms, with zero entity reads and zero projected-state callbacks
- One sparse changed record: 8.40 ms vs 111.71 ms, including 1.81 ms vs 88.58 ms in app-style whole-state validation/equality
- Entity I/O stayed at two rows read and one row written
- Retained heap growth: 1.23 MiB vs 46.34 MiB, including the in-memory database double

The remaining display validation/equality and touched-dictionary shallow copy still scale with their data size. Initial hydration, full projections for complex entities, DOM rendering, native IDB and live Drive latency are separate costs. No browser-frame-rate or maximum dataset-size claim follows from these numbers.
