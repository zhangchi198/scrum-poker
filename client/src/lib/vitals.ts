import { TIMING_KEYS, uaFamily, type PageKind, type Trigger, type VitalsBeacon } from '../../../shared/vitals.ts';
import { roomIdFromPath } from './invite.ts';

/**
 * Real-user timing: ONE beacon per page load, sent once the room is interactive or 10 s after load, whichever
 * comes first (or when the tab is hidden). It carries timings and coarse environment only: never a room id, URL,
 * name or vote. The page kind is a label (`home`, `room`, `join`, `other`).
 */

type Milestone = 'lookup' | 'wsOpen' | 'welcome' | 'hand';

const marks: Partial<Record<Milestone, number>> = {};
let kind: PageKind | null = null;
let inlined = false;
let sent = false;
let lcp: number | undefined;
let started = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

/** Records an app milestone (ms since navigation start). Only the first call per milestone counts. */
export function mark(name: Milestone) {
  marks[name] ??= Math.round(performance.now());
}

export function setPageKind(k: PageKind) {
  kind = k;
}

export function markInlinedLookup() {
  inlined = true;
}

/** Sends the beacon `delayMs` from now (0 = right away) unless it was already sent. */
export function reportSoon(delayMs = 0) {
  if (sent) return;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flush('interactive'), delayMs);
}

function defaultKind(): PageKind {
  if (location.pathname === '/') return 'home';
  return roomIdFromPath(location.pathname) ? 'room' : 'other';
}

function flush(trigger: Trigger) {
  if (sent) return;
  sent = true;
  clearTimeout(flushTimer);
  clearTimeout(timeoutTimer);
  try {
    navigator.sendBeacon('/api/vitals', JSON.stringify(collect(trigger)));
  } catch {
    /* timing is best-effort */
  }
}

/** Builds the beacon payload. Browser only. */
export function collect(trigger: Trigger): VitalsBeacon {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const t: VitalsBeacon['timings'] = {};
  if (nav) {
    t.dns = nav.domainLookupEnd - nav.domainLookupStart;
    t.connect = nav.connectEnd - nav.connectStart;
    if (nav.secureConnectionStart > 0) t.tls = nav.connectEnd - nav.secureConnectionStart;
    t.request = nav.requestStart;
    t.ttfb = nav.responseStart;
    t.response = nav.responseEnd;
    t.domInteractive = nav.domInteractive;
    if (nav.domContentLoadedEventEnd > 0) t.dcl = nav.domContentLoadedEventEnd;
    if (nav.loadEventEnd > 0) t.load = nav.loadEventEnd;
  }
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  if (fcp) t.fcp = fcp.startTime;
  if (lcp !== undefined) t.lcp = lcp;
  Object.assign(t, marks);
  for (const k of TIMING_KEYS) if (t[k] !== undefined) t[k] = Math.round(t[k]!);

  const script = performance.getEntriesByType('resource').find((r) => /\/assets\/index-[^/]*\.js$/.test(r.name)) as
    | PerformanceResourceTiming
    | undefined;
  const conn = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection;
  return {
    kind: kind ?? defaultKind(),
    trigger,
    cold: !!nav && nav.transferSize > 0,
    jsCold: !!script && script.transferSize > 0,
    inlined,
    proto: nav?.nextHopProtocol ?? '',
    net: conn?.effectiveType ?? '',
    ua: uaFamily(navigator.userAgent),
    timings: t,
    transfer: nav?.transferSize,
    vw: window.innerWidth,
    vh: window.innerHeight,
  };
}

/** Call once at startup. */
export function startVitals() {
  if (started) return;
  started = true;
  try {
    new PerformanceObserver((list) => {
      const last = list.getEntries().at(-1);
      if (last) lcp = last.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    /* LCP is not supported everywhere (Safari < 17.4, Firefox) */
  }
  timeoutTimer = setTimeout(() => flush('timeout'), 10_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush('hidden');
  });
}
