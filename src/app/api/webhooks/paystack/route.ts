/**
 * POST /api/webhooks/paystack
 *
 * Paystack signs the raw body with HMAC-SHA512 using the secret key, in the
 * `x-paystack-signature` header. This route:
 *
 *   1. reads the RAW body (parsing first would invalidate the signature);
 *   2. verifies the signature and returns 401 if it does not match;
 *   3. ignores events it does not handle, with a 200 so Paystack stops retrying;
 *   4. hands the charge reference to the booking service, which re-verifies the
 *      charge server-side, checks the amount against the frozen quote, and posts
 *      the split ledger exactly once.
 *
 * Always return 200 for events we understood, even if the booking was already
 * confirmed. A non-2xx makes Paystack retry, and repeated retries of an
 * unhandled event will eventually get the endpoint disabled.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyPaystackSignature } from '@/payments/paystack';
import { getContainer } from '@/server/container';

export const dynamic = 'force-dynamic';

const eventSchema = z.object({
  event: z.string(),
  data: z.object({
    reference: z.string(),
    amount: z.number().int(),
    currency: z.string().optional(),
    status: z.string().optional()
  })
});

const HANDLED_EVENTS = new Set(['charge.success']);

export async function POST(request: Request) {
  const rawBody = await request.text();
  const secretKey = process.env.PAYSTACK_WEBHOOK_SECRET ?? process.env.PAYSTACK_SECRET_KEY ?? '';

  if (!secretKey) {
    return NextResponse.json({ error: 'Webhook secret is not configured' }, { status: 500 });
  }

  const valid = verifyPaystackSignature({
    rawBody,
    signatureHeader: request.headers.get('x-paystack-signature'),
    secretKey
  });

  if (!valid) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const parsed = eventSchema.safeParse(JSON.parse(rawBody) as unknown);
  if (!parsed.success) {
    // Signed but unparseable: acknowledge so it is not retried forever.
    return NextResponse.json({ received: true, handled: false, reason: 'unrecognised payload' });
  }

  const { event, data } = parsed.data;
  if (!HANDLED_EVENTS.has(event)) {
    return NextResponse.json({ received: true, handled: false, reason: `ignored ${event}` });
  }

  const { service } = getContainer();

  try {
    const { booking, alreadyProcessed } = await service.confirmPayment({ processorRef: data.reference });
    return NextResponse.json({
      received: true,
      handled: true,
      alreadyProcessed,
      bookingId: booking.id,
      reference: booking.reference,
      status: booking.status
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Confirmation failed';
    // A mismatch is a real problem that needs a human: report it, but still
    // acknowledge receipt so the retry storm does not mask the alert.
    return NextResponse.json({ received: true, handled: false, error: message }, { status: 202 });
  }
}
