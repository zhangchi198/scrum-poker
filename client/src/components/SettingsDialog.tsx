import { useEffect, useState } from 'react';
import { DECK_IDS, DECKS, LIMITS, type DeckId, type ParticipantView, type RoomView } from '../../../shared/protocol.ts';
import { navigate } from '../lib/router.ts';
import { parseCustomInput } from './deck.ts';

const deckLabel = (id: DeckId) => (id === 'custom' ? 'Custom' : DECKS[id].label);

export function SettingsDialog({
  room,
  me,
  onClose,
  onProfile,
  onDeck,
}: {
  room: RoomView;
  me: ParticipantView;
  onClose: () => void;
  onProfile: (patch: { name?: string; spectator?: boolean }) => void;
  onDeck: (deckId: DeckId, custom?: string[]) => void;
}) {
  const [name, setName] = useState(me.name);
  const [deckId, setDeckId] = useState<DeckId>(room.deckId);
  const [custom, setCustom] = useState(room.deckId === 'custom' ? room.cards.join(', ') : '1, 2, 3, 5, 8, ?');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const deckChanged =
    deckId !== room.deckId || (deckId === 'custom' && parseCustomInput(custom).join(',') !== room.cards.join(','));

  function save() {
    if (name.trim() && name.trim() !== me.name) onProfile({ name: name.trim() });
    if (deckChanged) onDeck(deckId, deckId === 'custom' ? parseCustomInput(custom) : undefined);
    onClose();
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <h2 id="settings-title">Settings</h2>

        <label className="field">
          <span>Your name</span>
          <input value={name} maxLength={LIMITS.nameLength} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="check">
          <input type="checkbox" checked={me.spectator} onChange={(e) => onProfile({ spectator: e.target.checked })} />
          <span>Spectator mode (watch without voting)</span>
        </label>

        <label className="field">
          <span>Deck for this room</span>
          <select value={deckId} onChange={(e) => setDeckId(e.target.value as DeckId)}>
            {DECK_IDS.map((id) => (
              <option key={id} value={id}>
                {deckLabel(id)}
              </option>
            ))}
          </select>
        </label>
        {deckId === 'custom' && (
          <label className="field">
            <span>Cards (comma separated)</span>
            <input value={custom} onChange={(e) => setCustom(e.target.value)} />
          </label>
        )}
        {deckChanged && <p className="muted small">Changing the deck clears everyone’s votes for this round.</p>}

        <div className="row spread">
          <button className="btn danger-text" onClick={() => navigate('/')}>
            Leave room
          </button>
          <div className="row">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" onClick={save}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
