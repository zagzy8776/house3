import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  buildInitRequest,
  PaystackError,
  toPaystackWirePayload,
  verifyPaystackSignature
} from '@/payments/paystack';
import {
  buildFlutterwaveRequest,
  FlutterwaveError,
  toFlutterwaveAmountNaira,
  verifyFlutterwaveHash
} from '@/payments/flutterwave';
import { computeSplits } from '@/domain/splits';
import { computeQuote } from '@/domain/pricing';
import { STATE_FEE_POLICIES } from '@/data/feePolicies';

const lagosPolicy = STATE_FEE_POLICIES.find((policy) => policy.subjectId === 'LA')!;
const paystackLocal = { rateBps: 150, flatKobo: 10_000, capKobo: 200_000 };

const quote = computeQuote({
  stay: { checkIn: '2026-04-10', checkOut: '2026-04-11' },
  nightlyRateKobo: 15_000_000,
  policy: lagosPolicy
});
const split = computeSplits({ quote, processorFee: paystackLocal, bearer: 'platform' });

const base = {
  quote,
  split,
  email: 'guest@example.com',
  reference: 'H3-LA-000123',
  subaccountCode: 'ACCT_partner_lekki',
  callbackUrl: 'https://house3.ng/checkout/return',
  bookingId: 'bk_123'
};

describe('paystack initialize request', () => {
  it('charges the full disclosed total and routes the partner share', () => {
    const request = buildInitRequest(base);
    expect(request.amountKobo).toBe(16_935_000);
    expect(request.transactionChargeKobo).toBe(15_000_000);
    expect(request.bearer).toBe('platform');
    expect(request.currency).toBe('NGN');
  });

  it('carries the full price breakdown in metadata for audit', () => {
    const request = buildInitRequest(base);
    const metadata = request.metadata as { breakdown: { key: string; amountKobo: number }[] };
    expect(metadata.breakdown.map((line) => line.key)).toEqual(['room', 'service_fee', 'service_fee_vat']);
    expect(request.metadata.partnerNetKobo).toBe(15_000_000);
    expect(request.metadata.platformNetKobo).toBe(1_935_000);
  });

  it('emits the snake_case wire payload Paystack expects', () => {
    const wire = toPaystackWirePayload(buildInitRequest(base));
    expect(wire).toMatchObject({
      amount: 16_935_000,
      subaccount: 'ACCT_partner_lekki',
      transaction_charge: 15_000_000,
      callback_url: 'https://house3.ng/checkout/return',
      currency: 'NGN'
    });
    expect(wire).not.toHaveProperty('subaccountCode');
  });

  it('rejects a malformed subaccount code', () => {
    expect(() => buildInitRequest({ ...base, subaccountCode: 'partner_1' })).toThrow(PaystackError);
  });

  it('rejects a charge that would leave the platform nothing', () => {
    const zeroFee = computeQuote({
      stay: { checkIn: '2026-04-10', checkOut: '2026-04-11' },
      nightlyRateKobo: 15_000_000,
      policy: { ...lagosPolicy, rateBps: 0, minFeeKobo: 0, maxFeeKobo: 0, minNightlyFeeKobo: 0 }
    });
    const badSplit = {
      ...split,
      paystack: { transactionChargeKobo: zeroFee.totalKobo, bearer: 'platform' as const }
    };
    expect(() => buildInitRequest({ ...base, quote: zeroFee, split: badSplit })).toThrow(/must be less than/);
  });

  it('rejects an unsafe reference', () => {
    expect(() => buildInitRequest({ ...base, reference: 'a b' })).toThrow(PaystackError);
  });
});

describe('paystack webhook signature', () => {
  const secret = 'sk_test_secret';
  const body = JSON.stringify({ event: 'charge.success', data: { reference: 'H3-LA-000123' } });
  const signature = createHmac('sha512', secret).update(body, 'utf8').digest('hex');

  it('accepts a correctly signed webhook', () => {
    expect(verifyPaystackSignature({ rawBody: body, signatureHeader: signature, secretKey: secret })).toBe(true);
  });

  it('accepts an uppercase signature header', () => {
    expect(
      verifyPaystackSignature({ rawBody: body, signatureHeader: signature.toUpperCase(), secretKey: secret })
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    const tampered = body.replace('H3-LA-000123', 'H3-LA-999999');
    expect(verifyPaystackSignature({ rawBody: tampered, signatureHeader: signature, secretKey: secret })).toBe(false);
  });

describe('flutterwave initialize request', () => {
  const fwBase = {
    quote,
    split,
    partnerSubaccountId: 'RS_PARTNER_1',
    txRef: 'H3-LA-000123',
    redirectUrl: 'https://house3.ng/checkout/return',
    customer: { email: 'guest@example.com', name: 'Ada Obi', phone: '08030000000' },
    bookingId: 'bk_123'
  };

  it('converts kobo to naira for the payment link', () => {
    expect(toFlutterwaveAmountNaira(16_935_000)).toBe(169_350);
  });

  it('sends the partner split ratio and platform metadata', () => {
    const request = buildFlutterwaveRequest(fwBase);
    expect(request.amountNaira).toBe(169_350);
    expect(request.subaccounts).toEqual([{ subaccountId: 'RS_PARTNER_1', transactionSplitRatio: 88 }]);
    expect(request.meta.bookingId).toBe('bk_123');
  });

  it('refuses bookings where the platform ratio would round to zero', () => {
    const tiny = { ...split, flutterwave: { partnerRatioPercent: 100, platformRatioPercent: 0 } };
    expect(() => buildFlutterwaveRequest({ ...fwBase, split: tiny })).toThrow(FlutterwaveError);
  });
});

describe('flutterwave webhook hash', () => {
  it('accepts the exact configured hash', () => {
    expect(verifyFlutterwaveHash({ hashHeader: 'abc123', expectedHash: 'abc123' })).toBe(true);
  });

  it('rejects a mismatched or missing hash', () => {
    expect(verifyFlutterwaveHash({ hashHeader: 'abc124', expectedHash: 'abc123' })).toBe(false);
    expect(verifyFlutterwaveHash({ hashHeader: null, expectedHash: 'abc123' })).toBe(false);
    expect(verifyFlutterwaveHash({ hashHeader: 'abc123', expectedHash: '' })).toBe(false);
  });
});


  it('rejects a missing signature', () => {
    expect(verifyPaystackSignature({ rawBody: body, signatureHeader: null, secretKey: secret })).toBe(false);
  });

  it('rejects a wrong-length signature without throwing', () => {
    expect(verifyPaystackSignature({ rawBody: body, signatureHeader: 'abc', secretKey: secret })).toBe(false);
  });
});
