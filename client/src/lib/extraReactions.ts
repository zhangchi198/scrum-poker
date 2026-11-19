import { addExtraReaction, parseExtraReactions } from '../../../shared/emoji.ts';

/** This browser's picked emojis, oldest first. Private to the browser: other people never see your row. */
export const EXTRA_REACTIONS_KEY = 'poker.reactions.extra.v1';

interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const browserStore = (): Store | null => {
  try {
    return localStorage;
  } catch {
    return null; // blocked storage (private mode, etc.)
  }
};

export function loadExtraReactions(store: Store | null = browserStore()): string[] {
  try {
    return parseExtraReactions(JSON.parse(store?.getItem(EXTRA_REACTIONS_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

/** Records a pick (newest wins, max 5) and returns the new list. Works in memory if storage is blocked. */
export function pickExtraReaction(current: readonly string[], emoji: string, store: Store | null = browserStore()): string[] {
  const next = addExtraReaction(current, emoji);
  try {
    store?.setItem(EXTRA_REACTIONS_KEY, JSON.stringify(next));
  } catch {
    /* the row just won't survive a reload */
  }
  return next;
}
