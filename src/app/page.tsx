/**
 * Landing page — the Figma Make design, wired to real data.
 *
 * This is a server component that builds every number the design displays, then
 * hands them to `LandingPage` (client) which owns only interaction state. Three
 * things are computed rather than hardcoded:
 *
 *  1. `guestNightlyDisplay` per card — from `computeQuote()`, so the card price
 *     cannot drift from the checkout price.
 *  2. `cities[].count` — from the repository, with `countIsReal` telling the card
 *     to show "Opening soon" instead of inventing a number.
 *  3. `recentBooking` — from an actual confirmed booking. Absent means the hero
 *     shows the honest "pay the operator direct" card instead of fake activity.
 */

import { addDays } from '@/domain/dates';
import { formatNaira } from '@/domain/money';
import { computeQuote, resolveFeePolicy } from '@/domain/pricing';
import { allFeePolicies } from '@/data/feePolicies';
import { CITIES, HERO_STATS, LISTINGS, type MarketingListing } from '@/content/marketing';
import { getContainer } from '@/server/container';
import { LandingPage, type RecentBooking } from './components/marketing/LandingPage';
import type { ListingCardModel } from './components/marketing/ListingCard';

export const dynamic = 'force-dynamic';

/** A fixed quote date keeps server and client renders identical. */
const QUOTE_DATE = '2026-01-01';

const CITY_STATE: Record<string, string> = Object.fromEntries(CITIES.map((city) => [city.city, city.stateCode]));

function stateCodeForArea(area: string): string {
  for (const [city, code] of Object.entries(CITY_STATE)) {
    if (area.includes(city)) return code;
  }
  return 'LA';
}

export default async function Home() {
  const { repo } = getContainer();
  const policies = allFeePolicies();

  /**
   * Guest-facing per-night total: the operator's rate plus our disclosed fee and
   * the VAT on that fee. Cleaning is excluded so the figure is a true nightly
   * rate; the full including-cleaning total appears on the breakdown and at
   * checkout.
   */
  function guestNightly(listing: MarketingListing, stateCode: string): number {
    const policy = resolveFeePolicy(policies, { stateCode });
    const quote = computeQuote({
      stay: { checkIn: QUOTE_DATE, checkOut: addDays(QUOTE_DATE, 1) },
      nightlyRateKobo: listing.rate * 100,
      policy
    });
    return quote.totalKobo;
  }

  const listings: ListingCardModel[] = LISTINGS.map((listing) => {
    const stateCode = stateCodeForArea(listing.area);
    return {
      ...listing,
      guestNightlyDisplay: formatNaira(guestNightly(listing, stateCode), { decimals: false })
    };
  });

  const cities = CITIES.map((city) => {
    const realCount = repo.listUnits({ stateCode: city.stateCode, status: 'LISTED' }).length;
    return {
      city: city.city,
      stateCode: city.stateCode,
      count: realCount,
      image: city.image,
      countIsReal: realCount > 0
    };
  });

  const heroStats = HERO_STATS.map((stat) => ({ value: stat.value, label: stat.label }));

  /**
   * Real social proof only. A confirmed booking produces this line; no bookings
   * means the card falls back to a factual statement about how payment works.
   */
  const recentBooking: RecentBooking = (() => {
    for (const unit of repo.listUnits({})) {
      const confirmed = repo
        .listBookingsForUnit(unit.id)
        .find((booking) => booking.status === 'CONFIRMED' || booking.status === 'COMPLETED');
      if (!confirmed) continue;

      return {
        unitName: unit.name,
        area: unit.area,
        nights: confirmed.nights,
        whenLabel: 'Confirmed'
      };
    }
    return null;
  })();

  return (
    <LandingPage
      listings={listings}
      cities={cities}
      heroStats={heroStats}
      recentBooking={recentBooking}
    />
  );
}
