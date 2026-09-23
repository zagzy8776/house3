/**
 * Availability, inventory holds and oversell protection.
 *
 * Why this exists: House3 does not own the rooms, so the fast, reliable path to
 * a confirmed stay is to (a) sync the partner's live calendar, and (b) take a
 * short-lived HOLD while the guest is on the payment page. If two guests race
 * for the same night, the second hold is rejected - we never take money for a
 * night we cannot deliver.
 */

import { eachNight, rangesOverlap, type IsoDate, type IsoInstant, type StayRange } from './dates';

export const DEFAULT_HOLD_TTL_MINUTES = 15;

export type UnitNightState = {
  unitId: string;
  /** Night-start date the state applies to. */
  night: IsoDate;
  state: 'OPEN' | 'CLOSED' | 'ON_REQUEST';
  /** Partner's own rate for that night, if it differs from the base rate. */
  nightlyRateKobo?: number;
  /** Where this state came from, for auditability. */
  source: 'PARTNER_API' | 'ICAL_FEED' | 'PARTNER_DASHBOARD' | 'BOOKING';
};

export type Hold = {
  id: string;
  unitId: string;
  stay: StayRange;
  status: 'ACTIVE' | 'CONVERTED' | 'EXPIRED' | 'RELEASED';
  expiresAt: IsoInstant;
};

export class AvailabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AvailabilityError';
  }
}

export function isHoldExpired(hold: Hold, now: IsoInstant): boolean {
  return new Date(hold.expiresAt).getTime() <= new Date(now).getTime();
}

/** Active holds only; expired holds are ignored so they cannot block inventory. */
export function activeHolds(holds: readonly Hold[], now: IsoInstant): Hold[] {
  return holds.filter((hold) => hold.status === 'ACTIVE' && !isHoldExpired(hold, now));
}

export function holdExpiry(now: IsoInstant, ttlMinutes: number = DEFAULT_HOLD_TTL_MINUTES): IsoInstant {
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    throw new AvailabilityError(`ttlMinutes must be positive, received ${ttlMinutes}`);
  }
  return new Date(new Date(now).getTime() + ttlMinutes * 60_000).toISOString();
}

export type AvailabilityCheckInput = {
  unitId: string;
  stay: StayRange;
  /** Night states pushed by the partner (calendar sync). */
  calendar: readonly UnitNightState[];
  /** Existing holds for the unit, any status. */
  holds: readonly Hold[];
  now: IsoInstant;
  /** Bookings already confirmed for the unit. */
  confirmedBookings?: readonly { unitId: string; stay: StayRange }[];
  /** Set true to allow booking nights the partner has not published yet. */
  allowOnRequest?: boolean;
};

export type AvailabilityResult = {
  available: boolean;
  reasons: string[];
  /** Per-night rate overrides found in the calendar, keyed by night date. */
  nightlyRateOverrides: Record<IsoDate, number>;
  blockedNights: IsoDate[];
  conflictingHolds: string[];
  conflictingBookings: number;
};

export function checkAvailability(input: AvailabilityCheckInput): AvailabilityResult {
  const { unitId, stay, calendar, holds, now } = input;
  const reasons: string[] = [];
  const blockedNights: IsoDate[] = [];
  const nightlyRateOverrides: Record<IsoDate, number> = {};

  const byNight = new Map<IsoDate, UnitNightState>();
  for (const night of calendar) {
    if (night.unitId === unitId) byNight.set(night.night, night);
  }

  for (const night of eachNight(stay)) {
    const state = byNight.get(night);
    if (!state) {
      if (!input.allowOnRequest) {
        blockedNights.push(night);
        reasons.push(`No published rate for night ${night}`);
      }
      continue;
    }
    if (state.state === 'CLOSED') {
      blockedNights.push(night);
      reasons.push(`Night ${night} is closed by the partner`);
    }
    if (state.state === 'ON_REQUEST' && !input.allowOnRequest) {
      blockedNights.push(night);
      reasons.push(`Night ${night} requires a partner confirmation`);
    }
    if (typeof state.nightlyRateKobo === 'number') {
      nightlyRateOverrides[night] = state.nightlyRateKobo;
    }
  }

  const conflicts = activeHolds(holds, now).filter(
    (hold) => hold.unitId === unitId && rangesOverlap(hold.stay, stay)
  );
  if (conflicts.length > 0) {
    reasons.push(`Unit is held by ${conflicts.length} active checkout session(s)`);
  }

  const bookingConflicts = (input.confirmedBookings ?? []).filter(
    (booking) => booking.unitId === unitId && rangesOverlap(booking.stay, stay)
  );
  if (bookingConflicts.length > 0) {
    reasons.push(`Unit already booked for an overlapping stay`);
  }

  return {
    available: reasons.length === 0,
    reasons,
    nightlyRateOverrides,
    blockedNights,
    conflictingHolds: conflicts.map((hold) => hold.id),
    conflictingBookings: bookingConflicts.length
  };
}

/**
 * Assert a unit can be held, then return the hold to persist. Throws instead of
 * returning a falsy result so a caller can never accidentally continue into a
 * payment flow with unavailable inventory.
 */
export function createHold(
  input: AvailabilityCheckInput & { holdId: string; ttlMinutes?: number }
): Hold {
  const result = checkAvailability(input);
  if (!result.available) {
    throw new AvailabilityError(
      `Cannot hold ${input.unitId} for ${input.stay.checkIn}..${input.stay.checkOut}: ${result.reasons.join('; ')}`
    );
  }
  return {
    id: input.holdId,
    unitId: input.unitId,
    stay: input.stay,
    status: 'ACTIVE',
    expiresAt: holdExpiry(input.now, input.ttlMinutes ?? DEFAULT_HOLD_TTL_MINUTES)
  };
}

/** Effective nightly rate: the first night override if present, else the base rate. */
export function effectiveNightlyRateKobo(
  baseRateKobo: number,
  nightlyRateOverrides: Record<IsoDate, number>
): number {
  const overrides = Object.values(nightlyRateOverrides);
  if (overrides.length === 0) return baseRateKobo;
  // Use the highest override so we never under-quote a premium night.
  return Math.max(baseRateKobo, ...overrides);
}
