# Running display preparation

**Deployment direction:** a PC-resident worker has been rejected for normal operation. The next acceptance step is the [three-large-CSV Apps Script experiment](gas/README.md). Existing Node worker code remains useful for local/reference tests; its OAuth and daemon setup are not the current rollout instructions.

This directory contains the incremental source-to-display pipeline and a Linux/Node worker for local folders or Google Drive. Routes, summaries, new-road distance and exploration are published as one generation. The worker runs on the user's PC; it is not an Apps Script or always-on Google Cloud deployment. Drive mode requires a separate owner OAuth authorization. The existing UI still reads its old local snapshot until authenticated artifact transport is connected. Old application storage formats are not a dependency.

## Run locally

```bash
npm run prepare:running -- --input data/raw
```

Inputs are original CSV files. Output is `data/running-display/`; the independent processing cache is `data/running-cache/`. All three locations are private and Git-ignored. They are also excluded from the public build and the local web server's file allowlist. Display artifacts still contain personal GPS, dates, and activity information: smaller does not mean anonymous.

The directory option uses filenames as local source identities. The Drive worker uses stable Drive file IDs and content checksums; renaming a Drive CSV does not create another run. A one-off conversion can also accept an explicit, private manifest:

```json
{
  "sources": [
    { "id": "stable-source-id", "revision": "observed-content-revision", "path": "data/raw/example.csv" }
  ]
}
```

```bash
npm run prepare:running -- --manifest data/source-manifest.json
```

The manifest is the complete selected inventory, not just one change notification. Removing a source from that inventory removes it from the next derived view; it does not delete the original file. An empty inventory is rejected rather than silently publishing an empty replacement. No data migration is necessary to use this format.

## Transformation

1. Read CSV in 256 KiB chunks with strict UTF-8 decoding, quote/newline handling, and bounded rows/fields. After validating the header, retain only time, latitude and longitude. Other sensor fields are structurally parsed but their text is discarded.
2. Collapse consecutive identical GPS coordinates. Keep the first observation time and final held observation time. High-rate accelerometer rows are not separate GPS fixes. Using the last repeated row before movement would falsely inflate speed.
3. Compute distances, elapsed time, 60-second pace buckets, kilometre splits and quality information from valid, unthinned GPS edges. Statistics are calculated before rendering simplification.
4. Produce geometry separately for daily detail (2 m tolerance, 0.5 km/h speed deviation) and monthly overview (6 m, 1 km/h). Speed changes constrain point removal independently of geometry. Chords are capped at 200 m. Bounded RDP windows avoid an unbounded quadratic simplification pass.
5. Round coordinates to one millionth of a degree and speeds to 0.1 km/h; store integer coordinate differences. Extra rounding error is at most approximately 0.08 m and 0.05 km/h. Store numeric speeds rather than theme colors.
6. Precompute newly travelled distance and the exploration mask. The client needs neither every historical track nor the historical comparison calculation to show these results.

The supported CSV has named `time`, `latitude`, and `longitude` columns, with UTC ISO timestamps. It matches the observed multi-sensor exports. Relative times, local times without offsets, and unknown headers are rejected. No recording date is guessed from a filename. Sensor-provided speed is not used until its units and semantics are explicitly supported.

## Statistical policy

- Activity dates follow the existing JST 03:00 boundary. Edges crossing that boundary are divided proportionally; total distance and time remain unchanged.
- Duration includes stops and missing observations. Distance is a GPS estimate, not road-matched or independently measured ground truth.
- A source-row gap over 15 seconds, invalid coordinates, a GPS-fix gap over 120 seconds, an edge over 250 m, or implied speed over 15 m/s breaks the line. Missing distance is not guessed.
- A long-held coordinate cannot reliably distinguish a stop from stale GPS. The 120-second limit is an explicit provisional policy. Missing seconds and rejected-edge counts are carried into the output.
- Pace samples include observed coverage. A missing interval is not converted to a normal-looking pace. Splits contain coverage as well as elapsed duration. A fully stationary interval has no finite pace.
- Exact duplicate normalized GPS exports are counted once, independently of file order. Non-identical recordings with overlapping time ranges stop publication for review rather than silently choosing one or double-counting.
- A short test recording is not silently discarded. The selection of which source files are actual runs belongs to the source inventory.
- Newly travelled distance is the existing approximate comparison against earlier dates, including same-day repeated travel. It is not a unique-road-length measurement. Same-day runs do not exclude one another.

