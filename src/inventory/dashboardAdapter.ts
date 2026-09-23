/**
 * Partner dashboard adapter.
 *
 * The fallback channel for operators with no PMS at all. The partner (or our
 * onboarding agent, working from a signed supply agreement) enters units, rates
 * and blackout dates through the House3 partner dashboard; this adapter reads
 * that data back out of our own database.
 *
 * The snapshot source is injected so the adapter stays unit-testable and free of
 * database imports.
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

export type DashboardSource = {
  listUnits(partnerId: string): Promise<UnitRecord[]>;
  listBlackouts(partnerId: string): Promise<{ unitExternalId: string; nights: IsoDate[] }[]>;
  listOpenRates(partnerId: string): Promise<{ unitExternalId: string; nightlyRateKobo: number; nights: IsoDate[] }[]>;
};

export class PartnerDashboardAdapter implements PartnerInventoryAdapter {
  readonly kind = 'PARTNER_DASHBOARD' as const;
  readonly bookingModel = 'BOOK_AND_SETTLE' as const;
  readonly authorization: AuthorizationRecord | null;

  private readonly source: DashboardSource;

  constructor(options: { authorization: AuthorizationRecord | null; source: DashboardSource }) {
    this.authorization = options.authorization;
    this.source = options.source;
  }

  async fetchSnapshot(context: AdapterContext): Promise<InventorySnapshot> {
    assertAuthorized(this.authorization, context.now);

    const units = await this.source.listUnits(context.partnerId);
    const availability: AvailabilityRecord[] = [];

    for (const blackout of await this.source.listBlackouts(context.partnerId)) {
      for (const night of blackout.nights) {
        availability.push({
          unitExternalId: blackout.unitExternalId,
          night,
          state: 'CLOSED',
          nightlyRateKobo: null
        });
      }
    }

    for (const openRate of await this.source.listOpenRates(context.partnerId)) {
      for (const night of openRate.nights) {
        availability.push({
          unitExternalId: openRate.unitExternalId,
          night,
          state: 'OPEN',
          nightlyRateKobo: openRate.nightlyRateKobo
        });
      }
    }

    return { units, availability, fetchedAt: context.now };
  }
}
