import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ClientMsg, ServerMsg } from '../shared/protocol.ts';
import { createApp } from '../server/app.ts';

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
  const waiters: { pred: (m: ServerMsg) => boolean; ok: (m: ServerMsg) => void }[] = [];
  ws.on('message', (d) => {
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

const ID_A = 'aaaaaaaaaaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbbbbbbbbbb';

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
});
