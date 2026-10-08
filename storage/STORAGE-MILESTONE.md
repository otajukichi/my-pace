> 過去の実装・検証資料です。本文中の手順・時間予算・制限・試験数は当時の記録で、今回の導入やロールバックを指示しません。現在の手順は [../PRACTICAL-SYNC-INSTALL.md](../PRACTICAL-SYNC-INSTALL.md)、設計は ../PRACTICAL-SYNC-DESIGN.md を優先してください。旧インストーラー、初期 bootstrap、ストア移動、秘密情報・OAuth・公開権限・トリガーの変更を今回の更新で繰り返さないでください。

> Current recovery revision: historical absolute4,096-lifetime-cap descriptions below are superseded by `BOUNDED-INDEX-RECOVERY.md`. Authenticated stores traverse INDEX history in durable bounded64-link slices with no lifetime checkpoint halt. Only the latest discovered checkpoint publication/manifest is mandatory; intermediate retired publications are not reopened. Current cadence/budget and idle behavior are in `OWNER-SCHEDULING.md`. Older performance results remain historical evidence.

# Drive-only storage integration milestone

Local implementation candidate, not deployed. The package now contains a composed reserved-slot writer and resumable importer, rather than an adapter requiring a missing writer. Its algorithm and simulated Drive integration are executable and automatically tested. This does not make the MyPace application finished or establish actual Google execution latency/visibility guarantees.

No external writes, OAuth changes, trigger installation, deployment, Git push or source-file changes occurred. The owner separately reported approving the added read scope; this package does not count that as proof of a live CSV import. Actual app-store bootstrap IDs must be explicitly provisioned and pinned. Existing probe folders must not be adopted as production storage.

## Implemented components

- `reserved-writer.mjs`: fixed bootstrap/store/actual script identity; pre-reserved immutable frame chain; same-ID ambiguity recovery; original receipt replay before version checks; versioned entity deltas and tombstones; ordered epoch fences; bounded copy-on-write radix shards for entities and receipts; automatic exact-predecessor checkpoints; compulsory immutable checkpoint-index publication before further work.
- `gas-store-io.mjs`: actual GAS Advanced Drive create/generated-ID bindings and bounded REST metadata/media reads. Only explicit metadata HTTP 404 denotes an absent slot. Permission, quota, malformed metadata and failed media reads never mean absence. Authoritative objects remain immutable. A separate fixed-ID authenticated checkpoint hint has a narrowly scoped same-ID mutable update; no arbitrary-ID web route exists.
- `import-store.mjs`: durable bounded job/source/content/asset-ID indexes, linked job discovery, scan pages and cursor acknowledgement, pinned reservation IDs, exact checkpoint/manifest validation, staged asset verification, incremental finalization, normalized-output rehash/counts and independently recomputed timestamp summaries, duplicate holds and atomic publication. Replacements preserve latest owner fields, and conflicting edits to the imported branch fail closed.
- `import-runner.mjs`: one source-range/checkpoint per step, reconstruction of identical payloads at previously reserved IDs after interruption, one bounded finalization batch per step, and crash-safe scan page/register/ack orchestration.
- `gas-import-runtime.mjs`: composition of the actual modules with a single script lock, shared work-budget callback, current reservation checks, private managed-asset metadata checks before media, and configured fixed parents/anchor. Constructing it performs no network or storage action.
- `gas/FolderImport.gs`: module-free build containing all production modules. No public handler or trigger installer is supplied. The generated bundle itself is tested through registration, parsing, cold state, finalization and publication in a VM without Node codecs.

The durable store is Drive files only. ScriptProperties may supply fixed configuration/secrets later; they are not used for progress, receipts or state here. All entity and index material is bounded per file. The checkpoint-index chain, retained receipts, source/job history and uncollected staging still grow overall. No garbage collection is implemented and no bounded-total-storage claim is made. Cold recovery follows at most 4,096 checkpoint-index links and 256 replay frames, with automatic checkpoints normally every 64 frames. Exceeding a recovery bound is an explicit maintenance failure, never a new empty store or silent reset. Referenced shards are verified lazily when read, not scrubbed globally on every mutation.

## Important integration contracts

All low-level writer and binding methods run under the same project script lock. Every new read phase requires `recoveryBarrier()` before cached reads. The runtime's reservation callbacks do this automatically when reacquiring the lock; runner lifecycle methods use the binding's recovery barriers.

