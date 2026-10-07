# Unchanged-folder discovery: local runtime candidate

No live service call, trigger, authorization, deployment or source mutation was performed for this change.

## Authority and bounded work

After an authoritative scheduler completion, each scheduled tick still acquires the owner script lock and recovers the current immutable Drive state. A completion-time job-directory version detects subsequently queued work before any idle throttle is considered. A new unfinished job resumes the durable pipeline immediately. Manual Start, Resume and Retry clear the throttle; every durable writer-head change also invalidates it even if cache eviction fails.

A due unchanged sweep compares current source checksums/size/parser/mapping with the current source generation and live published run. Historical identities cannot suppress A → B → A, including a historical duplicate A. Duplicate suppression requires a verified content key that still matches the live target run; missing legacy evidence is re-parsed and reverified before publication.

No journal frame, checkpoint index, checkpoint manifest or immutable index node is created for a fully known, quiescent source sweep. The existing writer can still finish an interrupted mandatory protocol publication during recovery; that is repair of previously committed work, not an unchanged scan reservation.

Discovery uses at most four listing pages and 128 sources per tick. A separate between-source threshold stops after 48 additional Drive/Fetch calls or one quarter of the short slice, whichever occurs first. A single bounded radix lookup may cross that threshold; the invocation's existing live call/runtime ceiling remains enforced. Files are listed only from the fixed source folder and originals are never modified.

## Advisory pagination, not job progress

A new optional immutable configuration pin, discoveryStateId, identifies one private mutable file in the existing metadata folder, with role source-discovery. The file is bounded to 8 KiB and HMAC authenticated with a separate protocol/domain using the existing owner-managed secret. It binds the actual script, store, anchor, dataset generation, fixed source folder, file ID, and current committed writer head. It contains only a page token, bounded within-page index/fingerprint and last-completed-check time. It contains no CSV rows, app state, import offset, upload pin, token or credential.

A page fingerprint covers the complete returned bounded page and its next token. Changed/reordered pages recheck their prefix. Expired tokens restart discovery. A changed durable head, missing/corrupt/unverifiable cursor, or absent cache restarts or repeats safe reads. New/changed source work enters the unchanged durable import pipeline, whose reserved IDs and publication checks remain authoritative. There is one fixed discovery file across arbitrarily many listing pages; no new journal/index files are needed merely to remember a known-page cursor.

CacheService is optional. It stores only a short-lived throttle bound to the actual script/store and verified current writer head. It is consulted only after locked recovery, never as app/job authority. Its maximum suppression interval is one hour. A cache miss reads the authenticated Drive discovery cursor; flushing the cache on every tick does not discard pagination. Cache failures do not block imports. Returned reconciliation/scanning is advisory discovery, while durable scheduler status can remain complete for the last finished import sweep.

A lost cursor-write response is not retried at a different ID. One bounded authenticated readback checks the exact intended head and cursor; a proved successful write proceeds normally. A hard read/identity/ownership/permission failure, or an unproved cursor write, persists one blocked scheduler status visible to the app and stops repeated discovery attempts. Owner Retry clears the block and the next scheduled tick resumes reconciliation. Transient read failures return a retryable deferred result without a journal update. A wholly unwritable authoritative store can still prevent recording any status; it must be repaired before work can proceed. No failure erases committed jobs. Legacy stores without the optional authenticated pin retain bounded durable scanning for an inconclusive large sweep; an explicit owner provisioning/repair operation is required to add the new fixed ID. Properties contain configuration only, never discovery progress.

## Local evidence and accounting

Reproduce with node --test idle-reconciliation.test.mjs import-store.test.mjs scheduled-runtime.test.mjs.

The 24-hour synthetic model uses three distinct unchanged 71-byte sources, 96 ticks at fifteen-minute cadence, and hourly complete folder checks:

- No CacheService: 2,582 actual Drive/Fetch requests, 24 folder lists, zero new immutable frames/indexes/manifests/nodes, and one new fixed mutable discovery file
- With CacheService: 2,375 actual Drive/Fetch requests, 24 folder lists, the same zero immutable growth, one fixed file, and 120 separately counted cache operations

The fixture includes initial immutable publication before measurement; the only additional file is the lazily created discovery cursor. Cursor overwrites do not create further files. A 145-distinct-source synthetic committed-state fixture verifies bounded pagination and zero immutable growth with every-tick cache eviction. Other regressions cover manual/new queued work, later new/changed source, expired page token, page reorder, cursor corruption, missing cache, ambiguous cursor writes, fixed key scope, and duplicate generation changes.

Idle recovery, read-only discovery and mutable-cursor requests are reported in actual per-invocation usage but are not durably added to the work-reservation ledger. The approved 12,000 rolling work-call ceiling remains unchanged. Adding 2,375 gives 14,375 only for this small fixture; this mixed Drive/Fetch illustration is not account-wide quota metering, a maximum for every history/folder size, or a guarantee against Google's per-user quotas. Recovery history, retries, longer scans, manual/status calls and other scripts can consume more. Cache requests are a different service and are reported separately. No live latency/quota acceptance is claimed.

## Recovery barrier status

Public owner start/resume/tick/status calls return recovering with processingMode recovery, retryable true, authenticated indexLinks/scannedLinks, cursorPersisted and actual usage while bounded INDEX discovery is unfinished. They do not invent idle/complete app state or write a business error record before recovery. A missing authenticated recovery setup returns blocked with requiresOwnerAction. Integrity errors still fail closed. Focused scheduler-recovery-status.test.mjs checks fresh cold calls, one-link progress, real completion, setup requirements and corruption.

## Larger-folder daily scaling evidence

Reproduce with node --test scheduled-idle-scaling.test.mjs. The reusable local harness is scheduled-idle-scaling.mjs; exact results are scheduled-idle-scaling-results.jsonl. It seeds 145 distinct known source/job/run identities in the real immutable writer, with authenticated checkpoint and discovery pins, then runs 96 cold scheduled invocations over 24 synthetic hours. It does not model importing those sources or claim to reproduce all assets/history of 145 real imports.

- Retained CacheService: 3,402 actual mixed Drive/Fetch calls; 115 separate cache operations
- Cache evicted before every tick: 3,567 mixed calls; 170 separate cache operations
- Both: 19 completed discovery sweeps, 19 partial discovery ticks, 95 folder-list calls, maximum 59 mixed calls per tick, 38 fixed-cursor writes, and one additional fixed cursor file
- Both: zero new immutable frames, checkpoint indexes, checkpoint manifests or immutable index nodes

A complete sweep requires two ticks in this fixture. The configured one-hour interval starts after each completed sweep, explaining 19 daily sweeps rather than 24. Adding the existing 12,000 work-admission ceiling gives illustrative mixed totals of 15,402 and 15,567. Relative to the previously documented 20,000 consumer URL Fetch comparison, those leave 4,598 and 4,433 respectively. These are fixture results, not quota-safe global maxima: mixed calls include non-UrlFetch requests; cache uses a separate service; real imported asset/job histories may be substantially larger than seeded state; larger folders, recoveries, retries, user/status traffic and other scripts remain outside this model. No production limit was changed for this measurement.
