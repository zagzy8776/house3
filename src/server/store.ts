/**
 * Persistence contracts + an in-memory implementation.
 *
 * The Prisma schema in prisma/schema.prisma is the production store. This module
 * defines the narrow interface the booking service depends on, plus an in-memory
 * implementation used by tests and by the demo API routes so the whole funnel can
 * be exercised without a database.
 */

import type { IsoDate, IsoInstant, StayRange } from '@/domain/dates';
import type { UnitNightState } from '@/domain/availability';
import type { BookingStatus } from '@/domain/booking';
import type { Quote } from '@/domain/pricing';
import type { TitleDocument } from '@/domain/title';

export type PartnerStatus = 'ONBOARDING' | 'ACTIVE' | 'SUSPENDED' | 'OFFBOARDED';

export type PartnerProfile = {
  id: string;
  displayName: string;
  legalName: string;
  stateCode: string;
  area: string;
  status: PartnerStatus;
  /**
   * Settlement destination. A partner cannot be sold for until this exists,
   * otherwise there is nowhere to send their money.
   */
  paystackSubaccountCode: string | null;
  flutterwaveSubaccountId?: string | null;
  settlementVerified: boolean;
};

export type ListedUnit = {
  id: string;
  partnerId: string;
  name: string;
  unitType: 'APARTMENT' | 'STUDIO' | 'ROOM' | 'HOSTEL_BED' | 'VILLA';
  maxGuests: number;
  bedrooms: number;
  bathrooms: number;
  /** Partner's own published nightly rate, kobo. */
  nightlyRateKobo: number;
  cleaningFeeKobo: number;
  extraGuestFeePerNightKobo: number;
  includedGuests: number;
  minNights: number;
  maxNights: number;
  bookable: boolean;
  status: 'DRAFT' | 'LISTED' | 'HIDDEN' | 'ARCHIVED';
  stateCode: string;
  area: string;
  /**
   * Surveyed coordinates. Null until captured at onboarding - never guessed from
   * the area name, because a wrong pin sends a guest to the wrong street. The
   * search box resolves an area to a centroid for the *query*, but a unit is
   * only geo-searchable once its own position is known.
   */
  latitude: number | null;
  longitude: number | null;
  /** Property title. Filters on this are what make this a Nigerian platform. */
  titleDocument: TitleDocument;

  // ----------------------------------------------------------------- discovery
  //
  // HOW A GUEST REACHES THIS PLACE.
  //
  // These are the fields that make House3 a referral platform rather than a booking
  // engine: a guest reads them and contacts the property themselves. They are
  // `null`-able because they are OBSERVED facts about an unknown third party, not
  // values we set. `src/domain/contact.ts` turns them into the routes a page offers.
  //
  // `sourceUrl` is the anchor. Without it a place cannot be attributed or reached, so
  // a page cannot honestly present it as a place at all.

  /** Where we observed this. The publisher's own listing. */
  sourceUrl?: string | null;
  /** Which publisher. Named on the page so the guest knows who we read it from. */
  sourceName?: string | null;
  /**
   * The name the SOURCE stated for the operator, or null.
   *
   * A name inferred from a domain is a hint and does not belong here: sending a guest
   * to a guessed website is worse than sending them to the listing they were reading.
   */
  operatorName?: string | null;
  /** The operator's own site, when the operator was identified by more than a hint. */
  operatorWebsite?: string | null;
  /** The number the listing published so guests would call. */
  contactPhone?: string | null;
  operatorInstagram?: string | null;
  /**
   * An availability link the source offered. NEVER used as a destination - a live
   * portal page once pointed one at a different listing on the same portal. Recorded
   * for future validation, never rendered as "book here".
   */
  availabilityHintUrl?: string | null;
};

export type LedgerRecipient = 'PARTNER' | 'PLATFORM';
export type LedgerKind =
  | 'ROOM_REVENUE'
  | 'CLEANING_PASSTHROUGH'
  | 'SERVICE_FEE'
  | 'SERVICE_FEE_VAT'
  | 'PROCESSOR_FEE'
  | 'REFUND';

export type LedgerEntryRecord = {
  id: string;
  bookingId: string;
  recipient: LedgerRecipient;
  kind: LedgerKind;
  amountKobo: number;
  status: 'PENDING' | 'SETTLED' | 'REVERSED';
  settlementRef: string | null;
  createdAt: IsoInstant;
};

export type GuestDetails = {
  name: string;
  email: string;
  phone: string;
  adults: number;
  children: number;
};

export type BookingRecord = {
  id: string;
  reference: string;
  status: BookingStatus;
  partnerId: string;
  unitId: string;
  stateCode: string;
  guest: GuestDetails;
  stay: StayRange;
  nights: number;
  /** Frozen money snapshot - never recomputed once the guest is on the pay page. */
  quote: Quote;
  partnerShareKobo: number;
  platformShareKobo: number;
  processorFeeKobo: number;
  bearer: 'platform' | 'partner';
  holdExpiresAt: IsoInstant | null;
  processorRef: string | null;
  checkoutUrl: string | null;
  confirmedAt: IsoInstant | null;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
};

export type BookingEventRecord = {
  id: string;
  bookingId: string;
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus;
  actor: string;
  note: string | null;
  createdAt: IsoInstant;
};

export type PaymentRecord = {
  id: string;
  bookingId: string;
  processor: 'PAYSTACK' | 'FLUTTERWAVE';
  processorRef: string;
  amountKobo: number;
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'REVERSED';
  verifiedAt: IsoInstant | null;
};

export type SearchAvailabilityFilter = {
  stateCode: string;
  area?: string;
  stay: StayRange;
  guests: number;
};

