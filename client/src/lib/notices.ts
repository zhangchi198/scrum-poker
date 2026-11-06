import type { ServerMsg, UndoView } from '../../../shared/protocol.ts';

type Notice = Extract<ServerMsg, { t: 'notice' }>;

/** Text of the toast shown for the 10 seconds Undo is available. The actor sees "You". */
export function undoToastText(u: UndoView, youId: string | null): string {
  const who = u.byId === youId ? 'You' : u.byName;
  return u.kind === 'reset' ? `${who} started a new round` : `${who} changed the deck to ${u.deckLabel ?? 'a new deck'}`;
}

export function noticeText(n: Notice, youId: string | null): string {
  switch (n.kind) {
    case 'undone':
      return `${n.byId === youId ? 'You' : n.byName} undid the ${n.what === 'reset' ? 'new round' : 'deck change'}`;
    case 'removed':
      return `${n.byId === youId ? 'You' : n.byName} removed ${n.name} (offline)`;
    case 'facilitator_left':
      return 'Facilitator left — controls are open to everyone';
  }
}

/** Spoken (live region) when the facilitator lock changes. Null when nothing relevant changed. */
export function lockAnnouncement(
  prev: { locked: boolean; facilitatorId: string | null },
  next: { locked: boolean; facilitatorId: string | null },
  nameOf: (id: string | null) => string,
  youId: string | null,
): string | null {
  if (prev.locked === next.locked && prev.facilitatorId === next.facilitatorId) return null;
  if (!next.locked) return 'Facilitator controls are off. Everyone can use the controls.';
  const who = next.facilitatorId === youId ? 'You are' : `${nameOf(next.facilitatorId)} is`;
  return prev.locked ? `${who} now the facilitator.` : `Facilitator controls are on. ${who} the facilitator.`;
}
