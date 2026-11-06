import type { RoomView } from '../../../shared/protocol.ts';

type Lock = Pick<RoomView, 'locked' | 'facilitatorId'>;

/** Whether `meId` may reveal, start rounds, change the deck, edit the story and run the timer. The server enforces the same rule. */
export function canControl(room: Lock, meId: string | null): boolean {
  return !room.locked || (meId !== null && room.facilitatorId === meId);
}

export function facilitatorName(room: Lock & Pick<RoomView, 'participants'>): string | null {
  if (!room.locked) return null;
  return room.participants.find((p) => p.id === room.facilitatorId)?.name ?? null;
}

/** "Only Alex can reveal" for people who are locked out, or null when they may act. `what` completes the sentence. */
export function controlHint(room: Lock & Pick<RoomView, 'participants'>, meId: string | null, what: string): string | null {
  if (canControl(room, meId)) return null;
  return `Only ${facilitatorName(room) ?? 'the facilitator'} can ${what}`;
}