export interface Repository {
  listPartners(): PartnerProfile[];
  getPartner(id: string): PartnerProfile | undefined;
  listUnits(filter: { stateCode?: string; area?: string; status?: ListedUnit['status'] }): ListedUnit[];
  getUnit(id: string): ListedUnit | undefined;
  /** Calendar states pushed by the partner. */
  listAvailability(unitId: string): UnitNightState[];
  putAvailability(unitId: string, nights: UnitNightState[]): void;

  createBooking(booking: BookingRecord): void;
  getBooking(id: string): BookingRecord | undefined;
  getBookingByReference(reference: string): BookingRecord | undefined;
  getBookingByProcessorRef(processorRef: string): BookingRecord | undefined;
  updateBooking(id: string, patch: Partial<BookingRecord>): BookingRecord;
  listBookingsForUnit(unitId: string): BookingRecord[];

  addLedgerEntry(entry: LedgerEntryRecord): void;
  listLedger(bookingId: string): LedgerEntryRecord[];

  appendEvent(event: BookingEventRecord): void;
  listEvents(bookingId: string): BookingEventRecord[];

  savePayment(payment: PaymentRecord): void;
  listPayments(bookingId: string): PaymentRecord[];
}

export class RepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryError';
  }
}

/** Booking statuses that occupy a unit's calendar. */
export const OCCUPYING: readonly BookingStatus[] = ['HELD', 'AWAITING_PAYMENT', 'CONFIRMED', 'COMPLETED'];

export class InMemoryRepository implements Repository {
  private readonly partners = new Map<string, PartnerProfile>();
  private readonly units = new Map<string, ListedUnit>();
  private readonly availability = new Map<string, UnitNightState[]>();
  private readonly bookings = new Map<string, BookingRecord>();
  private readonly ledger = new Map<string, LedgerEntryRecord>();
  private readonly events = new Map<string, BookingEventRecord>();
  private readonly payments = new Map<string, PaymentRecord>();

  constructor(seed?: {
    partners?: PartnerProfile[];
    units?: ListedUnit[];
    availability?: Record<string, UnitNightState[]>;
  }) {
    for (const partner of seed?.partners ?? []) this.partners.set(partner.id, partner);
    for (const unit of seed?.units ?? []) this.units.set(unit.id, unit);
    for (const [unitId, nights] of Object.entries(seed?.availability ?? {})) {
      this.availability.set(unitId, nights);
    }
  }

  listPartners(): PartnerProfile[] {
    return [...this.partners.values()];
  }

  getPartner(id: string): PartnerProfile | undefined {
    return this.partners.get(id);
  }

  listUnits(filter: { stateCode?: string; area?: string; status?: ListedUnit['status'] }): ListedUnit[] {
    return [...this.units.values()].filter((unit) => {
      if (filter.stateCode && unit.stateCode !== filter.stateCode) return false;
      if (filter.area && unit.area !== filter.area) return false;
      if (filter.status && unit.status !== filter.status) return false;
      return true;
    });
  }

  getUnit(id: string): ListedUnit | undefined {
    return this.units.get(id);
  }

  listAvailability(unitId: string): UnitNightState[] {
    return this.availability.get(unitId) ?? [];
  }

  putAvailability(unitId: string, nights: UnitNightState[]): void {
    const existing = new Map(this.availability.get(unitId)?.map((night) => [night.night, night]) ?? []);
    for (const night of nights) existing.set(night.night, night);
    this.availability.set(unitId, [...existing.values()]);
  }

  createBooking(booking: BookingRecord): void {
    if (this.bookings.has(booking.id)) throw new RepositoryError(`Booking ${booking.id} already exists`);
    this.bookings.set(booking.id, booking);
  }

  getBooking(id: string): BookingRecord | undefined {
    return this.bookings.get(id);
  }

  getBookingByReference(reference: string): BookingRecord | undefined {
    return [...this.bookings.values()].find((booking) => booking.reference === reference);
  }

  getBookingByProcessorRef(processorRef: string): BookingRecord | undefined {
    return [...this.bookings.values()].find((booking) => booking.processorRef === processorRef);
  }

  updateBooking(id: string, patch: Partial<BookingRecord>): BookingRecord {
    const current = this.bookings.get(id);
    if (!current) throw new RepositoryError(`Booking ${id} not found`);
    const next: BookingRecord = { ...current, ...patch };
    this.bookings.set(id, next);
    return next;
  }

  listBookingsForUnit(unitId: string): BookingRecord[] {
    return [...this.bookings.values()].filter(
      (booking) => booking.unitId === unitId && OCCUPYING.includes(booking.status)
    );
  }

  addLedgerEntry(entry: LedgerEntryRecord): void {
    if (this.ledger.has(entry.id)) throw new RepositoryError(`Ledger entry ${entry.id} already exists`);
    this.ledger.set(entry.id, entry);
  }

  listLedger(bookingId: string): LedgerEntryRecord[] {
    return [...this.ledger.values()].filter((entry) => entry.bookingId === bookingId);
  }

  appendEvent(event: BookingEventRecord): void {
    this.events.set(event.id, event);
  }

  listEvents(bookingId: string): BookingEventRecord[] {
    return [...this.events.values()]
      .filter((event) => event.bookingId === bookingId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  savePayment(payment: PaymentRecord): void {
    this.payments.set(payment.id, payment);
  }

  listPayments(bookingId: string): PaymentRecord[] {
    return [...this.payments.values()].filter((payment) => payment.bookingId === bookingId);
  }
}

export type { IsoDate };
