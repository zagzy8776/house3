import { describe, expect, it } from 'vitest';
import { addDays } from '@/domain/dates';
import type { FeePolicy } from '@/domain/pricing';
import { allFeePolicies } from '@/data/feePolicies';
import { InMemoryRepository, type ListedUnit } from '@/server/store';
import {
  buildLedgerEntries,
  buildReference,
  createBookingService,
  type PaymentGateway
} from '@/server/bookingService';
import { DEMO_PARTNERS, DEMO_UNITS, seedAvailability } from '@/server/demoInventory';

const START = '2026-06-01';
const NOW = '2026-05-20T08:00:00.000Z';

/** Paystack local NGN card pricing: 1.5% + NGN 100, capped at NGN 2,000. */
const paystackLocal = { rateBps: 150, flatKobo: 10_000, capKobo: 200_000 };

/** Records every init/verify call so assertions can inspect the split sent out. */
class FakeGateway implements PaymentGateway {
  readonly processor = 'PAYSTACK' as const;
  readonly initialized: {
    bookingId: string;
    reference: string;
    amountKobo: number;
    subaccountCode: string;
    transactionChargeKobo: number;
  }[] = [];

  private readonly charges = new Map<string, { paid: boolean; amountKobo: number }>();
  private sequence = 0;

  async initialize(input: {
    bookingId: string;
    reference: string;
    email: string;
    subaccountCode: string;
    amountKobo: number;
    transactionChargeKobo: number;
  }): Promise<{ processorRef: string; checkoutUrl: string }> {
    this.sequence += 1;
    const processorRef = `ps_ref_${this.sequence}`;
    this.initialized.push({
      bookingId: input.bookingId,
      reference: input.reference,
      amountKobo: input.amountKobo,
      subaccountCode: input.subaccountCode,
      transactionChargeKobo: input.transactionChargeKobo
    });
    // Assume the guest pays exactly what was quoted unless a test overrides it.
    this.charges.set(processorRef, { paid: true, amountKobo: input.amountKobo });
    return { processorRef, checkoutUrl: `https://checkout.paystack.test/${processorRef}` };
  }

  async verify(processorRef: string): Promise<{ paid: boolean; amountKobo: number }> {
    return this.charges.get(processorRef) ?? { paid: false, amountKobo: 0 };
  }

  /** Simulate a partial or tampered settlement. */
  forceCharge(processorRef: string, amountKobo: number): void {
    this.charges.set(processorRef, { paid: true, amountKobo });
  }

  failCharge(processorRef: string): void {
    this.charges.set(processorRef, { paid: false, amountKobo: 0 });
  }
}

function setup(options: { policyOverride?: FeePolicy[]; units?: ListedUnit[] } = {}) {
  const units = options.units ?? DEMO_UNITS;
  const repo = new InMemoryRepository({
    partners: DEMO_PARTNERS,
    units,
    availability: seedAvailability(units, {
      from: '2026-05-01',
      days: 120,
      // The Ajah room is booked on 2026-06-05 via the partner's own channel.
      closedNights: { u_ajah_room: ['2026-06-05'] }
    })
  });

  const gateway = new FakeGateway();
  let counter = 0;
  let instant = NOW;

  const service = createBookingService({
    repo,
    gateway,
    policies: options.policyOverride ?? allFeePolicies(),
    processorFee: paystackLocal,
    bearer: 'platform',
    clock: () => instant,
    generateId: (prefix) => `${prefix}_${(counter += 1).toString().padStart(4, '0')}`,
    callbackUrl: 'https://house3.ng/checkout/return',
    holdTtlMinutes: 15
  });

  return {
    repo,
    gateway,
    service,
    advanceTo: (iso: string) => {
      instant = iso;
    }
  };
}

const guest = {
  name: 'Ada Obi',
  email: 'ada@example.com',
  phone: '08030000000',
  adults: 2,
  children: 0
};

