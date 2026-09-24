'use client';

/* eslint-disable @next/next/no-img-element */

/**
 * Listing card.
 *
 * CONTACT-FIRST, BECAUSE THAT IS THE WHOLE PRODUCT
 * ------------------------------------------------
 * House3 does not take a booking or a payment. A guest reads a card, then phones
 * the operator. So the number is the most useful thing on the card and it is
 * rendered as one: a `tel:` link, tappable, with WhatsApp beside it. Everything
 * else - the layout, the banner, the rate - exists to get a guest to that button.
 *
 * WHY THE BANNER IS A BANNER AND NOT A PHOTOGRAPH
 * -----------------------------------------------
 * Most cards have no photograph, because the portals we crawl stamp their own
 * watermark across every image they host and we will not republish that. A 200px
 * empty box on every card looked broken, so the space carries the things a guest
 * can actually use - where it is, what it is - and a card WITH a photograph still
 * shows the photograph.
 *
 * The striped gradient is a deliberate placeholder texture, not a stand-in image.
 * It cannot be mistaken for a room, which is the point: a stock apartment here
 * would be the one genuinely dishonest thing this card could do.
 *
 * THE PRICE SAYS WHOSE IT IS
 * --------------------------
 * The figure is the OPERATOR's published rate, labelled "per night". The design's
 * version computed `Math.round(rate * 1.127)` - a hardcoded gross-up standing in
 * for our service fee. There is no service fee any more, so there is nothing to
 * gross up: the number shown is the number the operator published, which is the
 * number the guest will be quoted when they call.
 */

import { formatNaira } from '@/domain/money';
import { prettyPhone, telHref } from '@/domain/phone';
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
  /** True when the listing published a gallery rather than a single image. */
  hasGallery: boolean;
  /** How many photographs the listing published. Zero renders the placeholder. */
  photoCount: number;
  /** Where to open the place. */
  href: string;
  tags: string[];
  /** The number the listing published, or null. The card's primary action. */
  phone: string | null;
  /** `https://wa.me/...`, prebuilt by the domain layer, or null. */
  whatsappHref: string | null;
};

/**
 * The clickable half of the banner, when the banner has to be clickable at all.
 *
 * An `<a>` may not contain a `tel:` link - nested anchors are invalid HTML and a
 * browser silently flattens them, so the call button would open the listing page
 * instead of the dialler. The card is therefore NOT one big anchor: this overlay
 * covers the banner and carries the link to the place's page, and everything below
 * sits outside it.
 */
function BannerLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      aria-label={`Open ${label}`}
      className="absolute inset-0"
      style={{ textDecoration: 'none' }}
    />
  );
}

export function ListingCard({ listing }: { listing: ListingCardModel }) {
  const rate = listing.rateKobo === null ? null : formatNaira(listing.rateKobo, { decimals: false });
  const phone = listing.phone;

  return (
    <Card3D className="rounded-2xl overflow-hidden group">
      <div
        className="rounded-2xl overflow-hidden h-full flex flex-col"
        style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
      >
        <div className="relative overflow-hidden" style={{ height: 200, background: 'var(--muted)' }}>
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
              photograph of a room.
            */
            <div
              className="w-full h-full flex flex-col justify-end p-5"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(135deg, rgba(217,124,43,0.10) 0px, rgba(217,124,43,0.10) 2px, transparent 2px, transparent 14px), linear-gradient(150deg, rgba(217,124,43,0.22) 0%, rgba(20,14,10,0.96) 72%)'
              }}
            >
              <p
                className="text-2xl font-semibold m-0"
                style={{ fontFamily: 'var(--font-outfit)', color: 'var(--foreground)' }}
              >
                {listing.area}
              </p>
              <p
                className="text-sm mt-1 m-0"
                style={{ fontFamily: 'var(--font-outfit)', color: 'var(--muted-foreground)' }}
              >
                {[listing.bedrooms !== null ? `${listing.bedrooms} bedroom` : null, listing.type]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
          )}

          {listing.image ? (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ background: 'linear-gradient(to top, rgba(10,8,6,0.7) 0%, transparent 55%)' }}
            />
          ) : null}

          {/* The photo count, not a "Featured" badge: it tells the guest how much
              there is to look at, which is the thing they act on. */}
          {listing.photoCount > 1 ? (
            <div className="absolute top-3 left-3">
              <span
                className="px-2.5 py-1 rounded-full text-xs font-semibold"
                style={{
                  background: 'rgba(0,0,0,0.6)',
                  backdropFilter: 'blur(8px)',
                  color: 'var(--foreground)',
                  fontFamily: 'var(--font-outfit)'
                }}
              >
                {listing.photoCount} photos
              </span>
            </div>
          ) : null}

          {listing.image ? (
            <div className="absolute bottom-3 left-3 right-3 pointer-events-none">
              <p
                className="text-white font-semibold text-sm m-0"
                style={{ fontFamily: 'var(--font-outfit)', textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}
              >
                {listing.area}
              </p>
            </div>
          ) : null}

          {/*
            Only when there is nothing below to click. With a number published the
            contact block is the card's route, and a banner overlay as well would
            put two competing targets under the same thumb.
          */}
          {phone ? null : <BannerLink href={listing.href} label={listing.name} />}
        </div>

        {/*
          THE CONTACT BLOCK
          -----------------
          This is what the card is for. It sits directly under the banner so the
          eye lands on the number instead of hunting for it in a footer, and it is
          deliberately outside the banner's link overlay so the two do not compete
          for the same tap.
        */}
        <div
          className="px-4 py-3 border-t"
          style={{ borderColor: 'var(--border)', background: 'rgba(255,255,255,0.02)' }}
        >
          {phone ? (
            <div className="flex items-center gap-2">
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
                {prettyPhone(phone)}
              </a>

              {listing.whatsappHref ? (
                <a
                  href={listing.whatsappHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Message ${listing.name} on WhatsApp`}
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
            </div>
          ) : (
            <a
              href={listing.href}
              className="flex items-center justify-center px-3 py-2.5 rounded-xl text-sm font-medium"
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

          <div className="flex items-center justify-between gap-3 mt-2.5">
            <p className="text-sm font-semibold m-0" style={{ fontFamily: 'var(--font-outfit)' }}>
              {rate ? (
                <>
                  {rate}
                  <span
                    className="font-normal"
                    style={{ color: 'var(--muted-foreground)', fontSize: 12, marginLeft: 6 }}
                  >
                    per night
                  </span>
                </>
              ) : (
                <span style={{ color: 'var(--muted-foreground)', fontWeight: 400, fontSize: 13 }}>
                  rate not published
                </span>
              )}
            </p>

            <a
              href={listing.href}
              className="text-xs whitespace-nowrap"
              style={{ color: 'var(--accent)', fontFamily: 'var(--font-outfit)', textDecoration: 'none' }}
            >
              Details →
            </a>
          </div>
        </div>

        <div className="px-4 pt-3 pb-4 mt-auto">
          <p
            className="text-sm font-semibold mb-2 m-0"
            style={{ fontFamily: 'var(--font-outfit)', color: 'var(--foreground)' }}
          >
            {listing.name}
          </p>

          {listing.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {listing.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{
                    background: 'rgba(217,124,43,0.12)',
                    color: 'var(--accent)',
                    fontFamily: 'var(--font-outfit)',
                    border: '1px solid rgba(217,124,43,0.2)'
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </Card3D>
  );
}

