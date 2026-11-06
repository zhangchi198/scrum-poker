import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ClientMsg, ServerMsg } from '../shared/protocol.ts';
import { createApp } from '../server/app.ts';
import { Room } from '../server/room.ts';

type App = ReturnType<typeof createApp>;
const apps: App[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const a of apps.splice(0)) await a.close().catch(() => {});
});

async function start(opts: Parameters<typeof createApp>[0] = {}) {
  const app = createApp({ log: () => {}, ...opts });
  apps.push(app);
  await new Promise<void>((ok) => app.server.listen(0, '127.0.0.1', ok));
  const port = (app.server.address() as AddressInfo).port;
  return { app, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws` };
}

async function createRoom(base: string, body: object = {}) {
  const res = await fetch(`${base}/api/rooms`, { method: 'POST', body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { id?: string; error?: string } };
}

/** A tiny test client that records every message and lets you await the next one matching a predicate. */
async function client(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  sockets.push(ws);
  const inbox: ServerMsg[] = [];
  const raw: string[] = [];
  const waiters: { pred: (m: ServerMsg) => boolean; ok: (m: ServerMsg) => void }[] = [];
  ws.on('message', (d) => {
    raw.push(d.toString());
    const m = JSON.parse(d.toString()) as ServerMsg;
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0]!.ok(m);
    else inbox.push(m);
  });
  await new Promise<void>((ok, fail) => {
    ws.once('open', ok);
    ws.once('error', fail);
  });
  return {
    ws,
    raw,
    send: (m: ClientMsg) => ws.send(JSON.stringify(m)),
    next<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true) {
      const match = (m: ServerMsg) => m.t === t && pred(m as Extract<ServerMsg, { t: T }>);
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0] as Extract<ServerMsg, { t: T }>);
      return new Promise<Extract<ServerMsg, { t: T }>>((ok, fail) => {
        const timer = setTimeout(() => fail(new Error(`timed out waiting for ${t}`)), 2000);
        waiters.push({ pred: match, ok: (m) => (clearTimeout(timer), ok(m as Extract<ServerMsg, { t: T }>)) });
      });
    },
  };
}

async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function closed(ws: WebSocket, ms = 2000) {
  return new Promise<number>((ok, fail) => {
    const t = setTimeout(() => fail(new Error('socket was not closed')), ms);
    ws.once('close', (code) => (clearTimeout(t), ok(code)));
  });
}

/** A controllable clock for the app under test. */
function fakeClock() {
  const c = { t: Date.now(), now: () => c.t };
  return c;
}

const ID_A = 'aaaaaaaaaaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbbbbbbbbbb';
const ID_C = 'cccccccccccccccccccc';

describe('server', () => {
  it('serves health', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/healthz`);
    expect(await res.json()).toMatchObject({ ok: true, rooms: 0 });
  });

  it('plays a full round between two players over WebSockets', async () => {
    const { base, ws } = await start();
    const { status, body } = await createRoom(base, { deckId: 'fibonacci' });
    expect(status).toBe(201);
    const roomId = body.id!;

    const a = await client(ws);
    a.send({ t: 'join', roomId, clientId: ID_A, name: 'Alice', spectator: false });
    const wa = await a.next('welcome');
    expect(wa.room.participants).toHaveLength(1);

    const b = await client(ws);
    b.send({ t: 'join', roomId, clientId: ID_B, name: 'Bob', spectator: false });
    await b.next('welcome');
    await a.next('state', (m) => m.room.participants.length === 2);

    a.send({ t: 'vote', value: '5' });
    // Bob learns Alice voted, but not what.
    const seenByB = await b.next('state', (m) => m.room.participants.some((p) => p.voted));
    expect(seenByB.room.participants.find((p) => p.name === 'Alice')).toMatchObject({ voted: true, vote: null });

    b.send({ t: 'vote', value: '8' });
    await a.next('state', (m) => m.room.participants.every((p) => p.voted));
    a.send({ t: 'reveal' });
    const revealed = await b.next('state', (m) => m.room.revealed);
    expect(revealed.room.participants.map((p) => p.vote).sort()).toEqual(['5', '8']);

    b.send({ t: 'react', emoji: '🎉' });
    expect(await a.next('reaction')).toMatchObject({ name: 'Bob', emoji: '🎉' });

    a.send({ t: 'reset' });
    const fresh = await b.next('state', (m) => m.room.round === 2);
    expect(fresh.room.revealed).toBe(false);
    expect(fresh.room.participants.every((p) => !p.voted)).toBe(true);
  });

  it('nudges only people who have not voted', async () => {
    const { base, ws } = await start();
    const roomId = (await createRoom(base)).body.id!;
    const a = await client(ws);
    a.send({ t: 'join', roomId, clientId: ID_A, name: 'Alice', spectator: false });
    await a.next('welcome');
    const b = await client(ws);
    b.send({ t: 'join', roomId, clientId: ID_B, name: 'Bob', spectator: false });
    await b.next('welcome');
    a.send({ t: 'vote', value: '3' });
    await b.next('state', (m) => m.room.participants.some((p) => p.voted));
    a.send({ t: 'nudge' });
    expect(await b.next('nudge')).toMatchObject({ fromName: 'Alice' });
    a.send({ t: 'nudge' });
    expect(await a.next('error')).toMatchObject({ code: 'rate_limited' });
  });

  it('reports unknown rooms', async () => {
    const { ws } = await start();
    const a = await client(ws);
    a.send({ t: 'join', roomId: 'Nope123456', clientId: ID_A, name: 'A', spectator: false });
    expect(await a.next('error')).toMatchObject({ code: 'room_not_found' });
  });

  it('rejects cross-origin WebSocket upgrades', async () => {
    const { ws } = await start();
    await expect(client(ws, { Origin: 'https://evil.example' })).rejects.toThrow(/403/);
  });

  it('rate limits room creation per IP', async () => {
    const { base } = await start({ roomsPerIpPerHour: 2 });
    expect((await createRoom(base)).status).toBe(201);
    expect((await createRoom(base)).status).toBe(201);
    expect((await createRoom(base)).status).toBe(429);
  });

  it('rejects bad decks', async () => {
    const { base } = await start();
    expect((await createRoom(base, { deckId: 'nope' })).status).toBe(400);
    expect((await createRoom(base, { deckId: 'custom', custom: ['x'] })).status).toBe(400);
    expect((await createRoom(base, { deckId: 'custom', custom: ['S', 'M', 'L'] })).status).toBe(201);
  });

  it('persists rooms across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poker-'));
    const dataFile = join(dir, 'rooms.json');
    const first = await start({ dataFile });
    const roomId = (await createRoom(first.base)).body.id!;
    const a = await client(first.ws);
    a.send({ t: 'join', roomId, clientId: ID_A, name: 'Alice', spectator: false });
    await a.next('welcome');
    a.send({ t: 'story', story: 'Checkout flow' });
    a.send({ t: 'vote', value: '13' });
    await a.next('state', (m) => m.room.participants[0]!.vote === '13' && m.room.story === 'Checkout flow');
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);

    const second = await start({ dataFile });
    const again = await client(second.ws);
    again.send({ t: 'join', roomId, clientId: ID_A, name: 'Alice', spectator: false });
    const w = await again.next('welcome');
    expect(w.room.story).toBe('Checkout flow');
    expect(w.room.participants[0]!.vote).toBe('13');
  });

  it('serves the SPA shell for room URLs and blocks path traversal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poker-static-'));
    writeFileSync(join(dir, 'index.html'), '<html>shell</html>');
    const { base } = await start({ staticDir: dir });
    const res = await fetch(`${base}/r/AbCdEfGh12`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await res.text()).toContain('shell');
    const trav = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    expect(await trav.text()).not.toContain('root:');
  });

  it('survives malformed request paths (regression: one request crashed the process)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poker-static-'));
    writeFileSync(join(dir, 'index.html'), '<html>shell</html>');
    const { base } = await start({ staticDir: dir });
    const port = new URL(base).port;
    for (const path of ['/%E0%A4%A', '/%ff', '/%', '//', '///etc/passwd', '/a%00b', '/assets/../../x']) {
      // Raw socket so the client library can't normalize the path for us.
      const status = await new Promise<string>((ok) => {
        const sock = connect(Number(port), '127.0.0.1', () => sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
        let buf = '';
        sock.on('data', (d) => (buf += d.toString()));
        sock.on('close', () => ok(buf.split('\r\n')[0] ?? ''));
        sock.on('error', () => ok('socket error'));
      });
      expect(status, path).toMatch(/^HTTP\/1\.1 (200|400)/);
      expect((await fetch(`${base}/healthz`)).status, `alive after ${path}`).toBe(200);
    }
  });

  it('rejects non-object JSON bodies with 400', async () => {
    const { base } = await start();
    for (const body of ['null', '[]', '"x"', '5']) {
      const res = await fetch(`${base}/api/rooms`, { method: 'POST', body });
      expect(res.status, body).toBe(400);
    }
  });

  it('counts slow concurrent room creations against the per-IP limit', async () => {
    const { base } = await start({ roomsPerIpPerHour: 3 });
    const port = Number(new URL(base).port);
    // Open 8 requests that all pass the header phase before any body arrives.
    const socks = await Promise.all(
      Array.from({ length: 8 }, () => new Promise<ReturnType<typeof connect>>((ok) => {
        const s = connect(port, '127.0.0.1', () => {
          s.write('POST /api/rooms HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n');
          ok(s);
        });
      })),
    );
    await new Promise((r) => setTimeout(r, 100));
    const statuses = await Promise.all(socks.map((s) => new Promise<string>((ok) => {
      let buf = '';
      s.on('data', (d) => (buf += d.toString()));
      s.on('close', () => ok(buf.split(' ')[1] ?? ''));
      s.write('{}');
    })));
    expect(statuses.filter((x) => x === '201')).toHaveLength(3);
    expect(statuses.filter((x) => x === '429')).toHaveLength(5);
  });
});

