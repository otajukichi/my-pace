# Same-Drive daily snapshot backup

This adds an owner-only backup path, not work to the interactive sync path. It does not create a trigger merely by saving or deploying the script.

## Recovery scope

- One `captureReadView()` fixes the committed revision. Later edits are outside that snapshot and enter a later backup.
- Copies the immutable bootstrap, captured head, entity and receipt trees, and the immutable assets of ready CSV-import pins. Original bytes and original logical IDs are preserved through a manifest mapping to new physical Drive IDs.
- Initial backup copies the reachable snapshot. Later backups reuse unchanged copies, verify their bytes, and only create missing immutable objects. It is not a folder rename or replacement.
- Does not copy raw `running_data` CSV input, browser-only unsynced edits, account credentials, or the historical predecessor-frame chain. Already imported completed routes are included. In-progress reserved assets can legitimately be absent and are not treated as completed route data.
- No delete propagation and no automatic retention deletion. This deliberately consumes more Drive space over time.
- Same-account/Drive loss is out of scope. A nightly schedule can lose the changes since the latest successful snapshot; zero loss is not guaranteed. Failed runs can make that interval longer than a day.

## Durability

Each object has a reserved destination ID saved before creation. Lost replies are resolved by reading that same ID. A partial copy never replaces the previous complete manifest. The snapshot's protocol hashes, raw asset hashes, identity, and head/root cutoff are checked. Missing/corrupt copies fail closed, including on reuse; there is no fallback to original files during restoration.

The backup state is a private fixed Drive file, bounded to 4 MiB. Capacity or quota exhaustion stops without publishing a partial snapshot. This first version does not support unlimited history or automatic garbage collection. Capture uses the normal short writer lock; copying uses the separate owner user lock so bulk copying does not lock out interactive sync for the whole invocation.

## Isolated recovery, not automatic production replacement

`MyPaceBackupRestoreTest` provisions an independent durable store under a separate configuration property. It never changes production store pins. It reconstructs logical entities, including tombstones, into the new store. Entity versions and operation receipts restart in the new identity; old clients must not attach with their previous store identity. The application change journal starts fresh.

Completed imported routes are served by the existing route reader through a durable original-ID to copied-byte asset adapter. This avoids rewriting hash-linked checkpoint bodies. CSV processing remains paused: the old job/source state is archived but automatic import resumption in the reconstructed store is not supported. The recovery adapter is required for those route assets; this is not a drop-in replacement folder for the normal runtime.

Qualification compares every reconstructed value and completed route page, writes a new independent-store probe through the normal writer, and requires a later invocation/fresh runtime to read that probe. Statuses `restoring`, `restored-needs-verification`, `verifying`, and `restore-probe-written` are not success. Only `restore-verified` passes the initial schedule gate.

No live production cutover is performed. An actual incident requires selecting a verified snapshot and an explicit compatible recovery/cutover procedure. Do not point old GAS or old browser state at the new store. Do not delete the original store or overwrite the production property in an attempt to restore.

## Schedule and visibility

The shared `storage/gas/appsscript.json` must explicitly include `https://www.googleapis.com/auth/script.scriptapp` in `oauthScopes`. The backup scheduler calls `ScriptApp.getProjectTriggers`, `newTrigger`, and `deleteTrigger`; the old CSV scheduler was installed manually through Google UI and did not need this scope in its source template. Preserve all existing manifest settings/scopes and add only this scope once. The owner must review and accept Google's additional authorization before running `MyPaceBackupEnableDaily`; editing a local template or saving a manifest is not proof that consent or trigger installation succeeded. No full-Drive write permission is added.

For an existing project with verified backup and isolated restore, this correction needs only the manifest scope addition and owner authorization, followed by `MyPaceBackupEnableDaily` again. It does not require replacing the GAS bundle, rerunning restore, deleting data, resetting configuration, or updating a web deployment. Confirm `backup-schedule-enabled` in the resulting log; later check a real scheduled backup outcome separately.


The owner explicitly enables an Apps Script clock trigger for approximately 03:00 Asia/Tokyo. Google clock triggers are not exact timers. Work is bounded per invocation; a guarded continuation can resume pending work. `MyPaceBackupStatus` reports the last successful snapshot, in-progress work, last failure, restore result, and schedule state. A scheduled trigger existing is not proof that backups continue to succeed.

## Evidence boundary

Local tests cover captured-cut concurrency, original-source loss, immutable copy ambiguity, interrupted/resumed work, corrupted/missing archive data, tombstones, fresh reopened writable recovery, and completed imported routes. Apps Script/Drive permissions, quotas, real timing and live restoration must still be qualified by the owner using the staged commands. No account operation was performed by these local tests.

## Choosing an older snapshot and getting records out

The owner history command lists immutable completed manifests; the selected-restore command reads only a manifest in the pinned private backup folder. A selected manifest does not replace the latest-backup pointer. Each snapshot gets its own isolated recovery store, so choosing an older snapshot does not overwrite a previously reconstructed store.

