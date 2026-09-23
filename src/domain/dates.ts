/**
 * Date helpers for stay windows.
 *
 * A stay is modelled as a half-open interval [checkIn, checkOut) of calendar
 * dates in "YYYY-MM-DD" form. The guest occupies the nights checkIn .. checkOut-1.
 * Half-open intervals make overlap detection exact: back-to-back bookings
 * (out on the 5th, in on the 5th) are NOT a conflict.
 */

export type IsoDate = string; // "YYYY-MM-DD"
export type IsoInstant = string; // full ISO timestamp

export const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class DateRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateRangeError';
  }
}

export function assertIsoDate(value: string, label = 'date'): IsoDate {
  if (!ISO_DATE_RE.test(value)) {
    throw new DateRangeError(`${label} must be YYYY-MM-DD, received "${value}"`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new DateRangeError(`${label} is not a real date: ${value}`);
  // Reject rollovers such as 2026-02-31.
  if (parsed.toISOString().slice(0, 10) !== value) {
    throw new DateRangeError(`${label} is not a real calendar date: ${value}`);
  }
  return value;
}

/** Parse an ISO date into a UTC midnight timestamp, so day maths is safe. */
export function toUtcMillis(date: IsoDate): number {
  assertIsoDate(date);
  return new Date(`${date}T00:00:00.000Z`).getTime();
}

export function fromUtcMillis(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  if (!Number.isInteger(days)) throw new DateRangeError(`days must be an integer, received ${days}`);
  return fromUtcMillis(toUtcMillis(date) + days * DAY_MS);
}

export type StayRange = { checkIn: IsoDate; checkOut: IsoDate };

export function assertStayRange(range: StayRange): StayRange {
  assertIsoDate(range.checkIn, 'checkIn');
  assertIsoDate(range.checkOut, 'checkOut');
  if (toUtcMillis(range.checkOut) <= toUtcMillis(range.checkIn)) {
    throw new DateRangeError(
      `checkOut (${range.checkOut}) must be after checkIn (${range.checkIn})`
    );
  }
  return range;
}

/** Number of billable nights in a stay. 2026-01-01 -> 2026-01-03 === 2 nights. */
export function nightsBetween(range: StayRange): number {
  assertStayRange(range);
  return Math.round((toUtcMillis(range.checkOut) - toUtcMillis(range.checkIn)) / DAY_MS);
}

/** Enumerate each night-start date of a stay, inclusive of checkIn, exclusive of checkOut. */
export function eachNight(range: StayRange): IsoDate[] {
  const total = nightsBetween(range);
  const nights: IsoDate[] = [];
  for (let index = 0; index < total; index += 1) {
    nights.push(addDays(range.checkIn, index));
  }
  return nights;
}

/** Half-open overlap test. Returns false for adjacent (back-to-back) stays. */
export function rangesOverlap(a: StayRange, b: StayRange): boolean {
  assertStayRange(a);
  assertStayRange(b);
  return toUtcMillis(a.checkIn) < toUtcMillis(b.checkOut) && toUtcMillis(b.checkIn) < toUtcMillis(a.checkOut);
}
