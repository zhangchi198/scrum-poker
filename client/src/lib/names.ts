/**
 * Display labels for participants. The server keeps whatever name each person typed; when two people share one,
 * the later one (in participant order) shows as "Alex (2)", the next "Alex (3)", and so on.
 */
export function displayNames(people: readonly { id: string; name: string }[]): Map<string, string> {
  const key = (s: string) => s.normalize('NFC').toLocaleLowerCase();
  const taken = new Set(people.map((p) => key(p.name)));
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const p of people) {
    const k = key(p.name);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n === 1) {
      out.set(p.id, p.name);
      continue;
    }
    // Skip suffixes that would collide with someone who really is called "Alex (2)".
    let label = `${p.name} (${n})`;
    for (let i = n + 1; taken.has(key(label)); i++) label = `${p.name} (${i})`;
    taken.add(key(label));
    out.set(p.id, label);
  }
  return out;
}
