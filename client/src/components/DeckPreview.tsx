import { deckNotes, parseCustomDeck } from './deck.ts';

/** Live preview of a custom deck as the server will read it, plus a note for anything cut or dropped. */
export function DeckPreview({ input, id }: { input: string; id?: string }) {
  const parsed = parseCustomDeck(input);
  const notes = deckNotes(parsed);
  return (
    <div id={id} className="deck-preview">
      <p className="small">
        <span className="muted">Your deck: </span>
        <strong>{parsed.cards.length ? parsed.cards.join(' · ') : '—'}</strong>
      </p>
      {notes.length > 0 && <p className="small deck-note">{notes.join(' ')}</p>}
    </div>
  );
}
