'use client';

/* eslint-disable @next/next/no-img-element */

/**
 * Listing card.
 *
 * THE LAYOUT IS HORIZONTAL, AND WHY
 * ---------------------------------
 * Modelled on how Nigerian property portals present a result: a landscape
 * thumbnail on the left, and everything a guest scans - price, type, name,
 * location, spec row, poster - stacked to its right. It is denser than a grid of
 * portrait tiles and it reads in one sweep: price first, then what the place is,
 * then where, then how to reach it.
 *
 * The thumbnail is landscape rather than a tall hero because most cards have no
 * photograph of their own. A 240px portrait void on every row was the ugliest
 * thing on the site; a shorter landscape slot that carries location and spec when
 * there is no photograph keeps the row dense either way.
 *
 * WHY THE THUMBNAIL IS USUALLY A TEXTURE, NOT A PHOTOGRAPH
 * -------------------------------------------------------
 * The portals we crawl stamp their own watermark across every image they host, so
 * we do not republish them - see `extraction/watermark.py`, which is where that
 * decision is recorded and tested. The striped gradient is a deliberate
 * placeholder: it cannot be mistaken for a room, which is the point. A stock
 * apartment here would be the one genuinely dishonest thing this card could do.
 *
 * The layout deliberately works with either, so the day a source publishes clean
 * photographs - an operator's own site, a direct submission - the same card
 * renders them with no change.
 *
 * WHAT IS NOT HERE, AND WHY
 * -------------------------
 * No "Premium" badge: nothing in this directory is promoted and House3 charges
 * nothing, so the badge would be a lie about commercial status. No heart/save
 * button: nothing is stored server-side, so it would be a button that loses the
 * guest's list on reload. No "3 toilets", because toilets are not a field we
 * observe - and a spec row that invents one is worse than a shorter spec row.
 *
 * THE PRICE SAYS WHOSE IT IS
 * --------------------------
 * The figure is the OPERATOR's published rate, labelled "per night". The design's
 * version computed `Math.round(rate * 1.127)` - a hardcoded gross-up standing in
 * for our service fee. There is no service fee any more, so there is nothing to
 * gross up: the number shown is the number the operator published, which is the
 * number the guest will be quoted when they call.
 *
 * WHY THE CARD IS NOT ONE BIG ANCHOR
 * ----------------------------------
 * An `<a>` may not contain a `tel:` link - nested anchors are invalid and a
 * browser silently flattens them, so the call button would open the listing page
 * instead of the dialler. The thumbnail carries the link to the place's page and
 * the buttons sit outside it.
 */

import { formatNaira } from '@/domain/money';
import { telHref } from '@/domain/phone';
import { Card3D } from './primitives';

/** A card built from a real observed place. */
export type ListingCardModel = {
  id: string;
  name: string;
  area: string;
  /** The listing's own photograph, or null when we have none we can publish. */
  image: string | null;
  /** Kobo. The rate the operator published - never a House3 price. */
  rateKobo: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  type: string;
  /** How many photographs the listing published. Zero renders no count. */
  photoCount: number;
  /** Where to open the place. */
  href: string;
  /** The number the listing published, or null. The card's primary action. */
  phone: string | null;
  /** `https://wa.me/...`, prebuilt by the domain layer, or null. */
  whatsappHref: string | null;
  /** Who published it. Shown the way a portal shows the poster. */
  attribution: string;
  /** When we observed it, ISO date. Shown as a freshness badge. */
  lastSeenAt: string;
};

/**
 * A readable label for the property type, in the reference card's position.
 */
function typeLabel(type: string): string {
  const cleaned = type.replace(/_/g, ' ').trim();
  if (!cleaned) return 'Short stay';
  return `${cleaned.charAt(0).toUpperCase() + cleaned.slice(1)} · short stay`;
}

/**
 * Spec row entries, only those we actually observed.
 *
 * Built as a list so a missing field drops its own chip rather than rendering an
 * empty one. `bathrooms` is present on 256 of 260 published places and `bedrooms`
 * on all 260, so in practice the row is nearly always full - but "nearly always"
 * is not a reason to render a chip with nothing in it.
 */
