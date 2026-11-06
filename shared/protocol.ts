// Wire protocol + domain constants shared by the server and the browser client.
// Kept free of runtime dependencies so both sides can import it directly.

export const DECKS = {
  fibonacci: { label: 'Fibonacci', cards: ['0', '1', '2', '3', '5', '8', '13', '21', '34', '55', '89', '?', '☕'] },
  modified: { label: 'Modified Fibonacci', cards: ['0', '½', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', '☕'] },
  tshirt: { label: 'T-shirt sizes', cards: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '?', '☕'] },
  powers: { label: 'Powers of 2', cards: ['0', '1', '2', '4', '8', '16', '32', '64', '?', '☕'] },
} as const;

export type PresetDeckId = keyof typeof DECKS;
export type DeckId = PresetDeckId | 'custom';
export const DECK_IDS = [...(Object.keys(DECKS) as PresetDeckId[]), 'custom'] as const;

export const REACTIONS = ['👍', '🎉', '🤔', '😂', '🔥', '😱', '👀', '☕'] as const;
export const TIMER_PRESETS = [30, 60, 120, 300] as const;

export const LIMITS = {
  nameLength: 24,
  storyLength: 200,
  customCards: 16,
  customCardLength: 4,
  participantsPerRoom: 40,
  maxTimerSeconds: 3600,
} as const;

export interface ParticipantView {
  id: string;
  name: string;
  spectator: boolean;
  connected: boolean;
  voted: boolean;
  /** Only present for yourself, or for everyone once the round is revealed. */
  vote: string | null;
}

export interface TimerView {
  endsAt: number;
  duration: number;
}

export interface RoomView {
  id: string;
  story: string;
  deckId: DeckId;
  cards: string[];
  revealed: boolean;
  round: number;
  participants: ParticipantView[];
  timer: TimerView | null;
  /** Server clock at send time, so clients can correct the timer for clock skew. */
  now: number;
}

export type ClientMsg =
  | { t: 'join'; roomId: string; clientId: string; name: string; spectator: boolean }
  | { t: 'vote'; value: string | null }
  | { t: 'reveal' }
  | { t: 'reset' }
  | { t: 'story'; story: string }
  | { t: 'deck'; deckId: DeckId; custom?: string[] }
  | { t: 'profile'; name?: string; spectator?: boolean }
  | { t: 'timer'; seconds: number | null }
  | { t: 'react'; emoji: string }
  | { t: 'nudge' }
  | { t: 'leave' }
  | { t: 'ping' };

/** `GET /api/rooms/:id`. Reveals nothing that joining would not, and never any vote. */
export type RoomLookup =
  | { status: 'live'; story: string; players: number; deckLabel: string }
  | { status: 'revivable'; deckLabel: string };

export type ErrorCode = 'room_not_found' | 'room_full' | 'bad_request' | 'rate_limited' | 'not_joined';

export type ServerMsg =
  | { t: 'welcome'; you: string; room: RoomView }
  | { t: 'state'; room: RoomView }
  | { t: 'reaction'; from: string; name: string; emoji: string }
  | { t: 'nudge'; fromName: string }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong' };

const NON_NUMERIC_SPECIAL = new Set(['?', '☕']);

export function numericValue(card: string): number | null {
  if (card === '½') return 0.5;
  if (!/^\d+(\.\d+)?$/.test(card)) return null;
  return Number(card);
}

export interface RoundStats {
  total: number;
  distribution: { card: string; count: number }[];
  average: number | null;
  median: number | null;
  /** Share of "real" votes (excluding ? and ☕) that match the most common card. */
  agreement: number | null;
  consensus: boolean;
  mostCommon: string[];
}

export function computeStats(votes: string[], cards: readonly string[]): RoundStats {
  const counts = new Map<string, number>();
  for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1);

  const order = [...cards, ...[...counts.keys()].filter((c) => !cards.includes(c))];
  const distribution = order.filter((c) => counts.has(c)).map((card) => ({ card, count: counts.get(card)! }));

  const nums = votes.map(numericValue).filter((n): n is number => n !== null).sort((a, b) => a - b);
  const average = nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
  let median: number | null = null;
  if (nums.length) {
    const mid = Math.floor(nums.length / 2);
    median = nums.length % 2 ? nums[mid]! : (nums[mid - 1]! + nums[mid]!) / 2;
  }

  const real = distribution.filter((d) => !NON_NUMERIC_SPECIAL.has(d.card));
  const realTotal = real.reduce((s, d) => s + d.count, 0);
  const max = real.reduce((m, d) => Math.max(m, d.count), 0);
  const mostCommon = real.filter((d) => d.count === max && max > 0).map((d) => d.card);

  return {
    total: votes.length,
    distribution,
    average,
    median,
    agreement: realTotal ? max / realTotal : null,
    consensus: realTotal >= 2 && real.length === 1,
    mostCommon,
  };
}
