/**
 * Inventory ingestion.
 *
 * House3 only lists inventory it is *authorised* to sell. This file is the
 * enforcement point: every adapter must declare how it obtained the right to
 * use the data, and the runtime refuses to read from an adapter whose declared
 * basis is missing or stale.
 *
 * There is deliberately NO scraping adapter. A "read the partner's public
 * website and republish it" channel is not an inventory source: it breaks the
 * partner's terms of service, it republishes their copyrighted photography, and
 * it cannot produce a live calendar - so it cannot tell us whether the room is
 * actually free today. Every supported channel below can.
 */

import type { IsoDate } from '@/domain/dates';

export type InventoryChannelKind =
  | 'PARTNER_API' // partner runs a PMS/channel manager and gave us API credentials
  | 'ICAL_FEED' // partner published a calendar URL for us to subscribe to
  | 'PARTNER_DASHBOARD' // partner typed/uploaded their own units and rates
  | 'AFFILIATE_PROGRAM'; // partner's own affiliate programme (we redirect, they settle)

export type AuthorizationBasis =
  | 'SIGNED_SUPPLY_AGREEMENT'
  | 'API_CREDENTIALS_ISSUED'
  | 'PARTNER_PUBLISHED_FEED'
  | 'AFFILIATE_PROGRAM_TERMS';

export type AuthorizationRecord = {
  kind: InventoryChannelKind;
  basis: AuthorizationBasis;
  /** Human-readable reference: contract id, affiliate publisher id, feed owner. */
  reference: string;
  /** ISO timestamp. */
  grantedAt: string;
  /** ISO timestamp, or null for open-ended. */
  expiresAt: string | null;
  /** Which partner granted it. */
  partnerId: string;
};

export class UnauthorizedInventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedInventoryError';
  }
}

const REQUIRED_BASIS: Record<InventoryChannelKind, readonly AuthorizationBasis[]> = {
  PARTNER_API: ['SIGNED_SUPPLY_AGREEMENT', 'API_CREDENTIALS_ISSUED'],
  ICAL_FEED: ['PARTNER_PUBLISHED_FEED', 'SIGNED_SUPPLY_AGREEMENT'],
  PARTNER_DASHBOARD: ['SIGNED_SUPPLY_AGREEMENT', 'PARTNER_PUBLISHED_FEED'],
  AFFILIATE_PROGRAM: ['AFFILIATE_PROGRAM_TERMS']
};

/**
 * Guard called at the top of every adapter fetch. Throws rather than logging,
 * because a silent failure here is how platforms end up serving stolen data.
 */
export function assertAuthorized(
  authorization: AuthorizationRecord | null | undefined,
  now: string = new Date().toISOString()
): AuthorizationRecord {
  if (!authorization) {
    throw new UnauthorizedInventoryError(
      'Adapter has no authorization record. Write access to a partner calendar ' +
        'requires a signed supply agreement, issued API credentials, a partner-published ' +
        'feed, or affiliate programme acceptance.'
    );
  }
  const allowed = REQUIRED_BASIS[authorization.kind];
  if (!allowed.includes(authorization.basis)) {
    throw new UnauthorizedInventoryError(
      `Authorization basis "${authorization.basis}" is not valid for channel "${authorization.kind}". ` +
        `Expected one of: ${allowed.join(', ')}`
    );
  }
  if (authorization.expiresAt && new Date(authorization.expiresAt).getTime() <= new Date(now).getTime()) {
    throw new UnauthorizedInventoryError(
      `Authorization "${authorization.reference}" expired at ${authorization.expiresAt}`
    );
  }
  if (!authorization.reference.trim()) {
    throw new UnauthorizedInventoryError('Authorization must carry a contract/agreement reference');
  }
  return authorization;
}

export type UnitRecord = {
  externalId: string;
  partnerId: string;
  name: string;
  unitType: 'APARTMENT' | 'STUDIO' | 'ROOM' | 'HOSTEL_BED' | 'VILLA';
  maxGuests: number;
  bedrooms: number;
  bathrooms: number;
  /** Nightly rate published by the partner, in kobo. We never alter this. */
  nightlyRateKobo: number;
  cleaningFeeKobo: number;
  minNights: number;
  maxNights: number;
};

export type AvailabilityRecord = {
  unitExternalId: string;
  night: IsoDate;
  state: 'OPEN' | 'CLOSED' | 'ON_REQUEST';
  nightlyRateKobo: number | null;
};

export type InventorySnapshot = {
  units: UnitRecord[];
  availability: AvailabilityRecord[];
  /** When the adapter produced this snapshot. */
  fetchedAt: string;
  /**
   * Present only when the whole snapshot is an authorised affiliate handoff.
   * Bookable adapters omit it: their units are not directory/affiliate rows.
   */
  distribution?: 'AFFILIATE';
};

export type AdapterContext = {
  partnerId: string;
  /** Opaque per-partner configuration (API key ref, iCal URL, etc). */
  config: Record<string, string>;
  now: string;
};

export interface PartnerInventoryAdapter {
  readonly kind: InventoryChannelKind;
  /**
   * Whether this channel can produce a bookable rate+calendar, or whether it
   * only redirects the guest to the partner to complete checkout.
   */
  readonly bookingModel: 'BOOK_AND_SETTLE' | 'REDIRECT_TO_PARTNER';
  /**
   * Present only on adapters whose snapshots are authorised affiliate handoffs.
   * Bookable adapters omit it: their units are not directory/affiliate rows.
   */
  readonly distribution?: 'AFFILIATE';
  readonly authorization: AuthorizationRecord | null;
  fetchSnapshot(context: AdapterContext): Promise<InventorySnapshot>;
}

/** Thrown when a caller asks for a channel that this platform does not support. */
export class UnsupportedChannelError extends Error {
  constructor(public readonly requested: string) {
    super(
      `Inventory channel "${requested}" is not supported. House3 ingests partners via ` +
        'PARTNER_API, ICAL_FEED, PARTNER_DASHBOARD or AFFILIATE_PROGRAM only.'
    );
    this.name = 'UnsupportedChannelError';
  }
}
