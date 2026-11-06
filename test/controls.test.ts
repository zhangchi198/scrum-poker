import { describe, expect, it } from 'vitest';
import { UNDO_WINDOW_MS } from '../shared/protocol.ts';
import { Room, RoomError, type Guarded } from '../server/room.ts';

const A = 'client-a-000000000000';
const B = 'client-b-000000000000';
const C = 'client-c-000000000000';
const D = 'client-d-000000000000';

/** Alice and Bob vote, Cara watches. */
function setup() {
  const r = new Room('Room123456', 0);
  r.join(A, 'Alice', false, 0);
  r.join(B, 'Bob', false, 0);
  r.join(C, 'Cara', true, 0);
  return r;
}

const forbidden = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RoomError);
    expect((e as RoomError).code).toBe('forbidden');
    return (e as RoomError).message;
  }
  throw new Error('expected a forbidden error');
};

describe('undo', () => {
  it('restores votes, reveal state, round and timer after "new round"', () => {
    const r = setup();
    r.vote(A, '5', 1);
    r.vote(B, '8', 1);
    r.setTimer(60, 1000);
    r.reveal(2000);
    r.reset(3000, A);
    expect(r.revealed).toBe(false);
    expect(r.round).toBe(2);
    expect(r.timer).toBeNull();

    r.undo(4000);
    expect(r.revealed).toBe(true);
    expect(r.round).toBe(1);
    expect(r.timer).toEqual({ endsAt: 61_000, duration: 60 });
    expect(r.view(A, 4000).participants.map((p) => p.vote)).toEqual(['5', '8', null]);
  });

  it('keeps restored votes hidden when the round was not revealed', () => {
    const r = setup();
    r.vote(A, '5', 1);
    r.vote(B, '8', 1);
    r.reset(2, A);
    r.undo(3);
    expect(r.revealed).toBe(false);
    // Bob sees that Alice voted, never what; Alice sees only her own card.
    expect(r.view(B, 3).participants.map((p) => [p.voted, p.vote])).toEqual([
      [true, null],
      [true, '8'],
      [false, null],
    ]);
    expect(r.view(null, 3).participants.every((p) => p.vote === null)).toBe(true);
  });

  it('exposes who and what in the view, with no votes in it', () => {
    const r = setup();
    r.vote(A, '5', 1);
    r.reset(10, B);
    const u = r.view(A, 11).undo;
    expect(u).toEqual({ kind: 'reset', until: 10 + UNDO_WINDOW_MS, byId: r.participants.get(B)!.publicId, byName: 'Bob' });
    expect(Object.keys(r.view(A, 11).undo!).sort()).toEqual(['byId', 'byName', 'kind', 'until']); // names and times only, no votes
  });

  it('is only available inside the window', () => {
    const r = setup();
    r.vote(A, '5', 1);
    r.reset(1000, A);
    expect(r.view(A, 1000 + UNDO_WINDOW_MS - 1).undo).not.toBeNull();
    expect(r.view(A, 1000 + UNDO_WINDOW_MS).undo).toBeNull();
    expect(() => r.undo(1000 + UNDO_WINDOW_MS)).toThrow(/Too late/);
    expect(r.round).toBe(2);
    expect(r.participants.get(A)!.vote).toBeNull();
  });

  it('is single-level: a second undo is refused', () => {
    const r = setup();
    r.reset(0, A);
    r.undo(1);
    expect(() => r.undo(2)).toThrow(RoomError);
  });

  it.each([
    ['a new vote', (r: Room) => r.vote(B, '3', 5)],
    ['a vote being retracted', (r: Room) => (r.vote(B, '3', 5), r.vote(B, null, 6))],
    ['a reveal', (r: Room) => (r.vote(B, '3', 5), r.reveal(6))],
    ['an internal reset', (r: Room) => r.reset(5)],
    ['an internal deck change', (r: Room) => r.setDeck('tshirt', undefined, 5)],
  ])('is invalidated by %s', (_name, change) => {
    const r = setup();
    r.vote(A, '5', 1);
    r.reset(2, A);
    change(r);
    expect(() => r.undo(7)).toThrow(RoomError);
  });

  it('does not hand a vote back to someone who became a spectator in the meantime (before the reveal)', () => {
    const r = setup();
    r.vote(A, '5', 1);
    r.vote(B, '2', 1);
    r.reset(3, B);
    r.setProfile(A, undefined, true, 4); // nothing to clear now, so Undo is still available
    r.undo(5);
    expect(r.participants.get(A)!.vote).toBeNull();
    expect(r.participants.get(B)!.vote).toBe('2');
  });

  it('a newer new round replaces the pending undo, so Undo only ever steps back one action', () => {
    const r = setup();
    r.vote(A, '5', 1);
    r.reset(2, A);
    r.reset(3, B);
    expect(r.view(A, 4).undo).toMatchObject({ kind: 'reset', byName: 'Bob' });
    r.undo(4);
    expect(r.round).toBe(2); // back to the empty round 2, not to Alice's round-1 vote
    expect(r.participants.get(A)!.vote).toBeNull();
    expect(() => r.undo(5)).toThrow(RoomError);
  });

  it('survives things that do not touch the round (story, timer, someone joining, nudges)', () => {
    const r = setup();
    r.vote(A, '5', 1);
    r.reset(2, A);
    r.setStory('Login page', 3);
    r.setTimer(30, 3);
    r.join(D, 'Dan', false, 4);
    expect(() => r.undo(5)).not.toThrow();
    expect(r.participants.get(A)!.vote).toBe('5');
    expect(r.participants.get(D)!.vote).toBeNull();
    expect(r.story).toBe('Login page');
    // A timer started after the reset is newer than the one being restored, so it stays.
    expect(r.timer).toEqual({ endsAt: 30_003, duration: 30 });
  });

  it('restores the previous deck and its votes after a deck change', () => {
    const r = setup();
    r.vote(A, '5', 1);
    r.vote(B, '8', 1);
    r.setDeck('tshirt', undefined, 2, A);
    expect(r.deckId).toBe('tshirt');
    expect(r.participants.get(A)!.vote).toBeNull();
    expect(r.view(B, 3).undo).toMatchObject({ kind: 'deck', deckLabel: 'T-shirt sizes', byName: 'Alice' });

    r.undo(3);
    expect(r.deckId).toBe('fibonacci');
    expect(r.cards).toContain('13');
    expect(r.participants.get(A)!.vote).toBe('5');
    expect(r.participants.get(B)!.vote).toBe('8');
    expect(r.round).toBe(1);
  });

  it('restores a custom deck, and a deck change from a revealed round', () => {
    const r = setup();
    r.setDeck('custom', ['S', 'M', 'L'], 0);
    r.vote(A, 'M', 1);
    r.reveal(2);
    r.setDeck('fibonacci', undefined, 3, B);
    expect(r.revealed).toBe(false);
    r.undo(4);
    expect(r.deckId).toBe('custom');
    expect(r.cards).toEqual(['S', 'M', 'L']);
    expect(r.revealed).toBe(true);
    expect(r.view(null, 4).participants[0]!.vote).toBe('M');
  });

  it('is not offered for internal resets (stale-room join) or invalid deck changes', () => {
    const r = setup();
    expect(() => r.setDeck('custom', ['x'], 1, A)).toThrow(RoomError);
    expect(r.view(A, 2).undo).toBeNull();
    const stale = new Room('Room123456', 0);
    stale.join(A, 'Alice', false, 0);
    stale.leave(A, 1);
    stale.join(B, 'Bob', false, 10_000, 5000);
    expect(stale.view(B, 10_000).undo).toBeNull();
  });
});

