import { describe, expect, it } from 'vitest';
import {
  applyBps,
  clampKobo,
  formatNaira,
  MoneyError,
  roundToStep,
  sumKobo,
  toKobo,
  toNaira
} from '@/domain/money';

describe('money', () => {
  it('converts naira to integer kobo', () => {
    expect(toKobo(150_000)).toBe(15_000_000);
    expect(toKobo(1500.5)).toBe(150_050);
  });

  it('round-trips kobo back to naira', () => {
    expect(toNaira(15_000_000)).toBe(150_000);
  });

  it('rejects non-integer kobo when asserting', () => {
    expect(() => toNaira(1500.5)).toThrow(MoneyError);
  });

  it('applies basis points with half-up rounding', () => {
    // 12% of NGN 150,000 = NGN 18,000
    expect(applyBps(15_000_000, 1_200)).toBe(1_800_000);
    // 7.5% of NGN 18,000 = NGN 1,350
    expect(applyBps(1_800_000, 750)).toBe(135_000);
    // 10% of 101 kobo = 10.1 -> 10
    expect(applyBps(101, 1_000)).toBe(10);
  });

  it('clamps into a min/max band', () => {
    expect(clampKobo(500, 1_000, 5_000)).toBe(1_000);
    expect(clampKobo(9_999, 1_000, 5_000)).toBe(5_000);
    expect(clampKobo(2_000, 1_000, null)).toBe(2_000);
  });

  it('rejects an inverted clamp band', () => {
    expect(() => clampKobo(1, 5_000, 1_000)).toThrow(MoneyError);
  });

  it('rounds to the nearest display step', () => {
    // step = NGN 50 = 5,000 kobo
    expect(roundToStep(1_800_000, 5_000)).toBe(1_800_000);
    expect(roundToStep(1_800_001, 5_000)).toBe(1_800_000);
    // Below the midpoint rounds down, above rounds up, exact ties round up.
    expect(roundToStep(1_802_400, 5_000)).toBe(1_800_000);
    expect(roundToStep(1_802_600, 5_000)).toBe(1_805_000);
    expect(roundToStep(1_802_500, 5_000)).toBe(1_805_000);
    expect(roundToStep(1_234, 1)).toBe(1_234);
  });

  it('formats naira with grouping and two decimals', () => {
    expect(formatNaira(16_935_000)).toBe('NGN 169,350.00');
    expect(formatNaira(16_935_000, { decimals: false })).toBe('NGN 169,350');
    expect(formatNaira(16_935_050)).toBe('NGN 169,350.50');
    expect(formatNaira(-1_000)).toBe('-NGN 10.00');
  });

  it('sums kobo and rejects garbage', () => {
    expect(sumKobo([100, 200, -50])).toBe(250);
    expect(() => sumKobo([100, 1.5])).toThrow(MoneyError);
  });
});
