// Incremental CSV parser. No Node/Drive dependency; checkpoints belong to the host.
// Values never appear in errors because the input contains private locations.
export class CsvParser {
  constructor({ maxField = 65536, maxRow = 262144, maxColumns = 128 } = {}) {
    Object.assign(this, { maxField, maxRow, maxColumns });
    this.mode = 'start'; this.field = ''; this.fieldSize = 0; this.row = []; this.rowSize = 0;
    this.selectedColumns = null;
    this.first = true; this.cr = false;
  }
  write(text, emit, final = false) {
    const field = () => {
      this.row.push(this.field); this.field = ''; this.fieldSize = 0;
      if (this.row.length > this.maxColumns) throw Error('CSV_COLUMN_LIMIT');
    };
    const row = () => { field(); emit(this.row); this.row = []; this.rowSize = 0; this.mode = 'start'; };
    const append = c => {
      if (++this.fieldSize > this.maxField) throw Error('CSV_FIELD_LIMIT');
      if (!this.selectedColumns || this.selectedColumns.has(this.row.length)) this.field += c;
    };
    for (const c of text) {
      if (this.first) { this.first = false; if (c === '\uFEFF') continue; }
      if (this.cr) { this.cr = false; if (c === '\n') continue; }
      if (++this.rowSize > this.maxRow) throw Error('CSV_ROW_LIMIT');
      if (this.mode === 'quoted') {
        if (c === '"') this.mode = 'closed'; else append(c);
      } else if (this.mode === 'closed' && c === '"') {
        append(c); this.mode = 'quoted';
      } else {
        if (this.mode === 'closed' && ![',', '\n', '\r'].includes(c)) throw Error('CSV_AFTER_QUOTE');
        if (c === ',') { field(); this.mode = 'start'; }
        else if (c === '\n' || c === '\r') { row(); this.cr = c === '\r'; }
        else if (c === '"') {
          if (this.mode !== 'start') throw Error('CSV_BARE_QUOTE');
          this.mode = 'quoted';
        } else { append(c); this.mode = 'plain'; }
      }
    }
    if (final) {
      if (this.mode === 'quoted') throw Error('CSV_UNCLOSED_QUOTE');
      if (this.rowSize || this.row.length || this.field) row();
    }
  }
}

const numeric = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
function coordinate(text, limit) {
  if (typeof text !== 'string' || !numeric.test(text.trim())) return null;
  const value = Number(text);
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}
function timestamp(text) {
  // This input format records UTC. Relative/local clock formats need a separate
  // explicit importer: never guess a recording date from its filename.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text)) throw Error('CSV_UTC_TIME_REQUIRED');
  const value = Date.parse(text);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 19) !== text.slice(0, 19)) throw Error('CSV_TIME_INVALID');
  return value;
}

/** Drop inertial channels and repeated held GPS values before any geometry work.
 * Keep first observation time and final observation time of a held position.
 * Using the last repeated row as the previous fix would invent huge speeds.
 */
export class SensorGpsReader {
  constructor({ maxFixes = 200000, maxDurationSeconds = 172800, maxRowGapSeconds = 15 } = {}) {
    Object.assign(this, { maxFixes, maxDurationSeconds, maxRowGapSeconds });
    this.header = null; this.fixes = []; this.start = null; this.end = null;
    this.rows = 0; this.repeated = 0; this.invalidGps = 0; this.rowGaps = 0; this.broken = true;
  }
  row(row) {
    if (!row.length || row.length === 1 && !row[0].trim() || row[0].startsWith('#')) return;
    if (!this.header) {
      if (new Set(row).size !== row.length || !['time', 'latitude', 'longitude'].every(k => row.includes(k))) throw Error('CSV_UNSUPPORTED_HEADER');
      this.header = row; this.columns = ['time', 'latitude', 'longitude'].map(k => row.indexOf(k)); return;
    }
    if (row.length !== this.header.length) throw Error('CSV_COLUMN_COUNT');
    const [ti, lati, loni] = this.columns, t = timestamp(row[ti]);
    if (this.end !== null && t < this.end) throw Error('CSV_TIME_ORDER');
    if (this.start === null) this.start = t;
    if (t - this.start > this.maxDurationSeconds * 1000) throw Error('CSV_DURATION_LIMIT');
    if (this.end !== null && t - this.end > this.maxRowGapSeconds * 1000) { this.broken = true; this.rowGaps++; }
    this.end = t; this.rows++;
    const lat = coordinate(row[lati], 90), lon = coordinate(row[loni], 180);
    if (lat === null || lon === null) { this.invalidGps++; this.broken = true; return; }
    const previous = this.fixes.at(-1);
    if (!this.broken && previous && lat === previous.lat && lon === previous.lon) { previous.lastT = t; this.repeated++; return; }
    if (previous && t === previous.t && !this.broken) throw Error('CSV_CONFLICTING_SAME_TIME');
    this.fixes.push({ t, lastT: t, lat, lon, breakBefore: this.broken }); this.broken = false;
    if (this.fixes.length > this.maxFixes) throw Error('CSV_GPS_FIX_LIMIT');
  }
  finish() {
    if (!this.header || !this.rows) throw Error('CSV_EMPTY');
    return { start: this.start, end: this.end, fixes: this.fixes,
      counts: { rows: this.rows, gpsFixes: this.fixes.length, repeatedGpsRows: this.repeated, invalidGpsRows: this.invalidGps, rowGaps: this.rowGaps } };
  }
}
