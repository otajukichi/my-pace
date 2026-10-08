# Practical sync candidate: bounded compatible writer

Local-only candidate, not deployed and not live-Drive qualified. Model measurements must not be described as production latency. The owner still explicitly activates the existing irreversible format-2 fence; this change does not add another migration or change credentials, permissions, store IDs, source folders, or generation.

## Decision and alternatives

Keep the existing immutable representation for this install, while making the common execution path smaller and resumable. A local immutable per-record prototype in `qa/practical-sync/compare-representations.mjs` reduces one proposal to252bytes/one object, and preserves competing branch values in its reducer. Its2/4-call upload floor is **not** an end-to-end alternative: safe stable-ID assignment, complete discovery, pagination/current views, compaction, authenticated migration and user-visible branch resolution remain unqualified. The source-compatible candidate preserves existing record version conflicts, exact operation replay and fail-closed activation today. This is an incremental practical choice, not a claim that the old representation is intrinsically optimal.

## Invariants kept

- The browser durably queues the exact command before background IO. Failed/ambiguous transport cannot remove pending intent or invent a cloud ACK.
- Stable operation UUID, epoch, store/generation and command digest; expected record version and explicit conflict. Immutable reserved IDs and sole commit frame remain authoritative.
- Every newly observed referenced object has ID, owner, privacy, parent, bounds, schema and hash validation. No undocumented Drive CAS is used.
- Response loss and409 are reconciled at the original exact ID. No alternate-ID escape, silent overwrite, deletion or garbage collection.
- Prepared output assignments are durable before output creation. Delayed competing writers and old pages are still accepted only through existing exact winner/adoption checks.
- CSV source additions are expected and remain separate from the app-managed private protocol folder and small-write lane.

## Explicit trust contract and changed detection frequency

The app-managed store is owner-private and changed only by this cooperating application. The user does not manually move, overwrite, delete or share its protocol objects. This premise does not apply to the CSV source folder.

1. A managed write phase checks folder privacy once while holding the same ScriptLock. Positive immutable object proofs live only in that phase; same-ID attempted create, lock loss or phase end invalidates cached proof. This changes detection from before every create to the next lock phase for a forbidden manual parent-permission change. It does not claim ScriptLock prevents external sharing.
2. A successful create may avoid immediate metadata/media rereads only when the authenticated response supplies exact ID, role/store markers, one pinned parent, private ownership, MIME, size, positive version and server SHA-256 of the exact serialized uploaded bytes. SHA-256 is optional in Drive: missing/incomplete/invalid proof keeps the original exact-ID readback. A copied appProperty digest is never proof. Each batch remains all-or-none proof publication on transport ambiguity; known partial writes are read back.
3. Current-key purpose-separated `mypace-attested-frame-prefix-v1` recovery advice may attest an already-verified immutable history prefix. Fast restore still rereads/hash-checks the exact signed frame and current INDEX, verifies anchor/store/generation/script/schema binding, checks index count/cut/revision consistency and scans for a newer INDEX. Current record nodes and minimum acknowledged revision are checked normally. Old generic FRAME_SCAN hints cannot opt into this stronger path. The new attestation explicitly binds writerFence, and prepared progress has a separate version and HMAC purpose. Absent/old-key/mismatched advice or newer INDEX uses the full old recovery path. A missing signed witness fails closed. This intentionally postpones detection of forbidden manual corruption/deletion of older checkpoint proof objects. The `maintain` action and owner recovery tools disable this shortcut and verify the selected current checkpoint manifest/publication; they are not exhaustive audits of every historical object.

Current-key hint producers sign only verified writer state: `_writeFrameScanHint` after full original recovery or extension of an exact already-attested prefix and applied/verified frame transitions; `PreparedWriter._seed` used by `_saveProgress` binds the already-recovered parent, never planned output state. All durable work page signatures bind store/script/schema/generation, descriptor, exact parent/commit slot, ordinal, previous page and state hash. Reusing these facts is not authorization to trust caller-supplied flags.

## Work budgets and resumability

Record command, pull, legacy snapshot, recover and maintain:45s server admission budget;55s proxy timeout;65s browser timeout. Hosting function configuration is60s and needs verification on the actual plan. CSV route/import summaries retain20/25/35s independent limits. These are admission/timeouts, not hard guarantees that synchronous token acquisition or platform calls return on time.

