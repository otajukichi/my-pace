import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, validateState, upsertWake, upsertHabitLog, upsertDiary, upsertEvent, addDays } from '../src/lib/domain.js';
import { deriveGarden, gardenProgress, rewardDates, GARDEN_STAGES, GARDEN_PLANTS } from '../src/lib/garden.js';

const today = '2026-10-06';
const run = (id, date = today) => ({ id, date, distanceKm: 2, durationSec: 900, note: '', points: [] });
const withHabits = () => ({ ...createInitialState(), habits: [
  { id: 'check', name: 'ストレッチ', type: 'check', unit: '', target: 1, archived: false },
  { id: 'number', name: '水を飲む', type: 'number', unit: '杯', target: 8, archived: false },
  { id: 'time', name: '読書', type: 'time', unit: '分', target: 30, archived: true },
] });
const withDays = (count) => {
  const state = createInitialState();
  for (let i = 0; i < count; i++) state.wake[addDays(today, -i)] = '07:00';
  return state;
};

test('empty garden is stable, starts at a seed, and earns nothing by rendering', () => {
  const state = createInitialState(), original = structuredClone(state);
  const garden = deriveGarden(state, today);
  assert.deepEqual(garden, { dates: [], totalDays: 0, todayEarned: false, level: 1, stage: 'seed', stageLabel: 'はじまりの種', currentAt: 0, nextAt: 1, progress: 0, daysToNext: 1, unlockedPlants: ['cosmos'], selectedPlant: 'cosmos', currentPlant: 'cosmos', theme: 'day', lastEarnedDate: null });
  for (let i = 0; i < 20; i++) assert.deepEqual(gardenProgress(state, today), garden);
  assert.deepEqual(state, original);
  assert.equal('rewards' in state.garden, false);
});

test('multiple activities and repeated clicks on the same day earn only one reward', () => {
  let state = upsertWake(withHabits(), today, '07:00');
  state.runs = [run('first'), run('second')];
  state = upsertHabitLog(state, 'check', today, true);
  state = upsertHabitLog(state, 'number', today, 1);
  state = upsertHabitLog(state, 'time', today, 10);
  const original = structuredClone(state);
  for (let i = 0; i < 20; i++) {
    state = upsertWake(state, today, '07:00');
    state = upsertHabitLog(state, 'check', today, true);
    assert.equal(deriveGarden(state, today).totalDays, 1);
  }
  assert.deepEqual(rewardDates(state, today), [today]);
  assert.equal(deriveGarden(state, today).todayEarned, true);
  assert.deepEqual(state, original);
});

test('duplicate run histories on a day cannot earn more and duplicate IDs still fail validation', () => {
  const state = { ...createInitialState(), runs: [run('a'), run('b'), run('c')] };
  assert.equal(deriveGarden(validateState(state), today).totalDays, 1);
  assert.equal(deriveGarden({ ...state, runs: [...state.runs, state.runs[0]] }, today).totalDays, 1);
  assert.throws(() => validateState({ ...state, runs: [...state.runs, state.runs[0]] }));
});

test('habit rewards recognize any genuine positive effort, not only meeting a target', () => {
  let state = withHabits();
  state = upsertHabitLog(state, 'number', '2026-10-04', 0.5);
  state = upsertHabitLog(state, 'time', '2026-10-05', 1);
  state = upsertHabitLog(state, 'check', today, true);
  assert.deepEqual(rewardDates(state, today), ['2026-10-04', '2026-10-05', today]);
  assert.equal(state.habits[2].archived, true);
});

test('unchecked and zero habit logs do not earn rewards', () => {
  let state = withHabits();
  state = upsertHabitLog(state, 'check', today, false);
  state = upsertHabitLog(state, 'number', today, 0);
  state = upsertHabitLog(state, 'time', today, 0);
  assert.equal(deriveGarden(state, today).totalDays, 0);
});

test('future wake, runs, and positive habits stay excluded until their local day', () => {
  let state = upsertWake(withHabits(), '2026-10-07', '07:00');
  state.runs = [run('future', '2026-10-08')];
  state = upsertHabitLog(state, 'check', '2026-10-09', true);
  assert.deepEqual(rewardDates(state, today), []);
  assert.deepEqual(rewardDates(state, '2026-10-07'), ['2026-10-07']);
  assert.deepEqual(rewardDates(state, '2026-10-09'), ['2026-10-07', '2026-10-08', '2026-10-09']);
});

