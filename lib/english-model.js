/** English-only metadata and browser-local practice records. No Drive/network access. */
export const ENGLISH_STORAGE_KEY = 'mypace.english.v1';
const MAX_MATERIALS = 5000;
const MAX_RECORDS = 10000;
const MAX_CATALOG_TEXT = 3000000;
const MAX_STATE_TEXT = 6000000;
const MATERIAL_ID = /^[a-z][a-z0-9-]{0,79}$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const FORMATS = ['phrases', 'dialogue', 'speech', 'article', 'research'];
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export const ENGLISH_AREAS = freeze([
  { id: 'people', label: '初対面・人間関係', english: 'People', short: '人との出会い', description: '初めての挨拶から、少し親しくなる会話まで。' },
  { id: 'daily', label: '日常・近況', english: 'Everyday', short: 'いつもの日々', description: '今日のこと、最近のことを自分の言葉で。' },
  { id: 'culture', label: '趣味・文化', english: 'Culture', short: '好きなこと', description: '好きな作品や、気になっていることを持ち寄る。' },
  { id: 'services', label: '暮らし・サービス', english: 'Around town', short: '街の暮らし', description: '注文や買い物など、暮らしの中のやりとり。' },
  { id: 'travel', label: '旅行・移動', english: 'Travel', short: '旅の途中', description: '知らない街で、尋ねたり伝えたりする。' },
  { id: 'ideas', label: '意見・議論', english: 'Ideas', short: '考えを交わす', description: '違う視点に出会い、自分の考えを伝える。' },
  { id: 'problems', label: '問題・相談', english: 'Work it out', short: '一緒に考える', description: '困りごとを言葉にして、解決を探す。' },
  { id: 'work', label: '仕事・研究', english: 'Work & research', short: '仕事と研究', description: '取り組んでいることや、新しい発見を話す。' },
]);
const AREA_IDS = ENGLISH_AREAS.map(area => area.id);

/** Access conditions describe experiences, never an assessment of English ability. */
export const ENGLISH_MODES = freeze([
  { id: 'scene', label: 'シーン会話', description: '場面とヒントを手がかりに。', requirements: { sessions: 0, themes: 0, areas: 0 } },
  { id: 'topic', label: 'テーマ会話', description: 'テーマから、自分の言葉で。', requirements: { sessions: 3, themes: 3, areas: 1 } },
  { id: 'free', label: 'フリートーク', description: '英語で、会話の向くほうへ。', requirements: { sessions: 8, themes: 5, areas: 3 } },
]);

const themes = [
  ['people', 'first-hello', 'はじめまして', '初対面の相手と挨拶を交わす。', 5],
  ['people', 'getting-acquainted', 'もう少し、あなたのこと', '会ったばかりの相手と共通点を探す。', 8],
  ['people', 'make-plans', 'また会う約束', '一緒に過ごす予定を相談する。', 8],
  ['daily', 'weekend-stories', '週末どうだった？', '最近の出来事を気軽に話す。', 5],
  ['daily', 'ordinary-day', 'いつもの一日', '普段の暮らしについて話す。', 5],
  ['daily', 'small-discovery', 'ちいさな発見', '最近気づいたことを伝える。', 8],
  ['culture', 'favorite-film', '好きな映画の話', '印象に残った作品について話す。', 8],
  ['culture', 'music-to-share', 'この曲、聴いてみて', '好きな音楽を紹介する。', 5],
  ['culture', 'new-hobby', 'やってみたいこと', '気になる趣味について話す。', 8],
  ['services', 'cafe-order', 'カフェでひと息', '飲み物や食べ物を注文する。', 5],
  ['services', 'find-a-gift', '贈り物を選ぶ', 'お店で希望を伝えて相談する。', 8],
  ['services', 'make-booking', '予約をお願いしたい', '日時や希望を伝えて予約する。', 5],
  ['travel', 'hotel-checkin', '旅先のチェックイン', '宿泊先で必要なことを確認する。', 5],
  ['travel', 'ask-directions', 'あの場所へ行きたい', '道順や移動の方法を尋ねる。', 5],
  ['travel', 'local-recommendation', 'この街のおすすめ', 'その街ならではの場所を聞く。', 8],
  ['ideas', 'different-view', '違う見方もある', '身近な話題について意見を交換する。', 10],
  ['ideas', 'a-better-city', 'こんな街だったら', '暮らしやすい街について考える。', 10],
  ['ideas', 'choose-together', 'どちらにしよう？', '選択肢の良さを比べて考える。', 8],
  ['problems', 'ask-for-help', 'ちょっと助けてほしい', '困っていることを説明する。', 5],
  ['problems', 'change-plans', '予定が変わったら', '事情を伝えて別の案を相談する。', 8],
  ['problems', 'think-it-through', '一緒に整理する', '悩みを整理して次の一歩を考える。', 10],
  ['work', 'explain-research', '研究の話をしよう', '取り組んでいることを紹介する。', 10],
  ['work', 'project-update', 'いま、ここまで進んだ', '作業の進み具合や気づきを伝える。', 8],
  ['work', 'ask-a-question', 'その発見が気になる', '説明を聞いて質問をする。', 10],
];

