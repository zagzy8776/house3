/**
 * Search and pricing for DISCOVERY inventory.
 *
 * WHAT THIS FILE IS
 * -----------------
 * It answers two questions: "which places match this query?" and "what would this
 * place cost for these dates?". Both are things a guest needs in order to decide
 * whether to contact a property.
 *
 * WHAT THIS FILE NO LONGER IS
 * ---------------------------
 * It was `bookingService.ts`, and it also held `startCheckout`, `confirmPayment`,
 * `cancelExpiredHolds`, a hold on the calendar, ledger legs and a payment gateway
 * interface. House3 does not take bookings or payments, so that half was removed
 * rather than left dormant: a `startCheckout` that cannot be reached is still a
 * method that claims the platform books things.
 *
 * `quoteUnit` deliberately survives. A guest deciding whether to call a property needs
 * to know what a stay would cost, and a nightly rate multiplied by nights is arithmetic,
 * not a transaction. What it must NOT do is present the number as payable - see
 * `HANDOFF_DISCLOSURE` in `src/domain/contact.ts`, which is what the page says beside it.
 *
 * NO AVAILABILITY CLAIM IS MADE HERE. `search` does not filter on availability, because
 * House3 has no calendar for discovered places and cannot know whether a night is free.
 * Claiming otherwise would be the single most damaging thing this platform could do, so
 * the absence is deliberate and is not "not implemented yet".
 */

import type { PartnerProfile, ListedUnit, Repository } from './store';
import { computeQuote, type FeePolicy, type Quote } from '@/domain/pricing';
import { nightsBetween, type StayRange } from '@/domain/dates';
import { findPriceBand, inPriceBand, passesRadius } from '@/domain/geo';
import { TITLE_DOCUMENT_LABELS, type TitleDocument } from '@/domain/title';

/** Formats kobo for a human-facing rejection reason. */
function fmt(amountKobo: number): string {
  return `NGN ${(amountKobo / 100).toLocaleString('en-NG')}`;
}


export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchError';
  }
}

/** A place, ready to be shown to a guest. */
export type PlaceResult = {
  unit: ListedUnit;
  partner: PartnerProfile;
  /**
   * What these dates would cost at the advertised rate.
   *
   * Research, per `src/domain/provenance.ts`: an observed rate is quotable and is never
   * a payable price. Nothing in this module can turn it into one.
   */
  quote: Quote;
  /** Distance from the query centre, when a geo filter was applied. */
  distanceKm?: number;
};

export type SearchOutcome = {
  results: PlaceResult[];
  /** Places excluded, with the reason. Kept visible so a thin result set is explainable. */
  excluded: { unitId: string; unitName: string; reasons: string[] }[];
  nights: number;
};

export type SearchQuery = {
  stateCode: string;
  area?: string;
  stay: StayRange;
  guests: number;
  limit?: number;
  bedroomsMin?: number;
  titleDocuments?: readonly TitleDocument[];
  priceBandId?: string;
  near?: { center: { lat: number; lng: number }; radiusKm: number };
  sort?: 'total-asc' | 'total-desc' | 'distance';
};

export type PlaceSearch = {
  search(query: SearchQuery): SearchOutcome;
  quoteUnit(input: { unitId: string; stay: StayRange; guests: number }): PlaceResult;
};

export type PlaceSearchDeps = {
  repo: Repository;
  /** Reads the fee policy for a state. Left injectable so tests stay deterministic. */
  feePolicyFor: (stateCode: string, area: string | null) => FeePolicy;
};

/**
 * Build the discovery search service.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY IT IS NOT A GAP
 * ----------------------------------------------------
 * `bookingService.ts` filtered results through four things that no longer apply:
 *
 *   1. `checkAvailability` against a calendar. House3 has no calendar for a place
 *      discovered on someone else's site, so it cannot know whether a night is free.
 *      Filtering on it would mean inventing an answer.
 *   2. `activeHolds` from in-flight checkouts. There are no checkouts.
 *   3. `partnerBlockers` - settlement account and verification. Those gate whether
 *      House3 can PAY a partner, and House3 pays nobody.
 *   4. `computeSplits`, which divided a payment between us and the operator.
 *
 * Removing them is the point of this file, not an omission from it. What remains is
 * what a guest needs to choose a place: does it match, what would it cost, how far is
 * it, and where do I contact it.
 */
