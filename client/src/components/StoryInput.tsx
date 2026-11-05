import { useEffect, useRef, useState } from 'react';
import { LIMITS } from '../../../shared/protocol.ts';

/** Shared story title. Local edits win while focused; remote changes show up otherwise. */
export function StoryInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  function change(v: string) {
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
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        clearTimeout(timer.current);
        onCommit(draft);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      onChange={(e) => change(e.target.value)}
    />
  );
}
