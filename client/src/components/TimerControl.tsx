import { useEffect, useId, useRef, useState } from 'react';
import { TIMER_PRESETS, type TimerView } from '../../../shared/protocol.ts';

function fmt(totalSeconds: number) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Timer picker as a disclosure: a button that reveals ordinary buttons. Tab walks them, Esc closes and returns
 * focus to the toggle, and so do a click elsewhere and tabbing out.
 */
export function TimerControl({
  timer,
  clockOffset,
  onSet,
}: {
  timer: TimerView | null;
  clockOffset: number;
  onSet: (seconds: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!timer) return;
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [timer]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  if (timer) {
    const remaining = (timer.endsAt - (Date.now() + clockOffset)) / 1000;
    const done = remaining <= 0;
    return (
      <div className={`timer running ${done ? 'done' : remaining <= 10 ? 'ending' : ''}`} role="timer">
        <span className="timer-value">{done ? 'Time’s up' : fmt(remaining)}</span>
        <button className="timer-stop" onClick={() => onSet(null)} aria-label="Stop timer" title="Stop timer">
          ×
        </button>
      </div>
    );
  }

  return (
    <div
      className="timer-menu"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          toggleRef.current?.focus();
        }
      }}
      onBlur={(e) => {
        if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button ref={toggleRef} className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={open ? panelId : undefined}>
        ⏱ Timer
      </button>
      {open && (
        <div className="menu" id={panelId} role="group" aria-label="Timer length">
          {TIMER_PRESETS.map((s) => (
            <button
              key={s}
              onClick={() => {
                onSet(s);
                setOpen(false);
              }}
            >
              {s < 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? '' : 's'}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
