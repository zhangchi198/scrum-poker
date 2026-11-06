/**
 * What the story box should show when the room's story changes remotely. Only text you have actually edited
 * since focusing is protected; a focused-but-untouched box follows the room.
 */
export function draftForRemote(draft: string, remote: string, focused: boolean, edited: boolean): string {
  return focused && edited ? draft : remote;
}

/** On blur, commit only an edit; otherwise adopt the latest remote value instead of re-sending a stale one. */
export function blurResult(draft: string, remote: string, edited: boolean): { commit: string | null; draft: string } {
  return edited ? { commit: draft, draft } : { commit: null, draft: remote };
}
