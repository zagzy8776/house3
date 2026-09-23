'use client';

/* eslint-disable @next/next/no-img-element */

/**
 * Listing card - markup ported from the design, data from the real engine.
 *
 * The design computed the guest price as `Math.round(rate * 1.127)` - a
 * hardcoded gross-up. This takes `guestNightlyKobo` computed by
 * `src/domain/pricing.ts`, so the card cannot drift from the checkout total:
 * the same fee policy, the same rounding, the same VAT treatment.
 *
 * The rating badge only renders when a real rating exists. We have no reviews
 * yet, so it is absent rather than invented - the design's 4.9/5.0 values were
 * placeholders.
 */

import { Card3D } from './primitives';
import type { MarketingListing } from '@/content/marketing';

export type ListingCardModel = MarketingListing & {
  /** Guest-facing per-night total, already including fee and VAT, pre-formatted. */
  guestNightlyDisplay: string;
};

export function ListingCard({ listing }: { listing: ListingCardModel }) {
  const searchHref = `/search?area=${encodeURIComponent(listing.area.split(',')[0] ?? listing.area)}&guests=2`;

  return (
    <Card3D className="rounded-2xl overflow-hidden cursor-pointer group">
      <div
        className="rounded-2xl overflow-hidden"
        style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
      >
        <div className="relative overflow-hidden" style={{ height: 240, background: '#111' }}>
          <img
            src={listing.image}
            alt={listing.name}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
          />
          <div
            className="absolute inset-0"
            style={{ background: 'linear-gradient(to top, rgba(10,8,6,0.7) 0%, transparent 55%)' }}
          />

          {listing.featured ? (
            <div className="absolute top-3 left-3">
              <span
                className="px-2.5 py-1 rounded-full text-xs font-semibold"
                style={{
                  background: 'var(--primary)',
                  color: 'var(--primary-foreground)',
                  fontFamily: 'var(--font-outfit)'
                }}
              >
                Featured
              </span>
            </div>
          ) : null}

          <div className="absolute bottom-3 left-3 right-3 flex justify-between items-end">
            <p
              className="text-white font-semibold text-sm m-0"
              style={{ fontFamily: 'var(--font-outfit)', textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}
            >
              {listing.area}
            </p>
            {listing.rating ? (
              <div
                className="flex items-center gap-1 px-2 py-1 rounded-full"
                style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
              >
                <svg width="10" height="10" viewBox="0 0 12 12" fill="var(--accent)" aria-hidden="true">
                  <path d="M6 0l1.5 4.5H12L8.25 7.5 9.75 12 6 9l-3.75 3L3.75 7.5 0 4.5h4.5z" />
                </svg>
                <span className="text-xs font-medium text-white" style={{ fontFamily: 'var(--font-outfit)' }}>
                  {listing.rating}
                </span>
              </div>
            ) : null}
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
                {listing.beds} bed · {listing.baths} bath · {listing.sqm}m²
              </p>
            </div>
            <span
              className="px-2 py-0.5 rounded-lg text-xs"
              style={{
                background: 'var(--secondary)',
                color: 'var(--secondary-foreground)',
                fontFamily: 'var(--font-outfit)'
              }}
            >
              {listing.type}
            </span>
          </div>

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

          <div
            className="flex justify-between items-center pt-3 border-t"
            style={{ borderColor: 'var(--border)' }}
          >
            <div>
              <p
                className="text-xs mb-0.5 m-0"
                style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
              >
                per night, all fees in
              </p>
              <p
                className="font-bold text-lg m-0"
                style={{ fontFamily: 'var(--font-jetbrains)', color: 'var(--primary)' }}
              >
                {listing.guestNightlyDisplay}
              </p>
            </div>
            <a
              href={searchHref}
              className="px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 hover:opacity-80"
              style={{
                background: 'var(--secondary)',
                color: 'var(--foreground)',
                fontFamily: 'var(--font-outfit)',
                textDecoration: 'none'
              }}
            >
              View →
            </a>
          </div>
        </div>
      </div>
    </Card3D>
  );
}
