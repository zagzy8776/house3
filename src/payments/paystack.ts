/**
 * Paystack integration.
 *
 * Paystack is the primary processor because it supports the exact mechanic this
 * business needs out of the box:
 *
 *   1. The partner creates/links a Subaccount (their settlement bank account).
 *   2. We initialise ONE charge for the full displayed total, passing
 *      `subaccount` + `transaction_charge` (flat kobo to the partner) and
 *      `bearer` (who eats the Paystack fee).
 *   3. Paystack splits on settlement: the partner's share settles into their own
 *      account and the platform retains its service fee + VAT.
 *
 * The guest never sees two payments, and we never hold the partner's money in
 * our own account waiting to pay out manually.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SplitResult } from '@/domain/splits';
import type { Quote } from '@/domain/pricing';

export type PaystackInitRequest = {
  email: string;
  amountKobo: number;
  reference: string;
  subaccountCode: string;
  transactionChargeKobo: number;
  bearer: 'platform' | 'partner';
  callbackUrl: string;
  metadata: Record<string, unknown>;
  currency?: 'NGN';
  channels?: readonly ('card' | 'bank' | 'ussd' | 'bank_transfer' | 'qr' | 'mobile_money')[];
};

export type PaystackInitResponse = {
  status: boolean;
  message: string;
  data?: { authorization_url: string; access_code: string; reference: string };
};

export class PaystackError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'PaystackError';
  }
}

const PAYSTACK_BASE = 'https://api.paystack.co';

/**
 * Build the exact request for POST /transaction/initialize.
 * Pure function so it can be asserted in tests without network access.
 */
export function buildInitRequest(input: {
  quote: Quote;
  split: SplitResult;
  email: string;
  reference: string;
  subaccountCode: string;
  callbackUrl: string;
  bookingId: string;
}): PaystackInitRequest {
  const { quote, split } = input;

  if (!input.subaccountCode.startsWith('ACCT_')) {
    throw new PaystackError(`Invalid Paystack subaccount code: "${input.subaccountCode}"`);
  }
  if (split.paystack.transactionChargeKobo >= quote.totalKobo) {
    throw new PaystackError(
      'Partner transaction charge must be less than the charge total, otherwise House3 earns nothing'
    );
  }
  if (!/^[a-zA-Z0-9._-]{6,}$/.test(input.reference)) {
    throw new PaystackError(`Reference must be 6+ safe characters, received "${input.reference}"`);
  }

  return {
    email: input.email,
    amountKobo: quote.totalKobo,
    reference: input.reference,
    subaccountCode: input.subaccountCode,
    transactionChargeKobo: split.paystack.transactionChargeKobo,
    bearer: split.paystack.bearer,
    callbackUrl: input.callbackUrl,
    currency: 'NGN',
    channels: ['card', 'bank', 'ussd', 'bank_transfer'],
    metadata: {
      bookingId: input.bookingId,
      policyId: quote.policyId,
      nights: quote.nights,
      checkIn: quote.stay.checkIn,
      checkOut: quote.stay.checkOut,
      // Full, auditable disclosure is stored with every charge.
      breakdown: quote.lines.map((line) => ({
        key: line.key,
        label: line.label,
        amountKobo: line.amountKobo
      })),
      partnerNetKobo: quote.partnerNetKobo,
      platformNetKobo: quote.platformNetKobo
    }
  };
}

export type PaystackClientOptions = {
  secretKey: string;
  fetchImpl?: typeof fetch;
};

export class PaystackClient {
  private readonly secretKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PaystackClientOptions) {
    if (!options.secretKey) throw new PaystackError('Paystack secret key is required');
    this.secretKey = options.secretKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async initializeTransaction(request: PaystackInitRequest): Promise<PaystackInitResponse> {
    const response = await this.fetchImpl(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(toPaystackWirePayload(request))
    });

    const body = (await response.json()) as PaystackInitResponse;
    if (!response.ok || !body.status) {
      throw new PaystackError(`Paystack initialize failed: ${body.message ?? response.status}`, body);
    }
    return body;
  }

  /** GET /transaction/verify/:reference - always verify server-side before confirming. */
  async verifyTransaction(reference: string): Promise<{
    status: string;
    amountKobo: number;
    currency: string;
    reference: string;
  }> {
    const response = await this.fetchImpl(
      `${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: this.headers() }
    );
    const body = (await response.json()) as {
      status: boolean;
      data?: { status: string; amount: number; currency: string; reference: string };
    };
    if (!response.ok || !body.status || !body.data) {
      throw new PaystackError(`Paystack verify failed for ${reference}`, body);
    }
    return {
      status: body.data.status,
      amountKobo: body.data.amount,
      currency: body.data.currency,
      reference: body.data.reference
    };
  }

  /** POST /subaccount - run once per partner during onboarding. */
  async createSubaccount(input: {
    businessName: string;
    settlementBank: string;
    accountNumber: string;
    percentageCharge: number;
  }): Promise<{ subaccountCode: string }> {
    const response = await this.fetchImpl(`${PAYSTACK_BASE}/subaccount`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        business_name: input.businessName,
        settlement_bank: input.settlementBank,
        account_number: input.accountNumber,
        percentage_charge: input.percentageCharge
      })
    });
    const body = (await response.json()) as {
      status: boolean;
      message?: string;
      data?: { subaccount_code: string };
    };
    if (!response.ok || !body.status || !body.data) {
      throw new PaystackError(`Paystack subaccount creation failed: ${body.message ?? response.status}`, body);
    }
    return { subaccountCode: body.data.subaccount_code };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/json'
    };
  }
}

/**
 * Verify a webhook body against the `x-paystack-signature` header.
 * Paystack sends HMAC-SHA512 of the raw request body using your secret key.
 */
export function verifyPaystackSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  secretKey: string;
}): boolean {
  const { rawBody, signatureHeader, secretKey } = input;
  if (!signatureHeader) return false;
  const expected = createHmac('sha512', secretKey).update(rawBody, 'utf8').digest('hex');
  const provided = signatureHeader.trim().toLowerCase();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
}

/** Paystack expects snake_case field names on the wire. */
export function toPaystackWirePayload(request: PaystackInitRequest): Record<string, unknown> {
  return {
    email: request.email,
    amount: request.amountKobo,
    reference: request.reference,
    subaccount: request.subaccountCode,
    transaction_charge: request.transactionChargeKobo,
    bearer: request.bearer,
    callback_url: request.callbackUrl,
    currency: request.currency ?? 'NGN',
    channels: request.channels ?? ['card', 'bank', 'ussd', 'bank_transfer'],
    metadata: request.metadata
  };
}
