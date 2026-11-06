import { useEffect, useId, useRef, useState } from 'react';
import { REACTIONS } from '../../../shared/protocol.ts';

/**
 * Emoji reactions. On roomy screens the row is always visible; on phones CSS hides it behind the
 * 😀 button and shows it as a popover (closes on pick, outside press, or Esc).
 */
export function Reactions({ onReact }: { onReact: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !wrapRef.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="reactions-wrap" ref={wrapRef}>
      <button
        ref={toggleRef}
        className="reactions-toggle"
        aria-label="Reactions"
        aria-expanded={open}
        aria-controls={popId}
        onClick={() => setOpen((o) => !o)}
      >
        😀
      </button>
      <div id={popId} className={`reactions ${open ? 'open' : ''}`} role="group" aria-label="Reactions">
        {REACTIONS.map((emoji) => (
          <button
            key={emoji}
            className="reaction-btn"
            aria-label={`React ${emoji}`}
            onClick={() => {
              onReact(emoji);
              setOpen(false);
            }}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
