import { describe, expect, it } from 'vitest';
import {
  computeQuote,
  PricingError,
  resolveFeePolicy,
  selectLengthOfStayDiscount,
  type FeePolicy
} from '@/domain/pricing';
import { defaultFeePolicy, STATE_FEE_POLICIES } from '@/data/feePolicies';

const globalPolicy = defaultFeePolicy();
const lagosPolicy = STATE_FEE_POLICIES.find((policy) => policy.subjectId === 'LA') as FeePolicy;
const owerriPolicy = STATE_FEE_POLICIES.find((policy) => policy.subjectId === 'IM') as FeePolicy;

describe('fee policy resolution', () => {
  it('prefers a partner policy over a state policy over the global default', () => {
    const partnerPolicy: FeePolicy = {
      ...globalPolicy,
      id: 'partner-x',
      scope: 'PARTNER',
      subjectId: 'p_1',
      rateBps: 500
    };

    expect(
      resolveFeePolicy([globalPolicy, lagosPolicy, partnerPolicy], { stateCode: 'LA', partnerId: 'p_1' }).id
    ).toBe('partner-x');
    expect(resolveFeePolicy([globalPolicy, lagosPolicy], { stateCode: 'LA' }).id).toBe('state-la');
    expect(resolveFeePolicy([globalPolicy, lagosPolicy], { stateCode: 'ZZ' }).id).toBe('global-default');
  });

  it('refuses to quote when no policy matches', () => {
    expect(() => resolveFeePolicy([], { stateCode: 'LA' })).toThrow(PricingError);
  });
});

