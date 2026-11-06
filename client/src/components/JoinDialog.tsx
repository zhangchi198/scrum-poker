import { useState, type FormEvent } from 'react';
import { LIMITS, type RoomLookup } from '../../../shared/protocol.ts';
import { loadIdentity } from '../lib/identity.ts';

function context(info: RoomLookup | null): string | null {
  if (!info) return null;
  if (info.status === 'revivable') return 'Joining: a planning poker room · nobody here yet';
  const what = info.story || 'a planning poker room';
  const who = info.players === 0 ? 'nobody here yet' : info.players === 1 ? '1 person here' : `${info.players} people here`;
  return `Joining: ${what} · ${who}`;
}

export function JoinDialog({
  info,
  onJoin,
  onCancel,
}: {
  info: RoomLookup | null;
  onJoin: (name: string, spectator: boolean) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(() => loadIdentity().name);
  const [spectator, setSpectator] = useState(false);
  const joining = context(info);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) onJoin(name.trim(), spectator);
  }

  return (
    <main className="center-page">
      <form className="panel join" onSubmit={submit}>
        <h1 className="page-title">Join the room</h1>
        {joining && (
          <p className="join-context" dir="auto">
            {joining}
            {info && <span className="muted small"> · {info.deckLabel}</span>}
          </p>
        )}
        <label className="field">
          <span>Your name</span>
          <input autoFocus value={name} maxLength={LIMITS.nameLength} placeholder="e.g. Alex" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={spectator} onChange={(e) => setSpectator(e.target.checked)} />
          <span>Join as a spectator (watch without voting)</span>
        </label>
        <div className="row">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()}>
            Join
          </button>
        </div>
      </form>
    </main>
  );
}
