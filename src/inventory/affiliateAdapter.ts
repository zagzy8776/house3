/**
 * Affiliate redirect adapter.
 *
 * For partners we cannot (yet) take payment for - big OTAs, hotels on an
 * affiliate programme - we do NOT republish their inventory. We send the guest
 * to the partner's own checkout and earn the programme's commission. This is
 * how metasearch coexists with suppliers instead of fighting them, and it means
 * zero payment/chargeback liability on that inventory.
 */

import {
  assertAuthorized,
  type AdapterContext,
  type AuthorizationRecord,
  type InventorySnapshot,
  type PartnerInventoryAdapter,
  type UnitRecord
} from './types';

export type AffiliateOffer = {
  unit: UnitRecord;
  /** Deep link to the partner's own checkout for the requested stay. */
  deepLink: string;
  /** Commission the programme pays us, in basis points of the gross booking. */
  commissionBps: number;
};

export type AffiliateAdapterOptions = {
  authorization: AuthorizationRecord | null;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
};

export class AffiliateRedirectAdapter implements PartnerInventoryAdapter {
  readonly kind = 'AFFILIATE_PROGRAM' as const;
  readonly bookingModel = 'REDIRECT_TO_PARTNER' as const;
  /** Every snapshot from this channel is an authorised affiliate handoff. */
  readonly distribution = 'AFFILIATE' as const;
  readonly authorization: AuthorizationRecord | null;

  private readonly fetchImpl: typeof fetch;

  constructor(options: AffiliateAdapterOptions) {
    this.authorization = options.authorization;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Reads the programme's own feed/API. `config.feedUrl` must be the URL the
   * programme documented for publishers; `config.publisherId` identifies us.
   */
  async fetchSnapshot(context: AdapterContext): Promise<InventorySnapshot> {
    assertAuthorized(this.authorization, context.now);

    const feedUrl = context.config.feedUrl;
    if (!feedUrl) throw new Error('Affiliate adapter requires config.feedUrl from the programme');

    const response = await this.fetchImpl(feedUrl, {
      headers: context.config.apiKey ? { Authorization: `Bearer ${context.config.apiKey}` } : {}
    });
    if (!response.ok) {
      throw new Error(`Affiliate feed failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as { units?: UnitRecord[] };
    const units = (body.units ?? []).map((unit) => ({ ...unit, partnerId: context.partnerId }));

    // Affiliate inventory carries no calendar we can trust for instant booking;
    // the partner's own checkout decides availability.
    return {
      units,
      availability: [],
      fetchedAt: context.now,
      distribution: 'AFFILIATE'
    };
  }

  buildDeepLink(input: {
    baseUrl: string;
    unitExternalId: string;
    checkIn: string;
    checkOut: string;
    adults: number;
    publisherId: string;
  }): string {
    assertAuthorized(this.authorization);
    const url = new URL(input.baseUrl);
    url.searchParams.set('checkin', input.checkIn);
    url.searchParams.set('checkout', input.checkOut);
    url.searchParams.set('adults', String(input.adults));
    url.searchParams.set('aff', input.publisherId);
    url.searchParams.set('unit', input.unitExternalId);
    return url.toString();
  }
}
