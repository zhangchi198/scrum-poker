import type { ParticipantView } from '../../../shared/protocol.ts';

export interface VoteTally {
  /** Voters who are connected, and how many of those have voted. */
  online: number;
  votedOnline: number;
  offline: number;
  /** Everyone with a vote, connected or not (they all count at reveal). */
  voted: number;
}

/** Counts for the table status line. `players` are the non-spectators. */
export function tallyVotes(players: readonly ParticipantView[]): VoteTally {
  const online = players.filter((p) => p.connected);
  return {
    online: online.length,
    votedOnline: online.filter((p) => p.voted).length,
    offline: players.length - online.length,
    voted: players.filter((p) => p.voted).length,
  };
}

/** "3 of 4 voted · 1 offline", counting only connected voters and listing offline ones separately. */
export function voteStatus(t: VoteTally): string {
  if (t.online === 0 && t.offline === 0) return 'Waiting for players…';
  if (t.votedOnline === 0 && t.offline === 0) return 'Pick your cards!';
  const base = t.online === 0 ? 'Nobody is online' : `${t.votedOnline} of ${t.online} voted`;
  return t.offline ? `${base} · ${t.offline} offline` : base;
}

/** Who a nudge would reach: connected voters who haven't voted, not counting yourself or spectators. */
export function nudgeTargets(participants: readonly ParticipantView[], youId: string | null): number {
  return participants.filter((p) => !p.spectator && p.connected && !p.voted && p.id !== youId).length;
}