describe('room lifetime', () => {
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;

  async function joinRoom(wsUrl: string, roomId: string, clientId = ID_A, name = 'Alice') {
    const c = await client(wsUrl);
    c.send({ t: 'join', roomId, clientId, name, spectator: false });
    return c;
  }

  /** Creates a room, has Alice join and leave, advances the clock past the 30-day TTL and sweeps. */
  async function expiredRoom(clock: ReturnType<typeof fakeClock>, opts: Parameters<typeof createApp>[0] = {}, deckBody: object = { deckId: 'tshirt' }) {
    const s = await start({ now: clock.now, ...opts });
    const roomId = (await createRoom(s.base, deckBody)).body.id!;
    const a = await joinRoom(s.ws, roomId);
    await a.next('welcome');
    a.ws.close();
    await until(() => s.app.rooms.get(roomId)!.connectedCount === 0);
    clock.t += 31 * DAY;
    s.app.sweep();
    return { ...s, roomId };
  }

  it('keeps an idle room with full state for 30 days, then leaves a tombstone', async () => {
    const clock = fakeClock();
    const s = await start({ now: clock.now });
    const roomId = (await createRoom(s.base, { deckId: 'tshirt' })).body.id!;
    const a = await joinRoom(s.ws, roomId);
    await a.next('welcome');
    a.send({ t: 'story', story: 'Keep me' });
    await a.next('state', (m) => m.room.story === 'Keep me');
    a.ws.close();
    await until(() => s.app.rooms.get(roomId)!.connectedCount === 0);

    clock.t += 29 * DAY;
    s.app.sweep();
    expect(s.app.rooms.get(roomId)!.story).toBe('Keep me');
    expect(s.app.tombstones.size).toBe(0);

    clock.t += 2 * DAY;
    s.app.sweep();
    expect(s.app.rooms.has(roomId)).toBe(false);
    expect(s.app.tombstones.get(roomId)).toMatchObject({ id: roomId, deckId: 'tshirt' });
    expect(JSON.stringify(s.app.tombstones.get(roomId))).not.toContain('Keep me');
  });

  it('revives a tombstoned room under the same id and deck, with a fresh story and round', async () => {
    const clock = fakeClock();
    const s = await expiredRoom(clock, {}, { deckId: 'custom', custom: ['S', 'M', 'L'] });
    expect(s.app.rooms.size).toBe(0);
    const b = await joinRoom(s.ws, s.roomId, ID_B, 'Bob');
    const w = await b.next('welcome');
    expect(w.room).toMatchObject({ id: s.roomId, deckId: 'custom', cards: ['S', 'M', 'L'], story: '', round: 1 });
    expect(w.room.participants).toHaveLength(1);
    expect(s.app.rooms.has(s.roomId)).toBe(true);
    expect(s.app.tombstones.has(s.roomId)).toBe(false);
  });

  it('drops tombstones 90 days after last activity', async () => {
    const clock = fakeClock();
    const s = await expiredRoom(clock);
    clock.t += 58 * DAY; // 89 days since last activity
    s.app.sweep();
    expect(s.app.tombstones.has(s.roomId)).toBe(true);
    clock.t += 2 * DAY; // 91 days
    s.app.sweep();
    expect(s.app.tombstones.size).toBe(0);
    const late = await joinRoom(s.ws, s.roomId);
    expect(await late.next('error')).toMatchObject({ code: 'room_not_found' });
  });

  it('refuses to revive a tombstone that is past its 90 days even if the sweeper has not run yet', async () => {
    const clock = fakeClock();
    const s = await expiredRoom(clock);
    clock.t += 60 * DAY; // no sweep
    const late = await joinRoom(s.ws, s.roomId);
    expect(await late.next('error')).toMatchObject({ code: 'room_not_found' });
  });

  it('does not revive ids that are neither live nor tombstoned', async () => {
    const { ws, app } = await start();
    const a = await joinRoom(ws, 'Nope123456');
    expect(await a.next('error')).toMatchObject({ code: 'room_not_found' });
    expect(app.rooms.size).toBe(0);
  });

  it('counts revival against the per-IP creation limit', async () => {
    const clock = fakeClock();
    const s2 = await start({ now: clock.now, roomsPerIpPerHour: 1, roomTtlMs: 1000, tombstoneTtlMs: 10 * DAY });
    await createRoom(s2.base); // uses this IP's one slot for the hour
    const id = [...s2.app.rooms.keys()][0]!;
    const a = await joinRoom(s2.ws, id);
    await a.next('welcome');
    a.ws.close();
    await until(() => s2.app.rooms.get(id)!.connectedCount === 0);
    clock.t += 5000;
    s2.app.sweep();
    expect(s2.app.tombstones.has(id)).toBe(true);
    const b = await joinRoom(s2.ws, id, ID_B, 'Bob');
    expect(await b.next('error')).toMatchObject({ code: 'rate_limited' });
    expect(s2.app.rooms.has(id)).toBe(false);
    // ...but a different IP can still revive it
    const c = await client(s2.ws, { 'CF-Connecting-IP': '203.0.113.9' });
    c.send({ t: 'join', roomId: id, clientId: ID_C, name: 'Cara', spectator: false });
    await c.next('welcome');
  });

  it('counts revival against the room cap', async () => {
    const clock = fakeClock();
    const s = await start({ now: clock.now, roomTtlMs: 1000, maxRooms: 1 });
    const first = (await createRoom(s.base)).body.id!;
    const a = await joinRoom(s.ws, first);
    await a.next('welcome');
    a.ws.close();
    await until(() => s.app.rooms.get(first)!.connectedCount === 0);
    clock.t += 5000;
    s.app.sweep();
    expect((await createRoom(s.base)).status).toBe(201); // takes the only slot
    const b = await joinRoom(s.ws, first, ID_B, 'Bob');
    expect(await b.next('error')).toMatchObject({ code: 'rate_limited', message: expect.stringContaining('capacity') });
    expect(s.app.rooms.has(first)).toBe(false);
  });

  it('starts a fresh round when someone returns to an empty room after 4 hours', async () => {
    const clock = fakeClock();
    const s = await start({ now: clock.now });
    const roomId = (await createRoom(s.base)).body.id!;
    const a = await joinRoom(s.ws, roomId);
    await a.next('welcome');
    const b = await joinRoom(s.ws, roomId, ID_B, 'Bob');
    await b.next('welcome');
    a.send({ t: 'vote', value: '5' });
    await b.next('state', (m) => m.room.participants.some((p) => p.voted));
    a.send({ t: 'story', story: 'Yesterday' });
    a.ws.close();
    b.ws.close();
    await until(() => s.app.rooms.get(roomId)!.connectedCount === 0);

    clock.t += 3 * HOUR; // short gap: everything is as they left it
    const early = await joinRoom(s.ws, roomId);
    const ew = await early.next('welcome');
    expect(ew.room.round).toBe(1);
    expect(ew.room.participants).toHaveLength(2);
    expect(ew.room.participants[0]!.vote).toBe('5');
    early.ws.close();
    await until(() => s.app.rooms.get(roomId)!.connectedCount === 0);

    clock.t += 5 * HOUR;
    const late = await joinRoom(s.ws, roomId);
    const lw = await late.next('welcome');
    expect(lw.room.round).toBe(2);
    expect(lw.room.revealed).toBe(false);
    expect(lw.room.participants).toHaveLength(1);
    expect(lw.room.participants[0]!.vote).toBeNull();
    expect(lw.room.story).toBe('Yesterday');
  });

  it('persists tombstones and loads both the v2 and the legacy file format', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poker-'));
    const dataFile = join(dir, 'rooms.json');
    const clock = fakeClock();
    const first = await expiredRoom(clock, { dataFile }, { deckId: 'powers' });
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);
    const saved = JSON.parse(readFileSync(dataFile, 'utf8'));
    expect(saved.version).toBe(2);
    expect(saved.rooms).toEqual([]);
    expect(saved.tombstones).toHaveLength(1);

    const second = await start({ now: clock.now, dataFile });
    expect(second.app.tombstones.has(first.roomId)).toBe(true);
    const b = await joinRoom(second.ws, first.roomId, ID_B, 'Bob');
    expect((await b.next('welcome')).room.deckId).toBe('powers');

    // legacy: a plain array of snapshots, one of which is long expired and becomes a tombstone
    const live = new Room('Legacy123a', clock.t);
    live.join(ID_A, 'Alice', false, clock.t);
    live.vote(ID_A, '5', clock.t);
    live.leave(ID_A, clock.t);
    const old = new Room('Legacy456a', clock.t - 40 * DAY);
    old.setDeck('tshirt', undefined, clock.t - 40 * DAY);
    const legacyFile = join(dir, 'legacy.json');
    writeFileSync(legacyFile, JSON.stringify([live.snapshot(), old.snapshot()]));
    const third = await start({ now: clock.now, dataFile: legacyFile });
    expect([...third.app.rooms.keys()]).toEqual(['Legacy123a']);
    expect(third.app.tombstones.get('Legacy456a')).toMatchObject({ deckId: 'tshirt' });
    const again = await joinRoom(third.ws, 'Legacy123a');
    expect((await again.next('welcome')).room.participants[0]!.vote).toBe('5');
  });
});

