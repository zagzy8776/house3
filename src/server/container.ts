/**
 * Composition root.
 *
 * Wires the repository, the inventory/booking services and the payment gateway
 * from environment configuration. Nothing in `src/domain` or `src/server` reads
 * process.env — everything flows from here, which is what keeps the tests
 * deterministic.
 *
 * NOTE for production: replace `InMemoryRepository` with a Prisma-backed
 * implementation of the same `Repository` interface. The in-memory store is
 * process-local, so it is correct for a single-instance demo and for tests, but
 * it does not survive a restart or a second server instance.
 */

import { allFeePolicies, envEnum, envInt } from '@/data/feePolicies';
import { PaystackClient, buildInitRequest, type PaystackInitRequest } from '@/payments/paystack';
import type { FeeBearer, ProcessorFeeModel } from '@/domain/splits';
import { createBookingService, type BookingService, type PaymentGateway } from './bookingService';
import { DEMO_PARTNERS, DEMO_UNITS, seedAvailability } from './demoInventory';
import { InMemoryRepository, type Repository } from './store';

export type Container = {
  repo: Repository;
  service: BookingService;
  gateway: PaymentGateway;
  processorFee: ProcessorFeeModel;
  bearer: FeeBearer;
  /** True when a live processor secret is configured. */
  livePayments: boolean;
  /** True when the fake gateway is in use (never allowed with live keys). */
  demoPayments: boolean;
};

class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/** Processor pricing model, used both to forecast margin and to bound bearer rules. */
function processorFeeModel(): ProcessorFeeModel {
  return {
    rateBps: envInt('PAYSTACK_FEE_RATE_BPS', 150),
    flatKobo: envInt('PAYSTACK_FEE_FLAT_KOBO', 10_000),
    capKobo: envInt('PAYSTACK_FEE_CAP_KOBO', 200_000)
  };
}

/**
 * Development-only gateway.
 *
 * It produces a checkout URL that the app itself serves, so the whole funnel can
 * be walked end to end before any processor account exists. It is refused in
 * production, because a "pretend payment" in production is how platforms end up
 * confirming bookings nobody paid for.
 */
function createDemoGateway(): PaymentGateway {
  const charges = new Map<string, { paid: boolean; amountKobo: number }>();
  let sequence = 0;

  return {
    processor: 'PAYSTACK',
    async initialize(input) {
      sequence += 1;
      const processorRef = `demo_${Date.now()}_${sequence}`;
      charges.set(processorRef, { paid: true, amountKobo: input.amountKobo });
      return { processorRef, checkoutUrl: `/api/dev/checkout/${processorRef}` };
    },
    async verify(processorRef) {
      return charges.get(processorRef) ?? { paid: false, amountKobo: 0 };
    }
  };
}

function createPaystackGateway(secretKey: string, baseUrl: string): PaymentGateway {
  const client = new PaystackClient({ secretKey });

  return {
    processor: 'PAYSTACK',
    async initialize(input) {
      // Build the request through the domain-aware helper so the split fields and
      // the audit metadata can never drift from what was quoted.
      const request: PaystackInitRequest = {
        email: input.email,
        amountKobo: input.amountKobo,
        reference: input.reference,
        subaccountCode: input.subaccountCode,
        transactionChargeKobo: input.transactionChargeKobo,
        bearer: input.bearer,
        callbackUrl: `${baseUrl}/checkout/return`,
        metadata: { bookingId: input.bookingId }
      };

      const response = await client.initializeTransaction(request);
      const data = response.data;
      if (!data) throw new ConfigurationError('Paystack returned no authorization data');
      return { processorRef: data.reference, checkoutUrl: data.authorization_url };
    },
    async verify(processorRef) {
      const result = await client.verifyTransaction(processorRef);
      return { paid: result.status === 'success', amountKobo: result.amountKobo };
    }
  };
}

let cached: Container | null = null;

export function getContainer(): Container {
  if (cached) return cached;

  const secretKey = process.env.PAYSTACK_SECRET_KEY ?? '';
  const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:3000';
  const isProduction = process.env.NODE_ENV === 'production';
  const livePayments = secretKey.length > 0 && !secretKey.startsWith('sk_test_xxx');
  // Demo payments simulate a successful charge. They must be opted into
  // explicitly and are impossible while live keys are present.
  const demoPayments = !livePayments && process.env.ALLOW_DEMO_PAYMENTS === 'true';

  if (isProduction && !livePayments && !demoPayments) {
    throw new ConfigurationError(
      'PAYSTACK_SECRET_KEY must be configured in production ' +
        '(or set ALLOW_DEMO_PAYMENTS=true for a staging environment with no real money)'
    );
  }
  if (isProduction && demoPayments) {
    // eslint-disable-next-line no-console
    console.warn(
      '[house3] ALLOW_DEMO_PAYMENTS=true: charges are simulated. ' +
        'Unset this before you take real money.'
    );
  }

  const gateway = livePayments ? createPaystackGateway(secretKey, appBaseUrl) : createDemoGateway();
  const bearer = envEnum<FeeBearer>('PROCESSOR_FEE_BEARER', ['platform', 'partner'], 'platform');

  const repo = new InMemoryRepository({
    partners: DEMO_PARTNERS,
    units: DEMO_UNITS,
    availability: seedAvailability(DEMO_UNITS, { from: '2026-01-01', days: 400 })
  });

  const service = createBookingService({
    repo,
    gateway,
    policies: allFeePolicies(),
    processorFee: processorFeeModel(),
    bearer,
    clock: () => new Date().toISOString(),
    generateId: (prefix) => `${prefix}_${globalThis.crypto.randomUUID().slice(0, 12)}`,
    callbackUrl: `${appBaseUrl}/checkout/return`,
    holdTtlMinutes: 15
  });

  cached = {
    repo,
    service,
    gateway,
    processorFee: processorFeeModel(),
    bearer,
    livePayments,
    demoPayments
  };
  return cached;
}

export { buildInitRequest };
