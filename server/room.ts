import { randomBytes } from 'node:crypto';
import { DECKS, LIMITS, type DeckId, type RoomView, type TimerView } from '../shared/protocol.ts';

export interface Participant {
  /** Public id shown to other players. The clientId (the "secret") is never sent to anyone else. */
  publicId: string;
  name: string;
  spectator: boolean;
  vote: string | null;
  connections: number;
  disconnectedAt: number | null;
}

export class RoomError extends Error {
  readonly code: 'room_full' | 'bad_request';
  constructor(code: 'room_full' | 'bad_request', message: string) {
    super(message);
    this.code = code;
  }
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function randomId(length: number): string {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    const b = bytes[i]!;
    if (b < 58 * 4) out += B58[b % 58]; // rejection sampling keeps the distribution uniform
  }
  return out.length === length ? out : randomId(length);
}

export function cleanText(input: unknown, max: number): string {
  if (typeof input !== 'string') return '';
  // Strip control characters, collapse whitespace.
  return input.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function parseCustomDeck(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const cards: string[] = [];
  for (const raw of input) {
    const c = cleanText(raw, LIMITS.customCardLength);
    if (c && !cards.includes(c)) cards.push(c);
  }
  return cards.length >= 2 && cards.length <= LIMITS.customCards ? cards : null;
}

export interface RoomSnapshot {
  id: string;
  story: string;
  deckId: DeckId;
  cards: string[];
  revealed: boolean;
  round: number;
  timer: TimerView | null;
  lastActivity: number;
  participants: [string, Omit<Participant, 'connections' | 'disconnectedAt'>][];
}

export class Room {
  readonly id: string;
  story = '';
  deckId: DeckId = 'fibonacci';
  cards: string[] = [...DECKS.fibonacci.cards];
  revealed = false;
  round = 1;
  timer: TimerView | null = null;
  lastActivity: number;
  lastNudgeAt = 0;
  readonly participants = new Map<string, Participant>();

  constructor(id: string, now = Date.now()) {
    this.id = id;
    this.lastActivity = now;
  }

  private touch(now: number) {
    this.lastActivity = now;
  }

  get connectedCount(): number {
    let n = 0;
    for (const p of this.participants.values()) if (p.connections > 0) n++;
    return n;
  }

  join(clientId: string, rawName: string, spectator: boolean, now = Date.now()): Participant {
    const name = cleanText(rawName, LIMITS.nameLength) || 'Anonymous';
    let p = this.participants.get(clientId);
    if (!p) {
      if (this.participants.size >= LIMITS.participantsPerRoom) {
        throw new RoomError('room_full', `This room is full (${LIMITS.participantsPerRoom} people max).`);
      }
      p = { publicId: randomId(8), name, spectator, vote: null, connections: 0, disconnectedAt: null };
      this.participants.set(clientId, p);
    } else {
      p.name = name;
      p.spectator = spectator;
      if (spectator) p.vote = null;
    }
    p.connections++;
    p.disconnectedAt = null;
    this.touch(now);
    return p;
  }

  leave(clientId: string, now = Date.now()) {
    const p = this.participants.get(clientId);
    if (!p) return;
    p.connections = Math.max(0, p.connections - 1);
    if (p.connections === 0) p.disconnectedAt = now;
    this.touch(now);
  }

  /** Drops participants that have been offline longer than the grace period. Returns true if anything changed. */
  prune(now: number, graceMs: number): boolean {
    let changed = false;
    for (const [id, p] of this.participants) {
      if (p.connections === 0 && p.disconnectedAt !== null && now - p.disconnectedAt > graceMs) {
        this.participants.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  isExpired(now: number, ttlMs: number): boolean {
    return this.connectedCount === 0 && now - this.lastActivity > ttlMs;
  }

  vote(clientId: string, value: string | null, now = Date.now()): boolean {
    const p = this.participants.get(clientId);
    if (!p || p.spectator || this.revealed) return false;
    if (value !== null && !this.cards.includes(value)) throw new RoomError('bad_request', 'That card is not in this deck.');
    if (p.vote === value) return false;
    p.vote = value;
    this.touch(now);
    return true;
  }

  reveal(now = Date.now()): boolean {
    if (this.revealed) return false;
    this.revealed = true;
    this.timer = null;
    this.touch(now);
    return true;
  }

  reset(now = Date.now()) {
    for (const p of this.participants.values()) p.vote = null;
    this.revealed = false;
    this.timer = null;
    this.round++;
    this.touch(now);
  }

  setStory(story: unknown, now = Date.now()): boolean {
    const next = cleanText(story, LIMITS.storyLength);
    if (next === this.story) return false;
    this.story = next;
    this.touch(now);
    return true;
  }

  setDeck(deckId: unknown, custom: unknown, now = Date.now()) {
    let cards: string[] | null = null;
    if (deckId === 'custom') cards = parseCustomDeck(custom);
    else if (typeof deckId === 'string' && Object.hasOwn(DECKS, deckId)) cards = [...DECKS[deckId as keyof typeof DECKS].cards];
    if (!cards) {
      throw new RoomError('bad_request', `A custom deck needs 2–${LIMITS.customCards} distinct cards of up to ${LIMITS.customCardLength} characters.`);
    }
    this.deckId = deckId as DeckId;
    this.cards = cards;
    // Votes from the old deck are meaningless now.
    for (const p of this.participants.values()) p.vote = null;
    this.revealed = false;
    this.touch(now);
  }

  setProfile(clientId: string, name: unknown, spectator: unknown, now = Date.now()): boolean {
    const p = this.participants.get(clientId);
    if (!p) return false;
    if (name !== undefined) p.name = cleanText(name, LIMITS.nameLength) || p.name;
    if (typeof spectator === 'boolean') {
      p.spectator = spectator;
      if (spectator) p.vote = null;
    }
    this.touch(now);
    return true;
  }

  setTimer(seconds: unknown, now = Date.now()) {
    if (seconds === null) {
      this.timer = null;
    } else {
      if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 5 || seconds > LIMITS.maxTimerSeconds) {
        throw new RoomError('bad_request', 'Timer must be between 5 seconds and 1 hour.');
      }
      this.timer = { endsAt: now + seconds * 1000, duration: seconds };
    }
    this.touch(now);
  }

  /** Clients (by clientId) who are expected to vote and haven't yet. */
  pendingVoters(): string[] {
    const out: string[] = [];
    for (const [id, p] of this.participants) if (!p.spectator && p.connections > 0 && p.vote === null) out.push(id);
    return out;
  }

  view(forClientId: string | null, now = Date.now()): RoomView {
    return {
      id: this.id,
      story: this.story,
      deckId: this.deckId,
      cards: this.cards,
      revealed: this.revealed,
      round: this.round,
      timer: this.timer,
      now,
      participants: [...this.participants].map(([cid, p]) => ({
        id: p.publicId,
        name: p.name,
        spectator: p.spectator,
        connected: p.connections > 0,
        voted: p.vote !== null,
        vote: this.revealed || cid === forClientId ? p.vote : null,
      })),
    };
  }

  snapshot(): RoomSnapshot {
    return {
      id: this.id,
      story: this.story,
      deckId: this.deckId,
      cards: this.cards,
      revealed: this.revealed,
      round: this.round,
      timer: this.timer,
      lastActivity: this.lastActivity,
      participants: [...this.participants].map(([cid, p]) => [
        cid,
        { publicId: p.publicId, name: p.name, spectator: p.spectator, vote: p.vote },
      ]),
    };
  }

  /** Restores a room after a restart. Everyone starts disconnected and gets the usual grace period to reconnect. */
  static restore(s: RoomSnapshot, now = Date.now()): Room {
    const room = new Room(s.id, s.lastActivity);
    room.story = s.story;
    room.deckId = s.deckId;
    room.cards = s.cards;
    room.revealed = s.revealed;
    room.round = s.round;
    room.timer = s.timer;
    for (const [cid, p] of s.participants) {
      room.participants.set(cid, { ...p, connections: 0, disconnectedAt: now });
    }
    return room;
  }
}
