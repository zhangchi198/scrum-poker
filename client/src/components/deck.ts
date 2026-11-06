import { LIMITS } from '../../../shared/protocol.ts';
import { cleanText, graphemeLength } from '../../../shared/text.ts';

export interface CustomDeckParse {
  cards: string[];
  /** Values cut down to the card length limit. */
  truncated: string[];
  /** Cards dropped for being past the card-count limit. */
  dropped: number;
  duplicates: number;
}

const tokens = (input: string) =>
  input
    .split(',')
    .map((s) => cleanText(s, Infinity))
    .filter(Boolean);

/** What the server will make of a custom deck: cut to the grapheme limit, de-duplicated, capped. */
export function parseCustomDeck(input: string): CustomDeckParse {
  const cards: string[] = [];
  const truncated: string[] = [];
  let duplicates = 0;
  let dropped = 0;
  for (const raw of tokens(input)) {
    const card = cleanText(raw, LIMITS.customCardLength);
    if (card !== raw) truncated.push(raw);
    if (cards.includes(card)) duplicates++;
    else if (cards.length >= LIMITS.customCards) dropped++;
    else cards.push(card);
  }
  return { cards, truncated, dropped, duplicates };
}

export function parseCustomInput(input: string): string[] {
  return parseCustomDeck(input).cards;
}

/** One line per thing the parser changed, for the note under the field. */
export function deckNotes(p: CustomDeckParse): string[] {
  const notes: string[] = [];
  if (p.truncated.length) notes.push(`Cut to ${LIMITS.customCardLength} characters: ${p.truncated.map((t) => `“${t}”`).join(', ')}.`);
  if (p.dropped) notes.push(`Only the first ${LIMITS.customCards} cards are used; ${p.dropped} dropped.`);
  if (p.duplicates) notes.push(`${p.duplicates} repeated ${p.duplicates === 1 ? 'card' : 'cards'} removed.`);
  if (p.cards.length < 2) notes.push('Add at least 2 cards.');
  return notes;
}

/** Validates a comma-separated custom deck; returns the cards, or a message for the field. */
export function validateCustomInput(input: string): { cards: string[]; error: string | null } {
  const cards = tokens(input);
  const rule = `A custom deck needs 2–${LIMITS.customCards} distinct cards of up to ${LIMITS.customCardLength} characters.`;
  if (cards.length < 2) return { cards, error: `Add at least 2 cards, separated by commas. ${rule}` };
  if (cards.length > LIMITS.customCards) return { cards, error: `Too many cards (${cards.length}). ${rule}` };
  const tooLong = cards.find((c) => graphemeLength(c) > LIMITS.customCardLength);
  if (tooLong) return { cards, error: `“${tooLong}” is longer than ${LIMITS.customCardLength} characters. ${rule}` };
  const dup = cards.find((c, i) => cards.indexOf(c) !== i);
  if (dup) return { cards, error: `“${dup}” appears more than once. ${rule}` };
  return { cards, error: null };
}
