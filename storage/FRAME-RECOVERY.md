# Short web reads after interrupted manual import

This patch addresses a reproducible local failure mode, not a confirmed diagnosis of a specific live Drive history. Authentication success and `STORE_YIELD` distinguish the storage work budget from Google login rejection. The web endpoint still has a 20-second between-call work budget, the server request still times out after 25 seconds, and Vercel still permits at most 60 seconds. A slow in-flight Google call is not interruptible by the between-call check.

## Why retrying could repeat the same work

Every public snapshot, import-list, route, and import-status request performs cold storage recovery. INDEX traversal had a durable signed prefix cursor, but frame-tail replay did not. A yielded manual import only sealed a quiescent checkpoint on whole-scan completion. Repeated public reads could therefore replay the same unfinished tail until the same 20-second budget expired. The app also starts fresh syncs on its visible 60-second timer, visibility and online events; those are new requests, not evidence of durable continuation.

## Bounded owner repair

After installing the updated complete GAS file into the same existing project, run `MyPacePrepareWebSync` once in the owner editor. It:

1. Checks active/effective owner, script, existing pinned configuration, private folders and immutable anchor. It does not bootstrap a new store or replace the signing secret.
2. Recovers existing history with authenticated frame-prefix progress enabled. No CSV scan/import is started or reset.
3. After full verification, writes a no-business-change checkpoint when more than one frame must be replayed. Its operation ID binds the verified revision/head hash. The writer resolves ambiguous commits and repeats at the existing reserved slot.
4. Releases the lock and constructs a fresh runtime for a cold storage-recovery probe with the actual 20-second public budget. This probe verifies recovery only, not every application page. The result explicitly says `scope: cold-storage-recovery`.

`ready` means that cold storage probe passed; try one normal app sync. `prepared` means the owner hard deadline left insufficient time for the probe; the probe was not run. `web-budget-blocked` means even the prepared tail did not fit and should be reported rather than repeatedly retried. `recovering` with a persisted, advancing frame revision or INDEX cursor can continue from saved progress. `recovery-budget-blocked` means no new durable frame cursor was confirmed; report it instead of repeatedly issuing the same action. A single unusually expensive frame or failing hint write can still prevent progress. No universal latency guarantee is made.

The owner action does not expose a web endpoint. Repeated successful preparations do not create new immutable checkpoint history. It may update the fixed advisory file; that file remains private and unauthoritative.

## Frame-prefix trust and integrity

`mypace-frame-scan-hint-v1` uses the existing fixed hint file, authenticated HMAC envelope, 4,096-byte maximum and domain separator. It binds owner-selected store/script/schema/generation, anchor ID/hash, hint-file ID, last verified immutable frame ID/hash/revision, current immutable INDEX reference/ordinal, and replay-frame count. It contains no state roots, application values or receipts.

Only explicit owner preparation writes this protocol. It signs a prefix only after the complete frame transition, roots, references and mandatory checkpoint publication were verified. First/every-fourth/final verified frames are persisted; failed writes are not reported as confirmed. A prefix is never a ready application snapshot.

Every consumer rechecks the immutable anchor and the authenticated referenced INDEX. INDEX successors are still traversed. If a newer INDEX exists, its current checkpoint takes precedence and ordinary recovery applies. Otherwise, the current manifest and mandatory publishing frame/INDEX proof are reverified before restoring the authenticated frame prefix. The exact seed frame is reread, schema/identity/hash checked, and accepted epochs, roots and head receipt are derived from those immutable bytes. Both next INDEX and next frame remain fresh probes; all later frame transitions and minimum-acknowledged proofs are verified normally before any read or mutation is allowed.

Malformed/foreign/unauthenticated advice falls back to the fixed anchor. A valid authenticated missing/corrupt witness fails closed. Stale advice can only cost extra traversal. Existing older code ignores the new hint protocol and performs full recovery; it does not reinterpret a frame cursor as an INDEX cursor.

## Manual import settlement

Manual admitted slices now reserve 30 seconds and up to 256 service calls for settlement, within the unchanged 120-second hard owner limit. They persist the final scheduler status first, then seal it. A failed seal never reclassifies or discards an already committed success/error status. `checkpointReady` reports immutable checkpoint completion only; it is not a cold web-read proof, because the advisory hint update may still fail. A partial seal is reported explicitly. Scheduled import behavior is unchanged.

A rejected 60-second closing reserve starved useful manual work in a 750ms/request model; it was removed. The retained 30-second setting completes the 130-row model in three invocations at 750ms/request. At 1s/request the same model completes in nine invocations; some slices correctly report incomplete sealing. Live behavior remains service-dependent.

## Local evidence

- A parsed 130-row job with three uncheckpointed frames repeats `STORE_YIELD` after exactly 20 modeled 1-second requests on two successive cold reads.
- One owner preparation takes 51 modeled seconds; afterward full snapshot, imported-run listing, and import-status actions each take 17 modeled seconds.
- A longer frame tail survives bounded owner yields with increasing persisted revisions and preserves values, operation receipts and source bytes.
- Adversarial review covers forged/foreign hints, missing/corrupt seeds, deleted current manifest/publication, delayed INDEX visibility, lost hint acknowledgments, epochs, receipt replay, minimum acknowledgments and reentrant reads.
- These are local synthetic tests, not live Google or Vercel acceptance. The package does not deploy, create triggers, edit original CSV files or change credentials.