test('planned events and diary edits never produce a reward', () => {
  let state = upsertEvent(createInitialState(), { id: 'event', date: today, title: '予定', note: '', time: null });
  state = upsertDiary(state, today, { text: '記録した日', mood: 'bright' });
  for (let i = 0; i < 10; i++) {
    state = upsertDiary(state, today, { text: `記録 ${i}`, mood: 'calm' });
    assert.equal(deriveGarden(state, today).totalDays, 0);
  }
});

test('rest days never reduce growth, level, or unlocks', () => {
  const state = withDays(21), earlier = deriveGarden(state, today), later = deriveGarden(state, '2027-01-01');
  for (const key of ['dates', 'totalDays', 'level', 'stage', 'progress', 'unlockedPlants']) assert.deepEqual(later[key], earlier[key]);
  assert.equal(later.todayEarned, false);
  assert.equal(later.lastEarnedDate, today);
});

test('deleting or unchecking recomputes a day only when the final earning record is removed', () => {
  let state = upsertWake(withHabits(), today, '07:00');
  state = upsertHabitLog(state, 'check', today, true);
  state.runs = [run('run')];
  const snapshot = structuredClone(state);
  delete state.wake[today];
  assert.equal(deriveGarden(state, today).totalDays, 1);
  state = upsertHabitLog(state, 'check', today, false);
  assert.equal(deriveGarden(state, today).totalDays, 1);
  state.runs = [];
  assert.equal(deriveGarden(state, today).totalDays, 0);
  assert.equal(deriveGarden(snapshot, today).totalDays, 1, 'undo restoring the previous snapshot restores derived growth');
});

test('removing a numeric habit log or its definition removes its final earned day', () => {
  const state = upsertHabitLog(withHabits(), 'number', today, 1);
  const deletedLog = structuredClone(state);
  delete deletedLog.habitLogs.number[today];
  assert.equal(deriveGarden(deletedLog, today).totalDays, 0);
  const deletedHabit = structuredClone(state);
  deletedHabit.habits = deletedHabit.habits.filter((item) => item.id !== 'number');
  delete deletedHabit.habitLogs.number;
  assert.equal(deriveGarden(validateState(deletedHabit), today).totalDays, 0);
});

test('stage progression has deterministic boundaries and bounded progress', () => {
  for (let i = 0; i < GARDEN_STAGES.length; i++) {
    const stage = GARDEN_STAGES[i], garden = deriveGarden(withDays(stage.at), today);
    assert.equal(garden.level, i + 1);
    assert.equal(garden.stage, stage.id);
    assert.equal(garden.nextAt, GARDEN_STAGES[i + 1]?.at ?? null);
    assert.equal(garden.progress, i === GARDEN_STAGES.length - 1 ? 1 : 0);
  }
  assert.equal(deriveGarden(withDays(5), today).progress, 0.5);
  const mature = deriveGarden(withDays(100), today);
  assert.equal(mature.nextAt, null);
  assert.equal(mature.progress, 1);
  assert.equal(mature.daysToNext, 0);
});

test('plant unlocks are derived; deleted rewards preserve preferences and gate appearance', () => {
  const state = withDays(21);
  state.garden = { plant: 'hydrangea', theme: 'night' };
  assert.equal(deriveGarden(state, today).currentPlant, 'hydrangea');
  assert.deepEqual(deriveGarden(state, today).unlockedPlants, GARDEN_PLANTS.map((plant) => plant.id));
  delete state.wake[today];
  const garden = deriveGarden(validateState(state), today);
  assert.equal(garden.selectedPlant, 'hydrangea');
  assert.equal(garden.currentPlant, 'cosmos');
  assert.equal(garden.theme, 'night');
  assert.deepEqual(garden.unlockedPlants, ['cosmos', 'sunflower']);
  assert.equal(state.garden.plant, 'hydrangea');
});

test('derived helper ignores invalid unsaved data and rejects invalid anchors', () => {
  const state = withHabits();
  state.wake = { 'invalid': '07:00', [today]: '99:00' };
  state.runs = [run('zero'), run('negative')];
  state.runs[0].distanceKm = 0;
  state.runs[1].durationSec = -1;
  state.habitLogs = { check: { [today]: 1 }, number: { [today]: Infinity }, time: { [today]: -1 }, orphan: { [today]: true } };
  assert.deepEqual(rewardDates(state, today), []);
  assert.throws(() => deriveGarden(state, '2026-02-30'));
});

test('input insertion order cannot change the derived result', () => {
  const a = withDays(7), b = structuredClone(a);
  b.wake = Object.fromEntries(Object.entries(b.wake).reverse());
  assert.deepEqual(deriveGarden(a, today), deriveGarden(b, today));
});
