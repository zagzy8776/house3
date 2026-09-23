/**
 * DEV-ONLY fake checkout.
 *
 * Only reachable when no real processor secret is configured; it 404s as soon as
 * live Paystack keys are present, so it cannot be used to confirm a booking in
 * production. It exists so the funnel can be walked end to end (hold -> pay ->
 * confirm -> split ledger) before any merchant account exists.
 */

import { getContainer } from '@/server/container';

export const dynamic = 'force-dynamic';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[char] ?? char;
  });
}

function page(reference: string, body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>House3 demo payment</title></head>
     <body style="font-family:system-ui,sans-serif;max-width:560px;margin:60px auto;padding:24px">
       <h1>Demo payment gateway</h1>
       <p style="color:#555">Reference <code>${escapeHtml(reference)}</code></p>
       ${body}
     </body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}

export async function GET(_request: Request, context: { params: Promise<{ reference: string }> }) {
  const { reference } = await context.params;
  const { demoPayments, repo } = getContainer();

  if (!demoPayments) {
    return new Response('Not found', { status: 404 });
  }

  const booking = repo.getBookingByProcessorRef(reference);
  if (!booking) return new Response('Unknown payment reference', { status: 404 });

  const lines = booking.quote.lines
    .map(
      (line) =>
        `<tr><td>${escapeHtml(line.label)}</td><td style="text-align:right">${(line.amountKobo / 100).toLocaleString(
          'en-NG'
        )} NGN</td></tr>`
    )
    .join('');

  return page(
    reference,
    `<table style="width:100%;border-collapse:collapse">${lines}
       <tr style="font-weight:600;border-top:1px solid #ccc">
         <td style="padding-top:8px">Total</td>
         <td style="padding-top:8px;text-align:right">${(booking.quote.totalKobo / 100).toLocaleString(
           'en-NG'
         )} NGN</td>
       </tr>
     </table>
     <form method="post" style="margin-top:24px">
       <button type="submit" style="padding:12px 20px;cursor:pointer">Pay now (demo)</button>
     </form>
     <p style="color:#888;font-size:13px">This confirms the booking through the same code path a Paystack
     webhook uses, including the amount check and the split ledger.</p>`
  );
}

export async function POST(_request: Request, context: { params: Promise<{ reference: string }> }) {
  const { reference } = await context.params;
  const { demoPayments, service } = getContainer();

  if (!demoPayments) {
    return new Response('Not found', { status: 404 });
  }

  try {
    const { booking } = await service.confirmPayment({ processorRef: reference });
    return Response.redirect(
      `http://localhost:${process.env.PORT ?? '3000'}/checkout/return?reference=${encodeURIComponent(
        booking.reference
      )}`,
      303
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Confirmation failed';
    return page(reference, `<p style="color:#b00020">${escapeHtml(message)}</p>`);
  }
}
