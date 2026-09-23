/**
 * Booking orchestration.
 *
 * This is the funnel the guest experiences, end to end:
 *
 *   search  ->  quoteUnit  ->  startCheckout (hold + processor init)
 *           ->  confirmPayment (webhook/return verification)  ->  split ledger
 *
 * Two properties this module guarantees, both covered by tests:
 *
 *  1. No money is taken for inventory we cannot deliver. Availability is
 *     re-checked immediately before the hold, and confirmed bookings occupy the
 *     calendar.
 *  2. The guest is charged exactly the total that was shown, and that total is
 *     split with nothing invented or lost: partner + platform + processor =
 *     total, and the ledger legs always sum to the payouts actually disbursed.
 */

import { checkAvailability, createHold, effectiveNightlyRateKobo, type Hold } from '@/domain/availability';
import { assertTransition } from '@/domain/booking';
import { nightsBetween, type StayRange } from '@/domain/dates';
import { computeQuote, resolveFeePolicy, type FeePolicy, type Quote } from '@/domain/pricing';
import { computeSplits, type FeeBearer, type ProcessorFeeModel, type SplitResult } from '@/domain/splits';
import {
  type BookingRecord,
  type GuestDetails,
  type LedgerEntryRecord,
  type LedgerKind,
  type ListedUnit,
  type PartnerProfile,
  type Repository
} from './store';

export class BookingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookingError';
  }
}

/** What the payment layer must provide. Swapped for a fake in tests. */
export type PaymentGateway = {
  processor: 'PAYSTACK' | 'FLUTTERWAVE';
  initialize(input: {
    bookingId: string;
    reference: string;
    email: string;
    subaccountCode: string;
    amountKobo: number;
    /** Flat kobo routed to the partner's own account. */
    transactionChargeKobo: number;
    bearer: FeeBearer;
  }): Promise<{ processorRef: string; checkoutUrl: string }>;
  verify(processorRef: string): Promise<{ paid: boolean; amountKobo: number }>;
};

export type BookingServiceDeps = {
  repo: Repository;
  gateway: PaymentGateway;
  policies: readonly FeePolicy[];
  processorFee: ProcessorFeeModel;
  bearer: FeeBearer;
  /** ISO instant supplier, so tests are deterministic. */
  clock: () => string;
  generateId: (prefix: string) => string;
  callbackUrl: string;
  holdTtlMinutes?: number;
  globalPolicyId?: string;
};

export type SellableUnit = {
  unit: ListedUnit;
  partner: PartnerProfile;
  quote: Quote;
  split: SplitResult;
};

export type SearchOutcome = {
  results: SellableUnit[];
  /** Units that matched the query but are not bookable, with reasons. */
  rejected: { unitId: string; unitName: string; reasons: string[] }[];
  nights: number;
};

export type SearchQuery = {
  stateCode: string;
  area?: string;
  stay: StayRange;
  guests: number;
  limit?: number;
};

export type BookingService = {
  search(query: SearchQuery): SearchOutcome;
  quoteUnit(input: { unitId: string; stay: StayRange; guests: number }): SellableUnit;
  startCheckout(input: {
    unitId: string;
    stay: StayRange;
    guests: number;
    guest: GuestDetails;
  }): Promise<{ booking: BookingRecord; checkoutUrl: string }>;
  confirmPayment(input: {
    processorRef: string;
  }): Promise<{ booking: BookingRecord; alreadyProcessed: boolean }>;
  cancelExpiredHolds(): BookingRecord[];
};


/**
 * Ledger legs for a confirmed booking.
 *
 * The processor collects `totalKobo`, sends the partner their share to their own
 * subaccount, keeps `processorFeeKobo`, and sends the platform the rest. The
 * ledger mirrors that cash movement exactly, which is why the legs sum to
 * `partnerShare + platformShare` (i.e. total minus the processor's cut) rather
 * than to the gross total. `assertLedgerBalances` proves it.
 */
