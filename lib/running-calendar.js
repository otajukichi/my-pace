import { localDate } from './state.js';

const DAY = 86400000;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export const DISTANCE_LEVELS = [0, 2000, 4000, 6000];
const iso = date => date.toISOString().slice(0, 10);
function parseDate(value) {
  if (typeof value !== 'string' || !datePattern.test(value)) throw new TypeError('Invalid calendar date');
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(+date) || iso(date) !== value) throw new RangeError('Invalid calendar date');
  return date;
}
export function shiftMonth(month, amount) {
  const date = parseDate(`${month}-01`);
  if (!Number.isInteger(amount)) throw new TypeError('Month shift must be an integer');
  date.setUTCMonth(date.getUTCMonth() + amount);
  return iso(date).slice(0, 7);
}
export function shiftDay(day, amount) {
  if (!Number.isInteger(amount)) throw new TypeError('Day shift must be an integer');
  return iso(new Date(+parseDate(day) + amount * DAY));
}
export function dayInMonth(day, month, today = localDate()) {
  const last = shiftDay(`${shiftMonth(month, 1)}-01`, -1);
  const chosen = `${month}-${String(Math.min(Number(day?.slice(8)) || 1, Number(last.slice(8)))).padStart(2, '0')}`;
  parseDate(chosen);
  return chosen > today ? today : chosen;
}
export function distanceLevel(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return 0;
  return 1 + DISTANCE_LEVELS.slice(1).filter(limit => meters >= limit).length;
}
export function indexRunDays(runs, today = localDate()) {
  parseDate(today);
  const days = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    try { parseDate(run?.date); } catch { continue; }
    const { distanceMeters, durationSeconds } = run.summary ?? {};
    if (run.date > today || !Number.isFinite(distanceMeters) || distanceMeters <= 0
      || !Number.isFinite(durationSeconds) || durationSeconds < 0) continue;
    let day = days.get(run.date);
    if (!day) days.set(run.date, day = { date: run.date, runs: [], distanceMeters: 0, durationSeconds: 0 });
    day.runs.push(run); day.distanceMeters += distanceMeters; day.durationSeconds += durationSeconds;
  }
  for (const day of days.values()) {
    day.paceSecondsPerKm = day.durationSeconds / (day.distanceMeters / 1000);
    day.level = distanceLevel(day.distanceMeters);
  }
  return new Map([...days].sort(([a], [b]) => a.localeCompare(b)));
}
export function monthSummary(days, month) {
  parseDate(`${month}-01`);
  const selected = [...days.values()].filter(day => day.date.startsWith(month));
  const distanceMeters = selected.reduce((sum, day) => sum + day.distanceMeters, 0);
  const durationSeconds = selected.reduce((sum, day) => sum + day.durationSeconds, 0);
  return { month, days: selected, dayCount: selected.length,
    runCount: selected.reduce((sum, day) => sum + day.runs.length, 0), distanceMeters, durationSeconds,
    paceSecondsPerKm: distanceMeters ? durationSeconds / (distanceMeters / 1000) : null,
    longest: selected.reduce((best, day) => !best || day.distanceMeters > best.distanceMeters ? day : best, null) };
}
/** Monday-to-Sunday columns. Empty means no imported record, never a failed day. */
export function calendarWindow(days, month, { months = 3, today = localDate() } = {}) {
  parseDate(today);
  if (![2, 3, 6, 12].includes(months)) throw new RangeError('Unsupported calendar window');
  const first = `${shiftMonth(month, 1 - months)}-01`;
  const last = iso(new Date(+parseDate(`${shiftMonth(month, 1)}-01`) - DAY));
  const firstDate = parseDate(first), offset = (firstDate.getUTCDay() + 6) % 7;
  const start = new Date(+firstDate - offset * DAY);
  const weeks = Math.ceil((+parseDate(last) - +start + DAY) / (7 * DAY));
  const cells = Array.from({ length: weeks * 7 }, (_, index) => {
    const date = iso(new Date(+start + index * DAY));
    return { date, week: Math.floor(index / 7), weekday: index % 7, day: days.get(date) ?? null,
      outside: date < first || date > last, future: date > today, inMonth: date.startsWith(month) };
  });
  const labels = Array.from({ length: months }, (_, index) => {
    const value = shiftMonth(first.slice(0, 7), index);
    return { month: value, column: Math.floor((+parseDate(`${value}-01`) - +start) / (7 * DAY)), label: `${Number(value.slice(5))}月` };
  });
  return { first, last, weeks, cells, labels };
}
export function initialRunningMonth(days, today = localDate()) {
  return [...days.keys()].at(-1)?.slice(0, 7) ?? today.slice(0, 7);
}
