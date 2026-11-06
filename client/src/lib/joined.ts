import { loadIdentity } from './identity.ts';

export const JOINED_CAP = 50;
const KEY = 'poker.rooms.v1';

/** Adds `id` as the most recent entry, dropping duplicates and keeping the last `cap`. */
export function addJoined(list: readonly string[], id: string, cap = JOINED_CAP): string[] {
  return [...list.filter((x) => x !== id), id].slice(-cap);
}

function read(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function write(list: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode etc.: the join dialog just shows again next time */
  }
}

// In-memory copy so a browser without usable storage still skips the dialog within one page load.
let session: string[] = [];

export function hasJoined(id: string): boolean {
  return session.includes(id) || read().includes(id);
}

/** This browser has a name and has been in this room before, so the join dialog is skipped. */
export function resumable(id: string): boolean {
  return !!loadIdentity().name && hasJoined(id);
}

export function markJoined(id: string) {
  session = addJoined(session, id);
  write(addJoined(read(), id));
}

export function forgetJoined(id: string) {
  session = session.filter((x) => x !== id);
  write(read().filter((x) => x !== id));
}

/** Spectator mode lasts for this tab and room only; it is never stored where later rooms could inherit it. */
export function readSpectator(roomId: string): boolean {
  try {
    return sessionStorage.getItem(`poker.spectator.${roomId}`) === '1';
  } catch {
    return false;
  }
}

export function writeSpectator(roomId: string, spectator: boolean) {
  try {
    if (spectator) sessionStorage.setItem(`poker.spectator.${roomId}`, '1');
    else sessionStorage.removeItem(`poker.spectator.${roomId}`);
  } catch {
    /* ignore */
  }
}