## Files the viewer requests

All immutable objects live at `objects/<sha256>.json`; `index.json` is the sole mutable catalog. Every object and the catalog are limited to 128 KiB. Long routes and monthly lists are split by actual encoded size. Geometry chunks explicitly identify the original chain and part number, so transport boundaries reconnect while missing-GPS boundaries remain separate.

| Object kind | Contents | When requested |
| --- | --- | --- |
| `catalog` | Format/algorithm version, year references, latest record, exploration block references | Start or explicit refresh |
| `year` | Daily distance/time/count, monthly totals, month references; no GPS geometry | Calendar/year selection |
| `month` | Summaries, normalized small route outlines, newly travelled distance, route/analysis references | Visible month/list |
| `route` | Detailed speed-colored geometry, independent of themes | Selected run only |
| `overview` | Lighter routes bundled for a month, retaining separate runs | Monthly map only |
| `analysis` | Summary, 60-second pace/coverage tuples and kilometre-split tuples | Expanded running log only |
| `exploration` | Theme-neutral, run-length-encoded reveal alpha; grouped geographically | Visible map region only |

`lib/running-artifacts.js` defines the reader boundary. It accepts a caller-provided authenticated transport, coalesces duplicate reads, and keeps a bounded memory cache. It does not fetch routes when the caller requests a calendar or monthly list. It does not fall back to loading raw CSV. The transport must enforce authentication, size limits and object integrity before handing parsed JSON to this reader.

The exploration mask uses Web Mercator zoom 16, 64 cells per map tile (roughly 8 m cells at mid-latitudes). Multiple visits combine using maximum reveal alpha. Version 2 uses this fixed grid for the 20 m joining corridor as well as the 60 m reveal corridor, so cached contributions can be combined and retracted. This replaces version 1's per-group local 8 m enclosure grid; boundary pixels can differ by about a cell. Enclosed regions are computed across dates and tile boundaries, including the date line. Theme tinting remains the viewer's job. Newly travelled distance still uses the original unthinned 30 m comparison, independently of the display grid.

## Updates and failure behavior

- Local source fingerprints contain file metadata and the algorithm version. Unchanged files reuse a hash-checked normalized cache without reopening CSV. The idle worker skips preparation altogether when the source inventory and catalog are unchanged; a daily audit checks the derivative objects again.
- Completed per-run geometry, analysis and thumbnails have content-keyed caches. Adding a run computes that run's display, rather than simplifying every old route again. Identical immutable objects keep their references, including unaffected years/months.
- New-road-distance cache keys include the run's geometry and geometries of earlier nearby dates. A new latest run leaves old results valid. Backfills, corrections, moves and removals invalidate later nearby results. Same-day runs remain independent. Conservative geographic bounds and date-line handling prevent accidentally missing a nearby dependency.
- Exploration corridor rasterization is cached per geometry, independently of date. Active contributions are unioned; deleted/corrected inputs are removed from that union. Enclosures are cached by connected occupied-cell component. Closing a loop over several dates reveals its interior; removing a closing edge retracts it. Repeated visits do not keep rasterizing old GPS or consume a lifetime work budget. Unchanged components and mask tiles reuse their calculations.
- Source metadata is checked again after reading. Changing a source during conversion prevents publication.
- Immutable objects are written through temporary files and renamed only when complete. Existing objects are hash-checked before reuse.
- The new catalog is published last, atomically. A parser error, overlap, capacity failure, or interrupted preparation before publication preserves the previous catalog.
- Linux `flock` guards prevent overlapping workers and preparations. The kernel releases the lock after process death, including SIGKILL; a stale preparation PID marker is recovered automatically when that PID is dead. Do not unlink the `.guard` files. This is not a distributed cloud lock or a Drive compare-and-swap protocol.
- Old unreferenced derivative objects are currently retained. Automatic garbage collection is not implemented. Original CSV files are never rewritten or deleted.
- `last-report.json` reports actual CSV bytes, source reuse, `displayComputed`, `freshComputed`, `corridorComputed`, `enclosureComputed`, `maskTileComputed` and exploration cell work. The worker's `status.json` adds elapsed time and Drive request/download counters. No paths, coordinates, file names or tokens are logged.

