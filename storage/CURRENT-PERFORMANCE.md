# Current synthetic scheduled import evidence

Local mocks only. No live Google requests, source data, credentials, deployment or trigger. Both models use a 15-minute cadence, 12,000-call work admission, 120-second hard invocation cap, versioned output packing and authenticated checkpoint/discovery advice. The second 31 MiB file is added after the first finishes on the same retained store and ledger.

## 100 ms illustrative delay per service request
- Each source: 32,505,967 bytes, 157,033 rows (207 bytes per sensor row).
- First file: 8 ticks, 4,287 actual mixed requests, 8 checkpoint indexes.
- Both files: 17 ticks, 9,522 actual mixed requests, 0 visible budget waits, 17 total checkpoint indexes and 126 output files.
- Maximum invocation: 66.6 seconds. Maximum reserved calls: 11,045.
- Combined virtual elapsed: 5.01 hours including cadence and rolling waits; this is not a live ETA.
- Both publications independently verified for sample count and whole-source SHA-256: True.

## 300 ms illustrative delay per service request
- Each source: 32,505,967 bytes, 157,033 rows (207 bytes per sensor row).
- First file: 14 ticks, 4,977 actual mixed requests, 14 checkpoint indexes.
- Both files: 33 ticks, 10,984 actual mixed requests, 2 visible budget waits, 31 total checkpoint indexes and 126 output files.
- Maximum invocation: 117.3 seconds. Maximum reserved calls: 11,580.
- Combined virtual elapsed: 26.40 hours including cadence and rolling waits; this is not a live ETA.
- Both publications independently verified for sample count and whole-source SHA-256: True.

## Interpretation and limits

The slower two-file model crosses a conservative rolling budget wait. High-volume backfill can take more than one day; neither overnight completion nor immediate cloud import is guaranteed. The app exposes budget wait and next eligible time while preserving source files and committed progress. Actual calls and reserved allowances are reported separately. The ledger is not an account-wide Google quota meter.

Unchanged scans add zero immutable history: a three-source daily model measured 2,375 mixed calls with cache, or 2,582 without. A 145-source seeded-identity model measured 3,402 calls with cache or 3,567 with cache eviction every tick; this does not model 145 fully imported asset histories. Other requests and scripts consume additional quota.

Authenticated recovery no longer has a lifetime 4,096-checkpoint halt. The 4,101-checkpoint regression recovers from complete hint loss in 65 bounded calls and writes checkpoint 4,102. Retention/garbage collection remain unimplemented, and total Drive storage/other bounded structures remain finite.

Compared with the previous unversioned packing model, two-file actual requests fell from 13,315 to 9,522 at 100 ms and from 18,067 to 10,984 at 300 ms. Per-output byte caps and public route-page bounds did not increase. This is synthetic workload evidence, not a general speed multiplier.

Full local logs are retained separately as scheduled-performance-release-results.jsonl; this document is the self-contained release summary.
