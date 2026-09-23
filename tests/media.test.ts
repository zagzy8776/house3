import { describe, expect, it } from 'vitest';
import {
  assertMediaUsable,
  cardImage,
  primaryImage,
  selectGallery,
  UnlicensedMediaError,
  type MediaAsset,
  type MediaPartnerContext
} from '@/domain/media';
import {
  assertBookable,
  listingAgeDays,
  priceMovementNote,
  UnbookableRateError,
  type ObservedRate
} from '@/domain/provenance';

const NOW = '2026-09-23T00:00:00.000Z';

function partner(overrides: Partial<MediaPartnerContext> = {}): MediaPartnerContext {
  return {
    id: 'partner_1',
    legalName: 'Adeniyi Jones Residences Ltd',
    status: 'ACTIVE',
    supplyAgreementRef: 'H3-SUP-2026-014',
    supplyAgreementSignedAt: '2026-08-01T00:00:00.000Z',
    ...overrides
  };
}

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset_1',
    partnerId: 'partner_1',
    unitExternalId: 'unit_1',
    licence: 'PARTNER_SUPPLIED',
    licenceRef: 'H3-SUP-2026-014',
    licenceGrantedAt: '2026-08-01T00:00:00.000Z',
    licenceExpiresAt: null,
    position: 0,
    alt: 'Living area of a three-bedroom apartment in Ikeja',
    variants: [{ key: 'units/unit_1/hero', width: 1600, height: 1067, sizeBytes: 240_000 }],
    ...overrides
  };
}

const UNIT = { externalId: 'unit_1', partnerId: 'partner_1' };

describe('media licensing', () => {
  it('accepts an asset covered by a signed supply agreement', () => {
    expect(assertMediaUsable(asset(), partner(), UNIT, NOW).id).toBe('asset_1');
  });

  it('refuses any media at all for a partner with no signed agreement', () => {
    // The core rule. A crawled photograph of a property we have no agreement
    // over is exactly the case this exists to stop.
    expect(() =>
      assertMediaUsable(asset(), partner({ supplyAgreementRef: null }), UNIT, NOW)
    ).toThrow(UnlicensedMediaError);
    expect(() =>
      assertMediaUsable(asset(), partner({ supplyAgreementSignedAt: null }), UNIT, NOW)
    ).toThrow(/no signed supply agreement/i);
  });

  it('refuses a blank agreement reference', () => {
    expect(() =>
      assertMediaUsable(asset(), partner({ supplyAgreementRef: '   ' }), UNIT, NOW)
    ).toThrow(UnlicensedMediaError);
  });

  it('takes media down when a partner is not active', () => {
    for (const status of ['ONBOARDING', 'PAUSED', 'TERMINATED', 'SUSPENDED']) {
      expect(() => assertMediaUsable(asset(), partner({ status }), UNIT, NOW)).toThrow(
        UnlicensedMediaError
      );
    }
  });

  it('refuses media belonging to a different partner', () => {
    expect(() =>
      assertMediaUsable(asset({ partnerId: 'partner_2' }), partner(), UNIT, NOW)
    ).toThrow(/belongs to partner/i);
  });

  it('refuses media that depicts a different unit', () => {
    expect(() =>
      assertMediaUsable(asset({ unitExternalId: 'unit_99' }), partner(), UNIT, NOW)
    ).toThrow(/depicts unit/i);
  });

  it('refuses an asset with no licence reference', () => {
    expect(() => assertMediaUsable(asset({ licenceRef: '  ' }), partner(), UNIT, NOW)).toThrow(
      /names no reference/i
    );
  });

  it('refuses an expired licence', () => {
    expect(() =>
      assertMediaUsable(
        asset({ licence: 'LICENSED_FEED', licenceExpiresAt: '2026-09-01T00:00:00.000Z' }),
        partner(),
        UNIT,
        NOW
      )
    ).toThrow(/expired/i);
  });

  it('requires an expiry date on licensed feeds but not on partner uploads', () => {
    expect(() =>
      assertMediaUsable(asset({ licence: 'LICENSED_FEED' }), partner(), UNIT, NOW)
    ).toThrow(/no expiry/i);

    expect(() =>
      assertMediaUsable(asset({ licence: 'PARTNER_SUPPLIED' }), partner(), UNIT, NOW)
    ).not.toThrow();
  });

  it('refuses an asset with no rendered variants', () => {
    expect(() => assertMediaUsable(asset({ variants: [] }), partner(), UNIT, NOW)).toThrow(
      /no rendered variants/i
    );
  });

  it('refuses an asset with no partner record at all', () => {
    expect(() => assertMediaUsable(asset(), null, UNIT, NOW)).toThrow(/no partner record/i);
  });
});

