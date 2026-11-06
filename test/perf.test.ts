import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../server/app.ts';
import { sanitizeBeacon } from '../server/vitals.ts';
import { percentile, uaFamily } from '../shared/vitals.ts';

type App = ReturnType<typeof createApp>;
const apps: App[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const a of apps.splice(0)) await a.close().catch(() => {});
});

function staticSite() {
  const dir = mkdtempSync(join(tmpdir(), 'poker-static-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-abc.js"></script><link rel="stylesheet" crossorigin href="/assets/index-abc.css"></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
  writeFileSync(join(dir, 'assets', 'index-abc.css'), 'body{}');
  return dir;
}

async function start(opts: Parameters<typeof createApp>[0] = {}) {
  const app = createApp({ log: () => {}, ...opts });
  apps.push(app);
  await new Promise<void>((ok) => app.server.listen(0, '127.0.0.1', ok));
  const port = (app.server.address() as AddressInfo).port;
  return { app, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws` };
}

async function newRoom(base: string) {
  const res = await fetch(`${base}/api/rooms`, { method: 'POST', body: '{}' });
  return ((await res.json()) as { id: string }).id;
}

const beacon = (extra: object = {}) => ({
  kind: 'home',
  trigger: 'timeout',
  cold: true,
  jsCold: true,
  inlined: false,
  proto: 'h2',
  net: '4g',
  ua: 'Chrome/macOS',
  timings: { ttfb: 100, fcp: 300, lcp: 450 },
  vw: 1280,
  vh: 800,
  ...extra,
});

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/vitals`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers });

describe('POST /api/vitals', () => {
  it('accepts a text/plain beacon (what sendBeacon sends) with 204 and stores it', async () => {
    const { app, base } = await start();
    const res = await post(base, beacon(), { 'Content-Type': 'text/plain;charset=UTF-8' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(app.vitals.recent).toHaveLength(1);
    expect(app.vitals.recent[0]).toMatchObject({ kind: 'home', cold: true, timings: { ttfb: 100, fcp: 300, lcp: 450 } });
  });

  it('keeps only known fields, clamps numbers and truncates strings (never a room id or URL)', () => {
    const rec = sanitizeBeacon(
      beacon({
        kind: 'room',
        url: 'https://poker.example/r/abcdefghij',
        roomId: 'abcdefghij',
        path: '/r/abcdefghij',
        ua: `Chrome/macOS ${'x'.repeat(500)} /r/abcdefghij`,
        proto: 'h'.repeat(100),
        timings: { ttfb: -5, fcp: 1e12, lcp: Number.NaN, load: '12', hand: 250.26, bogus: 7 },
        vw: 1e9,
      }),
      '2026-01-01T00:00:00.000Z',
    )!;
    expect(Object.keys(rec).sort()).toEqual(['cold', 'inlined', 'jsCold', 'kind', 'net', 'proto', 'timings', 'trigger', 'ts', 'ua', 'vh', 'vw']);
    expect(rec.timings).toEqual({ ttfb: 0, fcp: 600_000, hand: 250.3 });
    expect(rec.ua.length).toBe(40);
    expect(rec.proto.length).toBe(12);
    expect(rec.vw).toBe(20_000);
    expect(JSON.stringify(rec)).not.toContain('abcdefghij');
  });

  it('turns an unknown page kind into "other" and rejects non-objects', async () => {
    expect(sanitizeBeacon(beacon({ kind: '/r/abcdefghij' }), 't')!.kind).toBe('other');
    const { base } = await start();
    for (const body of ['not json', '[]', 'null', '42']) expect((await post(base, body)).status).toBe(400);
  });

  it('rejects bodies over 4 KB with 413', async () => {
    const { app, base } = await start();
    const res = await post(base, JSON.stringify(beacon({ ua: 'x'.repeat(5000) })));
    expect(res.status).toBe(413);
    expect(app.vitals.recent).toHaveLength(0);
  });

  it('limits each IP to 30 per hour, with a fresh budget per IP', async () => {
    let now = 1_000_000;
    const { app, base } = await start({ now: () => now, vitalsPerIpPerHour: 3 });
    const as = (ip: string) => ({ 'CF-Connecting-IP': ip });
    for (let i = 0; i < 3; i++) expect((await post(base, beacon(), as('1.1.1.1'))).status).toBe(204);
    expect((await post(base, beacon(), as('1.1.1.1'))).status).toBe(429);
    expect((await post(base, beacon(), as('2.2.2.2'))).status).toBe(204);
    now += 3600_000 + 1;
    expect((await post(base, beacon(), as('1.1.1.1'))).status).toBe(204);
    expect(app.vitals.recent).toHaveLength(5);
  });

  it('applies the default per-IP limit of 30 per hour', async () => {
    const { base } = await start();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await post(base, beacon())).status;
    expect(last).toBe(429);
  });

  it('caps the whole site at a daily total across IPs, and resets the next day', async () => {
    let now = 5 * 24 * 3600_000;
    const { base } = await start({ now: () => now, vitalsGlobalPerDay: 4 });
    for (let i = 0; i < 4; i++) expect((await post(base, beacon(), { 'CF-Connecting-IP': `9.9.9.${i}` })).status).toBe(204);
    expect((await post(base, beacon(), { 'CF-Connecting-IP': '9.9.9.77' })).status).toBe(429);
    now += 24 * 3600_000;
    expect((await post(base, beacon(), { 'CF-Connecting-IP': '9.9.9.77' })).status).toBe(204);
  });

  it('appends to vitals.jsonl next to the data file, without any IP, and rotates at the size cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poker-vitals-'));
    const { base } = await start({ dataFile: join(dir, 'rooms.json'), vitalsMaxFileBytes: 1500, feedbackMail: null });
    for (let i = 0; i < 12; i++) {
      expect((await post(base, beacon(), { 'CF-Connecting-IP': `203.0.113.${i}` })).status).toBe(204);
    }
    const file = join(dir, 'vitals.jsonl');
    expect(existsSync(`${file}.1`)).toBe(true);
    const all = readFileSync(file, 'utf8') + readFileSync(`${file}.1`, 'utf8');
    expect(all.trim().split('\n').length).toBeGreaterThan(5);
    expect(readFileSync(file, 'utf8').length).toBeLessThanOrEqual(1500);
    expect(all).not.toMatch(/203\.0\.113|127\.0\.0\.1/);
    for (const line of all.trim().split('\n')) expect(JSON.parse(line)).toMatchObject({ kind: 'home' });
  });

  it('keeps only a memory ring buffer without a data file', async () => {
    const { app, base } = await start();
    await post(base, beacon());
    expect(app.vitals.file).toBeUndefined();
    expect(app.vitals.recent).toHaveLength(1);
  });
});

