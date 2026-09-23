import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertPublishable,
  bookableSearchHref,
  contactLabel,
  formatAdvertisedRate,
  parseDirectory,
  placeDescriptor,
  placeLocation,
  UnpublishablePlaceError,
  type RawDirectoryPlace
} from '@/domain/directory';
import { formatNaira } from '@/domain/money';

function row(overrides: RawDirectoryPlace = {}): RawDirectoryPlace {
  return {
    id: 'npc:1043552',
    operator_name: 'Adeniyi Jones Residences Ltd',
    phone: '0803 000 0000',
    property_type: 'SHORTLET',
    bedrooms: 3,
    bathrooms: 3,
    state: 'LA',
    city: 'Lagos',
    area: 'Ikeja',
    advertised_price: 20_000_000,
    currency: 'NGN',
    source: 'npc',
    source_url: 'https://www.nigeriapropertycentre.com/for-rent/short-let/lagos/ikeja/x-1043552',
    attribution: 'Nigeria Property Centre',
    first_seen_at: '2026-09-01',
    last_seen_at: '2026-09-20',
    contact_route: { kind: 'PHONE', href: 'tel:08030000000' },
    media: null,
    ...overrides
  };
}

describe('directory publication guard', () => {
  it('accepts a fully attributed facts-only row', () => {
    const place = assertPublishable(row());
    expect(place.operatorName).toBe('Adeniyi Jones Residences Ltd');
    expect(place.advertisedPriceKobo).toBe(20_000_000);
    expect(place.media).toBeNull();
  });

  it('refuses a row with no attribution', () => {
    // Attribution is the entire basis for publishing a fact about someone
    // else's business. Without it this is not a directory entry.
    expect(() => assertPublishable(row({ attribution: undefined }))).toThrow(
      UnpublishablePlaceError
    );
    expect(() => assertPublishable(row({ attribution: '   ' }))).toThrow(/no attribution/i);
  });

  it('refuses a row with no source URL to link back to', () => {
    expect(() => assertPublishable(row({ source_url: undefined }))).toThrow(/no source URL/i);
  });

  it('refuses a row carrying photographs', () => {
    // The one mistake here that cannot be taken back: a page that went live
    // with someone's photograph has already been viewed and cached.
    for (const forbidden of ['photos', 'images', 'gallery', 'image']) {
      expect(() => assertPublishable(row({ [forbidden]: ['a.jpg'] }))).toThrow(
        /non-publishable field/i
      );
    }
  });

  it("refuses a row carrying the operator's own listing title", () => {
    // A listing title is the operator's marketing copy, not a fact. It stays
    // internal for dedupe and never reaches a public page.
    expect(() => assertPublishable(row({ property_name: 'Luxury 3 Bedrooms Flats' }))).toThrow(
      /non-publishable field/i
    );
  });

  it('refuses prose', () => {
    expect(() => assertPublishable(row({ description: 'A lovely home...' }))).toThrow(
      /non-publishable field/i
    );
  });

  it('refuses a contact route with no href', () => {
    expect(() => assertPublishable(row({ contact_route: { kind: 'PHONE', href: null } }))).toThrow(
      /with no href/i
    );
  });

  it('refuses an unknown contact route', () => {
    expect(() =>
      assertPublishable(row({ contact_route: { kind: 'CARRIER_PIGEON', href: 'x' } }))
    ).toThrow(/unknown contact route/i);
  });

  it('accepts a row we cannot contact, and says so rather than inventing a route', () => {
    const place = assertPublishable(row({ contact_route: { kind: 'NONE', href: null } }));
    expect(place.contactRoute.kind).toBe('NONE');
    expect(place.contactRoute.href).toBeNull();
  });

  it('requires an id', () => {
    expect(() => assertPublishable(row({ id: undefined }))).toThrow(/no id/i);
  });
});

