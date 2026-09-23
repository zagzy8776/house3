/**
 * Booking lifecycle.
 *
 * Happy path:
 *
 *   DRAFT -> HELD -> AWAITING_PAYMENT -> CONFIRMED -> COMPLETED
 *
 * Failure / exit paths:
 *   HELD              -> EXPIRED   (hold TTL passed, guest never paid)
 *   AWAITING_PAYMENT  -> FAILED    (processor declined / abandoned)
 *   AWAITING_PAYMENT  -> EXPIRED   (guest stalled past the hold)
 *   CONFIRMED         -> CANCELLED (guest or partner cancelled)
 *   CONFIRMED         -> REFUNDED / PARTIALLY_REFUNDED
 *
 * Terminal states are exactly: COMPLETED, CANCELLED, EXPIRED, FAILED,
 * REFUNDED, PARTIALLY_REFUNDED. Every transition out of a terminal state is
 * rejected, so a settled booking can never be silently reopened.
 */

export const BOOKING_STATUSES = [
  'DRAFT',
  'HELD',
  'AWAITING_PAYMENT',
  'CONFIRMED',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED'
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const TERMINAL_BOOKING_STATUSES: readonly BookingStatus[] = [
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED'
];

const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  DRAFT: ['HELD', 'CANCELLED'],
  HELD: ['AWAITING_PAYMENT', 'EXPIRED', 'CANCELLED'],
  AWAITING_PAYMENT: ['CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED'],
  CONFIRMED: ['COMPLETED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
  FAILED: [],
  REFUNDED: [],
  PARTIALLY_REFUNDED: []
};

/** Statuses at which the guest's money is (or should already be) with us. */
export const PAID_STATUSES: readonly BookingStatus[] = [
  'CONFIRMED',
  'COMPLETED',
  'REFUNDED',
  'PARTIALLY_REFUNDED'
];

export class BookingStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookingStateError';
  }
}

export function isTerminal(status: BookingStatus): boolean {
  return TERMINAL_BOOKING_STATUSES.includes(status);
}

export function isPaid(status: BookingStatus): boolean {
  return PAID_STATUSES.includes(status);
}

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) {
    throw new BookingStateError(`Illegal booking transition ${from} -> ${to}`);
  }
}

export function allowedTransitions(from: BookingStatus): readonly BookingStatus[] {
  return TRANSITIONS[from];
}