Cold preparation no longer eagerly rereads every mutation path before making one durable step. Node dependencies remain lazily verified by the planner. Existing output IDs in a resumed assignment are checked first; only missing outputs are dispatched again. A current-key authenticated immutable work page can reuse its exact assignment recipe/state binding for already-created outputs, instead of reconstructing their old dependencies again. Exact output ID/hash/schema/tree/depth still has to validate; absent outputs are reconstructed deterministically, and unsigned/old-key work retains independent semantic replay. The final durable work state is unchanged, so older anchored four-node pages remain compatible. Large branch-tree assignments are limited to two nodes when the reserve admits a batch (otherwise one), while tiny leaf writes can use four. Already-anchored old batches remain readable.

A managed hint update needs only metadata+update because parent proof is already phase-bound. Its advisory admission is4s rather than7s; each actual request still recalculates remaining timeout and response reserve. Failure/response loss never reports a persisted/advanced cursor. This prevents a verified slow frame from repeatedly losing its chance to persist progress.

## Maintenance and compatibility

`maintain` accepts exactly{} through the same owner session, CSRF check and signed dispatcher. Soft maintenance starts at16 replay frames after record ACK/read confirmation and when the browser has no pending edits/conflicts. It is one bounded request, not a trigger or an unbounded loop. The client yields subsequent slices to newly queued local work. Failures are displayed separately from record-save status.

The hard64-frame barrier requires checkpoint completion before further mutation if idle maintenance never runs (including older clients). The256-frame reader limit is unchanged. Maintenance may finish an already-occupied immutable preparation before checkpointing; it does not discard or cancel another pending operation. No promises of uninterrupted global linearizability or immediate cross-browser agreement are added.

Existing owner sequence uses the same project and existing configuration: install bundle, explicitly prepare existing history, update the same deployment and app, then explicitly run `MyPaceEnableIncrementalSync` after accepting the existing rollback boundary. Once activation is attempted, a lost/ambiguous response may already mean fence2 committed; retry the same activation function, never restore an older unfenced bundle on the assumption that missing ACK means failure. Local IndexedDB migration is a separate boundary documented by the client/installer.

## Retention is still a limit

No GC was added. The100-short-journal model with idle maintenance retained757 managed objects including setup and8,612,933content bytes (about8.21MiB);701objects/8,263,433bytes came from record writes, with maintenance/setup making up the balance. This run includes growing COW leaves and receipt history. These are retained protocol bytes, not100copies of user text. Ordinary leaf writes still create7immutable objects; slow/deep resumable writes may create more work pages. Network optimization does not eliminate storage amplification.

A linear illustration at this measured workload's average is roughly30MiB/year for one save/day or300MiB/year for10saves/day; that is **not** a growth forecast or supported indefinite-capacity claim. Larger histories, larger text, imports, Drive quota and retention increase actual costs. Long-term operation needs measured usage and an explicit future compaction/retention design; no destructive cleanup is authorized by this patch. Real user workflow capacity and account quota remain owner acceptance checks.

## Validation status

See the final backend report and exact source manifest. Exploration logs may combine evolving candidates and are not release evidence. Key gates: no silent intent loss; exact replay and conflict; full and missing create proof; slow/serial/cold progress; lost ACK; resumed partial outputs; maintenance debt; post-ACK read confirmation; generated ES2020-compatible GAS. Worst combined legacy-tail/token/serial stress can exceed the approximately10-minute goal even while converging. Only measured workload envelopes may be advertised; live Apps Script/Drive and actual browser verification remain separate.

### Authenticated assignment producer boundary

The recipe-reuse path is limited to the managed web runtime. It accepts a current-key WORK-v1 MAC only after `_checkWork` has bound the complete immutable page body to its descriptor, store/script/schema/generation, unchanged parent, commit slot and ordinal. The scoped in-memory authority also binds the exact page state hash and preparation reference; it is never a caller-supplied boolean. Output ID, expected hash, slot, type, tree and depth are still checked. Old-key, unsigned, changed-state, changed-parent and unmanaged runtimes retain deterministic reconstruction.

The supported WORK-v1 producers are the unchanged baseline prepared writer used by the frozen candidate and this candidate: `_appendWork` signs the state returned by deterministic `_transition`, including each pinned node ID, exact cursor and computed recipe. Independent tests use an actual old generated producer, rather than merely synthesizing a signed object. Deployed4ff0b1c predates prepared-work files, but this compatibility case remains reachable after activation through leaf splits and owner/scheduled preparation. This is not permission to trust arbitrary custom code that shares the secret.

A failed or lost same-page advice upgrade never advances an ordinal or acknowledges an edit. It merely changes to the stronger, purpose-separated recovery attestation after full original recovery completed. All partially created output IDs remain pinned; only verified complete assignment results become the next durable work state. No work format or business fence is changed by this optimization.
