/** Room ids are 10 base58 characters. */
export const ROOM_ID_PATTERN = '[1-9A-HJ-NP-Za-km-z]{10}';
const BARE_ID = new RegExp(`^${ROOM_ID_PATTERN}$`);
const ROOM_PATH = new RegExp(`^/r/(${ROOM_ID_PATTERN})/?$`);

/** The room id in a path like `/r/<id>` (optional trailing slash), or null. */
export function roomIdFromPath(path: string): string | null {
  return ROOM_PATH.exec(path)?.[1] ?? null;
}

/**
 * Extracts a room id from whatever someone pasted into the invite box: a link to this site
 * (`https://<host>/r/<id>`, optionally with a trailing slash, query or hash) or a bare id.
 * Links to other hosts, other paths, and strings that merely end in an id are rejected.
 */
export function parseInvite(input: string, host: string): string | null {
  const text = input.trim();
  if (BARE_ID.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.host.toLowerCase() !== host.toLowerCase()) return null;
  return roomIdFromPath(url.pathname);
}