describe('search', () => {
  it('returns bookable Lagos units sorted cheapest first', () => {
    const { service } = setup();
    const outcome = service.search({
      stateCode: 'LA',
      stay: { checkIn: START, checkOut: addDays(START, 1) },
      guests: 2
    });

    expect(outcome.nights).toBe(1);
    // The Lekki studio has a 2-night minimum, so a one-nighter rules it out.
    expect(outcome.results.map((result) => result.unit.id)).toEqual(['u_lekki_2bed']);

    const twoNights = service.search({
      stateCode: 'LA',
      stay: { checkIn: START, checkOut: addDays(START, 2) },
      guests: 2
    });
    expect(twoNights.results.map((result) => result.unit.id)).toEqual([
      'u_lekki_studio',
      'u_lekki_2bed',
      'u_ikoyi_3bed'
    ]);
  });

  it('excludes a partner with no verified settlement account', () => {
    const { service } = setup();
    const outcome = service.search({
      stateCode: 'LA',
      area: 'Ajah',
      stay: { checkIn: START, checkOut: addDays(START, 1) },
      guests: 1
    });

    expect(outcome.results).toHaveLength(0);
    expect(outcome.rejected[0]?.reasons).toContain('Partner has no settlement account');
    expect(outcome.rejected[0]?.reasons).toContain('Partner settlement account is not verified');
  });

  it('labels affiliate inventory as AFFILIATE instead of quoting it', () => {
    const units = DEMO_UNITS.map((unit) =>
      unit.id === 'u_ajah_room' ? { ...unit, bookable: false } : unit
    );
    const { service } = setup({ units });
    const outcome = service.search({
      stateCode: 'LA',
      area: 'Ajah',
      stay: { checkIn: START, checkOut: addDays(START, 1) },
      guests: 1
    });

    expect(outcome.results).toHaveLength(0);
    const affiliate = outcome.rejected.find((entry) => entry.unitId === 'u_ajah_room');
    expect(affiliate?.distribution).toBe('AFFILIATE');
    expect(affiliate?.reasons).toContain('Affiliate listing: completes on the partner site');
  });

  it('hides nights the partner closed on their own calendar', () => {
    const { service } = setup();
    const outcome = service.search({
      stateCode: 'LA',
      area: 'Ajah',
      stay: { checkIn: '2026-06-04', checkOut: '2026-06-06' },
      guests: 1
    });

    expect(outcome.results).toHaveLength(0);
  });

  it('reports units that cannot fit the party instead of quoting them', () => {
    const { service } = setup();
    const outcome = service.search({
      stateCode: 'AK',
      stay: { checkIn: START, checkOut: addDays(START, 1) },
      guests: 3
    });

    expect(outcome.results).toHaveLength(0);
    expect(outcome.rejected[0]?.reasons[0]).toMatch(/Sleeps 1/);
  });

  it('can quote every launch state', () => {
    const { service } = setup();
    for (const stateCode of ['LA', 'FC', 'OY', 'IM', 'AK']) {
      const outcome = service.search({
        stateCode,
        stay: { checkIn: START, checkOut: addDays(START, 2) },
        guests: 1
      });
      expect(outcome.results.length).toBeGreaterThan(0);
    }
  });
});

describe('disclosed pricing', () => {
  it('shows the partner rate, our service fee and VAT as separate lines', () => {
    const { service } = setup();
    const sellable = service.quoteUnit({
      unitId: 'u_lekki_2bed',
      stay: { checkIn: START, checkOut: addDays(START, 1) },
      guests: 2
    });

    expect(sellable.quote.roomSubtotalKobo).toBe(15_000_000);
    expect(sellable.quote.serviceFeeKobo).toBe(1_800_000);
    expect(sellable.quote.cleaningFeeKobo).toBe(1_000_000);
    expect(sellable.quote.lines.map((line) => line.key)).toEqual([
      'room',
      'cleaning_fee',
      'service_fee',
      'service_fee_vat'
    ]);
    // The listing names the operator; there is no anonymous "our price".
    expect(sellable.partner.displayName).toBe('Lekki Homes Ltd');
  });

  it('charges extra guests above the included occupancy', () => {
    const { service } = setup();
    const stay = { checkIn: START, checkOut: addDays(START, 1) };
    const twoGuests = service.quoteUnit({ unitId: 'u_lekki_2bed', stay, guests: 2 });
    const fourGuests = service.quoteUnit({ unitId: 'u_lekki_2bed', stay, guests: 4 });

    expect(fourGuests.quote.addonTotalKobo).toBe(1_000_000); // 2 extra x NGN 5,000 x 1 night
    expect(fourGuests.quote.totalKobo).toBeGreaterThan(twoGuests.quote.totalKobo);
  });
});

