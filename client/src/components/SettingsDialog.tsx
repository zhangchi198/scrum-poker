import { useEffect, useId, useRef, useState } from 'react';
import { DECK_IDS, DECKS, LIMITS, type DeckId, type ParticipantView, type RoomView } from '../../../shared/protocol.ts';
import { validateCustomInput } from './deck.ts';
import { FeedbackDialog } from './FeedbackDialog.tsx';

const deckLabel = (id: DeckId) => (id === 'custom' ? 'Custom' : DECKS[id].label);

/**
 * Native <dialog> opened with showModal(): the browser provides the focus trap, an inert background,
 * Esc to close and focus return. Every field is applied on Save.
 */
export function SettingsDialog({
  room,
  me,
  onClose,
  onProfile,
  onDeck,
  onLeave,
}: {
  room: RoomView;
  me: ParticipantView;
  onClose: () => void;
  onProfile: (patch: { name?: string; spectator?: boolean }) => void;
  onDeck: (deckId: DeckId, custom?: string[]) => void;
  onLeave: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const customRef = useRef<HTMLInputElement>(null);
  const downOnBackdrop = useRef(false);
  const errorId = useId();
  const [name, setName] = useState(me.name);
  const [spectator, setSpectator] = useState(me.spectator);
  const [deckId, setDeckId] = useState<DeckId>(room.deckId);
  const [custom, setCustom] = useState(room.deckId === 'custom' ? room.cards.join(', ') : '1, 2, 3, 5, 8, ?');
  const [submitted, setSubmitted] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
    nameRef.current?.focus();
  }, []);

  const validation = deckId === 'custom' ? validateCustomInput(custom) : null;
  const deckError = submitted ? (validation?.error ?? null) : null;
  const deckChanged =
    deckId !== room.deckId || (deckId === 'custom' && !!validation && validation.cards.join(',') !== room.cards.join(','));

  function save(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (validation?.error) {
      customRef.current?.focus();
      return;
    }
    const patch: { name?: string; spectator?: boolean } = {};
    if (name.trim() && name.trim() !== me.name) patch.name = name.trim();
    if (spectator !== me.spectator) patch.spectator = spectator;
    if (Object.keys(patch).length) onProfile(patch);
    if (deckChanged) onDeck(deckId, validation ? validation.cards : undefined);
    dialogRef.current?.close();
  }

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog"
      aria-labelledby="settings-title"
      onClose={onClose}
      onMouseDown={(e) => (downOnBackdrop.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current) dialogRef.current?.close();
      }}
    >
      <form className="modal-body" onSubmit={save} noValidate>
        <h2 id="settings-title">Settings</h2>

        <label className="field">
          <span>Your name</span>
          <input ref={nameRef} value={name} maxLength={LIMITS.nameLength} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="check">
          <input type="checkbox" checked={spectator} onChange={(e) => setSpectator(e.target.checked)} />
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
          <div className="field">
            <label htmlFor="custom-cards">
              <span>Cards (comma separated)</span>
            </label>
            <input
              id="custom-cards"
              ref={customRef}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              aria-invalid={deckError ? true : undefined}
              aria-describedby={deckError ? errorId : undefined}
            />
            {deckError && (
              <p id={errorId} className="form-error" role="alert">
                {deckError}
              </p>
            )}
          </div>
        )}
        {deckChanged && <p className="muted small">Changing the deck clears everyone’s votes for this round.</p>}

        <div className="dialog-actions">
          <button type="button" className="btn danger-text" onClick={onLeave}>
            Leave room
          </button>
          <div className="row">
            <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              Save
            </button>
          </div>
        </div>
        <p className="settings-feedback">
          <button type="button" className="link-btn" onClick={() => setFeedbackOpen(true)}>
            Send feedback
          </button>
        </p>
      </form>
      {/* Stacks on top of this dialog in the top layer; closing it returns focus to the button above. */}
      {feedbackOpen && <FeedbackDialog page="room" onClose={() => setFeedbackOpen(false)} />}
    </dialog>
  );
}
