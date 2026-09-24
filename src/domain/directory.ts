/**
 * The operator directory.
 *
 * This is the surface for places we know about but cannot sell: crawled from a
 * portal, with no agreement, no calendar and no settlement account. It is how
 * the site carries real, useful coverage in a state before a single partner has
 * signed there.
 *
 * FACTS, WITH ATTRIBUTION
 *
 * A directory is legal. Facts about a business - its name, its address, its
 * phone number, the prices it publishes - are not owned by anyone. We observed
 * a 3-bedroom in Ikeja advertised at 220,000 a night; that is a thing that
 * happened, and we can say so, as long as we say where we saw it. So every row
 * here carries `attribution` and links back to `sourceUrl`, and
 * `assertPublishable()` refuses to let a row through without them.
 *
 * MEDIA IS CARRIED, ATTRIBUTED
 *
 * A row also carries the photographs its listing published, as `media` and
 * `coverImageUrl`. An earlier revision of this file declared `media: null` on
 * every row as a deliberate refusal; that refusal has been lifted by product
 * decision, and the record of the reversal lives in
 * `services/acquisition/compliance/allowed_fields.py`. What did NOT change is
 * attribution: every row still names its source, and an image the source did not
 * publish is never substituted in.
 *
 * PROSE IS STILL NOT PUBLISHED. `description` and the title fields stay in
 * `FORBIDDEN_PUBLIC_KEYS`: we display a listing's gallery, we do not republish
 * its written description.
 *
 * WHY THIS IS NOT PART OF /search
 *
 * A directory row has no calendar. Rendering it as a bookable unit would mean
 * the guest sees a price, clicks, and there is nothing to confirm - and it would
 * put an unverified rate into the same list as partner rates that are backed by
 * an agreement. Those two must never share a type, so they do not share a page.
 * Every place row offers a route to the operator, and a route to the bookable
 * inventory we do have in that area.
 *
 * THERE ARE TWO DIRECTORY DISTRIBUTIONS, AND NO PATH BETWEEN THEM
 *
 * `DIRECTORY` is observed coverage: a crawl saw a real place and a real contact
 * channel. It may never carry an affiliate route, because discovering a
 * `booking_url` on a public page is not affiliate authorization.
 *
 * `AFFILIATE` is an authorised handoff: the partner (or programme) supplied the
 * destination, a partner name and a disclosure, and the row must route through
 * `AFFILIATE_URL`. A crawler cannot self-promote into this state.
 */

export type ListingDistribution = 'DIRECTORY' | 'AFFILIATE';

export type ContactRouteKind = 'AFFILIATE_URL' | 'PHONE' | 'WEBSITE' | 'EMAIL' | 'NONE';

export type ContactRoute = {
  kind: ContactRouteKind;
  /** Null only when kind is NONE. */
  href: string | null;
};

export type AffiliateHandoff = {
  partnerName: string;
  /** The partner-supplied destination. Guests leave House3 to complete checkout. */
  destinationUrl: string;
  /** Human-readable disclosure shown beside the handoff button. */
  disclosure: string;
};

export type DirectoryPlace = {
  id: string;
  /** DIRECTORY is observed coverage; AFFILIATE is an authorised partner handoff. */
  distribution: ListingDistribution;
  operatorName: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  instagram: string | null;
  pmsDetected: string | null;
  propertyType: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  state: string | null;
  city: string | null;
  area: string | null;
  /** Kobo, exactly as the operator advertised it. Never a price we can charge. */
  advertisedPriceKobo: number | null;
  currency: string | null;
  source: string;
  sourceUrl: string;
  attribution: string;
  firstSeenAt: string;
  lastSeenAt: string;
  contactRoute: ContactRoute;
  affiliate: AffiliateHandoff | null;
  /**
   * The listing's own photographs, absolute URLs, as the source published them.
   *
   * An empty array means the listing published no images, which the UI renders as
   * a designed placeholder - not as a broken image and not as somebody else's
   * stock photograph. Showing a stock photo of a different apartment could not be
   * honest; this is the gallery of the place the guest is about to call.
   */
  media: string[];
  /** The first of `media`, promoted so a card needn't index the array. */
  coverImageUrl: string | null;
};

/**
 * Never acceptable on a public row, whatever else changes.
 *
 * The media entries that used to live here - `photo`, `photos`, `image`,
 * `images`, `gallery` - have been removed: this platform now carries a listing's
 * gallery, under the names `media` and `coverImageUrl`, so refusing the older
 * aliases would reject the very rows the pipeline now produces.
 *
 * PROSE STAYS FORBIDDEN. `description` is the one that matters: an operator's
 * written listing copy is somebody's writing, and we display their photographs
 * without republishing their prose. `property_name` is the same argument at
 * field level - a marketing title is copy, not a fact.
 */