describe('vitals helpers and CLI', () => {
  it('classifies user agents coarsely, with no versions', () => {
    expect(uaFamily('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36')).toBe('Chrome/macOS');
    expect(uaFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari/iOS');
    expect(uaFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0')).toBe('Firefox/Windows');
  });

  it('computes percentiles', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([0, 100], 0.9)).toBe(90);
  });

  it('scripts/vitals-summary.ts finds the file via DATA_FILE and prints p50/p90 per page kind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'poker-vitals-cli-'));
    const lines = [100, 200, 300, 400, 500].map((n) => JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', ...beacon({ timings: { ttfb: n, fcp: n * 2 } }) }));
    writeFileSync(join(dir, 'vitals.jsonl'), `${lines.join('\n')}\n{torn`);
    const out = spawnSync(process.execPath, [join(process.cwd(), 'scripts/vitals-summary.ts'), '-n', '2'], {
      env: { ...process.env, DATA_FILE: join(dir, 'rooms.json') },
      encoding: 'utf8',
    });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('5 record(s)');
    expect(out.stdout).toMatch(/home \(5 loads, 5 cold\)/);
    expect(out.stdout).toMatch(/ttfb\s+300 \/\s+460/);
    expect(out.stdout).toMatch(/fcp\s+600 \/\s+920/);
  });
});

