/** Browser-only Google Drive adapter. Importing/constructing it makes no network requests.
 * Tokens live only in this closure. Call prepare() from an explicit click, then
 * connect() from a fresh click so GIS can open its account/consent popup.
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_PROJECT_NUMBER = '402304619999';
export const EXPECTED_FOLDER_ID = '1kqtRzzNKZAq7-HE83XIN_JErtBn9YM_6';
export const MAX_UPLOAD_BYTES = 5_000_000; // Google multipart guidance uses decimal MB.
export const MAX_SNAPSHOT_BYTES = 13 * 1024 * 1024; // 12 MiB state plus envelope allowance.
export const SNAPSHOT_MARKER = Object.freeze({ myPaceSync: 'my-pace-drive-v1' });
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,size,parents,appProperties,ownedByMe,shared,trashed,createdTime,modifiedTime';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files';
const encoder = new TextEncoder();

export class GoogleDriveError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'GoogleDriveError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
const failure = (code, message, status) => new GoogleDriveError(code, message, status);
const aborted = () => failure('ABORTED', 'Google Drive の操作を中止しました。');
const checkAbort = signal => { if (signal?.aborted) throw aborted(); };
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id);

/** Accept public browser credentials only. This does not verify server-side key restrictions. */
export function validateGoogleConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw failure('CONFIG', 'OAuth クライアント ID とブラウザ API キーを入力してください。');
  if (Object.keys(config).some(key => /secret|token|password|credential|private/i.test(key))) {
    throw failure('CONFIG', 'クライアントシークレットやアクセストークンは入力しないでください。');
  }
  const clientId = typeof config.clientId === 'string' ? config.clientId.trim() : '';
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  if (!/^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId) || clientId.length > 250) {
    throw failure('CONFIG', 'Web アプリ用の公開 OAuth クライアント ID を入力してください。');
  }
  if (!/^AIza[A-Za-z0-9_-]{35}$/.test(apiKey)) throw failure('CONFIG', '制限付きブラウザ API キーを入力してください。');
  const projectNumber = String(config.projectNumber ?? GOOGLE_PROJECT_NUMBER);
  const expectedFolderId = config.expectedFolderId ?? EXPECTED_FOLDER_ID;
  if (projectNumber !== GOOGLE_PROJECT_NUMBER || expectedFolderId !== EXPECTED_FOLDER_ID) {
    throw failure('CONFIG', 'このアプリで指定された Google プロジェクトと保存先フォルダを使用してください。');
  }
  if (!clientId.startsWith(`${GOOGLE_PROJECT_NUMBER}-`)) throw failure('CONFIG', '指定された Google プロジェクトのクライアント ID を使用してください。');
  return Object.freeze({ clientId, apiKey, projectNumber, expectedFolderId });
}

function withCallback(start, { signal, timeoutMs, setTimer, clearTimer }, timeoutCode = 'TIMEOUT') {
  return new Promise((resolve, reject) => {
    let settled = false, timer, cleanup;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
      if (cleanup) { try { cleanup(); } catch { /* Best-effort SDK disposal. */ } }
      error ? reject(error) : resolve(value);
    };
    const onAbort = () => finish(aborted());
    if (signal?.aborted) return finish(aborted());
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimer(() => finish(failure(timeoutCode, 'Google の応答がありません。もう一度お試しください。')), timeoutMs);
    timer?.unref?.();
    try {
      cleanup = start(finish);
      if (settled && cleanup) { try { cleanup(); } catch { /* Best-effort SDK disposal. */ } }
    } catch {
      finish(failure('SDK_ERROR', 'Google の画面を開けませんでした。ブラウザの設定を確認してください。'));
    }
  });
}

