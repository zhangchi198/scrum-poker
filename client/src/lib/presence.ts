/** Offline seats say "reconnecting…" for this long, since most drop-outs are a blip. */
export const RECONNECTING_MS = 15_000;

/** Last-seen text for an offline seat: "reconnecting…", then "away 40s", "away 3m", "away 2h", "away 1d". */
export function awayText(offlineSince: number | null, now: number): string {
  if (offlineSince === null) return '';
  const ms = Math.max(0, now - offlineSince);
  if (ms < RECONNECTING_MS) return 'reconnecting…';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `away ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `away ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `away ${h}h`;
  return `away ${Math.floor(h / 24)}d`;
}
