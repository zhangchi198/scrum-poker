import { describe, expect, it, vi } from 'vitest';
import type { ParticipantView } from '../shared/protocol.ts';
import { deckNotes, parseCustomDeck, validateCustomInput } from '../client/src/components/deck.ts';
import { NEW_ROUND_MESSAGE, progressDelay, revealMessage } from '../client/src/lib/announce.ts';
import { cardLen, formatNumber } from '../client/src/lib/format.ts';
import { displayNames } from '../client/src/lib/names.ts';
import { createTitleFlasher } from '../client/src/lib/title.ts';
import { computeStats } from '../shared/protocol.ts';
import { graphemeLength, sliceGraphemes } from '../shared/text.ts';
import { parseInvite, roomIdFromPath } from '../client/src/lib/invite.ts';
import { JOINED_CAP, addJoined } from '../client/src/lib/joined.ts';
import { blurResult, draftForRemote } from '../client/src/lib/story.ts';
import { nudgeTargets, tallyVotes, voteStatus } from '../client/src/lib/tally.ts';

const ID = 'abcdefghij'; // 10 base58 characters
const HOST = 'poker.example.com';

describe('parseInvite', () => {
  it('accepts a link to this host, with optional slash, query and hash', () => {
    for (const link of [
      `https://${HOST}/r/${ID}`,
      `https://${HOST}/r/${ID}/`,
      `https://${HOST}/r/${ID}?utm=x`,
      `https://${HOST}/r/${ID}#top`,
      `https://${HOST}/r/${ID}/?a=1#b`,
      `  http://${HOST}/r/${ID}\n`,
      `HTTPS://POKER.EXAMPLE.COM/r/${ID}`,
    ]) {
      expect(parseInvite(link, HOST), link).toBe(ID);
    }
  });

  it('accepts a bare id', () => {
    expect(parseInvite(ID, HOST)).toBe(ID);
    expect(parseInvite(`  ${ID} `, HOST)).toBe(ID);
  });

  it('rejects other hosts, other paths, and strings that merely end in an id', () => {
    for (const bad of [
      `https://example.com/r/${ID}`,
      `https://example.com/${ID}`,
      `https://${HOST}/${ID}`,
      `https://${HOST}/x/r/${ID}`,
      `https://${HOST}/r/${ID}/extra`,
      `https://${HOST}.evil.com/r/${ID}`,
      `https://${HOST}:8443/r/${ID}`,
      `javascript:alert(1)//${HOST}/r/${ID}`,
      `see ${ID}`,
      `xx${ID}`,
      `${ID}x`,
      `abcdefghi`, // 9 characters
      `abcdefghIl`, // l and I are not base58
      '',
    ]) {
      expect(parseInvite(bad, HOST), bad).toBeNull();
    }
  });
});

describe('roomIdFromPath', () => {
  it('matches only /r/<valid id>', () => {
    expect(roomIdFromPath(`/r/${ID}`)).toBe(ID);
    expect(roomIdFromPath(`/r/${ID}/`)).toBe(ID);
    for (const bad of ['/', '/r/', `/r/${ID}x`, `/x/${ID}`, '/about', '/r/abc']) expect(roomIdFromPath(bad), bad).toBeNull();
  });
});

