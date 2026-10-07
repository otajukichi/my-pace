# Private owner-store bootstrap

Local-only implementation and simulator evidence. This code has not run against live Drive, changed consent, deployed an Apps Script, or installed a trigger.

## Server API

`createOwnerBootstrap(globals, { ownerEmail, checkBudget, expectedScriptId?, propertyKey?, datasetGeneration?, acceptedEpochs? })` returns owner-guarded synchronous methods:

- `bootstrap()` is an explicit owner action. It reserves and pins production IDs, creates or resumes the private folder hierarchy at those exact IDs, creates or verifies the immutable writer anchor, and recovers the existing writer chain. It never searches or adopts a folder by name.
- `load()` is a strictly read-only owner action. It returns `null` for an absent configuration, otherwise verifies configuration, My Drive identity, exact private folder hierarchy and markers, and canonical immutable anchor identity/initial successors. It does not repair missing objects or publish pending checkpoint-index links. Runtime operations perform their own normal recovery barriers afterward.

Both methods require the active and effective Session identities to equal the trusted owner email. An unavailable active identity is denied. These methods are for direct owner-editor entry points, not execute-as-owner public requests or unattended triggers. Constructing the API does not acquire a lock, obtain a token, inspect properties or contact Drive.

The optional `expectedScriptId` is an additional project check. When omitted, the first explicit bootstrap durably binds `ScriptApp.getScriptId()` to the production configuration. Every later load/bootstrap must match that actual ID. Run this in the existing authorized GAS project; sharing its Google Cloud project with another GAS script does not establish the same grant or identity. The code does not request or expand authorization.

`parsePinnedOwnerStoreConfig(raw, { ownerEmail, writerScriptId, datasetGeneration?, acceptedEpochs? })` is a separate pure parser for a separately authenticated, trusted server boundary. It performs no authentication or Drive verification. Pass the actual current script ID and trusted owner identity, never values selected by an incoming request. Required schema, protocol, distinct IDs, original epoch/generation validity and identity are always checked; optional expected generation/epochs add exact comparison. Only a `null` input denotes absent configuration. Malformed and mismatched values fail closed.

## Fixed configuration and crash recovery

Default property key: `mypace.production.store.v1` (exported as `OWNER_STORE_PROPERTY`). One bounded immutable record contains the owner/script identity, actual My Drive root ID, three reserved folder IDs, store ID, anchor ID, initial frame/index IDs, a checkpoint-hint ID for new configurations, original dataset generation and original epochs. It contains no import progress, mutable state, receipts, job queue or phase flag. Other ScriptProperties are not changed.

For new stores, seven generated IDs are persisted in one property value and exactly read back before the first folder or file create. A configuration-write failure stops creation. A lost property-write response proceeds only when exact readback proves that same value. A restart uses the persisted IDs, never replacement IDs. Older six-ID configurations and anchors remain unchanged; they are not silently retrofitted and continue full authoritative recovery without the shortcut. Do not delete a legacy configuration to obtain a hint.

Folder creates use `ignoreDefaultVisibility: true`. Every folder is checked for exact ID, folder MIME, non-trashed status, owner-only privacy, exact single parent and store/script/protocol/role app markers. A display-name change is allowed because names are not identity. The immutable anchor uses pre-reserved initial writer successors, so interrupted creation reconstructs identical bytes without allocating another initial chain. Same-ID conflicts and create errors are resolved by a subsequent read of that exact ID. Only an explicit HTTP 404 is treated as absence; 401/403/429/5xx, bad metadata and failed media reads never trigger a new store.

The bootstrap acquires the same project script lock as the writer and preserves a lock already held by its trusted caller. It exposes no Drive listing, overwrite, permission change, delete, source mutation or public route. The existing deployment's authoritative property key must remain stable; changing it is not a migration procedure.

## Authenticated checkpoint shortcut

New configurations and anchors pin the same distinct checkpointHintId. The hint is a private Drive file, not an authoritative state store. It is authenticated with the existing, manually configured MYPACE_WRITER_SECRET using a separate HMAC domain. No secret is generated, returned in configuration/status, or logged. Configure the matching secret before relying on accelerated app reads or periodic import; absence of the codec retains full recovery.

