import { useEffect, useState, type FormEvent } from 'react';
import { DECKS, LIMITS, type DeckId } from '../../../shared/protocol.ts';
import { loadIdentity, saveIdentity } from '../lib/identity.ts';
import { parseInvite } from '../lib/invite.ts';
import { markJoined } from '../lib/joined.ts';
import { navigate } from '../lib/router.ts';
import { setPageKind } from '../lib/vitals.ts';
import { parseCustomInput } from './deck.ts';
import { DeckPreview } from './DeckPreview.tsx';
import { FeedbackDialog } from './FeedbackDialog.tsx';

const DECK_CHOICES: { id: DeckId; label: string; preview: string }[] = [
  ...Object.entries(DECKS).map(([id, d]) => ({
    id: id as DeckId,
    label: d.label,
    preview: d.cards.filter((c) => c !== '?' && c !== '☕').slice(0, 7).join(' · ') + ' …',
  })),
  { id: 'custom', label: 'Custom', preview: 'Your own values' },
];

export function Home() {
  const [name, setName] = useState(() => loadIdentity().name);
  const [deckId, setDeckId] = useState<DeckId>('fibonacci');
  const [custom, setCustom] = useState('1, 2, 3, 5, 8, ?');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  useEffect(() => setPageKind('home'), []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (name.trim()) saveIdentity({ name: name.trim() });
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deckId === 'custom' ? { deckId, custom: parseCustomInput(custom) } : { deckId }),
      });
      const body = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !body.id) throw new Error(body.error ?? 'Could not create a room.');
      // The creator just typed their name here, so skip the join dialog for this room.
      if (name.trim()) markJoined(body.id);
      navigate(`/r/${body.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  function join(e: FormEvent) {
    e.preventDefault();
    const id = parseInvite(joinCode, location.host);
    if (id) {
      if (name.trim()) saveIdentity({ name: name.trim() });
      navigate(`/r/${id}`);
    } else setError('That doesn’t look like a room link.');
  }

  return (
    <main className="home">
      <div className="home-hero">
        <div className="hero-cards" aria-hidden>
          <span className="mini-card c1">2</span>
          <span className="mini-card c2">5</span>
          <span className="mini-card c3">3</span>
        </div>
        <h1>Scrum Poker</h1>
        <p className="lede">Estimate stories together in real time. Votes stay hidden until everyone reveals, so nobody anchors.</p>
      </div>

      <form className="panel" onSubmit={create}>
        <h2>Start a room</h2>
        <label className="field">
          <span>Your name</span>
          <input value={name} maxLength={LIMITS.nameLength} placeholder="e.g. Alex" onChange={(e) => setName(e.target.value)} />
        </label>

        <fieldset className="field">
          <legend>Deck</legend>
          <div className="deck-grid">
            {DECK_CHOICES.map((d) => (
              <label key={d.id} className={`deck-option ${deckId === d.id ? 'selected' : ''}`}>
                <input type="radio" name="deck" value={d.id} checked={deckId === d.id} onChange={() => setDeckId(d.id)} />
                <strong>{d.label}</strong>
                <small>{d.preview}</small>
              </label>
            ))}
          </div>
        </fieldset>

        {deckId === 'custom' && (
          <div className="field">
            <label htmlFor="home-custom">
              <span>Cards (comma separated, up to {LIMITS.customCards}, {LIMITS.customCardLength} characters each)</span>
            </label>
            <input id="home-custom" value={custom} aria-describedby="home-custom-preview" onChange={(e) => setCustom(e.target.value)} />
            <DeckPreview id="home-custom-preview" input={custom} />
          </div>
        )}

        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn primary big" disabled={busy}>
          {busy ? 'Creating…' : 'Create room'}
        </button>
      </form>

      <form className="panel slim" onSubmit={join}>
        <label className="field inline">
          <span>Got an invite?</span>
          <input value={joinCode} placeholder="Paste the room link" onChange={(e) => setJoinCode(e.target.value)} />
        </label>
        <button className="btn">Join</button>
      </form>

      <p className="footnote">No accounts. Rooms stay around for 30 days of inactivity, so bookmark your room link.</p>
      <p className="footnote">
        <button type="button" className="link-btn" onClick={() => setFeedbackOpen(true)}>
          Send feedback
        </button>
      </p>
      {feedbackOpen && <FeedbackDialog page="home" onClose={() => setFeedbackOpen(false)} />}
    </main>
  );
}
