> 過去の実装・検証資料です。本文中の手順・時間予算・制限・試験数は当時の記録で、今回の導入やロールバックを指示しません。現在の手順は [../PRACTICAL-SYNC-INSTALL.md](../PRACTICAL-SYNC-INSTALL.md)、設計は ../PRACTICAL-SYNC-DESIGN.md を優先してください。旧インストーラー、初期 bootstrap、ストア移動、秘密情報・OAuth・公開権限・トリガーの変更を今回の更新で繰り返さないでください。

# MyPace folder import: local integration slice

**Owner-runtime candidate:** [OWNER-KIT.md](OWNER-KIT.md), [OWNER-SCHEDULING.md](OWNER-SCHEDULING.md), and [PERFORMANCE-NOTES.md](PERFORMANCE-NOTES.md) describe the current owner-controlled bootstrap, manual/periodic runtime, authenticated integration boundary, and measured local limits. Historical milestone statements below are retained as dated evidence, not the current feature checklist. No deployment or live acceptance is implied.

**Storage integration update:** [STORAGE-MILESTONE.md](STORAGE-MILESTONE.md) supersedes the missing-writer status below. The local package now composes the durable reserved-slot writer, job/scan indexes, reservations, resume and verified run publication. It remains undeployed, with explicit remaining app/security/scheduler work.

**6 October 2026 adapter update:** see [ADAPTER-MILESTONE.md](ADAPTER-MILESTONE.md) for the new GAS-compatible codecs/hash, source transport, bounded manifest/checkpoint preparation, immutable asset adapter and existing-writer coordinator. This is still local-only; the production writer binding, scheduler and end-to-end app import are not supplied. Historical core evidence below is preserved.

Status: isolated, tested core and integration plan; **not deployed**. No OAuth, Google file mutation, trigger creation, repo push or deployed application change. Original CSV materializations are outside this directory and must not be bundled. No source coordinates or rows appear in fixtures/results.

## Checks

Run `node --test core.test.mjs large.test.mjs` (Node 24). All 13 tests passed. The large test generates 113,600,000 bytes, verifies 1,600,000 records and the full normalized SHA-256 against independently constructed expected rows, and reconstructs parser state after 3,200 bounded chunks. Maximum request-shaped chunk was 71,000 bytes; maximum serialized parser checkpoint was 247 bytes for this fixture. These numbers are observations, not worst-case bounds. Synthetic malformed, oversized, Unicode, quoted-newline and every-byte-split tests complement the large repeating fixture. Six commit failure boundaries verify the adapter contract with in-memory fakes, not actual Drive publication.

`inspect-actual.mjs <local CSV paths>` emits only aggregate validation results. All three read-only actual file materializations passed (results in actual-results.jsonl). Actual files are not copied into this package. Node timing is not GAS timing; actual Range/auth/writer/deployed application acceptance is not run.

## Small coherent integration plan

1. Build one `FolderImportService` in the existing single Apps Script writer project, keeping `import-core` pure. Wire Advanced Drive metadata/listing and bounded UrlFetch media ranges via an adapter that only accepts trusted configured direct-source IDs. Explicit manifest remains drive.file + approved drive.readonly + external_request. The scope addition and Production publishing step need actual owner consent/setup before live execution.
2. Implement strict UTF-8 decoder for GAS (do not assume Node TextDecoder exists there), source stream hash with serializable bounded incremental digest state, Range response validation, a bounded normalized point batch (legacy: max 1,024 points; packing v1: max 4,096 stored points; both keep the 256 KiB encoded-output cap; public route pages remain max 1,024 points / 256 KiB), and scalar summary accumulator. No all-file Buffer/Blob/string/array; no complete route array in checkpoints. Keep sensor time ordering/gap/jitter policies explicit. Do not infer a reliable run distance merely from sensor sample count.
3. Bind `commitBatch` to immutable assets plus existing reserved-slot writer receipts. Asset IDs must be reserved/persisted before upload; putOnce cannot invent a fresh file ID after an ambiguous create. Verify actual bytes/digest on ID conflict, never assume 409 is a matching success. A committed checkpoint includes source identity/version, offset, parser state, mapping/header, current digest state, batch sequence, scalar summary and prior manifest-page link. Output durability precedes checkpoint publication. Serialize/check bound to at most 2 MiB for any checkpoint, and cap each index/manifest shard independently. Do not store a growing list of route assets, seen source IDs or completed job IDs in one checkpoint/property value.
4. Full-source identity and before/after metadata checks prevent mixing source versions. Parser errors stop publication; counters retain only safe error codes/row numbers. Changed same-file content stages a replacement, not a second added run. Copy duplicates require duplicate resolution before contributing twice. Preserve original file bytes, parent, name and revision settings. Missing originals do not erase already committed history.
5. Finish the app integration in a single candidate: import status/progress/backlog/errors, staged route assets, completed run manifest, source provenance, idempotent summary and app reload. Default schedule proposal is hourly with 120 seconds of work plus early checkpoint reserve, rolling quota budget, idle exit and bounded backoff. Do not install a trigger until the candidate and authorized setup are ready.
6. Run the two existing acceptance bundles together: actual folder import (all three files, injected interruption/resume, duplicate scan, later new file, large synthetic file) and deployed save/reload/recovery (auth, durable edit, second browser, offline/retry, conflicts). Ordinary documented Google behaviors do not need separate owner-run probes. Capture actual GAS latency/quota/memory-related behavior and output counts/hashes. Local tests cannot mark either bundle passed.

## Remaining custom automated tests before wiring live

- Fake Range transport: non-206, wrong Content-Range, truncated bytes, unexpected full-file 200, 429/5xx/backoff, source version change, lost response.
- Adapter receipt conflict and immutable asset identity, process death at every real Drive boundary, paused/competing invocations, quota yield, page-token restart, same-file replacement preserving owner edits.
- Bound every persisted/index object, strict malformed UTF-8 GAS decoding, final streaming digest, checkpoints in long multiline rows, invalid/unknown sensor schema.
- Source-version metadata from actual Drive v3 adapter: the connected plugin's normalized metadata response omitted version/checksum fields despite requesting them. This is a connector shape limitation, not evidence Drive lacks the fields. Live GAS adapter must request/check them directly.

## Files

- import-core.mjs: parser, format validation, candidate/identity checks and batch adapter contract.
- core.test.mjs: small deterministic adversarial tests.
- large.test.mjs: generated over-100-MiB streaming/restart/hash test.
- inspect-actual.mjs: optional aggregate-only local real-file validation.
- test-results.txt and actual-results.jsonl: verified local results.

Full architecture is the companion revision-3 design document. This folder intentionally contains no credentials, OAuth token, original CSV, deploy script or trigger installer.

## Storage packing and public route pages

New jobs pin packing version 1: at most 4,096 points per immutable output, still at most 256 KiB. Existing jobs without that version retain 1,024-point packing and byte-identical pending reservations. Public route responses remain at most 1,024 points and 256 KiB, using signed within-output cursors. See `OUTPUT-PACKING.md` and `CURRENT-PERFORMANCE.md`.