describe('checkout hold', () => {
  it('holds inventory and initialises a split charge for the full total', async () => {
    const { service, gateway } = setup();
    const { booking, checkoutUrl } = await service.startCheckout({
      unitId: 'u_lekki_2bed',
      stay: { checkIn: START, checkOut: addDays(START, 1) },
      guests: 2,
      guest
    });

    expect(booking.status).toBe('AWAITING_PAYMENT');
    expect(booking.reference).toMatch(/^H3-LA-/);
    expect(checkoutUrl).toContain('checkout.paystack.test');

    const init = gateway.initialized[0]!;
    expect(init.amountKobo).toBe(booking.quote.totalKobo);
    expect(init.subaccountCode).toBe('ACCT_lekki_homes');
    expect(init.transactionChargeKobo).toBe(booking.quote.partnerNetKobo);
    // The platform side of the split is the disclosed fee plus VAT.
    expect(init.amountKobo - init.transactionChargeKobo).toBe(
      booking.quote.serviceFeeKobo + booking.quote.serviceFeeVatKobo
    );
  });

  it('refuses to hold the same unit twice for overlapping dates', async () => {
    const { service } = setup();
    await service.startCheckout({
      unitId: 'u_lekki_2bed',
      stay: { checkIn: START, checkOut: addDays(START, 2) },
      guests: 2,
      guest
    });

    await expect(
      service.startCheckout({
        unitId: 'u_lekki_2bed',
        stay: { checkIn: addDays(START, 1), checkOut: addDays(START, 3) },
        guests: 2,
        guest
      })
    ).rejects.toThrow(/Cannot hold/);
  });

  it('still allows a back-to-back stay starting the day another guest leaves', async () => {
    const { service } = setup();
    await service.startCheckout({
      unitId: 'u_lekki_2bed',
      stay: { checkIn: START, checkOut: addDays(START, 2) },
      guests: 2,
      guest
    });

    const second = await service.startCheckout({
      unitId: 'u_lekki_2bed',
      stay: { checkIn: addDays(START, 2), checkOut: addDays(START, 4) },
      guests: 2,
      guest
    });

    expect(second.booking.status).toBe('AWAITING_PAYMENT');
  });
});

