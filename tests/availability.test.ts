import { describe, expect, it } from 'vitest';
import {
  activeHolds,
  AvailabilityError,
  checkAvailability,
  createHold,
  effectiveNightlyRateKobo,
  holdExpiry,
  type Hold,
  type UnitNightState
} from '@/domain/availability';

const NOW = '2026-04-01T09:00:00.000Z';

function openNights(unitId: string, nights: string[], rateKobo = 5_000_000): UnitNightState[] {
  return nights.map((night) => ({
    unitId,
    night,
    state: 'OPEN' as const,
    nightlyRateKobo: rateKobo,
    source: 'PARTNER_DASHBOARD' as const
  }));
}

describe('hold expiry', () => {
  it('defaults to a 15 minute checkout hold', () => {
    expect(holdExpiry(NOW)).toBe('2026-04-01T09:15:00.000Z');
  });

  it('rejects a non-positive TTL', () => {
    expect(() => holdExpiry(NOW, 0)).toThrow(AvailabilityError);
  });
});

describe('checkAvailability', () => {
  const stay = { checkIn: '2026-04-10', checkOut: '2026-04-13' };

  it('is available when every night is published and open', () => {
    const result = checkAvailability({
      unitId: 'u1',
      stay,
      calendar: openNights('u1', ['2026-04-10', '2026-04-11', '2026-04-12']),
      holds: [],
      now: NOW
    });

    expect(result.available).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(Object.keys(result.nightlyRateOverrides)).toHaveLength(3);
  });

  it('is unavailable when the partner closed one night', () => {
    const calendar: UnitNightState[] = [
      ...openNights('u1', ['2026-04-10', '2026-04-12']),
      { unitId: 'u1', night: '2026-04-11', state: 'CLOSED', source: 'ICAL_FEED' }
    ];

    const result = checkAvailability({ unitId: 'u1', stay, calendar, holds: [], now: NOW });

    expect(result.available).toBe(false);
    expect(result.blockedNights).toEqual(['2026-04-11']);
  });

  it('treats nights the partner never published as unavailable', () => {
    const result = checkAvailability({
      unitId: 'u1',
      stay,
      calendar: openNights('u1', ['2026-04-10']),
      holds: [],
      now: NOW
    });

    expect(result.available).toBe(false);
    expect(result.blockedNights).toEqual(['2026-04-11', '2026-04-12']);
  });

  it('can allow on-request nights when the partner accepts manual confirmation', () => {
    const result = checkAvailability({
      unitId: 'u1',
      stay,
      calendar: openNights('u1', ['2026-04-10']),
      holds: [],
      now: NOW,
      allowOnRequest: true
    });

    expect(result.available).toBe(true);
  });

  it('is blocked by a live hold but not by an expired one', () => {
    const liveHold: Hold = {
      id: 'h1',
      unitId: 'u1',
      stay: { checkIn: '2026-04-11', checkOut: '2026-04-12' },
      status: 'ACTIVE',
      expiresAt: '2026-04-01T09:10:00.000Z'
    };
    const calendar = openNights('u1', ['2026-04-10', '2026-04-11', '2026-04-12']);

    expect(checkAvailability({ unitId: 'u1', stay, calendar, holds: [liveHold], now: NOW }).available).toBe(false);

    const afterExpiry = '2026-04-01T09:20:00.000Z';
    expect(checkAvailability({ unitId: 'u1', stay, calendar, holds: [liveHold], now: afterExpiry }).available).toBe(
      true
    );
  });

  it('is blocked by an already confirmed overlapping booking', () => {
    const result = checkAvailability({
      unitId: 'u1',
      stay,
      calendar: openNights('u1', ['2026-04-10', '2026-04-11', '2026-04-12']),
      holds: [],
      now: NOW,
      confirmedBookings: [{ unitId: 'u1', stay: { checkIn: '2026-04-12', checkOut: '2026-04-15' } }]
    });

    expect(result.available).toBe(false);
    expect(result.conflictingBookings).toBe(1);
  });

  it('ignores holds on other units', () => {
    const otherUnitHold: Hold = {
      id: 'h2',
      unitId: 'u2',
      stay: { checkIn: '2026-04-10', checkOut: '2026-04-13' },
      status: 'ACTIVE',
      expiresAt: '2026-04-01T10:00:00.000Z'
    };

    const result = checkAvailability({
      unitId: 'u1',
      stay,
      calendar: openNights('u1', ['2026-04-10', '2026-04-11', '2026-04-12']),
      holds: [otherUnitHold],
      now: NOW
    });

    expect(result.available).toBe(true);
  });
});

describe('createHold', () => {
  const base = {
    unitId: 'u1',
    stay: { checkIn: '2026-04-10', checkOut: '2026-04-12' },
    calendar: openNights('u1', ['2026-04-10', '2026-04-11']),
    holds: [] as Hold[],
    now: NOW
  };

  it('creates an ACTIVE hold with a TTL', () => {
    const hold = createHold({ ...base, holdId: 'h-new', ttlMinutes: 20 });
    expect(hold.status).toBe('ACTIVE');
    expect(hold.expiresAt).toBe('2026-04-01T09:20:00.000Z');
  });

  it('throws instead of holding unavailable inventory', () => {
    expect(() => createHold({ ...base, calendar: [], holdId: 'h-bad' })).toThrow(AvailabilityError);
  });
});

describe('activeHolds', () => {
  it('filters out non-active and expired holds', () => {
    const holds: Hold[] = [
      { id: 'a', unitId: 'u1', stay: { checkIn: '2026-04-10', checkOut: '2026-04-11' }, status: 'ACTIVE', expiresAt: '2026-04-01T09:10:00.000Z' },
      { id: 'b', unitId: 'u1', stay: { checkIn: '2026-04-10', checkOut: '2026-04-11' }, status: 'ACTIVE', expiresAt: '2026-04-01T08:00:00.000Z' },
      { id: 'c', unitId: 'u1', stay: { checkIn: '2026-04-10', checkOut: '2026-04-11' }, status: 'CONVERTED', expiresAt: '2026-04-01T10:00:00.000Z' }
    ];

    expect(activeHolds(holds, NOW).map((hold) => hold.id)).toEqual(['a']);
  });
});

describe('effectiveNightlyRateKobo', () => {
  it('uses the base rate when there are no overrides', () => {
    expect(effectiveNightlyRateKobo(5_000_000, {})).toBe(5_000_000);
  });

  it('never under-quotes a premium night', () => {
    expect(effectiveNightlyRateKobo(5_000_000, { '2026-04-11': 9_000_000, '2026-04-12': 6_000_000 })).toBe(
      9_000_000
    );
  });
});