describe('timer', () => {
  it('keeps running through the reveal', () => {
    const r = setup();
    r.vote(A, '5', 1);
    r.setTimer(60, 1000);
    r.reveal(2000);
    expect(r.timer).toEqual({ endsAt: 61_000, duration: 60 });
  });

  it('is cleared by a new round (it belongs to the round)', () => {
    const r = setup();
    r.setTimer(60, 1000);
    r.reset(2000);
    expect(r.timer).toBeNull();
  });
});

describe('facilitator lock', () => {
  const guarded: Guarded[] = ['reveal', 'reset', 'deck', 'story', 'timer', 'undo', 'remove'];

  it('is off by default and exposes only a public id when on', () => {
    const r = setup();
    expect(r.view(A).locked).toBe(false);
    expect(r.view(A).facilitatorId).toBeNull();
    for (const g of guarded) expect(() => r.guard(B, g)).not.toThrow();

    expect(r.setLocked(A, true, 1)).toBe(true);
    const v = r.view(B);
    expect(v.locked).toBe(true);
    expect(v.facilitatorId).toBe(r.participants.get(A)!.publicId);
    expect(JSON.stringify(v)).not.toContain(A); // the clientId never leaves the server
  });

  it('rejects every guarded action from anyone but the facilitator, with a clear message', () => {
    const r = setup();
    r.setLocked(A, true);
    for (const g of guarded) {
      expect(forbidden(() => r.guard(B, g)), g).toMatch(/^Only Alice can .* while facilitator controls are on\.$/);
      expect(() => r.guard(A, g)).not.toThrow();
    }
    expect(forbidden(() => r.guard(B, 'reveal'))).toContain('reveal the cards');
    expect(forbidden(() => r.guard(B, 'reset'))).toContain('start a new round');
  });

  it('cannot be taken over, and only the facilitator can turn it off', () => {
    const r = setup();
    r.setLocked(A, true);
    forbidden(() => r.setLocked(B, true));
    forbidden(() => r.setLocked(B, false));
    expect(r.facilitator).toBe(A);
    expect(r.setLocked(A, false)).toBe(true);
    expect(r.facilitator).toBeNull();
    expect(r.setLocked(A, false)).toBe(false);
  });

  it('hands off to a connected participant only', () => {
    const r = setup();
    r.setLocked(A, true);
    const bob = r.participants.get(B)!.publicId;
    forbidden(() => r.handOff(B, r.participants.get(C)!.publicId)); // not the facilitator
    expect(() => r.handOff(A, 'nobody')).toThrow(/no longer/);
    r.leave(B, 5);
    expect(() => r.handOff(A, bob)).toThrow(/offline/);
    r.join(B, 'Bob', false, 6);
    expect(r.handOff(A, bob, 7)).toBe(true);
    expect(r.facilitator).toBe(B);
    forbidden(() => r.handOff(A, bob)); // Alice no longer holds the role
    expect(r.view(A).facilitatorId).toBe(bob);
  });

  it('releases when the facilitator is pruned after the grace period', () => {
    const r = setup();
    r.setLocked(A, true);
    r.leave(A, 1000);
    expect(r.prune(1000 + 90_000, 90_000)).toBe(false); // still inside the grace period
    expect(r.releaseIfFacilitatorGone()).toBe(false);
    expect(r.prune(1000 + 90_001, 90_000)).toBe(true);
    expect(r.releaseIfFacilitatorGone()).toBe(true);
    expect(r.facilitator).toBeNull();
    expect(r.view(B).locked).toBe(false);
    for (const g of guarded) expect(() => r.guard(B, g)).not.toThrow();
  });

  it('releases when the facilitator leaves', () => {
    const r = setup();
    r.setLocked(A, true);
    r.remove(A);
    expect(r.releaseIfFacilitatorGone()).toBe(true);
    expect(r.canControl(B)).toBe(true);
  });

  it('an unreachable facilitator never shows as locked in the view', () => {
    const r = setup();
    r.setLocked(A, true);
    r.participants.delete(A); // gone, release not yet run
    expect(r.view(B).locked).toBe(false);
    expect(r.view(B).facilitatorId).toBeNull();
  });
});