describe('payment confirmation', () => {
  it('confirms the booking and posts a balanced split ledger', async () => {
    const { service, repo } = setup();
    const { booking } = await service.startCheckout({
      unitId: 'u_lekki_2bed',
      stay: { checkIn: START, checkOut: addDays(START, 1) },
      guests: 2,
      guest
    });

    const result = await service.confirmPayment({ processorRef: booking.processorRef! });

    expect(result.alreadyProcessed).toBe(false);
    expect(result.booking.status).toBe('CONFIRMED');
    expect(result.booking.confirmedAt).toBe(NOW);

    const ledger = repo.listLedger(booking.id);
    const partnerLeg = ledger.find((entry) => entry.recipient === 'PARTNER')!;
    const feeLeg = ledger.find((entry) => entry.kind === 'SERVICE_FEE')!;
    const vatLeg = ledger.find((entry) => entry.kind === 'SERVICE_FEE_VAT')!;
    const costLeg = ledger.find((entry) => entry.kind === 'PROCESSOR_FEE')!;

    // The partner's ledger leg is their NGN 150,000 rate plus their NGN 10,000
    // cleaning passthrough: the passthrough is their money, not ours.
    expect(partnerLeg.amountKobo).toBe(16_000_000);
    expect(feeLeg.amountKobo).toBe(1_800_000);
    expect(vatLeg.amountKobo).toBe(135_000);
    expect(costLeg.amountKobo).toBe(-200_000); // processor cost borne by the platform

    const legTotal = ledger.reduce((sum, entry) => sum + entry.amountKobo, 0);
    expect(legTotal).toBe(result.booking.partnerShareKobo + result.booking.platformShareKobo);
  });

  it('is idempotent when the processor retries the webhook', async () => {
    const { service, repo } = setup();
    const { booking } = await service.startCheckout({
      unitId: 'u_owerri_2bed',
      stay: { checkIn: START, checkOut: addDays(START, 2) },
      guests: 2,
      guest
    });

    await service.confirmPayment({ processorRef: booking.processorRef! });
    const ledgerAfterFirst = repo.listLedger(booking.id).length;
    const second = await service.confirmPayment({ processorRef: booking.processorRef! });

    expect(second.alreadyProcessed).toBe(true);
    expect(second.booking.status).toBe('CONFIRMED');
    expect(repo.listLedger(booking.id)).toHaveLength(ledgerAfterFirst);
  });

  it('refuses to confirm when the settled amount does not match the quote', async () => {
    const { service, repo, gateway } = setup();
    const { booking } = await service.startCheckout({
      unitId: 'u_maitama_2bed',
      stay: { checkIn: START, checkOut: addDays(START, 1) },
      guests: 2,
      guest
    });
    gateway.forceCharge(booking.processorRef!, booking.quote.totalKobo - 500_000);

    await expect(service.confirmPayment({ processorRef: booking.processorRef! })).rejects.toThrow(
      /Amount mismatch/
    );
    expect(repo.getBooking(booking.id)?.status).toBe('FAILED');
    expect(repo.listLedger(booking.id)).toHaveLength(0);
  });

  it('marks the booking FAILED when the processor declines', async () => {
    const { service, repo, gateway } = setup();
    const { booking } = await service.startCheckout({
      unitId: 'u_ibadan_1bed',
      stay: { checkIn: START, checkOut: addDays(START, 1) },
      guests: 2,
      guest
    });
    gateway.failCharge(booking.processorRef!);

    const result = await service.confirmPayment({ processorRef: booking.processorRef! });

    expect(result.booking.status).toBe('FAILED');
    expect(repo.listLedger(booking.id)).toHaveLength(0);
  });
});

describe('hold expiry', () => {
  it('releases inventory abandoned at checkout so the next guest can book', async () => {
    const { service, advanceTo } = setup();
    const stay = { checkIn: START, checkOut: addDays(START, 2) };

    await service.startCheckout({ unitId: 'u_lekki_2bed', stay, guests: 2, guest });
    expect(
      service
        .search({ stateCode: 'LA', area: 'Lekki Phase 1', stay, guests: 2 })
        .results.map((result) => result.unit.id)
    ).not.toContain('u_lekki_2bed');

    // 16 minutes later the 15-minute hold has lapsed.
    advanceTo('2026-05-20T08:16:00.000Z');
    const expired = service.cancelExpiredHolds();

    expect(expired).toHaveLength(1);
    expect(expired[0]?.status).toBe('EXPIRED');
    expect(
      service
        .search({ stateCode: 'LA', area: 'Lekki Phase 1', stay, guests: 2 })
        .results.map((result) => result.unit.id)
    ).toContain('u_lekki_2bed');
  });

  it('does not expire a booking that has already been paid for', async () => {
    const { service, advanceTo } = setup();
    const { booking } = await service.startCheckout({
      unitId: 'u_lekki_2bed',
      stay: { checkIn: START, checkOut: addDays(START, 1) },
      guests: 2,
      guest
    });
    await service.confirmPayment({ processorRef: booking.processorRef! });

    advanceTo('2026-05-21T08:00:00.000Z');

    expect(service.cancelExpiredHolds()).toHaveLength(0);
  });
});

