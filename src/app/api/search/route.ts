/**
 * GET /api/search
 *
 *   ?state=LA&area=Lekki%20Phase%201&checkIn=2026-06-01&checkOut=2026-06-03
 *   &guests=2&bedrooms=2&title=C_OF_O&band=200-400k&near=6.4418,3.474&radiusKm=5
 *
 * Filters compose (they intersect). Pass `near` for an explicit coordinate
 * radius, or `area` alone and the neighbourhood centroid is used. Returns both
 * the guest-facing total AND the operator-facing net, because support must be
 * able to answer "how much did the operator get?" without opening the database.
 *
 * Affiliate inventory is never returned in `results`: those units have no
 * House3 calendar or payment path. When one matches the query it appears in
 * `unavailable` with `distribution: "AFFILIATE"` so a client can render an
 * authorised partner handoff without mistaking it for bookable supply.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { findState, liveStates } from '@/data/nigeria';
import { allFeePolicies, defaultFeePolicy } from '@/data/feePolicies';
import { centroidForArea, PRICE_BANDS } from '@/domain/geo';
import { TITLE_DOCUMENTS, TITLE_DOCUMENT_LABELS, parseTitleDocuments } from '@/domain/title';
import { buildDirectoryRepository } from '@/server/directoryRepository';
import { createPlaceSearch } from '@/server/placeSearch';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  state: z.string().min(1).max(4),
  area: z.string().min(1).optional(),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  guests: z.coerce.number().int().min(1).max(20).default(2),
  /** Minimum bedrooms. */
  bedrooms: z.coerce.number().int().min(0).max(20).optional(),
  /** Comma-separated TitleDocument values, e.g. "C_OF_O,GOVERNORS_CONSENT". */
  title: z.string().max(200).optional(),
  /** Price band id from PRICE_BANDS, e.g. "100-200k". */
  band: z.string().max(40).optional(),
  /** "lat,lng" for a radius search. */
  near: z
    .string()
    .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
    .optional(),
  radiusKm: z.coerce.number().positive().max(200).optional(),
  sort: z.enum(['total-asc', 'total-desc', 'distance']).optional()
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    state: url.searchParams.get('state') ?? '',
    area: url.searchParams.get('area') ?? undefined,
    checkIn: url.searchParams.get('checkIn') ?? '',
    checkOut: url.searchParams.get('checkOut') ?? '',
    guests: url.searchParams.get('guests') ?? '2',
    bedrooms: url.searchParams.get('bedrooms') ?? undefined,
    title: url.searchParams.get('title') ?? undefined,
    band: url.searchParams.get('band') ?? undefined,
    near: url.searchParams.get('near') ?? undefined,
    radiusKm: url.searchParams.get('radiusKm') ?? undefined,
    sort: url.searchParams.get('sort') ?? undefined
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid search parameters', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { state, checkIn, checkOut, guests, bedrooms, title, band, near, radiusKm, sort } = parsed.data;
  const area = parsed.data.area;

  const rolloutMode = (process.env.ROLLOUT_MODE === 'all' ? 'all' : 'phased') as 'all' | 'phased';
  const lastLiveLaunchOrder = Number(process.env.LAST_LIVE_LAUNCH_ORDER ?? '5');

  const stateSeed = findState(state);
  if (!stateSeed) {
    return NextResponse.json({ error: `Unknown state code "${state}"` }, { status: 400 });
  }
  if (!liveStates(rolloutMode, lastLiveLaunchOrder).some((live) => live.code === state)) {
    return NextResponse.json(
      {
        error: `${stateSeed.name} is not live yet`,
        liveStates: liveStates(rolloutMode, lastLiveLaunchOrder).map((entry) => entry.code)
      },
      { status: 409 }
    );
  }

  const titleDocuments = parseTitleDocuments(title);
  if (title && titleDocuments.length === 0) {
    return NextResponse.json(
      { error: 'No valid title documents supplied', valid: TITLE_DOCUMENTS },
      { status: 400 }
    );
  }

  if (band && !PRICE_BANDS.some((entry) => entry.id === band)) {
    return NextResponse.json(
      { error: `Unknown price band "${band}"`, valid: PRICE_BANDS.map((entry) => entry.id) },
      { status: 400 }
    );
  }

  // `near` wins over `area`; `area` alone resolves to a centroid so that
  // "near Lekki Phase 1" works straight from the search box.
  let geoFilter: { center: { lat: number; lng: number }; radiusKm: number } | undefined;
  if (near) {
    const [latText, lngText] = near.split(',');
    geoFilter = { center: { lat: Number(latText), lng: Number(lngText) }, radiusKm: radiusKm ?? 5 };
  } else if (area) {
    const centroid = centroidForArea(area);
    if (centroid) geoFilter = { center: centroid, radiusKm: radiusKm ?? 5 };
  }

  // The published directory, not the demo fixtures. This route used to read the
  // in-memory demo inventory, so it returned nothing for data the site's own
  // pages were rendering.
  const repo = await buildDirectoryRepository();
  const policies = allFeePolicies();
  const search = createPlaceSearch({
    repo,
    feePolicyFor: (stateCode) =>
      policies.find((policy) => policy.subjectId === stateCode) ?? defaultFeePolicy()
  });

  try {
    const outcome = search.search({
      stateCode: state,
      // With a radius we do NOT also pin the exact area name, otherwise
      // "near Lekki Phase 1, 8km" would wrongly exclude Ikoyi.
      area: geoFilter ? undefined : area,
      stay: { checkIn, checkOut },
      guests,
      bedroomsMin: bedrooms,
      titleDocuments,
      priceBandId: band,
      near: geoFilter,
      sort
    });

    return NextResponse.json({
      state: { code: stateSeed.code, name: stateSeed.name },
      area: area ?? null,
      nights: outcome.nights,
      filters: {
        bedroomsMin: bedrooms ?? null,
        titleDocuments,
        titleLabels: titleDocuments.map((doc) => TITLE_DOCUMENT_LABELS[doc]),
        priceBandId: band ?? null,
        radiusKm: geoFilter?.radiusKm ?? null,
        sort: sort ?? 'total-asc'
      },
      results: outcome.results.map((result) => ({
        unitId: result.unit.id,
        name: result.unit.name,
        unitType: result.unit.unitType,
        area: result.unit.area,
        bedrooms: result.unit.bedrooms,
        bathrooms: result.unit.bathrooms,
        maxGuests: result.unit.maxGuests,
        // Null when not yet surveyed, rather than a guessed pin.
        location:
          result.unit.latitude !== null && result.unit.longitude !== null
            ? { lat: result.unit.latitude, lng: result.unit.longitude }
            : null,
        distanceKm: result.distanceKm ?? null,
        titleDocument: result.unit.titleDocument,
        titleLabel: TITLE_DOCUMENT_LABELS[result.unit.titleDocument],
        // Named attribution: the guest always knows whose home this is.
        operator: result.partner.displayName,
        // Guest-facing money, line by line, so the fee is never hidden.
        price: {
          currency: result.quote.currency,
          lines: result.quote.lines,
          totalKobo: result.quote.totalKobo,
          operatorRateKobo: result.quote.roomSubtotalKobo,
          cleaningFeeKobo: result.quote.cleaningFeeKobo
        },
        // There is no fee, because House3 charges none and takes no payment. The
        // pricing engine still computes one internally - it is the arithmetic of a
        // stay - but it is NOT emitted here. It used to be, and a client reading
        // `serviceFeeKobo` would reasonably conclude House3 takes ₦3,000 a booking.
        // A field that describes a charge that cannot happen is a false statement,
        // so it is removed rather than zeroed: zero reads as "we charge nothing
        // this time", which is a different and equally wrong claim.
        handoff: {
          source: result.unit.sourceName ?? null,
          sourceUrl: result.unit.sourceUrl ?? null
        }
      })),
      excluded: outcome.excluded.map((entry) => ({
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
