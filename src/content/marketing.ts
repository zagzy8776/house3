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
  badge: '1,354 spaces across 5 states',
  /** Illustrative: our inventory is single-digit until Lagos supply is onboarded. */
  badgeIllustrative: true,
  headlineFirst: 'Premium stays',
  headlineAccent: 'across Nigeria',
  subhead: 'Shortlets, serviced flats and penthouse suites — with an itemised receipt before you pay.'
} as const;

export const HERO_STATS: { value: string; label: string; illustrative: boolean }[] = [
  { value: '847', label: 'Lagos listings', illustrative: true },
  { value: '312', label: 'Abuja listings', illustrative: true },
  { value: '195', label: 'Other states', illustrative: true },
  // This one is true, and it is the whole pitch. Never make it illustrative.
  { value: '₦0', label: 'Hidden fees', illustrative: false }
];

export const FILTERS = ['All', 'Serviced Flat', 'Studio', 'Penthouse', 'Shortlet'] as const;

/**
 * Listing presentation data from the design.
 *
 * `rate` is the OPERATOR's nightly rate - the number the operator advertises.
 * The guest-facing total is computed by the pricing engine, never by
 * multiplying by a hardcoded factor.
 */
export type MarketingListing = {
  id: string;
  name: string;
  area: string;
  type: (typeof FILTERS)[number];
  beds: number;
  baths: number;
  rate: number;
  sqm: number;
  image: string;
  tags: string[];
  featured: boolean;
  /** Ratings were invented for the design. We have no reviews yet. */
  rating?: string;
  reviews?: number;
};

export const LISTINGS: MarketingListing[] = [
  {
    id: '1',
    name: 'The Lekki Residence',
    area: 'Lekki Phase 1, Lagos',
    type: 'Serviced Flat',
    beds: 2,
    baths: 2,
    rate: 150000,
    sqm: 110,
    image: 'https://images.unsplash.com/photo-1613977257363-707ba9348227?w=900&h=640&fit=crop&auto=format',
    tags: ['Pool', 'Gym', '24hr Power'],
    featured: true
  },
  {
    id: '2',
    name: 'VI Skyline Studio',
    area: 'Victoria Island, Lagos',
    type: 'Studio',
    beds: 1,
    baths: 1,
    rate: 90000,
    sqm: 52,
    image: 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=900&h=640&fit=crop&auto=format',
    tags: ['City View', 'Power', 'Wi-Fi'],
    featured: false
  },
  {
    id: '3',
    name: 'Maitama Penthouse',
    area: 'Maitama, Abuja',
    type: 'Penthouse',
    beds: 3,
    baths: 3,
    rate: 220000,
    sqm: 210,
    image: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=900&h=640&fit=crop&auto=format',
    tags: ['Terrace', 'Gym', 'Concierge'],
    featured: true
  },
  {
    id: '4',
    name: 'Bodija Garden Flat',
    area: 'Bodija, Ibadan',
    type: 'Shortlet',
    beds: 2,
    baths: 2,
    rate: 65000,
    sqm: 85,
    image: 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=900&h=640&fit=crop&auto=format',
    tags: ['Garden', 'Parking', 'Power'],
    featured: false
  },
  {
    id: '5',
    name: 'Uyo GRA Retreat',
    area: 'GRA, Uyo',
    type: 'Shortlet',
    beds: 2,
    baths: 2,
    rate: 75000,
    sqm: 95,
    image: 'https://images.unsplash.com/photo-1484154218962-a197022b5858?w=900&h=640&fit=crop&auto=format',
    tags: ['Quiet', 'Parking', 'Power'],
    featured: false
  },
  {
    id: '6',
    name: 'Asokoro Premium Suite',
    area: 'Asokoro, Abuja',
    type: 'Serviced Flat',
    beds: 1,
    baths: 1,
    rate: 95000,
    sqm: 68,
    image: 'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=900&h=640&fit=crop&auto=format',
    tags: ['Security', 'Pool', 'Power'],
    featured: false
  }
];

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
  listingsSub: 'All prices include fees — what you see is what you pay.',
  citiesHeadline: '5 states, growing',
  ctaHeadline: 'Book your stay tonight.',
  ctaBody: '1,354 verified spaces across Lagos, Abuja, Ibadan, Owerri and Uyo.',
  ctaIllustrative: true,
  ctaButton: 'Find a space'
} as const;

/**
 * Nav anchors, in order, as designed.
 *
 * The `#pricing` entry was removed along with the pricing section — an anchor to
 * a section that no longer exists is a dead link.
 */
export const NAV_LINKS = [
  { href: '#listings', label: 'Listings' },
  { href: '#cities', label: 'Cities' },
  // The operator directory - every shortlet we can see, whether or not we can
  // sell it yet. A real route rather than an anchor, since it is its own page.
  { href: '/places', label: 'Operators' }
] as const;

/** Search modal coverage line — matches the five launch states. */
export const SEARCH_COVERAGE = 'Lagos · Abuja · Ibadan · Owerri · Uyo';

/**
 * Which marketing claims are not yet backed by real data.
 *
 * Surfaced so the single `IS_ILLUSTRATIVE` flag can drive a visible disclosure
 * during pre-launch, or be flipped off once Lagos supply makes the numbers real.
 */
export const ILLUSTRATIVE_CLAIMS = [
  HERO.badgeIllustrative ? 'hero badge: "1,354 spaces across 5 states"' : null,
  ...HERO_STATS.filter((stat) => stat.illustrative).map((stat) => `hero stat: ${stat.value} ${stat.label}`),
  ...CITIES.filter((city) => city.illustrative).map((city) => `city count: ${city.city} ${city.count}`),
  SECTION_COPY.ctaIllustrative ? 'closing CTA: "1,354 verified spaces"' : null
].filter((entry): entry is string => entry !== null);
