import { useEffect, useRef } from 'react';

/** The row of cards. Scrolls sideways when it overflows, with an edge fade as the scroll hint. */
export function Hand({
  cards,
  vote,
  canVote,
  shakeKey,
  onVote,
}: {
  cards: string[];
  vote: string | null | undefined;
  canVote: boolean;
  shakeKey: number;
  onVote: (value: string | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const more = (n: number) => (n > 2 ? '28px' : '0px');
      el.style.setProperty('--fade-l', more(el.scrollLeft));
      el.style.setProperty('--fade-r', more(el.scrollWidth - el.clientWidth - el.scrollLeft));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [cards]);

  return (
    <div ref={ref} className={`hand ${shakeKey ? 'shake' : ''} ${canVote ? '' : 'locked'}`} role="group" aria-label="Your cards">
      {cards.map((card) => {
        const selected = vote === card;
        return (
          <button
            key={card}
            className={`card-btn ${selected ? 'selected' : ''}`}
            disabled={!canVote}
            aria-pressed={selected}
            onClick={() => onVote(selected ? null : card)}
          >
            {card}
          </button>
        );
      })}
    </div>
  );
}
