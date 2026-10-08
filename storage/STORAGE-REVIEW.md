> 過去の実装・検証資料です。本文中の手順・時間予算・制限・試験数は当時の記録で、今回の導入やロールバックを指示しません。現在の手順は [../PRACTICAL-SYNC-INSTALL.md](../PRACTICAL-SYNC-INSTALL.md)、設計は ../PRACTICAL-SYNC-DESIGN.md を優先してください。旧インストーラー、初期 bootstrap、ストア移動、秘密情報・OAuth・公開権限・トリガーの変更を今回の更新で繰り返さないでください。

# Independent storage integration review

Scope: local GAS Store IO, reserved-slot writer, import-domain binding, runner, and runtime composition. No external actions, Drive writes, source mutations, deployment, or authorization changes were performed. All IO in this review used mocks.

## Findings resolved and verified

- **Malformed metadata was mistaken for absence.** HTTP 200 with JSON `null` returned the same sentinel as HTTP 404. Metadata now requires a non-null, non-array object. Invalid metadata cannot free a reserved slot.
- **A parent lookup could exhaust the write budget.** Store IO now checks lock ownership and budget again immediately before the immutable create. Regression tests cover budget expiry and lock loss during the preceding lookup.
- **Resume/finalization skipped current asset privacy metadata.** Runtime-managed reads now verify ID, private ownership, exact managed parent, MIME, length, and store/job/pin/role/hash markers before downloading bytes.
- **An old runtime could authorize a retired reservation.** A newly acquired reservation-read lock phase now performs authoritative recovery. A second runtime's committed cancellation blocks the old runtime before an asset create.
- **Failed recovery left partial state readable.** Failed writer recovery now invalidates cached state. Status, record, and receipt reads remain blocked until recovery succeeds.
- **Transient reads were mislabeled as corrupt JSON.** Asset reads now occur outside the JSON parsing catch. Budget yields and media outages retain their original retryable classification, and a cold retry can resume.
- **Managed metadata/source checks needed the shared invocation budget.** Runtime metadata and source-validation calls now use the shared budget; source checks accept the configured deadline.

## Verification

- `gas-store-io.test.mjs`: 201 passing cases, including malformed metadata/ranges/headers, 404 versus 403/500 handling, fixed-ID create conflicts/timeouts, every signed Java byte value, lock ownership, private parents, ID-generation validation, source immutability, and the exact 2 MiB boundary.
- `review-regression.test.mjs`: four passing composed regressions for transient checkpoint failures, failed-recovery invalidation, and cancellation across runtime instances.
- Latest focused integration run: 271 passed, zero failed, across these two files plus `gas-runtime.test.mjs`, `import-store.test.mjs`, `reserved-writer.test.mjs`, and `import-runner.test.mjs`.
- The integrating owner will run the frozen final aggregate. No additional unresolved local blocker was identified in this review.

## Remaining limits

- Mocks establish ordering, bounds, and fail-closed behavior; they do not establish Drive's atomic complete-byte visibility or behavior during real lost responses/concurrent fixed-ID creates.
- An HTTP 404 is the adapter's absence sentinel. Drive can also conceal inaccessible resources as 404, so status classification alone does not prove genuine absence. The real owner/script/scope path remains an acceptance gate.
- GAS buffers HTTP responses and cannot interrupt an already started service call. Exact Range/status checks and between-call budgets do not create a streaming response cap or per-call timeout.
- The modules are server-internal. They are not authorization for arbitrary client-controlled IDs, a public authenticated endpoint, a complete application migration, or a deployed scheduler/cleanup implementation.

## Independent import-binding review addendum

The frozen `import-store.test.mjs` was independently rerun: **38 passed, zero failed**. The review reproduced and verified fixes for:

- **Checkpoint mapping could change mid-file.** An established header is now exact-match frozen across checkpoints. Only the parser's named base and observed 21-column sensor schemas are accepted; preamble state cannot regress.
- **Valid output hashes could accompany forged run summaries.** Checkpoint row/header/preamble/parser/count invariants are enforced. Finalization independently parses every bounded normalized output, validates point fields, and recomputes first/last timestamps and non-increasing-time counts with full submillisecond ordering before publication.
- **Historical content indexes could suppress a valid generation.** A source changing A → B → A can create a replacement; duplicate claims must match the current live run generation. A held duplicate can be explicitly rechecked with a new publication operation ID after that generation changes.
- **Terminal status lookup tried to read retired assets.** The runner now checks `getJob` before resuming completed, duplicate, or cancelled jobs. This preserves the distinction between metadata lookup and authorized asset reads.

No remaining data-corruption or reservation-security blocker was found within the server-internal trusted-parser model. These APIs must not become arbitrary client-controlled checkpoint or generic entity-write endpoints.

Remaining domain policy is explicit: an unfinished source whose version/metadata changes requires ordered cancellation and re-registration; automatic invalidation and changed/missing-source scan outcome handling are not implemented. Duplicate candidates retain their pins pending explicit resolution/recheck. Missing-checksum fallback, live acceptance, GC/quarantine, and scheduler/UI work remain outside this local binding milestone. Individual records and scan pages are bounded; linked job/scan history still grows with the number of jobs and pages.