describe('directory display', () => {
  it('describes a place from its facts, not from the operator title', () => {
    expect(placeDescriptor({ bedrooms: 3, propertyType: 'SHORTLET' })).toBe('3-bedroom short-let');
    expect(placeDescriptor({ bedrooms: 1, propertyType: 'APARTMENT' })).toBe('1-bedroom apartment');
    expect(placeDescriptor({ bedrooms: null, propertyType: 'STUDIO' })).toBe('Studio');
    expect(placeDescriptor({ bedrooms: 2, propertyType: null })).toBe('2-bedroom short-let');
  });

  it('builds a location without repeating a word', () => {
    expect(placeLocation({ area: 'Ikeja', city: 'Lagos', state: 'LA' }, 'Lagos')).toBe(
      'Ikeja, Lagos'
    );
    // "Lekki, Lekki" reads like a bug, so the duplicate goes.
    expect(placeLocation({ area: 'Lekki', city: 'Lekki', state: 'LA' }, 'Lagos')).toBe(
      'Lekki, Lagos'
    );
    expect(placeLocation({ area: null, city: null, state: 'FC' }, 'FCT Abuja')).toBe('FCT Abuja');
  });

  it('labels an advertised rate as advertised', () => {
    const place = assertPublishable(row());
    const formatted = formatAdvertisedRate(place, (kobo) => formatNaira(kobo, { decimals: false }));
    expect(formatted).toContain('200,000');
  });

  it('returns no rate rather than a zero when none was published', () => {
    const place = assertPublishable(row({ advertised_price: null }));
    expect(formatAdvertisedRate(place, (kobo) => formatNaira(kobo))).toBeNull();
  });

  it('picks a contact label from the route', () => {
    expect(contactLabel({ kind: 'PHONE', href: 'tel:x' }, null)).toBe('Call to book');
    expect(contactLabel({ kind: 'BOOKING_URL', href: 'https://x' }, 'smoobu')).toBe(
      'Book on their site'
    );
    expect(contactLabel({ kind: 'NONE', href: null }, null)).toBe('Details only');
  });

  it('always offers a route to the inventory we can actually confirm', () => {
    const href = bookableSearchHref({ area: 'Ikeja', state: 'LA', bedrooms: 3 });
    expect(href).toContain('state=LA');
    expect(href).toContain('area=Ikeja');
    expect(href).toContain('bedrooms=3');
  });

  it('returns no search route without a state, rather than a broken link', () => {
    expect(bookableSearchHref({ area: 'Ikeja', state: null, bedrooms: 3 })).toBeNull();
  });
});

describe('directory parsing', () => {
  it('drops a bad row without blanking the rest of the directory', () => {
    const payload = {
      generated_at: '2026-09-23',
      places: [row(), row({ id: 'npc:2', attribution: undefined }), row({ id: 'npc:3' })]
    };
    const result = parseDirectory(payload);

    expect(result.places.map((place) => place.id)).toEqual(['npc:1043552', 'npc:3']);
    // Counted rather than silent, so a run that loses half its rows is visible.
    expect(result.rejected).toBe(1);
    expect(result.generatedAt).toBe('2026-09-23');
  });

  it('survives an empty or malformed payload', () => {
    expect(parseDirectory({}).places).toEqual([]);
    expect(parseDirectory(null).places).toEqual([]);
    expect(parseDirectory({ places: 'not-an-array' }).places).toEqual([]);
    expect(parseDirectory({ places: 'not-an-array' }).generatedAt).toBeNull();
  });
});

/**
 * The seam that actually matters: does what the Python pipeline writes survive
 * this module's guard unchanged?
 *
 * Skipped when no crawl has run, rather than asserting against a fixture that
 * would only ever prove the fixture agrees with itself. When the file is
 * present, a rejection here means the two sides have drifted - most likely a
 * field added to the pipeline's output that the guard rightly refuses.
 */
const REAL_DIRECTORY = path.join(
  process.cwd(),
  'services',
  'acquisition',
  'directory.json'
);

describe.runIf(existsSync(REAL_DIRECTORY))('real pipeline output', () => {
  it('passes the guard with zero rows rejected', () => {
    const payload = JSON.parse(readFileSync(REAL_DIRECTORY, 'utf8'));
    const result = parseDirectory(payload, '2026-09-23T00:00:00.000Z');

    expect(result.rejected).toBe(0);
    expect(result.places.length).toBeGreaterThan(0);

    for (const place of result.places) {
      expect(place.attribution).toBeTruthy();
      expect(place.sourceUrl).toMatch(/^https?:\/\//);
      expect(place.media).toBeNull();
    }
  });
});
