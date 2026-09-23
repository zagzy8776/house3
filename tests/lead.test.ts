import { describe, expect, it } from 'vitest';
import {
  dedupeLeads,
  isRetentionExpired,
  leadDedupeKey,
  LEAD_RETENTION_DAYS,
  mergeLeads,
  normaliseOperatorName,
  normalisePhone,
  retentionExpiry,
  sanitiseContact,
  type OperatorLead
} from '@/domain/lead';
import {
  assessLead,
  buildCallList,
  medianRateKobo,
  TIER_THRESHOLDS,
  type MarketBenchmark
} from '@/domain/leadScoring';

const NOW = '2026-06-01T00:00:00.000Z';

function makeLead(overrides: Partial<OperatorLead> = {}): OperatorLead {
  const displayName = overrides.displayName ?? 'Lekki Homes Ltd';
  const area = overrides.area ?? 'Lekki Phase 1';
  const stateCode = overrides.stateCode ?? 'LA';

  return {
    id: overrides.id ?? leadDedupeKey({ displayName, area, stateCode }),
    displayName,
    normalisedName: normaliseOperatorName(displayName),
    area,
    stateCode,
    location: { lat: 6.4418, lng: 3.474 },
    contact: { phone: '+2348030000000', email: null, website: null, instagram: null },
    listingCount: 1,
    observedNightlyRatesKobo: [15_000_000],
    claimedTitles: [],
    pmsFingerprints: [],
    contactedAt: null,
    sources: [
      {
        kind: 'PUBLIC_LISTING_TITLE',
        reference: 'https://example.ng/listing/1',
        observedAt: NOW,
        robotPermitted: true
      }
    ],
    retainUntil: retentionExpiry(NOW),
    ...overrides
  };
}

describe('operator name normalisation', () => {
  it('collapses the variants one operator appears under', () => {
    const variants = ['Lekki Homes Ltd', 'LEKKI HOMES LIMITED', 'Lekki Homes Nig. Ltd', 'lekki homes ltd.'];
    const normalised = new Set(variants.map(normaliseOperatorName));
    expect(normalised.size).toBe(1);
    expect([...normalised][0]).toBe('lekki homes');
  });

  it('keeps distinguishing words', () => {
    expect(normaliseOperatorName('Maitama Residences Ltd')).toBe('maitama residences');
    expect(normaliseOperatorName('Owerri Garden Suites')).toBe('owerri garden suites');
  });

  it('never collapses a suffix-only name to an empty key', () => {
    // "Ltd" alone must not normalise to '', or every such lead would merge.
    expect(normaliseOperatorName('Ltd').length).toBeGreaterThan(0);
    expect(normaliseOperatorName('Services Ventures')).not.toBe('');
  });

  it('ignores punctuation differences', () => {
    expect(normaliseOperatorName('Uyo GRA Retreat')).toBe(normaliseOperatorName('uyo gra retreat'));
  });
});

describe('dedupe keys', () => {
  it('matches the same operator in the same neighbourhood', () => {
    const a = leadDedupeKey({ displayName: 'Lekki Homes Ltd', area: 'Lekki Phase 1', stateCode: 'LA' });
    const b = leadDedupeKey({ displayName: 'LEKKI HOMES LIMITED', area: 'lekki phase 1', stateCode: 'LA' });
    expect(a).toBe(b);
  });

  it('separates the same name in another neighbourhood', () => {
    const lagos = leadDedupeKey({ displayName: 'Prime Suites', area: 'Lekki Phase 1', stateCode: 'LA' });
    const abuja = leadDedupeKey({ displayName: 'Prime Suites', area: 'Maitama', stateCode: 'FC' });
    expect(lagos).not.toBe(abuja);
  });
});

