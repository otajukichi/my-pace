import { createInitialState, parseBackup, serializeBackup } from './domain.js';

export const STORAGE_KEY = 'rhythm.personal.v1';
const errorText = (error) => error instanceof Error ? error.message : String(error);

/** Storage is injected for tests. Access to localStorage itself may throw in private/security contexts. */
export function readState(storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    if (!target || typeof target.getItem !== 'function') throw new Error('この環境ではブラウザー保存を利用できません。');
    const text = target.getItem(STORAGE_KEY);
    return { ok: true, state: text == null ? createInitialState() : parseBackup(text) };
  } catch (error) {
    // Do not overwrite the unreadable original. The UI must show the warning before any later save.
    return { ok: false, state: createInitialState(), error: errorText(error) };
  }
}
export function writeState(state, storage) {
  try {
    const serialized = serializeBackup(state);
    const target = storage ?? globalThis.localStorage;
    if (!target || typeof target.setItem !== 'function') throw new Error('この環境ではブラウザー保存を利用できません。');
    target.setItem(STORAGE_KEY, serialized);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}
export const loadState = readState;
export const saveState = writeState;