const FORBIDDEN_PUBLIC_KEYS = [
  'description',
  'body_text',
  'summary',
  'property_name',
  'propertyName',
  'title_document',
  'titleDocument',
  // Crawl-only signals. A discovered booking/availability URL is not an
  // authorised handoff, so it must never reach the public projection.
  // `availability_hint_url` is the quarantined name for a link that was observed
  // but never validated as a calendar endpoint - it is even less publishable.
  'booking_url',
  'availability_url',
  'availability_hint_url'
] as const;

export class UnpublishablePlaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnpublishablePlaceError';
  }
}


/** The raw JSONL/JSON shape, before validation. Snake_case on the wire. */
export type RawDirectoryPlace = {
  id?: unknown;
  operator_name?: unknown;
  phone?: unknown;
  email?: unknown;
  website?: unknown;
  instagram?: unknown;
  pms_detected?: unknown;
  property_type?: unknown;
  bedrooms?: unknown;
  bathrooms?: unknown;
  state?: unknown;
  city?: unknown;
  area?: unknown;
  advertised_price?: unknown;
  currency?: unknown;
  source?: unknown;
  source_url?: unknown;
  attribution?: unknown;
  first_seen_at?: unknown;
  last_seen_at?: unknown;
  distribution?: unknown;
  affiliate_partner?: unknown;
  affiliate_url?: unknown;
  affiliate_disclosure?: unknown;
  contact_route?: unknown;
  media?: unknown;
  [key: string]: unknown;
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * The listing's gallery, as absolute http(s) URLs.
 *
 * Parsed defensively and never thrown on: a malformed image URL blanks that one
 * image rather than rejecting the whole place. A place is worth publishing for
 * its name, area and rate alone - refusing the row because one of forty image
 * URLs was malformed would lose a real property over a cosmetic field.
 *
 * Non-http entries are dropped rather than passed through: `javascript:` and
 * `data:` URLs in a `src` are an injection route, and a gallery is the last place
 * to accept one.
 */
function mediaUrls(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [];
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const candidate = text(entry);
    if (!candidate || seen.has(candidate)) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      seen.add(candidate);
      urls.push(candidate);
    } catch {
      continue;
    }
  }

  return urls;
}

/**
 * Validate and convert one row.
 *
 * Fails loudly. A row that cannot be validated is a row we do not know how to
 * attribute, and publishing it anyway is the one mistake here that cannot be
 * taken back - a page that went live with someone's photograph on it has already
 * been viewed, cached and screenshotted by the time anyone notices.
 */
