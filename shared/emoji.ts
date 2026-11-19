// Extra emoji reactions: the picker's emoji set, the server-side check for "one standard emoji", and the
// newest-wins list of extras each browser keeps next to the built-in REACTIONS.

import { REACTIONS } from './protocol.ts';
import { graphemes } from './text.ts';

/**
 * What the "+" picker offers, in display order. Hand-picked, common, and all from Emoji 13 or older so they
 * render on every current OS. None of them repeats a built-in reaction.
 */
export const PICKER_EMOJIS = [
  '😀', '😁', '😅', '🤣', '😊', '😍', '🥰', '😎',
  '🤩', '🥳', '😇', '🙃', '😉', '🤓', '🤗', '😴',
  '🤯', '😬', '🙄', '😏', '😢', '😭', '😤', '😡',
  '🥺', '😳', '🤷', '🤦', '🙈', '💀', '🤡', '👻',
  '👏', '🙌', '🙏', '🤝', '💪', '👌', '✌️', '🤞',
  '👋', '👎', '❤️', '💔', '💯', '✅', '❌', '⚡',
  '💡', '🎯', '🚀', '🏆', '⭐', '🌈', '🍕', '🍩',
  '🍺', '🧠', '🐛', '🐢', '🦄', '⏰', '📈', '🤖',
] as const;

/** How many picked emojis a browser keeps beside the built-in reactions. */
export const MAX_EXTRA_REACTIONS = 5;

/** Longest emoji we accept, in UTF-16 code units. The longest RGI sequences (ZWJ families, skin tones) are ~15. */
const MAX_EMOJI_UNITS = 32;

let rgi: RegExp | null | undefined;
function rgiEmoji(): RegExp | null {
  if (rgi === undefined) {
    try {
      // Built at runtime: the `v` flag is newer than the TypeScript target, and old browsers would throw on a literal.
      rgi = new RegExp('^\\p{RGI_Emoji}$', 'v');
    } catch {
      rgi = null;
    }
  }
  return rgi;
}

/**
 * True for exactly one standard emoji: a single grapheme that Unicode lists as an emoji recommended for general
 * interchange (RGI), such as 👍, 👍🏽, ❤️, 🇺🇸 or 👨‍👩‍👧. Text, several emojis, bare symbols like © and oversized
 * strings are rejected. Without `v`-flag support it falls back to "one grapheme that starts with a pictograph".
 */
export function isStandardEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EMOJI_UNITS) return false;
  const re = rgiEmoji();
  if (re) return re.test(value);
  return graphemes(value).length === 1 && /^\p{Extended_Pictographic}/u.test(value);
}

/** True if a `react` message may carry this emoji: a built-in reaction or any single standard emoji. */
export function isReactionEmoji(value: unknown): value is string {
  return (REACTIONS as readonly string[]).includes(value as string) || isStandardEmoji(value);
}

/**
 * Adds `emoji` as the newest extra reaction (last in the list). An emoji already in the list moves to the end
 * instead of repeating, built-ins are never added, and past MAX_EXTRA_REACTIONS the oldest ones drop off.
 * Returns a new array; `list` is left alone.
 */
export function addExtraReaction(list: readonly string[], emoji: string): string[] {
  if ((REACTIONS as readonly string[]).includes(emoji)) return [...list];
  const next = list.filter((e) => e !== emoji);
  next.push(emoji);
  return next.slice(-MAX_EXTRA_REACTIONS);
}

/** Cleans a stored list (from localStorage, so anything): keeps picker emojis only, no repeats, the newest 5. */
export function parseExtraReactions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  let out: string[] = [];
  for (const e of raw) {
    if (typeof e === 'string' && (PICKER_EMOJIS as readonly string[]).includes(e)) out = addExtraReaction(out, e);
  }
  return out;
}