## Local worker reference (not the deployment plan)

The previous local-worker setup and operating notes are in [WORKER.md](WORKER.md). Do not follow that OAuth/daemon setup for the Apps Script experiment; use the [verification handoff](gas/HANDOFF.md) instead. The following describes the retained Node reference implementation. No extra npm dependencies are required; Linux `flock` is required:

```bash
npm run watch:running -- --input data/raw
# A single reconciliation, useful for diagnostics:
npm run watch:running -- --input data/raw --once
```

Drive mode uses `changes.list` (default every 5 minutes), plus a full metadata reconciliation once a day. The start token is taken before the initial folder listing; subsequent changes close that race. All pages must succeed before treating the inventory as complete. Cursor expiry triggers reconciliation, not a wipe. Missing permissions, partial lists, empty inventories and checksum failures preserve the previous catalog. Filename-only changes need no CSV downloads.

CSV downloads use validated 8 MiB byte ranges, local checkpoints, final MD5 verification and a metadata recheck. A crash or network failure resumes the last completed range. Changed revisions restart that file; no per-sensor-row Drive writes occur. Input membership/checksums are rechecked before publication. Only after the full update, including optional Drive publication, does the worker commit its change cursor.

With `publishToDrive: true`, the worker creates **a new owner-only folder** in My Drive. It does not modify old application folders or original recordings. Immutable artifacts are uploaded first; `index.json` is created/updated last. Preallocated file IDs are saved locally before creation, so a lost upload response does not create duplicate files on retry. Unchanged objects are reused. The catalog still refers to `objects/<sha>.json`; a future authenticated Drive reader resolves each basename within this dedicated folder and validates size/hash. A public Drive URL is never a transport.

One designated PC owns this output folder. Do not copy its worker state to another active machine. The Drive publication protocol deliberately does not claim multi-writer atomicity or undocumented conditional-write guarantees. A failed remote publication can leave a newer local generation ready for retry, while the previous remote catalog remains available.

## Remaining boundaries

1. Measure the separate three-CSV Apps Script kit on Google's actual runtime using [the verification manual](gas/README.md). Synthetic HTTP/Drive and Apps Script VM tests are not evidence of real Google performance or successful authorization. The Node worker is not the selected deployment.
2. Connect the current app to owner-authenticated artifact transport. Public builds remain empty; no raw CSV or prepared GPS is a public static asset.
3. If the cold three-CSV experiment passes, test incremental ingestion with existing history, then add source discovery and automatic updates on Google. The experiment processes only its three fixed inputs; it is not a production folder watcher. Normal operation must not depend on an always-on PC.
4. Preparation on a changed inventory still reads cached normalized runs and walks metadata/dependency/component indexes. It is not O(1) in lifetime history. Heavy route simplification, GPS rasterization and fresh-distance measurements are cached, but a large connected explored region can still require a contour update. Limits are per new geometry/component (50 million cell visits), total distinct tiles (20,000), and occupied topology cells (2 million). A limit failure retains the previous generation and reports an explicit error.
5. Old snapshots, completed computation caches and unreferenced immutable objects are retained for recovery. Garbage collection and source retention are not implemented; originals are never deleted. Local and Drive disk usage should be monitored during long-term use.

Official references checked for this design:

- [Drive changes feed](https://developers.google.com/workspace/drive/api/guides/manage-changes)
- [Drive notifications and channel renewal](https://developers.google.com/workspace/drive/api/guides/push)
- [Drive downloads and partial downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- [Apps Script installable triggers](https://developers.google.com/apps-script/guides/triggers/installable)

## Validation

`tests/running-preparation.test.mjs` covers parsing, statistical/geometry contracts, bounded artifacts, and build exclusion. `tests/running-updates.test.mjs` covers append/backfill/edit/delete, equivalence to full rebuild, same-day and date-line behavior, loop closure/retraction, cache reuse over 371 runs, stable-input detection, paginated Drive changes, byte-range resume, checksums, bounded HTTP retries, publication ordering, owner-only output checks, and SIGKILL recovery. Fixtures are synthetic; real GPS and measured private reports belong under `data/` only.