The owner recovery-export command produces ordinary application JSON from the snapshot's live `app/data` values using the exact existing `entitiesToState` / `serializeBackup` / `parseBackup` contract. This export covers diaries, wake records, manual runs, habits/logs, events and settings. Importing that JSON through the existing UI replaces that UI's records and therefore is a separate explicit incident-recovery action, not something the backup command does automatically. Imported CSV routes are not part of that normal JSON format: they remain recoverable/readable through the copied route assets and isolated recovery adapter.

Large exports are bounded by the backup state capacity and the existing application importer limits; the command must fail rather than truncate. A failed convenience export does not destroy the immutable snapshot. For a production incident, first preserve the old source/configuration, select a verified snapshot, reconstruct and qualify the separate store, then plan an explicit compatible frontend/backend cutover or explicit JSON import. The initial feature does not claim that full production cutover has already been implemented or qualified.

## 2026-10-08 restore continuation correction

The owner restore command has a 240-second envelope and stops admitting new work around 220 seconds. STORE_YIELD is an interruption, not a successful restore. The original command recovered the isolated target during bootstrap, recovered it again during format activation, and then recovered it again in each restore/verification slice. Real Drive latency can consume most of the envelope in these repeated checks.

A persisted restore job proves that initial target provisioning and fence activation completed. Subsequent invocations now use the pinned configuration's read-only load path, preserving the exact target IDs, and use the existing lock-scoped protocol cache during restore work. Missing or altered established targets fail closed; they are not silently recreated. Initial provisioning without a saved restore job remains resumable. Both restoration and verification still recover the target and validate writerFence 2. The budget has not been extended.

MyPaceBackupStatus and restore reports expose restoreProgress: phase, position, restored, pendingEntities, verifiedRecords, verifiedRoutePages and scanDone. Failure reports additionally expose the current phase (snapshot selection, target initialization/reopening, isolated target activation, job persistence, restoration or verification). These counters contain no diary contents. A failure-time report shows observed progress; the next invocation reloads the durable state. Only restore-verified completes qualification. A retryable code is not a guarantee of eventual progress: if repeated reports show unchanged counters, stop and investigate.

This correction does not change production data, existing snapshots, stored target identity, scheduling, authorization or frontend behavior. Previously saved intermediate restore jobs are resumed, not discarded. Validation uses actual owner commands with synthetic 500/1000/2000 ms Drive/token delays, real HMAC codecs, missing production files, historical snapshot selection and multiple records; model results do not predict actual Google execution time.

Restoration completion now persists a pausing-imports phase before the isolated scheduler pause. Old jobs with a completed scan cursor transition to that phase without rereading the archive or resaving an empty batch. Verification with a durable completed scan likewise goes directly to the final write probe. These changes remove repeated final-phase work under latency. The two-second synthetic profile completes for the small-record fixture; arbitrarily slower service calls are not guaranteed to finish an indivisible writer transaction in one budget. Progress fields remain the basis for diagnosing repeated interruption.

## 2026-10-09 verification-cost repair

The earlier resume repair made progress durable, but still opened/recovered a target per four-entity slice, reread archived leaf bodies per entity, and updated/read back the progress file per entity. This repair keeps one bounded verification slice (at most 128 records/pages) under a held lock, captures the target root, shares at most 64 archived bodies / 4 MiB only inside that slice, and checkpoints after eight verified items or 15 seconds. Every cached body remains checked against its manifest hash and identity. Cache state and OAuth tokens never persist between owner invocations.

Existing restore jobs, including the observed six-record verification cursor, continue without a new snapshot or reset. A persisted target cut rejects unrelated changes during verification. The one exact committed write probe can be reconciled after a lost reply only by its digest, single successor revision, current frame ID/hash, exact changed entity/version and value. A subsequent invocation still has to reopen and read the probe before `restore-verified`.

Verification reserves time for saving progress; only fully checked records/pages advance the cursor. The actual imported-route reader uses the frozen source and destination views, so a route page does not repeat target recovery. Results include local-only service counters (`usage.metadataReads`, `remoteRequests`, `writes`, `idAllocations`, `tokenRequests`, `elapsedMs`); collecting them adds no requests and logs no tokens or record contents.

The mixed regression includes 34 restored records, ten change slots and their head (source scan position 45), imported route data, a tombstone and paused scheduler state. At modeled one-second remote calls and ten-second OAuth acquisition, source files removed, the current implementation completes verification/probe in one invocation and requires one later invocation for fresh probe validation. These are synthetic latency results, not a promise about live Google latency. No production replacement, new backup, deployment, reset, deletion or schedule activation is performed by this repair.

## 2026-10-09 prepared daily running extension

The existing immutable snapshot format remains `mypace-backup-v1`. Snapshots with a published daily head additionally contain `daily: {schema: 1, head}` in their hash-covered manifest. Older snapshots without that member remain readable and restorable. No separate daily backup service, automatic restore, production switch, trigger enable, or retention deletion was added.

