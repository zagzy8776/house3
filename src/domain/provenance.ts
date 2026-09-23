/**
 * Where a rate came from, and when we saw it.
 *
 * "Detect which houses are listed and when, and how much they are" is a
 * reasonable thing to want. It splits into two very different products, and
 * keeping them apart is what this module is for.
 *
 *   RESEARCH  What operators are advertising, where, at what rate, and how that
 *             has moved. Sourced from the acquisition pipeline. Genuinely
 *             useful - it is how we choose who to call and what to say.
 *
 *   SALE      What a guest can actually pay, held as a rate the partner gave us
 *             and backed by a calendar and an agreement.
 *
 * The failure mode to design against is a listing card that shows the first
 * while looking like the second. A guest sees "₦180,000 / night", clicks, and
 * there is no calendar, no partner and no room - because that number was
 * observed on a portal three weeks ago and belongs to an operator who has never
 * heard of us. So the two are separate types here, and `assertBookable()` refuses
 * to let an observed rate be used as a payable price.
 *
 * NOT BUILT, DELIBERATELY: a view count.
 *
 * There is no honest way to measure how many people viewed someone else's
 * listing. That number lives in their own analytics and appears nowhere on the
 * page. We could infer something from search rank or from how often a listing
 * shows up, and then display it as "views" - and it would be invented. What we
 * can measure is presence, absence and advertised price, so that is what we
 * record and what this module will report.
 */

import type { Kobo } from './money';

/** Exactly two kinds of listing on this platform. Never blended. */
export type ListingProvenance =
  // A signed partner: we may sell it, so we may show a price.
  | 'PARTNER'
  // An operator we know exists. Research subject, not inventory.
  | 'PROSPECT';

export type PriceMovement = {
  on: string;
  previousKobo: Kobo;
  currentKobo: Kobo;
};

/** One listing as observed across crawls. Prospect-side research data. */
export type ObservedListing = {
  source: string;
  sourceUrl: string;
  sourceListingId: string;
  /** ISO dates. `firstSeenAt` is a floor: the listing predates our finding it. */
  firstSeenAt: string;
  lastSeenAt: string;
  /** As displayed by the operator. Kobo, like every other amount here. */
  advertisedPriceKobo: Kobo | null;
  currency: string;
  bedrooms: number | null;
  area: string | null;
  priceMovements: readonly PriceMovement[];
};

/**
 * A rate a guest can pay. Only ever constructed from partner inventory.
 */
export type BookableRate = {
  kind: 'PARTNER_RATE';
  nightlyKobo: Kobo;
  partnerId: string;
  unitExternalId: string;
  /** When the partner's own systems last confirmed this rate. */
  confirmedAt: string;
};

/**
 * A rate we saw somewhere else. Real, quotable in outreach, and never payable.
 */
export type ObservedRate = {
  kind: 'ADVERTISED_ELSEWHERE';
  nightlyKobo: Kobo;
  source: string;
  sourceUrl: string;
  observedAt: string;
};

export type DisplayableRate = BookableRate | ObservedRate;

export class UnbookableRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnbookableRateError';
  }
}

/**
 * Guard for anything that is about to be shown as a price a guest can pay.
 *
 * There is no code path that turns an advertised-elsewhere rate into a bookable
 * one - not a flag, not a config value, not an admin override. The only way to
 * sell at a price is to have the partner give us that price, which is the same
 * gate as `assertAuthorized()` for inventory.
 */
export function assertBookable(rate: DisplayableRate): BookableRate {
  if (rate.kind !== 'PARTNER_RATE') {
    throw new UnbookableRateError(
      `Rate of ${rate.nightlyKobo} kobo from "${rate.source}" is an advertised price observed on ` +
        "another site, not a price we can sell at. It can be shown as research, attributed to " +
        'its source, and never as a payable rate.'
    );
  }
  if (rate.nightlyKobo <= 0) {
    throw new UnbookableRateError(`Partner rate must be positive, got ${rate.nightlyKobo}.`);
  }
  return rate;
}

/** How long we have been watching a listing. Always at least this long. */
export function listingAgeDays(observed: Pick<ObservedListing, 'firstSeenAt'>, today: string): number {
  const first = Date.parse(observed.firstSeenAt);
  const now = Date.parse(today);
  if (Number.isNaN(first) || Number.isNaN(now)) {
    throw new UnbookableRateError(`Cannot compute listing age from "${observed.firstSeenAt}".`);
  }
  return Math.max(0, Math.round((now - first) / 86_400_000));
}

/**
 * A sentence for the outreach call, which is the only place a prospect's rate
 * belongs. Returns null rather than guessing when the history is too thin to
 * support a claim.
 */
export function priceMovementNote(
  observed: Pick<ObservedListing, 'priceMovements'>,
  options: { minimumPercent?: number } = {}
): string | null {
  const minimum = options.minimumPercent ?? 5;
  const movements = [...observed.priceMovements];
  if (movements.length === 0) return null;

  const last = movements[movements.length - 1];
  if (!last || last.previousKobo <= 0) return null;

  const percent = Math.round(((last.currentKobo - last.previousKobo) / last.previousKobo) * 100);

  // A rounding-level move is noise, and calling an operator about noise costs
  // us the credibility the call was for.
  if (Math.abs(percent) < minimum) return null;

  const direction = percent < 0 ? 'cut' : 'raised';
  const times = movements.length > 1 ? ` ${movements.length} times` : '';
  return `Advertised rate ${direction} ${Math.abs(percent)}%${times} since we began tracking.`;
}
