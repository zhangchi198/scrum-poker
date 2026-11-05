import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeStats, REACTIONS } from '../../../shared/protocol.ts';
import { loadIdentity, saveIdentity, type Identity } from '../lib/identity.ts';
import { navigate } from '../lib/router.ts';
import { useRoom } from '../lib/useRoom.ts';
import { JoinDialog } from './JoinDialog.tsx';
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
  const [identity, setIdentity] = useState<Identity | null>(() => {
    const id = loadIdentity();
    return id.name ? id : null;
  });
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [shakeKey, setShakeKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  const { room, you, status, fatal, clockOffset, send } = useRoom(roomId, identity, {
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
  const votedCount = players.filter((p) => p.voted).length;
  const onlinePlayers = players.filter((p) => p.connected);
  const pending = onlinePlayers.filter((p) => !p.voted).length;

  const stats = useMemo(() => {
    if (!room?.revealed) return null;
    return computeStats(
      players.map((p) => p.vote).filter((v): v is string => v !== null),
      room.cards,
    );
  }, [room, players]);

  // Celebrate consensus once per round.
  const celebrated = useRef(-1);
  useEffect(() => {
    if (room && stats?.consensus && celebrated.current !== room.round) {
      celebrated.current = room.round;
      for (let i = 0; i < 10; i++) setTimeout(() => float('🎉', ''), i * 90);
    }
  }, [room, stats, float]);

  useEffect(() => {
    document.title = room?.story ? `${room.story} · Scrum Poker` : 'Scrum Poker';
  }, [room?.story]);

  if (!identity) {
    return (
      <JoinDialog
        onJoin={(name, spectator) => setIdentity(saveIdentity({ name, spectator }))}
        onCancel={() => navigate('/')}
      />
    );
  }

  if (fatal) {
    return (
      <div className="center-page">
        <div className="panel">
          <h2>{fatal.code === 'room_full' ? 'Room is full' : 'Room not found'}</h2>
          <p className="muted">{fatal.message}</p>
          <button className="btn primary" onClick={() => navigate('/')}>
            Start a new room
          </button>
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
    setIdentity(saveIdentity(patch));
    send({ t: 'profile', ...patch });
  }

  const canVote = me && !me.spectator && !room.revealed;

  return (
    <div className="room">
      <header className="topbar">
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
        <StoryInput value={room.story} onCommit={(story) => send({ t: 'story', story })} />
        <div className="topbar-actions">
          <TimerControl timer={room.timer} clockOffset={clockOffset} onSet={(seconds) => send({ t: 'timer', seconds })} />
          <button className="btn" onClick={copyInvite}>
            Invite
          </button>
          <button className="btn icon" onClick={() => setSettingsOpen(true)} aria-label="Room settings" title="Settings">
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
                {players.length === 0
                  ? 'Waiting for players…'
                  : votedCount === 0
                    ? 'Pick your cards!'
                    : `${votedCount} of ${players.length} voted`}
              </p>
              <button
                className={`btn primary big ${votedCount > 0 && pending === 0 ? 'pulse' : ''}`}
                disabled={votedCount === 0}
                onClick={() => send({ t: 'reveal' })}
              >
                Reveal cards
              </button>
              {votedCount > 0 && pending > 0 && (
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
              <button className="btn primary big" onClick={() => send({ t: 'reset' })}>
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

      <footer className="dock">
        {me?.spectator ? (
          <div className="dock-note">
            You’re watching.{' '}
            <button className="link-btn" onClick={() => updateProfile({ spectator: false })}>
              Join as a voter
            </button>
          </div>
        ) : (
          <div key={shakeKey} className={`hand ${shakeKey ? 'shake' : ''} ${canVote ? '' : 'locked'}`} role="group" aria-label="Your cards">
            {room.cards.map((card) => {
              const selected = me?.vote === card;
              return (
                <button
                  key={card}
                  className={`card-btn ${selected ? 'selected' : ''}`}
                  disabled={!canVote}
                  aria-pressed={selected}
                  onClick={() => send({ t: 'vote', value: selected ? null : card })}
                >
                  {card}
                </button>
              );
            })}
          </div>
        )}
        <div className="reactions" role="group" aria-label="Reactions">
          {REACTIONS.map((emoji) => (
            <button key={emoji} className="reaction-btn" onClick={() => send({ t: 'react', emoji })} aria-label={`React ${emoji}`}>
              {emoji}
            </button>
          ))}
        </div>
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
          onClose={() => setSettingsOpen(false)}
          onProfile={updateProfile}
          onDeck={(deckId, custom) => send({ t: 'deck', deckId, custom })}
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
