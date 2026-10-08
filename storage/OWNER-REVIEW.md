> 過去の実装・検証資料です。本文中の手順・時間予算・制限・試験数は当時の記録で、今回の導入やロールバックを指示しません。現在の手順は [../PRACTICAL-SYNC-INSTALL.md](../PRACTICAL-SYNC-INSTALL.md)、設計は ../PRACTICAL-SYNC-DESIGN.md を優先してください。旧インストーラー、初期 bootstrap、ストア移動、秘密情報・OAuth・公開権限・トリガーの変更を今回の更新で繰り返さないでください。

# Independent owner-runtime review

Scope: local `owner-scheduler.mjs`, its tests, reentrant coordinator locking, owner bootstrap and pinned writer bootstrap/load behavior. All execution used local synthetic GAS/Drive fixtures. No live service, source file, permission, deployment, trigger or remote repository was changed.

## Findings and disposition

- **Temporary throttling became an owner-blocked error.** The source transport exhausts its bounded retries as `RETRY_EXHAUSTED`; the scheduler initially omitted that code. The integrating owner corrected retry classification for the transport's recognized transient statuses, including structured rate-limit 403. Regressions verify both 429 and structured 403 resume with bounded backoff, while an ordinary permission 403 remains blocked after one attempt.
- **Rolling reservations are admission accounting, not a complete quota meter.** Authoritative Drive ledger recovery necessarily occurs before its next reservation. Status, blocked/no-op invocations, exhausted admission checks and explicit review operations also consume requests outside admitted reservations. Bootstrap has a separate budget, and its preflight load precedes scheduler metering in editor wrappers. `OWNER-KIT.md` discloses these boundaries. They must not be represented as an account-wide request ceiling or a single hard 120-second editor execution cap. Between-call deadlines cannot interrupt a Google call already in flight.
- **Status is recovery-capable.** Its recovery barrier can create a missing mandatory checkpoint-index link from an earlier committed publication. A fresh idle status does not create the scheduler or start import. A new regression demonstrates the precise recovery write; general claims that status never writes would be incorrect.
- **Reentrant coordinator lock ownership is preserved.** An already-held caller lock is neither reacquired nor released, including when the action throws. Existing standalone lock acquisition/release behavior continues to pass.
- **Owner source review preserves the generation boundary.** Changed sources remain blocked with the old identity and pin intact. Explicit restart cancels only the pending generation, leaves originals and published history untouched, returns idle, and permits a new scan of the current identity. The regression obeys the rolling accounting window rather than raising configured limits.
- **An interrupted scan registration remains recoverable.** A simulated failure immediately after a job-registration frame becomes durable, before scan acknowledgement and scheduler error persistence, cold-resumes to one completed job without skipping or duplicating the entry.

## Bootstrap review

The reviewed bootstrap persists the bounded configuration and all six fixed IDs before the first create. It does not adopt existing folders by name or replace a conflicting configuration. Same-ID readback resolves uncertain writes; missing or inaccessible metadata is never casually adopted. Both active and effective owner identity are checked by owner entry paths. Initial script identity is pinned in the configuration, with an optional stricter expected-script input.

The writer accepts an explicitly pinned pair of initial slot/index IDs and validates them on re-entry. `load()` uses the strict read-only bootstrap reader rather than a recovery barrier, so it cannot provision an absent anchor or repair a pending publication. The independent bootstrap/writer rerun covered owner mismatch, property-write ambiguity, fixed-ID create interruption, folder privacy/ownership/parent/marker mismatch, malformed responses, pinned anchor mismatch and the read-only-load distinction.

Low-level scheduler/runtime exports remain trusted server internals. Session checks belong to the guarded editor wrappers on every invocation; these APIs are not safe arbitrary client/RPC surfaces and the kit must not be exposed as a public web app.

## Verification

- `owner-review.test.mjs`: **7 passed**, zero failed. This reviewer added the regression file.
- Latest combined `owner-bootstrap.test.mjs`, `owner-scheduler.test.mjs`, `owner-review.test.mjs`, `immutable-assets.test.mjs` and `reserved-writer.test.mjs` run: **226 passed**, zero failed, including the pure pinned-configuration parser extraction.
- Earlier independent `owner-bootstrap.test.mjs` plus `reserved-writer.test.mjs` run: **130 passed**, zero failed.
- The integrating owner is responsible for the frozen full-suite and generated-bundle run after the remaining concurrent edits. These are local mock results, not live GAS throughput, Drive visibility, quota, authorization or application acceptance results.

## Performance and cache boundary

Before the concurrent read-cache optimization, the tiny fixture required thousands of requests, and a reviewed changed-source restart required six admitted invocations (about 11,400 calls in one measured trace). This proves bounded recoverable progress in that case, not practical large-import throughput. It remains a performance gate for actual use.

Cache feedback was sent directly to its implementer: bytes-only cache hits need fresh privacy/identity metadata and a proven unchanged version/checksum; two absent fields must not count as matching identity. Caching positive metadata for an entire lock phase explicitly weakens within-phase freshness because Drive changes do not obey the script lock. Such a mode must not silently become the default guarantee. Missing successors, original sources and managed import assets must remain outside this cache. The optimization's final implementation and performance claims are owned by its separate focused verification.

No remaining local data-corruption or cursor-recovery blocker was identified in the reviewed owner scheduler/bootstrap scope after the retry correction. This is not an approval to deploy or a claim of end-to-end application completion.
