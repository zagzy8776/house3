/**
 * GET /api/search
 *
 *   ?state=LA&area=Lekki%20Phase%201&checkIn=2026-06-01&checkOut=2026-06-03&guests=2
 *
 * Returns bookable units in a live state, each with the guest-facing total AND
 * the operator-facing net. Both numbers are returned on purpose: the UI must be
 * able to show the guest the full breakdown, and support must be able to answer
 * "how much did the operator get?" without opening a database.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { findState, liveStates } from '@/data/nigeria';
import { getContainer } from '@/server/container';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  state: z.string().min(1).max(4),
  area: z.string().min(1).optional(),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  guests: z.coerce.number().int().min(1).max(20).default(2)
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    state: url.searchParams.get('state') ?? '',
    area: url.searchParams.get('area') ?? undefined,
    checkIn: url.searchParams.get('checkIn') ?? '',
    checkOut: url.searchParams.get('checkOut') ?? '',
    guests: url.searchParams.get('guests') ?? '2'
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid search parameters', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { state, area, checkIn, checkOut, guests } = parsed.data;
  const rolloutMode = (process.env.ROLLOUT_MODE === 'all' ? 'all' : 'phased') as 'all' | 'phased';
  const lastLiveLaunchOrder = Number(process.env.LAST_LIVE_LAUNCH_ORDER ?? '5');

  const stateSeed = findState(state);
  if (!stateSeed) {
    return NextResponse.json({ error: `Unknown state code "${state}"` }, { status: 400 });
  }
  if (!liveStates(rolloutMode, lastLiveLaunchOrder).some((live) => live.code === state)) {
    return NextResponse.json(
      { error: `${stateSeed.name} is not live yet`, liveStates: liveStates(rolloutMode, lastLiveLaunchOrder).map((s) => s.code) },
      { status: 409 }
    );
  }

  const { service } = getContainer();

  try {
    const outcome = service.search({
      stateCode: state,
      area,
      stay: { checkIn, checkOut },
      guests
    });

    return NextResponse.json({
      state: { code: stateSeed.code, name: stateSeed.name },
      area: area ?? null,
      nights: outcome.nights,
      results: outcome.results.map((result) => ({
        unitId: result.unit.id,
        name: result.unit.name,
        unitType: result.unit.unitType,
        area: result.unit.area,
        bedrooms: result.unit.bedrooms,
        bathrooms: result.unit.bathrooms,
        maxGuests: result.unit.maxGuests,
        // Named attribution: the guest always knows whose home this is.
        operator: result.partner.displayName,
        // Guest-facing money, line by line, so the fee is never hidden.
        price: {
          currency: result.quote.currency,
          lines: result.quote.lines,
          totalKobo: result.quote.totalKobo,
          operatorRateKobo: result.quote.roomSubtotalKobo,
          serviceFeeKobo: result.quote.serviceFeeKobo,
          serviceFeeVatKobo: result.quote.serviceFeeVatKobo
        },
        feePolicyId: result.quote.policyId
      })),
      unavailable: outcome.rejected.map((entry) => ({
        unitId: entry.unitId,
        name: entry.unitName,
        reasons: entry.reasons
      }))
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Search failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
