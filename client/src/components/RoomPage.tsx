import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeStats, type RoomLookup } from '../../../shared/protocol.ts';
import { IDENTITY_KEY, loadIdentity, saveIdentity } from '../lib/identity.ts';
import { forgetJoined, hasJoined, markJoined, readSpectator, writeSpectator } from '../lib/joined.ts';
import { navigate } from '../lib/router.ts';
import { nudgeTargets, tallyVotes, voteStatus } from '../lib/tally.ts';
import { useRoom } from '../lib/useRoom.ts';
import { Hand } from './Hand.tsx';
import { JoinDialog } from './JoinDialog.tsx';
import { NotFound } from './NotFound.tsx';
import { Reactions } from './Reactions.tsx';
import { Seat } from './Seat.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { StatsPanel, formatNumber } from './StatsPanel.tsx';
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

export function RoomPage({ roomId }: { roomId: string }) {
  // The join dialog shows on the first visit to a room in this browser (the creator, who typed a name on Home, skips it).
  const [joined, setJoined] = useState(() => !!loadIdentity().name && hasJoined(roomId));
  // Per tab and room, never stored where a later room could inherit it.
  const spectatorRef = useRef(readSpectator(roomId));
  // What the server says about this room, fetched before asking for a name: undefined = still checking.
  const [lookup, setLookup] = useState<RoomLookup | 'missing' | null | undefined>(undefined);
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

  const getJoinInfo = useCallback(() => ({ ...loadIdentity(), spectator: spectatorRef.current }), []);
  const { room, you, status, fatal, joinError, retry, clockOffset, send } = useRoom(roomId, joined, getJoinInfo, {
    onReaction: (r) => float(r.emoji, r.name),
    onNudge: (fromName) => {
      toast(`👋 ${fromName} is waiting on your vote`);
      setShakeKey((k) => k + 1);
      navigator.vibrate?.(200);
      flashTitle('👋 Your vote!');
    },
    onError: (_code, message) => toast(message),
  });

  const me = room?.participants.find((p) => p.id === you) ?? null;
  const players = useMemo(() => room?.participants.filter((p) => !p.spectator) ?? [], [room]);
  const spectators = room?.participants.filter((p) => p.spectator) ?? [];
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
    document.title = room?.story ? `${room.story} · Scrum Poker` : 'Scrum Poker';
  }, [room?.story]);

  // Before asking for a name, check the room exists (and get context for the dialog).
  useEffect(() => {
    if (joined) return;
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
        <div className="center-page">
          <p className="muted">Looking for the room…</p>
        </div>
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
      <div className="center-page">
        <div className="panel">
          <h2>Couldn’t join the room</h2>
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
      </div>
    );
  }

  if (!room) {
    return (
      <div className="center-page">
        <p className="muted">Connecting…</p>
      </div>
    );
  }

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

  const canVote = me && !me.spectator && !room.revealed;

  return (
    <div className="room">
      <header className="topbar" ref={setTopEl}>
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
          <StoryInput value={room.story} onCommit={(story) => send({ t: 'story', story })} />
          {pinned && (
            <button
              className="btn primary pinned-action"
              disabled={!room.revealed && votedCount === 0}
              onClick={() => send({ t: room.revealed ? 'reset' : 'reveal' })}
              title={room.revealed ? 'Start new round' : 'Reveal cards'}
            >
              {room.revealed ? 'New round' : 'Reveal'}
            </button>
          )}
        </div>
        <div className="topbar-actions">
          <TimerControl timer={room.timer} clockOffset={clockOffset} onSet={(seconds) => send({ t: 'timer', seconds })} />
          <button className="btn" onClick={copyInvite}>
            Invite
          </button>
          <button ref={settingsBtn} className="btn icon" onClick={() => setSettingsOpen(true)} aria-label="Room settings" title="Settings">
            ⚙︎
          </button>
        </div>
      </header>

      {status !== 'open' && <div className="banner">Reconnecting…</div>}

      <main className="table-area">
        <div className="seats">
          {top.map((p) => (
            <Seat key={p.id} p={p} isMe={p.id === you} revealed={room.revealed} />
          ))}
        </div>

        <div className={`table ${room.revealed ? 'is-revealed' : ''}`}>
          {!room.revealed ? (
            <>
              <p className="table-status">
                {voteStatus(tally)}
              </p>
              <button
                ref={setActionEl}
                className={`btn primary big ${votedCount > 0 && tally.votedOnline === tally.online ? 'pulse' : ''}`}
                disabled={votedCount === 0}
                onClick={() => send({ t: 'reveal' })}
              >
                Reveal cards
              </button>
              {votedCount > 0 && pending > 0 && !me?.spectator && (
                <button className="link-btn" onClick={() => send({ t: 'nudge' })}>
                  👋 Nudge {pending === 1 ? 'the one who hasn’t' : `the ${pending} who haven’t`} voted
                </button>
              )}
            </>
          ) : (
            <>
              <p className="table-status">
                {stats?.consensus ? 'Consensus!' : stats?.average !== null && stats?.average !== undefined ? 'Average' : 'Most common'}
              </p>
              <p className="table-result">
                {stats?.average !== null && stats?.average !== undefined
                  ? formatNumber(stats.average)
                  : stats?.mostCommon.join(' / ') || '—'}
              </p>
              <button ref={setActionEl} className="btn primary big" onClick={() => send({ t: 'reset' })}>
                Start new round
              </button>
            </>
          )}
        </div>

        <div className="seats">
          {bottom.map((p) => (
            <Seat key={p.id} p={p} isMe={p.id === you} revealed={room.revealed} />
          ))}
        </div>

        {spectators.length > 0 && (
          <p className="spectators">
            👀 Watching: {spectators.map((s) => s.name + (s.id === you ? ' (you)' : '')).join(', ')}
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
                  Your vote: <span className="chip-card">{me.vote}</span>
                </>
              ) : (
                'You didn’t vote'
              )}
            </div>
          ) : (
            <Hand key={shakeKey} cards={room.cards} vote={me?.vote} canVote={!!canVote} shakeKey={shakeKey} onVote={(value) => send({ t: 'vote', value })} />
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

      <div className="toasts" role="status" aria-live="polite">
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
          onLeave={leaveRoom}
        />
      )}
    </div>
  );
}

let titleTimer: ReturnType<typeof setTimeout> | undefined;
function flashTitle(text: string) {
  const original = document.title.startsWith('👋') ? document.title.split(' — ')[1] ?? 'Scrum Poker' : document.title;
  document.title = `${text} — ${original}`;
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => (document.title = original), 6000);
}
