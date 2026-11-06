// User feedback: validation, storage (feedback.jsonl) and a once-a-day email digest.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FEEDBACK_LIMITS,
  FEEDBACK_PAGES,
  FEEDBACK_TYPES,
  type FeedbackPage,
  type FeedbackType,
} from '../shared/feedback.ts';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Items per email. The rest wait for the next digest, so one email never grows without bound. */
const MAX_ITEMS_PER_EMAIL = 100;
const EMAIL_LIKE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export interface FeedbackItem {
  id: string;
  receivedAt: number;
  type: FeedbackType;
  message: string;
  contact: string;
  page: FeedbackPage;
  viewport: string;
  userAgent: string;
}

export interface MailMessage {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
}

/** Anything with nodemailer's sendMail shape; tests pass a fake. */
export interface MailTransport {
  sendMail(msg: MailMessage): Promise<unknown>;
}

export interface MailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  to: string;
  from: string;
}

/** Reads SMTP settings from the environment; null when SMTP_USER, SMTP_PASS or FEEDBACK_TO is missing. */
export function mailConfigFromEnv(env: Record<string, string | undefined>): MailConfig | null {
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS?.trim();
  const to = env.FEEDBACK_TO?.trim();
  if (!user || !pass || !to) return null;
  const port = Number(env.SMTP_PORT) || 465;
  return { host: env.SMTP_HOST?.trim() || 'smtp.gmail.com', port, user, pass, to, from: env.FEEDBACK_FROM?.trim() || user };
}

export interface FeedbackOptions {
  /** Directory for feedback.jsonl and feedback-mail.json. Omit to keep everything in memory. */
  dir?: string;
  /** SMTP config. null/undefined disables email (feedback is still stored). */
  mail?: MailConfig | null;
  /** Overrides the SMTP transport (tests). */
  transport?: MailTransport;
  now?: () => number;
  log?: (msg: string) => void;
  ipLimitPerHour?: number;
  globalLimitPerDay?: number;
  /** Minimum gap between emails (default 24h). */
  digestIntervalMs?: number;
}

const BAD_CHARS = '\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff';
const STRIP_KEEP_NEWLINE = new RegExp(`[${BAD_CHARS}]`, 'g');
const STRIP_ALL = new RegExp(`[${BAD_CHARS}\\n]`, 'g');

/** Strips control, zero-width and bidi characters. Newlines survive only when `multiline` is set. */
export function cleanFeedbackText(input: unknown, max: number, multiline = false): string {
  if (typeof input !== 'string') return '';
  let s = input.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  if (multiline) {
    s = s.replace(STRIP_KEEP_NEWLINE, '').replace(/\n{3,}/g, '\n\n');
  } else {
    s = s.replace(STRIP_ALL, ' ').replace(/\s+/g, ' ');
  }
  return s.trim().slice(0, max);
}

export type SubmitResult = { status: 201; body: { ok: true } } | { status: 400 | 429; body: { error: string } };

function isItem(v: unknown): v is FeedbackItem {
  const o = v as Partial<FeedbackItem> | null;
  return (
    !!o &&
    typeof o.id === 'string' &&
    typeof o.receivedAt === 'number' &&
    (FEEDBACK_TYPES as readonly unknown[]).includes(o.type) &&
    typeof o.message === 'string' &&
    typeof o.contact === 'string' &&
    (FEEDBACK_PAGES as readonly unknown[]).includes(o.page) &&
    typeof o.viewport === 'string' &&
    typeof o.userAgent === 'string'
  );
}