### Exact completed-display closure

The captured authoritative `daily/head` selects one immutable directory. Its month pages select day assets. Backups copy that entire reachable directory → month → day graph, including embedded source identity, inclusion/overlap notices, quality information, prepared route geometry and statistics. Flat legacy daily directories are also supported. Every referenced descriptor must exactly match a ready daily pin collected from the same captured writer root; a guessed or missing pin cannot authorize a copy. Each body is copied by the existing reserved-ID mechanism and checked for exact byte length and SHA-256. Unchanged copies remain reusable.

Ready pins are reservation evidence, not an instruction to copy every historical materialization checkpoint. Superseded work/checkpoint bodies outside the published display graph are excluded. Their captured entity metadata remains in the archive, while the isolated restore resets derived-only file/job caches and unpublished pins. Published pin proofs are retained with only their copied assets. This prevents both abandoned-work archive growth and later reuse of dangling derived cache references. Source CSV remains excluded. Existing normalized import assets, user records and legacy runs remain included under their existing rules.

Traversal and restore qualification are resumable: a root page, month page, asset or daily response is a bounded work item. The final backup publication does not restart a whole-history read pass. The existing 4 MiB job/state/manifest capacity remains a real limit; too many metadata descriptors fail explicitly rather than truncate history or publish a partial snapshot. This is not an unlimited-history claim.

### Isolated identity and reading

Archived immutable bytes and their original reservations are never rewritten. The restored head binds the new target store/generation separately from `sourceStoreId`/`sourceGeneration` in the archived assets. It also pins `archiveManifestId`, `archiveManifestHash`, `archiveStoreId` and the captured `archivePublication`. The freshly signed target read head is published only after reconstruction and complete bounded verification. A later invocation reopens it and reads a representative day through the same prepared daily reader. The actual GAS daily reader recognizes archive provenance and uses only the verified original-ID → copied-ID manifest map; missing/corrupt copies fail without a production-ID fallback.

Both CSV processing and derived preparation remain paused. The restored head sets `pending: false`, `error: DAILY_PAUSED`; completed days remain available while the interface can explain that preparation is paused. Geometry, statistics, source/overlap notices and quality warnings are compared exactly with the captured source response, with only the intended target identity and pause metadata differing.

The restore preserves a `daily/archive-source` descriptor for later explicitly authorized rebuilds. Derived cache entities referencing excluded work bodies are reset in the isolated target only. Owner-authorized future materialization can read copied normalized sources through the archive mapping and write new target-native assets. This does not enable or resume processing during restore.

A restored target can itself be backed up before rebuilding daily output. Its backup uses the same archive-aware source resolver and a store-specific backup configuration when the original configuration belongs to another store. It creates a separate private snapshot root without replacing the original archive configuration or copies. Second-generation restoration explicitly distinguishes the immediate snapshot's store identity from older immutable asset provenance.

### Qualification and owner commands

The owner commands remain `MyPaceBackupNow`, `MyPaceBackupStatus`, `MyPaceBackupHistory`, `MyPaceBackupRestoreTest`, and `MyPaceBackupRestoreSelected`. Existing manual qualification is not discarded. For a new daily-capable snapshot, run the ordinary backup to completion and resume its isolated restore command until `restore-verified`. Status now adds `verifiedDailyDays` and `verifiedDailyAssets`. `restore-probe-written`, a paused scheduler, or a readable cached day alone is not complete qualification.

A pre-daily snapshot restores existing records/imports with no invented empty daily publication; a later owner-authorized backfill is needed. A snapshot claiming daily support with missing directory/month/day dependencies fails verification instead of quietly rebuilding or reporting an empty day.

Local evidence includes original-source loss across 03:00 JST, corrupt/missing day/index copies, exact mapping and pin-proof failure, signed-head corruption, durable month-page cursors, unchanged older snapshots, capacity failure, paused restore, actual GAS fast-reader recovery, and backup/re-restore of an already restored target after deleting every original and first-generation archive body in the fixture. Tests are synthetic; no live Drive backup/restore, production activation, deployment, or processing enable was performed.

Discovery is also restored disabled: `enabled`, `pending`, and `coverage` become false, active channels are cleared, `watchPending` is cleared, and the state records `DRIVE_CHANGE_REACTIVATION_REQUIRED`. Captured cursors/queues/provenance remain available as inactive metadata. Original project notification properties are never copied or overwritten; new target-specific hint registries start disabled.

The expanded owner integration fixture also exercises real GAS adapters and materialization together: a pre-daily snapshot explicitly rebuilds from its copied normalized assets via an archive-only descriptor; a daily-capable second-generation restore explicitly rebuilds after original files and the first archive are unavailable, then incorporates a newly imported target-native file (recorded duration changes from 60 to 120 seconds). These are explicit local fixture activations only. They do not authorize any live import/discovery/preparation activation.