export function buildLedgerEntries(input: {
  bookingId: string;
  quote: Quote;
  split: {
    partnerShareKobo: number;
    platformShareKobo: number;
    processorFeeKobo: number;
    bearer: FeeBearer;
  };
  createdAt: string;
  generateId: (prefix: string) => string;
}): LedgerEntryRecord[] {
  const { bookingId, quote, split, createdAt, generateId } = input;

  const entries: LedgerEntryRecord[] = [
    {
      id: generateId('led'),
      bookingId,
      recipient: 'PARTNER',
      kind: 'ROOM_REVENUE' as LedgerKind,
      amountKobo: split.partnerShareKobo,
      status: 'SETTLED',
      settlementRef: null,
      createdAt
    },
    {
      id: generateId('led'),
      bookingId,
      recipient: 'PLATFORM',
      kind: 'SERVICE_FEE' as LedgerKind,
      amountKobo: quote.serviceFeeKobo,
      status: 'SETTLED',
      settlementRef: null,
      createdAt
    },
    {
      id: generateId('led'),
      bookingId,
      recipient: 'PLATFORM',
      kind: 'SERVICE_FEE_VAT' as LedgerKind,
      amountKobo: quote.serviceFeeVatKobo,
      status: 'SETTLED',
      settlementRef: null,
      createdAt
    }
  ];

  // Only when the platform absorbed the processing cost does it appear as an
  // expense leg. When the partner bears it, it is already reflected in their
  // reduced share.
  if (split.bearer === 'platform') {
    entries.push({
      id: generateId('led'),
      bookingId,
      recipient: 'PLATFORM',
      kind: 'PROCESSOR_FEE' as LedgerKind,
      amountKobo: -split.processorFeeKobo,
      status: 'SETTLED',
      settlementRef: null,
      createdAt
    });
  }

  assertLedgerBalances(entries, split.partnerShareKobo + split.platformShareKobo, bookingId);
  return entries;
}

export function assertLedgerBalances(
  entries: readonly LedgerEntryRecord[],
  expectedTotalKobo: number,
  bookingId: string
): void {
  const total = entries.reduce((sum, entry) => sum + entry.amountKobo, 0);
  if (total !== expectedTotalKobo) {
    throw new BookingError(
      `Ledger for ${bookingId} does not balance: legs sum to ${total}, expected ${expectedTotalKobo}`
    );
  }
}


