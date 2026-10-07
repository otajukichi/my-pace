# Bounded INDEX recovery

Local implementation and synthetic tests only. No live Drive, credentials, trigger, deployment, push, source-file mutation, deletion, or garbage collection was performed.

## Authority and compatibility

The existing immutable bootstrap, INDEX chain, current checkpoint manifest/publication, live frame tail, shards, records, and receipts remain authoritative. Nothing is reset, renumbered, deleted, compacted, or moved to a new store.

The fixed private hint file accepts two HMAC-authenticated payload protocols:

- `mypace-checkpoint-hint-v1`: the existing checkpoint acceleration payload
- `mypace-index-scan-hint-v1`: a verified immutable INDEX-prefix cursor

Both payloads bind store, writer script, schema, dataset generation, fixed hint-file ID, anchor ID/hash, last INDEX reference, and absolute INDEX ordinal. The envelope remains at most 4,096 bytes. The scan cursor contains no business-state roots or receipts and never makes a writer ready.

An absent, malformed, tampered, foreign, or old-key cursor restarts from the fixed anchor. A delayed valid cursor can regress progress, but recovery follows all successors again. A valid authenticated reference to a missing/corrupt INDEX fails closed instead of silently reverting.

INDEX-only discovery deliberately does not open intermediate checkpoint manifests/publication bodies. Historical retirement of those objects remains compatible. Only the newest discovered checkpoint is restored, then its manifest, mandatory publishing frame/INDEX binding, and current live tail are verified. Saved acknowledgement proofs are checked before readiness. Public state, receipt, and mutation APIs cannot succeed during incomplete recovery.

## Bounded work

The authenticated default is 64 newly traversed INDEX links per recovery call (`maxIndexScanLinks`). A smaller configured `maxIndexLinks` is also respected. `maxIndexLinks` no longer limits authenticated stores' lifetime history; the ordinal is exposed as the `status().indexLinks` metric.

A discovery slice reads at most:

- 64 newly accepted INDEX links by default
- One additional boundary probe
- One authenticated cursor-seed INDEX, if present

The selected current publication separately verifies its INDEX during final restoration. Frame replay and shard traversal retain their existing independent bounds. A warm-state successor probe can add one preliminary INDEX read before a cold restart in the same call.

The constant-sized cursor is written after the first verified new link, after each 16 verified new links, and at slice exhaustion. Saving the first link prevents a short/slow service budget from repeatedly starving before the first periodic checkpoint. Interrupted INDEX reads attempt to preserve the last verified prefix as well. Writes use the existing fixed-ID, one-attempt advisory IO. Failed writes and lost responses can cause repeated work but cannot change authority.

Link-budget exhaustion throws `WRITER_RECOVERY_PENDING`, with `retryable=true`, `indexLinks`, `scannedLinks`, and `cursorPersisted`. All ready state is invalidated. The next invocation continues from whatever valid cursor is actually durable; it never assumes an uncertain write succeeded. External service/time-budget exceptions can still end an invocation earlier; previously persisted progress remains usable.

Legacy/no-codec stores retain bounded safe admission and return `WRITER_RECOVERY_SETUP_REQUIRED` when authenticated continuation is required. This error includes owner-action/setup guidance; it is not permission to increase the lifetime bound, discard history, or recreate the store.

## Owner repair binding

Normal stores keep their immutable bootstrap's embedded `checkpointHintId`. Trusted owner repair may configure a replacement fixed hint ID together with `checkpointHintAnchorHash`, obtained from `readBootstrapInfo()` after fresh bootstrap verification. The hash must match the existing immutable anchor exactly. This supports both legacy anchors without an embedded hint and replacement of an original hint pin without changing anchor bytes.

The replacement option is server-side trusted configuration, never request data or an arbitrary recovery root. A hash-bound anchor that is missing cannot be bootstrapped again: the writer fails before allocation or creation. `readBootstrap()` retains its previous payload-only API.

## Verification

`index-recovery.test.mjs` covers reduced per-call bounds, a 64-link default slice, loss/tampering/regression, key loss/rotation, service interruptions, failed/lost advisory writes, forbidden mutations while scanning, retired intermediate manifests/frames, required current publication/tail/acknowledgement validation, late INDEX/frame visibility, owner binding, epoch-fence admission, and fixed-ID GAS IO request bounds.

The long-history test creates 4,101 real immutable checkpoints through the writer. After removing its hint, recovery completes in 65 calls with no more than 66 present INDEX reads per call, preserves original data and receipts, and successfully creates checkpoint 4,102. It uses smaller receipt leaves for economical local test execution, not a different authority protocol.

Other retained regression suites: reserved writer, checkpoint authentication/IO, adversarial hint review, safe no-codec admission, and warm recovery review. Full release validation must also include the owner scheduler/repair and packaging changes maintained alongside this work.