describe('room lookup inlined in invite HTML', () => {
  const tag = (html: string) => /<script type="application\/json" id="room-lookup">([^<]*)<\/script>/.exec(html);

  it('inlines exactly what GET /api/rooms/:id returns, with no-store', async () => {
    const { base } = await start({ staticDir: staticSite() });
    const id = await newRoom(base);
    const res = await fetch(`${base}/r/${id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const api = await (await fetch(`${base}/api/rooms/${id}`)).json();
    expect(JSON.parse(tag(html)![1]!)).toEqual(api);
    expect(html).toContain('<div id="root">');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('etag')).toBeNull();
    expect(res.headers.get('last-modified')).toBeNull();
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(html)));
  });

  it('escapes < so a story cannot close the tag or inject markup', async () => {
    const { app, base } = await start({ staticDir: staticSite() });
    const id = await newRoom(base);
    const story = '</script><img src=x onerror=alert(1)><!-- <script>';
    app.rooms.get(id)!.story = story;
    const html = await (await fetch(`${base}/r/${id}`)).text();
    expect(html).not.toContain('</script><img');
    expect(html).not.toContain('<!--');
    expect(html).toContain('\\u003c/script>');
    expect(html.match(/<script/g)).toHaveLength(2); // the module script and the data block
    expect(JSON.parse(tag(html)![1]!)).toMatchObject({ status: 'live', story });
  });

  it('never contains votes or names', async () => {
    const { base, ws } = await start({ staticDir: staticSite() });
    const id = await newRoom(base);
    const sock = new WebSocket(ws);
    sockets.push(sock);
    const got = new Promise<void>((ok) => sock.on('message', (d) => JSON.parse(d.toString()).t === 'state' && ok()));
    await new Promise((ok) => sock.once('open', ok));
    sock.send(JSON.stringify({ t: 'join', roomId: id, clientId: 'c'.repeat(20), name: 'Zebediah-Secret', spectator: false }));
    sock.send(JSON.stringify({ t: 'vote', value: '13' }));
    await got;
    const html = await (await fetch(`${base}/r/${id}`)).text();
    const data = JSON.parse(tag(html)![1]!) as Record<string, unknown>;
    expect(data).toMatchObject({ status: 'live', players: 1 });
    expect(Object.keys(data).sort()).toEqual(['deckLabel', 'players', 'status', 'story']);
    expect(html).not.toContain('Zebediah');
    expect(html).not.toContain('"13"');
  });

  it('is not inlined for unknown or malformed ids, the home page, HEAD requests or POST', async () => {
    const { base } = await start({ staticDir: staticSite() });
    const id = await newRoom(base);
    for (const path of ['/r/abcdefghij', '/r/short', '/r/abcdefghij/extra', '/', '/index.html', `/x/${id}`]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain('room-lookup');
    }
    expect((await fetch(`${base}/r/${id}`, { method: 'HEAD' })).headers.get('content-length')).not.toBeNull();
    const plain = await (await fetch(`${base}/r/${id}`, { method: 'HEAD' })).text();
    expect(plain).toBe('');
  });

  it('inlines a revivable (expired) room too', async () => {
    let now = 1_000_000;
    const { app, base } = await start({ staticDir: staticSite(), now: () => now, roomTtlMs: 1000, graceMs: 10 });
    const id = await newRoom(base);
    now += 5000;
    app.sweep(now);
    expect(app.rooms.has(id)).toBe(false);
    const html = await (await fetch(`${base}/r/${id}`)).text();
    expect(JSON.parse(tag(html)![1]!)).toMatchObject({ status: 'revivable' });
  });

  it('counts against the per-IP lookup budget and falls back to the plain shell when it is spent', async () => {
    const { base } = await start({ staticDir: staticSite(), lookupsPerIpPerMinute: 2 });
    const id = await newRoom(base);
    expect(tag(await (await fetch(`${base}/r/${id}`)).text())).not.toBeNull(); // 1
    expect((await fetch(`${base}/api/rooms/${id}`)).status).toBe(200); // 2: same budget
    const spent = await fetch(`${base}/r/${id}`);
    expect(spent.status).toBe(200); // the page still loads
    expect(tag(await spent.text())).toBeNull();
    expect((await fetch(`${base}/api/rooms/${id}`)).status).toBe(429);
  });

  it('is never cacheable by a shared cache, while the plain shell stays no-cache', async () => {
    const { base } = await start({ staticDir: staticSite() });
    const id = await newRoom(base);
    const room = await fetch(`${base}/r/${id}`);
    expect(room.headers.get('cache-control')).toMatch(/no-store/);
    expect(room.headers.get('cache-control')).toMatch(/private/);
    const shell = await fetch(`${base}/`);
    expect(shell.headers.get('cache-control')).toBe('no-cache');
  });
});

describe('conditional requests and preload hints', () => {
  it('serves ETag + Last-Modified and answers 304 to If-None-Match for the shell and assets', async () => {
    const { base } = await start({ staticDir: staticSite() });
    for (const path of ['/', '/assets/index-abc.js', '/r/abcdefghij']) {
      const first = await fetch(`${base}${path}`);
      const etag = first.headers.get('etag')!;
      expect(etag).toMatch(/^W\/"/);
      expect(first.headers.get('last-modified')).toBeTruthy();
      await first.arrayBuffer();
      const second = await fetch(`${base}${path}`, { headers: { 'If-None-Match': etag } });
      expect(second.status).toBe(304);
      expect(await second.text()).toBe('');
      expect(second.headers.get('etag')).toBe(etag);
      expect(second.headers.get('cache-control')).toBe(first.headers.get('cache-control'));
      expect(second.headers.get('content-security-policy')).toBeTruthy();
    }
  });

  it('answers 200 for a stale validator and honours If-Modified-Since', async () => {
    const dir = staticSite();
    const { base } = await start({ staticDir: dir });
    const first = await fetch(`${base}/`);
    const lastModified = first.headers.get('last-modified')!;
    await first.arrayBuffer();
    expect((await fetch(`${base}/`, { headers: { 'If-None-Match': 'W/"nope"' } })).status).toBe(200);
    expect((await fetch(`${base}/`, { headers: { 'If-Modified-Since': lastModified } })).status).toBe(304);
    // The file changes: the old validators no longer match.
    const later = new Date(Date.now() + 60_000);
    writeFileSync(join(dir, 'index.html'), readFileSync(join(dir, 'index.html'), 'utf8') + '<!-- v2 -->');
    utimesSync(join(dir, 'index.html'), later, later);
    expect((await fetch(`${base}/`, { headers: { 'If-Modified-Since': lastModified } })).status).toBe(200);
    expect((await fetch(`${base}/`, { headers: { 'If-None-Match': first.headers.get('etag')! } })).status).toBe(200);
  });

  it('does not 304 a room page that carries an inlined lookup, whatever validator is sent', async () => {
    const { base } = await start({ staticDir: staticSite() });
    const id = await newRoom(base);
    const shellEtag = (await fetch(`${base}/`)).headers.get('etag')!;
    const res = await fetch(`${base}/r/${id}`, { headers: { 'If-None-Match': shellEtag, 'If-Modified-Since': new Date(Date.now() + 1e6).toUTCString() } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('room-lookup');
  });

  it('adds a Link preload header for the built script and stylesheet on HTML only', async () => {
    const { base } = await start({ staticDir: staticSite() });
    const link = (await fetch(`${base}/`)).headers.get('link')!;
    expect(link).toContain('</assets/index-abc.css>; rel=preload; as=style');
    expect(link).toContain('</assets/index-abc.js>; rel=modulepreload');
    expect((await fetch(`${base}/assets/index-abc.js`)).headers.get('link')).toBeNull();
  });
});

describe('/healthz version', () => {
  it('reports "dev" by default and the given version otherwise', async () => {
    const dev = await start();
    expect(((await (await fetch(`${dev.base}/healthz`)).json()) as { version: string }).version).toBe('dev');
    const prod = await start({ version: 'abc1234' });
    expect(((await (await fetch(`${prod.base}/healthz`)).json()) as { version: string }).version).toBe('abc1234');
  });

  it('server/index.ts shortens APP_VERSION (the commit SHA build arg) to 7 characters', async () => {
    const probe = createServer();
    await new Promise<void>((ok) => probe.listen(0, '127.0.0.1', ok));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((ok) => probe.close(ok));
    const child = spawn(process.execPath, [join(process.cwd(), 'server/index.ts')], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_FILE: '', APP_VERSION: '0123456789abcdef0123456789abcdef01234567' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      await new Promise<void>((ok) => child.stdout.on('data', (d) => String(d).includes('listening') && ok()));
      const body = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { version: string };
      expect(body.version).toBe('0123456');
    } finally {
      child.kill('SIGKILL');
    }
  });
});
