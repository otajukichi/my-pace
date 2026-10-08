> 過去の実装・検証資料です。本文中の手順・時間予算・制限・試験数は当時の記録で、今回の導入やロールバックを指示しません。現在の手順は [../PRACTICAL-SYNC-INSTALL.md](../PRACTICAL-SYNC-INSTALL.md)、設計は ../PRACTICAL-SYNC-DESIGN.md を優先してください。旧インストーラー、初期 bootstrap、ストア移動、秘密情報・OAuth・公開権限・トリガーの変更を今回の更新で繰り返さないでください。

# Bounded output packing

Local implementation and synthetic evidence only. No live Drive writes, credentials, authorization changes, deployment, source mutation, or deletion occurred.

## Changes and compatibility

New import jobs pin `packingVersion: 1` in the durable job and every parser checkpoint. Version 1 prepares up to 4,096 normalized points per output, while the existing 256 KiB per-output byte ceiling remains unchanged. The byte ceiling often binds first. Source ranges remain at most 1 MiB, batches at most 64 outputs / 8 MiB, and checkpoints at most 2 MiB. No immutable-asset byte limit or writer implementation changed for this optimization.

An absent packing version means the original 1,024-point representation. Legacy checkpoints preserve the absence of the field, including serialization order and bytes. Legacy jobs with no committed checkpoint also reconstruct the original initial checkpoint; changing the global preparation default alone would have broken their already-reserved first batch. New jobs persist the version before any reservation, and checkpoint validation rejects a version different from the job's version. Old jobs retain their old packing through completion. Pending ranges, IDs, digests and bytes are never repacked on resume.

Parser version, mapping hash, source identity, source key, normalized point order, normalized stream hash and source hash do not change. Existing completed assets remain readable. This is a representation change, not a new source generation or automatic re-import.

## Route paging boundary

Route responses still contain at most 1,024 points and now explicitly enforce at most 256 KiB for the complete JSON response. A bounded reserve accommodates the signed cursor envelope; unusually large points may produce fewer than 1,024 points per page.

The existing authenticated cursor now includes `pointOffset` within its selected output. It remains bound to revision, run, job, pin, output index and pin-chain position. Legacy cursors lacking an offset mean offset zero. Invalid offsets, forged signatures and stale revisions fail closed. A page advances within the same output until exhausted, then advances to the next output or pin. Empty-output pins remain supported.

Every page still verifies its entire immutable output, which is at most 256 KiB. Therefore multiple pages within one packed output can reread those bounded bytes. This keeps the current SHA-256 integrity and privacy checks; no partial-byte integrity scheme or whole-route materialization was introduced.

## Paired local measurements

`output-packing-performance-results.jsonl` compares the same current manual-owner simulator with legacy packing versus version 1. The legacy comparison used a temporary module copy with only the initial packing default and new-job version emission restored to legacy behavior. The authoritative repository was not changed for that baseline. Both modes used identical source fixtures, service configuration, range caps and writer behavior.

- One row: 1 output and 296 requests in either mode.
- Dense 1 MiB, 41,942 samples: 42 to 12 outputs; 792 to 492 requests, a 37.9% reduction.
- Representative 21-column sensor 1 MiB, 5,065 samples: 6 to 3 outputs; 432 to 402 requests, a 6.9% reduction.

All six runs completed in one invocation, retained every sample, performed zero original-source writes and required 24 requests for final cold recovery. In these fixtures, each eliminated output removed ten requests; index-node and frame counts were unchanged. The smaller sensor improvement shows why fewer files must not be presented as an equal end-to-end speedup. Metadata, index and fixed orchestration work still matter. These request counts are synthetic, not live latency or quota measurements. Larger scheduled models are recorded separately by the release integration.

## Verification

`output-packing-review.test.mjs` adds ten tests covering source/normalized identity invariance, the unchanged byte cap, legacy packing and malformed versions, byte-identical initial and later pending resumes, durable version consistency, gap-free mixed old/new route paging, signed offset validation, complete-response byte bounds with unusually large valid points, and transient errors injected at real reservation-index shard reads.

Focused preparation/store/runner/reader checks: 72 passed. Additional performance/runtime/range/finalization and over-100-MiB stress checks: 18 passed. The large stress fixture streamed 114,000,061 source bytes and 2,000,000 points through 2,000 restored checkpoints with verified source and normalized hashes. Results are in `packing-focused-results.txt` and `packing-regression-results.txt`. The release parent owns final full-suite and regenerated-bundle verification.

### Finalization and budget error regressions

Finalization independently enforces the checkpoint's packing ceiling, including legacy 1,024-point outputs. This prevents an internally hash-consistent but oversized point group from being published when the route reader could not page it. An independent reviewer supplied the legacy 1,025 / packed 4,097-point adversarial fixtures.

A service-delay model also exposed an existing catch-all in asset authorization lookups. Budget exhaustion during an index-shard read could become a false `ASSET_MEDIA_NOT_RESERVED` denial. `assertReservation` and `assertReadableAsset` now propagate retryable, yield, recovery and lock-control exceptions unchanged, while real absent or mismatched reservations still return false. Independent tests cover both active reservations and current published assets. This correction preserves safe scheduler retry behavior; it grants no additional asset access.