export function assertPublishable(row: RawDirectoryPlace, now?: string): DirectoryPlace {
  const id = text(row.id);
  const source = text(row.source);
  const sourceUrl = text(row.source_url);
  const attribution = text(row.attribution);

  if (!id) throw new UnpublishablePlaceError('Place row has no id.');
  if (!source) throw new UnpublishablePlaceError(`Place "${id}" names no source.`);
  if (!sourceUrl) {
    throw new UnpublishablePlaceError(`Place "${id}" has no source URL to link back to.`);
  }
  if (!attribution) {
    // Attribution is the whole basis for publishing a fact about someone else's
    // business. Without it the row is unattributed, which is a different and
    // worse thing than a directory entry.
    throw new UnpublishablePlaceError(`Place "${id}" has no attribution.`);
  }

  for (const key of FORBIDDEN_PUBLIC_KEYS) {
    if (row[key] !== undefined && row[key] !== null) {
      throw new UnpublishablePlaceError(
        `Place "${id}" carries non-publishable field "${key}". A directory publishes ` +
          'facts and the gallery a listing published - never its written copy.'
      );
    }
  }

  const distributionValue = text(row.distribution) ?? 'DIRECTORY';
  if (!['DIRECTORY', 'AFFILIATE'].includes(distributionValue)) {
    throw new UnpublishablePlaceError(
      `Place "${id}" has unknown distribution "${distributionValue}".`
    );
  }
  const distribution = distributionValue as ListingDistribution;

  const affiliatePartner = text(row.affiliate_partner);
  const affiliateUrl = text(row.affiliate_url);
  const affiliateDisclosure = text(row.affiliate_disclosure);
  if (distribution === 'AFFILIATE') {
    if (!affiliatePartner || !affiliateUrl || !affiliateDisclosure) {
      throw new UnpublishablePlaceError(
        `Affiliate place "${id}" needs a partner, destination URL and disclosure.`
      );
    }
    let destination: URL;
    try {
      destination = new URL(affiliateUrl);
    } catch {
      throw new UnpublishablePlaceError(`Affiliate place "${id}" has an invalid destination URL.`);
    }
    if (destination.protocol !== 'http:' && destination.protocol !== 'https:') {
      throw new UnpublishablePlaceError(`Affiliate place "${id}" has an invalid destination URL.`);
    }
  } else if (affiliatePartner || affiliateUrl || affiliateDisclosure) {
    throw new UnpublishablePlaceError(
      `Directory place "${id}" carries affiliate fields without an authorised affiliate distribution.`
    );
  }

  const rawRoute = row.contact_route as Record<string, unknown> | null | undefined;
  const kind = text(rawRoute?.kind) ?? 'NONE';
  if (!['AFFILIATE_URL', 'PHONE', 'WEBSITE', 'EMAIL', 'NONE'].includes(kind)) {
    throw new UnpublishablePlaceError(`Place "${id}" has unknown contact route "${kind}".`);
  }
  if (distribution === 'AFFILIATE' && kind !== 'AFFILIATE_URL') {
    throw new UnpublishablePlaceError(`Affiliate place "${id}" must use an affiliate route.`);
  }
  if (distribution === 'DIRECTORY' && kind === 'AFFILIATE_URL') {
    throw new UnpublishablePlaceError(`Directory place "${id}" cannot use an affiliate route.`);
  }
  const href = text(rawRoute?.href);
  if (kind !== 'NONE' && !href) {
    throw new UnpublishablePlaceError(`Place "${id}" declares contact route ${kind} with no href.`);
  }

  const verifiedNow = now ?? new Date().toISOString();

  // The cover is the first parsed image, computed rather than trusted from the
  // row. A pipeline that promoted a cover the gallery does not contain would
  // otherwise put an image on a card that the gallery then fails to show.
  const media = mediaUrls(row.media);
  const coverImageUrl = media[0] ?? null;

  return {
    id,
    distribution,
    operatorName: text(row.operator_name),
    phone: text(row.phone),
    email: text(row.email),
    website: text(row.website),
    instagram: text(row.instagram),
    pmsDetected: text(row.pms_detected),
    propertyType: text(row.property_type),
    bedrooms: int(row.bedrooms),
    bathrooms: int(row.bathrooms),
    state: text(row.state),
    city: text(row.city),
    area: text(row.area),
    advertisedPriceKobo: int(row.advertised_price),
    currency: text(row.currency),
    source,
    sourceUrl,
    attribution,
    firstSeenAt: text(row.first_seen_at) ?? verifiedNow.slice(0, 10),
    lastSeenAt: text(row.last_seen_at) ?? verifiedNow.slice(0, 10),
    contactRoute: { kind: kind as ContactRouteKind, href },
    affiliate:
      distribution === 'AFFILIATE'
        ? {
            partnerName: affiliatePartner as string,
            destinationUrl: affiliateUrl as string,
            disclosure: affiliateDisclosure as string
          }
        : null,
    media,
    coverImageUrl
  };
}


// ---------------------------------------------------------------------------
// display
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<string, string> = {
  SHORTLET: 'short-let',
  SHORT_LET: 'short-let',
  APARTMENT: 'apartment',
  FLAT: 'flat',
  SERVICED_APARTMENT: 'serviced apartment',
  DUPLEX: 'duplex',
  BUNGALOW: 'bungalow',
  HOUSE: 'house',
  VILLA: 'villa',
  STUDIO: 'studio',
  HOSTEL_BED: 'hostel bed'
};

function typeLabel(propertyType: string | null): string | null {
  if (!propertyType) return null;
  return TYPE_LABELS[propertyType.toUpperCase()] ?? propertyType.toLowerCase().replace(/_/g, ' ');
}

/**
 * A descriptor built from facts: "3-bedroom short-let".
 *
 * Derived rather than copied. The operator's own listing title is their
 * marketing copy - "Luxury 3 Bedrooms Flats with City View" - and a guest gets
 * more from the numbers anyway.
 */
export function placeDescriptor(place: Pick<DirectoryPlace, 'bedrooms' | 'propertyType'>): string {
  const kind = typeLabel(place.propertyType) ?? 'short-let';
  if (place.bedrooms === null) return kind.charAt(0).toUpperCase() + kind.slice(1);
  return `${place.bedrooms}-bedroom ${kind}`.replace(/^(\w)/, (first) => first.toUpperCase());
}

/**
 * "Ikeja, Lagos". Most specific first, skipping anything we do not have, and
 * de-duplicating - area and city are often the same word, and "Lekki, Lekki"
 * reads like a bug.
 *
 * `stateName` is passed in rather than looked up here: this module stays free of
 * the state table so it can be tested with plain strings.
 */
export function placeLocation(
  place: Pick<DirectoryPlace, 'area' | 'city' | 'state'>,
  stateName?: string | null
): string {
  const parts = [place.area, place.city ?? stateName ?? null, stateName ?? place.state]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));

  return parts.filter((part, index) => parts.indexOf(part) === index).join(', ');
}