describe('ledger construction', () => {
  it('attributes the processor fee to the platform when it bears the cost', () => {
    const { service } = setup();
    const sellable = service.quoteUnit({
      unitId: 'u_lekki_2bed',
      stay: { checkIn: START, checkOut: addDays(START, 1) },
      guests: 2
    });

    const entries = buildLedgerEntries({
      bookingId: 'bk_x',
      quote: sellable.quote,
      split: { ...sellable.split, bearer: 'platform' },
      createdAt: NOW,
      generateId: (prefix) => `${prefix}_x`
    });

    expect(entries.filter((entry) => entry.recipient === 'PARTNER')).toHaveLength(1);
    expect(entries.some((entry) => entry.kind === 'PROCESSOR_FEE')).toBe(true);
  });

  it('shows no platform processor-cost leg when the partner bears the fee', () => {
    const { service } = setup();
    const sellable = service.quoteUnit({
      unitId: 'u_lekki_2bed',
      stay: { checkIn: START, checkOut: addDays(START, 1) },
      guests: 2
    });

    const entries = buildLedgerEntries({
      bookingId: 'bk_y',
      quote: sellable.quote,
      split: {
        partnerShareKobo: sellable.split.partnerShareKobo - sellable.split.processorFeeKobo,
        platformShareKobo: sellable.quote.serviceFeeKobo + sellable.quote.serviceFeeVatKobo,
        processorFeeKobo: sellable.split.processorFeeKobo,
        bearer: 'partner'
      },
      createdAt: NOW,
      generateId: (prefix) => `${prefix}_y`
    });

    expect(entries.some((entry) => entry.kind === 'PROCESSOR_FEE')).toBe(false);
  });

  it('throws rather than posting a ledger that does not balance', () => {
    const { service } = setup();
    const sellable = service.quoteUnit({
      unitId: 'u_lekki_2bed',
      stay: { checkIn: START, checkOut: addDays(START, 1) },
      guests: 2
    });

    expect(() =>
      buildLedgerEntries({
        bookingId: 'bk_z',
        quote: { ...sellable.quote, serviceFeeKobo: sellable.quote.serviceFeeKobo + 1 },
        split: { ...sellable.split, bearer: 'platform' },
        createdAt: NOW,
        generateId: (prefix) => `${prefix}_z`
      })
    ).toThrow(/does not balance/);
  });
});

describe('reference generation', () => {
  it('is readable over the phone and names the state', () => {
    expect(buildReference('LA', 'bk_0001')).toBe('H3-LA-XXBK0001');
    expect(buildReference('FC', 'abcd1234efgh5678')).toBe('H3-FC-EFGH5678');
  });
});

describe('title document filter', () => {
  const stay = { checkIn: START, checkOut: addDays(START, 2) };

  it('returns only units holding the requested title', () => {
    const { service } = setup();
    const outcome = service.search({ stateCode: 'LA', stay, guests: 2, titleDocuments: ['C_OF_O'] });

    expect(outcome.results.map((result) => result.unit.id)).toEqual(['u_lekki_studio', 'u_lekki_2bed']);
  });

  it('accepts several titles at once', () => {
    const { service } = setup();
    const outcome = service.search({
      stateCode: 'LA',
      stay,
      guests: 2,
      titleDocuments: ['C_OF_O', 'GOVERNORS_CONSENT']
    });

    expect(outcome.results.map((result) => result.unit.id)).toEqual([
      'u_lekki_studio',
      'u_lekki_2bed',
      'u_ikoyi_3bed'
    ]);
  });

  it('explains the rejection by naming the actual title', () => {
    const { service } = setup();
    const outcome = service.search({ stateCode: 'LA', stay, guests: 2, titleDocuments: ['FREEHOLD'] });

    expect(outcome.results).toHaveLength(0);
    expect(outcome.rejected.some((entry) => entry.reasons.some((reason) => reason.includes('Certificate of Occupancy')))).toBe(
      true
    );
  });
});

