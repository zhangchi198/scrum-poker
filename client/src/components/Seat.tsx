import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ParticipantView } from '../../../shared/protocol.ts';
import { cardLen } from '../lib/format.ts';

/**
 * One player. The name wraps to two lines; the whole thing is a button so the full name (and status) can be shown
 * on hover, keyboard focus, or a tap on touch screens, where there is no hover.
 */
export function Seat({
  p,
  name,
  isMe,
  revealed,
  tipAbove,
}: {
  p: ParticipantView;
  /** Display label (already disambiguated for duplicate names). */
  name: string;
  isMe: boolean;
  revealed: boolean;
  tipAbove?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const show = hover || focus || pinned;
  const wrapRef = useRef<HTMLLIElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);

  const state = revealed ? (p.vote !== null ? 'up' : 'none') : p.voted ? 'down' : 'empty';
  const status = revealed ? (p.vote !== null ? `voted ${p.vote}` : 'did not vote') : p.voted ? 'has voted' : 'is thinking';
  const label = `${name}${isMe ? ' (you)' : ''}, ${status}${p.connected ? '' : ', offline'}`;

  // Keep the tooltip inside the viewport for seats at the screen edge.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!show || !tip) return;
    tip.style.setProperty('--shift', '0px');
    const r = tip.getBoundingClientRect();
    const pad = 8;
    const shift = Math.max(pad - r.left, 0) - Math.max(r.right - (window.innerWidth - pad), 0);
    tip.style.setProperty('--shift', `${shift}px`);
  }, [show]);

  useEffect(() => {
    if (!pinned) return;
    const away = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setPinned(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [pinned]);

  return (
    <li
      ref={wrapRef}
      className={`seat ${p.connected ? '' : 'offline'} ${isMe ? 'me' : ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => setPinned((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && show) {
          setPinned(false);
          setHover(false);
          setFocus(false);
        }
      }}
    >
      <button
        type="button"
        className="seat-btn"
        aria-label={label}
        onFocus={(e) => setFocus(e.currentTarget.matches(':focus-visible'))}
        onBlur={() => {
          setFocus(false);
          setPinned(false);
        }}
      >
        <span className={`slot ${state}`}>
          <span className="flip">
            <span className="face back" />
            <span className="face front" data-len={p.vote ? cardLen(p.vote) : 1}>
              {p.vote ?? ''}
            </span>
          </span>
        </span>
      </button>
      {/* Outside the button: a -webkit-box inside a <button> loses its line-clamp ellipsis in Chrome. */}
      <span className="seat-name" dir="auto" aria-hidden="true">
        {name}
      </span>
      {show && (
        <span ref={tipRef} className={`seat-tip ${tipAbove ? 'above' : ''}`} aria-hidden="true">
          <bdi>{name}</bdi>
          {isMe ? ' · You' : ''}
          {p.connected ? '' : ' · offline'}
        </span>
      )}
    </li>
  );
}
