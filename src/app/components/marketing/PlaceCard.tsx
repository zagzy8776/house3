/**
 * One row of the operator directory.
 *
 * THE PHOTOGRAPH SLOT
 *
 * There is no photograph, and that is a deliberate design decision rather than a
 * missing feature. The card renders a typographic panel built from the facts it
 * actually has - what the place is, where it is, what it costs - plus a prompt to
 * the operator to claim the listing and send us their own photos.
 *
 * Filling that slot with a stock photograph of a different apartment would be the
 * one genuinely dishonest thing this page could do: the guest would believe they
 * were looking at the room they are about to call about.
 *
 * THE PRICE IS LABELLED AS ADVERTISED
 *
 * `advertisedPriceKobo` is what the operator published on their own listing, seen
 * by us on a date. It is not a rate we can charge and there is no code path that
 * turns it into one. The word "advertised" and the observation date are on the
 * card because without them the number reads like a price we are offering.
 */

import { Card3D } from './primitives';
import type { DirectoryPlace } from '@/domain/directory';
import {
  bookableSearchHref,
  contactLabel,
  formatAdvertisedRate,
  placeDescriptor,
  placeLocation
} from '@/domain/directory';
import { formatNaira } from '@/domain/money';

export function PlaceCard({
  place,
  stateName
}: {
  place: DirectoryPlace;
  stateName?: string | null;
}) {
  const descriptor = placeDescriptor(place);
  const location = placeLocation(place, stateName);
  const rate = formatAdvertisedRate(place, (kobo) => formatNaira(kobo, { decimals: false }));
  const searchHref = bookableSearchHref(place);
  const canContact = place.contactRoute.kind !== 'NONE' && place.contactRoute.href;
  const claimHref = `mailto:partners@house3.ng?subject=${encodeURIComponent(
    `Claim listing ${place.id}`
  )}`;

  return (
    <Card3D className="rounded-2xl overflow-hidden group">
      <div
        className="rounded-2xl overflow-hidden h-full flex flex-col"
        style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
      >
        {/* The photo slot. Facts, not a stand-in image. */}
        <div
          className="relative overflow-hidden flex flex-col justify-end p-5"
          style={{
            minHeight: 150,
            background: 'linear-gradient(140deg, rgba(217,124,43,0.16) 0%, rgba(20,14,10,0.9) 70%)'
          }}
        >
          <span
            className="absolute top-3 left-3 text-xs px-2 py-0.5 rounded-full"
            style={{
              background: 'rgba(0,0,0,0.45)',
              color: 'var(--accent)',
              fontFamily: 'var(--font-outfit)',
              border: '1px solid rgba(217,124,43,0.25)'
            }}
          >
            Directory entry
          </span>

          <p
            className="m-0 font-semibold text-lg leading-tight"
            style={{ fontFamily: 'var(--font-outfit)', color: 'var(--foreground)' }}
          >
            {descriptor}
          </p>
          {location ? (
            <p
              className="m-0 text-sm mt-1"
              style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
            >
              {location}
            </p>
          ) : null}

          <p
            className="m-0 text-xs mt-3"
            style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
          >
            No photos yet. Seen on {place.attribution}.
          </p>
        </div>

        <div className="p-5 flex flex-col flex-1">
          {place.operatorName ? (
            <p
              className="m-0 text-sm font-medium"
              style={{ fontFamily: 'var(--font-outfit)', color: 'var(--foreground)' }}
            >
              {place.operatorName}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-1.5 mt-2 mb-4">
            {place.bathrooms !== null ? <Chip>{place.bathrooms} bath</Chip> : null}
            {place.pmsDetected ? <Chip>{place.pmsDetected}</Chip> : null}
            {place.instagram ? <Chip>instagram</Chip> : null}
          </div>

          <div
            className="flex justify-between items-end pt-3 border-t mt-auto"
            style={{ borderColor: 'var(--border)' }}
          >
            <div>
              <p
                className="text-xs mb-0.5 m-0"
                style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
              >
                {rate ? `advertised, seen ${place.lastSeenAt}` : 'rate not published'}
              </p>
              <p
                className="font-bold text-lg m-0"
                style={{
                  fontFamily: 'var(--font-jetbrains)',
                  color: rate ? 'var(--primary)' : 'var(--muted-foreground)'
                }}
              >
                {rate ?? '—'}
              </p>
            </div>

            {canContact ? (
              <a
                href={place.contactRoute.href as string}
                rel="nofollow noopener"
                target={place.contactRoute.kind === 'BOOKING_URL' ? '_blank' : undefined}
                className="px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 hover:opacity-80"
                style={{
                  background: 'var(--primary)',
                  color: 'var(--primary-foreground)',
                  fontFamily: 'var(--font-outfit)',
                  textDecoration: 'none'
                }}
              >
                {contactLabel(place.contactRoute, place.pmsDetected)}
              </a>
            ) : null}
          </div>

          {/* Three exits, in order of what we can actually honour. */}
          <div
            className="flex flex-wrap gap-3 mt-4 pt-3 border-t text-xs"
            style={{ borderColor: 'var(--border)', fontFamily: 'var(--font-outfit)' }}
          >
            {searchHref ? (
              <a href={searchHref} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                Book a confirmed stay nearby →
              </a>
            ) : null}
            <a href={claimHref} style={{ color: 'var(--muted-foreground)', textDecoration: 'none' }}>
              Manage this listing
            </a>
            <a
              href={place.sourceUrl}
              rel="nofollow noopener"
              target="_blank"
              style={{ color: 'var(--muted-foreground)', textDecoration: 'none' }}
            >
              Source
            </a>
          </div>
        </div>
      </div>
    </Card3D>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-xs px-2 py-0.5 rounded-full"
      style={{
        background: 'rgba(217,124,43,0.12)',
        color: 'var(--accent)',
        fontFamily: 'var(--font-outfit)',
        border: '1px solid rgba(217,124,43,0.2)'
      }}
    >
      {children}
    </span>
  );
}
