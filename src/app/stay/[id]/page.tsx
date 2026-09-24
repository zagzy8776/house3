/* eslint-disable @next/next/no-img-element */

/**
 * One place, in full.
 *
 * WHAT THIS PAGE IS
 * -----------------
 * A guest clicks a listing and sees everything we observed about it: the
 * gallery, what the place is, where it is, what the operator published as a
 * rate, and how to reach them. It is the destination the card has always
 * promised and never had.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a checkout. There is no payment path in this application at all, and
 * the buttons on the right are a phone dial, a WhatsApp thread, the operator's
 * own site and the source listing. `HANDOFF_DISCLOSURE` says so in words rather
 * than leaving the guest to discover it.
 *
 * THE GALLERY
 * -----------
 * The photographs are the ones the listing itself published, carried through the
 * acquisition pipeline (`services/acquisition/extraction/media.py`) and attributed
 * to the source. A place whose listing published no photographs gets a panel that
 * says exactly that, because a stock photograph of a different apartment is the
 * one genuinely dishonest thing this page could do.
 *
 * WHY THE ID IS DECODED
 * ---------------------
 * A place id is `{source}:{listingId}` - see `build_directory` in the pipeline -
 * so it contains a colon. Next hands the segment over encoded, and a route that
 * skipped the decode would look up `npc%3A1043552` and find nothing.
 */

import Link from 'next/link';
import { findState } from '@/data/nigeria';
import {
  contactLabel,
  formatAdvertisedRate,
  placeDescriptor,
  placeDetailRows,
  placeLocation,
  type DirectoryPlace
} from '@/domain/directory';
import { HANDOFF_DISCLOSURE, contactRoutes } from '@/domain/contact';
import { formatNaira } from '@/domain/money';
import { loadPlace } from '@/server/directorySource';
import { Gallery } from '../../components/marketing/Gallery';

export const dynamic = 'force-dynamic';

export default async function StayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const placeId = decodeURIComponent(id);
  const place = await loadPlace(placeId);

  if (!place) return <NotFound id={placeId} />;

  const stateName = findState(place.state ?? '')?.name ?? null;
  const rows = placeDetailRows(place, stateName);
  const rate = formatAdvertisedRate(place, (kobo) => formatNaira(kobo, { decimals: false }));
  const descriptor = placeDescriptor(place);

  // Reuse the referral resolver rather than reading `contactRoute` directly, so
  // this page offers the same ranked destinations as the rest of the app: the
  // operator's own site first, then phone, then WhatsApp, then the source.
  const routes = contactRoutes({
    sourceUrl: place.sourceUrl,
    sourceName: place.attribution,
    operatorName: place.operatorName,
    operatorWebsite: place.website,
    phone: place.phone,
    instagram: place.instagram,
    availabilityHintUrl: null
  });

  return (
    <main className="min-h-screen" style={{ background: 'var(--background)', color: 'var(--foreground)' }}>
      <TopBar />

      <div className="max-w-6xl mx-auto px-6 pb-20">
        <Gallery images={place.media} label={descriptor} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-10 mt-10">
          <div className="lg:col-span-2">
            <p className="text-sm mb-2 m-0" style={{ color: 'var(--accent)', fontFamily: 'var(--font-outfit)' }}>
              {placeLocation(place, stateName) ?? 'Location not published'}
            </p>

            <h1 className="text-3xl md:text-4xl font-light mb-4 m-0" style={{ fontFamily: 'var(--font-fraunces)' }}>
              {descriptor}
            </h1>

            <p
              className="text-base mb-8 m-0 max-w-2xl"
              style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)', lineHeight: 1.7 }}
            >
              {place.operatorName ? (
                <>
                  Listed by <strong style={{ color: 'var(--foreground)' }}>{place.operatorName}</strong>.{' '}
                </>
              ) : null}
              {HANDOFF_DISCLOSURE}
            </p>

            <DetailTable rows={rows} />
          </div>

          <RatePanel place={place} rate={rate} routes={routes} />
        </div>

        <SourceNotice place={place} stateName={stateName} />
      </div>
    </main>
  );
}