export const DEFAULT_CATALOG = freeze({
  schema: 1,
  sample: true,
  materials: [
    ...themes.map(([areaId, id, title, description, durationMinutes]) => ({ id, kind: 'conversation', areaId, title, description, durationMinutes })),
    { id: 'reading-phrases', kind: 'reading', areaId: null, title: 'ひと息のフレーズ', description: '短い表現を声に出す。', durationMinutes: 3, format: 'phrases' },
    { id: 'reading-dialogue', kind: 'reading', areaId: null, title: '二人の会話', description: '会話文を声に出す。', durationMinutes: 5, format: 'dialogue' },
    { id: 'reading-speech', kind: 'reading', areaId: null, title: '短いスピーチ', description: 'まとまった話を声に出す。', durationMinutes: 5, format: 'speech' },
    { id: 'reading-article', kind: 'reading', areaId: null, title: 'ひとつの記事', description: '少し長い文章を声に出す。', durationMinutes: 8, format: 'article' },
    { id: 'reading-research', kind: 'reading', areaId: null, title: '研究を伝える', description: '研究発表の文章を声に出す。', durationMinutes: 10, format: 'research' },
  ],
});

export class EnglishValidationError extends Error {
  constructor(message) { super(message); this.name = 'EnglishValidationError'; this.code = 'INVALID_ENGLISH_DATA'; }
}
export class EnglishStorageError extends Error {
  constructor(message) { super(message); this.name = 'EnglishStorageError'; this.code = 'ENGLISH_STORAGE_UNAVAILABLE'; }
}
function invalid(path) { throw new EnglishValidationError(`英会話データの形式を確認してください: ${path}`); }
function object(value, path, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(path);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || FORBIDDEN.has(key) || !allowed.includes(key)) invalid(`${path}.${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid(`${path}.${key}`);
  }
  if (required.some(key => !Object.hasOwn(value, key))) invalid(path);
}
function string(value, path, max, min = 1) {
  if (typeof value !== 'string' || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid(path);
}
function array(value, path, max) {
  if (!Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) invalid(path);
}
function instant(value, path) {
  string(value, path, 24, 24);
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(path);
}
function sessionId(value) { if (typeof value !== 'string' || !SESSION_ID.test(value)) invalid('sessionId'); }
function materialId(value) { if (typeof value !== 'string' || !MATERIAL_ID.test(value) || FORBIDDEN.has(value)) invalid('materialId'); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function parseBounded(text, max) {
  if (typeof text !== 'string' || text.length > max) invalid('JSON size');
  try { return JSON.parse(text); } catch { invalid('JSON'); }
}

export function normalizeFolderId(value) {
  if (typeof value !== 'string') invalid('folderId');
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (DRIVE_ID.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,200})\/?$/);
    if (url.protocol === 'https:' && url.hostname === 'drive.google.com' && !url.username && !url.password && !url.port && match) return match[1];
  } catch { /* A malformed URL is reported without exposing it. */ }
  invalid('folderId');
}

/** Metadata only: arbitrary scenario, character, transcript or instruction fields are rejected. */
export function validateCatalog(input) {
  const catalog = typeof input === 'string' ? parseBounded(input, MAX_CATALOG_TEXT) : input;
  object(catalog, 'catalog', ['schema', 'sample', 'materials'], ['schema', 'materials']);
  if (catalog.schema !== 1 || (Object.hasOwn(catalog, 'sample') && typeof catalog.sample !== 'boolean')) invalid('catalog.schema');
  array(catalog.materials, 'materials', MAX_MATERIALS);
  const ids = new Set();
  for (const material of catalog.materials) {
    object(material, 'material', ['id', 'kind', 'areaId', 'title', 'description', 'durationMinutes', 'format', 'fileId'], ['id', 'kind', 'areaId', 'title', 'description', 'durationMinutes']);
    materialId(material.id);
    if (ids.has(material.id)) invalid('duplicate materialId');
    ids.add(material.id);
    if (material.kind === 'conversation') {
      if (!AREA_IDS.includes(material.areaId) || Object.hasOwn(material, 'format')) invalid('conversation area/format');
    } else if (material.kind === 'reading') {
      if (material.areaId !== null || (Object.hasOwn(material, 'format') && !FORMATS.includes(material.format))) invalid('reading area/format');
    } else invalid('kind');
    string(material.title, 'title', 80);
    string(material.description, 'description', 200, 0);
    if (!Number.isInteger(material.durationMinutes) || material.durationMinutes < 1 || material.durationMinutes > 60) invalid('durationMinutes');
    if (Object.hasOwn(material, 'fileId') && (typeof material.fileId !== 'string' || !DRIVE_ID.test(material.fileId))) invalid('fileId');
  }
  if (JSON.stringify(catalog).length > MAX_CATALOG_TEXT) invalid('catalog size');
  return { schema: 1, sample: catalog.sample ?? false, materials: copy(catalog.materials) };
}

export function activeCatalog(state) { return state.catalog || DEFAULT_CATALOG; }

export function validatePracticeRecord(value, { catalog, requireOrigin = false } = {}) {
  const required = ['schema', 'sessionId', 'performedAt', 'kind', 'areaId', 'themeId', 'modeId'];
  object(value, 'practice', [...required, 'origin'], requireOrigin ? [...required, 'origin'] : required);
  if (value.schema !== 1) invalid('practice.schema');
  sessionId(value.sessionId);
  instant(value.performedAt, 'performedAt');
  materialId(value.themeId);
  if (value.kind === 'conversation') {
    if (!AREA_IDS.includes(value.areaId) || !['scene', 'topic', 'free'].includes(value.modeId)) invalid('practice area/mode');
  } else if (value.kind === 'reading') {
    if (value.areaId !== null || value.modeId !== 'reading') invalid('reading area/mode');
  } else invalid('practice.kind');
  if (Object.hasOwn(value, 'origin') && !['manual', 'connector'].includes(value.origin)) invalid('practice.origin');
  if (catalog) {
    const material = catalog.materials.find(item => item.id === value.themeId);
    if (!material || material.kind !== value.kind || material.areaId !== value.areaId) invalid('practice material reference');
  }
  return copy(value);
}

function sameRecord(left, right) {
  return ['schema', 'sessionId', 'performedAt', 'kind', 'areaId', 'themeId', 'modeId', 'origin'].every(key => left[key] === right[key]);
}
function uniqueRecords(values, { requireOrigin = false, merging = false } = {}) {
  array(values, 'records', merging ? MAX_RECORDS * 2 : MAX_RECORDS);
  const found = new Map();
  for (const value of values) {
    const record = validatePracticeRecord(value, { requireOrigin });
    const previous = found.get(record.sessionId);
    if (previous && !sameRecord(previous, record)) invalid('conflicting sessionId');
    found.set(record.sessionId, record);
    if (found.size > MAX_RECORDS) invalid('record limit');
  }
  return [...found.values()];
}

function localDay(iso) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function progressFor(records, modes = ENGLISH_MODES) {
  const completed = uniqueRecords(records);
  const conversations = completed.filter(record => record.kind === 'conversation');
  const reading = completed.filter(record => record.kind === 'reading');
  const themeIds = [...new Set(conversations.map(record => record.themeId))];
  const areaIds = [...new Set(conversations.map(record => record.areaId))];
  const practiceDays = [...new Set(completed.map(record => localDay(record.performedAt)))].sort();
  const counts = { sessions: conversations.length, themes: themeIds.length, areas: areaIds.length };
  array(modes, 'modes', 20);
  const modeIds = new Set();
  const modeProgress = modes.map(mode => {
    object(mode, 'mode', ['id', 'label', 'description', 'requirements']);
    materialId(mode.id);
    if (modeIds.has(mode.id)) invalid('duplicate mode');
    modeIds.add(mode.id);
    string(mode.label, 'mode.label', 80);
    string(mode.description, 'mode.description', 200, 0);
    object(mode.requirements, 'requirements', ['sessions', 'themes', 'areas']);
    const remaining = {};
    for (const key of ['sessions', 'themes', 'areas']) {
      if (!Number.isInteger(mode.requirements[key]) || mode.requirements[key] < 0 || mode.requirements[key] > MAX_RECORDS) invalid('requirements');
      remaining[key] = Math.max(0, mode.requirements[key] - counts[key]);
    }
    return { ...copy(mode), unlocked: Object.values(remaining).every(value => value === 0), remaining };
  });
  const perArea = Object.fromEntries(AREA_IDS.map(id => {
    const entries = conversations.filter(record => record.areaId === id);
    const themes = [...new Set(entries.map(record => record.themeId))];
    return [id, { sessions: entries.length, themeIds: themes, distinctThemes: themes.length }];
  }));
  return {
    totalSessions: completed.length, conversationSessions: conversations.length, readingSessions: reading.length,
    practiceDays, distinctDays: practiceDays.length, themeIds, areaIds, distinctThemes: themeIds.length, distinctAreas: areaIds.length,
    readingThemeIds: [...new Set(reading.map(record => record.themeId))],
    unlockedModes: modeProgress.filter(mode => mode.unlocked).map(mode => mode.id), modes: modeProgress, perArea,
  };
}

export function modeAvailable(mode, records, modes = ENGLISH_MODES) {
  return mode === 'reading' || progressFor(records, modes).unlockedModes.includes(mode);
}

function validatePending(value) {
  object(value, 'pending', ['sessionId', 'startedAt', 'materialId', 'kind', 'areaId', 'modeId']);
  validatePracticeRecord({ schema: 1, sessionId: value.sessionId, performedAt: value.startedAt, kind: value.kind, areaId: value.areaId, themeId: value.materialId, modeId: value.modeId });
}

/** References and mode guidance only. Never includes scenario content or previous conversations. */
export function buildStartText({ session, material, folderId }) {
  validatePending(session);
  validateCatalog({ schema: 1, materials: [material] });
  const folder = normalizeFolderId(folderId);
  if (!folder) throw new EnglishValidationError('教材フォルダを設定してください。');
  if (session.materialId !== material.id || session.kind !== material.kind || session.areaId !== material.areaId) invalid('session material reference');
  const mode = {
    scene: 'シーン会話。まず日本語で状況と使える表現を簡潔に案内し、必要に応じてヒントをください。',
    topic: 'テーマ会話。決まった模範解答を求めず、私の返答に沿って会話を進め、日本語の補助は必要なときにお願いします。',
    free: 'フリートーク。導入・説明から原則英語で、台本をなぞらず自然に会話してください。',
    reading: '音読。教材の文章を使い、声に出して読む練習を案内してください。会話モードの解放条件は関係ありません。',
  }[session.modeId];
  return [
    `my-pace ${session.kind === 'reading' ? '音読' : '英会話'}セッション`,
    `セッションID: ${session.sessionId}`,
    `Google Drive教材フォルダID: ${folder}`,
    `教材ID: ${material.id}`,
    ...(material.fileId ? [`教材ファイルID: ${material.fileId}`] : ['参照方法: 指定フォルダの catalog.json で教材IDを確認し、同じフォルダの {教材ID}.md を参照してください。']),
    `練習形態: ${mode}`,
    '',
    '接続済みGoogle Driveから、指定フォルダ内の指定教材だけを実際に読み込んでください。接続・権限・教材不足などで読めない場合は、その理由を伝えて止めてください。読めたふりや教材の代作はしないでください。',
    '教材の役柄・指示に従い、シナリオの展開や相手の発言は先に明かさず、準備ができたことだけ短く伝えてください。私が話しかけたら開始してください。',
    'この練習中は役柄を保ち、前回の会話を覚えているふりはしないでください。英語力の認定や音声の採点は不要です。',
    '記録連携が使えない場合は、記録を保存したとは言わないでください。終わったら私がmy-paceで実施済みにできます。',
  ].join('\n');
}

function defaults() { return { schema: 1, settings: { folderId: '' }, catalog: null, pending: null, records: [] }; }
function validateState(value) {
  object(value, 'state', ['schema', 'settings', 'catalog', 'pending', 'records']);
  if (value.schema !== 1) invalid('state.schema');
  object(value.settings, 'settings', ['folderId']);
  if (normalizeFolderId(value.settings.folderId) !== value.settings.folderId) invalid('settings.folderId');
  if (value.catalog !== null) validateCatalog(value.catalog);
  if (value.pending !== null) validatePending(value.pending);
  const records = uniqueRecords(value.records, { requireOrigin: true });
  if (records.length !== value.records.length) invalid('duplicate saved records');
  if (value.pending && records.some(record => record.sessionId === value.pending.sessionId)) invalid('completed pending session');
  return copy(value);
}

/** Writes are atomic: if browser storage fails, neither records nor progress claim a save. */
export function createEnglishStore(options = {}) {
  const now = options.now || (() => new Date());
  const uuid = options.uuid || (() => globalThis.crypto.randomUUID());
  let storage;
  let state = defaults();
  let savedSnapshot = null;
  let persistent = false;
  let readOnly = false;
  let error = null;
  const listeners = new Set();
  try {
    storage = options.storage === undefined ? globalThis.localStorage : options.storage;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new Error('unavailable');
    const raw = storage.getItem(ENGLISH_STORAGE_KEY);
    if (raw !== null) state = validateState(parseBounded(raw, MAX_STATE_TEXT));
    savedSnapshot = raw;
    persistent = true;
  } catch {
    readOnly = true;
    error = 'このブラウザの英会話データを読み込めません。保存済みデータを上書きせず、閲覧だけにしています。';
  }
  const get = () => copy(state);
  const status = () => ({ persistent, readOnly, error, scope: 'local' });
  const emit = () => { for (const listener of listeners) { try { listener(get(), status()); } catch { /* An observer must not turn a successful save into a reported failure. */ } } };
  const timestamp = () => {
    const value = now();
    const iso = (value instanceof Date ? value : new Date(value)).toISOString();
    instant(iso, 'now');
    return iso;
  };
  function assertCurrentSnapshot() {
    if (readOnly) throw new EnglishStorageError(error);
    let current;
    try { current = storage.getItem(ENGLISH_STORAGE_KEY); } catch {
      persistent = false;
      error = '保存済みの英会話データを確認できませんでした。変更は保存していません。ブラウザの設定を確認して、もう一度お試しください。';
      emit();
      throw new EnglishStorageError(error);
    }
    if (current !== savedSnapshot) {
      readOnly = true;
      persistent = false;
      error = '別の画面で英会話データが更新されました。新しい記録を上書きしないため、変更を保存していません。このページを開き直してください。';
      emit();
      throw new EnglishStorageError(error);
    }
  }
  function save(next) {
    const validated = validateState(next);
    const serialized = JSON.stringify(validated);
    if (serialized.length > MAX_STATE_TEXT) invalid('state size');
    // Recheck immediately before writing, including when an injected callback or
    // another store changed storage after the public operation's initial check.
    assertCurrentSnapshot();
    try { storage.setItem(ENGLISH_STORAGE_KEY, serialized); } catch {
      persistent = false;
      error = 'ブラウザに保存できませんでした。変更は記録されていません。空き容量やブラウザの設定を確認して、もう一度お試しください。';
      emit();
      throw new EnglishStorageError(error);
    }
    state = validated;
    savedSnapshot = serialized;
    persistent = true;
    error = null;
    emit();
  }
  return {
    get, status,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    configure(settings) {
      assertCurrentSnapshot();
      object(settings, 'settings', ['folderId']);
      save({ ...state, settings: { folderId: normalizeFolderId(settings.folderId) } });
      return get().settings;
    },
    setCatalog(input) {
      assertCurrentSnapshot();
      const catalog = validateCatalog(input);
      save({ ...state, catalog });
      return copy(catalog);
    },
    start({ materialId: id, mode }) {
      assertCurrentSnapshot();
      materialId(id);
      const material = activeCatalog(state).materials.find(item => item.id === id);
      if (!material) throw new EnglishValidationError('選択した教材が見つかりません。');
      const modeId = material.kind === 'reading' ? 'reading' : mode;
      if (!['scene', 'topic', 'free', 'reading'].includes(modeId) || (material.kind === 'conversation' && modeId === 'reading')) invalid('mode');
      if (!modeAvailable(modeId, state.records)) throw new EnglishValidationError('この練習形態はまだ解放されていません。');
      if (state.pending?.materialId === id && state.pending.modeId === modeId) return copy(state.pending);
      const pending = { sessionId: uuid(), startedAt: timestamp(), materialId: id, kind: material.kind, areaId: material.areaId, modeId };
      validatePending(pending);
      if (state.records.some(record => record.sessionId === pending.sessionId) || state.pending?.sessionId === pending.sessionId) throw new EnglishValidationError('セッションIDを新しく作れませんでした。もう一度お試しください。');
      save({ ...state, pending });
      return copy(pending);
    },
    complete(id) {
      assertCurrentSnapshot();
      sessionId(id);
      const completed = state.records.find(record => record.sessionId === id);
      if (completed) return copy(completed);
      const pending = state.pending;
      if (!pending || pending.sessionId !== id) throw new EnglishValidationError('記録する練習が見つかりません。');
      const record = { schema: 1, sessionId: id, performedAt: timestamp(), kind: pending.kind, areaId: pending.areaId, themeId: pending.materialId, modeId: pending.modeId, origin: 'manual' };
      save({ ...state, pending: null, records: [...state.records, record] });
      return copy(record);
    },
    cancel(id) {
      assertCurrentSnapshot();
      sessionId(id);
      if (!state.pending || state.pending.sessionId !== id) return false;
      save({ ...state, pending: null });
      return true;
    },
    exportJSON() {
      return JSON.stringify({ schema: 1, kind: 'mypace-english-history', records: state.records }, null, 2);
    },
    importJSON(text) {
      assertCurrentSnapshot();
      const imported = parseBounded(text, MAX_STATE_TEXT);
      object(imported, 'history', ['schema', 'kind', 'records']);
      if (imported.schema !== 1 || imported.kind !== 'mypace-english-history') invalid('history.schema');
      const records = uniqueRecords(imported.records, { requireOrigin: true });
      const merged = uniqueRecords([...state.records, ...records], { requireOrigin: true, merging: true });
      const added = merged.length - state.records.length;
      const pending = state.pending && merged.some(record => record.sessionId === state.pending.sessionId) ? null : state.pending;
      if (added || pending !== state.pending) save({ ...state, pending, records: merged });
      return { added, total: merged.length };
    },
  };
}
