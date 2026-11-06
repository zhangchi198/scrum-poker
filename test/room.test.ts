import { describe, expect, it } from 'vitest';
import { Room, RoomError, isTombstone, randomId } from '../server/room.ts';

const A = 'client-a-000000000000';
const B = 'client-b-000000000000';
const C = 'client-c-000000000000';

function room3() {
  const r = new Room('Room123456', 0);
  r.join(A, 'Alice', false, 0);
  r.join(B, 'Bob', false, 0);
  r.join(C, 'Cara', true, 0);
  return r;
}

describe('randomId', () => {
  it('produces base58 ids of the right length', () => {
    for (let i = 0; i < 200; i++) expect(randomId(10)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{10}$/);
  });
});

describe('Room', () => {
  it('hides other votes until reveal, but shows you your own', () => {
    const r = room3();
    r.vote(A, '5');
    r.vote(B, '8');
    const asA = r.view(A);
    expect(asA.participants.find((p) => p.name === 'Alice')!.vote).toBe('5');
    expect(asA.participants.find((p) => p.name === 'Bob')).toMatchObject({ voted: true, vote: null });
    // the spectator sees nothing
    expect(r.view(C).participants.every((p) => p.vote === null)).toBe(true);

    r.reveal();
    expect(r.view(C).participants.map((p) => p.vote)).toEqual(['5', '8', null]);
  });

  it('never leaks client ids in views', () => {
    const r = room3();
    expect(JSON.stringify(r.view(A))).not.toContain('client-');
  });

  it('rejects cards not in the deck and votes from spectators or after reveal', () => {
    const r = room3();
    expect(() => r.vote(A, '4')).toThrow(RoomError);
    expect(r.vote(C, '5')).toBe(false);
    r.vote(A, '5');
    r.reveal();
    expect(r.vote(A, '8')).toBe(false);
    expect(r.view(A).participants[0]!.vote).toBe('5');
  });

  it('reset clears votes, hides cards, and bumps the round', () => {
    const r = room3();
    r.vote(A, '5');
    r.reveal();
    r.setTimer(60, 1000);
    r.reset();
    expect(r.revealed).toBe(false);
    expect(r.round).toBe(2);
    expect(r.timer).toBeNull();
    expect(r.view(A).participants.every((p) => !p.voted)).toBe(true);
  });

  it('changing deck clears votes and validates custom decks', () => {
    const r = room3();
    r.vote(A, '5');
    r.setDeck('tshirt', undefined);
    expect(r.cards).toContain('XL');
    expect(r.view(A).participants[0]!.voted).toBe(false);
    r.setDeck('custom', ['1', '2', '2', ' 3 ']);
    expect(r.cards).toEqual(['1', '2', '3']);
    expect(() => r.setDeck('custom', ['only'])).toThrow(RoomError);
    expect(() => r.setDeck('__proto__', undefined)).toThrow(RoomError);
  });

  it('keeps a seat (and vote) through a short disconnect, prunes after grace', () => {
    const r = room3();
    r.vote(A, '5');
    r.leave(A, 1000);
    expect(r.prune(1000 + 5_000, 90_000)).toBe(false);
    r.join(A, 'Alice', false, 6000);
    expect(r.view(A).participants[0]!.vote).toBe('5');
    r.leave(A, 10_000);
    expect(r.prune(10_000 + 91_000, 90_000)).toBe(true);
    expect(r.participants.has(A)).toBe(false);
  });

  it('two tabs for the same person count as one seat', () => {
    const r = room3();
    r.join(A, 'Alice', false);
    r.leave(A);
    expect(r.view(null).participants.find((p) => p.name === 'Alice')!.connected).toBe(true);
    expect(r.participants.size).toBe(3);
  });

  it('expires only when empty and idle', () => {
    const r = room3();
    expect(r.isExpired(10 ** 12, 1000)).toBe(false);
    for (const id of [A, B, C]) r.leave(id, 0);
    expect(r.isExpired(500, 1000)).toBe(false);
    expect(r.isExpired(2000, 1000)).toBe(true);
  });

  it('validates timer bounds', () => {
    const r = room3();
    expect(() => r.setTimer(2)).toThrow(RoomError);
    expect(() => r.setTimer(99999)).toThrow(RoomError);
    r.setTimer(30, 1000);
    expect(r.timer).toEqual({ endsAt: 31_000, duration: 30 });
    r.setTimer(null);
    expect(r.timer).toBeNull();
  });

  it('cleans names and stories', () => {
    const r = new Room('Room123456');
    r.join(A, '  Al\u0007ice   the    great ', false);
    expect(r.view(null).participants[0]!.name).toBe('Alice the great');
    r.join(B, '\u200b\u200b', false);
    expect(r.view(null).participants[1]!.name).toBe('Anonymous');
    r.setStory('a\u202eevil\u2066x');
    expect(r.story).toBe('aevilx');
    r.setStory('x'.repeat(500));
    expect(r.story).toHaveLength(200);
  });

  it('round-trips through a snapshot with everyone disconnected', () => {
    const r = room3();
    r.vote(A, '5');
    r.setStory('Login page');
    const restored = Room.restore(JSON.parse(JSON.stringify(r.snapshot())), 5000);
    expect(restored.story).toBe('Login page');
    expect(restored.view(A).participants[0]).toMatchObject({ name: 'Alice', vote: '5', connected: false });
    restored.join(A, 'Alice', false);
    expect(restored.view(A).participants[0]!.connected).toBe(true);
  });

  describe('fresh start after a gap', () => {
    const HOUR = 3600_000;
    const STALE = 4 * HOUR;

    function idleRoom() {
      const r = room3();
      r.setStory('Old story');
      r.vote(A, '5');
      r.reveal(100);
      r.setTimer(60, 100);
      for (const id of [A, B, C]) r.leave(id, 1000);
      return r;
    }

    it('resets the round and drops offline seats when the first person returns after 4h', () => {
      const r = idleRoom();
      r.join(B, 'Bob', false, 1000 + STALE, STALE);
      expect(r.round).toBe(2);
      expect(r.revealed).toBe(false);
      expect(r.timer).toBeNull();
      expect([...r.participants.keys()]).toEqual([B]);
      expect(r.view(B).participants[0]).toMatchObject({ name: 'Bob', voted: false, connected: true });
      expect(r.story).toBe('Old story');
    });

    it('leaves the room alone for a shorter gap', () => {
      const r = idleRoom();
      r.join(B, 'Bob', false, 1000 + STALE - 1, STALE);
      expect(r.round).toBe(1);
      expect(r.revealed).toBe(true);
      expect(r.participants.size).toBe(3);
      expect(r.view(B).participants.find((p) => p.name === 'Alice')!.vote).toBe('5');
    });

    it('never resets while somebody is connected, however old the last activity', () => {
      const r = room3();
      r.join(A, 'Alice', false, 100 * STALE, STALE); // second tab
      expect(r.round).toBe(1);
      expect(r.participants.size).toBe(3);
      // B joins late too, but A is still connected
      r.join(B, 'Bob', false, 100 * STALE, STALE);
      expect(r.round).toBe(1);
    });
  });

  it('turns into a tombstone and revives with the same id and deck but fresh state', () => {
    const r = room3();
    r.setDeck('custom', ['S', 'M', 'L']);
    r.setStory('Old');
    r.vote(A, 'M');
    const t = JSON.parse(JSON.stringify(r.tombstone()));
    expect(t).toEqual({ id: 'Room123456', deckId: 'custom', cards: ['S', 'M', 'L'], lastActivity: r.lastActivity });
    expect(isTombstone(t)).toBe(true);
    const revived = Room.revive(t, 5000);
    expect(revived.id).toBe('Room123456');
    expect(revived.deckId).toBe('custom');
    expect(revived.cards).toEqual(['S', 'M', 'L']);
    expect(revived.story).toBe('');
    expect(revived.round).toBe(1);
    expect(revived.participants.size).toBe(0);
    expect(revived.lastActivity).toBe(5000);
  });

  it('validates tombstones and snapshots', () => {
    expect(isTombstone(null)).toBe(false);
    expect(isTombstone({ id: 'x', deckId: 'nope', cards: ['1', '2'], lastActivity: 1 })).toBe(false);
    expect(isTombstone({ id: 'x', deckId: 'fibonacci', cards: 'no', lastActivity: 1 })).toBe(false);
    expect(isTombstone({ id: 'x', deckId: 'fibonacci', cards: ['1', '2'], lastActivity: NaN })).toBe(false);
    expect(() => Room.restore({ id: 5 } as never)).toThrow('malformed');
    expect(() => Room.restore(null as never)).toThrow('malformed');
  });
});

