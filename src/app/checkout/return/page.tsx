/**
 * Where the guest lands after paying.
 *
 * Shows the confirmed booking, the split that was posted, and what the operator
 * receives — the same numbers a support agent needs if the guest calls.
 */

import { formatNaira } from '@/domain/money';
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
  const ledger = repo.listLedger(booking.id);
  const operatorName = partner?.displayName ?? 'Your host';

  return (
    <main className="h3-page">
      <h1>{booking.status === 'CONFIRMED' ? 'Booking confirmed' : `Booking ${booking.status.toLowerCase()}`}</h1>
      <p className="h3-summary">
        Reference <strong>{booking.reference}</strong> · {booking.nights} night
        {booking.nights === 1 ? '' : 's'} · {booking.stay.checkIn} to {booking.stay.checkOut} ·{' '}
        {operatorName}
      </p>

      <h2>What you were charged</h2>
      <MoneyTable
        lines={booking.quote.lines}
        totalKobo={booking.quote.totalKobo}
        totalLabel="Total charged"
        settlement={{
          operatorName,
          operatorKobo: booking.partnerShareKobo,
          platformKobo: booking.platformShareKobo
        }}
      />

      <h2 style={{ marginTop: 'var(--h3-space-7)' }}>Settlement legs</h2>
      {ledger.length === 0 ? (
        <p className="h3-note">No ledger entries yet — the payment has not been confirmed.</p>
      ) : (
        <ul className="h3-ledger">
          {ledger.map((entry) => (
            <li key={entry.id}>
              {entry.recipient} · {entry.kind} · {formatNaira(entry.amountKobo)} ({entry.status})
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