describe('length of stay discounts', () => {
  const discounts = [
    { label: 'Weekly', minNights: 7, discountBps: 1_000 },
    { label: 'Monthly', minNights: 28, discountBps: 2_000 }
  ];


describe('computeQuote', () => {
  it('prices a Lagos one-nighter as partner rate + disclosed service fee + VAT', () => {
    const quote = computeQuote({
      stay: { checkIn: '2026-04-10', checkOut: '2026-04-11' },
      nightlyRateKobo: 15_000_000, // NGN 150,000 - exactly what the partner charges
      policy: lagosPolicy
    });

    expect(quote.nights).toBe(1);
    expect(quote.roomSubtotalKobo).toBe(15_000_000);
    // 12% of 150,000 = 18,000, already a multiple of NGN 50
    expect(quote.serviceFeeKobo).toBe(1_800_000);
    // 7.5% of 18,000 = 1,350
    expect(quote.serviceFeeVatKobo).toBe(135_000);
    expect(quote.totalKobo).toBe(16_935_000); // NGN 169,350
    expect(quote.partnerNetKobo).toBe(15_000_000);
    expect(quote.platformNetKobo).toBe(1_935_000);
    expect(quote.currency).toBe('NGN');
  });

  it('always keeps partner + platform equal to the charged total', () => {
    const scenarios = [
      { nights: 1, rate: 15_000_000, policy: lagosPolicy },
      { nights: 4, rate: 8_500_000, policy: lagosPolicy },
      { nights: 20, rate: 4_000_000, policy: owerriPolicy },
      { nights: 2, rate: 120_000_000, policy: globalPolicy },
      { nights: 9, rate: 350_000, policy: owerriPolicy }
    ];

    for (const scenario of scenarios) {
      const quote = computeQuote({
        stay: {
          checkIn: '2026-05-01',
          checkOut: `2026-05-${String(scenario.nights + 1).padStart(2, '0')}`
        },
        nightlyRateKobo: scenario.rate,
        policy: scenario.policy
      });
      expect(quote.partnerNetKobo + quote.platformNetKobo).toBe(quote.totalKobo);
      expect(quote.partnerNetKobo).toBeGreaterThan(0);
      expect(quote.platformNetKobo).toBeGreaterThan(0);
    }
  });

  it('never charges more than the total it prints, line by line', () => {
    const quote = computeQuote({
      stay: { checkIn: '2026-06-01', checkOut: '2026-06-08' },
      nightlyRateKobo: 5_000_000,
      policy: lagosPolicy,
      cleaningFeeKobo: 1_500_000,
      extraGuests: 2,
      extraGuestFeePerNightKobo: 500_000,
      discounts: [{ label: 'Weekly -10%', minNights: 7, discountBps: 1_000 }]
    });

    const lineSum = quote.lines.reduce((total, line) => total + line.amountKobo, 0);
    expect(lineSum).toBe(quote.totalKobo);
    expect(quote.lines.every((line) => line.customerVisible)).toBe(true);
    // The disclosure is only honest if the fee line is present and labelled.
    expect(quote.lines.some((line) => line.key === 'service_fee')).toBe(true);
    expect(quote.lines.some((line) => line.key === 'los_discount' && line.amountKobo < 0)).toBe(true);
  });

  it('computes the fee on discounted room revenue, not the pre-discount subtotal', () => {
    // Uncapped so we can see the fee base itself rather than the Lagos cap.
    const uncapped: FeePolicy = { ...lagosPolicy, id: 'test-uncapped', maxFeeKobo: null };
    const quote = computeQuote({
      stay: { checkIn: '2026-06-01', checkOut: '2026-06-11' },
      nightlyRateKobo: 10_000_000, // 10 nights = NGN 1,000,000
      policy: uncapped,
      discounts: [{ label: 'Loyalty -10%', minNights: 10, discountBps: 1_000 }]
    });

    expect(quote.roomSubtotalKobo).toBe(100_000_000);
    expect(quote.discountTotalKobo).toBe(10_000_000);
    // 12% of 90,000,000 = 10,800,000
    expect(quote.serviceFeeKobo).toBe(10_800_000);
    expect(quote.partnerNetKobo).toBe(90_000_000);
  });

  it('caps a big Lagos booking at the state cap instead of the percentage', () => {
    const quote = computeQuote({
      stay: { checkIn: '2026-06-01', checkOut: '2026-06-11' },
      nightlyRateKobo: 10_000_000,
      policy: lagosPolicy,
      discounts: [{ label: 'Loyalty -10%', minNights: 10, discountBps: 1_000 }]
    });

    // 12% would be NGN 108,000; the Lagos cap is NGN 80,000
    expect(quote.serviceFeeKobo).toBe(8_000_000);
  });

  it('applies the per-night floor in high-demand markets', () => {
    const quote = computeQuote({
      stay: { checkIn: '2026-07-01', checkOut: '2026-07-02' },
      nightlyRateKobo: 1_000_000, // NGN 10,000 cheap unit
      policy: lagosPolicy
    });
    // 12% would be NGN 1,200; the Lagos floor is NGN 3,000
    expect(quote.serviceFeeKobo).toBe(300_000);
  });

  it('applies the cap on very large bookings', () => {
    const quote = computeQuote({
      stay: { checkIn: '2026-07-01', checkOut: '2026-07-08' },
      nightlyRateKobo: 100_000_000, // NGN 1,000,000 per night
      policy: globalPolicy
    });
    expect(quote.serviceFeeKobo).toBe(globalPolicy.maxFeeKobo);
  });

  it('rejects a non-positive nightly rate', () => {
    expect(() =>
      computeQuote({
        stay: { checkIn: '2026-08-01', checkOut: '2026-08-02' },
        nightlyRateKobo: 0,
        policy: globalPolicy
      })
    ).toThrow(PricingError);
  });

  it('rejects an absurd fee rate rather than overcharging a guest', () => {
    expect(() =>
      computeQuote({
        stay: { checkIn: '2026-08-01', checkOut: '2026-08-02' },
        nightlyRateKobo: 1_000_000,
        policy: { ...globalPolicy, rateBps: 9_000 }
      })
    ).toThrow(PricingError);
  });
});

  it('picks the best applicable tier', () => {
    expect(selectLengthOfStayDiscount(discounts, 3)).toBeUndefined();
    expect(selectLengthOfStayDiscount(discounts, 7)?.label).toBe('Weekly');
    expect(selectLengthOfStayDiscount(discounts, 30)?.label).toBe('Monthly');
  });
});
