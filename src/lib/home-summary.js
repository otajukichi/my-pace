import {isDateKey, recentDates} from './domain.js';

/** Read-only presentation of locally stored records, through the selected day.
 * A recorded habit value (including 0/false) is not necessarily a completion.
 * Historic targets are not stored, so only explicit check marks are counted.
 */
export function homeSummary(state, anchor) {
  const eligible = date => isDateKey(date) && date <= anchor;
  const days = new Map();
  const day = date => {
    if (!days.has(date)) days.set(date, {date, wake:null, runCount:0, distanceKm:0, habitEntries:0, habitChecked:0, habitMeasured:0, diary:false});
    return days.get(date);
  };
  for (const [date, time] of Object.entries(state.wake ?? {})) if (eligible(date)) day(date).wake = time;
  for (const run of state.runs ?? []) if (eligible(run.date)) {
    const entry = day(run.date);
    entry.runCount++;
    // Imported-file metadata is not a run and never supplies estimated distance.
    if (Number.isFinite(run.distanceKm)) entry.distanceKm += run.distanceKm;
  }
  for (const habit of state.habits ?? []) for (const [date, value] of Object.entries(state.habitLogs?.[habit.id] ?? {})) {
    if (!eligible(date)) continue;
    const entry = day(date);
    entry.habitEntries++;
    if (habit.type === 'check' && value === true) entry.habitChecked++;
    if (habit.type === 'number' || habit.type === 'time') entry.habitMeasured++;
  }
  for (const date of Object.keys(state.diary ?? {})) if (eligible(date)) day(date).diary = true;
  const history = [...days.values()].sort((a,b) => a.date.localeCompare(b.date));
  const total = history.reduce((sum, entry) => ({
    recordedDays:sum.recordedDays + 1,
    wakeDays:sum.wakeDays + Number(entry.wake !== null),
    runCount:sum.runCount + entry.runCount,
    distanceKm:sum.distanceKm + entry.distanceKm,
    habitEntries:sum.habitEntries + entry.habitEntries,
    habitDays:sum.habitDays + Number(entry.habitEntries > 0),
    habitChecked:sum.habitChecked + entry.habitChecked,
    habitMeasured:sum.habitMeasured + entry.habitMeasured,
    diaryDays:sum.diaryDays + Number(entry.diary),
  }), {recordedDays:0,wakeDays:0,runCount:0,distanceKm:0,habitEntries:0,habitDays:0,habitChecked:0,habitMeasured:0,diaryDays:0});
  return {anchor, ...total, latestWake:history.filter(entry => entry.wake !== null).at(-1) ?? null,
    week:recentDates(7, anchor).map(date => ({...(days.get(date) ?? {date,wake:null,runCount:0,distanceKm:0,habitEntries:0,habitChecked:0,habitMeasured:0,diary:false}), recorded:days.has(date)}))};
}
