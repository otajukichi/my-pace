# Retained history and recovery maintenance

## Current authenticated configuration

The previous4096-lifetime-checkpoint stop has been removed for stores configured with the fixed-ID authenticated recovery hint. `maxIndexScanLinks` defaults to64 newly traversed INDEX links per call. It limits a recovery slice, not total retained history. A signed public API uses a smaller trusted slice to fit its shorter deadline.

A cold store with a missing/invalid hint recovers incrementally. The bounded authenticated cursor attests only verified immutable INDEX-prefix traversal; it does not contain an authoritative business snapshot. Until the latest checkpoint and live tail are verified, reads, receipt decisions and writes remain unavailable, with retryable `WRITER_RECOVERY_PENDING`. Repeated calls continue automatically from the durable cursor. Invalid/lost advice can cost rereading; it cannot erase records or acknowledge unfinished work.

The regression builds4,101 genuine checkpoints, removes its entire hint, recovers in65 bounded calls and successfully writes checkpoint4,102. Existing values and receipt replay are verified. This demonstrates traversal past the former limit; it is not a universal storage/latency guarantee. See `BOUNDED-INDEX-RECOVERY.md` for exact IO bounds, binding and fail-closed cases.

## Legacy setup

An older store without authenticated hint configuration retains a conservative bounded fallback. If it exceeds that fallback it reports `WRITER_RECOVERY_SETUP_REQUIRED`, requiring the explicit owner configuration upgrade and existing server secret. Never increase a lifetime cap blindly, delete history, reset configuration or edit an immutable bootstrap to make recovery succeed.

`MyPaceRepairRecoveryConfiguration` verifies owner/script, private folders and the existing immutable anchor before extending only missing fixed advisory IDs. It binds any legacy hint extension to the exact verified anchor hash. Original folders, slots, generation, epochs and history remain unchanged. The owner must already have configured the server secret. `MyPaceRecoverStorage` performs a bounded recovery step and reports ready/recovering/setup-needed truthfully. Read the owner kit for the final exact invocation sequence.

## Idle behavior

Successful unchanged scans no longer consume journal/checkpoint history. A24-hour/96-tick three-source model created zero new immutable frames, checkpoint indexes, manifests or radix nodes; it used one fixed mutable discovery file. Large unchanged paginated folders also pass with cache eviction on every tick. This removes the former inactivity-driven~100-day estimate rather than postponing it by raising a cap.

Business changes, real imports, budget reservations and meaningful error state still create retained history. Retention and garbage collection are not implemented. Drive storage, catalog/shard bounds and individual service latency remain finite constraints; a supported recovery path is not a promise of unlimited capacity. Missing/corrupt authenticated authority remains a visible integrity failure and must not be bypassed by discarding its valid hint witness.