/**
 * The operator's advertised rate, formatted, or null when they did not publish
 * one. Named "advertised" everywhere it surfaces, because it is not a price we
 * can charge and the label is the only thing telling a guest that.
 */
export function formatAdvertisedRate(
  place: Pick<DirectoryPlace, 'advertisedPriceKobo'>,
  format: (kobo: number) => string
): string | null {
  if (place.advertisedPriceKobo === null || place.advertisedPriceKobo <= 0) return null;
  return format(place.advertisedPriceKobo);
}

/** The label for whatever the contact route is, for the button. */
export function contactLabel(route: ContactRoute, pmsDetected: string | null): string {
  switch (route.kind) {
    case 'AFFILIATE_URL':
      return 'Continue on partner site';
    case 'PHONE':
      return 'Call to book';
    case 'EMAIL':
      return 'Email to enquire';
    case 'WEBSITE':
      return 'Visit their site';
    default:
      return 'Details only';
  }
}

/**
 * First-party tracking hop for an authorised affiliate handoff.
 *
 * DIRECTORY rows return null: they must never be routed through the affiliate
 * endpoint, even if a caller tries to construct the URL by hand.
 */
export function affiliateHandoffHref(
  place: Pick<DirectoryPlace, 'id' | 'distribution' | 'affiliate'>
): string | null {
  if (place.distribution !== 'AFFILIATE' || !place.affiliate) return null;
  return `/api/affiliate/out?id=${encodeURIComponent(place.id)}`;
}

/**
 * Where a guest goes to book something we can actually confirm.
 *
 * Every place row carries this, because a directory entry with no path to
 * inventory is a dead end: the guest found what they wanted and we had nowhere
 * to send them. Carrying the area through means the search lands on the right
 * neighbourhood rather than the whole state.
 */
export function bookableSearchHref(
  place: Pick<DirectoryPlace, 'area' | 'state' | 'bedrooms'>
): string | null {
  if (!place.state) return null;
  const params = new URLSearchParams({ state: place.state });
  if (place.area) params.set('area', place.area);
  if (place.bedrooms !== null && place.bedrooms > 0) params.set('bedrooms', String(place.bedrooms));
  return `/search?${params.toString()}`;
}

/**
 * The page for one place.
 *
 * The id is `{source}:{listingId}`, so it contains a colon. It is encoded
 * here and decoded by the route, because a raw colon in a path segment is
 * legal but fragile - and a route param that silently truncates at the colon
 * would 404 every listing.
 */
export function placeHref(place: Pick<DirectoryPlace, 'id'>): string {
  return `/stay/${encodeURIComponent(place.id)}`;
}

/**
 * The full detail rows shown on a place's own page.
 *
 * Built here rather than in the component so the page renders a list of facts
 * instead of deciding which facts exist, and so what counts as a displayable
 * field is one reviewable function. Only fields that are actually populated are
 * returned: a row reading "Bathrooms —" is noise, and a guest reads it as a
 * failed lookup rather than as "not published".
 */
export function placeDetailRows(
  place: DirectoryPlace,
  stateName?: string | null
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const type = typeLabel(place.propertyType);
  if (type) rows.push({ label: 'Type', value: type });

  if (place.bedrooms !== null && place.bedrooms > 0) {
    rows.push({ label: 'Bedrooms', value: String(place.bedrooms) });
  }
  if (place.bathrooms !== null && place.bathrooms > 0) {
    rows.push({ label: 'Bathrooms', value: String(place.bathrooms) });
  }

  const location = placeLocation(place, stateName);
  if (location) rows.push({ label: 'Location', value: location });

  rows.push({ label: 'First seen', value: place.firstSeenAt });
  rows.push({ label: 'Last checked', value: place.lastSeenAt });
  rows.push({ label: 'Source', value: place.attribution });

  if (place.pmsDetected) {
    rows.push({ label: 'Booking system', value: place.pmsDetected });
  }

  return rows;
}

/**
 * Parse a whole directory file.
 *
 * A malformed row is dropped rather than failing the page, because one bad row
 * in a crawl should not blank a directory of thousands. The drop is counted, so
 * a run that loses half its rows is visible instead of quietly shrinking.
 */
export function parseDirectory(
  payload: unknown,
  now?: string
): { places: DirectoryPlace[]; rejected: number; generatedAt: string | null } {
  const body = (payload ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(body.places) ? body.places : [];

  const places: DirectoryPlace[] = [];
  let rejected = 0;

  for (const row of rows) {
    try {
      places.push(assertPublishable(row as RawDirectoryPlace, now));
    } catch {
      rejected += 1;
    }
  }

  return {
    places,
    rejected,
    generatedAt: typeof body.generated_at === 'string' ? body.generated_at : null
  };
}
