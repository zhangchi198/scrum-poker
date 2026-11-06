// Text helpers shared by the server and the client. Lengths count user-perceived characters (graphemes),
// so a family emoji or an accented letter is one character, never half of one.

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

export function graphemes(s: string): string[] {
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}

export function graphemeLength(s: string): number {
  return graphemes(s).length;
}

export function sliceGraphemes(s: string, max: number): string {
  const g = graphemes(s);
  return g.length <= max ? s : g.slice(0, max).join('');
}

/**
 * Strips control, zero-width and bidi-override characters (invisible names, spoofed text), collapses whitespace
 * and trims. A zero-width joiner survives only when it glues two pictographs (👨‍👩‍👧), so joined emoji stay one character.
 */
export function cleanText(input: unknown, max: number): string {
  if (typeof input !== 'string') return '';
  return sliceGraphemes(
    input
      .replace(/[\u0000-\u001f\u007f-\u009f​‌‎‏‪-‮⁠-⁤⁦-⁩﻿]/g, '')
      .replace(/(?<![\p{Extended_Pictographic}️])‍|‍(?!\p{Extended_Pictographic})/gu, '')
      .replace(/\s+/g, ' ')
      .trim(),
    max,
  );
}