The hint is written only after a mandatory immutable checkpoint index has been published. Cold recovery validates its identity, authenticated ordinal, referenced index, manifest and publishing frame, then follows successors. A stale or delayed hint cannot roll back a verified successor. Missing/invalid/unverifiable hints fall back to the fixed anchor; a valid authenticated hint referring to missing/corrupt committed data fails closed. The existing absolute 4,096-index maintenance limit remains enforced. Retention/GC and recovery after loss of every surviving witness are not solved by this shortcut.

## Scopes and evidence

Manifest scopes are `drive.file`, `drive.readonly`, `script.external_request` and `userinfo.email`. No `DriveApp` or full-drive write scope is used. The userinfo.email scope may require new owner consent if it was not previously granted. No trigger-installation scope is added. The separate scheduled entry is enabled only by an owner-created Google UI trigger.

Official API references confirm that pre-generated IDs support folders and can be retried at the same ID, and explain Session identity availability:

- https://developers.google.com/workspace/drive/api/guides/create-file#generate-ids
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create
- https://developers.google.com/apps-script/reference/base/session

Focused command: `node --test owner-bootstrap.test.mjs reserved-writer.test.mjs`

At implementation handoff: 138 tests passed, zero failed/skipped. `owner-bootstrap-results.txt` records the run. Coverage includes all persistence/create interruption boundaries, wrong account/project, unknown grants represented by HTTP errors, root/parent/privacy/marker collisions, malformed fixed config and generated IDs, absent versus inaccessible objects, probe preservation, anchor identity/hash checks, and the strictly read-only pending-publication case. This simulated evidence does not establish live Google request latency, quota behavior or immutable-create visibility.

## Explicit owner recovery repair

The current bootstrap reserves eight IDs, including fixed checkpoint-hint and discovery-state files. Older six-ID and seven-ID stores can use the explicit editor helper `MyPaceRepairRecoveryConfiguration`. It requires an already owner-managed `MYPACE_WRITER_SECRET`, verifies HMAC operation, checks both active/effective owner identities and the actual script, and read-only verifies the original private folders and immutable anchor before reserving only missing advisory IDs. It persists and exactly reads back the configuration before any later advisory create. It does not create or overwrite hint/discovery bodies itself.

The underlying `repairRecoveryConfiguration()` method preserves every existing ID, original epoch order, dataset generation and immutable file. For a legacy anchor without an embedded hint ID, it records the exact existing anchor hash as `checkpointHintAnchorHash`. A retry reuses the persisted pins. Existing authenticated hint bodies, including evidence pointing to missing authoritative data, remain untouched. An absent fixed hint is subsequently recreated at that same configured ID; repair never substitutes a fresh ID to hide an inaccessible or missing authority.

`MyPaceRecoverStorage` invokes one bounded authenticated writer recovery slice. It reports `recovering` on `WRITER_RECOVERY_PENDING`; repeat the same helper until `ready`. Missing setup is reported as `setup-needed` with the relevant next step. Missing/corrupt authoritative history remains an error, rather than an instruction to reset the store. Both editor helpers use the same guarded owner execution path and report work usage without printing the signing key. No trigger or public endpoint is installed.

`loadRecoveryConfiguration()` is a separate strictly read-only, owner-guarded maintenance method. It verifies schema, pinned owner/script identity, exact folders and original anchor equality while retaining any valid historical generation and epochs. Ordinary import `load()` continues to enforce the kit's requested generation/epoch compatibility contract, currently generation `1` and epoch `default`. Successful maintenance recovery of another generation does not authorize importing into it under the current kit.

Repair tests are in `owner-recovery-repair.test.mjs`. They include unchanged legacy history, idempotence, failed/ambiguous property writes, wrong identities, missing owner secret, failed HMAC support, original anchor failures, preservation of an authenticated missing-authority witness, same-ID hint recreation, and bundled bounded recovery through `recovering` to `ready`.
