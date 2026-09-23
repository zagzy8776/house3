/**
 * Flutterwave integration (secondary processor).
 *
 * Used for partners who settle through Flutterwave, and as a fallback if a
 * Paystack account is restricted mid-rollout.
 *
 * IMPORTANT DIFFERENCE: Flutterwave splits by RATIO (integer percentages that
 * must total 100), not by flat amount. So the partner/platform percentage has to
 * be computed up front and the remainder assigned to the platform - see
 * `toFlutterwaveRatios` in src/domain/splits.ts. Because ratios are whole
 * percent, we refuse to route very small platform shares to Flutterwave.
 */

import { timingSafeEqual } from 'node:crypto';
import type { SplitResult } from '@/domain/splits';
import type { Quote } from '@/domain/pricing';

export type FlutterwaveSplit = {
  subaccountId: string;
  transactionSplitRatio: number;
};

export type FlutterwaveInitRequest = {
  txRef: string;
  amountNaira: number;
  currency: 'NGN';
  redirectUrl: string;
  customer: { email: string; name: string; phonenumber: string };
  paymentOptions: string;
  subaccounts: FlutterwaveSplit[];
  meta: Record<string, unknown>;
};

export class FlutterwaveError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'FlutterwaveError';
  }
}

const FLUTTERWAVE_BASE = 'https://api.flutterwave.com/v3';

/** Flutterwave takes naira (not kobo) for the payment link amount. */
export function toFlutterwaveAmountNaira(totalKobo: number): number {
  return Math.round(totalKobo) / 100;
}

export function buildFlutterwaveRequest(input: {
  quote: Quote;
  split: SplitResult;
  partnerSubaccountId: string;
  txRef: string;
  redirectUrl: string;
  customer: { email: string; name: string; phone: string };
  bookingId: string;
}): FlutterwaveInitRequest {
  const { quote, split } = input;

  if (split.flutterwave.platformRatioPercent < 1) {
    throw new FlutterwaveError(
      'Platform ratio would round below 1% on Flutterwave; use Paystack for this booking ' +
        'or route the guest to the partner checkout'
    );
  }

  return {
    txRef: input.txRef,
    amountNaira: toFlutterwaveAmountNaira(quote.totalKobo),
    currency: 'NGN',
    redirectUrl: input.redirectUrl,
    customer: {
      email: input.customer.email,
      name: input.customer.name,
      phonenumber: input.customer.phone
    },
    paymentOptions: 'card',
    subaccounts: [
      { subaccountId: input.partnerSubaccountId, transactionSplitRatio: split.flutterwave.partnerRatioPercent }
    ],
    meta: {
      bookingId: input.bookingId,
      breakdown: quote.lines.map((line) => ({ key: line.key, label: line.label, amountKobo: line.amountKobo })),
      partnerNetKobo: quote.partnerNetKobo,
      platformNetKobo: quote.platformNetKobo
    }
  };
}


export type FlutterwaveClientOptions = {
  secretKey: string;
  fetchImpl?: typeof fetch;
};

export class FlutterwaveClient {
  private readonly secretKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FlutterwaveClientOptions) {
    if (!options.secretKey) throw new FlutterwaveError('Flutterwave secret key is required');
    this.secretKey = options.secretKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async initializePayment(request: FlutterwaveInitRequest): Promise<{ link: string; txRef: string }> {
    const response = await this.fetchImpl(`${FLUTTERWAVE_BASE}/payments`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        tx_ref: request.txRef,
        amount: request.amountNaira,
        currency: request.currency,
        redirect_url: request.redirectUrl,
        payment_options: request.paymentOptions,
        customer: request.customer,
        subaccounts: request.subaccounts.map((split) => ({
          id: split.subaccountId,
          transaction_split_ratio: split.transactionSplitRatio
        })),
        meta: request.meta
      })
    });

    const body = (await response.json()) as {
      status: string;
      message?: string;
      data?: { link: string };
    };
    if (!response.ok || body.status !== 'success' || !body.data) {
      throw new FlutterwaveError(`Flutterwave initialize failed: ${body.message ?? response.status}`, body);
    }
    return { link: body.data.link, txRef: request.txRef };
  }

  /** Verify by tx_ref (GET /transactions/verify_by_reference). */
  async verifyByReference(txRef: string): Promise<{
    status: string;
    amountNaira: number;
    currency: string;
    txRef: string;
    id: number;
  }> {
    const url = `${FLUTTERWAVE_BASE}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`;
    const response = await this.fetchImpl(url, { headers: this.headers() });
    const body = (await response.json()) as {
      status: string;
      data?: { status: string; amount: number; currency: string; tx_ref: string; id: number };
    };
    if (!response.ok || body.status !== 'success' || !body.data) {
      throw new FlutterwaveError(`Flutterwave verify failed for ${txRef}`, body);
    }
    return {
      status: body.data.status,
      amountNaira: body.data.amount,
      currency: body.data.currency,
      txRef: body.data.tx_ref,
      id: body.data.id
    };
  }

  /** GET /subaccounts - the subaccounts available for splitting. */
  async listSubaccounts(): Promise<{ id: string; accountName: string }[]> {
    const response = await this.fetchImpl(`${FLUTTERWAVE_BASE}/subaccounts`, { headers: this.headers() });
    const body = (await response.json()) as {
      status: string;
      data?: { id: number; account_name: string }[];
    };
    if (!response.ok || body.status !== 'success') {
      throw new FlutterwaveError('Flutterwave subaccount listing failed', body);
    }
    return (body.data ?? []).map((entry) => ({ id: String(entry.id), accountName: entry.account_name }));
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/json'
    };
  }
}

/** Flutterwave webhooks carry a static secret hash in the `verif-hash` header. */
export function verifyFlutterwaveHash(input: {
  hashHeader: string | null;
  expectedHash: string;
}): boolean {
  if (!input.hashHeader || !input.expectedHash) return false;
  const provided = Buffer.from(input.hashHeader.trim(), 'utf8');
  const expected = Buffer.from(input.expectedHash.trim(), 'utf8');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
