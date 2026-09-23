import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  assertTransition,
  BookingStateError,
  BOOKING_STATUSES,
  isPaid,
  isTerminal,
  type BookingStatus
} from '@/domain/booking';

describe('booking state machine', () => {
  it('walks the happy path from draft to completed', () => {
    const path: BookingStatus[] = ['DRAFT', 'HELD', 'AWAITING_PAYMENT', 'CONFIRMED', 'COMPLETED'];
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(() => assertTransition(path[index]!, path[index + 1]!)).not.toThrow();
    }
  });

  it('rejects skipping payment', () => {
    expect(() => assertTransition('HELD', 'CONFIRMED')).toThrow(BookingStateError);
  });

  it('rejects any transition out of a terminal state', () => {
    const terminals = BOOKING_STATUSES.filter(isTerminal);
    expect(terminals).toContain('COMPLETED');
    expect(terminals).toContain('EXPIRED');
    expect(terminals).toContain('FAILED');

    for (const terminal of terminals) {
      expect(allowedTransitions(terminal)).toEqual([]);
      expect(() => assertTransition(terminal, 'CONFIRMED')).toThrow(BookingStateError);
    }
  });

  it('allows refund paths only from a confirmed booking', () => {
    expect(() => assertTransition('CONFIRMED', 'REFUNDED')).not.toThrow();
    expect(() => assertTransition('CONFIRMED', 'PARTIALLY_REFUNDED')).not.toThrow();
    expect(() => assertTransition('AWAITING_PAYMENT', 'REFUNDED')).toThrow(BookingStateError);
  });

  it('treats only money-received states as paid', () => {
    expect(isPaid('CONFIRMED')).toBe(true);
    expect(isPaid('COMPLETED')).toBe(true);
    expect(isPaid('REFUNDED')).toBe(true);
    expect(isPaid('AWAITING_PAYMENT')).toBe(false);
    expect(isPaid('HELD')).toBe(false);
    expect(isPaid('FAILED')).toBe(false);
  });

  it('lets an abandoned checkout expire rather than hang', () => {
    expect(() => assertTransition('HELD', 'EXPIRED')).not.toThrow();
    expect(() => assertTransition('AWAITING_PAYMENT', 'EXPIRED')).not.toThrow();
  });
});
