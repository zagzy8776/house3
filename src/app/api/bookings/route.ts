/**
 * POST /api/bookings
 *
 * Body: { unitId, checkIn, checkOut, guests, guest: { name, email, phone } }
 *
 * Places a 15-minute hold on the unit and initialises the split payment. The
 * response contains exactly what the guest is about to be charged, including the
 * operator's own rate, so the client cannot render a total we did not quote.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getContainer } from '@/server/container';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  unitId: z.string().min(1),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  guests: z.number().int().min(1).max(20).default(2),
  guest: z.object({
    name: z.string().min(2).max(120),
    email: z.string().email(),
    phone: z.string().min(7).max(20),
    adults: z.number().int().min(1).max(20).default(2),
    children: z.number().int().min(0).max(10).default(0)
  })
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid booking request', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { unitId, checkIn, checkOut, guests, guest } = parsed.data;
  const { service } = getContainer();

  try {
    const { booking, checkoutUrl } = await service.startCheckout({
      unitId,
      stay: { checkIn, checkOut },
      guests,
      guest
    });

    return NextResponse.json(
      {
        bookingId: booking.id,
        reference: booking.reference,
        status: booking.status,
        checkoutUrl,
        holdExpiresAt: booking.holdExpiresAt,
        price: {
          currency: booking.quote.currency,
          lines: booking.quote.lines,
          totalKobo: booking.quote.totalKobo,
          operatorNetKobo: booking.partnerShareKobo,
          platformNetKobo: booking.platformShareKobo,
          processorFeeKobo: booking.processorFeeKobo
        }
      },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Checkout could not be started';
    // 409: the inventory could not be held (already booked, held, or closed).
    const status = message.includes('Cannot hold') ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
