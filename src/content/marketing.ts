/**
 * Marketing content, ported verbatim from the Figma Make design.
 *
 * Everything here is DATA, not markup, so the landing page is a rendering of
 * this file. That matters for one specific reason: some of the numbers below are
 * ILLUSTRATIVE for the design and are not yet true. They are marked
 * `illustrative: true` so nothing fabricated can hide inside a component, and so
 * there is exactly one file to edit when real inventory replaces them.
 */

export const BRAND = {
  name: 'House3',
  tagline: 'Premium stays across Nigeria'
} as const;

export const HERO = {
  /**
   * Real. This is the whole pitch and it has never been illustrative.
   */
  badge: 'No booking fees — you deal with the operator',
  badgeIllustrative: false,
  headlineFirst: 'Premium stays',
  headlineAccent: 'across Nigeria',
  subhead: 'Shortlets, serviced flats and penthouse suites — see the operator’s own photographs and rates, then deal with them directly.'
} as const;

export const HERO_STATS: { value: string; label: string; illustrative: boolean }[] = [
  // ILLUSTRATIVE, AND THAT IS THE PROBLEM - see the note below before touching this.
  { value: '847', label: 'Lagos listings', illustrative: true },
  { value: '312', label: 'Abuja listings', illustrative: true },
  { value: '195', label: 'Other states', illustrative: true },
  // This one is true, and it is the whole pitch. Never make it illustrative.
  { value: '₦0', label: 'Booking fees', illustrative: false }
];

/*
 * THE INVENTED HERO NUMBERS MUST NOT RENDER.
 *
 * The three marked `illustrative: true` above are fabricated - the real crawl has
 * 260 Lagos places, not 847, and there is nothing in Abuja at all. `src/app/page.tsx`
 * must NOT pass them to `LandingPage`.
 *
 * They were being rendered anyway. `page.tsx` mapped `HERO_STATS` down to
 * `{ value, label }`, dropping the `illustrative` flag on the way, and the hero
 * printed "847 Lagos listings" and "312 Abuja listings" in large type as plain
 * facts - directly beside "₦0 Booking fees", which is true. A guest reading that
 * row has no way to tell which of the four statements were made up, and the honest
 * one lends credibility to the other three.
 *
 * An assertion in `tests/marketingClaims.test.ts` now fails if any `illustrative`
 * claim reaches a rendered surface, so this cannot quietly return.
 *
 * WHEN THESE CAN COME BACK: pass the real counts from `loadDirectory()`. The
 * homepage already counts places per state for the city cards, so the number is in
 * hand - the hero simply has to read it instead of a constant. That is the change
 * to make; editing the constants to match today's crawl would be a different lie
 * tomorrow.
 */

export const FILTERS = ['All', 'Serviced Flat', 'Studio', 'Penthouse', 'Shortlet'] as const;

/*
 * `ILLUSTRATIVE_LISTINGS` and the `MarketingListing` type that described it have
 * been DELETED.
 *
 * The array was six invented places - "The Lekki Residence", invented rates, and
 * Unsplash photographs of apartments with nothing to do with any Nigerian
 * shortlet. It used to be the landing page's inventory, which was the single most
 * misleading thing on the site: a guest saw a real-looking price for a place that
 * does not exist, on a page claiming every number is real. The homepage was moved
 * onto the published directory and nothing has imported this array since.
 *
 * It was kept as design scaffolding and the scaffolding is now doing harm. Its
 * shape carries `tags: ['Pool', 'Gym', '24hr Power']` - amenities the crawler does
 * not collect - so anyone working on the card against it would build a chip row
 * for fields that do not exist, and then wire it into the real card as though the
 * data were there. `ListingCard` has no `tags` field at all now, for exactly that
 * reason: the card renders the rate, the type, the name, the location, the spec
 * row and who published it, all of which are observed.
 *
 * If the card's layout needs exercising, build a model literal in a test. A test
 * fixture cannot be mistaken for inventory; a file in `content/` called
 * "marketing" with six realistic-looking listings absolutely can.
 *
 * `FILTERS` stays because it is referenced as a type elsewhere. It is the design's
 * vocabulary for property type, and the crawled inventory does not distribute
 * across it - a Lekki crawl returns mostly "short-let" - which is why the filter
 * chips were removed from the listings section rather than faked.
 */