describe('persistence robustness', () => {
  it('moves a corrupt data file aside instead of overwriting it, and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poker-'));
    const dataFile = join(dir, 'rooms.json');
    writeFileSync(dataFile, '{"version":2,"rooms":[{"id":');
    const logs: string[] = [];
    const { app } = await start({ dataFile, log: (m) => logs.push(m) });
    const backups = readdirSync(dir).filter((f) => f.startsWith('rooms.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe('{"version":2,"rooms":[{"id":');
    expect(existsSync(dataFile)).toBe(false);
    expect(logs.join('\n')).toMatch(/ERROR: could not read .*moved it to .*corrupt-/);
    await app.close(); // writes a fresh file; the backup stays
    expect(readdirSync(dir).filter((f) => f.startsWith('rooms.json.corrupt-'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(dataFile, 'utf8')).version).toBe(2);
  });

  it('also treats valid JSON of the wrong shape as corrupt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poker-'));
    const dataFile = join(dir, 'rooms.json');
    writeFileSync(dataFile, '{"hello":"world"}');
    await start({ dataFile });
    expect(readdirSync(dir).some((f) => f.startsWith('rooms.json.corrupt-'))).toBe(true);
  });

  it('restores room by room, so one bad entry does not drop the others', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poker-'));
    const dataFile = join(dir, 'rooms.json');
    const now = Date.now();
    const good = new Room('GoodRoom12', now);
    good.join(ID_A, 'Alice', false, now);
    const tomb = { id: 'GoodTomb12', deckId: 'tshirt', cards: ['S', 'M'], lastActivity: now };
    writeFileSync(
      dataFile,
      JSON.stringify({
        version: 2,
        rooms: [{ id: 'BadRoom123', participants: 7 }, null, good.snapshot(), { id: 'Bad id!', deckId: 'fibonacci', cards: ['1', '2'], participants: [] }],
        tombstones: [{ id: 'x' }, tomb],
      }),
    );
    const logs: string[] = [];
    const { app, base } = await start({ dataFile, log: (m) => logs.push(m) });
    expect([...app.rooms.keys()]).toEqual(['GoodRoom12']);
    expect([...app.tombstones.keys()]).toEqual(['GoodTomb12']);
    expect(logs.filter((l) => l.startsWith('ERROR: skipped'))).toHaveLength(4);
    expect(((await (await fetch(`${base}/healthz`)).json()) as { rooms: number }).rooms).toBe(1);
    expect(readdirSync(dir).some((f) => f.includes('corrupt'))).toBe(false);
  });

  it('saves shortly after the last change instead of waiting for the periodic save', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poker-'));
    const dataFile = join(dir, 'rooms.json');
    const { base } = await start({ dataFile, saveDebounceMs: 30 });
    expect(existsSync(dataFile)).toBe(false);
    const roomId = (await createRoom(base)).body.id!;
    await until(() => existsSync(dataFile), 1000);
    expect(JSON.parse(readFileSync(dataFile, 'utf8')).rooms.map((r: { id: string }) => r.id)).toEqual([roomId]);
  });

  it('logs how many rooms it saved on shutdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poker-'));
    const logs: string[] = [];
    const { app, base } = await start({ dataFile: join(dir, 'rooms.json'), log: (m) => logs.push(m) });
    await createRoom(base);
    await createRoom(base);
    await app.close();
    expect(logs).toContain('saved 2 room(s)');
  });

  it('logs and rethrows when the final save fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poker-'));
    const logs: string[] = [];
    const { app } = await start({ dataFile: join(dir, 'missing-dir', 'rooms.json'), log: (m) => logs.push(m) });
    await expect(app.close()).rejects.toThrow(/ENOENT/);
    expect(logs.join('\n')).toMatch(/ERROR: final save failed/);
  });

  it('exits non-zero when the final save fails on SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poker-'));
    const child = spawn(process.execPath, [join(process.cwd(), 'server/index.ts')], {
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_FILE: join(dir, 'missing-dir', 'rooms.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const exit = new Promise<number | null>((ok) => child.on('exit', (code) => ok(code)));
    try {
      await until(() => out.includes('listening'), 5000);
      child.kill('SIGTERM');
      expect(await exit).toBe(1);
      expect(out).toContain('final save failed');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('http hardening', () => {
  it('sends HSTS (without includeSubDomains), COOP and CORP', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/healthz`);
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });

  it('answers 413 to an oversized POST body instead of resetting the connection', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/rooms`, { method: 'POST', body: JSON.stringify({ custom: 'x'.repeat(5000) }) });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
    const port = Number(new URL(base).port);
    const status = await new Promise<string>((ok) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write(`POST /api/rooms HTTP/1.1\r\nHost: x\r\nContent-Length: 20000\r\nConnection: close\r\n\r\n${'x'.repeat(20000)}`);
      });
      let buf = '';
      sock.on('data', (d) => (buf += d.toString()));
      // The server answers 413 and closes while we may still be uploading the rest of the body, so the client can
      // see ECONNRESET after the response already arrived (normal TCP behaviour; real clients read the response).
      // Judge by what was received, and only call it a socket error when nothing came back at all.
      const settle = () => ok(buf.split('\r\n')[0] || 'socket error');
      sock.on('close', settle);
      sock.on('error', settle);
    });
    expect(status).toBe('HTTP/1.1 413 Payload Too Large');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});

describe('socket hardening', () => {
  async function joined(wsUrl: string, roomId: string, clientId: string, headers: Record<string, string> = {}) {
    const c = await client(wsUrl, headers);
    c.send({ t: 'join', roomId, clientId, name: 'P', spectator: false });
    return c;
  }

  it('allows 5 sockets per clientId in a room and rejects the 6th with an error and a close', async () => {
    const { base, ws } = await start();
    const roomId = (await createRoom(base)).body.id!;
    const tabs: Awaited<ReturnType<typeof joined>>[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await joined(ws, roomId, ID_A);
      await t.next('welcome');
      tabs.push(t);
    }
    const sixth = await joined(ws, roomId, ID_A);
    const done = closed(sixth.ws);
    expect(await sixth.next('error')).toMatchObject({ code: 'rate_limited' });
    expect(await done).toBe(1008);
    // someone else is unaffected
    const other = await joined(ws, roomId, ID_B);
    await other.next('welcome');
    // and a seat frees up when a tab closes
    tabs[0]!.ws.close();
    await until(() => tabs[0]!.ws.readyState === WebSocket.CLOSED);
    const again = await joined(ws, roomId, ID_A);
    await again.next('welcome');
  });

  it('refuses upgrades past the per-IP socket cap with 429, keyed on the client IP', async () => {
    const { ws } = await start({ maxSocketsPerIp: 2 });
    const one = await client(ws);
    await client(ws);
    await expect(client(ws)).rejects.toThrow(/429/);
    // a different client IP (as set by cloudflared) is counted separately
    await client(ws, { 'CF-Connecting-IP': '203.0.113.7' });
    // closing a socket releases its slot
    one.ws.close();
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) {
      ok = await client(ws).then(() => true, () => false);
      if (!ok) await new Promise((r) => setTimeout(r, 10));
    }
    expect(ok).toBe(true);
  });

  it('closes sockets that do not join within the deadline (4000), but not ones that did', async () => {
    const { base, ws } = await start({ joinDeadlineMs: 120 });
    const roomId = (await createRoom(base)).body.id!;
    const idle = await client(ws);
    const idleClosed = closed(idle.ws);
    const failedJoin = await client(ws);
    failedJoin.send({ t: 'join', roomId: 'Nope123456', clientId: ID_B, name: 'X', spectator: false });
    const failedClosed = closed(failedJoin.ws);
    const ok = await joined(ws, roomId, ID_A);
    await ok.next('welcome');
    expect(await idleClosed).toBe(4000);
    expect(await failedClosed).toBe(4000);
    ok.send({ t: 'ping' });
    await ok.next('pong');
    expect(ok.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('counts binary frames against the rate limit and closes persistent offenders with 1008', async () => {
    const { ws } = await start({ now: () => 1_000_000 }); // frozen clock: no refill, so exactly 30 frames are free
    const a = await client(ws);
    const done = closed(a.ws);
    for (let i = 0; i < 100; i++) a.ws.send(Buffer.from([1, 2, 3]));
    expect(await done).toBe(1008);
  });

  it('closes persistent text spammers with 1008, but only after the threshold', async () => {
    const { ws } = await start({ now: () => 1_000_000, abuseKickThreshold: 20 });
    const a = await client(ws);
    const done = closed(a.ws);
    for (let i = 0; i < 30 + 19; i++) a.send({ t: 'ping' });
    // 19 rejections so far: still open, and told to slow down
    await a.next('error', (m) => m.code === 'rate_limited');
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    a.send({ t: 'ping' });
    expect(await done).toBe(1008);
  });

  it('does not leak anyone else\'s vote in any raw frame before reveal, and sends each viewer their own', async () => {
    const { base, ws, app } = await start();
    const roomId = (await createRoom(base)).body.id!;
    const a = await joined(ws, roomId, ID_A);
    await a.next('welcome');
    const b = await joined(ws, roomId, ID_B);
    await b.next('welcome');
    const c = await client(ws);
    c.send({ t: 'join', roomId, clientId: ID_C, name: 'Spec', spectator: true });
    await c.next('welcome');
    a.send({ t: 'vote', value: '34' });
    b.send({ t: 'vote', value: '89' });
    await until(() => [...app.rooms.get(roomId)!.participants.values()].filter((p) => p.vote).length === 2);
    for (const x of [a, b, c]) {
      x.send({ t: 'ping' });
      await x.next('pong'); // every state frame sent before this has arrived
    }
    const all = (x: typeof a) => x.raw.join('\n');
    expect(all(a)).toContain('"vote":"34"');
    expect(all(a)).not.toContain('"vote":"89"');
    expect(all(b)).toContain('"vote":"89"');
    expect(all(b)).not.toContain('"vote":"34"');
    expect(all(c)).not.toMatch(/"vote":"(34|89)"/);

    // The assembled frame is exactly what the room's own per-viewer view says.
    const room = app.rooms.get(roomId)!;
    for (const [x, id] of [[a, ID_A], [b, ID_B], [c, ID_C]] as const) {
      const last = [...x.raw].reverse().map((r) => JSON.parse(r) as ServerMsg).find((m) => m.t === 'state')!;
      if (last.t !== 'state') throw new Error('no state');
      expect(last.room).toEqual(room.view(id, last.room.now));
    }

    a.send({ t: 'reveal' });
    for (const x of [a, b, c]) {
      const r = await x.next('state', (m) => m.room.revealed);
      expect(r.room.participants.map((p) => p.vote).sort()).toEqual(['34', '89', null]);
    }
  });
});

describe('game state and join flow', () => {
  const DAY = 24 * 3600_000;

  async function join(wsUrl: string, roomId: string, clientId: string, name: string, spectator = false) {
    const c = await client(wsUrl);
    c.send({ t: 'join', roomId, clientId, name, spectator });
    const welcome = await c.next('welcome');
    return Object.assign(c, { welcome });
  }

  it('leave removes the seat immediately, broadcasts it, and detaches the socket', async () => {
    const { app, base, ws } = await start({ graceMs: 60_000 });
    const roomId = (await createRoom(base)).body.id!;
    const a = await join(ws, roomId, ID_A, 'Alice');
    const b = await join(ws, roomId, ID_B, 'Bob');
    b.send({ t: 'vote', value: '8' });
    await a.next('state', (m) => m.room.participants.some((p) => p.voted));
    b.send({ t: 'leave' });
    await until(() => !app.rooms.get(roomId)!.participants.has(ID_B)); // long before the 60s grace period
    a.send({ t: 'ping' });
    await a.next('pong');
    const last = [...a.raw].reverse().map((r) => JSON.parse(r) as ServerMsg).find((m) => m.t === 'state')!;
    if (last.t !== 'state') throw new Error('no state');
    expect(last.room.participants.map((p) => p.name)).toEqual(['Alice']);
    expect(last.room.participants[0]!.voted).toBe(false);
    // Detached: later room messages are refused, and the closing socket does not re-broadcast.
    b.send({ t: 'vote', value: '3' });
    expect(await b.next('error')).toMatchObject({ code: 'not_joined' });
    const statesSeen = () => b.raw.filter((r) => r.startsWith('{"t":"state"')).length;
    const before = statesSeen();
    a.send({ t: 'vote', value: '5' });
    await a.next('state', (m) => m.room.participants[0]!.voted);
    b.send({ t: 'ping' });
    await b.next('pong');
    expect(statesSeen()).toBe(before); // no longer receives this room's broadcasts
    b.ws.close();
    await closed(b.ws);
    expect(app.rooms.get(roomId)!.participants.size).toBe(1);
  });

  it('a nudge with nobody to nudge does not start the room cooldown', async () => {
    const { base, ws } = await start();
    const roomId = (await createRoom(base)).body.id!;
    const a = await join(ws, roomId, ID_A, 'Alice');
    a.send({ t: 'vote', value: '3' });
    await a.next('state', (m) => m.room.participants[0]!.voted);
    a.send({ t: 'nudge' }); // only you: nothing to do
    a.send({ t: 'ping' });
    await a.next('pong');
    const b = await join(ws, roomId, ID_B, 'Bob');
    a.send({ t: 'nudge' });
    expect(await b.next('nudge')).toMatchObject({ fromName: 'Alice' });
    expect(a.raw.join('\n')).not.toContain('rate_limited');
  });

  it('keeps results unchanged when a voter flips to spectator after the reveal', async () => {
    const { base, ws } = await start();
    const roomId = (await createRoom(base)).body.id!;
    const a = await join(ws, roomId, ID_A, 'Alice');
    const b = await join(ws, roomId, ID_B, 'Bob');
    a.send({ t: 'vote', value: '3' });
    b.send({ t: 'vote', value: '8' });
    await a.next('state', (m) => m.room.participants.every((p) => p.voted));
    a.send({ t: 'reveal' });
    await b.next('state', (m) => m.room.revealed);
    b.send({ t: 'profile', spectator: true });
    const st = await a.next('state', (m) => m.room.participants.some((p) => p.spectator));
    expect(st.room.participants.map((p) => p.vote).sort()).toEqual(['3', '8']);
  });

  describe('GET /api/rooms/:id', () => {
    const get = (base: string, id: string, headers: Record<string, string> = {}) => fetch(`${base}/api/rooms/${id}`, { headers });

    it('describes a live room with only the story, head-count and deck, never votes', async () => {
      const { app, base, ws } = await start();
      const roomId = (await createRoom(base, { deckId: 'tshirt' })).body.id!;
      const a = await join(ws, roomId, ID_A, 'Alice');
      const b = await join(ws, roomId, ID_B, 'Bob');
      await join(ws, roomId, ID_C, 'Cara', true);
      a.send({ t: 'story', story: 'Login page' });
      a.send({ t: 'vote', value: 'XL' });
      await b.next('state', (m) => m.room.story === 'Login page' && m.room.participants.some((p) => p.voted));
      b.ws.close();
      await until(() => app.rooms.get(roomId)!.connectedCount === 2);
      const res = await get(base, roomId);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['deckLabel', 'players', 'status', 'story']);
      expect(body).toMatchObject({ status: 'live', story: 'Login page', deckLabel: 'T-shirt sizes' });
      expect(JSON.stringify(body)).not.toContain('XL');
    });

    it('counts only connected non-spectators', async () => {
      const { app, base, ws } = await start();
      const roomId = (await createRoom(base)).body.id!;
      await join(ws, roomId, ID_A, 'Alice');
      const b = await join(ws, roomId, ID_B, 'Bob');
      await join(ws, roomId, ID_C, 'Cara', true);
      b.ws.close();
      await until(() => app.rooms.get(roomId)!.connectedCount === 2);
      expect(await (await get(base, roomId)).json()).toMatchObject({ status: 'live', players: 1 });
    });

    it('reports a revivable tombstone without reviving it, and 404 once it is gone or never existed', async () => {
      const clock = fakeClock();
      const s = await start({ now: clock.now });
      const roomId = (await createRoom(s.base, { deckId: 'powers' })).body.id!;
      const a = await join(s.ws, roomId, ID_A, 'Alice');
      a.ws.close();
      await until(() => s.app.rooms.get(roomId)!.connectedCount === 0);
      clock.t += 31 * DAY;
      s.app.sweep();
      expect(s.app.tombstones.has(roomId)).toBe(true);
      const res = await get(s.base, roomId);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'revivable', deckLabel: 'Powers of 2' });
      expect(s.app.rooms.size).toBe(0); // looking does not revive
      expect((await get(s.base, 'Nope123456')).status).toBe(404);
      expect((await get(s.base, 'short')).status).toBe(404);
      clock.t += 70 * DAY; // past the 90-day tombstone window, before sweeping
      expect((await get(s.base, roomId)).status).toBe(404);
    });

    it('is rate limited per IP, and the window slides', async () => {
      const clock = fakeClock();
      const { base } = await start({ now: clock.now, lookupsPerIpPerMinute: 3 });
      const ip = { 'cf-connecting-ip': '203.0.113.7' };
      for (let i = 0; i < 3; i++) expect((await get(base, 'Nope123456', ip)).status).toBe(404);
      const limited = await get(base, 'Nope123456', ip);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
      // Another network is unaffected.
      expect((await get(base, 'Nope123456', { 'cf-connecting-ip': '203.0.113.8' })).status).toBe(404);
      clock.t += 61_000;
      expect((await get(base, 'Nope123456', ip)).status).toBe(404);
    });

    it('does not shadow other API paths or methods', async () => {
      const { base } = await start();
      expect((await fetch(`${base}/api/rooms/Nope123456`, { method: 'POST' })).status).toBe(404);
      expect((await fetch(`${base}/api/nothing`)).status).toBe(404);
    });
  });
});

