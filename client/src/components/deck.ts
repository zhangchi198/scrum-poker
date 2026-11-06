import { LIMITS } from '../../../shared/protocol.ts';

export function parseCustomInput(input: string): string[] {
  return [
    ...new Set(
      input
        .split(',')
        .map((s) => s.trim().slice(0, LIMITS.customCardLength))
        .filter(Boolean),
    ),
  ].slice(0, LIMITS.customCards);
}

/** Validates a comma-separated custom deck; returns the cards, or a message for the field. */
export function validateCustomInput(input: string): { cards: string[]; error: string | null } {
  const cards = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const rule = `A custom deck needs 2–${LIMITS.customCards} distinct cards of up to ${LIMITS.customCardLength} characters.`;
  if (cards.length < 2) return { cards, error: `Add at least 2 cards, separated by commas. ${rule}` };
  if (cards.length > LIMITS.customCards) return { cards, error: `Too many cards (${cards.length}). ${rule}` };
  const tooLong = cards.find((c) => c.length > LIMITS.customCardLength);
  if (tooLong) return { cards, error: `“${tooLong}” is longer than ${LIMITS.customCardLength} characters. ${rule}` };
  const dup = cards.find((c, i) => cards.indexOf(c) !== i);
  if (dup) return { cards, error: `“${dup}” appears more than once. ${rule}` };
  return { cards, error: null };
}
