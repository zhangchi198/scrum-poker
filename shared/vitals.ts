/** Real-user timing beacon shared by the client (sends), the server (validates) and scripts/vitals-summary.ts. */

export const PAGE_KINDS = ['home', 'room', 'join', 'other'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export const TRIGGERS = ['interactive', 'timeout', 'hidden'] as const;
export type Trigger = (typeof TRIGGERS)[number];

/** Millisecond metrics. Unless noted they are measured from the start of navigation; missing = not observed. */
export const TIMING_KEYS = [
  'dns', // domainLookupEnd - domainLookupStart (a duration)
  'connect', // connectEnd - connectStart (a duration, includes TLS)
  'tls', // connectEnd - secureConnectionStart (a duration)
  'request', // requestStart
  'ttfb', // responseStart
  'response', // responseEnd
  'domInteractive',
  'dcl', // domContentLoadedEventEnd
  'load', // loadEventEnd
  'fcp',
  'lcp',
  'lookup', // room lookup finished (or was inlined in the HTML)
  'wsOpen', // WebSocket open
  'welcome', // welcome message received
  'hand', // first render of the hand of cards
] as const;
export type TimingKey = (typeof TIMING_KEYS)[number];

/** Other numeric fields. */
export const NUMBER_KEYS = ['transfer', 'vw', 'vh'] as const;

export const MAX_BEACON_BYTES = 4096;
export const MAX_MS = 10 * 60_000;

export interface VitalsBeacon {
  kind: PageKind;
  trigger: Trigger;
  /** The main document came over the network (not from the HTTP cache). */
  cold: boolean;
  /** The main script came over the network. */
  jsCold: boolean;
  /** Room lookup was inlined in the HTML (no round trip). */
  inlined: boolean;
  proto: string;
  net: string;
  ua: string;
  timings: Partial<Record<TimingKey, number>>;
  transfer?: number;
  vw?: number;
  vh?: number;
}

export type VitalsRecord = VitalsBeacon & { ts: string };

/** Coarse "Browser/OS" string; no versions, nothing that identifies a person. */
export function uaFamily(ua: string): string {
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'other';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\/|FxiOS/.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS/.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'other';
  return `${browser}/${os}`;
}

/** Linear-interpolation percentile of an ascending-sorted list. */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}
