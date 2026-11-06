import { graphemeLength } from '../../../shared/text.ts';

/** Up to 2 decimals, none when not needed: 1.17 -> "1.17", 5.0 -> "5", 5.2 -> "5.2". */
export function formatNumber(n: number): string {
  return String(Number(n.toFixed(2)));
}

/** Length bucket (1-4) CSS uses to shrink long card values so they fit the card. */
export function cardLen(card: string): number {
  return Math.min(4, Math.max(1, graphemeLength(card)));
}
