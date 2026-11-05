export interface Identity {
  clientId: string;
  name: string;
  spectator: boolean;
}

const KEY = 'poker.identity.v1';

function randomHex(bytes: number): string {
  // crypto.randomUUID needs a secure context; getRandomValues works on plain-http LAN access too.
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function read(): Partial<Identity> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Identity>;
  } catch {
    return {};
  }
}

let memory: Identity | null = null;

export function loadIdentity(): Identity {
  if (memory) return memory;
  const stored = read();
  memory = {
    clientId: typeof stored.clientId === 'string' && stored.clientId.length >= 16 ? stored.clientId : randomHex(16),
    name: typeof stored.name === 'string' ? stored.name : '',
    spectator: stored.spectator === true,
  };
  saveIdentity({});
  return memory;
}

export function saveIdentity(patch: Partial<Omit<Identity, 'clientId'>>): Identity {
  const next = { ...(memory ?? loadIdentity()), ...patch };
  memory = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode etc. — identity just won't persist across reloads */
  }
  return next;
}
