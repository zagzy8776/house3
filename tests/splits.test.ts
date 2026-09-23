import { describe, expect, it } from 'vitest';
import { computeProcessorFee, computeSplits, toFlutterwaveRatios, SplitError } from '@/domain/splits';
import { computeQuote } from '@/domain/pricing';
import { defaultFeePolicy, STATE_FEE_POLICIES } from '@/data/feePolicies';
import { addDays } from '@/domain/dates';

/** Paystack local NGN card pricing: 1.5% + NGN 100, capped at NGN 2,000. */
const paystackLocal = { rateBps: 150, flatKobo: 10_000, capKobo: 200_000 };

const lagosPolicy = STATE_FEE_POLICIES.find((policy) => policy.subjectId === 'LA')!;

function quoteFor(nightlyRateKobo: number, nights = 1, policy = lagosPolicy) {
  return computeQuote({
    stay: { checkIn: '2026-04-10', checkOut: addDays('2026-04-10', nights) },
    nightlyRateKobo,
    policy
  });
}

describe('processor fee forecasting', () => {
  it('applies rate, flat fee and cap', () => {
    // 1.5% of NGN 10,000 = NGN 150, + NGN 100 = NGN 250 (uncapped)
    expect(computeProcessorFee(1_000_000, paystackLocal)).toBe(25_000);
    // Large charge hits the NGN 2,000 cap
    expect(computeProcessorFee(100_000_000, paystackLocal)).toBe(200_000);
    // Zero charge costs nothing
    expect(computeProcessorFee(0, paystackLocal)).toBe(0);
  });
});

describe('computeSplits', () => {
  it('splits a NGN 169,350 Lagos booking: partner gets their full rate, platform nets the rest', () => {
    const quote = quoteFor(15_000_000);
    expect(quote.totalKobo).toBe(16_935_000);

    const split = computeSplits({ quote, processorFee: paystackLocal, bearer: 'platform' });

    expect(split.partnerShareKobo).toBe(15_000_000); // partner gets exactly NGN 150,000
    expect(split.processorFeeKobo).toBe(200_000); // capped at NGN 2,000
    expect(split.platformShareKobo).toBe(1_735_000); // NGN 17,350 net of processing
    expect(split.partnerShareKobo + split.platformShareKobo + split.processorFeeKobo).toBe(quote.totalKobo);
  });

  it('protects the platform fee when the partner bears the processor fee', () => {
    const quote = quoteFor(15_000_000);
    const split = computeSplits({ quote, processorFee: paystackLocal, bearer: 'partner' });

    expect(split.partnerShareKobo).toBe(15_000_000 - 200_000);
    expect(split.platformShareKobo).toBe(1_935_000);
    expect(split.platformShareKobo + split.partnerShareKobo + split.processorFeeKobo).toBe(quote.totalKobo);
  });

  it('honours a partner-specific withholding', () => {
    const quote = quoteFor(15_000_000);
    const split = computeSplits({
      quote,
      processorFee: paystackLocal,
      bearer: 'platform',
      platformWithholdingFromPartnerKobo: 500_000
    });

    expect(split.partnerShareKobo).toBe(14_500_000);
    expect(split.partnerShareKobo + split.platformShareKobo + split.processorFeeKobo).toBe(quote.totalKobo);
  });

  it('holds the invariant across a wide random sweep of bookings', () => {
    const policies = [defaultFeePolicy(), ...STATE_FEE_POLICIES];
    let checked = 0;

    for (let index = 0; index < 500; index += 1) {
      const nightlyRateKobo = 50_000 + Math.floor(Math.random() * 90_000_000);
      const nights = 1 + Math.floor(Math.random() * 30);
      const policy = policies[index % policies.length]!;
      const bearer = index % 2 === 0 ? 'platform' : 'partner';
      const quote = quoteFor(nightlyRateKobo, nights, policy);

      let split;
      try {
        split = computeSplits({ quote, processorFee: paystackLocal, bearer });
      } catch (error) {
        // The only acceptable failure is "the fee does not cover processing" on
        // a deliberately tiny booking. Anything else is a bug.
        expect(error).toBeInstanceOf(SplitError);
        continue;
      }

      expect(split.partnerShareKobo + split.platformShareKobo + split.processorFeeKobo).toBe(quote.totalKobo);
      expect(split.partnerShareKobo).toBeGreaterThan(0);
      expect(split.flutterwave.partnerRatioPercent + split.flutterwave.platformRatioPercent).toBe(100);
      checked += 1;
    }

    expect(checked).toBeGreaterThan(450);
  });

  it('refuses to split when the disclosed fee cannot cover processing', () => {
    const zeroFeePolicy = { ...defaultFeePolicy(), id: 'zero', rateBps: 0, minFeeKobo: 0, maxFeeKobo: 0 };
    const quote = quoteFor(100_000, 1, zeroFeePolicy);

    expect(() => computeSplits({ quote, processorFee: paystackLocal, bearer: 'platform' })).toThrow(SplitError);
  });
});

describe('flutterwave ratios', () => {
  it('gives the partner the floor percent and the platform the remainder', () => {
    const ratios = toFlutterwaveRatios(1_000, 3_000);
    expect(ratios.partnerRatioPercent).toBe(25);
    expect(ratios.platformRatioPercent).toBe(75);
  });

  it('keeps the ratios summing to 100 even when uneven', () => {
    const ratios = toFlutterwaveRatios(15_000_000, 1_935_000);
    expect(ratios.partnerRatioPercent).toBe(88);
    expect(ratios.platformRatioPercent).toBe(12);
  });
});