function specRow(listing: ListingCardModel): Array<{ icon: string; value: string }> {
  const entries: Array<{ icon: string; value: string }> = [];
  if (listing.bedrooms !== null) {
    entries.push({ icon: '🛏', value: `${listing.bedrooms} bed${listing.bedrooms === 1 ? '' : 's'}` });
  }
  if (listing.bathrooms !== null) {
    entries.push({
      icon: '🛁',
      value: `${listing.bathrooms} bath${listing.bathrooms === 1 ? '' : 's'}`
    });
  }
  return entries;
}

export function ListingCard({ listing }: { listing: ListingCardModel }) {
  const rate = listing.rateKobo === null ? null : formatNaira(listing.rateKobo, { decimals: false });
  const phone = listing.phone;
  const specs = specRow(listing);

  return (
    <Card3D className="rounded-2xl group">
      <div
        className="rounded-2xl overflow-hidden flex flex-col sm:flex-row h-full"
        style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
      >
        {/* THUMBNAIL */}
        <div
          className="relative sm:w-[280px] sm:min-w-[280px] shrink-0 overflow-hidden"
          style={{ height: 210, background: 'var(--muted)' }}
        >
          {listing.image ? (
            <img
              src={listing.image}
              alt={listing.name}
              loading="lazy"
              className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
            />
          ) : (
            /*
              The placeholder texture. Diagonal stripes over a warm gradient, low
              contrast and obviously a texture - it must never be read as a
              photograph of a room. It carries the location because the row beside
              it can be long and an empty box reads as a broken card.
            */
            <div
              className="w-full h-full flex flex-col justify-end p-4"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(135deg, rgba(217,124,43,0.10) 0px, rgba(217,124,43,0.10) 2px, transparent 2px, transparent 14px), linear-gradient(150deg, rgba(217,124,43,0.22) 0%, rgba(20,14,10,0.96) 72%)'
              }}
            >
              <p
                className="text-lg font-semibold m-0"
                style={{ fontFamily: 'var(--font-outfit)', color: 'var(--foreground)' }}
              >
                {listing.area}
              </p>
              <p
                className="text-xs mt-1 m-0"
                style={{ fontFamily: 'var(--font-outfit)', color: 'var(--muted-foreground)' }}
              >
                Ask the property for pictures
              </p>
            </div>
          )}

          {/* The photo count, the way a portal shows it on a thumbnail. It tells
              the guest how much there is to look at, which is what they act on. */}
          {listing.photoCount > 1 ? (
            <span
              className="absolute bottom-3 left-3 px-2 py-1 rounded-md text-xs font-semibold"
              style={{
                background: 'rgba(0,0,0,0.66)',
                backdropFilter: 'blur(8px)',
                color: '#fff',
                fontFamily: 'var(--font-outfit)'
              }}
            >
              ▣ {listing.photoCount}
            </span>
          ) : null}

          {/*
            The freshness badge, in the reference card's top-left slot. It reports
            our own observation date rather than the source's listing age, because
            the observation date is the thing we actually know - "added yesterday"
            is the source's claim about itself.
          */}
          <span
            className="absolute top-3 left-3 px-2.5 py-1 rounded-full text-xs font-semibold"
            style={{
              background: 'rgba(0,0,0,0.6)',
              backdropFilter: 'blur(8px)',
              color: 'var(--foreground)',
              fontFamily: 'var(--font-outfit)'
            }}
          >
            Seen {listing.lastSeenAt}
          </span>

          {/*
            Only when there is nothing below to click. With a number published the
            contact block is the card's route, and a thumbnail overlay as well
            would put two competing targets under the same thumb.
          */}
          {phone ? null : (
            <a
              href={listing.href}
              aria-label={`Open ${listing.name}`}
              className="absolute inset-0"
              style={{ textDecoration: 'none' }}
            />
          )}
        </div>

        {/* BODY */}
        <div className="flex-1 flex flex-col p-4 sm:p-5 min-w-0">
          <p className="m-0 leading-none" style={{ fontFamily: 'var(--font-outfit)' }}>
            <span className="text-2xl font-bold" style={{ color: 'var(--primary)' }}>
              {rate ?? 'Rate not published'}
            </span>
            {rate ? (
              <span className="text-sm font-normal" style={{ color: 'var(--muted-foreground)', marginLeft: 8 }}>
                /night
              </span>
            ) : null}
          </p>

          {/*
            The type, in the reference card's position. It says "short stay"
            rather than the reference's "for rent" because that is what this
            inventory is - a night-by-night stay, not an annual let - and
            borrowing the reference's wording would misdescribe every row.
          */}
          <p
            className="text-sm mt-1.5 m-0 font-medium"
            style={{ color: 'var(--primary)', fontFamily: 'var(--font-outfit)' }}
          >
            {typeLabel(listing.type)}
          </p>

          <h3
            className="text-lg font-semibold mt-1.5 m-0 truncate"
            style={{ fontFamily: 'var(--font-outfit)', color: 'var(--foreground)' }}
          >
            {listing.name}
          </h3>

          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-sm"
            style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
          >
            <span>📍 {listing.area}</span>
          </div>

          {specs.length > 0 ? (
            <div
              className="flex flex-wrap items-center gap-4 mt-3 text-sm"
              style={{ color: 'var(--foreground)', fontFamily: 'var(--font-outfit)' }}
            >
              {specs.map((spec) => (
                <span key={spec.value} className="flex items-center gap-1.5">
                  <span aria-hidden="true">{spec.icon}</span>
                  {spec.value}
                </span>
              ))}
            </div>
          ) : null}

          {/*
            Who published it, the way a portal shows the poster at the foot of a
            card. It is the source rather than a "property agent" portrait,
            because the source is who we actually observed.
          */}
          <div
            className="flex items-center gap-1.5 mt-3.5 pt-3 border-t text-xs"
            style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
          >
            🏢 <span className="truncate">{listing.attribution}</span>
          </div>

          <div className="flex items-center gap-2 mt-auto pt-3">
            {phone ? (
              <>
                <a
                  href={telHref(phone)}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl font-semibold transition-opacity hover:opacity-85"
                  style={{
                    background: 'var(--primary)',
                    color: 'var(--primary-foreground)',
                    fontFamily: 'var(--font-outfit)',
                    textDecoration: 'none',
                    fontSize: 15
                  }}
                >
                  <span aria-hidden="true">☎</span>
                  Call
                </a>

                {listing.whatsappHref ? (
                  <a
                    href={listing.whatsappHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Message ${listing.attribution} on WhatsApp`}
                    className="flex items-center justify-center rounded-xl transition-opacity hover:opacity-85"
                    style={{
                      width: 44,
                      height: 44,
                      flexShrink: 0,
                      background: 'var(--secondary)',
                      color: 'var(--foreground)',
                      textDecoration: 'none',
                      fontSize: 18
                    }}
                  >
                    <span aria-hidden="true">💬</span>
                  </a>
                ) : null}

                <a
                  href={listing.href}
                  className="px-3 py-2.5 rounded-xl text-sm font-medium transition-opacity hover:opacity-85"
                  style={{
                    background: 'var(--secondary)',
                    color: 'var(--foreground)',
                    fontFamily: 'var(--font-outfit)',
                    textDecoration: 'none'
                  }}
                >
                  Details
                </a>
              </>
            ) : (
              <a
                href={listing.href}
                className="flex-1 flex items-center justify-center px-3 py-2.5 rounded-xl text-sm font-medium"
                style={{
                  background: 'var(--secondary)',
                  color: 'var(--muted-foreground)',
                  fontFamily: 'var(--font-outfit)',
                  textDecoration: 'none'
                }}
              >
                No phone published — view details
              </a>
            )}
          </div>
        </div>
      </div>
    </Card3D>
  );
}

