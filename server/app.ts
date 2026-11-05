import { createReadStream, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { DECK_IDS, REACTIONS, type ClientMsg, type ServerMsg } from '../shared/protocol.ts';
import { Room, RoomError, randomId, type RoomSnapshot } from './room.ts';

export interface AppOptions {
  staticDir?: string;
  dataFile?: string;
  /** How long an offline participant keeps their seat (and vote). */
  graceMs?: number;
  /** How long an empty room survives without activity. */
  roomTtlMs?: number;
  maxRooms?: number;
  roomsPerIpPerHour?: number;
  log?: (msg: string) => void;
}

interface Conn {
  ws: WebSocket;
  room: Room | null;
  clientId: string | null;
  alive: boolean;
  tokens: number;
  lastRefill: number;
  lastReactionAt: number;
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
};

const ROOM_ID = /^[1-9A-HJ-NP-Za-km-z]{10}$/;
const BUCKET_SIZE = 30;
const REFILL_PER_SEC = 10;
const NUDGE_COOLDOWN_MS = 10_000;
const REACTION_COOLDOWN_MS = 250;

export function createApp(opts: AppOptions = {}) {
  const graceMs = opts.graceMs ?? 90_000;
  const roomTtlMs = opts.roomTtlMs ?? 24 * 3600_000;
  const maxRooms = opts.maxRooms ?? 2000;
  const roomsPerIp = opts.roomsPerIpPerHour ?? 30;
  const log = opts.log ?? ((m: string) => console.log(`[poker] ${m}`));

  const rooms = new Map<string, Room>();
  const conns = new Set<Conn>();
  const createdByIp = new Map<string, number[]>();
  let dirty = false;

  // ---------- persistence (survives deploys; rooms are otherwise in-memory) ----------
  function load() {
    if (!opts.dataFile || !existsSync(opts.dataFile)) return;
    try {
      const snaps = JSON.parse(readFileSync(opts.dataFile, 'utf8')) as RoomSnapshot[];
      const now = Date.now();
      for (const s of snaps) {
        const room = Room.restore(s, now);
        if (!room.isExpired(now, roomTtlMs)) rooms.set(room.id, room);
      }
      log(`restored ${rooms.size} room(s)`);
    } catch (err) {
      log(`could not restore rooms: ${(err as Error).message}`);
    }
  }

  function save() {
    if (!opts.dataFile || !dirty) return;
    const tmp = `${opts.dataFile}.tmp`;
    writeFileSync(tmp, JSON.stringify([...rooms.values()].map((r) => r.snapshot())));
    renameSync(tmp, opts.dataFile);
    dirty = false;
  }

  load();

  // ---------- messaging ----------
  function send(ws: WebSocket, msg: ServerMsg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function broadcastState(room: Room) {
    dirty = true;
    const now = Date.now();
    for (const c of conns) if (c.room === room) send(c.ws, { t: 'state', room: room.view(c.clientId, now) });
  }

  function takeToken(c: Conn): boolean {
    const now = Date.now();
    c.tokens = Math.min(BUCKET_SIZE, c.tokens + ((now - c.lastRefill) / 1000) * REFILL_PER_SEC);
    c.lastRefill = now;
    if (c.tokens < 1) return false;
    c.tokens -= 1;
    return true;
  }

  function handle(c: Conn, msg: ClientMsg) {
    if (msg.t === 'ping') return send(c.ws, { t: 'pong' });

    if (msg.t === 'join') {
      if (c.room) return; // one room per socket
      const room = typeof msg.roomId === 'string' ? rooms.get(msg.roomId) : undefined;
      if (!room) return send(c.ws, { t: 'error', code: 'room_not_found', message: 'This room does not exist or has expired.' });
      if (typeof msg.clientId !== 'string' || !/^[\w-]{16,64}$/.test(msg.clientId)) {
        return send(c.ws, { t: 'error', code: 'bad_request', message: 'Invalid client id.' });
      }
      const p = room.join(msg.clientId, msg.name, msg.spectator === true);
      c.room = room;
      c.clientId = msg.clientId;
      send(c.ws, { t: 'welcome', you: p.publicId, room: room.view(c.clientId) });
      return broadcastState(room);
    }

    const room = c.room;
    const clientId = c.clientId;
    if (!room || !clientId) return send(c.ws, { t: 'error', code: 'not_joined', message: 'Join a room first.' });
    const me = room.participants.get(clientId);
    if (!me) return send(c.ws, { t: 'error', code: 'not_joined', message: 'You are no longer in this room.' });

    switch (msg.t) {
      case 'vote':
        if (room.vote(clientId, msg.value ?? null)) broadcastState(room);
        return;
      case 'reveal':
        if (room.reveal()) broadcastState(room);
        return;
      case 'reset':
        room.reset();
        return broadcastState(room);
      case 'story':
        if (room.setStory(msg.story)) broadcastState(room);
        return;
      case 'deck':
        room.setDeck(msg.deckId, msg.custom);
        return broadcastState(room);
      case 'profile':
        if (room.setProfile(clientId, msg.name, msg.spectator)) broadcastState(room);
        return;
      case 'timer':
        room.setTimer(msg.seconds);
        return broadcastState(room);
      case 'react': {
        const now = Date.now();
        if (!(REACTIONS as readonly string[]).includes(msg.emoji)) return;
        if (now - c.lastReactionAt < REACTION_COOLDOWN_MS) return;
        c.lastReactionAt = now;
        for (const o of conns) if (o.room === room) send(o.ws, { t: 'reaction', from: me.publicId, name: me.name, emoji: msg.emoji });
        return;
      }
      case 'nudge': {
        const now = Date.now();
        if (room.revealed) return;
        if (now - room.lastNudgeAt < NUDGE_COOLDOWN_MS) {
          return send(c.ws, { t: 'error', code: 'rate_limited', message: 'Give them a few seconds before nudging again.' });
        }
        room.lastNudgeAt = now;
        const targets = new Set(room.pendingVoters());
        targets.delete(clientId);
        for (const o of conns) if (o.room === room && o.clientId && targets.has(o.clientId)) send(o.ws, { t: 'nudge', fromName: me.name });
        return;
      }
      default:
        return send(c.ws, { t: 'error', code: 'bad_request', message: 'Unknown message.' });
    }
  }

  // ---------- HTTP ----------
  function clientIp(req: IncomingMessage): string {
    const cf = req.headers['cf-connecting-ip'];
    return (typeof cf === 'string' && cf) || req.socket.remoteAddress || 'unknown';
  }

  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(JSON.stringify(body));
  }

  function readBody(req: IncomingMessage, limit = 2048): Promise<string> {
    return new Promise((ok, fail) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          fail(new Error('too large'));
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
      req.on('error', fail);
    });
  }

  async function createRoom(req: IncomingMessage, res: ServerResponse) {
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (createdByIp.get(ip) ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= roomsPerIp) return json(res, 429, { error: 'Too many rooms created. Try again later.' });
    if (rooms.size >= maxRooms) return json(res, 503, { error: 'The server is at capacity. Try again later.' });

    let body: { deckId?: unknown; custom?: unknown } = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { error: 'Invalid request body.' });
    }

    let id = randomId(10);
    while (rooms.has(id)) id = randomId(10);
    const room = new Room(id, now);
    const deckId = body.deckId ?? 'fibonacci';
    if (!(DECK_IDS as readonly unknown[]).includes(deckId)) return json(res, 400, { error: 'Unknown deck.' });
    try {
      room.setDeck(deckId, body.custom, now);
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
    rooms.set(id, room);
    recent.push(now);
    createdByIp.set(ip, recent);
    dirty = true;
    json(res, 201, { id });
  }

  const staticRoot = opts.staticDir ? resolve(opts.staticDir) : null;

  function serveStatic(req: IncomingMessage, res: ServerResponse) {
    if (!staticRoot) return json(res, 404, { error: 'Not found' });
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = normalize(join(staticRoot, urlPath));
    if (!file.startsWith(staticRoot)) return json(res, 400, { error: 'Bad path' });
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
    createReadStream(file).pipe(res);
  }

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size, connections: conns.size });
    if (path === '/api/rooms' && req.method === 'POST') {
      createRoom(req, res).catch((err) => {
        log(`createRoom failed: ${(err as Error).message}`);
        if (!res.headersSent) json(res, 500, { error: 'Internal error' });
      });
      return;
    }
    if (path.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    serveStatic(req, res);
  });

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
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    const c: Conn = { ws, room: null, clientId: null, alive: true, tokens: BUCKET_SIZE, lastRefill: Date.now(), lastReactionAt: 0 };
    conns.add(c);
    ws.on('pong', () => (c.alive = true));
    ws.on('message', (data, isBinary) => {
      c.alive = true;
      if (isBinary) return;
      if (!takeToken(c)) return send(ws, { t: 'error', code: 'rate_limited', message: 'Slow down a little.' });
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
      conns.delete(c);
      if (c.room && c.clientId) {
        c.room.leave(c.clientId);
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

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms) {
      if (room.prune(now, graceMs)) broadcastState(room);
      if (room.isExpired(now, roomTtlMs)) {
        rooms.delete(id);
        dirty = true;
      }
    }
    for (const [ip, times] of createdByIp) {
      const keep = times.filter((t) => now - t < 3600_000);
      if (keep.length) createdByIp.set(ip, keep);
      else createdByIp.delete(ip);
    }
  }, Math.min(15_000, Math.max(250, graceMs / 2)));

  const saver = setInterval(() => {
    try {
      save();
    } catch (err) {
      log(`save failed: ${(err as Error).message}`);
    }
  }, 15_000);

  heartbeat.unref();
  sweeper.unref();
  saver.unref();

  async function close() {
    clearInterval(heartbeat);
    clearInterval(sweeper);
    clearInterval(saver);
    for (const c of conns) c.ws.close(1012, 'Server restarting');
    wss.close();
    await new Promise<void>((ok) => server.close(() => ok()));
    dirty = true;
    save();
  }

  return { server, rooms, close, save };
}
