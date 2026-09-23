/**
 * Partner API adapter (book-and-settle channel).
 *
 * Used with operators running a PMS or channel manager that exposes a REST API
 * (Smoobu, Beds24, Hostaway, Lodgify, Hotelrunner, ...). Requires API
 * credentials issued by the partner, so it is the strongest authorization basis
 * we support: the partner can revoke the key at any moment.
 *
 * Two directions matter:
 *   - fetchSnapshot   : read live rates + calendar
 *   - pushReservation : write the confirmed booking back so the partner's own
 *                       calendar blocks those nights (prevents double selling
 *                       through their direct channel)
 */

import type { IsoDate } from '@/domain/dates';
import {
  assertAuthorized,
  type AdapterContext,
  type AuthorizationRecord,
  type AvailabilityRecord,
  type InventorySnapshot,
  type PartnerInventoryAdapter,
  type UnitRecord
} from './types';

export type PartnerApiPayload = {
  units: {
    externalId: string;
    name: string;
    unitType: UnitRecord['unitType'];
    maxGuests: number;
    bedrooms: number;
    bathrooms: number;
    nightlyRateKobo: number;
    cleaningFeeKobo: number;
    minNights: number;
    maxNights: number;
    /** Nights explicitly closed by the partner. */
    closedNights: IsoDate[];
  }[];
};

export type ReservationPush = {
  unitExternalId: string;
  checkIn: IsoDate;
  checkOut: IsoDate;
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  adults: number;
  children: number;
  /** Human-visible reference the partner should see in their dashboard. */
  house3Reference: string;
  amountPaidKobo: number;
};

export type PartnerApiAdapterOptions = {
  authorization: AuthorizationRecord | null;
  fetchImpl?: typeof fetch;
  /** Path appended to config.baseUrl, e.g. "/api/v1/inventory". */
  inventoryPath?: string;
  /** Path appended to config.baseUrl for reservation writes. */
  reservationPath?: string;
};

export class PartnerApiAdapter implements PartnerInventoryAdapter {
  readonly kind = 'PARTNER_API' as const;
  readonly bookingModel = 'BOOK_AND_SETTLE' as const;
  readonly authorization: AuthorizationRecord | null;

  private readonly fetchImpl: typeof fetch;
  private readonly inventoryPath: string;
  private readonly reservationPath: string;

  constructor(options: PartnerApiAdapterOptions) {
    this.authorization = options.authorization;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.inventoryPath = options.inventoryPath ?? '/inventory';
    this.reservationPath = options.reservationPath ?? '/reservations';
  }

  async fetchSnapshot(context: AdapterContext): Promise<InventorySnapshot> {
    assertAuthorized(this.authorization, context.now);

    const baseUrl = context.config.baseUrl;
    const apiKey = context.config.apiKey;
    if (!baseUrl) throw new Error('Partner API adapter requires config.baseUrl');
    if (!apiKey) throw new Error('Partner API adapter requires config.apiKey');

    const response = await this.fetchImpl(`${trimSlash(baseUrl)}${this.inventoryPath}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
    });
    if (!response.ok) {
      throw new Error(`Partner inventory API failed: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as PartnerApiPayload;
    const units: UnitRecord[] = [];
    const availability: AvailabilityRecord[] = [];

    for (const unit of payload.units ?? []) {
      units.push({
        externalId: unit.externalId,
        partnerId: context.partnerId,
        name: unit.name,
        unitType: unit.unitType,
        maxGuests: unit.maxGuests,
        bedrooms: unit.bedrooms,
        bathrooms: unit.bathrooms,
        nightlyRateKobo: unit.nightlyRateKobo,
        cleaningFeeKobo: unit.cleaningFeeKobo,
        minNights: unit.minNights,
        maxNights: unit.maxNights
      });
      for (const night of unit.closedNights ?? []) {
        availability.push({
          unitExternalId: unit.externalId,
          night,
          state: 'CLOSED',
          nightlyRateKobo: null
        });
      }
    }

    return { units, availability, fetchedAt: context.now };
  }

  /** Write a confirmed House3 booking into the partner's system. */
  async pushReservation(context: AdapterContext, reservation: ReservationPush): Promise<{ partnerReservationId: string }> {
    assertAuthorized(this.authorization, context.now);

    const baseUrl = context.config.baseUrl ?? '';
    const apiKey = context.config.apiKey ?? '';

    const response = await this.fetchImpl(`${trimSlash(baseUrl)}${this.reservationPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Idempotency: retrying a webhook must not create a second reservation.
        'Idempotency-Key': reservation.house3Reference
      },
      body: JSON.stringify(reservation)
    });

    if (!response.ok) {
      throw new Error(`Partner reservation push failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { id?: string };
    return { partnerReservationId: body.id ?? reservation.house3Reference };
  }
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
