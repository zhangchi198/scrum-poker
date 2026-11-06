import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_MS,
  NUMBER_KEYS,
  PAGE_KINDS,
  TIMING_KEYS,
  TRIGGERS,
  type PageKind,
  type Trigger,
  type VitalsRecord,
} from '../shared/vitals.ts';

export interface VitalsOptions {
  /** Directory for vitals.jsonl; none keeps records in memory only. */
  dir?: string;
  perIpPerHour?: number;
  globalPerDay?: number;
  /** Rotate vitals.jsonl to vitals.jsonl.1 once it reaches this size. */
  maxFileBytes?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const RING = 200;

const clampNum = (v: unknown, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(0, v)) * 10) / 10 : undefined;

/** Printable ASCII only, truncated: strings never carry anything but a short label. */
const label = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '').slice(0, max) : '');

/** Turns an untrusted beacon into a record containing only known fields, or null if it is not an object. */
export function sanitizeBeacon(raw: unknown, ts: string): VitalsRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const timings: VitalsRecord['timings'] = {};
  const t = b.timings && typeof b.timings === 'object' ? (b.timings as Record<string, unknown>) : {};
  for (const k of TIMING_KEYS) {
    const n = clampNum(t[k], MAX_MS);
    if (n !== undefined) timings[k] = n;
  }
  const rec: VitalsRecord = {
    ts,
    kind: (PAGE_KINDS as readonly string[]).includes(b.kind as string) ? (b.kind as PageKind) : 'other',
    trigger: (TRIGGERS as readonly string[]).includes(b.trigger as string) ? (b.trigger as Trigger) : 'timeout',
    cold: b.cold === true,
    jsCold: b.jsCold === true,
    inlined: b.inlined === true,
    proto: label(b.proto, 12),
    net: label(b.net, 10),
    ua: label(b.ua, 40),
    timings,
  };
  for (const k of NUMBER_KEYS) {
    const n = clampNum(b[k], k === 'transfer' ? 100_000_000 : 20_000);
    if (n !== undefined) rec[k] = n;
  }
  return rec;
}

/**
 * Stores real-user timing beacons: a memory ring buffer plus an append-only vitals.jsonl (rotated at a size cap).
 * The client IP is only used for rate limiting in memory, never written anywhere.
 */
export function createVitals(opts: VitalsOptions = {}) {
  const perIp = opts.perIpPerHour ?? 30;
  const perDay = opts.globalPerDay ?? 2000;
  const maxBytes = opts.maxFileBytes ?? 5 * 1024 * 1024;
  const clock = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const file = opts.dir ? join(opts.dir, 'vitals.jsonl') : undefined;
  const recent: VitalsRecord[] = [];
  const byIp = new Map<string, number[]>();
  let dayBucket = -1;
  let dayCount = 0;
  let size = 0;
  let warned = false;

  if (file) {
    // The directory is deliberately not created: it is the data volume, and a missing one must stay an error
    // for the room save rather than being papered over here.
    try {
      if (existsSync(file)) size = statSync(file).size;
    } catch (err) {
      log(`vitals: cannot stat ${file}: ${(err as Error).message}`);
    }
  }

  function allow(ip: string, now: number): boolean {
    const bucket = Math.floor(now / DAY);
    if (bucket !== dayBucket) {
      dayBucket = bucket;
      dayCount = 0;
    }
    const recentIp = (byIp.get(ip) ?? []).filter((t) => now - t < HOUR);
    if (recentIp.length >= perIp || dayCount >= perDay) {
      byIp.set(ip, recentIp);
      return false;
    }
    recentIp.push(now);
    byIp.set(ip, recentIp);
    dayCount++;
    return true;
  }

  function write(rec: VitalsRecord) {
    recent.push(rec);
    if (recent.length > RING) recent.shift();
    if (!file) return;
    try {
      const line = `${JSON.stringify(rec)}\n`;
      if (size > 0 && size + line.length > maxBytes) {
        renameSync(file, `${file}.1`);
        size = 0;
      }
      appendFileSync(file, line);
      size += line.length;
    } catch (err) {
      if (!warned) log(`vitals: write failed (further failures are not logged): ${(err as Error).message}`);
      warned = true;
    }
  }

  /** `ok` = stored; `bad` = not a valid beacon; `limit` = rate limited. */
  function submit(raw: unknown, ip: string): 'ok' | 'bad' | 'limit' {
    const now = clock();
    const rec = sanitizeBeacon(raw, new Date(now).toISOString());
    if (!rec) return 'bad';
    if (!allow(ip, now)) return 'limit';
    write(rec);
    return 'ok';
  }

  function sweep() {
    const now = clock();
    for (const [ip, times] of byIp) {
      const keep = times.filter((t) => now - t < HOUR);
      if (keep.length) byIp.set(ip, keep);
      else byIp.delete(ip);
    }
  }

  return { submit, sweep, recent, file };
}
