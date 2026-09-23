/**
 * iCal (RFC 5545) calendar adapter.
 *
 * Many small Nigerian shortlet operators already publish an .ics calendar from
 * their PMS (Smoobu, Beds24, Hostaway, Lodgify, Airbnb export). Subscribing to
 * that published feed is the lowest-friction, fully-consented way to get a live
 * calendar: the partner chooses to publish it and can revoke it at any time.
 *
 * Feed semantics: VEVENTs in a published calendar describe BLOCKED periods
 * (existing bookings, owner blocks). Nights not covered by any VEVENT are open.
 */

import { eachNight, toUtcMillis, type IsoDate, type StayRange } from '@/domain/dates';
import {
  assertAuthorized,
  type AdapterContext,
  type AuthorizationRecord,
  type AvailabilityRecord,
  type InventorySnapshot,
  type PartnerInventoryAdapter,
  type UnitRecord
} from './types';

export type IcalEvent = { uid: string; start: IsoDate; end: IsoDate; summary: string };

/**
 * Unfold folded lines (RFC 5545 allows CRLF followed by a space/tab to continue
 * a logical line) and normalise line endings.
 */
export function unfoldIcal(raw: string): string[] {
  const normalised = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const physical = normalised.split('\n');
  const logical: string[] = [];
  for (const line of physical) {
    const previous = logical[logical.length - 1];
    if ((line.startsWith(' ') || line.startsWith('\t')) && previous !== undefined) {
      logical[logical.length - 1] = `${previous}${line.slice(1)}`;
    } else {
      logical.push(line);
    }
  }
  return logical.filter((line) => line.length > 0);
}

/** Parse "20260701" or "20260701T140000Z" into a UTC-midnight IsoDate. */
export function parseIcalDate(value: string): IsoDate {
  const dateOnly = value.includes('T') ? value.slice(0, value.indexOf('T')) : value.replace(/Z$/, '');
  if (!/^\d{8}$/.test(dateOnly)) {
    throw new Error(`Unsupported iCal date value: "${value}" (expected YYYYMMDD or a DATE-TIME)`);
  }
  const iso = `${dateOnly.slice(0, 4)}-${dateOnly.slice(4, 6)}-${dateOnly.slice(6, 8)}`;
  // Round-trip through the date helpers so bogus dates like 20260230 are caught.
  toUtcMillis(iso);
  return iso;
}

export function parseIcalEvents(raw: string): IcalEvent[] {
  const lines = unfoldIcal(raw);
  const events: IcalEvent[] = [];

  let inEvent = false;
  let uid = '';
  let summary = '';
  let start: IsoDate | null = null;
  let end: IsoDate | null = null;

  const flush = (): void => {
    if (start && end && toUtcMillis(end) > toUtcMillis(start)) {
      events.push({ uid: uid || `event-${events.length + 1}`, start, end, summary });
    }
    inEvent = false;
    uid = '';
    summary = '';
    start = null;
    end = null;
  };

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      continue;
    }
    if (line === 'END:VEVENT') {
      flush();
      continue;
    }
    if (!inEvent) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const rawKey = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    // Strip parameters such as ";VALUE=DATE" or ";TZID=Africa/Lagos".
    const key = rawKey.split(';')[0]?.toUpperCase() ?? '';

    if (key === 'UID') uid = value;
    else if (key === 'SUMMARY') summary = value;
    else if (key === 'DTSTART') start = parseIcalDate(value);
    else if (key === 'DTEND') end = parseIcalDate(value);
  }

  return events;
}

/** Nights blocked by a set of events, deduplicated and sorted. */
export function blockedNightsFromEvents(events: readonly IcalEvent[]): IsoDate[] {
  const nights = new Set<IsoDate>();
  for (const event of events) {
    const range: StayRange = { checkIn: event.start, checkOut: event.end };
    for (const night of eachNight(range)) nights.add(night);
  }
  return [...nights].sort();
}

export type IcalUnitConfig = UnitRecord & { icalUrl: string };

export function parseUnitConfig(json: string | undefined, partnerId: string): IcalUnitConfig[] {
  if (!json) return [];
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('config.units must be a JSON array');
  return parsed.map((entry, index) => {
    const record = entry as Partial<IcalUnitConfig>;
    if (!record.externalId) throw new Error(`config.units[${index}] is missing externalId`);
    if (!record.icalUrl) throw new Error(`config.units[${index}] is missing icalUrl`);
    return {
      externalId: record.externalId,
      partnerId,
      name: record.name ?? record.externalId,
      unitType: record.unitType ?? 'APARTMENT',
      maxGuests: record.maxGuests ?? 2,
      bedrooms: record.bedrooms ?? 1,
      bathrooms: record.bathrooms ?? 1,
      nightlyRateKobo: record.nightlyRateKobo ?? 0,
      cleaningFeeKobo: record.cleaningFeeKobo ?? 0,
      minNights: record.minNights ?? 1,
      maxNights: record.maxNights ?? 30,
      icalUrl: record.icalUrl
    };
  });
}

export type IcalAdapterOptions = {
  authorization: AuthorizationRecord | null;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export class IcalFeedAdapter implements PartnerInventoryAdapter {
  readonly kind = 'ICAL_FEED' as const;
  readonly bookingModel = 'BOOK_AND_SETTLE' as const;
  readonly authorization: AuthorizationRecord | null;

  private readonly fetchImpl: typeof fetch;

  constructor(options: IcalAdapterOptions) {
    this.authorization = options.authorization;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Fetch the partner's published calendar and convert it into nightly states.
   * `config.units` is a JSON array of { externalId, icalUrl, rate fields } that
   * the partner supplies during onboarding.
   */
  async fetchSnapshot(context: AdapterContext): Promise<InventorySnapshot> {
    assertAuthorized(this.authorization, context.now);

    const origin = context.config.origin ?? '';
    const units = parseUnitConfig(context.config.units, context.partnerId);

    const availability: AvailabilityRecord[] = [];
    for (const unit of units) {
      if (origin && !unit.icalUrl.startsWith(origin)) {
        throw new Error(`iCal URL for ${unit.externalId} is outside the declared origin ${origin}`);
      }
      const response = await this.fetchImpl(unit.icalUrl);
      if (!response.ok) {
        throw new Error(`iCal fetch failed for ${unit.externalId}: HTTP ${response.status}`);
      }
      const icalText = await response.text();
      for (const night of blockedNightsFromEvents(parseIcalEvents(icalText))) {
        availability.push({
          unitExternalId: unit.externalId,
          night,
          state: 'CLOSED',
          nightlyRateKobo: null
        });
      }
    }

    const stripped: UnitRecord[] = units.map(({ icalUrl: _icalUrl, ...unit }) => unit);

    return { units: stripped, availability, fetchedAt: context.now };
  }
}