describe('bedroom filter', () => {
  const stay = { checkIn: START, checkOut: addDays(START, 2) };

  it('applies a minimum bedroom count', () => {
    const { service } = setup();
    const outcome = service.search({ stateCode: 'LA', stay, guests: 2, bedroomsMin: 3 });

    expect(outcome.results.map((result) => result.unit.id)).toEqual(['u_ikoyi_3bed']);
  });

  it('reports how many bedrooms the unit actually has', () => {
    const { service } = setup();
    const outcome = service.search({ stateCode: 'LA', stay, guests: 2, bedroomsMin: 4 });
    const studio = outcome.rejected.find((entry) => entry.unitId === 'u_lekki_studio');

    expect(studio?.reasons.some((reason) => reason.includes('1 bedroom(s), 4 requested'))).toBe(true);
  });
});

describe('price band filter', () => {
  const stay = { checkIn: START, checkOut: addDays(START, 2) };

  it('filters on the guest total, not the operator rate', () => {
    const { service } = setup();
    // 2 nights: studio NGN 196,950, 2-bed NGN 348,700, Ikoyi ~NGN 1,006,000.
    const outcome = service.search({ stateCode: 'LA', stay, guests: 2, priceBandId: '200-400k' });

    expect(outcome.results.map((result) => result.unit.id)).toEqual(['u_lekki_2bed']);
  });

  it('keeps cheaper stays in a low band', () => {
    const { service } = setup();
    const outcome = service.search({ stateCode: 'LA', stay, guests: 2, priceBandId: '100-200k' });

    expect(outcome.results.map((result) => result.unit.id)).toEqual(['u_lekki_studio']);
  });

  it('rejects an unknown band rather than silently returning everything', () => {
    const { service } = setup();
    expect(() => service.search({ stateCode: 'LA', stay, guests: 2, priceBandId: 'free' })).toThrow(
      /Unknown price band/
    );
  });
});

describe('geographic search', () => {
  const stay = { checkIn: START, checkOut: addDays(START, 2) };

  it('includes units inside the radius and reports the distance', () => {
    const { service } = setup();
    const outcome = service.search({
      stateCode: 'LA',
      stay,
      guests: 2,
      near: { center: { lat: 6.4418, lng: 3.474 }, radiusKm: 3 }
    });

    expect(outcome.results.map((result) => result.unit.id)).toEqual(['u_lekki_studio', 'u_lekki_2bed']);
    for (const result of outcome.results) {
      expect(result.distanceKm).toBeDefined();
      expect(result.distanceKm!).toBeLessThan(3);
    }
  });

  it('excludes a neighbouring area just outside the radius', () => {
    const { service } = setup();
    // Ikoyi is roughly 4.2km from Lekki Phase 1.
    const outcome = service.search({
      stateCode: 'LA',
      stay,
      guests: 2,
      near: { center: { lat: 6.4418, lng: 3.474 }, radiusKm: 2 }
    });

    expect(outcome.results.map((result) => result.unit.id)).not.toContain('u_ikoyi_3bed');
  });

  it('sorts by distance when asked', () => {
    const { service } = setup();
    const outcome = service.search({
      stateCode: 'LA',
      stay,
      guests: 2,
      near: { center: { lat: 6.4541, lng: 3.4348 }, radiusKm: 8 },
      sort: 'distance'
    });

    const distances = outcome.results.map((result) => result.distanceKm!);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    // Ikoyi is the search centre, so it should now lead despite costing more.
    expect(outcome.results[0]?.unit.id).toBe('u_ikoyi_3bed');
  });

  it('never returns a unit from another city', () => {
    const { service } = setup();
    const outcome = service.search({
      stateCode: 'FC',
      stay,
      guests: 2,
      near: { center: { lat: 6.4418, lng: 3.474 }, radiusKm: 50 }
    });

    expect(outcome.results).toHaveLength(0);
  });
});

describe('combined filters', () => {
  it('intersects title, bedrooms, price band and geography', () => {
    const { service } = setup();
    const outcome = service.search({
      stateCode: 'LA',
      stay: { checkIn: START, checkOut: addDays(START, 2) },
      guests: 2,
      titleDocuments: ['C_OF_O'],
      bedroomsMin: 2,
      priceBandId: '200-400k',
      near: { center: { lat: 6.4418, lng: 3.474 }, radiusKm: 3 }
    });

    expect(outcome.results.map((result) => result.unit.id)).toEqual(['u_lekki_2bed']);
  });
});
