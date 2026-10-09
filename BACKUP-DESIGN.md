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
