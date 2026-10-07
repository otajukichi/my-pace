# Owner-controlled automatic folder import

This is a locally tested kit, not an installed trigger or a live-verified service. Keep the existing owner-authorized Apps Script project and its pinned private Drive store. The original CSV folder is read-only.

## Enable only after live acceptance

1. Install the complete generated owner/server kit in the existing script. Finish bootstrap, permissions and a small interrupted/resumed import acceptance test.
2. Configure `MYPACE_WRITER_SECRET` directly in Script Properties using the same independently generated, at-least-32-byte secret required by signed app access. Do not put secrets in source, screenshots, chat or logs. For older configurations, use the explicit recovery-configuration upgrade described in the maintenance guide, never edit the immutable anchor or erase configuration.
3. As the verified owner, open Apps Script → Triggers → Add Trigger. Select `MyPaceImportScheduledTick`, Time-driven, Minutes timer, **every 15 minutes**. Keep exactly one trigger for this handler. No trigger-install scope or installer is included.
4. Review Google’s authorization prompt and execution/failure notifications. Creating the trigger is an explicit owner action; this kit has not performed it.

To stop automatic import, delete that handler’s trigger in Google’s UI. This preserves Drive progress and does not interrupt a running call. Do not delete the configuration property, managed files or source CSVs. Manual Resume uses the same queue.

## How work progresses

Each admitted tick continues durable queued work before seeking new files. The default source rescan interval is one hour; trigger cadence is 15 minutes. Successful unchanged scans use one fixed authenticated mutable advisory Drive cursor and create no immutable journal/checkpoint history. Optional CacheService suppresses redundant checks only after recovered Drive state matches; eviction/loss causes extra reads, never lost work or an authoritative cache-only record.

Trusted `MYPACE_IMPORT_SCHEDULE` defaults:

- `sliceMs:60000`: short check/new-scan allowance, configurable 30–60 seconds.
- `calls:750`: actual Drive/Fetch call cap per invocation, configurable 256–1000.
- `steps:3`: short-profile bounded steps, configurable 1–4.
- `rangeBytes:1048576`: input range ceiling. Fresh chunks adapt to at most eight output assets; exact already-reserved ranges/IDs remain unchanged.
- `catchUp:true`: durable queued import/finalization selects the existing 120-second maximum and up to 16 bounded steps. This applies to later large files as well as initial backfill.
- `scanIntervalMs:3600000`: rescan after a finished sweep; configurable 15 minutes–24 hours.

The script lock covers the invocation. Interactive app requests can return retryable BUSY while catch-up holds it. The browser must retain edits in its durable outbox and show them pending until acknowledged; instant cloud sync during catch-up is not promised. A Google request already in flight cannot be interrupted by the between-call deadline.

`processingMode` distinguishes check, catch-up, recovery, oversized-resume, paused and idle. `allowanceMs` reports the selected allowance. An existing oversized manual reservation gets one bounded 120-second finishing attempt. Three unchanged import/finalization attempts persist `SCHEDULED_NO_PROGRESS` and require owner review plus `MyPaceImportRetryBlocked`. The guard does not claim to detect every possible stalled external service.

## Budget waits are visible

The Drive work-admission ledger limits reservations to **12,000 calls and one hour of runtime per conservative 24–25-hour rolling window**. Reservations precede work. A refund is recorded only after tightening the remaining actual-call ceiling. Ambiguous writes retain conservative accounting. Reader status derives `budget-wait` and numeric `retryAt` from durable buckets without changing progress; the wait clears when the next work profile can be admitted.

This ledger is not an account-wide quota meter. Recovery before admission, idle checks, status/API calls, bootstrap and other scripts consume additional quota. A 96-tick/24-hour three-source unchanged mock measured 2,375 mixed Drive/Fetch calls with cache, or 2,582 without, with zero new immutable frames/indexes/manifests. Adding 12,000 gives 14,375/14,582 mixed calls in that fixture, not a platform billing or quota guarantee. A 145-source unchanged-folder model (seeded real writer identities, not 145 fully imported asset histories) measured 3,402 calls with cache or 3,567 with eviction every tick, 19 complete sweeps and at most 59 calls/tick, still with zero immutable growth; adding the work ceiling gives 15,402/15,567 in that larger fixture. Google currently documents 20,000 consumer URL Fetch calls/day and 90 minutes of daily trigger runtime, per user; Advanced Drive accounting differs, and quotas may change. Monitor Google’s execution dashboard and other projects. A permanent five-minute trigger is not the recommended default.

## Recovery and privacy boundaries

The handler verifies the effective owner, rejects a contradictory active user, checks the actual script identity and all pinned configuration before Drive access. Clock event fields are only entry-shape checks, not authentication. Never expose this handler through public request dispatch, doGet/doPost, or a caller-selected action.

Business records, receipts, progress and admission budgets remain in Drive. Script Properties contains bounded identity configuration and the owner-managed secret. The private fixed-ID HMAC files are advisory acceleration only. Authenticated INDEX recovery is bounded and incremental, with no 4,096-checkpoint lifetime halt; incomplete recovery returns `recovering` and cannot expose empty/partial business state. Missing/corrupt authenticated authoritative references fail closed. See `BOUNDED-INDEX-RECOVERY.md` and the maintenance guide.

## Evidence and remaining acceptance

`scheduled-performance-release-results.jsonl` contains synthetic cold-runtime31MiB models at 100/300ms per service request, including a later second file on the same history and budget. These delays are illustrative, not measured Google latency or an ETA. Final publications are independently reopened and checked against expected sample counts and whole-source SHA-256. Final model results are summarized in `CURRENT-PERFORMANCE.md`: two sequential 31 MiB files require 17 ticks/9,522 calls at 100 ms and 33 ticks/10,984 calls at 300 ms, with 0/2 rolling waits respectively. Prior five-minute/16,000-call models are superseded and must not be presented as current defaults.

Live owner consent, source access, private app-created write access, interrupted/resumed import, trigger identity, real latency/quota and browser outbox acceptance remain required. No live Google actions were performed during local testing.

References: [Google quotas](https://developers.google.com/apps-script/guides/services/quotas), [installable triggers](https://developers.google.com/apps-script/guides/triggers/installable), [clock event fields](https://developers.google.com/apps-script/guides/triggers/events#time-driven_events).
