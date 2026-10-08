> 過去の実装・検証資料です。本文中の手順・時間予算・制限・試験数は当時の記録で、今回の導入やロールバックを指示しません。現在の手順は [PRACTICAL-SYNC-INSTALL.md](PRACTICAL-SYNC-INSTALL.md)、設計は PRACTICAL-SYNC-DESIGN.md を優先してください。旧インストーラー、初期 bootstrap、ストア移動、秘密情報・OAuth・公開権限・トリガーの変更を今回の更新で繰り返さないでください。

# Incremental sync backend candidate

Local candidate, 7 October 2026. No live activation, deployment, account change, or production write was performed by this work. Synthetic results below are not a Drive latency or quota guarantee.

## Compatibility and owner decision

The existing store, generation, immutable files, operation receipts, entity versions, and pending client operation IDs are retained. The app does not activate incremental sync at login or on a read. Until explicit activation, v2 pull returns `SYNC_V2_MIGRATION_REQUIRED` with `requiresOwnerAction:true`.

`MyPaceEnableIncrementalSync` is an explicit editor-only function for the same owner-authorized Apps Script project. It verifies both active and effective owner identities, the existing pinned configuration, and the existing recovery secret; it never bootstraps an absent store. Its deterministic operation atomically appends the v2 format fence and zero-sequence journal head. Repeat that same function to resolve an ambiguous result. Existing legacy receipts remain byte/semantically unchanged and replay before journal or version checks.

Running activation is an irreversible old-code compatibility boundary. After the fence, old storage bundles fail closed, including after later checkpoints. The owner must approve this boundary before live activation. After activation, rollback must retain a fence-aware storage writer; restoring the old entire GAS bundle is not a compatible rollback. No code in this candidate performs a live activation automatically.

## Atomic application journal

Every new app mutation on a fenced store atomically commits its business entity, catalog updates if needed, one absolute-sequence ring event, and journal head/floor in the existing reserved-slot frame. The journal has 1,024 logical slots. Events contain key/version/deletion metadata, not a second copy of a large diary value. Imports and maintenance revisions do not increment the app sequence. Retrying an original operation receipt does not emit another event.

Internal catalog/head/slot contention causes bounded receipt-first recovery and metadata rebuilding. A verified business-key version mismatch remains a conflict. Exhausted unrelated metadata contention is retryable, not a false user-data conflict.

## Read contract

`pull` accepts exactly:

- `cursor`: null or signed opaque continuation
- `since`: null or `{store,generation,seq}`
- `minimumAcknowledged`: null or `{store,generation,revision,hash}`

A new pull freezes one verified immutable COW state root. Snapshot continuations traverse radix leaves sequentially, with up to 128 business entries and encoded UTF-8 byte admission before append. Non-business state may yield an empty but advancing page. Delta pages consume at most 24 journal events, coalescing repeated keys against that frozen root. Snapshot `throughSeq` is null until the complete cut; only the final page has the resumable application checkpoint. Writer revision and application sequence are separate.

Cursors are purpose-separated, signed, identity/root/proof-bound and absolutely expiring. Snapshot lifetime is 24 hours; delta lifetime is 15 minutes. Continuations keep their original expiry. A current-root ring wrap cannot invalidate an already-issued frozen-root cursor while old files are retained. A new request below the retained floor returns `RESET_REQUIRED(retention-floor)`. Invalid or missing data fails closed; it is never reported as an empty successful delta.

## Bounded recovery and IO

Normal public reads receive 20 seconds, commands and authenticated recovery 35 seconds. Proxy limits are 25 and 45 seconds respectively; Vercel function maximum is 60 seconds. Per-call Drive REST timeouts are bounded by the remaining deadline, at most 8 seconds, with response reserve. Optional hint writes use a 2-second cap and require headroom. These configured timeouts still need real GAS runtime verification.

`recover({})` retains a diagnostic ready response. `recover({pull: originalFirstPagePayload})` returns a normal bounded protocol-2 page in the same verified lock phase. Its nested pull must have exactly the three fields above and cursor=null. It exists because merely recovering and then starting a second cold 20-second pull can repeat the irreducible recovery cost indefinitely. It cannot dispatch arbitrary actions or accept raw root/file IDs. It preserves the original `since` and minimum acknowledgement.

Only confirmed advancing durable recovery is exposed as `WRITER_RECOVERY_PENDING` with phase, revision/index ordinal, `cursorPersisted:true`, and `cursorAdvanced:true`. A no-progress deadline failure remains an explicit retryable budget error, not ready, not a partial page, and not an instruction to recreate or manually prepare the store for each record. Client retry is separately bounded and uses the original operation UUID.

Drive create/generate-ID/read/advisory-update requests use fixed Google hosts, no redirects, strict MIME/metadata validation, and bounded bytes. A create response is not proof: the original reserved ID is read back and verified. Ambiguous requests never renew an operation ID or substitute a new reserved frame ID. No access tokens or secrets are persisted or logged by the REST transport.

## Local evidence to date

- Generated bundle + actual REST adapter + synthetic Drive service: 100 successive acknowledged app writes at 100/300/500 ms per service call, including checkpoint rollover. Every following delta uses 23 cold service calls. Maximum overall request time was 5.9/17.7/29.5 seconds respectively, within its action's budget. These are simulated service delays.
- Generated combined-recovery tests: initial pulls with 1, 2, 5 and 20 unhinted tail frames complete at 750 and 1,000 ms/service, using strictly advancing persisted recovery where necessary. The longest measured recovery slice was 33 seconds.
- Sustained 2,000 ms/service in the tested recovery fixture fails explicitly within budget; it never reports readiness or returns a partial result without a cursor.
- Generated owner-entry tests preserve an existing Japanese diary and original legacy receipt, reject incorrect active/effective owners before storage work, reject public activation actions, and never bootstrap absent pins.
- Actual-module tests separately cover old-code fencing, ambiguous activation/command receipts, fixed-ring overwrite, frozen snapshots/deltas, exact acknowledgement proofs, UTF-8 response admission, 50,000-record cold radix bootstrap, and malformed protocol data.

Final aggregate test results and independently measured large-dataset costs belong in the final verification report. The figures above alone are not release qualification.

## Packaging and remaining gates

`npm run verify` first rebuilds GAS, then runs deterministic `check:gas`, syntax checks, all non-heavy tests, and the frontend build. `npm run check:gas` does not rewrite files; it fails if any checked generated GAS differs from current module sources. Heavy suites are separate (`npm run test:heavy`).

The complete deployment source remains `gas/MyPaceComplete.gs`, containing owner storage, app protocol, signed dispatcher and web entry from one checked build. Keep existing project/configuration/IDs; do not paste separate duplicate generated bundles into the same GAS project.

No physical Drive GC is implemented. Immutable frames/shards/checkpoint skeletons, receipts and tombstones continue growing over lifetime. Bounded interactive work and fixed logical journal slots do not imply bounded total storage. Frozen-cursor retention requires preserving referenced files for the full token lifetime; any later GC design must honor that explicitly.

Real Apps Script timeout enforcement, Drive latency/visibility/ambiguous-create behavior, browser IndexedDB migration/durability and isolated browser-profile acceptance remain separate live gates. Node/vm/IndexedDB protocol doubles do not establish those outcomes.
