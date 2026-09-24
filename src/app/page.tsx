/**
 * Landing page — the Figma Make design, wired to real data.
 *
 * This is a server component that builds every number the design displays, then
 * hands them to `LandingPage` (client) which owns only interaction state.
 *
 * THE LISTINGS ARE REAL OBSERVATIONS NOW
 * --------------------------------------
 * The grid used to render `LISTINGS` from `src/content/marketing.ts`: six invented
 * places with invented rates and Unsplash photographs of apartments in no
 * particular country. A front page that shows "The Lekki Residence, ₦169,350"
 * for a property that does not exist cannot be reconciled with a platform whose
 * pitch is that its numbers are honest, so it now reads the acquisition
 * pipeline's published directory - `services/acquisition/directory.json`, written
 * by `python pipeline.py` - and renders the places a crawl actually observed:
 * the operator's own photographs, the rate they published, and a link to the
 * place's own page.
 *
 * If nothing has been crawled yet the section says so instead of falling back to
 * the invented grid. An empty grid is a true statement; a fabricated one is not.
 *
 * The other three computed values are unchanged: city counts come from the
 * repository so a city with no inventory shows "Opening soon" rather than a
 * fabricated number, and `recentBooking` is absent because there are no bookings
 * to report - House3 does not take any.
 */

import { findState } from '@/data/nigeria';
import { placeDescriptor, placeHref, placeLocation, type DirectoryPlace } from '@/domain/directory';
import { toWhatsappHref } from '@/domain/phone';
import { CITIES } from '@/content/marketing';
import { loadDirectory } from '@/server/directorySource';
import { LandingPage } from './components/marketing/LandingPage';
import type { ListingCardModel } from './components/marketing/ListingCard';

export const dynamic = 'force-dynamic';

/** How many places the front page shows. The design is a three-column grid. */
const HOMEPAGE_LISTINGS = 9;

/**
 * Turn observed places into cards, best-first.
 *
 * Ordering puts places with photographs and a readable rate at the front: those
 * are the rows a guest can act on. A place with neither is still real, but it is
 * a weaker advert for the platform and belongs further down the page. The sort is
 * stable, so within a band the crawl's own order - newest observation first - is
 * preserved.
 */
function toCard(place: DirectoryPlace): ListingCardModel {
  const stateName = findState(place.state ?? '')?.name ?? null;
  const location = placeLocation(place, stateName);

  return {
    id: place.id,
    name: placeDescriptor(place),
    area: location ?? 'Location not published',
    image: place.coverImageUrl,
    rateKobo: place.advertisedPriceKobo,
    bedrooms: place.bedrooms,
    bathrooms: place.bathrooms,
    type: place.propertyType ?? 'shortlet',
    photoCount: place.media.length,
    href: placeHref(place),
    phone: place.phone,
    whatsappHref: toWhatsappHref(place.phone),
    attribution: place.attribution,
    lastSeenAt: place.lastSeenAt
  };
}

export default async function Home() {
  const { places } = await loadDirectory();

  const listings: ListingCardModel[] = [...places]
    .sort((a, b) => score(b) - score(a))
    .slice(0, HOMEPAGE_LISTINGS)
    .map(toCard);

  /**
   * City counts, from the SAME published directory the listings grid reads.
   *
   * These used to come from `getContainer().repo`, which held eight demo units
   * while the grid beside it rendered crawled places - so the page could show nine
   * real Lagos listings next to a Lagos card reading "Opening soon". One source
   * for both, so they cannot disagree.
   */
  const cities = CITIES.map((city) => {
    const cityPlaces = places.filter((place) => place.state === city.stateCode);
    return {
      city: city.city,
      stateCode: city.stateCode,
      count: cityPlaces.length,
      image: city.image,
      countIsReal: cityPlaces.length > 0
    };
  });

  /**
   * The hero stats are REAL COUNTS from the directory.
   *
   * This used to be `HERO_STATS.map(...)`, which passed invented figures - "847
   * Lagos listings", "312 Abuja listings" - to the hero as plain facts, with the
   * `illustrative` flag dropped on the way so nothing downstream could tell. The
   * real directory holds 260 places in Lagos and none in Abuja, so those numbers
   * were false on the page that most needs to be believed.
   *
   * The counts per state are already computed below for the city cards, so the
   * hero reads the same source and the two cannot disagree.
   */
  const placesByState = new Map<string, number>();
  for (const place of places) {
    if (!place.state) continue;
    placesByState.set(place.state, (placesByState.get(place.state) ?? 0) + 1);
  }

  const heroStats = [
    { value: String(placesByState.get('LA') ?? 0), label: 'Lagos places' },
    { value: String(placesByState.get('FC') ?? 0), label: 'Abuja places' },
    {
      value: String(places.filter((place) => place.state && place.state !== 'LA' && place.state !== 'FC').length),
      label: 'Other states'
    },
    // This one is true, and it is the whole pitch.
    { value: '₦0', label: 'Booking fees' }
  ];

  return (
    <LandingPage listings={listings} cities={cities} heroStats={heroStats} />
  );
}

/** Photographs and a readable rate are what make a card actionable. */
function score(place: DirectoryPlace): number {
  let value = 0;
  if (place.coverImageUrl) value += 3;
  if (place.advertisedPriceKobo && place.advertisedPriceKobo > 0) value += 2;
  if (place.media.length > 1) value += 1;
  if (place.operatorName) value += 1;
  return value;
}