Only trusted server orchestration may call registration, reservation and checkpoint methods. Do not expose low-level caller-selected IDs, descriptors, checkpoints or source metadata as public routes. The future authenticated dispatcher must map narrow commands onto this orchestration.

Call explicit writer bootstrap only after production parent IDs, store ID, writer script ID and anchor ID are configured. Do not auto-bootstrap an empty store when an existing anchor is inaccessible. A bootstrap collision must resolve to the existing identity or fail closed.

Asset writes remain under `drive.file`; original direct-child source reads remain under the approved `drive.readonly` plus external request scope. No DriveApp or full-drive write scope is used. `metadataParentId` holds immutable authoritative protocol objects; `assetsParentId` holds app-created normalized assets/checkpoints. The fixed source folder remains separate and read-only.

Publication transfers the live linked asset root from job pin to run in one writer frame. Completed assets remain readable through the current run; they are not writable/adoptable as fresh staging. Duplicate candidates retain their pin pending explicit resolution. No cleanup silently releases these holds.

## Automated evidence

The new tests exercise real composition of production modules against a local GAS-shaped Drive simulator, rather than replacing the writer with an in-memory transaction implementation. Lower-level tests additionally isolate malformed API responses and injected failures.

Covered cases include fixed bootstrap identity, different/same command winners, response loss before/after creates, exact same-ID retry bytes, original receipt replay after checkpoints, stale versions, tombstones, ordered epoch retirement, mandatory index-barrier interruption, stale/missing non-authoritative hints, missing/corrupt mandatory data, failed recovery invalidating cached state, bounded shards, cold scan restart, reserved upload restart, strict manifest links, full normalized-output verification, source changes, duplicate copies, owner-safe replacement, and privacy changes before resume. No test writes an original source.

Run:

    node build-gas.mjs
    node --test *.test.mjs

Frozen final aggregate: **411 tests passed, zero failed/skipped**, in 35.6 seconds on Node v24.19.0. Final result is recorded in `storage-test-results.txt`. Existing >100 MB portable parser/hash stress tests remain included. They measure local boundedness and correctness, not GAS service throughput. Real source files and private coordinates are not packaged.

## Remaining before live application acceptance

1. Add the bounded hash-first identity path for originals without MD5. Current code deliberately rejects them; it does not infer identity from timestamps.
2. Add a durable scheduler/current-scan pointer, retry/backoff/error-state policy, changed-active-source pause/cancel handling (including unchanged-content rename/version bumps), and rolling account/runtime budgeting. Low-level resumable steps and cold job discovery exist, but an hourly trigger is not installed or silently authorized.
3. Finish production bootstrap provisioning, fixed store configuration and the signed owner-only server dispatcher/Vercel session/CSRF boundary. No unauthenticated entry point may call this storage core.
4. Integrate MyPace entity/domain commands, IndexedDB/outbox/snapshot sync, owner migration, progress/error/backlog UI and chunked route reads. Imported sample metadata is not an authoritative distance/duration/pace/reward calculation.
5. Implement retention/GC with protected roots, ordered retirement and grace rules; currently files are retained. Configure real operation epochs rather than using the local default indefinitely. Authenticated fixed-ID checkpoint hints now accelerate new-store cold recovery; retention/GC and reader snapshot-token retention integration remain absent.
6. Run the two already defined live acceptance bundles against the coherent candidate: actual folder import with interruption/restart; and deployed app save/reload/recovery/auth/conflicts. Measure actual GAS time/quota and observe the small immutable-create publication assumption. Do not ask the owner to perform separate manual probes for documented platform features or custom-code fault coverage.

An individual Google service call cannot be interrupted by JavaScript deadline checks. UrlFetch buffers responses before code can reject a server that ignores Range. These remain documented platform constraints; local mocks cannot remove them.

## Authenticated checkpoint hint addition

The local candidate now includes optional domain-separated HMAC-SHA256 checkpoint hints at one separately pinned private Drive ID. New bootstrap configuration and anchors include the hint pin; existing no-hint stores remain unchanged and use full anchor recovery. Hints require the manually configured existing writer secret and cannot be supplied by a client. A valid hint is verified against its immutable index, manifest and publishing frame before successor traversal; authenticated references to missing/corrupt committed data fail closed. Hint failures never reset the store or invalidate a durable commit. The original absolute 4,096-checkpoint maintenance ceiling and lost-all-evidence limitation remain. See the authenticated-hint section of `PERFORMANCE-NOTES.md` for the exact format, IO/privacy checks, key behavior, non-authoritative recovery semantics and local test evidence.