describe('merging duplicate sightings', () => {
  it('sums portfolio size and keeps every rate observed', () => {
    const merged = mergeLeads([
      makeLead({ listingCount: 3, observedNightlyRatesKobo: [15_000_000] }),
      makeLead({ listingCount: 4, observedNightlyRatesKobo: [18_000_000, 12_000_000] })
    ]);

    expect(merged.listingCount).toBe(7);
    expect(merged.observedNightlyRatesKobo).toEqual([15_000_000, 18_000_000, 12_000_000]);
    expect(merged.sources).toHaveLength(2);
  });

  it('never loses a contact channel we already had', () => {
    const merged = mergeLeads([
      makeLead({ contact: { phone: '+2348030000000', email: null, website: null, instagram: null } }),
      makeLead({ contact: { phone: null, email: 'ops@lekkihomes.ng', website: null, instagram: null } }),
      makeLead({ contact: { phone: null, email: null, website: 'https://lekkihomes.ng', instagram: null } })
    ]);

    expect(merged.contact.phone).toBe('+2348030000000');
    expect(merged.contact.email).toBe('ops@lekkihomes.ng');
    expect(merged.contact.website).toBe('https://lekkihomes.ng');
  });

  it('keeps the earliest contact date so nobody is cold-called twice', () => {
    const merged = mergeLeads([
      makeLead({ contactedAt: '2026-03-01T00:00:00.000Z' }),
      makeLead({ contactedAt: null })
    ]);
    expect(merged.contactedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('unions PMS fingerprints without duplicating them', () => {
    const merged = mergeLeads([
      makeLead({ pmsFingerprints: ['smoobu'] }),
      makeLead({ pmsFingerprints: ['smoobu', 'beds24'] })
    ]);
    expect([...merged.pmsFingerprints].sort()).toEqual(['beds24', 'smoobu']);
  });

  it('dedupes a batch down to one row per operator', () => {
    // No explicit ids here on purpose: `id` IS the dedupe key, so overriding it
    // would defeat the very thing under test.
    const batch = dedupeLeads([
      makeLead({ displayName: 'Lekki Homes Ltd' }),
      makeLead({ displayName: 'LEKKI HOMES LIMITED' }),
      makeLead({ displayName: 'Island Suites Ikoyi', area: 'Ikoyi' })
    ]);

    expect(batch).toHaveLength(2);
    const merged = batch.find((lead) => lead.area === 'Lekki Phase 1');
    expect(merged?.listingCount).toBe(2);
  });
});

describe('phone normalisation', () => {
  it('converts the forms a Nigerian listing actually publishes', () => {
    expect(normalisePhone('0803 000 0000')).toBe('+2348030000000');
    expect(normalisePhone('+234 803 000 0000')).toBe('+2348030000000');
    expect(normalisePhone('2348030000000')).toBe('+2348030000000');
    expect(normalisePhone('8030000000')).toBe('+2348030000000');
  });

  it('leaves an unrecognised shape alone rather than guessing', () => {
    expect(normalisePhone('+44 20 7946 0000')).toBe('+44 20 7946 0000');
    expect(normalisePhone(null)).toBeNull();
  });

  it('sanitises a contact block', () => {
    const contact = sanitiseContact({
      phone: '0803-000-0000',
      email: '  OPS@LekkiHomes.NG ',
      website: 'https://lekkihomes.ng/',
      instagram: '@lekkihomes'
    });

    expect(contact).toEqual({
      phone: '+2348030000000',
      email: 'ops@lekkihomes.ng',
      website: 'https://lekkihomes.ng',
      instagram: 'lekkihomes'
    });
  });
});

describe('retention', () => {
  it('expires a year after observation by default', () => {
    expect(retentionExpiry('2026-01-01T00:00:00.000Z')).toBe('2027-01-01T00:00:00.000Z');
    expect(LEAD_RETENTION_DAYS).toBe(365);
  });

  it('flags an expired record', () => {
    const stale = makeLead({ retainUntil: '2026-05-01T00:00:00.000Z' });
    expect(isRetentionExpired(stale, NOW)).toBe(true);
    expect(isRetentionExpired(makeLead(), NOW)).toBe(false);
  });
});

describe('lead scoring', () => {
  it('blocks a record whose retention has lapsed', () => {
    const assessment = assessLead(makeLead({ retainUntil: '2026-05-01T00:00:00.000Z' }), { now: NOW });
    expect(assessment.blockedReason).toBe('RETENTION_EXPIRED');
    expect(assessment.score).toBe(0);
  });

  it('blocks a record with no way to make contact', () => {
    const unreachable = makeLead({ contact: { phone: null, email: null, website: null, instagram: null } });
    expect(assessLead(unreachable, { now: NOW }).blockedReason).toBe('NO_CONTACT_CHANNEL');
  });

  it('prefers phone, then Instagram, then email', () => {
    expect(assessLead(makeLead(), { now: NOW }).channel).toBe('PHONE');

    const instagramOnly = makeLead({
      contact: { phone: null, email: 'a@b.ng', website: null, instagram: 'lekki' }
    });
    expect(assessLead(instagramOnly, { now: NOW }).channel).toBe('INSTAGRAM');

    const emailOnly = makeLead({ contact: { phone: null, email: 'a@b.ng', website: null, instagram: null } });
    expect(assessLead(emailOnly, { now: NOW }).channel).toBe('EMAIL');
  });

  it('rewards a portfolio operator running a booking system in a tier 1 market', () => {
    const best = makeLead({
      listingCount: 12,
      pmsFingerprints: ['smoobu'],
      contact: {
        phone: '+2348030000000',
        email: null,
        website: 'https://lekkihomes.ng',
        instagram: 'lekkihomes'
      }
    });

    const assessment = assessLead(best, { now: NOW });
    expect(assessment.tier).toBe('A');
    expect(assessment.score).toBeGreaterThanOrEqual(TIER_THRESHOLDS.a);
    expect(assessment.reasons.some((reason) => reason.includes('smoobu'))).toBe(true);
  });

  it('rates a single unmanaged unit far lower', () => {
    const small = makeLead({
      listingCount: 1,
      stateCode: 'IM',
      contact: { phone: '+2348030000000', email: null, website: null, instagram: null }
    });
    expect(assessLead(small, { now: NOW }).tier).toBe('C');
  });

  it('treats an underpriced operator as the strongest opening', () => {
    const benchmark: MarketBenchmark = {
      area: 'Lekki Phase 1',
      stateCode: 'LA',
      medianNightlyRateKobo: 20_000_000,
      sampleSize: 40
    };

    const underpriced = assessLead(makeLead({ observedNightlyRatesKobo: [12_000_000] }), { now: NOW, benchmark });
    const atMarket = assessLead(makeLead({ observedNightlyRatesKobo: [20_000_000] }), { now: NOW, benchmark });

    expect(underpriced.score).toBeGreaterThan(atMarket.score);
    expect(underpriced.ratePositionBps).toBeLessThan(0);
    expect(underpriced.reasons.some((reason) => reason.includes('below the Lekki Phase 1 median'))).toBe(true);
  });

  it('penalises a lead already contacted', () => {
    // A strong lead, so the penalty does not collide with the 0 floor.
    const strong = {
      listingCount: 12,
      pmsFingerprints: ['smoobu'],
      contact: {
        phone: '+2348030000000',
        email: null,
        website: 'https://lekkihomes.ng',
        instagram: 'lekkihomes'
      }
    };

    const fresh = assessLead(makeLead(strong), { now: NOW });
    const called = assessLead(makeLead({ ...strong, contactedAt: '2026-05-01T00:00:00.000Z' }), { now: NOW });

    expect(called.score).toBe(fresh.score - 15);
    expect(called.reasons.some((reason) => reason.includes('do not cold-call'))).toBe(true);
  });

  it('floors the score at zero rather than going negative', () => {
    // A weak lead already contacted would otherwise score below zero.
    const weak = makeLead({
      listingCount: 1,
      stateCode: 'IM',
      contactedAt: '2026-05-01T00:00:00.000Z'
    });

    expect(assessLead(weak, { now: NOW }).score).toBe(0);
  });

  it('never returns a score outside 0-100', () => {
    const extreme = makeLead({
      listingCount: 50,
      pmsFingerprints: ['smoobu', 'beds24', 'hostaway'],
      contact: { phone: '+2348030000000', email: 'a@b.ng', website: 'https://x.ng', instagram: 'x' }
    });

    const assessment = assessLead(extreme, { now: NOW });
    expect(assessment.score).toBeLessThanOrEqual(100);
    expect(assessment.score).toBeGreaterThanOrEqual(0);
  });
});

describe('median rate', () => {
  it('handles an odd sample', () => {
    expect(medianRateKobo([makeLead({ observedNightlyRatesKobo: [10, 30, 20] })])).toBe(20);
  });

  it('averages the middle pair on an even sample', () => {
    expect(medianRateKobo([makeLead({ observedNightlyRatesKobo: [10, 20, 30, 40] })])).toBe(25);
  });

  it('returns zero when nothing has been observed', () => {
    expect(medianRateKobo([makeLead({ observedNightlyRatesKobo: [] })])).toBe(0);
  });
});

describe('call list', () => {
  it('drops blocked leads and orders by score', () => {
    const strong = makeLead({
      id: 'strong',
      displayName: 'Lekki Premier Homes',
      area: 'Lekki Phase 1',
      listingCount: 14,
      pmsFingerprints: ['smoobu']
    });
    const weak = makeLead({ id: 'weak', displayName: 'Tiny Stays', area: 'Ajah', listingCount: 1 });
    const blocked = makeLead({
      id: 'blocked',
      displayName: 'Unreachable',
      contact: { phone: null, email: null, website: null, instagram: null }
    });

    const list = buildCallList([weak, blocked, strong], { now: NOW });
    expect(list.map((entry) => entry.leadId)).toEqual(['strong', 'weak']);
  });

  it('breaks score ties by which operator brings more rooms', () => {
    const few = makeLead({ id: 'few', displayName: 'A Stays', area: 'Ikoyi', listingCount: 2 });
    const many = makeLead({ id: 'many', displayName: 'B Stays', area: 'Ikoyi', listingCount: 9 });

    const list = buildCallList([few, many], { now: NOW });
    expect(list[0]?.leadId).toBe('many');
  });
});
