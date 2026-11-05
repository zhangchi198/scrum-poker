import { LIMITS } from '../../../shared/protocol.ts';

export function parseCustomInput(input: string): string[] {
  return [
    ...new Set(
      input
        .split(',')
        .map((s) => s.trim().slice(0, LIMITS.customCardLength))
        .filter(Boolean),
    ),
  ].slice(0, LIMITS.customCards);
}
