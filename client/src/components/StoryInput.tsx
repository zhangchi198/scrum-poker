import { useEffect, useRef, useState } from 'react';
import { LIMITS } from '../../../shared/protocol.ts';
import { blurResult, draftForRemote } from '../lib/story.ts';

/** Shared story title. Your own edits win while you are typing; otherwise the room's latest story shows. */
export function StoryInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const edited = useRef(false); // typed since focusing
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setDraft((d) => draftForRemote(d, value, focused.current, edited.current));
  }, [value]);

  function change(v: string) {
    edited.current = true;
    setDraft(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onCommit(v), 400);
  }

  return (
    <input
      className="story-input"
      value={draft}
      maxLength={LIMITS.storyLength}
      placeholder="What are we estimating?"
      aria-label="Story being estimated"
      onFocus={() => {
        focused.current = true;
        edited.current = false;
      }}
      onBlur={() => {
        const result = blurResult(draft, value, edited.current);
        focused.current = false;
        edited.current = false;
        clearTimeout(timer.current);
        if (result.commit !== null) onCommit(result.commit);
        setDraft(result.draft);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      onChange={(e) => change(e.target.value)}
    />
  );
}
