import { describe, expect, it } from 'vitest';
import { REACTIONS } from '../shared/protocol.ts';
import {
  MAX_EXTRA_REACTIONS,
  PICKER_EMOJIS,
  addExtraReaction,
  isReactionEmoji,
  isStandardEmoji,
  parseExtraReactions,
} from '../shared/emoji.ts';
import { EXTRA_REACTIONS_KEY, loadExtraReactions, pickExtraReaction } from '../client/src/lib/extraReactions.ts';

describe('isStandardEmoji', () => {
  it('accepts one standard emoji, including modifiers, flags, keycaps and ZWJ sequences', () => {
    for (const e of ['👍', '🚀', '❤️', '✌️', '👍🏽', '🇺🇸', '1️⃣', '👨‍👩‍👧', '🏳️‍🌈', '☕']) {
      expect(isStandardEmoji(e), e).toBe(true);
    }
  });

  it('rejects text, several emojis, bare symbols, padding, oversized strings and non-strings', () => {
    for (const e of ['', 'a', 'hi', '👍👍', '👍 ', ' 👍', '👍a', '©', '❤', '1', '#', '🚀'.repeat(20), 'x'.repeat(5000), '‍', '<b>']) {
      expect(isStandardEmoji(e), JSON.stringify(e)).toBe(false);
    }
    for (const e of [null, undefined, 42, ['👍'], { emoji: '👍' }]) expect(isStandardEmoji(e)).toBe(false);
  });

  it('isReactionEmoji takes the built-ins and any standard emoji', () => {
    for (const e of [...REACTIONS, ...PICKER_EMOJIS]) expect(isReactionEmoji(e), e).toBe(true);
    expect(isReactionEmoji('nope')).toBe(false);
  });
});

describe('PICKER_EMOJIS', () => {
  it('is a small grid of distinct standard emojis that never repeats a built-in', () => {
    expect(PICKER_EMOJIS.length).toBeGreaterThanOrEqual(40);
    expect(PICKER_EMOJIS.length).toBeLessThanOrEqual(80);
    expect(PICKER_EMOJIS.length % 8).toBe(0); // fills the 8-column grid
    expect(new Set(PICKER_EMOJIS).size).toBe(PICKER_EMOJIS.length);
    for (const e of PICKER_EMOJIS) {
      expect(isStandardEmoji(e), e).toBe(true);
      expect((REACTIONS as readonly string[]).includes(e), e).toBe(false);
    }
  });
});

describe('addExtraReaction', () => {
  it('appends the newest last', () => {
    expect(addExtraReaction([], '🚀')).toEqual(['🚀']);
    expect(addExtraReaction(['🚀'], '🦄')).toEqual(['🚀', '🦄']);
  });

  it(`keeps at most ${MAX_EXTRA_REACTIONS}: a 6th drops the oldest and the newest stays`, () => {
    let row: string[] = [];
    for (const e of ['😀', '😁', '😅', '🤣', '😊']) row = addExtraReaction(row, e);
    expect(row).toEqual(['😀', '😁', '😅', '🤣', '😊']);
    row = addExtraReaction(row, '🚀');
    expect(row).toEqual(['😁', '😅', '🤣', '😊', '🚀']);
    expect(row).toHaveLength(MAX_EXTRA_REACTIONS);
  });

  it('moves a repeat pick to the newest position instead of duplicating it', () => {
    const row = ['😀', '😁', '😅', '🤣', '😊'];
    expect(addExtraReaction(row, '😁')).toEqual(['😀', '😅', '🤣', '😊', '😁']);
    expect(addExtraReaction(row, '😊')).toEqual(row); // already newest
    // A repeat at the cap drops nothing.
    expect(addExtraReaction(row, '😀')).toEqual(['😁', '😅', '🤣', '😊', '😀']);
  });

  it('never adds a built-in reaction and leaves the input alone', () => {
    const row = ['🚀'];
    expect(addExtraReaction(row, '👍')).toEqual(['🚀']);
    addExtraReaction(row, '🦄');
    expect(row).toEqual(['🚀']);
  });
});

describe('parseExtraReactions', () => {
  it('keeps picker emojis only, deduped, newest five', () => {
    expect(parseExtraReactions(['🚀', 'hello', '👍', 7, '🚀', '🦄'])).toEqual(['🚀', '🦄']);
    expect(parseExtraReactions(['😀', '😁', '😅', '🤣', '😊', '🚀', '🦄'])).toEqual(['😅', '🤣', '😊', '🚀', '🦄']);
    for (const bad of [null, '🚀', { 0: '🚀' }, undefined]) expect(parseExtraReactions(bad)).toEqual([]);
  });
});

describe('extra reactions storage', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it('starts empty and remembers picks across loads', () => {
    const store = memory();
    expect(loadExtraReactions(store)).toEqual([]);
    let row = pickExtraReaction([], '🚀', store);
    row = pickExtraReaction(row, '🦄', store);
    expect(loadExtraReactions(store)).toEqual(['🚀', '🦄']);
    expect(JSON.parse(store.m.get(EXTRA_REACTIONS_KEY)!)).toEqual(['🚀', '🦄']);
  });

  it('survives junk in storage and blocked storage', () => {
    const store = memory();
    store.setItem(EXTRA_REACTIONS_KEY, '{not json');
    expect(loadExtraReactions(store)).toEqual([]);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadExtraReactions(broken)).toEqual([]);
    expect(pickExtraReaction(['🚀'], '🦄', broken)).toEqual(['🚀', '🦄']);
    expect(loadExtraReactions(null)).toEqual([]);
  });
});