const dateFmt = (tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' });
const utcFmt = dateFmt('UTC');
const torontoFmt = dateFmt('America/Toronto');

export function renderDigest(items: FeedbackItem[], cfg: Pick<MailConfig, 'from' | 'to'>): MailMessage {
  const count = (t: FeedbackType) => items.filter((i) => i.type === t).length;
  const subject = `Scrum Poker feedback: ${items.length} new (${count('bug')} bugs, ${count('idea')} ideas, ${count('other')} other)`;
  const blocks = items.map((i, idx) => {
    const when = new Date(i.receivedAt);
    const lines = [
      `#${idx + 1}  [${i.type.toUpperCase()}]`,
      `Received: ${utcFmt.format(when)} UTC / ${torontoFmt.format(when)} Toronto`,
      `Page: ${i.page}`,
    ];
    if (i.contact) lines.push(`Contact: ${i.contact}`);
    if (i.viewport) lines.push(`Viewport: ${i.viewport}`);
    if (i.userAgent) lines.push(`User agent: ${i.userAgent}`);
    lines.push('', i.message);
    return lines.join('\n');
  });
  const text = `${blocks.join('\n\n----------------------------------------\n\n')}\n`;
  // Reply-To only when the digest has exactly one distinct address-looking contact (several senders: no single reply target).
  const addresses = [...new Set(items.map((i) => i.contact).filter((c) => EMAIL_LIKE.test(c)))];
  const replyTo = addresses.length === 1 ? addresses[0] : undefined;
  return { from: cfg.from, to: cfg.to, ...(replyTo ? { replyTo } : {}), subject, text };
}

export function createFeedback(opts: FeedbackOptions = {}) {
  const clock = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.log(`[poker] ${m}`));
  const ipLimit = opts.ipLimitPerHour ?? 5;
  const globalLimit = opts.globalLimitPerDay ?? 200;
  const interval = opts.digestIntervalMs ?? DAY;
  const jsonlFile = opts.dir ? join(opts.dir, 'feedback.jsonl') : null;
  const stateFile = opts.dir ? join(opts.dir, 'feedback-mail.json') : null;

  const items: FeedbackItem[] = [];
  const sent = new Set<string>();
  let lastSentAt: number | null = null;
  let sending = false;
  let timer: NodeJS.Timeout | null = null;
  let transport: MailTransport | null = opts.transport ?? null;
  const byIp = new Map<string, number[]>();
  let globalTimes: number[] = [];

  if (!opts.mail) log('feedback email disabled (no SMTP config)');

  // ---------- load ----------
  if (opts.dir) {
    if (jsonlFile && existsSync(jsonlFile)) {
      for (const line of readFileSync(jsonlFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const v: unknown = JSON.parse(line);
          if (isItem(v)) items.push(v);
        } catch {
          log('skipped an unreadable line in feedback.jsonl');
        }
      }
    }
    if (stateFile && existsSync(stateFile)) {
      try {
        const s = JSON.parse(readFileSync(stateFile, 'utf8')) as { lastSentAt?: unknown; sentIds?: unknown };
        if (typeof s.lastSentAt === 'number') lastSentAt = s.lastSentAt;
        if (Array.isArray(s.sentIds)) for (const id of s.sentIds) if (typeof id === 'string') sent.add(id);
      } catch {
        // Safer to resend a digest than to lose feedback: unknown state means "nothing sent, never sent".
        log('ERROR: could not read feedback-mail.json; treating all feedback as unsent');
      }
    }
  }

  function saveState() {
    if (!stateFile) return;
    // Keep only ids still present in the log, so the file stays small.
    const live = new Set(items.map((i) => i.id));
    const sentIds = [...sent].filter((id) => live.has(id));
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lastSentAt, sentIds }));
    renameSync(tmp, stateFile);
  }

  function bad(error: string): SubmitResult {
    return { status: 400, body: { error } };
  }

  // ---------- submit ----------
  function submit(raw: unknown, ip: string): SubmitResult {
    const now = clock();
    const mine = (byIp.get(ip) ?? []).filter((t) => now - t < HOUR);
    globalTimes = globalTimes.filter((t) => now - t < DAY);
    if (mine.length >= ipLimit) return { status: 429, body: { error: 'Too much feedback from your network. Try again later.' } };
    if (globalTimes.length >= globalLimit) return { status: 429, body: { error: 'Feedback is paused for today. Try again tomorrow.' } };

    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad('Invalid request body.');
    const r = raw as Record<string, unknown>;
    if (!(FEEDBACK_TYPES as readonly unknown[]).includes(r.type)) return bad('Unknown feedback type.');
    if (!(FEEDBACK_PAGES as readonly unknown[]).includes(r.page)) return bad('Unknown page.');
    if (typeof r.message !== 'string') return bad('Message is required.');
    const message = cleanFeedbackText(r.message, FEEDBACK_LIMITS.messageMax + 1, true);
    if (message.length < FEEDBACK_LIMITS.messageMin) return bad(`Message must be at least ${FEEDBACK_LIMITS.messageMin} characters.`);
    if (message.length > FEEDBACK_LIMITS.messageMax) return bad(`Message must be at most ${FEEDBACK_LIMITS.messageMax} characters.`);
    if (r.contact !== undefined && typeof r.contact !== 'string') return bad('Invalid contact.');
    const contact = cleanFeedbackText(r.contact, FEEDBACK_LIMITS.contactMax + 1);
    if (contact.length > FEEDBACK_LIMITS.contactMax) return bad(`Contact must be at most ${FEEDBACK_LIMITS.contactMax} characters.`);

    const item: FeedbackItem = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      receivedAt: now,
      type: r.type as FeedbackType,
      message,
      contact,
      page: r.page as FeedbackPage,
      viewport: cleanFeedbackText(r.viewport, FEEDBACK_LIMITS.viewportMax),
      userAgent: cleanFeedbackText(r.userAgent, FEEDBACK_LIMITS.userAgentMax),
    };
    // Count accepted submissions only. The IP is used for this in-memory window and never stored.
    mine.push(now);
    byIp.set(ip, mine);
    globalTimes.push(now);
    items.push(item);
    if (jsonlFile) {
      try {
        appendFileSync(jsonlFile, `${JSON.stringify(item)}\n`);
      } catch (err) {
        log(`ERROR: could not store feedback: ${(err as Error).message}`);
      }
    }
    void tick();
    return { status: 201, body: { ok: true } };
  }

  // ---------- digest ----------
  function pending(): FeedbackItem[] {
    return items.filter((i) => !sent.has(i.id));
  }

  /** Sends one digest if there is unsent feedback and the last email was at least a day ago. Never throws. */
  async function tick(): Promise<void> {
    const cfg = opts.mail;
    if (!cfg || sending) return;
    const now = clock();
    if (lastSentAt !== null && now - lastSentAt < interval) return;
    const batch = pending().slice(0, MAX_ITEMS_PER_EMAIL);
    if (!batch.length) return;
    sending = true;
    try {
      if (!transport) {
        const { createTransport } = await import('nodemailer');
        transport = createTransport({ host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: { user: cfg.user, pass: cfg.pass } });
      }
      await transport.sendMail(renderDigest(batch, cfg));
    } catch (err) {
      // A failure does not count as the day's email: nothing is marked sent, the next tick retries.
      log(`feedback email failed (${batch.length} item(s), will retry): ${(err as Error).message}`);
      return;
    } finally {
      sending = false;
    }
    for (const i of batch) sent.add(i.id);
    lastSentAt = now;
    try {
      saveState();
    } catch (err) {
      log(`ERROR: could not save feedback-mail.json: ${(err as Error).message}`);
    }
    log(`feedback email sent (${batch.length} item(s))`);
  }

  function start(tickMs = 10 * 60_000) {
    if (timer) return;
    timer = setInterval(() => void tick(), tickMs);
    timer.unref();
    void tick(); // deliver anything left over from before a restart
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    submit,
    tick,
    start,
    stop,
    pending,
    items,
    get lastSentAt() {
      return lastSentAt;
    },
  };
}

export type Feedback = ReturnType<typeof createFeedback>;