/** Explicit opt-in loader; never call during application startup. No global callback queues. */
export async function loadGoogle({ window: win = globalThis.window, document: doc = globalThis.document,
  signal, timeoutMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!win || !doc?.createElement || !doc?.head) throw failure('BROWSER_REQUIRED', 'ブラウザで Google Drive に接続してください。');
  checkAbort(signal);
  const pending = new AbortController();
  const onAbort = () => pending.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const settings = { signal: pending.signal, timeoutMs, setTimer, clearTimer };
  const script = (src, ready) => ready() ? Promise.resolve() : withCallback(finish => {
    const node = doc.createElement('script');
    node.src = src;
    node.async = true;
    node.defer = true;
    node.onload = () => finish(ready() ? null : failure('SDK_LOAD', 'Google の読み込みを完了できませんでした。'));
    node.onerror = () => finish(failure('SDK_LOAD', 'Google を読み込めません。接続とブラウザの設定を確認してください。'));
    doc.head.appendChild(node);
    return () => { node.onload = null; node.onerror = null; node.remove(); };
  }, settings, 'SDK_TIMEOUT');
  try {
    await Promise.all([
      script('https://accounts.google.com/gsi/client', () => Boolean(win.google?.accounts?.oauth2?.initTokenClient)),
      script('https://apis.google.com/js/api.js', () => Boolean(win.gapi?.load || win.google?.picker?.PickerBuilder)),
    ]);
    checkAbort(pending.signal);
    if (!win.google?.picker?.PickerBuilder) await withCallback(finish => {
      win.gapi.load('picker', { callback: () => finish(win.google?.picker?.PickerBuilder ? null : failure('SDK_LOAD', 'フォルダ選択画面を読み込めませんでした。')),
        onerror: () => finish(failure('SDK_LOAD', 'フォルダ選択画面を読み込めませんでした。')),
        timeout: timeoutMs, ontimeout: () => finish(failure('SDK_TIMEOUT', 'フォルダ選択画面の読み込みがタイムアウトしました。')) });
    }, settings, 'SDK_TIMEOUT');
    checkAbort(pending.signal);
  } finally {
    pending.abort(); // Cancel remaining script callbacks if either load failed.
    signal?.removeEventListener('abort', onAbort);
  }
}

