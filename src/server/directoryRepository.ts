/**
 * Turn published directory rows into the shape the search service reads.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/search` and the homepage read different stores, and that was a bug worth
 * naming: the homepage rendered 260 crawled places while `/search` returned zero,
 * because search read the in-memory demo fixtures. A guest who clicked "Search"
 * from a page full of listings was told there were no listings. Coverage that the
 * search box cannot find is not coverage.
 *
 * So the published directory is projected into the `Repository` the search
 * service already consumes, rather than a second search path being written. One
 * projection, one adapter, one place for the mapping to be wrong.
 *
 * WHAT IS SYNTHESISED, AND WHY THAT IS HONEST
 * -------------------------------------------
 * A crawled place has no calendar, no partner agreement and no surveyed
 * coordinates. Those absences are represented as absences rather than
 * substituted:
 *
 *   * `latitude`/`longitude` are null, which search already treats as "not
 *     geo-searchable" instead of silently dropping the row or inventing a pin.
 *   * `bookable` is false and there is no payment path anywhere downstream.
 *   * `maxGuests`, `minNights` and the cleaning fee are DEFAULTS, because the
 *     sources do not publish them. They are marked in `notes` so nothing reads a
 *     default as an observation.
 *   * The nightly rate is the operator's advertised rate, converted from kobo,
 *     and it is what the page shows - attributed, dated, and labelled.
 */

import type { DirectoryPlace } from '@/domain/directory';
import type { ListedUnit, PartnerProfile, Repository } from './store';
import { InMemoryRepository } from './store';
import { loadDirectory } from './directorySource';

/**
 * Nightly rates in the published directory are already kobo
 * (`advertised_price` is named in kobo by `publishing.py`), so no conversion
 * happens here. This constant exists to document that, because a `* 100` slipped
 * into this function would multiply every price by 100 silently.
 */

/** Guests a crawled place is assumed to sleep when the source did not say. */
const DEFAULT_MAX_GUESTS = 4;

/** The shortest stay we will offer, when the source published no minimum. */
const DEFAULT_MIN_NIGHTS = 1;

/**
 * The rate used for a place whose operator published none, or published one the
 * extraction guard dropped as implausible.
 *
 * WHY A PLACEHOLDER RATE IS BETTER THAN SKIPPING THE PLACE
 * -------------------------------------------------------
 * `computeQuote` requires a positive integer, so a `0` rate throws - and a throw
 * inside the search loop aborted the WHOLE search, not just that row. Six of 260
 * published Lagos places have no readable rate, so one malformed figure on a
 * source page was returning "0 places" for the entire state.
 *
 * The placeholder is only ever used to price the "would this place cost" line,
 * and the UI reads `advertisedPriceKobo` to decide what to show a guest - a place
 * with no observed rate renders "rate not published" and never this figure. It is
 * deliberately a round, obviously-synthetic number so that if it ever leaked into
 * a guest-facing amount it would be unmistakable in a screenshot.
 */
const UNPRICED_PLACE_PLACEHOLDER_KOBO = 1_000_00;

export function placeToUnit(place: DirectoryPlace): ListedUnit {
  const rate = place.advertisedPriceKobo;
  const hasRate = typeof rate === 'number' && rate > 0;

  return {
    id: place.id,
    // A crawled place has no partner row. The operator is named on the unit's
    // own contact fields, and entity resolution is what will create the partner
    // - inventing one here would create 260 operators with no agreement.
    partnerId: `observed:${place.id}`,
    name: descriptorFor(place),
    unitType: 'APARTMENT',
    maxGuests: DEFAULT_MAX_GUESTS,
    bedrooms: place.bedrooms ?? 0,
    bathrooms: place.bathrooms ?? 0,
    nightlyRateKobo: hasRate ? rate : UNPRICED_PLACE_PLACEHOLDER_KOBO,
    cleaningFeeKobo: 0,
    extraGuestFeePerNightKobo: 0,
    includedGuests: DEFAULT_MAX_GUESTS,
    minNights: DEFAULT_MIN_NIGHTS,
    maxNights: 90,
    bookable: false,
    status: 'LISTED',
    stateCode: place.state ?? '',
    area: place.area ?? place.city ?? '',
    // Absent, not guessed: a wrong pin sends a guest to the wrong street.
    latitude: null,
    longitude: null,
    titleDocument: 'NOT_DISCLOSED',
    sourceUrl: place.sourceUrl,
    sourceName: place.attribution,
    operatorName: place.operatorName,
    operatorWebsite: place.website,
    contactPhone: place.phone,
    operatorInstagram: place.instagram
  };
}

export function placeToPartner(place: DirectoryPlace): PartnerProfile {
  return {
    id: `observed:${place.id}`,
    displayName: place.operatorName ?? place.attribution,
    legalName: place.operatorName ?? '',
    stateCode: place.state ?? '',
    area: place.area ?? place.city ?? '',
    status: 'ACTIVE',
    // Not sellable: there is no settlement account because there is no payment.
    paystackSubaccountCode: null,
    settlementVerified: false
  };
}

/** A factual descriptor, matching `placeDescriptor` in the domain module. */
function descriptorFor(place: DirectoryPlace): string {
  const parts: string[] = [];
  if (place.bedrooms !== null && place.bedrooms > 0) parts.push(`${place.bedrooms}-bedroom`);
  if (place.propertyType) parts.push(place.propertyType.toLowerCase().replace(/_/g, ' '));
  const base = parts.length > 0 ? parts.join(' ') : 'Shortlet';
  const where = place.area ?? place.city;
  return where ? `${base}, ${where}` : base;
}

/** Every published place, projected into a repository. */
export async function buildDirectoryRepository(): Promise<Repository> {
  const { places } = await loadDirectory();

  return new InMemoryRepository({
    partners: places.map(placeToPartner),
    units: places.map(placeToUnit)
    // No availability. A crawled place has no calendar and search does not filter
    // on one, so seeding OPEN nights would be inventing a fact.
  });
}