describe('undo, facilitator lock, ghost seats (over WebSockets)', () => {
  type Client = Awaited<ReturnType<typeof client>>;
  const SECRET_A = 'q7xA';
  const SECRET_B = 'q8yB';

  /** Round-trips a ping so every earlier reply on this socket has arrived. */
  async function sync(c: Client) {
    c.send({ t: 'ping' });
    await c.next('pong');
  }

  async function lobby(opts: Parameters<typeof createApp>[0] = {}) {
    const s = await start(opts);
    const roomId = (await createRoom(s.base, { deckId: 'custom', custom: [SECRET_A, SECRET_B, '?'] })).body.id!;
    const join = async (clientId: string, name: string, spectator = false) => {
      const c = await client(s.ws);
      c.send({ t: 'join', roomId, clientId, name, spectator });
      const w = await c.next('welcome');
      return { c, you: w.you };
    };
    const a = await join(ID_A, 'Alice');
    const b = await join(ID_B, 'Bob');
    await a.c.next('state', (m) => m.room.participants.length === 2);
    return { ...s, roomId, join, a, b };
  }

  /** The last room view a client has been sent. */
  const lastState = (c: Client) => {
    const msgs = c.raw.map((r) => JSON.parse(r) as ServerMsg).filter((m) => m.t === 'state' || m.t === 'welcome');
    return (msgs.at(-1) as Extract<ServerMsg, { t: 'state' | 'welcome' }>).room;
  };

  it('undoes a new round for everyone, announces it, and never leaks a vote before the reveal', async () => {
    const clock = fakeClock();
    const { a, b } = await lobby({ now: clock.now });
    a.c.send({ t: 'vote', value: SECRET_A });
    b.c.send({ t: 'vote', value: SECRET_B });
    await b.c.next('state', (m) => m.room.participants.every((p) => p.voted));
    a.c.send({ t: 'reset' });
    const after = await b.c.next('state', (m) => m.room.round === 2);
    expect(after.room.undo).toMatchObject({ kind: 'reset', byName: 'Alice', byId: a.you, until: clock.t + 10_000 });
    expect(after.room.participants.every((p) => !p.voted)).toBe(true);

    clock.t += 9_000;
    b.c.send({ t: 'undo' });
    expect(await a.c.next('notice')).toMatchObject({ kind: 'undone', what: 'reset', byName: 'Bob', byId: b.you });
    await sync(a.c); // the notice is followed by the restored state
    const restored = { room: lastState(a.c) };
    expect(restored.room.round).toBe(1);
    expect(restored.room.undo).toBeNull();
    expect(restored.room.revealed).toBe(false);
    expect(restored.room.participants.every((p) => p.voted)).toBe(true);
    // Alice sees her own card and nobody else's.
    expect(restored.room.participants.map((p) => p.vote)).toEqual([SECRET_A, null]);

    // The whole conversation: Bob's card never reached Alice, and Alice's never reached Bob, before the reveal.
    await sync(a.c);
    await sync(b.c);
    for (const [c, me] of [[a.c, a.you], [b.c, b.you]] as const) {
      for (const raw of c.raw) {
        const m = JSON.parse(raw) as ServerMsg;
        if (m.t === 'state' || m.t === 'welcome') for (const p of m.room.participants) if (p.id !== me) expect(p.vote).toBeNull();
        // Notices and the undo summary carry names only.
        if (m.t === 'notice') expect(JSON.stringify(m)).not.toMatch(/q7xA|q8yB/);
      }
    }

    a.c.send({ t: 'reveal' });
    const shown = await b.c.next('state', (m) => m.room.revealed);
    expect(shown.room.participants.map((p) => p.vote)).toEqual([SECRET_A, SECRET_B]);
  });

  it('refuses to undo after the window or after a new vote, with a friendly error', async () => {
    const clock = fakeClock();
    const { a, b } = await lobby({ now: clock.now });
    a.c.send({ t: 'vote', value: SECRET_A });
    a.c.send({ t: 'reset' });
    await b.c.next('state', (m) => m.room.undo !== null);

    clock.t += 10_000; // exactly at the edge: closed
    b.c.send({ t: 'undo' });
    expect(await b.c.next('error')).toMatchObject({ code: 'bad_request', message: expect.stringMatching(/Too late/) });
    expect(lastState(a.c).round).toBe(2);

    clock.t += 1;
    a.c.send({ t: 'reset' });
    await b.c.next('state', (m) => m.room.round === 3 && m.room.undo !== null);
    b.c.send({ t: 'vote', value: SECRET_B }); // someone moves on
    const moved = await a.c.next('state', (m) => m.room.round === 3 && m.room.participants.some((p) => p.voted));
    expect(moved.room.undo).toBeNull();
    a.c.send({ t: 'undo' });
    expect(await a.c.next('error')).toMatchObject({ code: 'bad_request' });
    expect(lastState(b.c).round).toBe(3);
    expect(lastState(b.c).participants.find((p) => p.id === b.you)!.vote).toBe(SECRET_B);
  });

  it('undoes a deck change, restoring the deck and the votes', async () => {
    const { a, b } = await lobby();
    a.c.send({ t: 'vote', value: SECRET_A });
    a.c.send({ t: 'deck', deckId: 'tshirt' });
    const changed = await b.c.next('state', (m) => m.room.deckId === 'tshirt');
    expect(changed.room.undo).toMatchObject({ kind: 'deck', deckLabel: 'T-shirt sizes', byName: 'Alice' });
    b.c.send({ t: 'undo' });
    expect(await a.c.next('notice')).toMatchObject({ kind: 'undone', what: 'deck' });
    await sync(a.c);
    const back = { room: lastState(a.c) };
    expect(back.room.deckId).toBe('custom');
    expect(back.room.cards).toEqual([SECRET_A, SECRET_B, '?']);
    expect(back.room.participants[0]).toMatchObject({ voted: true, vote: SECRET_A });
  });

  it('keeps the timer through the reveal, clears it on a new round and brings it back on undo', async () => {
    const { a, b } = await lobby();
    a.c.send({ t: 'vote', value: SECRET_A });
    a.c.send({ t: 'timer', seconds: 120 });
    await b.c.next('state', (m) => m.room.timer !== null);
    a.c.send({ t: 'reveal' });
    const revealed = await b.c.next('state', (m) => m.room.revealed);
    expect(revealed.room.timer).toMatchObject({ duration: 120 });
    a.c.send({ t: 'reset' });
    const fresh = await b.c.next('state', (m) => m.room.round === 2);
    expect(fresh.room.timer).toBeNull();
    a.c.send({ t: 'undo' });
    await b.c.next('notice');
    await sync(b.c);
    const undone = { room: lastState(b.c) };
    expect(undone.room.round).toBe(1);
    expect(undone.room.timer).toMatchObject({ duration: 120 });
    expect(undone.room.revealed).toBe(true);
  });

  describe('facilitator lock', () => {
    it('is off by default: anyone can do everything', async () => {
      const { a, b } = await lobby();
      expect(lastState(a.c)).toMatchObject({ locked: false, facilitatorId: null });
      b.c.send({ t: 'story', story: 'Open to all' });
      await a.c.next('state', (m) => m.room.story === 'Open to all');
    });

    it('rejects every guarded action from non-facilitators, and still allows voting, reacting, profile changes', async () => {
      const { a, b } = await lobby();
      a.c.send({ t: 'lock', on: true });
      const locked = await b.c.next('state', (m) => m.room.locked);
      expect(locked.room.facilitatorId).toBe(a.you);
      expect(b.c.raw.join('\n')).not.toContain(ID_A); // the facilitator's clientId stays private

      b.c.send({ t: 'vote', value: SECRET_B }); // voting is open to everyone
      await a.c.next('state', (m) => m.room.participants.some((p) => p.voted));
      const attempts: ClientMsg[] = [
        { t: 'reveal' },
        { t: 'reset' },
        { t: 'story', story: 'hijack' },
        { t: 'deck', deckId: 'tshirt' },
        { t: 'timer', seconds: 30 },
        { t: 'timer', seconds: null },
        { t: 'undo' },
        { t: 'remove', id: a.you },
        { t: 'lock', on: false },
        { t: 'lock', on: true },
        { t: 'facilitator', id: b.you },
      ];
      for (const msg of attempts) {
        b.c.send(msg);
        const err = await b.c.next('error');
        expect(err.code, JSON.stringify(msg)).toBe('forbidden');
      }
      expect(lastState(a.c)).toMatchObject({ story: '', revealed: false, round: 1, deckId: 'custom', timer: null, locked: true, facilitatorId: a.you });

      // Still allowed for everyone.
      b.c.send({ t: 'react', emoji: '🎉' });
      await a.c.next('reaction');
      b.c.send({ t: 'profile', name: 'Robert', spectator: true });
      await a.c.next('state', (m) => m.room.participants.some((p) => p.name === 'Robert' && p.spectator));

      // The facilitator can.
      a.c.send({ t: 'story', story: 'Mine' });
      await b.c.next('state', (m) => m.room.story === 'Mine');
      a.c.send({ t: 'reveal' });
      await b.c.next('state', (m) => m.room.revealed);
    });

    it('explains who to ask', async () => {
      const { a, b } = await lobby();
      a.c.send({ t: 'lock', on: true });
      await b.c.next('state', (m) => m.room.locked);
      b.c.send({ t: 'reveal' });
      expect(await b.c.next('error')).toMatchObject({ code: 'forbidden', message: 'Only Alice can reveal the cards while facilitator controls are on.' });
    });

    it('hands the role over, and the new facilitator can use the controls while the old one cannot', async () => {
      const { a, b } = await lobby();
      a.c.send({ t: 'lock', on: true });
      await b.c.next('state', (m) => m.room.locked);
      a.c.send({ t: 'facilitator', id: b.you });
      const handed = await b.c.next('state', (m) => m.room.facilitatorId === b.you);
      expect(handed.room.locked).toBe(true);
      a.c.send({ t: 'reveal' });
      expect(await a.c.next('error')).toMatchObject({ code: 'forbidden' });
      b.c.send({ t: 'story', story: 'Bob runs this' });
      await a.c.next('state', (m) => m.room.story === 'Bob runs this');
      b.c.send({ t: 'lock', on: false });
      await a.c.next('state', (m) => !m.room.locked && m.room.facilitatorId === null);
    });

    it('releases with a notice when the facilitator leaves', async () => {
      const { a, b } = await lobby();
      a.c.send({ t: 'lock', on: true });
      await b.c.next('state', (m) => m.room.locked);
      a.c.send({ t: 'leave' });
      expect(await b.c.next('notice')).toEqual({ t: 'notice', kind: 'facilitator_left' });
      const open = await b.c.next('state', (m) => !m.room.locked);
      expect(open.room.facilitatorId).toBeNull();
      b.c.send({ t: 'story', story: 'Now open' });
      await b.c.next('state', (m) => m.room.story === 'Now open');
    });

    it('releases with a notice when the facilitator stays offline past the grace period', async () => {
      const clock = fakeClock();
      const { a, b, app } = await lobby({ now: clock.now, graceMs: 90_000 });
      a.c.send({ t: 'lock', on: true });
      await b.c.next('state', (m) => m.room.locked);
      a.c.ws.close();
      await b.c.next('state', (m) => m.room.participants.some((p) => !p.connected));
      clock.t += 60_000;
      app.sweep();
      await sync(b.c);
      expect(lastState(b.c).locked).toBe(true); // still within the grace period: the facilitator may be back
      clock.t += 31_000;
      app.sweep();
      expect(await b.c.next('notice')).toEqual({ t: 'notice', kind: 'facilitator_left' });
      const open = await b.c.next('state', (m) => !m.room.locked && m.room.participants.length === 1);
      expect(open.room.facilitatorId).toBeNull();
    });

    it('survives a reconnect of the facilitator (same client id) without releasing', async () => {
      const { a, b, join } = await lobby();
      a.c.send({ t: 'lock', on: true });
      await b.c.next('state', (m) => m.room.locked);
      a.c.ws.close();
      await b.c.next('state', (m) => m.room.participants.some((p) => !p.connected));
      const again = await join(ID_A, 'Alice');
      expect(again.you).toBe(a.you);
      expect(lastState(again.c)).toMatchObject({ locked: true, facilitatorId: a.you });
    });

    it('persists across a restart, with old files defaulting to unlocked', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'poker-'));
      const dataFile = join(dir, 'rooms.json');
      const first = await lobby({ dataFile });
      first.a.c.send({ t: 'lock', on: true });
      await first.b.c.next('state', (m) => m.room.locked);
      await first.app.close();
      apps.splice(apps.indexOf(first.app), 1);

      const saved = JSON.parse(readFileSync(dataFile, 'utf8')) as { rooms: { facilitator?: string | null }[] };
      expect(saved.rooms[0]!.facilitator).toBe(ID_A);

      const second = await start({ dataFile });
      const c = await client(second.ws);
      c.send({ t: 'join', roomId: first.roomId, clientId: ID_B, name: 'Bob', spectator: false });
      expect((await c.next('welcome')).room).toMatchObject({ locked: true });
      c.send({ t: 'reveal' });
      expect(await c.next('error')).toMatchObject({ code: 'forbidden' });
      await second.app.close();
      apps.splice(apps.indexOf(second.app), 1);

      // An older file (written before the lock existed) has no facilitator field.
      delete saved.rooms[0]!.facilitator;
      writeFileSync(dataFile, JSON.stringify({ version: 2, rooms: saved.rooms, tombstones: [] }));
      const third = await start({ dataFile });
      const d = await client(third.ws);
      d.send({ t: 'join', roomId: first.roomId, clientId: ID_B, name: 'Bob', spectator: false });
      expect((await d.next('welcome')).room).toMatchObject({ locked: false, facilitatorId: null });
    });
  });

  describe('ghost seats', () => {
    it('exposes a coarse offlineSince for offline seats only', async () => {
      const clock = fakeClock();
      clock.t = 1_700_000_123_456;
      const { a, b } = await lobby({ now: clock.now });
      b.c.ws.close();
      const st = await a.c.next('state', (m) => m.room.participants.some((p) => !p.connected));
      expect(st.room.participants.find((p) => p.id === b.you)!.offlineSince).toBe(1_700_000_123_000);
      expect(st.room.participants.find((p) => p.id === a.you)!.offlineSince).toBeNull();
    });

    it('lets anyone remove an offline seat, dropping their vote, and tells the room', async () => {
      const { a, b, join } = await lobby();
      const c = await join(ID_C, 'Cara');
      c.c.send({ t: 'vote', value: SECRET_A });
      await a.c.next('state', (m) => m.room.participants.length === 3 && m.room.participants.some((p) => p.voted));
      c.c.ws.close();
      await a.c.next('state', (m) => m.room.participants.some((p) => !p.connected));

      b.c.send({ t: 'remove', id: c.you });
      expect(await a.c.next('notice')).toEqual({ t: 'notice', kind: 'removed', byId: b.you, byName: 'Bob', name: 'Cara' });
      const st = await a.c.next('state', (m) => m.room.participants.length === 2);
      expect(st.room.participants.some((p) => p.voted)).toBe(false);
    });

    it('refuses to remove someone who is online, and yourself', async () => {
      const { a, b } = await lobby();
      a.c.send({ t: 'remove', id: b.you });
      expect(await a.c.next('error')).toMatchObject({ code: 'forbidden' });
      a.c.send({ t: 'remove', id: a.you });
      expect(await a.c.next('error')).toMatchObject({ code: 'forbidden' });
      await sync(b.c);
      expect(lastState(b.c).participants).toHaveLength(2);
    });

    it('a second tab keeps a seat online, so it cannot be removed', async () => {
      const { a, b, join } = await lobby();
      const second = await join(ID_B, 'Bob');
      b.c.ws.close();
      await sync(second.c);
      a.c.send({ t: 'remove', id: second.you });
      expect(await a.c.next('error')).toMatchObject({ code: 'forbidden' });
    });

    it('under the facilitator lock only the facilitator can remove an offline seat', async () => {
      const { a, b, join } = await lobby();
      const c = await join(ID_C, 'Cara');
      a.c.send({ t: 'lock', on: true });
      await b.c.next('state', (m) => m.room.locked);
      c.c.ws.close();
      await a.c.next('state', (m) => m.room.participants.some((p) => !p.connected));
      b.c.send({ t: 'remove', id: c.you });
      expect(await b.c.next('error')).toMatchObject({ code: 'forbidden' });
      a.c.send({ t: 'remove', id: c.you });
      expect(await b.c.next('notice')).toMatchObject({ kind: 'removed', name: 'Cara' });
    });
  });
});
