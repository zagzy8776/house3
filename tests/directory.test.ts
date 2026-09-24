import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  placeToPartner,
  placeToUnit
} from '@/server/directoryRepository';
import {
  affiliateHandoffHref,
  assertPublishable,
  bookableSearchHref,
  contactLabel,
  formatAdvertisedRate,
  parseDirectory,
  placeDescriptor,
  placeDetailRows,
  placeHref,
  placeLocation,
  UnpublishablePlaceError,
  type RawDirectoryPlace
} from '@/domain/directory';
import { formatNaira } from '@/domain/money';

function row(overrides: RawDirectoryPlace = {}): RawDirectoryPlace {
  return {
    id: 'npc:1043552',
    distribution: 'DIRECTORY',
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
    expect(place.distribution).toBe('DIRECTORY');
    expect(place.affiliate).toBeNull();
    // An empty gallery, not a null one: a listing that published no photographs
    // is a fact the UI renders as a placeholder, and `null` would force every
    // caller to distinguish "no photos" from "field missing".
    expect(place.media).toEqual([]);
    expect(place.coverImageUrl).toBeNull();
  });

  it('accepts an authorized affiliate row and maps its handoff', () => {
    const place = assertPublishable(
      row({
        id: 'partner:unit-1',
        distribution: 'AFFILIATE',
        contact_route: {
          kind: 'AFFILIATE_URL',
          href: 'https://example.com/aff?ref=house3'
        },
        affiliate_partner: 'Example Partner',
        affiliate_url: 'https://example.com/aff?ref=house3',
        affiliate_disclosure: 'We may earn a commission.'
      })
    );

    expect(place.distribution).toBe('AFFILIATE');
    expect(place.contactRoute).toEqual({
      kind: 'AFFILIATE_URL',
      href: 'https://example.com/aff?ref=house3'
    });
    expect(place.affiliate).toEqual({
      partnerName: 'Example Partner',
      destinationUrl: 'https://example.com/aff?ref=house3',
      disclosure: 'We may earn a commission.'
    });
  });

  it('refuses an unknown distribution rather than defaulting to a route', () => {
    expect(() => assertPublishable(row({ distribution: 'DROP_SHIPPED' }))).toThrow(
      /unknown distribution/i
    );
  });

  it('refuses affiliate fields on a directory row', () => {
    expect(() =>
      assertPublishable(
        row({
          affiliate_partner: 'Example Partner',
          affiliate_url: 'https://example.com/aff',
          affiliate_disclosure: 'We may earn a commission.'
        })
      )
    ).toThrow(/without an authorised affiliate distribution/i);
  });

  it('refuses an affiliate row without complete authorization metadata', () => {
    for (const missing of ['affiliate_partner', 'affiliate_url', 'affiliate_disclosure'] as const) {
      expect(() =>
        assertPublishable(
          row({
            id: 'partner:unit-1',
            distribution: 'AFFILIATE',
            contact_route: { kind: 'AFFILIATE_URL', href: 'https://example.com/aff' },
            affiliate_partner: 'Example Partner',
            affiliate_url: 'https://example.com/aff',
            affiliate_disclosure: 'We may earn a commission.',
            [missing]: undefined
          })
        )
      ).toThrow(/needs a partner, destination URL and disclosure/i);
    }
  });

  it('refuses a non-HTTP affiliate destination', () => {
    for (const destination of ['javascript:alert(1)', 'http://']) {
      expect(() =>
        assertPublishable(
          row({
            id: 'partner:unit-1',
            distribution: 'AFFILIATE',
            contact_route: { kind: 'AFFILIATE_URL', href: destination },
            affiliate_partner: 'Example Partner',
            affiliate_url: destination,
            affiliate_disclosure: 'We may earn a commission.'
          })
        )
      ).toThrow(/invalid destination URL/i);
    }
  });

  it('refuses route/distribution mismatches in both directions', () => {
    expect(() =>
      assertPublishable(
        row({
          id: 'partner:unit-1',
          distribution: 'AFFILIATE',
          contact_route: { kind: 'PHONE', href: 'tel:08030000000' },
          affiliate_partner: 'Example Partner',
          affiliate_url: 'https://example.com/aff',
          affiliate_disclosure: 'We may earn a commission.'
        })
      )
    ).toThrow(/must use an affiliate route/i);

    expect(() =>
      assertPublishable(
        row({
          contact_route: { kind: 'AFFILIATE_URL', href: 'https://example.com/aff' }
        })
      )
    ).toThrow(/cannot use an affiliate route/i);
  });

  it('refuses crawl-only booking and availability URLs', () => {
    for (const key of [
      'booking_url',
      'availability_url',
      'availability_hint_url'
    ] as const) {
      expect(() => assertPublishable(row({ [key]: 'https://x/book' }))).toThrow(
        /non-publishable field/i
      );
    }
  });

  it('routes affiliate clicks through the first-party tracking hop', () => {
    const place = assertPublishable(
      row({
        id: 'partner:unit-1',
        distribution: 'AFFILIATE',
        contact_route: { kind: 'AFFILIATE_URL', href: 'https://example.com/aff' },
        affiliate_partner: 'Example Partner',
        affiliate_url: 'https://example.com/aff',
        affiliate_disclosure: 'We may earn a commission.'
      })
    );

    expect(affiliateHandoffHref(place)).toBe(
      `/api/affiliate/out?id=${encodeURIComponent('partner:unit-1')}`
    );
    expect(affiliateHandoffHref(assertPublishable(row()))).toBeNull();
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

  it('refuses a row carrying the operator’s written copy', () => {
    // MEDIA IS NOW ALLOWED; PROSE IS NOT. This test used to loop over
    // ['photos','images','gallery','image'] and assert each one was refused.
    // The media half of that policy was reversed by product decision - the
    // platform shows a listing's photographs - and the record of the reversal is
    // in services/acquisition/compliance/allowed_fields.py.
    //
    // What is still refused is the operator's writing, which is the other half
    // and the one that matters more: a description is prose with an author.
    for (const forbidden of ['description', 'body_text', 'summary']) {
      expect(() => assertPublishable(row({ [forbidden]: 'A lovely home' }))).toThrow(
        /non-publishable field/i
      );
    }
  });

  it('carries the gallery and derives the cover from it', () => {
    // The positive half of the same decision: media IS published, and the cover
    // is computed from the gallery rather than trusted from the row.
    const place = assertPublishable(
      row({
        media: ['https://cdn.x/1.jpg', 'https://cdn.x/2.jpg'],
        cover_image_url: 'https://cdn.x/2.jpg'
      })
    );

    expect(place.media).toEqual(['https://cdn.x/1.jpg', 'https://cdn.x/2.jpg']);
    // The cover is the FIRST gallery image, not the row's claim. A row that
    // promoted an image the gallery does not contain would otherwise put a photo
    // on a card that the gallery then fails to show.
    expect(place.coverImageUrl).toBe('https://cdn.x/1.jpg');
  });

  it('drops unusable image URLs instead of rejecting the whole place', () => {
    // A place is worth publishing for its name, area and rate alone. Losing a
    // real property over one malformed image URL would be the wrong trade.
    const place = assertPublishable(
      row({
        media: [
          'https://cdn.x/1.jpg',
          'javascript:alert(1)',
          'data:image/png;base64,AAAA',
          'not a url',
          'https://cdn.x/1.jpg',
          'https://cdn.x/3.jpg'
        ]
      })
    );

    expect(place.media).toEqual(['https://cdn.x/1.jpg', 'https://cdn.x/3.jpg']);
    expect(place.coverImageUrl).toBe('https://cdn.x/1.jpg');
  });

  it('treats a listing with no photographs as an empty gallery, not an error', () => {
    const place = assertPublishable(row());
    expect(place.media).toEqual([]);
    expect(place.coverImageUrl).toBeNull();
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
    expect(contactLabel({ kind: 'AFFILIATE_URL', href: 'https://x' }, 'smoobu')).toBe(
      'Continue on partner site'
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
      // Media is carried now, so it is an array - empty when the listing published
      // no photographs. The guarantee that matters is that every entry is an
      // absolute http(s) URL and that the cover agrees with the gallery.
      expect(Array.isArray(place.media)).toBe(true);
      for (const url of place.media) {
        expect(url).toMatch(/^https?:\/\//);
      }
      expect(place.coverImageUrl).toBe(place.media[0] ?? null);
    }
  });
});

// ---------------------------------------------------------------------------
// the place page
// ---------------------------------------------------------------------------

describe('a place’s own page', () => {
  it('encodes the id, because the id contains a colon', () => {
    // A place id is `{source}:{listingId}`. A raw colon in a path segment is
    // legal but fragile, and a route that truncated at it would 404 every
    // listing - so the href is encoded here and decoded by the route.
    const href = placeHref({ id: 'npc:1043552' });

    expect(href).toBe('/stay/npc%3A1043552');
    expect(decodeURIComponent(href.replace('/stay/', ''))).toBe('npc:1043552');
  });

  it('lists only the facts that were actually published', () => {
    // A row reading "Bathrooms —" is noise, and a guest reads it as a failed
    // lookup rather than as "the operator did not publish this".
    const place = assertPublishable(row({ bathrooms: null, property_type: null, pms_detected: null }));
    const labels = placeDetailRows(place, 'Lagos').map((entry) => entry.label);

    expect(labels).not.toContain('Bathrooms');
    expect(labels).not.toContain('Type');
    expect(labels).not.toContain('Booking system');

    // The ones that are always present, because every row carries them.
    expect(labels).toContain('Bedrooms');
    expect(labels).toContain('Location');
    expect(labels).toContain('Source');
    expect(labels).toContain('Last checked');
  });

  it('reports the attribution and the last-seen date as facts', () => {
    const place = assertPublishable(row());
    const detail = Object.fromEntries(placeDetailRows(place, 'Lagos').map((entry) => [entry.label, entry.value]));

    expect(detail.Source).toBe('Nigeria Property Centre');
    expect(detail['Last checked']).toBe('2026-09-20');
    expect(detail.Location).toContain('Ikeja');
  });

  it('never renders a payable total', () => {
    // The one invariant this page cannot break: there is no payment path in the
    // app, so no label it produces may read like a charge.
    const place = assertPublishable(row({ advertised_price: 20_000_000 }));
    const rendered = placeDetailRows(place, 'Lagos')
      .map((entry) => `${entry.label} ${entry.value}`)
      .join(' ')
      .toLowerCase();

    for (const forbidden of ['total', 'pay now', 'service fee', 'vat', 'due']) {
      expect(rendered).not.toContain(forbidden);
    }
  });
});


// ---------------------------------------------------------------------------
// the search projection
// ---------------------------------------------------------------------------

describe('published places as searchable inventory', () => {
  it('projects an observed place into the unit search reads', () => {
    const place = assertPublishable(
      row({ media: ['https://cdn.x/1.jpg'], advertised_price: 15_000_000 })
    );
    const unit = placeToUnit(place);
    const partner = placeToPartner(place);

    expect(unit.id).toBe('npc:1043552');
    expect(unit.nightlyRateKobo).toBe(15_000_000);
    expect(unit.stateCode).toBe('LA');
    expect(unit.area).toBe('Ikeja');

    // Not sellable, and there is no payment path to make it so.
    expect(unit.bookable).toBe(false);

    // Absent, not guessed: a wrong pin sends a guest to the wrong street, and
    // search already treats null as "not geo-searchable".
    expect(unit.latitude).toBeNull();
    expect(unit.longitude).toBeNull();

    // The operator is carried for the page, but no settlement account exists
    // because no money moves.
    expect(partner.displayName).toBe('Adeniyi Jones Residences Ltd');
    expect(partner.paystackSubaccountCode).toBeNull();
    expect(partner.settlementVerified).toBe(false);
  });

  it('gives an unpriced place a synthetic rate so it cannot break a whole search', () => {
    // MEASURED BUG. `computeQuote` throws on a rate of 0, and the throw escaped
    // the search loop - so six unpriced places out of 260 returned "0 places"
    // for the whole of Lagos. A placeholder keeps the row priceable; the UI
    // reads `advertisedPriceKobo` and renders "rate not published" instead.
    const unpriced = assertPublishable(row({ advertised_price: null }));
    const unit = placeToUnit(unpriced);

    expect(unit.nightlyRateKobo).toBeGreaterThan(0);
    expect(unit.nightlyRateKobo).toBe(100_000);

    // And the observed absence is still visible to the UI, which is what decides
    // what a guest actually sees.
    expect(unpriced.advertisedPriceKobo).toBeNull();
  });

  it('carries the contact fields the place page needs', () => {
    const place = assertPublishable(row({ website: 'https://adeniyijones.ng' }));
    const unit = placeToUnit(place);

    expect(unit.sourceUrl).toBe(place.sourceUrl);
    expect(unit.sourceName).toBe('Nigeria Property Centre');
    expect(unit.operatorName).toBe('Adeniyi Jones Residences Ltd');
    expect(unit.contactPhone).toBe('0803 000 0000');
  });

  it('describes a place factually, never from a title', () => {
    // Titles are dropped by the pipeline, so the descriptor is the only name a
    // row has - and it has to be built from numbers and a location.
    const unit = placeToUnit(assertPublishable(row()));
    expect(unit.name).toBe('3-bedroom shortlet, Ikeja');
  });
});

