'use client';

/* eslint-disable @next/next/no-img-element */

/**
 * Listing card.
 *
 * TWO SOURCES, AND WHY THE CARD NO LONGER KNOWS WHICH
 * ---------------------------------------------------
 * This card renders whatever model it is handed. The homepage builds those
 * models from the acquisition pipeline's published directory - real places, real
 * observed rates, real photographs the listing published, and a link to the
 * place's own page.
 *
 * It used to take a `MarketingListing` from `src/content/marketing.ts`, which
 * meant the front page rendered invented names and Unsplash stock photographs as
 * if they were inventory. That is gone. `IllustrativeListingModel` below exists
 * only so the design can still be worked on against a full grid; nothing on the
 * site passes one.
 *
 * THE PRICE SAYS WHOSE IT IS
 * --------------------------
 * The figure is the OPERATOR's published rate, labelled "per night, operator's
 * rate". The design's version computed `Math.round(rate * 1.127)` - a hardcoded
 * gross-up standing in for our service fee. There is no service fee any more, so
 * there is nothing to gross up: the number shown is the number the operator
 * published, which is the number the guest will be quoted when they call.
 */

import { formatNaira } from '@/domain/money';
import { Card3D } from './primitives';

/** A card built from a real observed place. */
export type ListingCardModel = {
  id: string;
  name: string;
  area: string;
  /** The listing's own photograph, or null when it published none. */
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
};

export function ListingCard({ listing }: { listing: ListingCardModel }) {
  const rate = listing.rateKobo === null ? null : formatNaira(listing.rateKobo, { decimals: false });

  return (
    <Card3D className="rounded-2xl overflow-hidden cursor-pointer group">
      <a
        href={listing.href}
        className="rounded-2xl overflow-hidden block h-full"
        style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          textDecoration: 'none',
          color: 'inherit'
        }}
      >
        <div className="relative overflow-hidden" style={{ height: 240, background: 'var(--muted)' }}>
          {listing.image ? (
            <img
              src={listing.image}
              alt={listing.name}
              loading="lazy"
              className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
            />
          ) : (
            <div
              className="w-full h-full flex flex-col items-center justify-center px-6 text-center"
              style={{
                background: 'linear-gradient(140deg, rgba(217,124,43,0.16) 0%, rgba(20,14,10,0.9) 70%)'
              }}
            >
              <p
                className="text-sm m-0 font-medium"
                style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
              >
                No photographs published
              </p>
            </div>
          )}

          <div
            className="absolute inset-0"
            style={{ background: 'linear-gradient(to top, rgba(10,8,6,0.7) 0%, transparent 55%)' }}
          />

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

          <div className="absolute bottom-3 left-3 right-3">
            <p
              className="text-white font-semibold text-sm m-0"
              style={{ fontFamily: 'var(--font-outfit)', textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}
            >
              {listing.area}
            </p>
          </div>
        </div>

        <div className="p-5">
          <div className="flex justify-between items-start mb-3">
            <div>
              <p className="font-semibold m-0" style={{ fontFamily: 'var(--font-outfit)', color: 'var(--foreground)' }}>
                {listing.name}
              </p>
              <p
                className="text-sm mt-0.5 m-0"
                style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
              >
                {[
                  listing.bedrooms !== null ? `${listing.bedrooms} bed` : null,
                  listing.bathrooms !== null ? `${listing.bathrooms} bath` : null
                ]
                  .filter(Boolean)
                  .join(' · ') || 'Details not published'}
              </p>
            </div>
            <span
              className="px-2 py-0.5 rounded-lg text-xs whitespace-nowrap"
              style={{
                background: 'var(--secondary)',
                color: 'var(--secondary-foreground)',
                fontFamily: 'var(--font-outfit)'
              }}
            >
              {listing.type}
            </span>
          </div>

          {listing.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 mb-4">
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

          <div className="flex justify-between items-end pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
            <div>
              <p
                className="text-xs mb-0.5 m-0"
                style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
              >
                {rate ? "per night, operator's rate" : 'rate not published'}
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
            <span
              className="px-4 py-2 rounded-xl text-sm font-medium"
              style={{
                background: 'var(--secondary)',
                color: 'var(--foreground)',
                fontFamily: 'var(--font-outfit)'
              }}
            >
              View →
            </span>
          </div>
        </div>
      </a>
    </Card3D>
  );
}