describe('Room: spectator switch, leave', () => {
  it('keeps a revealed vote when the voter becomes a spectator (setProfile), but clears it before the reveal', () => {
    const r = room3();
    r.vote(A, '5');
    r.vote(B, '8');
    r.setProfile(A, undefined, true, 1); // before reveal: the vote goes
    expect(r.participants.get(A)!.vote).toBeNull();
    r.reveal(2);
    r.setProfile(B, undefined, true, 3); // after reveal: results must not change
    expect(r.participants.get(B)).toMatchObject({ spectator: true, vote: '8' });
    expect(r.view(A).participants.find((p) => p.name === 'Bob')!.vote).toBe('8');
  });

  it('keeps a revealed vote when a voter rejoins as a spectator (join), but clears it before the reveal', () => {
    const r = room3();
    r.vote(A, '5');
    r.vote(B, '8');
    r.join(A, 'Alice', true, 1);
    expect(r.participants.get(A)!.vote).toBeNull();
    r.reveal(2);
    r.join(B, 'Bob', true, 3);
    expect(r.participants.get(B)).toMatchObject({ spectator: true, vote: '8' });
  });

  it('remove() drops the seat and its vote at once, with no grace period', () => {
    const r = room3();
    r.vote(A, '5');
    expect(r.remove(A, 1)).toBe(true);
    expect(r.participants.has(A)).toBe(false);
    expect(r.remove(A, 2)).toBe(false);
    expect(r.view(B).participants.map((p) => p.name)).toEqual(['Bob', 'Cara']);
  });
});