export function createPlaceSearch(deps: PlaceSearchDeps): PlaceSearch {
  const { repo } = deps;

  function buildQuote(
    unit: ListedUnit,
    partner: PartnerProfile,
    stay: StayRange,
    guests: number
  ): PlaceResult {
    const policy = deps.feePolicyFor(unit.stateCode, unit.area);
    const extraGuests = Math.max(0, guests - unit.includedGuests);

    // `computeQuote` still runs, because it is the arithmetic of a stay and the page
    // shows the guest a total before they call. What it computes is NOT presented as
    // payable: `HANDOFF_DISCLOSURE` says so beside it, and `assertBookable` in
    // `src/domain/provenance.ts` refuses to let this quote be treated as a price we
    // can charge. There is no `split` field because there is no split.
    const quote = computeQuote({
      stay,
      nightlyRateKobo: unit.nightlyRateKobo,
      policy,
      cleaningFeeKobo: unit.cleaningFeeKobo,
      extraGuests,
      extraGuestFeePerNightKobo: unit.extraGuestFeePerNightKobo
    });

    return { unit, partner, quote };
  }

  function search(query: SearchQuery): SearchOutcome {
    const nights = nightsBetween(query.stay);
    const results: PlaceResult[] = [];
    const excluded: SearchOutcome['excluded'] = [];

    const priceBand = query.priceBandId ? findPriceBand(query.priceBandId) : undefined;
    if (query.priceBandId && !priceBand) {
      throw new SearchError(`Unknown price band "${query.priceBandId}"`);
    }

    const candidates = repo.listUnits({
      stateCode: query.stateCode,
      area: query.area,
      status: 'LISTED'
    });

    for (const unit of candidates) {
      const partner = repo.getPartner(unit.partnerId);
      const reasons: string[] = [];

      if (!partner) reasons.push('Place has no registered operator');

      // Party size and stay length are properties of the PLACE, not of a transaction.
      // A guest needs to know a two-bedroom sleeps four before they call.
      if (unit.maxGuests < query.guests) {
        reasons.push(`Sleeps ${unit.maxGuests}, ${query.guests} requested`);
      }
      if (nights < unit.minNights) reasons.push(`Minimum stay is ${unit.minNights} nights`);
      if (nights > unit.maxNights) reasons.push(`Maximum stay is ${unit.maxNights} nights`);

      if (query.bedroomsMin && unit.bedrooms < query.bedroomsMin) {
        reasons.push(`${unit.bedrooms} bedroom(s), ${query.bedroomsMin} requested`);
      }
      if (query.titleDocuments?.length && !query.titleDocuments.includes(unit.titleDocument)) {
        reasons.push(`Title is ${TITLE_DOCUMENT_LABELS[unit.titleDocument]}`);
      }

      // Geo pre-filter: reject on the bounding box before any haversine runs, and
      // before we spend a quote on a place 40km away.
      let distanceKm: number | undefined;
      if (query.near) {
        const positioned = unit.latitude !== null && unit.longitude !== null;
        if (!positioned) {
          reasons.push('Location not yet surveyed');
        } else {
          const proximity = passesRadius(
            { lat: unit.latitude as number, lng: unit.longitude as number },
            { center: query.near.center, radiusKm: query.near.radiusKm }
          );
          if (!proximity.passes) {
            const away = Number.isFinite(proximity.distanceKm)
              ? `${proximity.distanceKm.toFixed(1)}km from the search centre`
              : 'outside the search area';
            reasons.push(away);
          } else {
            distanceKm = proximity.distanceKm;
          }
        }
      }

      if (reasons.length > 0 || !partner) {
        excluded.push({ unitId: unit.id, unitName: unit.name, reasons });
        continue;
      }

      const place = buildQuote(unit, partner, query.stay, query.guests);

      // Price band applies to the total the guest would pay THE OPERATOR, so it can
      // only be tested after quoting. Filtering on the nightly rate would hide cheaper
      // stays once the cleaning passthrough is counted.
      if (priceBand && !inPriceBand(place.quote.totalKobo, priceBand)) {
        excluded.push({
          unitId: unit.id,
          unitName: unit.name,
          reasons: [`${fmt(place.quote.totalKobo)} is outside ${priceBand.label}`]
        });
        continue;
      }

      results.push(distanceKm === undefined ? place : { ...place, distanceKm });
    }

    const sort = query.sort ?? 'total-asc';
    results.sort((a, b) => {
      if (sort === 'total-desc') return b.quote.totalKobo - a.quote.totalKobo;
      if (sort === 'distance') {
        return (
          (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY)
        );
      }
      return a.quote.totalKobo - b.quote.totalKobo;
    });

    return { results: query.limit ? results.slice(0, query.limit) : results, excluded, nights };
  }

  function quoteUnit(input: { unitId: string; stay: StayRange; guests: number }): PlaceResult {
    const unit = repo.getUnit(input.unitId);
    if (!unit) throw new SearchError(`Unknown place ${input.unitId}`);

    const partner = repo.getPartner(unit.partnerId);
    if (!partner) throw new SearchError(`Place ${input.unitId} has no registered operator`);

    const nights = nightsBetween(input.stay);
    if (nights < unit.minNights) throw new SearchError(`Minimum stay is ${unit.minNights} nights`);
    if (nights > unit.maxNights) throw new SearchError(`Maximum stay is ${unit.maxNights} nights`);
    if (input.guests > unit.maxGuests) {
      throw new SearchError(`Place sleeps ${unit.maxGuests} guests`);
    }

    return buildQuote(unit, partner, input.stay, input.guests);
  }

  return { search, quoteUnit };
}
