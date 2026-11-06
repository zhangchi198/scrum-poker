import { createReadStream, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { DECKS, DECK_IDS, REACTIONS, type ClientMsg, type DeckId, type RoomLookup, type ServerMsg } from '../shared/protocol.ts';
import { Room, RoomError, isTombstone, randomId, type RoomSnapshot, type Tombstone } from './room.ts';

export interface AppOptions {
  staticDir?: string;
  dataFile?: string;
  /** How long an offline participant keeps their seat (and vote). */
  graceMs?: number;
  /** How long an empty room keeps its full state without activity (default 30 days). */
  roomTtlMs?: number;
  /** After a room expires, its link can be revived for this long since its last activity (default 90 days). */
  tombstoneTtlMs?: number;
  /** An empty room idle at least this long starts a fresh round when someone joins (default 4 hours). */
  staleAfterMs?: number;
  maxRooms?: number;
  roomsPerIpPerHour?: number;
  maxSocketsPerIp?: number;
  maxSocketsPerClient?: number;
  /** `GET /api/rooms/:id` lookups allowed per IP per minute (default 60). */
  lookupsPerIpPerMinute?: number;
  /** A socket must send a valid join within this long or it is closed (code 4000). */
  joinDeadlineMs?: number;
  /** Close a socket (1008) after this many rate-limit rejections within 10 seconds. */
  abuseKickThreshold?: number;
  /** Save this long after the last change. */
  saveDebounceMs?: number;
  /** Clock override, for tests. */
  now?: () => number;
  log?: (msg: string) => void;
}

interface Conn {
  ws: WebSocket;
  ip: string;
  room: Room | null;
  clientId: string | null;
  alive: boolean;
  tokens: number;
  lastRefill: number;
  lastReactionAt: number;
  joinTimer: NodeJS.Timeout | null;
  strikes: number;
  strikeWindowStart: number;
  kicked: boolean;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  // Room URLs are the only "secret" in this app, so never leak them via Referer.
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // No includeSubDomains: other subdomains of this domain are not served by this app.
  'Strict-Transport-Security': 'max-age=31536000',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const ROOM_ID = /^[1-9A-HJ-NP-Za-km-z]{10}$/;
const BUCKET_SIZE = 30;
const REFILL_PER_SEC = 10;
const NUDGE_COOLDOWN_MS = 10_000;
const REACTION_COOLDOWN_MS = 250;
const ABUSE_WINDOW_MS = 10_000;
const DAY = 24 * 3600_000;

class BodyTooLarge extends Error {}

export function createApp(opts: AppOptions = {}) {
  const graceMs = opts.graceMs ?? 90_000;
  const roomTtlMs = opts.roomTtlMs ?? 30 * DAY;
  const tombstoneTtlMs = opts.tombstoneTtlMs ?? 90 * DAY;
  const staleAfterMs = opts.staleAfterMs ?? 4 * 3600_000;
  const maxRooms = opts.maxRooms ?? 10_000;
  const roomsPerIp = opts.roomsPerIpPerHour ?? 30;
  const maxSocketsPerIp = opts.maxSocketsPerIp ?? 200; // generous: whole offices share one public IP behind NAT
  const maxSocketsPerClient = opts.maxSocketsPerClient ?? 5;
  const lookupsPerIp = opts.lookupsPerIpPerMinute ?? 60;
  const joinDeadlineMs = opts.joinDeadlineMs ?? 10_000;
  const abuseKickThreshold = opts.abuseKickThreshold ?? 50;
  const saveDebounceMs = opts.saveDebounceMs ?? 2000;
  const clock = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.log(`[poker] ${m}`));

  const rooms = new Map<string, Room>();
  const tombstones = new Map<string, Tombstone>();
  const conns = new Set<Conn>();
  const createdByIp = new Map<string, number[]>();
  const socketsByIp = new Map<string, number>();
  const lookupsByIp = new Map<string, number[]>();
  let dirty = false;
  let saveTimer: NodeJS.Timeout | null = null;

  // ---------- persistence (survives deploys; rooms are otherwise in-memory) ----------
  function retire(room: Room) {
    tombstones.set(room.id, room.tombstone());
  }

  function tombstoneExpired(t: Tombstone, now: number) {
    return now - t.lastActivity > tombstoneTtlMs;
  }

  function load() {
    const file = opts.dataFile;
    if (!file || !existsSync(file)) return;
    let rawRooms: unknown[];
    let rawTombstones: unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) {
        rawRooms = parsed; // legacy format: a plain array of room snapshots
      } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { rooms?: unknown }).rooms)) {
        rawRooms = (parsed as { rooms: unknown[] }).rooms;
        const t = (parsed as { tombstones?: unknown }).tombstones;
        if (Array.isArray(t)) rawTombstones = t;
      } else {
        throw new Error('unrecognised file format');
      }
    } catch (err) {
      // Never let the next save silently overwrite a file we could not read.
      const backup = `${file}.corrupt-${Date.now()}`;
      try {
        renameSync(file, backup);
        log(`ERROR: could not read ${file} (${(err as Error).message}); moved it to ${backup} and starting empty`);
      } catch (renameErr) {
        log(`ERROR: could not read ${file} (${(err as Error).message}) and could not move it aside (${(renameErr as Error).message})`);
      }
      return;
    }

    const now = clock();
    let skipped = 0;
    for (const s of rawRooms) {
      try {
        if (!ROOM_ID.test((s as RoomSnapshot | null)?.id ?? '')) throw new Error('bad room id');
        const room = Room.restore(s as RoomSnapshot, now);
        if (room.isExpired(now, roomTtlMs)) retire(room);
        else rooms.set(room.id, room);
      } catch (err) {
        skipped++;
        log(`ERROR: skipped an unreadable room while restoring: ${(err as Error).message}`);
      }
    }
    for (const t of rawTombstones) {
      if (isTombstone(t) && ROOM_ID.test(t.id)) {
        if (!rooms.has(t.id)) tombstones.set(t.id, { id: t.id, deckId: t.deckId, cards: t.cards, lastActivity: t.lastActivity });
      } else {
        skipped++;
        log('ERROR: skipped an unreadable tombstone while restoring');
      }
    }
    for (const [id, t] of tombstones) if (tombstoneExpired(t, now)) tombstones.delete(id);
    log(`restored ${rooms.size} room(s) and ${tombstones.size} tombstone(s)${skipped ? `, skipped ${skipped} bad entr${skipped === 1 ? 'y' : 'ies'}` : ''}`);
  }

  /** Writes the data file if anything changed. Returns the number of rooms written, or null if nothing was written. */
  function save(): number | null {
    if (!opts.dataFile || !dirty) return null;
    const tmp = `${opts.dataFile}.tmp`;
    const snaps = [...rooms.values()].map((r) => r.snapshot());
    writeFileSync(tmp, JSON.stringify({ version: 2, rooms: snaps, tombstones: [...tombstones.values()] }));
    renameSync(tmp, opts.dataFile);
    dirty = false;
    return snaps.length;
  }

  function saveQuietly() {
    try {
      save();
    } catch (err) {
      log(`save failed: ${(err as Error).message}`);
    }
  }

  /** Marks state as changed and schedules a save shortly after the last change. */
  function markDirty() {
    dirty = true;
    if (!opts.dataFile) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveQuietly, saveDebounceMs);
    saveTimer.unref();
  }

  load();

  // ---------- messaging ----------
  function send(ws: WebSocket, msg: ServerMsg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  /**
   * Sends the room state to everyone in it. The per-room work is done once: the shared view carries votes only
   * after reveal, so before reveal the sole per-socket difference is the viewer's own vote, which is patched into
   * their own participant entry. Nobody else's vote is ever put in a message before reveal.
   */
  function broadcastState(room: Room) {
    markDirty();
    const { participants, ...rest } = room.view(null, clock()); // viewer null: votes are null unless revealed
    const head = `{"t":"state","room":${JSON.stringify(rest).slice(0, -1)},"participants":[`;
    const parts = participants.map((p) => JSON.stringify(p));
    const assemble = (list: string[]) => `${head}${list.join(',')}]}}`;
    const shared = assemble(parts);
    const index = new Map<string, number>();
    let i = 0;
    for (const cid of room.participants.keys()) index.set(cid, i++);
    const patchedByClient = new Map<string, string>();
    for (const c of conns) {
      if (c.room !== room || c.ws.readyState !== c.ws.OPEN) continue;
      let out = shared;
      if (!room.revealed && c.clientId) {
        const vote = room.participants.get(c.clientId)?.vote;
        const at = index.get(c.clientId);
        if (vote !== null && vote !== undefined && at !== undefined) {
          let patched = patchedByClient.get(c.clientId);
          if (patched === undefined) {
            const copy = parts.slice();
            copy[at] = JSON.stringify({ ...participants[at]!, vote });
            patched = assemble(copy);
            patchedByClient.set(c.clientId, patched);
          }
          out = patched;
        }
      }
      c.ws.send(out);
    }
  }

  function takeToken(c: Conn): boolean {
    const now = clock();
    c.tokens = Math.min(BUCKET_SIZE, c.tokens + ((now - c.lastRefill) / 1000) * REFILL_PER_SEC);
    c.lastRefill = now;
    if (c.tokens < 1) return false;
    c.tokens -= 1;
    return true;
  }

  /** Called for every message the token bucket turned away. Persistent offenders are disconnected. */
  function rejectForRate(c: Conn) {
    const now = clock();
    if (now - c.strikeWindowStart > ABUSE_WINDOW_MS) {
      c.strikeWindowStart = now;
      c.strikes = 0;
    }
    c.strikes++;
    send(c.ws, { t: 'error', code: 'rate_limited', message: 'Slow down a little.' });
    if (c.strikes >= abuseKickThreshold && !c.kicked) {
      c.kicked = true;
      c.ws.close(1008, 'Rate limit exceeded');
    }
  }

  /** Reserves one room-creation slot for this IP (shared by POST /api/rooms and revival). */
  function takeCreationSlot(ip: string, now: number): 'ok' | 'ip' | 'cap' {
    const recent = (createdByIp.get(ip) ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= roomsPerIp) return 'ip';
    if (rooms.size >= maxRooms) return 'cap';
    recent.push(now);
    createdByIp.set(ip, recent);
    return 'ok';
  }

  /** Counts one room lookup for this IP; false once the per-minute budget is spent. */
  function takeLookup(ip: string, now: number): boolean {
    const recent = (lookupsByIp.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= lookupsPerIp) {
      lookupsByIp.set(ip, recent);
      return false;
    }
    recent.push(now);
    lookupsByIp.set(ip, recent);
    return true;
  }

  const deckLabel = (id: DeckId) => (id === 'custom' ? 'Custom' : DECKS[id].label);

  function handle(c: Conn, msg: ClientMsg) {
    if (msg.t === 'ping') return send(c.ws, { t: 'pong' });

    if (msg.t === 'join') {
      if (c.room) return; // one room per socket
      if (typeof msg.clientId !== 'string' || !/^[\w-]{16,64}$/.test(msg.clientId)) {
        return send(c.ws, { t: 'error', code: 'bad_request', message: 'Invalid client id.' });
      }
      const now = clock();
      const roomId = typeof msg.roomId === 'string' ? msg.roomId : '';
      let room = rooms.get(roomId);
      if (room) {
        let mine = 0;
        for (const o of conns) if (o.room === room && o.clientId === msg.clientId) mine++;
        if (mine >= maxSocketsPerClient) {
          send(c.ws, { t: 'error', code: 'rate_limited', message: 'Too many open tabs for this room.' });
          c.ws.close(1008, 'Too many connections');
          return;
        }
      } else {
        const tomb = tombstones.get(roomId);
        if (tomb && tombstoneExpired(tomb, now)) {
          tombstones.delete(roomId);
          markDirty();
        } else if (tomb) {
          // Reviving a room counts as creating one: same per-IP limit and the same capacity cap.
          const slot = takeCreationSlot(c.ip, now);
          if (slot === 'ip') return send(c.ws, { t: 'error', code: 'rate_limited', message: 'Too many rooms opened from your network. Try again later.' });
          if (slot === 'cap') return send(c.ws, { t: 'error', code: 'rate_limited', message: 'The server is at capacity. Try again later.' });
          room = Room.revive(tomb, now);
          rooms.set(room.id, room);
          tombstones.delete(room.id);
        }
      }
      if (!room) return send(c.ws, { t: 'error', code: 'room_not_found', message: 'This room does not exist or has expired.' });
      const p = room.join(msg.clientId, msg.name, msg.spectator === true, now, staleAfterMs);
      c.room = room;
      c.clientId = msg.clientId;
      if (c.joinTimer) clearTimeout(c.joinTimer);
      c.joinTimer = null;
      send(c.ws, { t: 'welcome', you: p.publicId, room: room.view(c.clientId, now) });
      return broadcastState(room);
    }

    const room = c.room;
    const clientId = c.clientId;
    if (!room || !clientId) return send(c.ws, { t: 'error', code: 'not_joined', message: 'Join a room first.' });
    const me = room.participants.get(clientId);
    if (!me) return send(c.ws, { t: 'error', code: 'not_joined', message: 'You are no longer in this room.' });

    switch (msg.t) {
      case 'vote':
        if (room.vote(clientId, msg.value ?? null, clock())) broadcastState(room);
        return;
      case 'reveal':
        if (room.reveal(clock())) broadcastState(room);
        return;
      case 'reset':
        room.reset(clock());
        return broadcastState(room);
      case 'story':
        if (room.setStory(msg.story, clock())) broadcastState(room);
        return;
      case 'deck':
        room.setDeck(msg.deckId, msg.custom, clock());
        return broadcastState(room);
      case 'profile':
        if (room.setProfile(clientId, msg.name, msg.spectator, clock())) broadcastState(room);
        return;
      case 'leave': {
        // Gone immediately (no grace period). This socket is detached; other tabs of the same client find out on their next message.
        room.remove(clientId, clock());
        c.room = null;
        c.clientId = null;
        return broadcastState(room);
      }
      case 'timer':
        room.setTimer(msg.seconds, clock());
        return broadcastState(room);
      case 'react': {
        const now = clock();
        if (!(REACTIONS as readonly string[]).includes(msg.emoji)) return;
        if (now - c.lastReactionAt < REACTION_COOLDOWN_MS) return;
        c.lastReactionAt = now;
        for (const o of conns) if (o.room === room) send(o.ws, { t: 'reaction', from: me.publicId, name: me.name, emoji: msg.emoji });
        return;
      }
      case 'nudge': {
        const now = clock();
        if (room.revealed) return;
        if (now - room.lastNudgeAt < NUDGE_COOLDOWN_MS) {
          return send(c.ws, { t: 'error', code: 'rate_limited', message: 'Give them a few seconds before nudging again.' });
        }
        const targets = new Set(room.pendingVoters());
        targets.delete(clientId);
        if (targets.size === 0) return; // nobody to nudge: don't burn the room's cooldown
        room.lastNudgeAt = now;
        for (const o of conns) if (o.room === room && o.clientId && targets.has(o.clientId)) send(o.ws, { t: 'nudge', fromName: me.name });
        return;
      }
      default:
        return send(c.ws, { t: 'error', code: 'bad_request', message: 'Unknown message.' });
    }
  }

  // ---------- HTTP ----------
  /**
   * The client IP. `CF-Connecting-IP` is trusted verbatim, which is safe only because port 3000 is bound to
   * loopback and reachable solely through cloudflared (see README).
   */
  function clientIp(req: IncomingMessage): string {
    const cf = req.headers['cf-connecting-ip'];
    return (typeof cf === 'string' && cf) || req.socket.remoteAddress || 'unknown';
  }

  function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
    res.end(JSON.stringify(body));
  }

  function readBody(req: IncomingMessage, limit = 2048): Promise<string> {
    return new Promise((ok, fail) => {
      let size = 0;
      let over = false;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (over) {
          // Keep draining so the 413 isn't lost to a connection reset; give up on absurd uploads.
          if (size > 1_000_000) req.destroy();
        } else if (size > limit) {
          over = true;
          chunks.length = 0;
          fail(new BodyTooLarge());
        } else chunks.push(chunk);
      });
      req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
      req.on('error', fail);
    });
  }

  async function createRoom(req: IncomingMessage, res: ServerResponse) {
    const ip = clientIp(req);
    const now = clock();
    // Reserve the slot before awaiting the body, so slow concurrent requests can't all pass the check.
    const slot = takeCreationSlot(ip, now);
    if (slot === 'ip') return json(res, 429, { error: 'Too many rooms created. Try again later.' });
    if (slot === 'cap') return json(res, 503, { error: 'The server is at capacity. Try again later.' });

    let body: { deckId?: unknown; custom?: unknown } = {};
    try {
      const raw = await readBody(req);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      body = parsed;
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof BodyTooLarge) {
        json(res, 413, { error: 'Request body too large.' }, { Connection: 'close' });
        // Only cut the connection once the response is out, and not if the client never finishes uploading.
        res.once('finish', () => {
          const t = setTimeout(() => req.destroy(), 2000);
          t.unref();
          req.once('close', () => clearTimeout(t));
        });
        return;
      }
      json(res, 400, { error: 'Invalid request body.' });
      return;
    }

    let id = randomId(10);
    while (rooms.has(id) || tombstones.has(id)) id = randomId(10);
    const room = new Room(id, now);
    const deckId = body.deckId ?? 'fibonacci';
    if (!(DECK_IDS as readonly unknown[]).includes(deckId)) return json(res, 400, { error: 'Unknown deck.' });
    try {
      room.setDeck(deckId, body.custom, now);
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
    rooms.set(id, room);
    markDirty();
    json(res, 201, { id });
  }

  const staticRoot = opts.staticDir ? resolve(opts.staticDir) : null;

  function serveStatic(req: IncomingMessage, res: ServerResponse) {
    if (!staticRoot) return json(res, 404, { error: 'Not found' });
    let urlPath: string;
    try {
      urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    } catch {
      return json(res, 400, { error: 'Bad path' });
    }
    if (urlPath.includes('\0')) return json(res, 400, { error: 'Bad path' });
    let file = normalize(join(staticRoot, urlPath));
    if (file !== staticRoot && !file.startsWith(staticRoot + sep)) return json(res, 400, { error: 'Bad path' });
    const isAsset = existsSync(file) && statSync(file).isFile();
    if (!isAsset) file = join(staticRoot, 'index.html'); // SPA fallback (/r/<id>, etc.)
    if (!existsSync(file)) return json(res, 404, { error: 'Not found' });
    const hashed = isAsset && urlPath.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  const server: Server = createServer((req, res) => {
    try {
      route(req, res);
    } catch (err) {
      log(`request failed: ${(err as Error).stack}`);
      if (!res.headersSent) json(res, 500, { error: 'Internal error' });
      else res.destroy();
    }
  });

  /**
   * Lets the room page decide what to show before asking for a name. The room id is the only secret, so this
   * returns only what joining would show anyway (story, head-count, deck), never a vote, and is rate-limited per
   * IP so it cannot enumerate ids faster than joining could.
   */
  function lookupRoom(req: IncomingMessage, res: ServerResponse, id: string) {
    const now = clock();
    if (!takeLookup(clientIp(req), now)) return json(res, 429, { error: 'Too many requests. Try again in a minute.' }, { 'Retry-After': '60' });
    const room = ROOM_ID.test(id) ? rooms.get(id) : undefined;
    if (room) {
      let players = 0;
      for (const p of room.participants.values()) if (!p.spectator && p.connections > 0) players++;
      const body: RoomLookup = { status: 'live', story: room.story, players, deckLabel: deckLabel(room.deckId) };
      return json(res, 200, body);
    }
    const tomb = ROOM_ID.test(id) ? tombstones.get(id) : undefined;
    if (tomb && !tombstoneExpired(tomb, now)) {
      const body: RoomLookup = { status: 'revivable', deckLabel: deckLabel(tomb.deckId) };
      return json(res, 200, body);
    }
    json(res, 404, { error: 'Room not found' });
  }

  function route(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size, connections: conns.size });
    if (path === '/api/rooms' && req.method === 'POST') {
      createRoom(req, res).catch((err) => {
        log(`createRoom failed: ${(err as Error).message}`);
        if (!res.headersSent) json(res, 500, { error: 'Internal error' });
      });
      return;
    }
    const lookup = /^\/api\/rooms\/([^/]+)$/.exec(path);
    if (lookup && (req.method === 'GET' || req.method === 'HEAD')) return lookupRoom(req, res, lookup[1]!);
    if (path.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    serveStatic(req, res);
  }

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0] ?? '/';
    const origin = req.headers.origin;
    let sameOrigin = true;
    if (origin) {
      try {
        sameOrigin = new URL(origin).host === req.headers.host;
      } catch {
        sameOrigin = false;
      }
    }
    if (path !== '/ws' || !sameOrigin) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const ip = clientIp(req);
    const open = socketsByIp.get(ip) ?? 0;
    if (open >= maxSocketsPerIp) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    // Count from the upgrade until the TCP socket closes, so a burst of upgrades can't slip past the cap.
    socketsByIp.set(ip, open + 1);
    socket.once('close', () => {
      const n = (socketsByIp.get(ip) ?? 1) - 1;
      if (n > 0) socketsByIp.set(ip, n);
      else socketsByIp.delete(ip);
    });
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const c: Conn = {
      ws,
      ip: clientIp(req),
      room: null,
      clientId: null,
      alive: true,
      tokens: BUCKET_SIZE,
      lastRefill: clock(),
      lastReactionAt: 0,
      joinTimer: null,
      strikes: 0,
      strikeWindowStart: clock(),
      kicked: false,
    };
    conns.add(c);
    c.joinTimer = setTimeout(() => ws.close(4000, 'No join received'), joinDeadlineMs);
    c.joinTimer.unref();
    ws.on('pong', () => (c.alive = true));
    ws.on('message', (data, isBinary) => {
      c.alive = true;
      if (c.kicked) return;
      // Every frame costs a token, binary ones included (we ignore their content).
      if (!takeToken(c)) return rejectForRate(c);
      if (isBinary) return;
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString());
        if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') throw new Error('shape');
      } catch {
        return send(ws, { t: 'error', code: 'bad_request', message: 'Malformed message.' });
      }
      try {
        handle(c, msg);
      } catch (err) {
        if (err instanceof RoomError) return send(ws, { t: 'error', code: err.code, message: err.message });
        log(`handler error: ${(err as Error).stack}`);
        send(ws, { t: 'error', code: 'bad_request', message: 'Something went wrong.' });
      }
    });
    ws.on('close', () => {
      if (c.joinTimer) clearTimeout(c.joinTimer);
      conns.delete(c);
      if (c.room && c.clientId) {
        c.room.leave(c.clientId, clock());
        broadcastState(c.room);
      }
    });
    ws.on('error', () => ws.terminate());
  });

  // ---------- housekeeping ----------
  const heartbeat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 30_000);

  /** Prunes offline seats, retires idle rooms to tombstones, and forgets old tombstones. */
  function sweep(now = clock()) {
    for (const [id, room] of rooms) {
      if (room.prune(now, graceMs)) broadcastState(room);
      if (room.isExpired(now, roomTtlMs)) {
        rooms.delete(id);
        retire(room);
        markDirty();
      }
    }
    for (const [id, t] of tombstones) {
      if (tombstoneExpired(t, now)) {
        tombstones.delete(id);
        markDirty();
      }
    }
    for (const [ip, times] of lookupsByIp) {
      const keep = times.filter((t) => now - t < 60_000);
      if (keep.length) lookupsByIp.set(ip, keep);
      else lookupsByIp.delete(ip);
    }
    for (const [ip, times] of createdByIp) {
      const keep = times.filter((t) => now - t < 3600_000);
      if (keep.length) createdByIp.set(ip, keep);
      else createdByIp.delete(ip);
    }
  }

  const sweeper = setInterval(() => sweep(), Math.min(15_000, Math.max(250, graceMs / 2)));

  // Safety net: the debounced save normally fires within seconds of a change.
  const saver = setInterval(saveQuietly, 15_000);

  heartbeat.unref();
  sweeper.unref();
  saver.unref();

  async function close() {
    clearInterval(heartbeat);
    clearInterval(sweeper);
    clearInterval(saver);
    if (saveTimer) clearTimeout(saveTimer);
    for (const c of conns) c.ws.close(1012, 'Server restarting');
    wss.close();
    await new Promise<void>((ok) => server.close(() => ok()));
    dirty = true;
    try {
      const n = save();
      if (n !== null) log(`saved ${n} room(s)`);
    } catch (err) {
      log(`ERROR: final save failed, rooms may be lost: ${(err as Error).message}`);
      throw err;
    }
  }

  return { server, rooms, tombstones, close, save, sweep };
}
