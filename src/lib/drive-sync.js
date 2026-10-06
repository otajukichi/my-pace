import { LIMITS, STATE_VERSION, validateState } from './domain.js';

/** Immutable snapshots: Drive versions/ETags are deliberately NOT used as a CAS. */
export const SYNC_FORMAT = 'my-pace-drive-v1';
export const SYNC_STORAGE_PREFIX = 'mypace.drive-sync.v1';
export const SYNC_LIMITS = Object.freeze({ snapshots: 10000, parents: 64, historyBytes: 64 * 1024 * 1024,
  snapshotBytes: LIMITS.backupBytes + 64 * 1024, uploadBytes: 5_000_000, metadataBytes: 8192 });
const encoder = new TextEncoder();
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const BAD_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const ENVELOPE_KEYS = ['syncFormat', 'datasetId', 'commitId', 'parentCommitIds', 'deviceId', 'hash', 'state', 'createdAt'];
const clone = (value) => JSON.parse(JSON.stringify(value));
const equalIds = (a, b) => a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);
export class DriveSyncError extends Error {
  constructor(code, message, details = undefined) { super(message); this.name = 'DriveSyncError'; this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new DriveSyncError(code, message, details); };
function identifier(value, label = 'ID') {
  if (typeof value !== 'string' || !ID.test(value) || BAD_IDS.has(value)) fail('INVALID_ID', `${label}の形式が正しくありません。`);
  return value;
}
function exactRecord(value, keys, code = 'INVALID_SNAPSHOT') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    fail(code, '同期データの形式が正しくありません。');
  }
}
/** Stable ordering means the hash does not depend on object insertion order. */
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function canonicalState(state) {
  const validated = validateState(state);
  const text = canonicalJSON(validated);
  if (text.length > LIMITS.backupChars || encoder.encode(text).byteLength > LIMITS.backupBytes) fail('STATE_TOO_LARGE', '同期データは12MiB以下にしてください。');
  return { state: validated, text };
}
async function digest(text, crypto = globalThis.crypto) {
  if (!crypto?.subtle) fail('CRYPTO_REQUIRED', '安全な同期にはHTTPSとWeb Cryptoが必要です。');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))].map((n) => n.toString(16).padStart(2, '0')).join('');
}
export async function hashState(state, crypto = globalThis.crypto) { return digest(canonicalState(state).text, crypto); }
export async function datasetIdForFolder(folderId, crypto = globalThis.crypto) { identifier(folderId, 'フォルダID'); return `folder-${await digest(`${SYNC_FORMAT}:${folderId}`, crypto)}`; }
function newId(crypto) {
  if (crypto?.randomUUID) return crypto.randomUUID();
  if (!crypto?.getRandomValues) fail('CRYPTO_REQUIRED', '安全なIDを作成できません。');
  return [...crypto.getRandomValues(new Uint8Array(24))].map((n) => n.toString(16).padStart(2, '0')).join('');
}
function parentIds(value) {
  if (!Array.isArray(value) || value.length > SYNC_LIMITS.parents) fail('INVALID_SNAPSHOT', '親スナップショットの一覧が正しくありません。');
  value.forEach((id) => identifier(id));
  if (new Set(value).size !== value.length) fail('INVALID_SNAPSHOT', '親スナップショットが重複しています。');
  return [...value].sort();
}
export async function validateSnapshot(raw, { crypto = globalThis.crypto } = {}) {
  exactRecord(raw, ENVELOPE_KEYS);
  if (raw.syncFormat !== SYNC_FORMAT) fail('INVALID_SNAPSHOT', '未対応の同期形式です。');
  for (const key of ['datasetId', 'commitId', 'deviceId']) identifier(raw[key], key);
  const parents = parentIds(raw.parentCommitIds);
  if (parents.includes(raw.commitId)) fail('INVALID_SNAPSHOT', 'スナップショットが自分自身を参照しています。');
  if (typeof raw.hash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.hash)) fail('INVALID_HASH', '同期データのハッシュが正しくありません。');
  if (typeof raw.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.createdAt) ||
      !Number.isFinite(Date.parse(raw.createdAt)) || new Date(raw.createdAt).toISOString() !== raw.createdAt) fail('INVALID_SNAPSHOT', '同期データの日時が正しくありません。');
  if (raw.state?.version !== STATE_VERSION) fail('INVALID_STATE', '同期データの保存形式に対応していません。');
  let state, text;
  try { ({ state, text } = canonicalState(raw.state)); } catch (error) { fail('INVALID_STATE', '同期データの内容を検証できません。', { reason: error.code }); }
  if (canonicalJSON(raw.state) !== text) fail('INVALID_STATE', '同期データには完全な標準形式の記録が必要です。');
  if (await digest(text, crypto) !== raw.hash) fail('HASH_MISMATCH', '同期データの内容とハッシュが一致しません。');
  return { syncFormat: SYNC_FORMAT, datasetId: raw.datasetId, commitId: raw.commitId,
    parentCommitIds: parents, deviceId: raw.deviceId, hash: raw.hash, state, createdAt: raw.createdAt };
}
export async function parseSnapshot(text, options = {}) {
  if (typeof text !== 'string' || text.length > SYNC_LIMITS.snapshotBytes || encoder.encode(text).byteLength > SYNC_LIMITS.snapshotBytes) fail('SNAPSHOT_TOO_LARGE', '同期スナップショットの容量が大きすぎます。');
  let raw;
  try { raw = JSON.parse(text); } catch { fail('INVALID_SNAPSHOT', '同期スナップショットのJSONを読み取れません。'); }
  return validateSnapshot(raw, options);
}
export async function createSnapshotEnvelope({ datasetId, commitId, parentCommitIds = [], deviceId, state,
  createdAt = new Date().toISOString() }, options = {}) {
  const candidate = canonicalState(state).state;
  return validateSnapshot({ syncFormat: SYNC_FORMAT, datasetId, commitId, parentCommitIds, deviceId,
    hash: await hashState(candidate, options.crypto), state: candidate, createdAt }, options);
}
/** Receives validated {fileId,envelope} records. Never picks a winner by date. */
export function analyzeSnapshots(snapshots) {
  const issues = [], commits = new Map(), datasets = new Set(), referenced = new Set(), files = new Set();
  if (!Array.isArray(snapshots) || snapshots.length > SYNC_LIMITS.snapshots) fail('HISTORY_LIMIT', '同期履歴の上限を超えています。履歴を省略して同期することはできません。');
  for (const { fileId, envelope } of snapshots) {
    if (files.has(fileId)) issues.push({ code: 'DUPLICATE_FILE', fileId, message: '同じDriveファイルが重複しています。' });
    files.add(fileId);
    if (commits.has(envelope.commitId)) issues.push({ code: 'DUPLICATE_COMMIT', commitId: envelope.commitId, message: '同じ変更IDのファイルが複数あります。' });
    else commits.set(envelope.commitId, envelope);
    datasets.add(envelope.datasetId);
    envelope.parentCommitIds.forEach((id) => referenced.add(id));
  }
  if (datasets.size > 1) issues.push({ code: 'MULTIPLE_DATASETS', message: '異なるデータセットが混在しています。別々の同期フォルダを使用してください。' });
  for (const envelope of commits.values()) for (const id of envelope.parentCommitIds) {
    if (!commits.has(id)) issues.push({ code: 'MISSING_PARENT', commitId: envelope.commitId, parentCommitId: id, message: '同期履歴の一部が見つかりません。' });
  }
  // Iterative topology check remains safe for long histories without recursion.
  const degree = new Map(), children = new Map();
  for (const [id, envelope] of commits) {
    degree.set(id, envelope.parentCommitIds.filter((parent) => commits.has(parent)).length);
    for (const parent of envelope.parentCommitIds) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(id);
    }
  }
  const queue = [...degree.keys()].filter((id) => degree.get(id) === 0); let processed = 0;
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]; processed++;
    for (const child of children.get(id) ?? []) {
      degree.set(child, degree.get(child) - 1);
      if (degree.get(child) === 0) queue.push(child);
    }
  }
  if (processed !== commits.size) issues.push({ code: 'CYCLE', message: '同期履歴に循環参照があります。' });
  const heads = [...commits.keys()].filter((id) => !referenced.has(id)).sort();
  return { status: issues.length ? 'invalid' : snapshots.length === 0 ? 'empty' : heads.length > 1 ? 'conflict' : 'ready',
    snapshots, heads, issues, datasetId: datasets.size === 1 ? [...datasets][0] : null };
}

