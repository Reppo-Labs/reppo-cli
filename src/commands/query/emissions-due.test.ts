import { describe, it, expect } from 'vitest';
import { parseWei } from './emissions-due.js';

describe('parseWei', () => {
  it('parses decimal-string wei', () => {
    expect(parseWei('1500000000000000000')).toBe(1500000000000000000n);
  });

  it('parses JS number wei via integer truncation', () => {
    expect(parseWei(42)).toBe(42n);
  });

  it('returns 0n for undefined/null/empty', () => {
    expect(parseWei(undefined)).toBe(0n);
    expect(parseWei('')).toBe(0n);
  });

  it('returns 0n for non-digit strings (would otherwise throw SyntaxError)', () => {
    expect(parseWei('abc')).toBe(0n);
    expect(parseWei('1.5')).toBe(0n);
    expect(parseWei('1e18')).toBe(0n);
  });

  it('rejects negatives — claimable emissions cannot be negative', () => {
    // Adversarial / buggy platform API response. Must not be allowed to
    // drag totalDueREPPO below zero.
    expect(parseWei('-500')).toBe(0n);
    expect(parseWei(-42)).toBe(0n);
  });

  it('handles enormous bigints beyond Number.MAX_SAFE_INTEGER', () => {
    const big = '999999999999999999999999999999';
    expect(parseWei(big)).toBe(BigInt(big));
  });
});