/** The rate, and the four ways to reach the operator. */
function RatePanel({
  place,
  rate,
  routes
}: {
  place: DirectoryPlace;
  rate: string | null;
  routes: ReturnType<typeof contactRoutes>;
}) {
  return (
    <aside className="lg:col-span-1">
      <div
        className="rounded-2xl p-6 lg:sticky lg:top-8"
        style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
      >
        <p
          className="text-xs mb-1 m-0 uppercase tracking-wider"
          style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
        >
          {rate ? 'Rate the operator published' : 'Rate not published'}
        </p>
        <p
          className="text-3xl font-bold m-0 mb-1"
          style={{
            fontFamily: 'var(--font-jetbrains)',
            color: rate ? 'var(--primary)' : 'var(--muted-foreground)'
          }}
        >
          {rate ?? '—'}
        </p>
        <p
          className="text-xs m-0 mb-6"
          style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)', lineHeight: 1.6 }}
        >
          {rate
            ? `Seen on ${place.attribution}, ${place.lastSeenAt}. Confirm the current price with the property.`
            : 'This operator did not publish a price we could read.'}
        </p>

        <div className="flex flex-col gap-2.5">
          {routes.map((route) => (
            <a
              key={route.kind}
              href={route.destination}
              rel="nofollow noopener"
              target="_blank"
              className="px-4 py-3 rounded-xl text-sm font-semibold text-center transition-all duration-200 hover:opacity-90"
              style={{
                background: route.primary ? 'var(--primary)' : 'var(--secondary)',
                color: route.primary ? 'var(--primary-foreground)' : 'var(--foreground)',
                fontFamily: 'var(--font-outfit)',
                textDecoration: 'none'
              }}
            >
              {route.label}
            </a>
          ))}
        </div>

        <p
          className="text-xs m-0 mt-5 pt-4 border-t"
          style={{
            color: 'var(--muted-foreground)',
            fontFamily: 'var(--font-outfit)',
            borderColor: 'var(--border)',
            lineHeight: 1.6
          }}
        >
          {contactLabel(place.contactRoute, place.pmsDetected)}
        </p>
      </div>
    </aside>
  );
}

function TopBar() {
  return (
    <div className="max-w-6xl mx-auto px-6 pt-8 pb-6">
      <Link
        href="/"
        className="text-sm transition-colors hover:opacity-70"
        style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)', textDecoration: 'none' }}
      >
        ← House3
      </Link>
    </div>
  );
}

function DetailTable({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-0 mt-2">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex justify-between gap-4 py-3 border-t"
          style={{ borderColor: 'var(--border)' }}
        >
          <dt className="text-sm m-0" style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}>
            {row.label}
          </dt>
          <dd className="text-sm m-0 text-right" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-outfit)' }}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SourceNotice({ place, stateName }: { place: DirectoryPlace; stateName: string | null }) {
  const searchHref = place.state
    ? `/search?state=${place.state}${place.area ? `&area=${encodeURIComponent(place.area)}` : ''}`
    : '/search';

  return (
    <div className="rounded-2xl p-6 mt-12" style={{ background: 'var(--muted)', border: '1px solid var(--border)' }}>
      <p
        className="text-sm m-0"
        style={{ color: 'var(--secondary-foreground)', fontFamily: 'var(--font-outfit)', lineHeight: 1.7 }}
      >
        These details were observed on{' '}
        <a
          href={place.sourceUrl}
          rel="nofollow noopener"
          target="_blank"
          style={{ color: 'var(--accent)', textDecoration: 'none' }}
        >
          {place.attribution}
        </a>{' '}
        and last checked on {place.lastSeenAt}. Photographs are the ones the listing published. Details
        change, so confirm anything that matters with the property before you travel. House3 does not
        take the booking or the payment for this place.
        {place.state ? (
          <>
            {' '}
            <Link href={searchHref} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
              See what else is in {place.area ?? stateName ?? 'this area'} →
            </Link>
          </>
        ) : null}
      </p>
    </div>
  );
}

function NotFound({ id }: { id: string }) {
  return (
    <main className="min-h-screen" style={{ background: 'var(--background)', color: 'var(--foreground)' }}>
      <TopBar />
      <div className="max-w-2xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-light mb-4 m-0" style={{ fontFamily: 'var(--font-fraunces)' }}>
          We do not have that place
        </h1>
        <p
          className="text-base m-0"
          style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)', lineHeight: 1.7 }}
        >
          No listing with the reference <code style={{ color: 'var(--accent)' }}>{id}</code> is in the
          directory. It may have been withdrawn by the operator, or the link may be out of date.{' '}
          <Link href="/" style={{ color: 'var(--accent)' }}>
            Browse what we do have →
          </Link>
        </p>
      </div>
    </main>
  );
}