describe('addJoined', () => {
  it('moves a repeat to the end and keeps only the last 50', () => {
    expect(addJoined(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a']);
    let list: string[] = [];
    for (let i = 0; i < JOINED_CAP + 20; i++) list = addJoined(list, `room${i}`);
    expect(list).toHaveLength(JOINED_CAP);
    expect(list[0]).toBe('room20');
    expect(list.at(-1)).toBe(`room${JOINED_CAP + 19}`);
  });
});

function p(id: string, o: Partial<ParticipantView> = {}): ParticipantView {
  return { id, name: id, spectator: false, connected: true, voted: false, vote: null, ...o };
}

describe('vote tally and nudge targets', () => {
  const people = [p('me'), p('b', { voted: true }), p('c', { voted: true }), p('d', { voted: true }), p('off', { connected: false })];

  it('counts only connected voters and lists offline ones separately', () => {
    const t = tallyVotes(people);
    expect(t).toEqual({ online: 4, votedOnline: 3, offline: 1, voted: 3 });
    expect(voteStatus(t)).toBe('3 of 4 voted · 1 offline');
  });

  it('does not count an offline voter in "X of Y", but still counts their vote for the reveal', () => {
    const t = tallyVotes([p('a', { voted: true }), p('b', { connected: false, voted: true })]);
    expect(voteStatus(t)).toBe('1 of 1 voted · 1 offline');
    expect(t.voted).toBe(2);
  });

  it('has sensible empty states', () => {
    expect(voteStatus(tallyVotes([]))).toBe('Waiting for players…');
    expect(voteStatus(tallyVotes([p('a'), p('b')]))).toBe('Pick your cards!');
    expect(voteStatus(tallyVotes([p('a', { connected: false })]))).toBe('Nobody is online · 1 offline');
  });

  it('nudge targets exclude yourself, spectators, offline and people who voted', () => {
    expect(nudgeTargets(people, 'me')).toBe(0); // you are the only non-voter
    expect(nudgeTargets(people, 'someone-else')).toBe(1);
    expect(nudgeTargets([...people, p('s', { spectator: true })], 'someone-else')).toBe(1);
    expect(nudgeTargets([p('me'), p('x')], 'me')).toBe(1);
  });
});

describe('story box', () => {
  it('follows remote changes while focused but untouched, and protects text you typed', () => {
    expect(draftForRemote('old', 'remote', true, false)).toBe('remote');
    expect(draftForRemote('old', 'remote', false, false)).toBe('remote');
    expect(draftForRemote('mine', 'remote', true, true)).toBe('mine');
  });

  it('commits on blur only after an edit, otherwise adopts the latest remote value', () => {
    expect(blurResult('stale', 'fresh', false)).toEqual({ commit: null, draft: 'fresh' });
    expect(blurResult('mine', 'fresh', true)).toEqual({ commit: 'mine', draft: 'mine' });
  });
});

const FAMILY = '👨‍👩‍👧';

describe('duplicate display names (R-8)', () => {
  const label = (names: string[]) => [...displayNames(names.map((name, i) => ({ id: String(i), name }))).values()];

  it('keeps the first as typed and numbers later ones in participant order', () => {
    expect(label(['Alex', 'Sam', 'Alex', 'alex', 'Alex'])).toEqual(['Alex', 'Sam', 'Alex (2)', 'alex (3)', 'Alex (4)']);
  });

  it('leaves unique names alone and never collides with a real "Alex (2)"', () => {
    expect(label(['Ann', 'Bob'])).toEqual(['Ann', 'Bob']);
    expect(label(['Alex', 'Alex (2)', 'Alex'])).toEqual(['Alex', 'Alex (2)', 'Alex (3)']);
  });
});

describe('custom deck parsing by grapheme (F-9)', () => {
  it('cuts values at 4 user-perceived characters, not 4 UTF-16 units', () => {
    expect(parseCustomDeck(`${FAMILY.repeat(5)}, XXL?`).cards).toEqual([FAMILY.repeat(4), 'XXL?']);
    expect(graphemeLength(FAMILY)).toBe(1);
    expect(sliceGraphemes('é👍👍👍👍', 3)).toBe('é👍👍');
  });

  it('reports what it truncated, dropped and de-duplicated', () => {
    const p = parseCustomDeck('1000000, 2, 2, ' + Array.from({ length: 20 }, (_, i) => `c${i}`).join(','));
    expect(p.truncated).toEqual(['1000000']);
    expect(p.duplicates).toBe(1);
    expect(p.cards).toHaveLength(16);
    expect(p.dropped).toBe(6);
    expect(deckNotes(p).join(' ')).toMatch(/Cut to 4 characters.*1000000.*Only the first 16.*6 dropped.*1 repeated card removed/);
    expect(deckNotes(parseCustomDeck('1, 2, 3'))).toEqual([]);
  });

  it('validation measures graphemes too', () => {
    expect(validateCustomInput(`${FAMILY.repeat(4)}, 1`).error).toBeNull();
    expect(validateCustomInput(`${FAMILY.repeat(5)}, 1`).error).toMatch(/longer than 4/);
  });
});

describe('number and card formatting', () => {
  it('shows up to 2 decimals only when needed', () => {
    expect(formatNumber(1.1666)).toBe('1.17');
    expect(formatNumber(5.0)).toBe('5');
    expect(formatNumber(5.2)).toBe('5.2');
    expect(formatNumber(0.5)).toBe('0.5');
    expect(formatNumber(8.999)).toBe('9');
  });

  it('buckets card values by length for font shrinking', () => {
    expect([cardLen('5'), cardLen('13'), cardLen('100'), cardLen('XXL?'), cardLen('ABCDEFG'), cardLen(FAMILY)]).toEqual([1, 2, 3, 4, 4, 1]);
  });
});

describe('live-region messages (V-6)', () => {
  it('summarises a reveal with average, median, agreement and vote count', () => {
    const stats = computeStats(['3', '5', '8'], ['3', '5', '8']);
    expect(revealMessage(stats)).toBe('Cards revealed. Average 5.33, median 5, agreement 33%, 3 votes.');
  });

  it('calls out consensus, non-numeric rounds and empty rounds', () => {
    expect(revealMessage(computeStats(['5', '5'], ['5']))).toBe('Cards revealed. Consensus on 5, 2 votes.');
    expect(revealMessage(computeStats(['XL', 'M', 'XL'], ['M', 'XL']))).toBe('Cards revealed. Most common XL, agreement 67%, 3 votes.');
    expect(revealMessage(computeStats([], ['5']))).toBe('Cards revealed. Nobody voted.');
    expect(revealMessage(computeStats(['5'], ['5']))).toContain('1 vote.');
    expect(NEW_ROUND_MESSAGE).toMatch(/^New round/);
  });

  it('throttles progress announcements to the minimum gap', () => {
    expect(progressDelay(1000, 1500, 4000)).toBe(3500);
    expect(progressDelay(1000, 5000, 4000)).toBe(0);
    expect(progressDelay(0, 10_000, 4000)).toBe(0);
  });
});

describe('title flash', () => {
  it('restores a story title that contains " — " exactly', () => {
    vi.useFakeTimers();
    try {
      const doc = { title: 'Fix A — B · Scrum Poker' };
      const flasher = createTitleFlasher(doc, 6000);
      flasher.flash('👋 Your vote!');
      expect(doc.title).toBe('👋 Your vote! — Fix A — B · Scrum Poker');
      flasher.flash('👋 Your vote!'); // a second nudge must not nest
      vi.advanceTimersByTime(6000);
      expect(doc.title).toBe('Fix A — B · Scrum Poker');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the flash when the story changes underneath it', () => {
    vi.useFakeTimers();
    try {
      const doc = { title: 'Old · Scrum Poker' };
      const flasher = createTitleFlasher(doc, 6000);
      flasher.flash('👋');
      flasher.setBase('New — story · Scrum Poker');
      expect(doc.title).toBe('👋 — New — story · Scrum Poker');
      vi.advanceTimersByTime(6000);
      expect(doc.title).toBe('New — story · Scrum Poker');
      flasher.setBase('Plain');
      expect(doc.title).toBe('Plain');
    } finally {
      vi.useRealTimers();
    }
  });
});
