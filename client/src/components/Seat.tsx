import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ParticipantView } from '../../../shared/protocol.ts';
import { cardLen } from '../lib/format.ts';
import { awayText } from '../lib/presence.ts';

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
  isFacilitator,
  clockOffset,
  onMakeFacilitator,
  onRemove,
}: {
  p: ParticipantView;
  /** Display label (already disambiguated for duplicate names). */
  name: string;
  isMe: boolean;
  revealed: boolean;
  tipAbove?: boolean;
  isFacilitator?: boolean;
  /** Server time minus local time, to date "away" correctly. */
  clockOffset: number;
  /** Present when the viewer may hand the facilitator role to this (online) person. */
  onMakeFacilitator?: () => void;
  /** Present when the viewer may remove this (offline) seat. */
  onRemove?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const show = hover || focus || pinned;
  const wrapRef = useRef<HTMLLIElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);

  const state = revealed ? (p.vote !== null ? 'up' : 'none') : p.voted ? 'down' : 'empty';
  const status = revealed ? (p.vote !== null ? `voted ${p.vote}` : 'did not vote') : p.voted ? 'has voted' : 'is thinking';
  const [, tick] = useState(0);
  useEffect(() => {
    if (p.connected) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [p.connected]);
  const away = p.connected ? '' : awayText(p.offlineSince, Date.now() + clockOffset);
  const label = `${name}${isMe ? ' (you)' : ''}${isFacilitator ? ', facilitator' : ''}, ${status}${p.connected ? '' : `, offline, ${away}`}`;
  const actions = !!(onMakeFacilitator || onRemove);
  const act = (e: React.MouseEvent, fn: () => void) => {
    e.stopPropagation(); // the seat itself toggles the pinned tooltip on click
    setPinned(false);
    setHover(false);
    fn();
  };

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
      onFocus={(e) => setFocus(e.target.matches(':focus-visible'))}
      onBlur={(e) => {
        // Moving focus into the tooltip's buttons keeps it open; leaving the seat closes it.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setFocus(false);
        setPinned(false);
      }}
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
      {isFacilitator && <span className="seat-badge">facilitator</span>}
      {!p.connected && (
        <span className="seat-away" aria-hidden="true">
          {away}
        </span>
      )}
      {show && (
        <span ref={tipRef} className={`seat-tip ${tipAbove ? 'above' : ''} ${actions ? 'has-actions' : ''}`} role={actions ? 'group' : undefined} aria-label={actions ? `Actions for ${name}` : undefined} aria-hidden={actions ? undefined : true}>
          <span aria-hidden="true">
            <bdi>{name}</bdi>
            {isMe ? ' · You' : ''}
            {isFacilitator ? ' · Facilitator' : ''}
            {p.connected ? '' : ` · ${away}`}
          </span>
          {onMakeFacilitator && (
            <button type="button" className="tip-action" aria-label={`Make ${name} the facilitator`} onClick={(e) => act(e, onMakeFacilitator)}>
              Make facilitator
            </button>
          )}
          {onRemove && (
            <button type="button" className="tip-action danger" aria-label={`Remove ${name} from the room`} onClick={(e) => act(e, onRemove)}>
              Remove from room
            </button>
          )}
        </span>
      )}
    </li>
  );
}