describe('gallery selection', () => {
  it('returns an empty gallery when there is no agreement', () => {
    expect(selectGallery(UNIT, partner({ supplyAgreementRef: null }), [asset()], NOW)).toEqual([]);
  });

  it('returns an empty gallery rather than a stand-in photo', () => {
    // A unit with no photographs is a designed card with no image. It is never
    // a photograph of some other property.
    expect(selectGallery(UNIT, partner(), [], NOW)).toEqual([]);
    expect(primaryImage(UNIT, partner(), [], NOW)).toBeNull();
  });

  it('orders assets by position and puts position 0 on the card', () => {
    const assets = [
      asset({ id: 'c', position: 2 }),
      asset({ id: 'a', position: 0 }),
      asset({ id: 'b', position: 1 })
    ];
    expect(selectGallery(UNIT, partner(), assets, NOW).map((entry) => entry.id)).toEqual([
      'a',
      'b',
      'c'
    ]);
    expect(primaryImage(UNIT, partner(), assets, NOW)?.id).toBe('a');
  });

  it('drops one bad asset without blanking a good gallery', () => {
    const assets = [
      asset({ id: 'good', position: 0 }),
      asset({
        id: 'expired',
        position: 1,
        licence: 'LICENSED_FEED',
        licenceExpiresAt: '2020-01-01T00:00:00.000Z'
      }),
      asset({ id: 'foreign', position: 2, unitExternalId: 'unit_99' })
    ];
    expect(selectGallery(UNIT, partner(), assets, NOW).map((entry) => entry.id)).toEqual(['good']);
  });

  it('allows operator-level media with no unit, for a logo slot', () => {
    const logo = asset({ id: 'logo', unitExternalId: null, position: 0 });
    expect(selectGallery(UNIT, partner(), [logo], NOW).map((entry) => entry.id)).toEqual(['logo']);
  });
});

describe('card image', () => {
  it('distinguishes "nothing licensed yet" from "no agreement"', () => {
    expect(cardImage(UNIT, partner(), [], NOW)).toEqual({ kind: 'EMPTY', reason: 'NO_MEDIA' });
    expect(cardImage(UNIT, partner({ supplyAgreementRef: null }), [], NOW)).toEqual({
      kind: 'EMPTY',
      reason: 'NO_AGREEMENT'
    });
  });

  it('returns the asset when one is licensed', () => {
    expect(cardImage(UNIT, partner(), [asset()], NOW).kind).toBe('ASSET');
  });
});

describe('rate provenance', () => {
  it('refuses to treat an advertised-elsewhere rate as payable', () => {
    // The whole point: a number we saw on someone else's portal is research,
    // not a price. No flag converts one into the other.
    const observed: ObservedRate = {
      kind: 'ADVERTISED_ELSEWHERE',
      nightlyKobo: 18_000_000,
      source: 'npc',
      sourceUrl: 'https://www.nigeriapropertycentre.com/for-rent/short-let/lagos/ikeja/x-1043552',
      observedAt: '2026-09-20'
    };

    expect(() => assertBookable(observed)).toThrow(UnbookableRateError);
    expect(() => assertBookable(observed)).toThrow(/not a price we can sell at/i);
  });

  it('accepts a partner rate', () => {
    const result = assertBookable({
      kind: 'PARTNER_RATE',
      nightlyKobo: 18_000_000,
      partnerId: 'partner_1',
      unitExternalId: 'unit_1',
      confirmedAt: NOW
    });
    expect(result.nightlyKobo).toBe(18_000_000);
  });

  it('refuses a non-positive partner rate', () => {
    expect(() =>
      assertBookable({
        kind: 'PARTNER_RATE',
        nightlyKobo: 0,
        partnerId: 'partner_1',
        unitExternalId: 'unit_1',
        confirmedAt: NOW
      })
    ).toThrow(/must be positive/i);
  });
});

describe('listing age and price movement', () => {
  it('reports age as at least the days we have been watching', () => {
    expect(listingAgeDays({ firstSeenAt: '2026-09-01' }, '2026-09-23')).toBe(22);
  });

  it('never reports a negative age for a clock skew', () => {
    expect(listingAgeDays({ firstSeenAt: '2026-09-30' }, '2026-09-23')).toBe(0);
  });

  it('summarises a meaningful price cut for an outreach call', () => {
    const note = priceMovementNote({
      priceMovements: [{ on: '2026-09-20', previousKobo: 20_000_000, currentKobo: 17_000_000 }]
    });
    expect(note).toContain('cut');
    expect(note).toContain('15%');
  });

  it('stays quiet about a rounding-level move and a missing history', () => {
    // Calling an operator about noise costs the credibility the call was for.
    expect(
      priceMovementNote({
        priceMovements: [{ on: '2026-09-20', previousKobo: 20_000_000, currentKobo: 19_600_000 }]
      })
    ).toBeNull();
    expect(priceMovementNote({ priceMovements: [] })).toBeNull();
  });

  it('says how many times a rate has moved', () => {
    const note = priceMovementNote({
      priceMovements: [
        { on: '2026-08-01', previousKobo: 20_000_000, currentKobo: 22_000_000 },
        { on: '2026-09-20', previousKobo: 22_000_000, currentKobo: 25_000_000 }
      ]
    });
    expect(note).toContain('raised');
    expect(note).toContain('2 times');
  });
});
