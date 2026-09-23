import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertStayRange,
  DateRangeError,
  eachNight,
  nightsBetween,
  rangesOverlap,
  toUtcMillis
} from '@/domain/dates';

describe('dates', () => {
  it('counts billable nights on a half-open interval', () => {
    expect(nightsBetween({ checkIn: '2026-01-01', checkOut: '2026-01-03' })).toBe(2);
    expect(nightsBetween({ checkIn: '2026-01-01', checkOut: '2026-01-02' })).toBe(1);
    expect(nightsBetween({ checkIn: '2026-03-01', checkOut: '2026-04-01' })).toBe(31);
  });

  it('rejects a zero-night or inverted stay', () => {
    expect(() => assertStayRange({ checkIn: '2026-01-05', checkOut: '2026-01-05' })).toThrow(DateRangeError);
    expect(() => assertStayRange({ checkIn: '2026-01-06', checkOut: '2026-01-05' })).toThrow(DateRangeError);
  });

  it('rejects malformed and impossible dates', () => {
    expect(() => toUtcMillis('01-01-2026')).toThrow(DateRangeError);
    expect(() => toUtcMillis('2026-02-30')).toThrow(DateRangeError);
  });

  it('enumerates each night of a stay', () => {
    expect(eachNight({ checkIn: '2026-01-30', checkOut: '2026-02-02' })).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01'
    ]);
  });

  it('adds days across month and leap boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('treats back-to-back stays as non-overlapping', () => {
    const first = { checkIn: '2026-02-01', checkOut: '2026-02-05' };
    const second = { checkIn: '2026-02-05', checkOut: '2026-02-08' };
    expect(rangesOverlap(first, second)).toBe(false);
  });

  it('detects partial and full overlap', () => {
    const first = { checkIn: '2026-02-01', checkOut: '2026-02-05' };
    expect(rangesOverlap(first, { checkIn: '2026-02-04', checkOut: '2026-02-09' })).toBe(true);
    expect(rangesOverlap(first, { checkIn: '2026-02-02', checkOut: '2026-02-03' })).toBe(true);
    expect(rangesOverlap(first, { checkIn: '2026-01-01', checkOut: '2026-03-01' })).toBe(true);
  });
});