export const SHOWCASE = [
  { image: 'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=1200&h=800&fit=crop&auto=format', label: 'Living rooms' },
  { image: 'https://images.unsplash.com/photo-1556020685-ae41abfc9365?w=1200&h=800&fit=crop&auto=format', label: 'Bedrooms' },
  { image: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=1200&h=800&fit=crop&auto=format', label: 'Kitchens' },
  { image: 'https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=1200&h=800&fit=crop&auto=format', label: 'Pools' }
];

export const CITIES: {
  city: string;
  stateCode: string;
  count: number;
  illustrative: boolean;
  image: string;
}[] = [
  {
    city: 'Lagos',
    stateCode: 'LA',
    count: 847,
    illustrative: true,
    image: 'https://images.unsplash.com/photo-1618220048045-10a6dbdf231e?w=600&h=700&fit=crop&auto=format'
  },
  {
    city: 'Abuja',
    stateCode: 'FC',
    count: 312,
    illustrative: true,
    image: 'https://images.unsplash.com/photo-1600585154526-990dced4db0d?w=600&h=700&fit=crop&auto=format'
  },
  {
    city: 'Ibadan',
    stateCode: 'OY',
    count: 93,
    illustrative: true,
    image: 'https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=600&h=700&fit=crop&auto=format'
  },
  {
    city: 'Owerri',
    stateCode: 'IM',
    count: 58,
    illustrative: true,
    image: 'https://images.unsplash.com/photo-1596178060810-72c7e926b7bd?w=600&h=700&fit=crop&auto=format'
  },
  {
    city: 'Uyo',
    stateCode: 'AK',
    count: 44,
    illustrative: true,
    image: 'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=600&h=700&fit=crop&auto=format'
  }
];

export const SECTION_COPY = {
  listingsHeadline: 'Available now',
  listingsSub: 'The operator’s own photographs and nightly rate. We do not add a fee — you deal with them directly.',
  citiesHeadline: 'Where we have coverage',
  ctaHeadline: 'Find your stay tonight.',
  /*
   * The CTA used to read "1,354 spaces across Lagos, Abuja, Ibadan, Owerri and
   * Uyo" - five invented counts, three of them for cities with no crawl at all.
   * An absolute number in a closing call to action is the worst place for one,
   * because it is the last thing a guest reads before deciding to trust the site.
   *
   * It is now a statement that cannot go stale: coverage grows, and the sentence
   * stays true. The real counts live in the hero and the city cards, both read
   * from the published directory.
   */
  ctaBody: 'Every place here was observed on a Nigerian listing, with the operator’s own rate. We take no booking and no payment.',
  ctaIllustrative: false,
  ctaButton: 'Find a space'
} as const;

/**
 * Nav anchors, in order, as designed.
 *
 * The `#pricing` entry was removed along with the pricing section — an anchor to
 * a section that no longer exists is a dead link.
 *
 * The `Operators` entry was removed with `/places`. That page was a separate
 * "operator directory" of contact-only rows, and it was the wrong shape for the
 * product: a guest does not want a table of operators to contact, they want the
 * place. Listings now open on their own page, at `/stay/:id`, with the gallery and
 * every observed detail - so the nav entry pointed at a redundant surface and the
 * page is gone.
 */
export const NAV_LINKS = [
  { href: '#listings', label: 'Listings' },
  { href: '#cities', label: 'Cities' }
] as const;

/** Search modal coverage line — matches the five launch states. */
export const SEARCH_COVERAGE = 'Lagos · Abuja · Ibadan · Owerri · Uyo';

/**
 * Which marketing claims are not yet backed by real data.
 *
 * Surfaced so the single `IS_ILLUSTRATIVE` flag can drive a visible disclosure
 * during pre-launch, or be flipped off once Lagos supply makes the numbers real.
 *
 * The listing grid is no longer on this list, because it is no longer a claim:
 * the homepage renders places the crawler actually observed. What remains here is
 * the marketing copy that still asserts coverage we have not measured.
 */
export const ILLUSTRATIVE_CLAIMS = [
  HERO.badgeIllustrative ? 'hero badge: "1,354 spaces across 5 states"' : null,
  ...HERO_STATS.filter((stat) => stat.illustrative).map((stat) => `hero stat: ${stat.value} ${stat.label}`),
  ...CITIES.filter((city) => city.illustrative).map((city) => `city count: ${city.city} ${city.count}`),
  SECTION_COPY.ctaIllustrative ? 'closing CTA: "1,354 spaces"' : null
].filter((entry): entry is string => entry !== null);
