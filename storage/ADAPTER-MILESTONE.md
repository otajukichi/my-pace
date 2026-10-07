# Local GAS adapter milestone

Historical adapter status. The later [storage integration milestone](STORAGE-MILESTONE.md) supplies the reserved-slot writer and durable import binding formerly listed as missing here. Remaining application/live gates are still open.

Status: local implementation and mock-tested integration boundary, not deployed and not yet an executable end-to-end application importer. Old probes and production app are untouched. No Google writes, settings, OAuth consent, Production publication, trigger installation, or remote push occurred.

## Implemented

- Strict GAS-compatible UTF-8 and serializable SHA-256. No Node Buffer, TextDecoder, TextEncoder or Node crypto in implementation. Node crypto is only the independent test oracle.
- Fixed-folder direct-child CSV listing and identity-bound Range reads. Metadata identity includes file ID, observed version, MD5 and size. Before/after freshness checks surround each range. Full-file 200, wrong range, wrong length, malformed headers and changed source fail closed.
- Bounded pure preparation: input at most 256 KiB; output asset at most 1,024 samples / 256 KiB; checkpoint at most 2 MiB; each manifest page at most 256 KiB. Invocation safety limits cap output assets at 64 and encoded outputs at 8 MiB. A checkpoint contains current parser/hash/scalar state and one previous-manifest descriptor, never a full route/history array.
- Immutable Advanced Drive asset creation at already committed, pinned fixed IDs, with a reservation-restricted same-ID GAS media readback helper (maximum 2 MiB, exact 206 range, no whole-file fallback). Every create, timeout or conflict is followed by same-ID metadata and exact-byte/hash verification. No overwrite, new-ID fallback, or source mutation exists.
- Two-phase lock coordinator stages immutable assets outside the global writer lock, then rechecks receipts, checkpoint/version, reservation pins, verified bytes and source freshness before the existing writer's checkpoint transition. The original receipt wins before current-version validation. Acquired locks alone are released. Mandatory publication recovery runs before mutations and before success.
- A module-free GAS bundle at gas/FolderImport.gs. Loading it performs no network or storage action; there is deliberately no public entry point, deployment script, or trigger installer.

## Real schema and time semantics

Read-only local inspection found the sensor:multi_record marker, a basic five-column header, and the extended 21-column header. Basic time/latitude/longitude plus optional altitude/speed are accepted; the observed extended schema is accepted by named columns. Unknown schemas fail closed. Time must be a valid calendar timestamp in ISO UTC with Z; fractional seconds are preserved, including submillisecond ordering. No epoch seconds/milliseconds assumption is made.

Latitude/longitude are bounded degree values. Actual headers do not declare altitude or speed units, so their values remain explicitly undeclared-unit values. Only speed -1 maps to unavailable; other negative values are rejected. Sensor count is sample count, not independent GPS fixes. No distance, run duration, pace, rewards or authoritative run totals are inferred. Original extra sensor values remain accessible through source provenance rather than being copied into checkpoint state.

## Required existing-writer binding (still missing)

The coordinator intentionally does not implement an alternate datastore or another transaction protocol. Production integration must supply the same reserved-slot writer used for normal edits:

1. Resolve the fixed checkpoint-index chain and complete mandatory recovery/publication barriers.
2. Register a pinned import job and persist every fixed asset ID, role, length and hash in authoritative Drive state before upload. Only configuration/fixed roots may live in ScriptProperties.
3. Validate the checkpoint and manifest schemas, previous page/checkpoint and exact ordered output descriptors. Validate the active pin and reservations under the final lock, then commit output readiness plus the new checkpoint/receipt atomically through the existing immutable frame.
4. Protect pins while staging outside the lock and fence cleanup. Existing assets are not adopted after retirement. Preserve original receipt identity and operation-digest comparison across retries.
5. Bind the managed-asset reader and reservation validation to the authenticated server context; never expose either reader as a client-controlled arbitrary-ID endpoint. The source transport's allowlist is deliberately not a generic managed-file reader.
6. Implement sharded durable folder scan/job lookup, expired-page-token restart/dedup, missing-checksum bounded hash stage, same-file replacement preserving owner edits, copy-duplicate resolution, source digest finalization and complete-run publication.
7. Add scheduler/rolling runtime accounting, UI progress/errors/backlog, app/domain integration and signed server routes. Neither completion of parsing nor an immutable checkpoint publishes a run.

These functions are an explicit unimplemented production dependency. Fake writer tests establish adapter ordering under the contract, not the correctness or existence of the application writer.

## Resource and platform limits

All application materialization is bounded, but UrlFetchApp itself does not expose a documented streaming response cap or per-call timeout. A server ignoring Range could buffer a large response inside the service before the adapter rejects status 200 without reading its body. A started Google service call also cannot be interrupted by the between-call deadline checks. The coordinator requires a budget callback; receipt lookup and mandatory recovery are deliberately permitted before new-work budget gates. The callback must reserve conservative time for final verification and commit. Local timings do not establish GAS execution time, quotas, memory usage, or Drive atomic visibility. The design's small immutable-create publication assumption remains a live acceptance gate.

## Checks and sources

Run from this directory:

    node --test core.test.mjs codec.test.mjs bounded-import.test.mjs transport.test.mjs immutable-assets.test.mjs gas-bundle.test.mjs large.test.mjs gas-large.test.mjs
    node build-gas.mjs

The generated GAS bundle is smoke-tested in a Node VM without Node byte codecs. Separate module-level adapter tests use GAS-shaped fakes. Original CSV files are not included. inspect-gas-core.mjs accepts explicit local source paths and prints aggregate-only results. Exact final counts and measurements are in gas-test-results.txt, gas-actual-results.jsonl and gas-large-results.txt.

Official API/specification references used for implementation:

- Drive partial downloads and canDownload: https://developers.google.com/workspace/drive/api/guides/manage-downloads
- Pre-generated IDs and duplicate-create retries: https://developers.google.com/workspace/drive/api/guides/manage-uploads
- Drive metadata and versions: https://developers.google.com/workspace/drive/api/reference/rest/v3/files
- List pagination: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
- Google retry/error guidance: https://developers.google.com/workspace/drive/api/guides/handle-errors
- GAS HTTP response API: https://developers.google.com/apps-script/reference/url-fetch/http-response
- GAS lock acquisition/release: https://developers.google.com/apps-script/reference/lock/lock
- HTTP Range: https://www.rfc-editor.org/rfc/rfc9110.html#section-14
- UTF-8: https://www.rfc-editor.org/rfc/rfc3629
- SHA-256: https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf

Actual owner scope consent/Production setup and both bundled live acceptance tests remain unrun. No owner action is requested for this partial milestone.

## Final local result

Final aggregate run on Node v24.19.0: 131 tests passed, zero failed/skipped. The GAS-compatible stress fixture consumed 114,000,061 bytes and 2,000,000 samples across 2,000 restored batches; maximum checkpoint 1,704 bytes and maximum output asset 103,424 bytes. Independent source/output SHA-256 checks passed. The separate earlier generic CSV stress fixture remains covered.

All three actual local CSVs passed the new portable codec/hash path: 153,523 / 65,249 / 130 samples, with source/output hashes checked independently. Maximum actual checkpoint was 1,898 bytes at 65,537-byte read chunks. These are fixture observations, not worst-case bounds or GAS timings.
