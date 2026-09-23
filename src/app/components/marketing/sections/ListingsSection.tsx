'use client';

/**
 * Listings grid with the type filters, ported from the design.
 *
 * The design's filter chips operated on a hardcoded array. These operate on the
 * models the server built from real inventory, so a filter that would produce an
 * empty grid shows the designed empty state instead of silently nothing.
 */

import { useState } from 'react';
import { FILTERS, SECTION_COPY } from '@/content/marketing';
import { ListingCard, type ListingCardModel } from '../ListingCard';

export function ListingsSection({ listings }: { listings: ListingCardModel[] }) {
  const [filter, setFilter] = useState<string>('All');

  const filtered = filter === 'All' ? listings : listings.filter((listing) => listing.type === filter);

  return (
    <section id="listings" className="py-16 px-6 lg:px-12 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6 mb-10">
        <div>
          <h2
            className="font-light mb-2"
            style={{
              fontFamily: 'var(--font-fraunces)',
              color: 'var(--foreground)',
              fontSize: 'clamp(2rem, 4vw, 3rem)'
            }}
          >
            {SECTION_COPY.listingsHeadline}
          </h2>
          <p className="m-0" style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}>
            {SECTION_COPY.listingsSub}
          </p>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
          {FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setFilter(option)}
              className="px-4 py-2 rounded-full text-sm whitespace-nowrap font-medium transition-all duration-200"
              style={{
                background: filter === option ? 'var(--primary)' : 'var(--secondary)',
                color: filter === option ? 'var(--primary-foreground)' : 'var(--secondary-foreground)',
                fontFamily: 'var(--font-outfit)',
                border: '1px solid',
                borderColor: filter === option ? 'var(--primary)' : 'var(--border)',
                cursor: 'pointer'
              }}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="py-24 text-center" style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}>
          No listings for this type yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {filtered.map((listing) => (
            <ListingCard key={listing.id} listing={listing} />
          ))}
        </div>
      )}
    </section>
  );
}
