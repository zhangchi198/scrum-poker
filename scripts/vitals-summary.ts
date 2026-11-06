// Prints the latest real-user timing records and p50/p90 per metric per page kind.
//   docker exec scrum-poker-app-1 node scripts/vitals-summary.ts [-n 20] [--cold] [--file path]
// The data directory comes from DATA_FILE (vitals.jsonl sits next to it), like the server.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PAGE_KINDS, TIMING_KEYS, percentile, type VitalsRecord } from '../shared/vitals.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const lastN = Number(value('-n') ?? 15);
const file = value('--file') ?? (process.env.DATA_FILE ? join(dirname(process.env.DATA_FILE), 'vitals.jsonl') : 'vitals.jsonl');

function readRecords(path: string): VitalsRecord[] {
  if (!existsSync(path)) return [];
  const out: VitalsRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as VitalsRecord);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

let records = [...readRecords(`${file}.1`), ...readRecords(file)];
if (!records.length) {
  console.log(`No vitals records in ${file}`);
  process.exit(0);
}
if (flag('--cold')) records = records.filter((r) => r.cold);

const fmt = (n: number | null | undefined) => (n == null ? '-' : String(Math.round(n)));
console.log(`${records.length} record(s) from ${records[0]?.ts} to ${records.at(-1)?.ts}${flag('--cold') ? ' (cold loads only)' : ''}\n`);

console.log(`Last ${Math.min(lastN, records.length)}:`);
console.log('time (UTC)           kind  trigger     cold net   ua                 ttfb  fcp  lcp load lookup wsOpen welcome hand');
for (const r of records.slice(-lastN)) {
  const t = r.timings;
  console.log(
    [
      r.ts.slice(0, 19).replace('T', ' ').padEnd(20),
      r.kind.padEnd(5),
      r.trigger.padEnd(11),
      (r.cold ? 'yes' : 'no').padEnd(4),
      (r.net || '-').padEnd(5),
      (r.ua || '-').padEnd(18),
      ...(['ttfb', 'fcp', 'lcp', 'load'] as const).map((k) => fmt(t[k]).padStart(4)),
      ...(['lookup', 'wsOpen', 'welcome', 'hand'] as const).map((k) => fmt(t[k]).padStart(6)),
    ].join(' '),
  );
}

console.log('\np50/p90 (n) in ms, per page kind:');
for (const kind of PAGE_KINDS) {
  const rs = records.filter((r) => r.kind === kind);
  if (!rs.length) continue;
  console.log(`\n${kind} (${rs.length} loads, ${rs.filter((r) => r.cold).length} cold)`);
  for (const k of TIMING_KEYS) {
    const xs = rs
      .map((r) => r.timings[k])
      .filter((v): v is number => typeof v === 'number')
      .sort((a, b) => a - b);
    if (xs.length) console.log(`  ${k.padEnd(14)} ${fmt(percentile(xs, 0.5)).padStart(6)} / ${fmt(percentile(xs, 0.9)).padStart(6)}  (${xs.length})`);
  }
}
