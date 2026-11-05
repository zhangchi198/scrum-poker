import { useState, type FormEvent } from 'react';
import { LIMITS } from '../../../shared/protocol.ts';
import { loadIdentity } from '../lib/identity.ts';

export function JoinDialog({ onJoin, onCancel }: { onJoin: (name: string, spectator: boolean) => void; onCancel: () => void }) {
  const [name, setName] = useState(() => loadIdentity().name);
  const [spectator, setSpectator] = useState(() => loadIdentity().spectator);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) onJoin(name.trim(), spectator);
  }

  return (
    <div className="center-page">
      <form className="panel join" onSubmit={submit}>
        <h2>Join the room</h2>
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
    </div>
  );
}
