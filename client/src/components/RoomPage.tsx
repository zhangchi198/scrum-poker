import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeStats, type RoomLookup } from '../../../shared/protocol.ts';
import { IDENTITY_KEY, loadIdentity, saveIdentity } from '../lib/identity.ts';
import { takeInjectedLookup } from '../lib/injected.ts';
import { forgetJoined, markJoined, readSpectator, resumable, writeSpectator } from '../lib/joined.ts';
import { navigate } from '../lib/router.ts';
import { NEW_ROUND_MESSAGE, progressDelay, revealMessage } from '../lib/announce.ts';
import { watchInteraction, playChime } from '../lib/chime.ts';
import { lockAnnouncement, noticeText, undoToastText } from '../lib/notices.ts';
import { canControl, controlHint } from '../lib/permissions.ts';
import { cardLen, formatNumber } from '../lib/format.ts';
import { displayNames } from '../lib/names.ts';
import { nudgeTargets, tallyVotes, voteStatus } from '../lib/tally.ts';
import { createTitleFlasher } from '../lib/title.ts';
import { useRoom } from '../lib/useRoom.ts';
import { mark, markInlinedLookup, reportSoon, setPageKind } from '../lib/vitals.ts';
import { Hand } from './Hand.tsx';
import { JoinDialog } from './JoinDialog.tsx';
import { NotFound } from './NotFound.tsx';
import { Reactions } from './Reactions.tsx';
import { Seat } from './Seat.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { StatsPanel } from './StatsPanel.tsx';
import { StoryLine } from './StoryLine.tsx';
import { StoryInput } from './StoryInput.tsx';
import { TimerControl } from './TimerControl.tsx';

interface Floater {
  key: number;
  emoji: string;
  name: string;
  x: number;
}
interface Toast {
  key: number;
  text: string;
}

let seq = 0;
const titles = createTitleFlasher(document);
/** Voting progress is announced at most this often (ms), so a burst of votes is one announcement. */
const PROGRESS_GAP = 4000;

