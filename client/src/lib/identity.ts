export interface Identity {
  clientId: string;
  name: string;
}

export const IDENTITY_KEY = 'poker.identity.v1';

function randomHex(bytes: number): string {
  // crypto.randomUUID needs a secure context; getRandomValues works on plain-http LAN access too.
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function read(): { clientId?: unknown; name?: unknown } {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// Only used when localStorage is unusable, so the identity at least stays stable within one page load.
let fallback: Identity | null = null;

function write(identity: Identity) {
  fallback = identity;
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    /* private mode etc. — identity just won't persist across reloads */
  }
}

/**
 * The current identity. It is read from localStorage on every call (never cached), so a tab always sees a name
 * changed in another tab. The spectator flag is deliberately not part of it: it is a per-room choice.
 */
export function loadIdentity(): Identity {
  const stored = read();
  const clientId =
    typeof stored.clientId === 'string' && stored.clientId.length >= 16 ? stored.clientId : (fallback?.clientId ?? randomHex(16));
  const name = typeof stored.name === 'string' ? stored.name : (fallback?.name ?? '');
  const identity = { clientId, name };
  if (stored.clientId !== clientId) write(identity);
  else fallback = identity;
  return identity;
}

export function saveIdentity(patch: Partial<Omit<Identity, 'clientId'>>): Identity {
  const next = { ...loadIdentity(), ...patch };
  write(next);
  return next;
}
