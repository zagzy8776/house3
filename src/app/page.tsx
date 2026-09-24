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
import { CITIES, HERO_STATS } from '@/content/marketing';
import { loadDirectory } from '@/server/directorySource';
import { LandingPage, type RecentBooking } from './components/marketing/LandingPage';
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
    type: place.propertyType ? place.propertyType.toLowerCase().replace(/_/g, ' ') : 'shortlet',
    hasGallery: place.media.length > 1,
    photoCount: place.media.length,
    href: placeHref(place),
    // Facts only. The design's tags were amenities it invented ("Pool", "Gym"),
    // and the crawler does not read amenities - so the chip row carries the
    // source and the observation date, which are true.
    tags: [place.attribution, `seen ${place.lastSeenAt}`]
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

  const heroStats = HERO_STATS.map((stat) => ({ value: stat.value, label: stat.label }));

  /**
   * No social proof is available, and none is fabricated.
   *
   * This reads from an empty list rather than from a repository of demo bookings:
   * House3 takes no bookings, so no code path in this app can produce a confirmed
   * one. The hero shows the factual statement about how contact works instead.
   */
  const recentBooking: RecentBooking = null;

  return (
    <LandingPage
      listings={listings}
      cities={cities}
      heroStats={heroStats}
      recentBooking={recentBooking}
    />
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