export function createBookingService(deps: BookingServiceDeps): BookingService {
  const { repo, gateway } = deps;
  const ttlMinutes = deps.holdTtlMinutes ?? 15;

  /** Holds derived from bookings still sitting in a checkout state. */
  function activeHoldsFor(unitId: string): Hold[] {
    const now = deps.clock();
    return repo
      .listBookingsForUnit(unitId)
      .filter((booking) => booking.status === 'HELD' || booking.status === 'AWAITING_PAYMENT')
      .map((booking) => ({
        id: booking.id,
        unitId: booking.unitId,
        stay: booking.stay,
        status: 'ACTIVE' as const,
        expiresAt: booking.holdExpiresAt ?? now
      }));
  }

  /** Everything that must be true before a partner's unit can be sold. */
  function partnerBlockers(partner: PartnerProfile): string[] {
    const reasons: string[] = [];
    if (partner.status !== 'ACTIVE') reasons.push(`Partner is ${partner.status}`);
    if (!partner.paystackSubaccountCode) reasons.push('Partner has no settlement account');
    if (!partner.settlementVerified) reasons.push('Partner settlement account is not verified');
    return reasons;
  }

  function bookedRanges(unitId: string): { unitId: string; stay: StayRange }[] {
    return repo.listBookingsForUnit(unitId).map((booking) => ({ unitId: booking.unitId, stay: booking.stay }));
  }

  function buildQuote(unit: ListedUnit, partner: PartnerProfile, stay: StayRange, guests: number): SellableUnit {
    const policy = resolveFeePolicy(deps.policies, {
      stateCode: unit.stateCode,
      partnerId: unit.partnerId,
      globalPolicyId: deps.globalPolicyId
    });

    const availability = checkAvailability({
      unitId: unit.id,
      stay,
      calendar: repo.listAvailability(unit.id),
      holds: activeHoldsFor(unit.id),
      now: deps.clock(),
      confirmedBookings: bookedRanges(unit.id)
    });

    // Premium nights quoted by the partner must never be under-charged.
    const nightlyRateKobo = effectiveNightlyRateKobo(unit.nightlyRateKobo, availability.nightlyRateOverrides);
    const extraGuests = Math.max(0, guests - unit.includedGuests);

    const quote = computeQuote({
      stay,
      nightlyRateKobo,
      policy,
      cleaningFeeKobo: unit.cleaningFeeKobo,
      extraGuests,
      extraGuestFeePerNightKobo: unit.extraGuestFeePerNightKobo
    });

    return {
      unit,
      partner,
      quote,
      split: computeSplits({ quote, processorFee: deps.processorFee, bearer: deps.bearer })
    };
  }

  function search(query: SearchQuery): SearchOutcome {
    const nights = nightsBetween(query.stay);
    const results: SellableUnit[] = [];
    const rejected: { unitId: string; unitName: string; reasons: string[] }[] = [];

    const candidates = repo.listUnits({ stateCode: query.stateCode, area: query.area, status: 'LISTED' });

    for (const unit of candidates) {
      const partner = repo.getPartner(unit.partnerId);
      const reasons: string[] = [];

      if (!partner) reasons.push('Unit has no registered partner');
      else reasons.push(...partnerBlockers(partner));

      if (unit.maxGuests < query.guests) reasons.push(`Sleeps ${unit.maxGuests}, ${query.guests} requested`);
      if (nights < unit.minNights) reasons.push(`Minimum stay is ${unit.minNights} nights`);
      if (nights > unit.maxNights) reasons.push(`Maximum stay is ${unit.maxNights} nights`);
      if (!unit.bookable) reasons.push('Affiliate listing: completes on the partner site');

      if (reasons.length > 0 || !partner) {
        rejected.push({ unitId: unit.id, unitName: unit.name, reasons });
        continue;
      }

      const availability = checkAvailability({
        unitId: unit.id,
        stay: query.stay,
        calendar: repo.listAvailability(unit.id),
        holds: activeHoldsFor(unit.id),
        now: deps.clock(),
        confirmedBookings: bookedRanges(unit.id)
      });

      if (!availability.available) {
        rejected.push({ unitId: unit.id, unitName: unit.name, reasons: availability.reasons });
        continue;
      }

      results.push(buildQuote(unit, partner, query.stay, query.guests));
    }

    // Cheapest first: price is the primary decision driver and the display total
    // already includes our disclosed fee.
    results.sort((a, b) => a.quote.totalKobo - b.quote.totalKobo);

    return { results: query.limit ? results.slice(0, query.limit) : results, rejected, nights };
  }

  function quoteUnit(input: { unitId: string; stay: StayRange; guests: number }): SellableUnit {
    const unit = repo.getUnit(input.unitId);
    if (!unit) throw new BookingError(`Unknown unit ${input.unitId}`);

    const partner = repo.getPartner(unit.partnerId);
    if (!partner) throw new BookingError(`Unit ${input.unitId} has no registered partner`);

    const blockers = partnerBlockers(partner);
    if (blockers.length > 0) {
      throw new BookingError(`Partner cannot be sold for: ${blockers.join('; ')}`);
    }

    const nights = nightsBetween(input.stay);
    if (nights < unit.minNights) throw new BookingError(`Minimum stay is ${unit.minNights} nights`);
    if (nights > unit.maxNights) throw new BookingError(`Maximum stay is ${unit.maxNights} nights`);
    if (input.guests > unit.maxGuests) throw new BookingError(`Unit sleeps ${unit.maxGuests} guests`);

    return buildQuote(unit, partner, input.stay, input.guests);
  }

  async function startCheckout(input: {
    unitId: string;
    stay: StayRange;
    guests: number;
    guest: GuestDetails;
  }): Promise<{ booking: BookingRecord; checkoutUrl: string }> {
    const sellable = quoteUnit(input);
    const { unit, partner } = sellable;

    const subaccountCode = partner.paystackSubaccountCode;
    if (!subaccountCode) throw new BookingError('Partner settlement account missing at checkout time');

    // createHold re-runs the availability check and throws instead of letting a
    // second guest pay for a night that is already taken.
    createHold({
      unitId: unit.id,
      stay: input.stay,
      calendar: repo.listAvailability(unit.id),
      holds: activeHoldsFor(unit.id),
      now: deps.clock(),
      confirmedBookings: bookedRanges(unit.id),
      holdId: deps.generateId('hold'),
      ttlMinutes
    });

    const bookingId = deps.generateId('bk');
    const reference = buildReference(unit.stateCode, bookingId);
    const now = deps.clock();

    repo.createBooking({
      id: bookingId,
      reference,
      status: 'HELD',
      partnerId: unit.partnerId,
      unitId: unit.id,
      stateCode: unit.stateCode,
      guest: input.guest,
      stay: input.stay,
      nights: sellable.quote.nights,
      quote: sellable.quote,
      partnerShareKobo: sellable.split.partnerShareKobo,
      platformShareKobo: sellable.split.platformShareKobo,
      processorFeeKobo: sellable.split.processorFeeKobo,
      bearer: deps.bearer,
      holdExpiresAt: holdExpiryIso(now, ttlMinutes),
      processorRef: null,
      checkoutUrl: null,
      confirmedAt: null,
      createdAt: now,
      updatedAt: now
    });
    repo.appendEvent({
      id: deps.generateId('evt'),
      bookingId,
      fromStatus: null,
      toStatus: 'HELD',
      actor: 'guest',
      note: `Inventory held for ${ttlMinutes} minutes`,
      createdAt: now
    });

    const initialized = await gateway.initialize({
      bookingId,
      reference,
      email: input.guest.email,
      subaccountCode,
      amountKobo: sellable.quote.totalKobo,
      transactionChargeKobo: sellable.split.paystack.transactionChargeKobo,
      bearer: deps.bearer
    });

    const booking = repo.updateBooking(bookingId, {
      status: 'AWAITING_PAYMENT',
      processorRef: initialized.processorRef,
      checkoutUrl: initialized.checkoutUrl,
      updatedAt: deps.clock()
    });
    repo.appendEvent({
      id: deps.generateId('evt'),
      bookingId,
      fromStatus: 'HELD',
      toStatus: 'AWAITING_PAYMENT',
      actor: 'system',
      note: `${gateway.processor} checkout initialised as ${initialized.processorRef}`,
      createdAt: deps.clock()
    });

    return { booking, checkoutUrl: initialized.checkoutUrl };
  }

  async function confirmPayment(input: {
    processorRef: string;
  }): Promise<{ booking: BookingRecord; alreadyProcessed: boolean }> {
    const booking = repo.getBookingByProcessorRef(input.processorRef);
    if (!booking) throw new BookingError(`No booking for processor reference ${input.processorRef}`);

    // Webhooks retry. Confirming twice must not double-settle the ledger.
    if (booking.status === 'CONFIRMED' || booking.status === 'COMPLETED') {
      return { booking, alreadyProcessed: true };
    }

    const verification = await gateway.verify(input.processorRef);
    const now = deps.clock();

    if (!verification.paid) {
      const failed = repo.updateBooking(booking.id, { status: 'FAILED', updatedAt: now });
      repo.appendEvent({
        id: deps.generateId('evt'),
        bookingId: booking.id,
        fromStatus: booking.status,
        toStatus: 'FAILED',
        actor: 'system',
        note: 'Processor reported the charge as unsuccessful',
        createdAt: now
      });
      return { booking: failed, alreadyProcessed: false };
    }

    // Never trust a client-supplied amount, and never confirm a booking that was
    // paid for at a different price than the guest was shown.
    if (verification.amountKobo !== booking.quote.totalKobo) {
      repo.updateBooking(booking.id, { status: 'FAILED', updatedAt: now });
      repo.appendEvent({
        id: deps.generateId('evt'),
        bookingId: booking.id,
        fromStatus: booking.status,
        toStatus: 'FAILED',
        actor: 'system',
        note:
          `Amount mismatch: charged ${verification.amountKobo} but quoted ${booking.quote.totalKobo}. ` +
          'Refund required; booking NOT confirmed.',
        createdAt: now
      });
      throw new BookingError(
        `Amount mismatch on ${booking.reference}: charged ${verification.amountKobo}, quoted ${booking.quote.totalKobo}`
      );
    }

    assertTransition(booking.status, 'CONFIRMED');

    const confirmed = repo.updateBooking(booking.id, {
      status: 'CONFIRMED',
      confirmedAt: now,
      updatedAt: now
    });
    repo.savePayment({
      id: deps.generateId('pay'),
      bookingId: booking.id,
      processor: gateway.processor,
      processorRef: input.processorRef,
      amountKobo: verification.amountKobo,
      status: 'SUCCESS',
      verifiedAt: now
    });
    repo.appendEvent({
      id: deps.generateId('evt'),
      bookingId: booking.id,
      fromStatus: booking.status,
      toStatus: 'CONFIRMED',
      actor: 'system',
      note: `${gateway.processor} charge verified; split settlement issued`,
      createdAt: now
    });

    for (const entry of buildLedgerEntries({
      bookingId: booking.id,
      quote: booking.quote,
      split: {
        partnerShareKobo: booking.partnerShareKobo,
        platformShareKobo: booking.platformShareKobo,
        processorFeeKobo: booking.processorFeeKobo,
        bearer: booking.bearer
      },
      createdAt: now,
      generateId: deps.generateId
    })) {
      repo.addLedgerEntry(entry);
    }

    return { booking: confirmed, alreadyProcessed: false };
  }

  /** Release inventory for checkouts the guest abandoned. Safe to run on a timer. */
  function cancelExpiredHolds(): BookingRecord[] {
    const now = deps.clock();
    const expired: BookingRecord[] = [];

    for (const unit of repo.listUnits({})) {
      for (const booking of repo.listBookingsForUnit(unit.id)) {
        if (booking.status !== 'HELD' && booking.status !== 'AWAITING_PAYMENT') continue;
        if (!booking.holdExpiresAt || booking.holdExpiresAt > now) continue;

        const updated = repo.updateBooking(booking.id, { status: 'EXPIRED', updatedAt: now });
        repo.appendEvent({
          id: deps.generateId('evt'),
          bookingId: booking.id,
          fromStatus: booking.status,
          toStatus: 'EXPIRED',
          actor: 'system',
          note: 'Hold expired before payment completed; inventory released',
          createdAt: now
        });
        expired.push(updated);
      }
    }

    return expired;
  }

  return { search, quoteUnit, startCheckout, confirmPayment, cancelExpiredHolds };
}

/** Reference format that ops and support can read aloud: H3-LA-7F3K9Q2M */
export function buildReference(stateCode: string, bookingId: string): string {
  const suffix = bookingId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(-8).padStart(8, 'X');
  return `H3-${stateCode}-${suffix}`;
}

export function holdExpiryIso(now: string, ttlMinutes: number): string {
  return new Date(new Date(now).getTime() + ttlMinutes * 60_000).toISOString();
}
