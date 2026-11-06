import { describe, expect, it } from 'vitest';
import type { ParticipantView } from '../shared/protocol.ts';
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
