import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { REACTIONS } from '../../../shared/protocol.ts';
import { PICKER_EMOJIS } from '../../../shared/emoji.ts';
import { EXTRA_REACTIONS_KEY, loadExtraReactions, pickExtraReaction } from '../lib/extraReactions.ts';

/** Columns in the picker grid; arrow keys move by this much up and down. Keep in step with styles.css. */
const PICKER_COLUMNS = 8;

/**
 * Emoji reactions. On roomy screens the row is always visible; on phones CSS hides it behind the
 * 😀 button and shows it as a popover (closes on pick, outside press, or Esc).
 *
 * The "+" button opens a grid of more emojis. A pick is sent as a reaction and joins this browser's row
 * (up to 5 extras, newest last; kept in localStorage, so the row is private to this browser).
 */
export function Reactions({ onReact }: { onReact: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [extras, setExtras] = useState<string[]>(() => loadExtraReactions());
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const popId = useId();
  const pickerId = useId();

  /** Back to "+" if it is on screen, else to the 😀 toggle (phones hide the row while the picker is up). */
  const focusOpener = () => {
    const more = moreRef.current;
    (more && more.offsetParent !== null ? more : toggleRef.current)?.focus();
  };

  const closePicker = (refocus: boolean) => {
    setPickerOpen(false);
    if (refocus) focusOpener();
  };

  // Another tab of this browser picked something: keep the rows in step.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === EXTRA_REACTIONS_KEY && setExtras(loadExtraReactions());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    if (!open && !pickerOpen) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pickerOpen) {
        closePicker(true);
      } else {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    // Focus landing on anything outside (Tab, Shift+Tab, wrap-around) closes the picker, like a menu. This listens
    // for focus arriving rather than for blur: Safari/iOS never focus a pressed button, so a tap on an emoji blurs
    // to nothing, and closing on that would unmount the grid before the click and lose the pick.
    const onFocusIn = (e: FocusEvent) => {
      if (pickerOpen && !wrapRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open, pickerOpen]);

  // Opening the picker puts focus on its first emoji (before paint, so a fast key press lands in the grid).
  useLayoutEffect(() => {
    if (!pickerOpen) return;
    setActive(0);
    gridRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [pickerOpen]);

  const react = (emoji: string) => {
    onReact(emoji);
    setOpen(false);
  };

  const pick = (emoji: string) => {
    onReact(emoji);
    setExtras((cur) => pickExtraReaction(cur, emoji));
    setOpen(false);
    closePicker(true);
  };

  const onGridKey = (e: ReactKeyboardEvent) => {
    const last = PICKER_EMOJIS.length - 1;
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: PICKER_COLUMNS, ArrowUp: -PICKER_COLUMNS };
    let next: number;
    if (e.key in step) next = Math.min(last, Math.max(0, active + step[e.key]!));
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else return;
    e.preventDefault();
    setActive(next);
    gridRef.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  };

  return (
    <div className="reactions-wrap" ref={wrapRef}>
      <button
        ref={toggleRef}
        className="reactions-toggle"
        aria-label="Reactions"
        aria-expanded={open}
        aria-controls={popId}
        onClick={() => {
          setPickerOpen(false);
          setOpen((o) => !o);
        }}
      >
        😀
      </button>
      <div id={popId} className={`reactions ${open ? 'open' : ''}`} role="group" aria-label="Reactions">
        {REACTIONS.map((emoji) => (
          <button key={emoji} className="reaction-btn" aria-label={`React ${emoji}`} onClick={() => react(emoji)}>
            {emoji}
          </button>
        ))}
        {extras.map((emoji) => (
          <button key={emoji} className="reaction-btn reaction-extra" aria-label={`React ${emoji}`} onClick={() => react(emoji)}>
            {emoji}
          </button>
        ))}
        <button
          ref={moreRef}
          className="reaction-btn reaction-more"
          aria-label="More emojis"
          title="More emojis"
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          aria-controls={pickerId}
          onClick={() => {
            if (pickerOpen) return closePicker(true);
            setOpen(false); // on phones the picker takes the row's place
            setPickerOpen(true);
          }}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {pickerOpen && (
        <div id={pickerId} className="emoji-picker" role="dialog" aria-label="More emojis">
          <p className="emoji-picker-hint">Picks join your row (last 5)</p>
          <div className="emoji-grid" ref={gridRef} role="group" aria-label="Emojis" onKeyDown={onGridKey}>
            {PICKER_EMOJIS.map((emoji, i) => (
              <button
                key={emoji}
                className="emoji-cell"
                tabIndex={i === active ? 0 : -1}
                aria-label={`React ${emoji}`}
                onFocus={() => setActive(i)}
                onClick={() => pick(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