/** Small immutable headers permit complete graph checks without downloading archived GPS/diary data. */
export function snapshotAppProperties(envelope) {
  const parents = JSON.stringify(parentIds(envelope.parentCommitIds));
  if (parents.length > 24 * 120) fail('METADATA_TOO_LARGE', '分岐が多すぎるため安全な履歴属性を作成できません。');
  const chunks = parents.match(/.{1,120}/g);
  const properties = { myPaceSync: SYNC_FORMAT, datasetId: envelope.datasetId, commitId: envelope.commitId,
    stateHash: envelope.hash, parentParts: String(chunks.length), createdAt: envelope.createdAt };
  chunks.forEach((chunk, i) => { properties[`p${String(i).padStart(2, '0')}`] = chunk; });
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value !== 'string' || encoder.encode(key + value).byteLength > 124) fail('METADATA_TOO_LARGE', 'Driveの同期属性が容量上限を超えています。');
  }
  return properties;
}
export function parseSnapshotMetadata(item) {
  identifier(item?.id, 'DriveファイルID');
  const props = item.appProperties;
  if (!props || typeof props !== 'object' || Array.isArray(props) || props.myPaceSync !== SYNC_FORMAT ||
      !/^(?:[1-9]|1[0-9]|2[0-4])$/.test(props.parentParts)) fail('INVALID_METADATA', 'Driveの同期属性を検証できません。');
  const count = Number(props.parentParts), keys = ['myPaceSync', 'datasetId', 'commitId', 'stateHash', 'parentParts', 'createdAt'];
  for (let i = 0; i < count; i++) keys.push(`p${String(i).padStart(2, '0')}`);
  exactRecord(props, keys, 'INVALID_METADATA');
  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== 'string' || encoder.encode(key + value).byteLength > 124) fail('INVALID_METADATA', 'Driveの同期属性が正しくありません。');
  }
  identifier(props.datasetId); identifier(props.commitId);
  if (!/^[a-f0-9]{64}$/.test(props.stateHash) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(props.createdAt) ||
      !Number.isFinite(Date.parse(props.createdAt)) || new Date(props.createdAt).toISOString() !== props.createdAt) fail('INVALID_METADATA', 'Driveの同期属性が正しくありません。');
  let encoded = '';
  for (let i = 0; i < count; i++) {
    const chunk = props[`p${String(i).padStart(2, '0')}`];
    if (!/^[\x20-\x7e]{1,120}$/.test(chunk)) fail('INVALID_METADATA', 'Driveの親履歴属性が正しくありません。');
    encoded += chunk;
  }
  let parents;
  try { parents = parentIds(JSON.parse(encoded)); } catch { fail('INVALID_METADATA', 'Driveの親履歴属性が正しくありません。'); }
  if (JSON.stringify(parents) !== encoded || parents.includes(props.commitId)) fail('INVALID_METADATA', 'Driveの親履歴属性が正しくありません。');
  if (item.name !== `mypace-${props.commitId}.json`) fail('METADATA_MISMATCH', 'Driveの同期ファイル名が一致しません。');
  if (item.size !== undefined && (!/^\d+$/.test(String(item.size)) || Number(item.size) > SYNC_LIMITS.snapshotBytes)) fail('HISTORY_LIMIT', '同期履歴に容量上限を超えたファイルがあります。');
  const record = { fileId: item.id, commitId: props.commitId, datasetId: props.datasetId, parentCommitIds: parents,
    hash: props.stateHash, createdAt: props.createdAt, size: item.size === undefined ? null : Number(item.size) };
  if (canonicalJSON(snapshotAppProperties(record)) !== canonicalJSON(props)) fail('INVALID_METADATA', 'Driveの同期属性が標準形式ではありません。');
  return record;
}

