/**
 * Where the guest lands after paying.
 *
 * Shows the confirmed booking and the itemisation of what they were charged.
 * It deliberately does NOT show the internal split: how much the operator
 * received and how much House3 kept is available to the ledger
 * (`repo.listLedger`) for support and reconciliation, but it is not guest-facing.
 */

import { getContainer } from '@/server/container';
import { MoneyTable } from '../../components/MoneyTable';

export const dynamic = 'force-dynamic';

export default async function CheckoutReturn({
  searchParams
}: {
  searchParams: Promise<{ reference?: string }>;
}) {
  const { reference } = await searchParams;

  if (!reference) {
    return (
      <main className="h3-page">
        <h1>Payment return</h1>
        <p className="h3-note">No booking reference was supplied.</p>
      </main>
    );
  }

  const { repo } = getContainer();
  const booking = repo.getBookingByReference(reference);

  if (!booking) {
    return (
      <main className="h3-page">
        <h1>Booking not found</h1>
        <p className="h3-note">We could not find a booking for reference {reference}.</p>
      </main>
    );
  }

  const partner = repo.getPartner(booking.partnerId);
  const hostName = partner?.displayName ?? 'Your host';

  return (
    <main className="h3-page">
      <h1>{booking.status === 'CONFIRMED' ? 'Booking confirmed' : `Booking ${booking.status.toLowerCase()}`}</h1>
      <p className="h3-summary">
        Reference <strong>{booking.reference}</strong> · {booking.nights} night
        {booking.nights === 1 ? '' : 's'} · {booking.stay.checkIn} to {booking.stay.checkOut} ·{' '}
        {hostName}
      </p>

      <h2>What you were charged</h2>
      <MoneyTable
        lines={booking.quote.lines}
        totalKobo={booking.quote.totalKobo}
        totalLabel="Total charged"
      />

      <p className="h3-note" style={{ marginTop: 'var(--h3-space-6)' }}>
        Need help with this booking? Quote reference <strong>{booking.reference}</strong>.
      </p>
    </main>
  );
}

