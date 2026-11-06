import type { RoundStats } from '../../../shared/protocol.ts';
import { formatNumber } from './format.ts';

/** Screen-reader summary spoken when the cards are revealed. */
export function revealMessage(stats: RoundStats | null): string {
  if (!stats || stats.total === 0) return 'Cards revealed. Nobody voted.';
  const votes = `${stats.total} ${stats.total === 1 ? 'vote' : 'votes'}`;
  if (stats.consensus) return `Cards revealed. Consensus on ${stats.mostCommon.join(' / ')}, ${votes}.`;
  const parts: string[] = [];
  if (stats.average !== null) parts.push(`Average ${formatNumber(stats.average)}`);
  else if (stats.mostCommon.length) parts.push(`Most common ${stats.mostCommon.join(' / ')}`);
  if (stats.median !== null) parts.push(`median ${formatNumber(stats.median)}`);
  if (stats.agreement !== null) parts.push(`agreement ${Math.round(stats.agreement * 100)}%`);
  parts.push(votes);
  return `Cards revealed. ${parts.join(', ')}.`;
}

export const NEW_ROUND_MESSAGE = 'New round. Pick your card.';

/** How long to wait before announcing voting progress again, so a burst of votes is one announcement. */
export function progressDelay(lastAt: number, now: number, minGapMs: number): number {
  return Math.max(0, lastAt + minGapMs - now);
}