describe('removing offline seats', () => {
  it('removes an offline participant and their vote', () => {
    const r = setup();
    r.vote(B, '8', 1);
    r.leave(B, 2);
    expect(r.removeOffline(A, r.participants.get(B)!.publicId, 3)).toEqual({ name: 'Bob' });
    expect(r.participants.has(B)).toBe(false);
    expect(r.view(A).participants.map((p) => p.name)).toEqual(['Alice', 'Cara']);
  });

  it('refuses to remove someone who is online (any connection counts), or yourself', () => {
    const r = setup();
    const bob = r.participants.get(B)!.publicId;
    forbidden(() => r.removeOffline(A, bob));
    r.join(B, 'Bob', false, 1); // a second tab
    r.leave(B, 2); // one tab closes, one stays
    forbidden(() => r.removeOffline(A, bob));
    forbidden(() => r.removeOffline(A, r.participants.get(A)!.publicId));
    expect(r.participants.has(B)).toBe(true);
  });

  it('is a no-op for an unknown id', () => {
    const r = setup();
    expect(r.removeOffline(A, 'ghost')).toBeNull();
  });

  it('invalidates a pending undo only when the removed seat held a vote', () => {
    const r = setup();
    r.vote(A, '5', 1);
    r.leave(B, 2);
    r.reset(3, A);
    r.removeOffline(A, r.participants.get(B)!.publicId, 4); // Bob had no vote: round unchanged
    expect(() => r.undo(5)).not.toThrow();
  });
});

