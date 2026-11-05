import { describe, expect, it } from 'vitest';
import { computeStats, DECKS, numericValue } from '../shared/protocol.ts';

const fib = DECKS.fibonacci.cards;

describe('numericValue', () => {
  it('parses numbers and ½, rejects the rest', () => {
    expect(numericValue('13')).toBe(13);
    expect(numericValue('½')).toBe(0.5);
    expect(numericValue('?')).toBeNull();
    expect(numericValue('XL')).toBeNull();
  });
});

describe('computeStats', () => {
  it('averages numeric votes and ignores ? and ☕', () => {
    const s = computeStats(['3', '5', '8', '?', '☕'], fib);
    expect(s.total).toBe(5);
    expect(s.average).toBeCloseTo(16 / 3);
    expect(s.median).toBe(5);
    expect(s.distribution.map((d) => d.card)).toEqual(['3', '5', '8', '?', '☕']);
    expect(s.consensus).toBe(false);
  });

  it('even-length median is the midpoint', () => {
    expect(computeStats(['2', '3', '5', '8'], fib).median).toBe(4);
  });

  it('flags consensus only when 2+ real votes all match', () => {
    expect(computeStats(['5', '5', '?'], fib).consensus).toBe(true);
    expect(computeStats(['5'], fib).consensus).toBe(false);
    expect(computeStats(['?', '?'], fib).consensus).toBe(false);
  });

  it('computes agreement and most common for non-numeric decks', () => {
    const s = computeStats(['M', 'M', 'L', '?'], DECKS.tshirt.cards);
    expect(s.average).toBeNull();
    expect(s.mostCommon).toEqual(['M']);
    expect(s.agreement).toBeCloseTo(2 / 3);
  });
});