/** All dependencies are injectable for offline tests. No method exposes the access token. */
export function createGoogleDrive(options = {}) {
  const win = options.window ?? globalThis.window;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const maxRetries = Math.min(4, Math.max(0, options.maxRetries ?? 3));
  const random = options.random ?? Math.random;
  let token = null, expiresAt = 0, expiryTimer, config, folder = null;
  let session = new AbortController(), preparation = null, connecting = false, picking = false;
  const onDisconnect = options.onDisconnect ?? (() => {});
  const isPrepared = () => Boolean(win?.google?.accounts?.oauth2?.initTokenClient && win?.google?.picker?.PickerBuilder);
  function disconnect(reason = 'disconnected') {
    const wasActive = Boolean(token || connecting || picking || preparation);
    token = null; expiresAt = 0; folder = null; config = undefined;
    clearTimer(expiryTimer); expiryTimer = undefined;
    session.abort(); session = new AbortController();
    if (wasActive) { try { onDisconnect(reason); } catch { /* UI callbacks cannot retain the session. */ } }
  }
  function isConnected() {
    if (token && now() >= expiresAt) disconnect('expired');
    return Boolean(token);
  }
  function requireConnected() {
    if (!isConnected()) throw failure('NOT_CONNECTED', 'Google Drive に接続し直してください。');
    return session.signal;
  }
  function requireFolder(id = EXPECTED_FOLDER_ID) {
    const signal = requireConnected();
    if (id !== EXPECTED_FOLDER_ID || folder?.id !== id) throw failure('FOLDER_REQUIRED', '指定されたフォルダを Google の選択画面で選んでください。');
    return signal;
  }
  function prepare() {
    if (isPrepared()) return Promise.resolve();
    if (preparation) return preparation;
    const current = loadGoogle({ window: win, document: options.document ?? globalThis.document, signal: session.signal,
      timeoutMs: options.sdkTimeoutMs ?? 15000, setTimer, clearTimer });
    preparation = current;
    return current.finally(() => { if (preparation === current) preparation = null; });
  }
  // Deliberately not async: requestAccessToken executes before returning to the click handler.
  function connect(input) {
    const nextConfig = validateGoogleConfig(input);
    if (!isPrepared()) return Promise.reject(failure('SDK_NOT_READY', '先に Google 接続の準備をしてから、接続ボタンを押してください。'));
    if (connecting) return Promise.reject(failure('BUSY', 'Google への接続処理中です。'));
    disconnect('reconnecting');
    connecting = true;
    const signal = session.signal;
    const oauth = win.google.accounts.oauth2;
    return withCallback(finish => {
      let active = true;
      const client = oauth.initTokenClient({ client_id: nextConfig.clientId, scope: DRIVE_SCOPE,
        include_granted_scopes: false, prompt: 'select_account',
        callback: response => {
          if (signal.aborted || !active) return;
          if (response?.error || !response?.access_token) return finish(failure('AUTH_DENIED', 'Google への接続が許可されませんでした。'));
          const scopes = typeof response.scope === 'string' ? response.scope.trim().split(/\s+/) : [];
          if (!scopes.includes(DRIVE_SCOPE) || scopes.some(scope => scope !== DRIVE_SCOPE) ||
            (typeof oauth.hasGrantedAllScopes === 'function' && !oauth.hasGrantedAllScopes(response, DRIVE_SCOPE))) {
            return finish(failure('SCOPE_REQUIRED', 'このアプリで選んだファイルへのアクセスだけを許可してください。'));
          }
          const seconds = Number(response.expires_in);
          if (!Number.isFinite(seconds) || seconds <= 0 || typeof response.access_token !== 'string' || !response.access_token.trim() || /[\r\n]/.test(response.access_token) || response.token_type !== undefined && (typeof response.token_type !== 'string' || response.token_type.toLowerCase() !== 'bearer')) {
            return finish(failure('AUTH_RESPONSE', 'Google の接続情報を確認できませんでした。'));
          }
          token = response.access_token;
          expiresAt = now() + Math.min(seconds * 1000, 24 * 60 * 60 * 1000);
          config = nextConfig;
          expiryTimer = setTimer(() => disconnect('expired'), Math.max(1, expiresAt - now()));
          expiryTimer?.unref?.();
          finish(null, { expiresAt });
        },
        error_callback: error => finish(failure(error?.type === 'popup_closed' ? 'POPUP_CLOSED' : error?.type === 'popup_failed_to_open' ? 'POPUP_BLOCKED' : 'AUTH_ERROR',
          error?.type === 'popup_closed' ? 'Google の接続画面が閉じられました。' : 'Google の接続画面を開けません。ポップアップの設定を確認してください。')),
      });
      client.requestAccessToken({ prompt: 'select_account' });
      return () => { active = false; };
    }, { signal, timeoutMs: options.authTimeoutMs ?? 120000, setTimer, clearTimer }, 'AUTH_TIMEOUT')
      .finally(() => { connecting = false; });
  }

  async function responseText(response, maximum, signal) {
    const advertised = response.headers?.get?.('content-length');
    if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > maximum)) {
      await response.body?.cancel?.();
      throw failure('TOO_LARGE', '保存データのサイズが上限を超えています。');
    }
    checkAbort(signal);
    if (!response.body?.getReader) {
      const text = await response.text();
      checkAbort(signal);
      if (encoder.encode(text).byteLength > maximum) throw failure('TOO_LARGE', '保存データのサイズが上限を超えています。');
      return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '', bytes = 0;
    try {
      while (true) {
        checkAbort(signal);
        const { done, value } = await reader.read();
        checkAbort(signal);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maximum) throw failure('TOO_LARGE', '保存データのサイズが上限を超えています。');
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof GoogleDriveError) throw error;
      throw failure('NETWORK', 'Google Drive からデータを読み込めませんでした。接続を確認してください。');
    } finally { reader.releaseLock(); }
  }
  function pause(ms, signal) {
    if (options.sleep) return options.sleep(ms, signal).then(() => checkAbort(signal));
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(aborted());
      const timer = setTimer(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimer(timer); signal.removeEventListener('abort', onAbort); reject(aborted()); };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  async function request(url, { signal, method = 'GET', body, headers = {}, text = false, maximum = 2 * 1024 * 1024, beforeAttempt } = {}) {
    // URLs are constructed only within this module. Tokens are never query parameters.
    for (let attempt = 0; ; attempt++) {
      checkAbort(signal);
      if (beforeAttempt) await beforeAttempt();
      checkAbort(signal);
      requireConnected();
      const attemptController = new AbortController();
      const onAbort = () => attemptController.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
      const timer = setTimer(() => { timedOut = true; attemptController.abort(); }, options.requestTimeoutMs ?? 30000);
      timer?.unref?.();
      let response, content;
      try {
        response = await fetchImpl(url, { method, body, headers: { ...headers, Authorization: `Bearer ${token}` },
          signal: attemptController.signal, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
        checkAbort(signal);
        if (response.status === 401) {
          disconnect('unauthorized');
          throw failure('UNAUTHORIZED', 'Google の接続が期限切れです。接続し直してください。', 401);
        }
        content = await responseText(response, response.ok ? maximum : 65536, attemptController.signal);
        checkAbort(signal);
      } catch (error) {
        if (error instanceof GoogleDriveError && error.code === 'UNAUTHORIZED') throw error;
        if (signal.aborted) throw aborted();
        if (timedOut) throw failure('NETWORK_TIMEOUT', 'Google Drive との通信がタイムアウトしました。');
        if (error instanceof GoogleDriveError) throw error;
        throw failure('NETWORK', 'Google Drive に接続できません。ネットワークを確認してください。');
      } finally {
        clearTimer(timer);
        signal.removeEventListener('abort', onAbort);
      }
      let payload;
      if (!text || !response.ok) { try { payload = JSON.parse(content); } catch { payload = null; } }
      if (response.ok) {
        if (text) return content;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure('INVALID_RESPONSE', 'Google Drive の応答を確認できませんでした。');
        return payload;
      }
      const reasons = payload?.error?.errors?.map?.(entry => entry.reason) ?? [];
      const transient = response.status === 429 || response.status >= 500 && response.status <= 599 ||
        response.status === 403 && reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason));
      if (transient && attempt < maxRetries) {
        const retryAfter = response.headers?.get?.('retry-after');
        const seconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : 0;
        await pause(Math.min(30000, Math.max(seconds * 1000, 500 * 2 ** attempt + Math.floor(random() * 250))), signal);
        continue;
      }
      throw failure(response.status === 409 ? 'CONFLICT' : transient ? 'RATE_LIMIT' : response.status === 403 ? 'FORBIDDEN' : response.status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR',
        response.status === 403 ? 'Google Drive へのアクセスを確認してください。' : 'Google Drive の操作を完了できませんでした。もう一度お試しください。', response.status);
    }
  }
  function url(path, parameters = {}) {
    const value = new URL(`${DRIVE_BASE}/${path}`);
    for (const [key, entry] of Object.entries(parameters)) if (entry !== undefined && entry !== '') value.searchParams.set(key, entry);
    return value.toString();
  }
  async function checkFolderMetadata(id, selected) {
    const signal = requireConnected();
    if (id !== EXPECTED_FOLDER_ID) throw failure('WRONG_FOLDER', '指定された保存先フォルダを選んでください。');
    // A stored ID is not a substitute for a Picker selection in this connection.
    if (!selected && folder?.id !== id) throw failure('FOLDER_REQUIRED', 'Google の選択画面で保存先フォルダを選んでください。');
    const metadata = await request(url(`files/${id}`, { fields: 'id,name,mimeType,ownedByMe,shared,trashed,capabilities(canAddChildren)' }), { signal });
    if (metadata.id !== EXPECTED_FOLDER_ID || metadata.mimeType !== FOLDER_MIME || metadata.ownedByMe !== true ||
      metadata.shared !== false || metadata.trashed !== false || metadata.capabilities?.canAddChildren !== true) {
      folder = null;
      throw failure('FOLDER_INVALID', '自分だけがアクセスできる、書き込み可能な指定フォルダを選んでください。');
    }
    checkAbort(signal);
    folder = Object.freeze({ ...metadata });
    return folder;
  }
  function verifyFolder(id = EXPECTED_FOLDER_ID) { return checkFolderMetadata(id, false); }
  function selectFolder(input) {
    const signal = requireConnected();
    if (input) {
      const given = validateGoogleConfig(input);
      if (given.clientId !== config.clientId || given.apiKey !== config.apiKey) throw failure('CONFIG_CHANGED', '設定を変更した場合は Google Drive に接続し直してください。');
    }
    if (picking) return Promise.reject(failure('BUSY', 'フォルダの選択中です。'));
    picking = true;
    return withCallback(finish => {
      const picker = win.google.picker;
      const view = new picker.DocsView(picker.ViewId.FOLDERS)
        .setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes(FOLDER_MIME).setMode(picker.DocsViewMode.LIST);
      const builder = new picker.PickerBuilder().addView(view).setOAuthToken(token).setDeveloperKey(config.apiKey)
        .setAppId(config.projectNumber).setOrigin(win.location.origin).setCallback(data => {
          const action = data?.[picker.Response.ACTION];
          if (action === picker.Action.CANCEL) return finish(failure('PICKER_CANCELLED', 'フォルダの選択をキャンセルしました。'));
          if (action !== picker.Action.PICKED) return;
          const docs = data[picker.Response.DOCUMENTS];
          const id = docs?.length === 1 ? docs[0][picker.Document.ID] : null;
          if (id !== EXPECTED_FOLDER_ID) return finish(failure('WRONG_FOLDER', '指定された保存先フォルダを選んでください。'));
          finish(null, id);
        });
      const dialog = builder.build();
      dialog.setVisible(true);
      return () => { dialog.setVisible(false); dialog.dispose?.(); };
    }, { signal, timeoutMs: options.pickerTimeoutMs ?? 180000, setTimer, clearTimer }, 'PICKER_TIMEOUT')
      .then(id => { checkAbort(signal); return checkFolderMetadata(id, true); })
      .finally(() => { picking = false; });
  }
  function snapshotMetadata(value, expectedId) {
    if (!value || !validId(value.id) || expectedId && value.id !== expectedId || value.mimeType !== 'application/json' ||
      value.trashed !== false || value.ownedByMe !== true || !value.parents?.includes(EXPECTED_FOLDER_ID) || value.appProperties?.myPaceSync !== 'my-pace-drive-v1') {
      throw failure('SNAPSHOT_INVALID', '同期ファイルの情報を確認できませんでした。');
    }
    if (typeof value.size !== 'string' || !/^\d+$/.test(value.size) || !Number.isSafeInteger(Number(value.size)) ||
      Number(value.size) < 1 || Number(value.size) > MAX_SNAPSHOT_BYTES) throw failure('TOO_LARGE', '同期ファイルのサイズが不明か、上限を超えています。');
    return value;
  }
  async function listSnapshots(folderId = EXPECTED_FOLDER_ID) {
    const signal = requireFolder(folderId);
    const result = [], seenPages = new Set(), seenIds = new Set();
    let pageToken;
    do {
      const payload = await request(url('files', { q: `'${folderId}' in parents and trashed = false and mimeType = 'application/json' and appProperties has { key='myPaceSync' and value='my-pace-drive-v1' }`,
        spaces: 'drive', corpora: 'user', pageSize: '100', fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`, pageToken }), { signal });
      if (!Array.isArray(payload.files) || payload.incompleteSearch === true) throw failure('INCOMPLETE_LIST', '同期ファイルの一覧を完全に取得できませんでした。');
      for (const value of payload.files) {
        snapshotMetadata(value);
        if (seenIds.has(value.id)) continue;
        if (result.length >= 10000) throw failure('TOO_MANY_FILES', '同期ファイルが多すぎます。');
        seenIds.add(value.id); result.push(value);
      }
      pageToken = payload.nextPageToken;
      if (pageToken !== undefined && (typeof pageToken !== 'string' || !pageToken || seenPages.has(pageToken) || seenPages.size >= 1000)) {
        throw failure('INVALID_PAGINATION', '同期ファイルの一覧を完全に取得できませんでした。');
      }
      if (pageToken) seenPages.add(pageToken);
    } while (pageToken);
    return result;
  }
  async function getSnapshotMetadata(id, signal) {
    if (!validId(id)) throw failure('SNAPSHOT_INVALID', '同期ファイルの ID が正しくありません。');
    return snapshotMetadata(await request(url(`files/${id}`, { fields: FILE_FIELDS }), { signal }), id);
  }
  async function readWithMetadata(metadata, signal) {
    const text = await request(url(`files/${metadata.id}`, { alt: 'media' }), { signal, text: true, maximum: MAX_SNAPSHOT_BYTES });
    if (encoder.encode(text).byteLength !== Number(metadata.size)) throw failure('SNAPSHOT_CHANGED', '読み込み中に同期ファイルが変更されました。もう一度お試しください。');
    return text;
  }
  async function readSnapshot(id) {
    const signal = requireFolder();
    return readWithMetadata(await getSnapshotMetadata(id, signal), signal);
  }
  async function generateId() {
    const signal = requireFolder();
    const payload = await request(url('files/generateIds', { count: '1', space: 'drive', type: 'files' }), { signal });
    if (payload.ids?.length !== 1 || !validId(payload.ids[0])) throw failure('INVALID_RESPONSE', 'Google Drive のファイル ID を取得できませんでした。');
    return payload.ids[0];
  }
  async function createSnapshot({ id, folderId, name, text, appProperties } = {}) {
    const signal = requireFolder(folderId);
    if (folderId !== EXPECTED_FOLDER_ID || !validId(id) || typeof name !== 'string' || !name.endsWith('.json') || name.length > 200 || /[\r\n]/.test(name) ||
      typeof text !== 'string' || !text.length || encoder.encode(text).byteLength > MAX_SNAPSHOT_BYTES) throw failure('SNAPSHOT_INVALID', '同期データの形式またはサイズが正しくありません。');
    if (encoder.encode(text).byteLength > MAX_UPLOAD_BYTES) throw failure('UPLOAD_TOO_LARGE', 'クラウド同期の上限は 5 MB（5,000,000 バイト）です。JSON バックアップを保存してください。');
    if (appProperties != null && (typeof appProperties !== 'object' || Array.isArray(appProperties) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(appProperties)))) throw failure('SNAPSHOT_INVALID', '同期ファイルの属性が正しくありません。');
    const properties = { ...appProperties, ...SNAPSHOT_MARKER };
    if (Object.keys(properties).length > 30 || Object.entries(properties).some(([key, value]) =>
      !/^[A-Za-z0-9_-]{1,80}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || typeof value !== 'string' || encoder.encode(key + value).byteLength > 124)) {
      throw failure('SNAPSHOT_INVALID', '同期ファイルの属性が正しくありません。');
    }
    const metadata = { id, name, mimeType: 'application/json', parents: [folderId], appProperties: properties };
    const boundary = `mypace_${globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? `${now()}_${Math.floor(random() * 1e15)}`}`;
    if (text.includes(boundary)) throw failure('SNAPSHOT_INVALID', '同期データを準備できませんでした。もう一度お試しください。');
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
    const upload = new URL(UPLOAD_BASE);
    upload.searchParams.set('uploadType', 'multipart'); upload.searchParams.set('fields', FILE_FIELDS);
    try {
      return snapshotMetadata(await request(upload.toString(), { signal, method: 'POST', body,
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        // Sharing/capabilities can change after selection or during retry backoff.
        beforeAttempt: async () => { await checkFolderMetadata(folderId, false); checkAbort(signal); } }), id);
    } catch (error) {
      if (error.code !== 'CONFLICT') throw error;
      const existing = await getSnapshotMetadata(id, signal);
      if (existing.name !== name || Object.keys(existing.appProperties).length !== Object.keys(properties).length || Object.entries(properties).some(([key, value]) => existing.appProperties[key] !== value) ||
        await readWithMetadata(existing, signal) !== text) throw failure('CONTENT_CONFLICT', '同じ ID の保存データが一致しません。既存ファイルは変更していません。', 409);
      return existing;
    }
  }
  return Object.freeze({ prepare, loadGoogle: prepare, isPrepared, connect, isConnected, disconnect, selectFolder,
    verifyFolder, listSnapshots, readSnapshot, generateId, createSnapshot,
    get connected() { return isConnected(); }, get expiresAt() { return isConnected() ? expiresAt : 0; } });
}
