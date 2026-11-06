import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import {
  cleanFeedbackText,
  createFeedback,
  mailConfigFromEnv,
  type MailConfig,
  type MailMessage,
  type MailTransport,
} from '../server/feedback.ts';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const MAIL: MailConfig = { host: 'smtp.test', port: 465, user: 'sender@example.test', pass: 'pw', to: 'owner@example.test', from: 'sender@example.test' };

function fakeTransport() {
  const t = { sent: [] as MailMessage[], fail: false } as { sent: MailMessage[]; fail: boolean } & MailTransport;
  t.sendMail = async (m) => {
    if (t.fail) throw new Error('smtp down');
    t.sent.push(m);
  };
  return t;
}

function setup(extra: Partial<Parameters<typeof createFeedback>[0]> = {}) {
  const clock = { t: Date.UTC(2026, 5, 1, 12, 0, 0) };
  const transport = fakeTransport();
  const logs: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'fb-'));
  const make = (o: Partial<Parameters<typeof createFeedback>[0]> = {}) =>
    createFeedback({ dir, mail: MAIL, transport, now: () => clock.t, log: (m) => logs.push(m), ...extra, ...o });
  return { clock, transport, logs, dir, make, fb: make() };
}

const good = (over: object = {}) => ({ type: 'idea', message: 'Please add dark mode toggle', page: 'home', ...over });
/** submit() kicks off tick() without awaiting it; let that settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('feedback validation', () => {
  it('accepts a good submission and stores sanitized fields', async () => {
    const { fb } = setup({ mail: null });
    const r = fb.submit(good({ contact: ' a@b.co ', viewport: '390x844', userAgent: 'UA‮​' }), '1.1.1.1');
    expect(r.status).toBe(201);
    expect(fb.items[0]).toMatchObject({ type: 'idea', contact: 'a@b.co', viewport: '390x844', userAgent: 'UA', page: 'home' });
  });

  it.each([
    ['bad type', good({ type: 'spam' })],
    ['bad page', good({ page: 'elsewhere' })],
    ['short message', good({ message: '  hi  ' })],
    ['empty after stripping', good({ message: '​​​​​​' })],
    ['long message', good({ message: 'x'.repeat(2001) })],
    ['long contact', good({ contact: 'c'.repeat(121) })],
    ['non-string message', good({ message: 12345 })],
    ['non-string contact', good({ contact: { a: 1 } })],
    ['array body', []],
    ['null body', null],
  ])('rejects %s with 400', (_n, body) => {
    const { fb } = setup({ mail: null });
    expect(fb.submit(body, '1.1.1.1').status).toBe(400);
    expect(fb.items).toHaveLength(0);
  });

  it('accepts exactly 5 and 2000 characters, keeps newlines, truncates viewport and user agent', () => {
    const { fb } = setup({ mail: null });
    expect(fb.submit(good({ message: '12345' }), 'a').status).toBe(201);
    expect(fb.submit(good({ message: 'y'.repeat(2000) }), 'b').status).toBe(201);
    fb.submit(good({ message: 'line one\r\nline two\n\n\n\nline three', viewport: 'v'.repeat(99), userAgent: 'u'.repeat(999) }), 'c');
    const last = fb.items.at(-1)!;
    expect(last.message).toBe('line one\nline two\n\nline three');
    expect(last.viewport).toHaveLength(20);
    expect(last.userAgent).toHaveLength(300);
  });

  it('cleanFeedbackText strips control, zero-width and bidi characters', () => {
    expect(cleanFeedbackText('a\u0000b​c‮d⁦e﻿', 50)).toBe('a b c d e');
    expect(cleanFeedbackText('one\ntwo', 50)).toBe('one two');
  });
});

describe('feedback rate limits', () => {
  it('allows 5 per IP per hour, then 429, per IP and recovering after the hour', () => {
    const { fb, clock } = setup({ mail: null });
    for (let i = 0; i < 5; i++) expect(fb.submit(good(), '9.9.9.9').status).toBe(201);
    expect(fb.submit(good(), '9.9.9.9').status).toBe(429);
    expect(fb.submit(good(), '8.8.8.8').status).toBe(201);
    clock.t += HOUR + 1;
    expect(fb.submit(good(), '9.9.9.9').status).toBe(201);
  });

  it('caps 200 per day globally', () => {
    const { fb, clock } = setup({ mail: null });
    for (let i = 0; i < 200; i++) expect(fb.submit(good(), `ip-${i}`).status).toBe(201);
    expect(fb.submit(good(), 'fresh-ip').status).toBe(429);
    clock.t += DAY + 1;
    expect(fb.submit(good(), 'fresh-ip').status).toBe(201);
  });

  it('does not count rejected submissions against the limit', () => {
    const { fb } = setup({ mail: null });
    for (let i = 0; i < 10; i++) fb.submit(good({ message: 'x' }), 'ip');
    expect(fb.submit(good(), 'ip').status).toBe(201);
  });
});

describe('feedback storage', () => {
  it('appends one JSON line per submission and never stores the IP', () => {
    const { fb, dir } = setup({ mail: null });
    fb.submit(good({ message: 'first message here' }), '203.0.113.77');
    fb.submit(good({ type: 'bug', message: 'second message here' }), '203.0.113.78');
    const raw = readFileSync(join(dir, 'feedback.jsonl'), 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(Object.keys(lines[0]).sort()).toEqual(['contact', 'id', 'message', 'page', 'receivedAt', 'type', 'userAgent', 'viewport']);
    expect(raw).not.toContain('203.0.113');
  });

  it('keeps memory only when there is no directory', () => {
    const fb = createFeedback({ mail: null, log: () => {} });
    expect(fb.submit(good(), 'x').status).toBe(201);
    expect(fb.items).toHaveLength(1);
  });

  it('stores only the fields it knows, so a room id sent as an extra field never lands in the log', () => {
    const { fb, dir } = setup({ mail: null });
    fb.submit(good({ roomId: 'ROOMSECRET1', url: 'https://x/r/ROOMSECRET1', page: 'room' }), 'ip');
    expect(readFileSync(join(dir, 'feedback.jsonl'), 'utf8')).not.toContain('ROOMSECRET1');
  });
});

describe('feedback digest', () => {
  it('emails the first submission immediately, as plain text with a summary subject', async () => {
    const { fb, transport } = setup();
    fb.submit(good({ type: 'bug', message: 'Cards overlap on iPhone', contact: 'me@mail.test', viewport: '390x844', userAgent: 'TestUA' }), 'ip');
    await settle();
    expect(transport.sent).toHaveLength(1);
    const m = transport.sent[0]!;
    expect(m.subject).toBe('Scrum Poker feedback: 1 new (1 bugs, 0 ideas, 0 other)');
    expect(m.to).toBe(MAIL.to);
    expect(m.replyTo).toBe('me@mail.test');
    expect(m).not.toHaveProperty('html');
    expect(m.text).toContain('[BUG]');
    expect(m.text).toContain('Cards overlap on iPhone');
    expect(m.text).toContain('Page: home');
    expect(m.text).toContain('Viewport: 390x844');
    expect(m.text).toContain('TestUA');
    expect(m.text).toContain('Jun 1, 2026'); // UTC and Toronto both land on this date
    expect(m.text).toMatch(/UTC \/ .* Toronto/);
    expect(fb.pending()).toHaveLength(0);
  });

  it('does not set Reply-To for a non-email contact', async () => {
    const { fb, transport } = setup();
    fb.submit(good({ contact: 'Alex from QA' }), 'ip');
    await settle();
    expect(transport.sent[0]!.replyTo).toBeUndefined();
  });

  it('batches later submissions: none within 24h, then exactly one email with all of them', async () => {
    const { fb, transport, clock } = setup();
    fb.submit(good({ message: 'the first one' }), 'a');
    await settle();
    expect(transport.sent).toHaveLength(1);

    clock.t += 2 * HOUR;
    fb.submit(good({ type: 'bug', message: 'second one here' }), 'b');
    clock.t += 10 * HOUR;
    fb.submit(good({ type: 'other', message: 'third one here' }), 'c');
    await settle();
    await fb.tick();
    expect(transport.sent).toHaveLength(1);
    expect(fb.pending()).toHaveLength(2);

    clock.t += 11 * HOUR + 59 * 60_000; // 23h59m after the first email
    await fb.tick();
    expect(transport.sent).toHaveLength(1);

    clock.t += 2 * 60_000; // now past 24h
    await fb.tick();
    await fb.tick(); // a second tick must not resend
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.subject).toBe('Scrum Poker feedback: 2 new (1 bugs, 0 ideas, 1 other)');
    expect(transport.sent[1]!.text).toContain('second one here');
    expect(transport.sent[1]!.text).toContain('third one here');
    expect(fb.pending()).toHaveLength(0);
  });

  it('sends nothing when there is nothing new, even after a day', async () => {
    const { fb, transport, clock } = setup();
    fb.submit(good(), 'a');
    await settle();
    clock.t += 3 * DAY;
    await fb.tick();
    expect(transport.sent).toHaveLength(1);
  });

  it('retries after an SMTP failure on the next tick and the failure does not count as the day email', async () => {
    const { fb, transport, clock, logs } = setup();
    transport.fail = true;
    fb.submit(good({ message: 'will fail first' }), 'a');
    await settle();
    expect(transport.sent).toHaveLength(0);
    expect(fb.pending()).toHaveLength(1);
    expect(fb.lastSentAt).toBeNull();
    expect(logs.some((l) => l.includes('feedback email failed'))).toBe(true);

    transport.fail = false;
    clock.t += 10 * 60_000;
    await fb.tick();
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.text).toContain('will fail first');
    expect(fb.pending()).toHaveLength(0);
  });

  it('a failure after a successful day email still waits for the 24h mark', async () => {
    const { fb, transport, clock } = setup();
    fb.submit(good(), 'a');
    await settle();
    clock.t += DAY;
    transport.fail = true;
    fb.submit(good({ message: 'late one here' }), 'b');
    await settle();
    expect(fb.pending()).toHaveLength(1);
    transport.fail = false;
    await fb.tick();
    expect(transport.sent).toHaveLength(2);
  });

  it('survives a restart: no resend, lastSentAt respected, pending items still delivered later', async () => {
    const { fb, make, transport, clock, dir } = setup();
    fb.submit(good({ message: 'before restart' }), 'a');
    await settle();
    clock.t += HOUR;
    fb.submit(good({ message: 'queued before restart' }), 'b');
    await settle();
    expect(transport.sent).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'feedback-mail.json'), 'utf8')).lastSentAt).toBe(fb.lastSentAt);

    const again = make();
    expect(again.pending().map((i) => i.message)).toEqual(['queued before restart']);
    expect(again.lastSentAt).toBe(fb.lastSentAt);
    await again.tick();
    expect(transport.sent).toHaveLength(1); // still inside the 24h window

    clock.t += DAY;
    await again.tick();
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.text).toContain('queued before restart');
    expect(transport.sent[1]!.text).not.toMatch(/\nbefore restart/);

    const third = make();
    clock.t += 5 * DAY;
    await third.tick();
    expect(transport.sent).toHaveLength(2);
  });

  it('start() delivers leftovers on boot and stop() clears the timer', async () => {
    const { fb, make, transport, clock } = setup({ mail: null });
    fb.submit(good({ message: 'left over item' }), 'a'); // stored while email was off
    clock.t += HOUR;
    const withMail = make({ mail: MAIL });
    withMail.start(60_000);
    await settle();
    expect(transport.sent).toHaveLength(1);
    withMail.stop();
  });

  it('is disabled without full SMTP config: logs once, stores, never sends', async () => {
    const { transport, logs, make, dir } = setup();
    const fb = make({ mail: mailConfigFromEnv({ SMTP_USER: 'u', SMTP_PASS: 'p' }) });
    expect(logs.filter((l) => l === 'feedback email disabled (no SMTP config)')).toHaveLength(1);
    fb.submit(good(), 'a');
    await settle();
    await fb.tick();
    expect(transport.sent).toHaveLength(0);
    expect(existsSync(join(dir, 'feedback.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'feedback-mail.json'))).toBe(false);
  });

  it('treats a corrupt state file as unsent rather than crashing', async () => {
    const { make, dir, logs } = setup();
    writeFileSync(join(dir, 'feedback-mail.json'), '{nope');
    const fb = make();
    expect(fb.lastSentAt).toBeNull();
    expect(logs.some((l) => l.includes('feedback-mail.json'))).toBe(true);
  });

  it('caps one email at 100 items; the rest follow in the next digest', async () => {
    const { fb, transport, clock } = setup({ globalLimitPerDay: 1000 });
    // Disable sending while queuing by failing the transport.
    transport.fail = true;
    for (let i = 0; i < 130; i++) fb.submit(good({ message: `item number ${i}` }), `ip${i}`);
    await settle();
    transport.fail = false;
    clock.t += 10 * 60_000;
    await fb.tick();
    expect(transport.sent[0]!.subject).toContain('100 new');
    clock.t += DAY;
    await fb.tick();
    expect(transport.sent[1]!.subject).toContain('30 new');
  });
});

describe('mailConfigFromEnv', () => {
  it('applies defaults and requires user, pass and recipient', () => {
    expect(mailConfigFromEnv({})).toBeNull();
    expect(mailConfigFromEnv({ SMTP_USER: 'u@x.test', SMTP_PASS: 'p' })).toBeNull();
    expect(mailConfigFromEnv({ SMTP_USER: 'u@x.test', SMTP_PASS: 'p', FEEDBACK_TO: 't@x.test' })).toEqual({
      host: 'smtp.gmail.com', port: 465, user: 'u@x.test', pass: 'p', to: 't@x.test', from: 'u@x.test',
    });
    expect(mailConfigFromEnv({ SMTP_USER: 'u', SMTP_PASS: 'p', FEEDBACK_TO: 't', SMTP_HOST: 'h', SMTP_PORT: '587', FEEDBACK_FROM: 'f' })).toMatchObject({ host: 'h', port: 587, from: 'f' });
  });
});

describe('POST /api/feedback', () => {
  const apps: ReturnType<typeof createApp>[] = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close().catch(() => {});
  });

  async function start(opts: Parameters<typeof createApp>[0] = {}) {
    const app = createApp({ log: () => {}, feedbackMail: null, ...opts });
    apps.push(app);
    await new Promise<void>((ok) => app.server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/feedback`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { app, base, post };
  }

  it('answers 201 / 400 / 413', async () => {
    const { post } = await start();
    expect((await post(good())).status).toBe(201);
    expect((await post(good({ message: 'no' }))).status).toBe(400);
    expect((await post('{not json')).status).toBe(400);
    expect((await post(good({ message: 'x'.repeat(9000) }))).status).toBe(413);
  });

  it('rate limits per CF-Connecting-IP with 429', async () => {
    const { post } = await start();
    for (let i = 0; i < 5; i++) expect((await post(good(), { 'CF-Connecting-IP': '5.5.5.5' })).status).toBe(201);
    expect((await post(good(), { 'CF-Connecting-IP': '5.5.5.5' })).status).toBe(429);
    expect((await post(good(), { 'CF-Connecting-IP': '6.6.6.6' })).status).toBe(201);
  });

  it('stores next to DATA_FILE and emails through the injected transport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fbapp-'));
    const transport = fakeTransport();
    const { post } = await start({ dataFile: join(dir, 'rooms.json'), feedbackMail: MAIL, feedbackTransport: transport });
    expect((await post(good({ page: 'room', message: 'from inside a room' }))).status).toBe(201);
    await settle();
    expect(readFileSync(join(dir, 'feedback.jsonl'), 'utf8')).toContain('from inside a room');
    expect(transport.sent).toHaveLength(1);
  });

  it('close() stops the digest timer so the process can exit', async () => {
    const { app } = await start({ feedbackTickMs: 5 });
    await app.close();
    apps.length = 0;
  });
});