/**
 * getState and applyState must be synchronous. applyState must durably persist the
 * complete local state before returning (false means failure). Access tokens
 * belong to the API adapter's memory only, never this coordinator's storage.
 */
export class DriveSyncCoordinator {
  constructor({ api, storage = globalThis.localStorage, getState, applyState,
    locks = globalThis.navigator?.locks, crypto = globalThis.crypto, now = () => new Date(), onStatus = () => {},
    autosaveDelay = 1500, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
    isVisible = () => globalThis.document?.visibilityState !== 'hidden', isOnline = () => globalThis.navigator?.onLine !== false } = {}) {
    if (!api || !['listSnapshots', 'readSnapshot', 'generateId', 'createSnapshot'].every((key) => typeof api[key] === 'function') ||
        typeof getState !== 'function' || typeof applyState !== 'function') throw new TypeError('Drive sync requires an API, getState, and applyState.');
    this.api = api; this.storage = storage; this.getState = getState; this.applyState = applyState;
    this.locks = locks; this.crypto = crypto; this.now = now; this.onStatus = onStatus;
    if (!Number.isFinite(autosaveDelay) || autosaveDelay < 0) throw new TypeError('Invalid autosave delay');
    this.autosaveDelay = autosaveDelay; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.isVisible = isVisible; this.isOnline = isOnline; this._timer = null;
    this._epoch = 0; this._revision = 0; this._busy = 0; this._folderId = null; this._ready = false;
    this._baseline = null; this._hydrated = false; this._autosave = false; this._verified = false;
    this._dirty = true; this._pendingCount = 0; this._state = 'disconnected'; this._message = 'Driveは未接続です。';
    this._controller = null; this._last = null; this._deviceId = null; this._ownedPendingFileId = null;
  }
  getStatus() { return { state: this._state, message: this._message, dirty: this._dirty, verified: this._verified,
    autosave: this._autosave, connected: Boolean(this._folderId && this._ready), busy: this._busy > 0,
    pendingCount: this._pendingCount, locksAvailable: Boolean(this.locks?.request), folderId: this._folderId }; }
  _emit() { try { this.onStatus(this.getStatus()); } catch { /* A view callback cannot change sync safety. */ } }
  _status(state, message) { this._state = state; this._message = message; this._emit(); }
  connectFolder(folderId) {
    identifier(folderId, 'フォルダID');
    this.disconnect(); this._folderId = folderId; this._hydrated = false; this._deviceId = null;
    this._status('needs-auth', 'Googleへの接続を確認してください。'); return this.getStatus();
  }
  setReady(ready = true) {
    if (typeof ready !== 'boolean') throw new TypeError('ready must be boolean');
    if (ready && !this._folderId) fail('FOLDER_REQUIRED', '同期フォルダを選んでください。');
    this._controller?.abort(); this._controller = new AbortController(); this._epoch++;
    this._ready = ready; this._autosave = false; this._cancelAutosave();
    this._status(ready ? 'idle' : 'needs-auth', ready ? '同期履歴を確認できます。' : 'Googleに再接続してください。');
    return this.getStatus();
  }
  disconnect() {
    this._cancelAutosave();
    this._controller?.abort(); this._epoch++; this._ready = false; this._folderId = null;
    this._baseline = null; this._hydrated = false; this._autosave = false; this._verified = false;
    this._dirty = true; this._pendingCount = 0; this._last = null; this._ownedPendingFileId = null;
    this._status('disconnected', 'Driveは未接続です。');
  }
  notifyLocalChange() {
    this._revision++; this._dirty = true; this._emit();
    try { this._scheduleAutosave(); } catch { /* A successful local edit must never fail due to scheduling. */ }
  }
  _cancelAutosave() { if (this._timer !== null) { this.clearTimer(this._timer); this._timer = null; } }
  _scheduleAutosave() {
    this._cancelAutosave();
    if (this._busy > 0 || !this._autosave || !this._ready || (!this._dirty && !this._pendingCount) || !this.isVisible() || !this.isOnline()) return;
    this._timer = this.setTimer(() => {
      this._timer = null;
      if (this._busy > 0 || !this._autosave || !this._ready || !this.isVisible() || !this.isOnline()) return;
      return this.save({ explicit: false }).catch(() => { /* Status/outbox retain the error for an explicit or online/resume retry. */ });
    }, this.autosaveDelay);
  }
  _recoverable(error) {
    const status = error?.status ?? error?.statusCode;
    return (error?.code === 'RATE_LIMIT' && (!status || status === 403 || status === 429)) ||
      (error?.code === 'NETWORK_TIMEOUT' && !status) || status === 408 || status === 429 || status >= 500 || (!status && !(error instanceof DriveSyncError) &&
      (!error?.code || ['NETWORK', 'NETWORK_ERROR', 'OFFLINE', 'RATE_LIMITED', 'DRIVE_UNAVAILABLE'].includes(error.code)));
  }
  setAutosave(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('autosave must be boolean');
    if (enabled && (!this.locks?.request || !this._ready || !this._verified || !this._baseline || this._last?.status !== 'ready')) {
      fail('AUTOSAVE_NOT_READY', '自動保存は、手動保存と読み戻し確認が成功した後で有効にできます。');
    }
    this._autosave = enabled; this._scheduleAutosave(); this._emit(); return this.getStatus();
  }
  _key(kind) { return `${SYNC_STORAGE_PREFIX}:${kind}:${this._folderId}`; }
  _read(key, maximum = SYNC_LIMITS.metadataBytes) {
    let value;
    try { value = this.storage?.getItem(key); } catch { fail('STORAGE_UNAVAILABLE', '端末の同期記録を読み取れません。'); }
    if (value == null) return null;
    if (typeof value !== 'string' || value.length > maximum || encoder.encode(value).byteLength > maximum) fail('STORAGE_CORRUPT', '端末の同期記録が破損しています。');
    try { return JSON.parse(value); } catch { fail('STORAGE_CORRUPT', '端末の同期記録を読み取れません。'); }
  }
  _write(key, value) {
    const text = JSON.stringify(value);
    try {
      if (!this.storage?.setItem) throw new Error('Missing storage');
      this.storage.setItem(key, text);
      if (this.storage.getItem(key) !== text) throw new Error('Storage verification failed');
    } catch { fail('STORAGE_WRITE_FAILED', '端末に送信待ちデータを安全に保存できません。容量やブラウザの保存設定を確認してください。'); }
  }
  _remove(key) {
    try { this.storage.removeItem(key); if (this.storage.getItem(key) !== null) throw new Error('not removed'); }
    catch { fail('STORAGE_WRITE_FAILED', 'Driveへの保存は確認できましたが、端末の送信待ち記録を更新できません。再試行しても同じファイルを確認します。'); }
  }
  _check(epoch) {
    if (epoch !== this._epoch || !this._ready || !this._folderId || this._controller?.signal.aborted) fail('ABORTED', '同期を中止しました。送信待ちデータは保持されます。');
  }
  async _await(promise, epoch) { const value = await promise; this._check(epoch); return value; }
  async _run(action, { write = false } = {}) {
    if (!this._ready || !this._folderId) fail('NOT_READY', 'Googleに接続して同期フォルダを選んでください。');
    if (write && !this.locks?.request) fail('LOCKS_REQUIRED', 'このブラウザでは複数タブの安全な同期に必要なWeb Locksが使えません。Driveへの保存と自動保存は無効です。');
    const epoch = this._epoch, folder = this._folderId;
    this._busy++; this._emit(); let succeeded = false;
    const execute = async () => { this._check(epoch); return action(epoch); };
    try { const result = await (this.locks?.request ? this.locks.request(`${SYNC_STORAGE_PREFIX}:lock:${folder}`, { mode: 'exclusive' }, execute) : execute()); succeeded = true; return result; }
    catch (error) {
      if (epoch === this._epoch && error.code !== 'ABORTED') {
        if (!this._recoverable(error)) { this._autosave = false; this._cancelAutosave(); }
        this._status(['CONFLICT', 'CHOICE_REQUIRED', 'REMOTE_CHANGED'].includes(error.code) ? 'conflict' : 'error', error instanceof DriveSyncError ? error.message : 'Driveとの通信に失敗しました。送信待ちデータは保持されます。');
      }
      throw error;
    } finally { this._busy--; if (succeeded && epoch === this._epoch && this._busy === 0) this._scheduleAutosave(); this._emit(); }
  }
  async _hydrate(epoch) {
    if (this._hydrated) return;
    // Without origin-wide locks, never reuse or write shared baseline metadata.
    if (!this.locks?.request) { this._hydrated = true; return; }
    const meta = this._read(this._key('meta'));
    if (!meta) { this._hydrated = true; return; }
    exactRecord(meta, ['version', 'folderId', 'deviceId', 'datasetId', 'baselineCommitId', 'baselineHash'], 'STORAGE_CORRUPT');
    if (meta.version !== 1 || meta.folderId !== this._folderId || typeof meta.baselineHash !== 'string' || !/^[a-f0-9]{64}$/.test(meta.baselineHash)) fail('STORAGE_CORRUPT', '端末の同期記録が正しくありません。');
    ['deviceId', 'datasetId', 'baselineCommitId'].forEach((key) => identifier(meta[key]));
    this._deviceId = meta.deviceId;
    const current = canonicalState(this.getState()), revision = this._revision;
    const hash = await this._await(digest(current.text, this.crypto), epoch);
    if (revision === this._revision && canonicalState(this.getState()).text === current.text && hash === meta.baselineHash) {
      this._baseline = { commitId: meta.baselineCommitId, hash, datasetId: meta.datasetId };
      this._dirty = false;
    }
    this._hydrated = true;
  }
  async _pending(epoch) {
    const pending = this._read(this._key('outbox'), SYNC_LIMITS.snapshotBytes * 2 + 8192);
    this._pendingCount = pending ? 1 : 0;
    if (!pending) return null;
    exactRecord(pending, ['version', 'folderId', 'fileId', 'text', 'explicit'], 'STORAGE_CORRUPT');
    if (pending.version !== 1 || pending.folderId !== this._folderId || typeof pending.explicit !== 'boolean') fail('STORAGE_CORRUPT', '送信待ちデータが正しくありません。');
    identifier(pending.fileId, 'DriveファイルID');
    const envelope = await this._await(parseSnapshot(pending.text, { crypto: this.crypto }), epoch);
    return { ...pending, envelope };
  }
  async _readEnvelope(record, epoch) {
    const text = await this._await(this.api.readSnapshot(record.fileId, { signal: this._controller.signal }), epoch);
    const envelope = await this._await(parseSnapshot(text, { crypto: this.crypto }), epoch);
    if (canonicalJSON(snapshotAppProperties(record)) !== canonicalJSON(snapshotAppProperties(envelope))) {
      fail('METADATA_MISMATCH', 'Driveのファイル属性と内容が一致しません。');
    }
    return { fileId: record.fileId, envelope, bytes: encoder.encode(text).byteLength };
  }
  async _inspect(epoch) {
    await this._hydrate(epoch); this._check(epoch);
    const metadata = await this._await(this.api.listSnapshots(this._folderId, { signal: this._controller.signal }), epoch);
    if (!Array.isArray(metadata) || metadata.length > SYNC_LIMITS.snapshots) fail('HISTORY_LIMIT', '同期履歴が10,000件を超えています。履歴を省略して同期することはできません。');
    const history = [], issues = [];
    for (const item of metadata) {
      try { history.push(parseSnapshotMetadata(item)); }
      catch (error) { issues.push({ code: error.code ?? 'INVALID_METADATA', fileId: typeof item?.id === 'string' ? item.id : '', message: error instanceof DriveSyncError ? error.message : '同期属性を検証できません。' }); }
    }
    const graph = analyzeSnapshots(history.map((record) => ({ fileId: record.fileId, envelope: record })));
    graph.issues.push(...issues); graph.snapshots = []; graph.history = history; graph.historyCount = metadata.length;
    if (graph.heads.length > SYNC_LIMITS.parents) graph.issues.push({ code: 'TOO_MANY_HEADS', message: '分岐が64件を超えています。自動的に履歴を省略して同期することはできません。' });
    if (graph.issues.length) graph.status = 'invalid';
    if (graph.status !== 'invalid') {
      const headSet = new Set(graph.heads), headRecords = history.filter((record) => headSet.has(record.commitId));
      let bytes = headRecords.reduce((total, record) => total + (record.size ?? 0), 0);
      if (bytes > SYNC_LIMITS.historyBytes) fail('HISTORY_LIMIT', '同期の分岐データ合計が64MiBを超えています。');
      bytes = 0;
      for (const record of headRecords) {
        try {
          const loaded = await this._readEnvelope(record, epoch); bytes += loaded.bytes;
          if (bytes > SYNC_LIMITS.historyBytes) fail('HISTORY_LIMIT', '同期の分岐データ合計が64MiBを超えています。');
          graph.snapshots.push({ fileId: loaded.fileId, envelope: loaded.envelope });
        } catch (error) {
          if (error.code === 'ABORTED' || !(error instanceof DriveSyncError)) throw error;
          graph.issues.push({ code: error.code, fileId: record.fileId, message: error.message });
        }
      }
    }
    if (graph.issues.length) graph.status = 'invalid';
    else if (graph.status === 'ready' && !this._baseline) graph.status = 'choice-required';
    else if (graph.status === 'ready' && (!equalIds(graph.heads, [this._baseline.commitId]) || graph.datasetId !== this._baseline.datasetId)) {
      graph.status = 'conflict'; graph.issues.push({ code: 'REMOTE_CHANGED', message: '別の端末で変更されています。保存する内容を選んでください。' });
    } else if (graph.status === 'empty' && this._baseline) {
      graph.status = 'invalid'; graph.issues.push({ code: 'MISSING_BASELINE', message: '以前の同期履歴が見つかりません。別のフォルダへの保存を検討してください。' });
    }
    if (this._baseline && history.some((record) => record.commitId === this._baseline.commitId && record.hash !== this._baseline.hash)) {
      graph.status = 'invalid'; graph.issues.push({ code: 'BASELINE_MISMATCH', message: '以前に確認した同期内容と一致しません。' });
    }
    this._pendingCount = this._read(this._key('outbox'), SYNC_LIMITS.snapshotBytes * 2 + 8192) ? 1 : 0;
    this._last = { status: graph.status, heads: [...graph.heads] };
    if (['invalid', 'conflict', 'choice-required'].includes(graph.status)) { this._autosave = false; this._cancelAutosave(); }
    const messages = { empty: '同期フォルダは空です。最初の保存は手動で実行してください。', ready: '同期履歴を確認しました。',
      'choice-required': 'Driveに既存データがあります。使う記録を明示的に選んでください。', conflict: '記録が分岐しています。使う内容を選んでください。', invalid: '同期履歴に問題があるため保存を停止しています。' };
    this._status(graph.status, messages[graph.status]);
    return graph;
  }
  inspect() { return this._run(async (epoch) => clone(await this._inspect(epoch))); }
  _persistBaseline(envelope) {
    this._write(this._key('meta'), { version: 1, folderId: this._folderId, deviceId: this._deviceId ?? envelope.deviceId,
      datasetId: envelope.datasetId, baselineCommitId: envelope.commitId, baselineHash: envelope.hash });
    this._baseline = { commitId: envelope.commitId, hash: envelope.hash, datasetId: envelope.datasetId };
  }
  async _flush(pending, epoch, explicit) {
    const { envelope } = pending, signal = this._controller.signal;
    this._check(epoch);
    try {
      await this._await(this.api.createSnapshot({ id: pending.fileId, folderId: this._folderId,
        name: `mypace-${envelope.commitId}.json`, text: pending.text,
        appProperties: snapshotAppProperties(envelope), signal }), epoch);
    } catch (error) {
      this._check(epoch);
      if (error.code === 'CONTENT_CONFLICT') throw error;
      if (!(error.status === 409 || error.statusCode === 409 || error.code === 'ALREADY_EXISTS')) throw error;
      // A collision never means success until exact existing bytes are verified below.
    }
    const readback = await this._await(this.api.readSnapshot(pending.fileId, { signal }), epoch);
    if (readback !== pending.text) fail('READBACK_MISMATCH', '保存先の内容が送信待ちデータと一致しません。上書きせず停止しました。');
    await this._await(parseSnapshot(readback, { crypto: this.crypto }), epoch);
    const previousBaseline = this._baseline;
    const canAdopt = this._ownedPendingFileId === pending.fileId || this._baseline?.commitId === envelope.commitId ||
      canonicalState(this.getState()).text === canonicalState(envelope.state).text;
    this._persistBaseline(envelope); this._check(epoch);
    if (!canAdopt) {
      // Completing another tab's/reloaded outbox does not establish lineage for divergent local edits.
      this._baseline = previousBaseline; this._autosave = false; this._cancelAutosave();
    }
    // Catch a concurrent writer whose immutable create raced our preflight.
    const graph = await this._inspect(epoch);
    if (graph.status === 'invalid') fail('INVALID_HISTORY', graph.issues[0]?.message ?? '保存後の同期履歴を検証できません。送信待ちデータを保持しました。');
    if (!graph.history.some((item) => item.fileId === pending.fileId && item.commitId === envelope.commitId)) {
      this._autosave = false; fail('READBACK_NOT_LISTED', '保存したファイルは読み戻せましたが、同期履歴一覧で確認できません。再確認してください。');
    }
    this._remove(this._key('outbox')); this._pendingCount = 0; this._ownedPendingFileId = null;
    this._dirty = canonicalState(this.getState()).text !== canonicalState(envelope.state).text;
    if (explicit) this._verified = true;
    this._emit();
    return { commitId: envelope.commitId, fileId: pending.fileId, hash: envelope.hash, dirty: this._dirty,
      verified: true, conflict: graph.status !== 'ready', heads: graph.heads };
  }
  async save({ explicit = true, resolution = false, expectedHeads, expectedLocalHash } = {}) {
    if (typeof explicit !== 'boolean' || typeof resolution !== 'boolean') throw new TypeError('Save flags must be boolean');
    if (!explicit && !this._autosave) fail('AUTOSAVE_DISABLED', '自動保存は有効になっていません。');
    if (resolution && !explicit) fail('EXPLICIT_CHOICE_REQUIRED', '競合の解決には明示的な確認が必要です。');
    return this._run(async (epoch) => {
      if (!explicit && !this._autosave) fail('AUTOSAVE_DISABLED', '自動保存は有効になっていません。');
      await this._hydrate(epoch); this._check(epoch);
      const current = canonicalState(this.getState());
      const currentHash = await this._await(digest(current.text, this.crypto), epoch);
      if (expectedLocalHash !== undefined && (expectedLocalHash !== currentHash || current.text !== canonicalState(this.getState()).text)) fail('LOCAL_CHANGED', '確認中に端末の記録が変更されました。内容をもう一度確認してください。');
      const pending = await this._pending(epoch);
      if (pending) {
        if (resolution) fail('PENDING_UPLOAD', '先に送信待ちの保存を再試行し、その後で競合を解決してください。');
        const result = await this._flush(pending, epoch, explicit); return { ...result, retried: true };
      }
      const graph = await this._inspect(epoch);
      if (graph.status === 'invalid') fail('INVALID_HISTORY', graph.issues[0]?.message ?? '同期履歴を検証できません。');
      if (resolution) {
        if (!Array.isArray(expectedHeads) || !equalIds(parentIds(expectedHeads), graph.heads)) fail('REMOTE_CHANGED', '確認後にDriveの記録が変わりました。もう一度確認してください。');
      } else if (graph.heads.length && (!this._baseline || graph.datasetId !== this._baseline.datasetId || !equalIds(graph.heads, [this._baseline.commitId]))) {
        fail(this._baseline ? 'CONFLICT' : 'CHOICE_REQUIRED', '既存データを自動で置き換えることはできません。使う記録を明示的に選んでください。');
      } else if (expectedHeads !== undefined && !equalIds(parentIds(expectedHeads), graph.heads)) fail('REMOTE_CHANGED', 'Driveの記録が変わりました。もう一度確認してください。');
      if (!explicit && (graph.status !== 'ready' || !this._verified)) fail('AUTOSAVE_NOT_READY', '最初の保存は手動で実行してください。');
      // Guard again after listing history: the confirmed local content may have changed during network waits.
      if (expectedLocalHash !== undefined && current.text !== canonicalState(this.getState()).text) fail('LOCAL_CHANGED', '確認中に端末の記録が変更されました。内容をもう一度確認してください。');
      if (graph.status === 'ready' && this._baseline?.hash === currentHash && !resolution) {
        const existing = graph.snapshots.find(({ envelope }) => envelope.commitId === this._baseline.commitId);
        this._dirty = current.text !== canonicalState(this.getState()).text;
        if (explicit) this._verified = true;
        this._emit();
        return { commitId: existing.envelope.commitId, fileId: existing.fileId, hash: currentHash,
          dirty: this._dirty, verified: true, retried: false, unchanged: true, heads: graph.heads, conflict: false };
      }
      if (graph.historyCount >= SYNC_LIMITS.snapshots) fail('HISTORY_LIMIT', '同期履歴が10,000件に達しています。履歴を削除せず安全に停止しました。');
      this._deviceId ??= newId(this.crypto);
      const datasetId = graph.datasetId ?? await this._await(datasetIdForFolder(this._folderId, this.crypto), epoch);
      const envelope = await this._await(createSnapshotEnvelope({ datasetId,
        commitId: newId(this.crypto), parentCommitIds: graph.heads, deviceId: this._deviceId, state: current.state,
        createdAt: new Date(this.now()).toISOString() }, { crypto: this.crypto }), epoch);
      snapshotAppProperties(envelope);
      const snapshotText = JSON.stringify(envelope);
      if (encoder.encode(snapshotText).byteLength > SYNC_LIMITS.uploadBytes) fail('UPLOAD_TOO_LARGE', 'Drive同期は1版5MB以下です。端末のJSONバックアップは12MiBまで保存できます。');
      const fileId = identifier(await this._await(this.api.generateId({ signal: this._controller.signal }), epoch), 'DriveファイルID');
      const entry = { version: 1, folderId: this._folderId, fileId, text: snapshotText, explicit };
      if (encoder.encode(entry.text).byteLength > SYNC_LIMITS.snapshotBytes) fail('SNAPSHOT_TOO_LARGE', '同期スナップショットの容量が大きすぎます。');
      this._write(this._key('outbox'), entry); this._pendingCount = 1; this._ownedPendingFileId = fileId; this._emit();
      return { ...await this._flush({ ...entry, envelope }, epoch, explicit), retried: false };
    }, { write: true });
  }
  /** Read a selected historical body on demand; never downloads every archived state. */
  async preview(commitId, { expectedHeads } = {}) {
    identifier(commitId, '変更ID');
    return this._run(async (epoch) => {
      const graph = await this._inspect(epoch);
      if (graph.status === 'invalid') fail('INVALID_HISTORY', graph.issues[0]?.message ?? '同期履歴を検証できません。');
      if (expectedHeads !== undefined && !equalIds(parentIds(expectedHeads), graph.heads)) fail('REMOTE_CHANGED', '確認後にDriveの記録が変わりました。');
      const record = graph.history.find((item) => item.commitId === commitId);
      if (!record) fail('SNAPSHOT_NOT_FOUND', '選んだ記録が見つかりません。');
      const selected = graph.snapshots.find(({ envelope }) => envelope.commitId === commitId) ?? await this._readEnvelope(record, epoch);
      return { fileId: selected.fileId, envelope: clone(selected.envelope), heads: [...graph.heads] };
    });
  }
  async load(commitId, { expectedLocalHash, expectedHeads, expectedSnapshotHash } = {}) {
    identifier(commitId, '変更ID');
    const before = canonicalState(this.getState()), revision = this._revision;
    return this._run(async (epoch) => {
      const beforeHash = await this._await(digest(before.text, this.crypto), epoch);
      if (expectedLocalHash !== undefined && expectedLocalHash !== beforeHash) fail('LOCAL_CHANGED', '確認後に端末の記録が変わりました。');
      const graph = await this._inspect(epoch);
      if (graph.status === 'invalid') fail('INVALID_HISTORY', graph.issues[0]?.message ?? '同期履歴を検証できません。');
      if (expectedHeads !== undefined && !equalIds(parentIds(expectedHeads), graph.heads)) fail('REMOTE_CHANGED', '確認後にDriveの記録が変わりました。');
      const record = graph.history.find((item) => item.commitId === commitId);
      if (!record) fail('SNAPSHOT_NOT_FOUND', '選んだ記録が見つかりません。');
      const selected = graph.snapshots.find(({ envelope }) => envelope.commitId === commitId) ?? await this._readEnvelope(record, epoch);
      if (expectedSnapshotHash !== undefined && expectedSnapshotHash !== selected.envelope.hash) fail('REMOTE_CHANGED', '確認後に選んだDriveの内容が変更されました。もう一度内容を確認してください。');
      if (revision !== this._revision || before.text !== canonicalState(this.getState()).text) fail('LOCAL_CHANGED', '読み込み中に端末の記録が変更されました。上書きを中止しました。');
      this._check(epoch);
      const result = this.applyState(clone(selected.envelope.state));
      if (result === false || result?.then) fail('LOCAL_SAVE_FAILED', '読み込んだ記録を端末に保存できません。');
      if (canonicalState(this.getState()).text !== canonicalState(selected.envelope.state).text) fail('LOCAL_SAVE_FAILED', '読み込んだ内容を端末で確認できません。');
      const envelope = selected.envelope;
      this._autosave = false; this._cancelAutosave();
      if (this.locks?.request) this._persistBaseline(envelope);
      else this._baseline = { commitId, hash: envelope.hash, datasetId: envelope.datasetId };
      this._dirty = false;
      this._last = { status: equalIds(graph.heads, [commitId]) ? 'ready' : 'conflict', heads: graph.heads };
      this._status(this._last.status, this._last.status === 'ready' ? '選んだ記録を端末に読み込みました。' : '選んだ記録を読み込みました。分岐を解決する保存には別の確認が必要です。');
      return { state: clone(envelope.state), commitId, hash: envelope.hash, dirty: false };
    });
  }
}
