import { useEffect, useId, useRef, useState } from 'react';
import { TIMER_PRESETS, type TimerView } from '../../../shared/protocol.ts';
import { chimeEnabled, setChimeEnabled } from '../lib/chime.ts';

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
  lockedHint,
  onTimeUp,
}: {
  timer: TimerView | null;
  clockOffset: number;
  onSet: (seconds: number | null) => void;
  /** Set when the facilitator lock keeps this person from running the timer: "Only Alex can run the timer". */
  lockedHint?: string | null;
  /** Called once when a timer this viewer watched running reaches zero. */
  onTimeUp?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [chime, setChime] = useState(() => chimeEnabled());
  const seenRunning = useRef<number | null>(null);
  const fired = useRef<number | null>(null);
  const remainingNow = timer ? (timer.endsAt - (Date.now() + clockOffset)) / 1000 : 1;
  const isDone = !!timer && remainingNow <= 0;
  const endsAt = timer?.endsAt ?? null;
  const locked = !!lockedHint;

  // Time's up: only for a timer this viewer saw counting down, so opening a room with an old timer stays quiet.
  useEffect(() => {
    if (endsAt === null) return;
    if (!isDone) seenRunning.current = endsAt;
    else if (seenRunning.current === endsAt && fired.current !== endsAt) {
      fired.current = endsAt;
      onTimeUp?.();
    }
  }, [endsAt, isDone, onTimeUp]);

  const toggleChime = () => {
    setChime(!chime);
    setChimeEnabled(!chime);
  };
  const chimeBtn = (cls: string, text?: string) => (
    <button
      type="button"
      className={cls}
      onClick={toggleChime}
      {...(text ? {} : { 'aria-pressed': chime, 'aria-label': 'Timer chime' })}
      title={chime ? 'Chime on (click to mute)' : 'Chime off (click to turn on)'}
    >
      <span aria-hidden={text ? undefined : true}>{chime ? '🔔' : '🔕'}</span>
      {text}
    </button>
  );

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
    const remaining = remainingNow;
    const done = isDone;
    return (
      <div className={`timer running ${done ? 'done' : remaining <= 10 ? 'ending' : ''}`} role="timer" title={lockedHint ?? undefined}>
        <span className="timer-value">{done ? 'Time’s up' : fmt(remaining)}</span>
        {chimeBtn('timer-btn')}
        <button className="timer-btn" disabled={locked} onClick={() => onSet(timer.duration)} aria-label="Restart timer" title={lockedHint ?? 'Restart timer'}>
          ↻
        </button>
        <button className="timer-btn timer-stop" disabled={locked} onClick={() => onSet(null)} aria-label="Stop timer" title={lockedHint ?? 'Stop timer'}>
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
      <button ref={toggleRef} className="btn" disabled={locked} title={lockedHint ?? undefined} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={open ? panelId : undefined}>
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
          {chimeBtn('menu-chime', chime ? ' Chime on' : ' Chime off')}
        </div>
      )}
    </div>
  );
}
