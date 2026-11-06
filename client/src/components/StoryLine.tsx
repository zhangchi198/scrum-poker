import { useId, useLayoutEffect, useRef, useState } from 'react';
import { graphemeLength } from '../../../shared/text.ts';

/** A story longer than this no longer fits the single-line box on most screens, so it is also shown wrapped. */
export const LONG_STORY = 60;

/** Read-only, wrapped copy of a long story: clamped to 3 lines with a "Show more" toggle when it overflows. */
export function StoryLine({ story }: { story: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (!expanded) setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [story, expanded]);

  if (graphemeLength(story) <= LONG_STORY) return null;
  return (
    <div className="story-full">
      <p id={id} ref={ref} dir="auto" className={expanded ? 'open' : ''}>
        {story}
      </p>
      {(overflows || expanded) && (
        <button type="button" className="link-btn" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