describe('ghost seats', () => {
  it('reports when a seat went offline, rounded down to the second', () => {
    const r = setup();
    r.leave(B, 12_345);
    const bob = r.view(A).participants.find((p) => p.name === 'Bob')!;
    expect(bob.offlineSince).toBe(12_000);
    expect(r.view(A).participants.find((p) => p.name === 'Alice')!.offlineSince).toBeNull();
    r.join(B, 'Bob', false, 20_000);
    expect(r.view(A).participants.find((p) => p.name === 'Bob')!.offlineSince).toBeNull();
  });
});

describe('persistence of the lock', () => {
  it('round-trips the facilitator', () => {
    const r = setup();
    r.setLocked(B, true);
    const restored = Room.restore(JSON.parse(JSON.stringify(r.snapshot())), 5000);
    expect(restored.facilitator).toBe(B);
    restored.join(B, 'Bob', false, 5001);
    expect(restored.view(A).locked).toBe(true);
    expect(restored.view(A).facilitatorId).toBe(restored.participants.get(B)!.publicId);
  });

  it('defaults to unlocked for files written before the lock existed', () => {
    const r = setup();
    const snap = JSON.parse(JSON.stringify(r.snapshot())) as Record<string, unknown>;
    delete snap.facilitator;
    const restored = Room.restore(snap as never, 5000);
    expect(restored.facilitator).toBeNull();
    expect(restored.canControl(A)).toBe(true);
  });

  it('ignores a facilitator that is not in the room, or a malformed one', () => {
    const r = setup();
    const snap = JSON.parse(JSON.stringify(r.snapshot())) as Record<string, unknown>;
    snap.facilitator = 'client-zzzzzzzzzzzzzzzz';
    expect(Room.restore(snap as never).facilitator).toBeNull();
    snap.facilitator = 42;
    expect(Room.restore(snap as never).facilitator).toBeNull();
  });

  it('does not persist the undo record (it lives 10 seconds)', () => {
    const r = setup();
    r.vote(A, '5', 1);
    r.reset(2, A);
    expect(JSON.stringify(r.snapshot())).not.toContain('undo');
    expect(Room.restore(JSON.parse(JSON.stringify(r.snapshot()))).view(A).undo).toBeNull();
  });

  it('clears the facilitator when a long-idle room starts fresh', () => {
    const r = setup();
    r.setLocked(A, true);
    r.leave(A, 1);
    r.leave(B, 1);
    r.leave(C, 1);
    r.join(D, 'Dan', false, 10_000, 5000);
    expect(r.facilitator).toBeNull();
  });
});
