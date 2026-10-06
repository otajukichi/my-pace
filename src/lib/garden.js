import { isDateKey, timeToMinutes, todayKey, GARDEN_PLANTS, GARDEN_THEMES } from './domain.js';

export { GARDEN_PLANTS, GARDEN_THEMES } from './domain.js';

export const GARDEN_STAGES = Object.freeze([
  Object.freeze({ id: 'seed', label: 'はじまりの種', at: 0 }),
  Object.freeze({ id: 'sprout', label: '小さな芽', at: 1 }),
  Object.freeze({ id: 'leaf', label: '葉がひらく', at: 3 }),
  Object.freeze({ id: 'bud', label: 'つぼみの時間', at: 7 }),
  Object.freeze({ id: 'bloom', label: '花がひらく', at: 14 }),
  Object.freeze({ id: 'garden', label: 'あなたの花園', at: 30 }),
]);

/**
 * A reward is a derived fact, never a balance incremented by a click.
 * One local calendar date earns at most one reward from a valid wake time,
 * a positive run, or a positive habit log. Diary and plans are intentionally excluded.
 * Historical archived habits still count; future records never do. Rest days never decay.
 */
export function rewardDates(state, anchor = todayKey()) {
  if (!isDateKey(anchor)) throw new Error('庭の基準日が正しくありません。');
  const dates = new Set();
  const eligible = (key) => isDateKey(key) && key <= anchor;
  for (const [key, value] of Object.entries(state.wake ?? {})) {
    if (!eligible(key)) continue;
    try { timeToMinutes(value); dates.add(key); } catch { /* Invalid unsaved values cannot earn. */ }
  }
  for (const run of state.runs ?? []) {
    if (eligible(run.date) && Number.isFinite(run.distanceKm) && run.distanceKm >= 0.001 && run.distanceKm <= 10000
      && Number.isInteger(run.durationSec) && run.durationSec >= 1 && run.durationSec <= 31 * 24 * 3600) dates.add(run.date);
  }
  for (const habit of state.habits ?? []) {
    for (const [key, value] of Object.entries(state.habitLogs?.[habit.id] ?? {})) {
      if (!eligible(key)) continue;
      const positive = habit.type === 'check' ? value === true
        : ['number', 'time'].includes(habit.type) && typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1000000;
      if (positive) dates.add(key);
    }
  }
  return [...dates].sort();
}

/** Pure summary suitable for rendering; deleting a record or undoing automatically recomputes growth. */
export function deriveGarden(state, anchor = todayKey()) {
  const dates = rewardDates(state, anchor), totalDays = dates.length;
  let index = 0;
  while (index + 1 < GARDEN_STAGES.length && totalDays >= GARDEN_STAGES[index + 1].at) index++;
  const stage = GARDEN_STAGES[index], nextAt = GARDEN_STAGES[index + 1]?.at ?? null;
  const unlockedPlants = GARDEN_PLANTS.filter((plant) => totalDays >= plant.unlockAt).map((plant) => plant.id);
  const selectedPlant = GARDEN_PLANTS.some((plant) => plant.id === state.garden?.plant) ? state.garden.plant : GARDEN_PLANTS[0].id;
  const currentPlant = unlockedPlants.includes(selectedPlant) ? selectedPlant : GARDEN_PLANTS[0].id;
  const theme = GARDEN_THEMES.some((item) => item.id === state.garden?.theme) ? state.garden.theme : GARDEN_THEMES[0].id;
  return { dates, totalDays, todayEarned: dates.includes(anchor), level: index + 1,
    stage: stage.id, stageLabel: stage.label, currentAt: stage.at, nextAt,
    progress: nextAt === null ? 1 : (totalDays - stage.at) / (nextAt - stage.at),
    daysToNext: nextAt === null ? 0 : nextAt - totalDays,
    unlockedPlants, selectedPlant, currentPlant, theme, lastEarnedDate: dates.at(-1) ?? null };
}

export const gardenProgress = deriveGarden;