export function RoomPage({ roomId }: { roomId: string }) {
  // The join dialog shows on the first visit to a room in this browser (the creator, who typed a name on Home, skips it).
  const [joined, setJoined] = useState(() => resumable(roomId));
  // Per tab and room, never stored where a later room could inherit it.
  const spectatorRef = useRef(readSpectator(roomId));
  // What the server says about this room, fetched before asking for a name: undefined = still checking.
  // An invite link arrives with it already inlined in the HTML, so that round trip is skipped.
  const inlinedLookup = useRef(takeInjectedLookup(roomId));
  const [lookup, setLookup] = useState<RoomLookup | 'missing' | null | undefined>(inlinedLookup.current ?? undefined);
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [shakeKey, setShakeKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsBtn = useRef<HTMLButtonElement>(null);
  const [topEl, setTopEl] = useState<HTMLElement | null>(null);
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  const [actionEl, setActionEl] = useState<HTMLElement | null>(null);
  const [bars, setBars] = useState({ top: 0, dock: 0 });
  const [pinned, setPinned] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const resultRef = useRef<HTMLHeadingElement>(null);
  // Set when this user pressed Reveal / Start new round, so focus follows the change they caused.
  const focusAfterChange = useRef(false);

  const toast = useCallback((text: string) => {
    const key = ++seq;
    setToasts((t) => [...t.slice(-2), { key, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.key !== key)), 3500);
  }, []);

  const float = useCallback((emoji: string, name: string) => {
    const key = ++seq;
    setFloaters((f) => [...f.slice(-30), { key, emoji, name, x: 8 + Math.random() * 84 }]);
    setTimeout(() => setFloaters((f) => f.filter((x) => x.key !== key)), 2800);
  }, []);

  const youRef = useRef<string | null>(null);
  const getJoinInfo = useCallback(() => ({ ...loadIdentity(), spectator: spectatorRef.current }), []);
  const { room, you, status, fatal, joinError, retry, clockOffset, send } = useRoom(roomId, joined, getJoinInfo, {
    onReaction: (r) => float(r.emoji, r.name),
    onNudge: (fromName) => {
      toast(`👋 ${fromName} is waiting on your vote`);
      setShakeKey((k) => k + 1);
      navigator.vibrate?.(200);
      titles.flash('👋 Your vote!');
    },
    onNotice: (n) => toast(noticeText(n, youRef.current)),
    onError: (_code, message) => toast(message),
  });
  youRef.current = you;

  const me = room?.participants.find((p) => p.id === you) ?? null;
  const players = useMemo(() => room?.participants.filter((p) => !p.spectator) ?? [], [room]);
  const spectators = room?.participants.filter((p) => p.spectator) ?? [];
  const labels = useMemo(() => displayNames(room?.participants ?? []), [room?.participants]);
  const tally = tallyVotes(players);
  const votedCount = tally.voted;
  const pending = nudgeTargets(room?.participants ?? [], you);

  // A voter who switched to spectator after the reveal keeps their vote in the results.
  const stats = useMemo(() => {
    if (!room?.revealed) return null;
    return computeStats(
      room.participants.map((p) => p.vote).filter((v): v is string => v !== null),
      room.cards,
    );
  }, [room]);

  // Celebrate consensus once per round.
  const celebrated = useRef(-1);
  useEffect(() => {
    if (room && stats?.consensus && celebrated.current !== room.round) {
      celebrated.current = room.round;
      for (let i = 0; i < 10; i++) setTimeout(() => float('🎉', ''), i * 90);
    }
  }, [room, stats, float]);

  // Focus: after a reveal or a new round the button that was pressed is gone, so move focus somewhere useful
  // instead of letting it fall to <body>. Changes made by someone else only move focus if it was lost.
  const statsRef = useRef(stats);
  statsRef.current = stats;
  const prevRevealed = useRef<boolean | null>(null);
  const lastAnnounced = useRef(0);
  const revealed = room?.revealed ?? null;
  useEffect(() => {
    if (revealed === null) return;
    const was = prevRevealed.current;
    prevRevealed.current = revealed;
    if (was === null || was === revealed) return;
    // Spoken first, and it holds back the progress announcements for a moment.
    lastAnnounced.current = Date.now();
    setAnnouncement(revealed ? revealMessage(statsRef.current) : NEW_ROUND_MESSAGE);
    const active = document.activeElement;
    const lost = !active || active === document.body || !document.body.contains(active);
    const mine = focusAfterChange.current;
    focusAfterChange.current = false;
    if (!mine && !lost) return;
    if (revealed) resultRef.current?.focus();
    else (dockEl?.querySelector<HTMLElement>('.card-btn.selected:not(:disabled), .card-btn:not(:disabled)') ?? actionEl)?.focus();
  }, [revealed, dockEl, actionEl]);

  // Voting progress for screen readers: the latest status, at most once per PROGRESS_GAP.
  const progress = voteStatus(tally);
  const progressSeen = useRef<string | null>(null);
  useEffect(() => {
    if (revealed !== false) return;
    const first = progressSeen.current === null;
    progressSeen.current = progress;
    if (first || tally.votedOnline === 0) return;
    const id = setTimeout(() => {
      lastAnnounced.current = Date.now();
      setAnnouncement(progress);
    }, progressDelay(lastAnnounced.current, Date.now(), PROGRESS_GAP));
    return () => clearTimeout(id);
  }, [progress, revealed, tally.votedOnline]);

  // Publish the sticky bars' heights (CSS uses them for scroll padding and toast position).
  useEffect(() => {
    if (!topEl || !dockEl) return;
    const apply = () => {
      const top = topEl.offsetHeight;
      const dock = dockEl.offsetHeight;
      const root = document.documentElement.style;
      root.setProperty('--top-h', `${top}px`);
      root.setProperty('--dock-h', `${dock}px`);
      setBars((b) => (b.top === top && b.dock === dock ? b : { top, dock }));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(topEl);
    ro.observe(dockEl);
    return () => ro.disconnect();
  }, [topEl, dockEl]);

  // Pin a compact copy of the table's main action to the top bar once the real one scrolls out of view.
  useEffect(() => {
    if (!actionEl) {
      setPinned(false);
      return;
    }
    // "Out of view" means mostly hidden, so a button peeking out from under the bars still gets pinned.
    const io = new IntersectionObserver(([entry]) => setPinned(!!entry && (!entry.isIntersecting || entry.intersectionRatio < 0.6)), {
      rootMargin: `-${bars.top}px 0px -${bars.dock}px 0px`,
      threshold: [0, 0.6],
    });
    io.observe(actionEl);
    return () => io.disconnect();
  }, [actionEl, bars]);

  useEffect(() => {
    titles.setBase(room?.story ? `${room.story} · Scrum Poker` : 'Scrum Poker');
  }, [room?.story]);

  // Sound can only start after a gesture; the flashing title stops as soon as the tab is looked at again.
  useEffect(() => {
    const stopWatching = watchInteraction();
    const back = () => !document.hidden && titles.clear();
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      stopWatching();
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, []);

  const onTimeUp = useCallback(() => {
    playChime();
    if (document.hidden || !document.hasFocus()) titles.flash('\u23f0 Time\u0027s up', Infinity);
  }, []);

  // The Undo toast lives as long as the server's window; re-render when it closes.
  const undo = room?.undo ?? null;
  const [, setUndoTick] = useState(0);
  const undoUntil = undo?.until ?? null;
  const clockOffsetRef = useRef(clockOffset);
  clockOffsetRef.current = clockOffset;
  useEffect(() => {
    if (undoUntil === null) return;
    const id = setTimeout(() => setUndoTick((n) => n + 1), Math.max(0, undoUntil - (Date.now() + clockOffsetRef.current)) + 50);
    return () => clearTimeout(id);
  }, [undoUntil]);
  const undoOpen = !!undo && undo.until > Date.now() + clockOffset;

  // Say it out loud when the facilitator lock turns on, off, or changes hands.
  const prevLock = useRef<{ locked: boolean; facilitatorId: string | null } | null>(null);
  const locked = room?.locked ?? null;
  const facilitatorId = room?.facilitatorId ?? null;
  const participantsRef = useRef(room?.participants);
  participantsRef.current = room?.participants;
  useEffect(() => {
    if (locked === null) return;
    const next = { locked, facilitatorId };
    const prev = prevLock.current;
    prevLock.current = next;
    if (!prev) return;
    const msg = lockAnnouncement(prev, next, (id) => participantsRef.current?.find((p) => p.id === id)?.name ?? 'Someone', youRef.current);
    if (msg) {
      lastAnnounced.current = Date.now();
      setAnnouncement(msg);
    }
  }, [locked, facilitatorId]);

  // Before asking for a name, check the room exists (and get context for the dialog).
  useEffect(() => {
    if (joined || inlinedLookup.current) return;
    const ctl = new AbortController();
    fetch(`/api/rooms/${roomId}`, { signal: ctl.signal })
      .then(async (res) => {
        if (res.status === 404) return setLookup('missing');
        if (!res.ok) return setLookup(null); // rate limited etc.: just show the dialog without context
        setLookup((await res.json()) as RoomLookup);
      })
      .catch(() => {
        if (!ctl.signal.aborted) setLookup(null);
      });
    return () => ctl.abort();
  }, [joined, roomId]);

  // Timing milestones for the real-user beacon (see lib/vitals.ts).
  useEffect(() => {
    if (lookup === undefined) return;
    mark('lookup');
    if (inlinedLookup.current) markInlinedLookup();
    if (joined) return;
    setPageKind(lookup === 'missing' ? 'other' : 'join');
    if (lookup !== 'missing') reportSoon(1500); // the join dialog is the invitee's "interactive"
  }, [lookup, joined]);
  const hasRoom = room !== null;
  useEffect(() => {
    if (!hasRoom) return;
    mark('hand');
    setPageKind('room');
    reportSoon();
  }, [hasRoom]);

  // Another tab changed the name: pick it up here and tell the room.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== IDENTITY_KEY) return;
      const name = loadIdentity().name;
      if (name && joined) send({ t: 'profile', name });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [joined, send]);

  if (!joined) {
    if (lookup === undefined) {
      return (
        <main className="center-page">
          <h1 className="sr-only">Scrum Poker</h1>
          <p className="muted">Looking for the room…</p>
        </main>
      );
    }
    if (lookup === 'missing') {
      return <NotFound title="Room not found" message="This room does not exist or has expired." action="Start a new room" />;
    }
    return (
      <JoinDialog
        info={lookup}
        onJoin={(name, spectator) => {
          saveIdentity({ name });
          spectatorRef.current = spectator;
          writeSpectator(roomId, spectator);
          markJoined(roomId);
          setJoined(true);
        }}
        onCancel={() => navigate('/')}
      />
    );
  }

  if (fatal) {
    return <NotFound title={fatal.code === 'room_full' ? 'Room is full' : 'Room not found'} message={fatal.message} action="Start a new room" />;
  }

  if (joinError) {
    return (
      <main className="center-page">
        <div className="panel">
          <h1 className="page-title">Couldn’t join the room</h1>
          <p className="muted" role="alert">
            {joinError}
          </p>
          <div className="row">
            <button className="btn" onClick={() => navigate('/')}>
              Home
            </button>
            <button className="btn primary" autoFocus onClick={retry}>
              Try again
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (!room) {
    return (
      <main className="center-page">
        <h1 className="sr-only">Scrum Poker</h1>
        <p className="muted">Connecting…</p>
      </main>
    );
  }

  const can = canControl(room, you);
  const iAmFacilitator = room.locked && room.facilitatorId === you;
  const revealHint = controlHint(room, you, 'reveal');
  const resetHint = controlHint(room, you, 'start a new round');
  const seatProps = (p: (typeof players)[number]) => ({
    isFacilitator: room.locked && p.id === room.facilitatorId,
    clockOffset,
    onMakeFacilitator: iAmFacilitator && p.id !== you && p.connected ? () => send({ t: 'facilitator', id: p.id }) : undefined,
    onRemove: !p.connected && can ? () => send({ t: 'remove', id: p.id }) : undefined,
  });
  const half = Math.ceil(players.length / 2);
  const top = players.slice(0, half);
  const bottom = players.slice(half);

  async function copyInvite() {
    const url = `${location.origin}/r/${roomId}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied');
    } catch {
      window.prompt('Copy this invite link:', url);
    }
  }

  function updateProfile(patch: { name?: string; spectator?: boolean }) {
    if (patch.name) saveIdentity({ name: patch.name });
    if (patch.spectator !== undefined) {
      spectatorRef.current = patch.spectator;
      writeSpectator(roomId, patch.spectator);
    }
    send({ t: 'profile', ...patch });
  }

  function leaveRoom() {
    send({ t: 'leave' });
    forgetJoined(roomId);
    navigate('/');
  }

  const canVote = me && !me.spectator && !room.revealed && status === 'open';
  const revealOrReset = (t: 'reveal' | 'reset') => {
    focusAfterChange.current = true;
    send({ t });
  };

  return (
    <div className="room">
      <header className="topbar" ref={setTopEl}>
        <h1 className="sr-only">Scrum Poker room{room.story ? `: ${room.story}` : ''}</h1>
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
          aria-label="Scrum Poker home"
        >
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span>Scrum Poker</span>
        </a>
        <div className="topbar-story">
          <StoryInput value={room.story} onCommit={(story) => send({ t: 'story', story })} lockedHint={controlHint(room, you, 'edit the story')} />
          {pinned && (
            <button
              className="btn primary pinned-action"
              disabled={!can || (!room.revealed && votedCount === 0)}
              onClick={() => revealOrReset(room.revealed ? 'reset' : 'reveal')}
              title={(room.revealed ? resetHint : revealHint) ?? (room.revealed ? 'Start new round' : 'Reveal cards')}
            >
              {room.revealed ? 'New round' : 'Reveal'}
            </button>
          )}
        </div>
        <div className="topbar-actions">
          <TimerControl
            timer={room.timer}
            clockOffset={clockOffset}
            onSet={(seconds) => send({ t: 'timer', seconds })}
            lockedHint={controlHint(room, you, 'run the timer')}
            onTimeUp={onTimeUp}
          />
          <button className="btn" onClick={copyInvite}>
            Invite
          </button>
          <button ref={settingsBtn} className="btn icon" onClick={() => setSettingsOpen(true)} aria-label="Room settings" title="Settings">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      <div role="status">{status !== 'open' && <div className="banner">Reconnecting…</div>}</div>

      <main className="table-area">
        <StoryLine story={room.story} />
        <ul className="seats" role="list" aria-label="Players">
          {top.map((p) => (
            <Seat key={p.id} p={p} name={labels.get(p.id) ?? p.name} isMe={p.id === you} revealed={room.revealed} {...seatProps(p)} />
          ))}
        </ul>

        <div className={`table ${room.revealed ? 'is-revealed' : ''}`}>
          {!room.revealed ? (
            <>
              <p className="table-status">
                {voteStatus(tally)}
              </p>
              <button
                ref={setActionEl}
                className={`btn primary big ${votedCount > 0 && tally.votedOnline === tally.online ? 'pulse' : ''}`}
                disabled={!can || votedCount === 0}
                aria-describedby={revealHint ? 'control-hint' : undefined}
                onClick={() => revealOrReset('reveal')}
              >
                Reveal cards
              </button>
              {revealHint && (
                <p id="control-hint" className="control-hint">
                  {revealHint}
                </p>
              )}
              {votedCount > 0 && pending > 0 && !me?.spectator && (
                <button className="link-btn" onClick={() => send({ t: 'nudge' })}>
                  👋 Nudge {pending === 1 ? 'the one who hasn’t' : `the ${pending} who haven’t`} voted
                </button>
              )}
            </>
          ) : (
            <>
              <h2 className="table-heading" ref={resultRef} tabIndex={-1}>
                <span className="table-status">
                  {stats?.consensus ? 'Consensus!' : stats?.average !== null && stats?.average !== undefined ? 'Average' : 'Most common'}
                </span>{' '}
                <span className="table-result" dir="auto">
                  {stats?.average !== null && stats?.average !== undefined
                    ? formatNumber(stats.average)
                    : stats?.mostCommon.join(' / ') || '—'}
                </span>
              </h2>
              <button
                ref={setActionEl}
                className="btn primary big"
                disabled={!can}
                aria-describedby={resetHint ? 'control-hint' : undefined}
                onClick={() => revealOrReset('reset')}
              >
                Start new round
              </button>
              {resetHint && (
                <p id="control-hint" className="control-hint">
                  {resetHint}
                </p>
              )}
            </>
          )}
        </div>

        <ul className="seats" role="list" aria-label="More players">
          {bottom.map((p) => (
            <Seat key={p.id} p={p} name={labels.get(p.id) ?? p.name} isMe={p.id === you} revealed={room.revealed} tipAbove {...seatProps(p)} />
          ))}
        </ul>

        {spectators.length > 0 && (
          <p className="spectators">
            👀 Watching:{' '}
            {spectators.map((s, i) => (
              <span key={s.id}>
                {i > 0 && ', '}
                <bdi>{labels.get(s.id) ?? s.name}</bdi>
                {s.id === you ? ' (you)' : ''}
                {room.locked && s.id === room.facilitatorId ? ' (facilitator)' : ''}
              </span>
            ))}
          </p>
        )}

        {stats && stats.total > 0 && <StatsPanel stats={stats} />}
      </main>

      <footer className="dock" ref={setDockEl}>
        <div className="dock-main">
          {me?.spectator ? (
            <div className="dock-note">
              You’re watching.{' '}
              <button className="link-btn" onClick={() => updateProfile({ spectator: false })}>
                Join as a voter
              </button>
            </div>
          ) : room.revealed ? (
            <div className="vote-chip">
              {me?.vote ? (
                <>
                  Your vote:{' '}
                  <span className="chip-card" data-len={cardLen(me.vote)}>
                    {me.vote}
                  </span>
                </>
              ) : (
                'You didn’t vote'
              )}
            </div>
          ) : (
            <>
              {status !== 'open' && <p className="hand-hint">Reconnecting… cards are paused</p>}
              <Hand key={shakeKey} cards={room.cards} vote={me?.vote} canVote={!!canVote} shakeKey={shakeKey} onVote={(value) => send({ t: 'vote', value })} />
            </>
          )}
        </div>
        <Reactions onReact={(emoji) => send({ t: 'react', emoji })} />
      </footer>

      <div className="floaters" aria-hidden>
        {floaters.map((f) => (
          <div key={f.key} className="floater" style={{ left: `${f.x}%` }}>
            <span className="floater-emoji">{f.emoji}</span>
            {f.name && <span className="floater-name">{f.name}</span>}
          </div>
        ))}
      </div>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      <div className="toasts" role="status" aria-live="polite">
        {undo && undoOpen && (
          <div className="toast with-action" key={`undo-${undo.kind}-${undo.until}`}>
            <span dir="auto">{undoToastText(undo, you)}</span>
            {can && (
              <>
                <span aria-hidden="true"> · </span>
                <button type="button" className="toast-btn" onClick={() => send({ t: 'undo' })}>
                  Undo
                </button>
              </>
            )}
          </div>
        )}
        {toasts.map((t) => (
          <div key={t.key} className="toast">
            {t.text}
          </div>
        ))}
      </div>

      {settingsOpen && me && (
        <SettingsDialog
          room={room}
          me={me}
          onClose={() => {
            setSettingsOpen(false);
            settingsBtn.current?.focus();
          }}
          onProfile={updateProfile}
          onDeck={(deckId, custom) => send({ t: 'deck', deckId, custom })}
          onLock={(on) => send({ t: 'lock', on })}
          onLeave={leaveRoom}
        />
      )}
    </div>
  );
}
