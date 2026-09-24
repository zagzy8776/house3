'use client';

/**
 * Listings grid.
 *
 * THE FILTER CHIPS ARE GONE
 * -------------------------
 * The design's chips were `All · Serviced Flat · Studio · Penthouse · Shortlet`,
 * picked to look good against six invented listings. Real crawled inventory does
 * not distribute across those categories - a crawl of Lekki returns mostly
 * "short-let" - so a row of chips that filters nine real places into one bucket is
 * furniture, not a control. They are removed rather than faked.
 *
 * The grid is a single-column LIST now, because the card is horizontal. A
 * horizontal card in a three-column grid would give each thumbnail about 100px,
 * which is not enough to read a room from - the layout and the column count have
 * to agree. This is how the portals the card is modelled on present results, and
 * it is why a guest can scan price down the left edge.
 *
 * The section keeps the design's heading and its empty state. What is worth
 * restating is that an empty state is possible and has to say something true: it
 * means no crawl has run, which is a fact about our coverage rather than about
 * the guest's search.
 */

import { SECTION_COPY } from '@/content/marketing';
import { ListingCard, type ListingCardModel } from '../ListingCard';

export function ListingsSection({ listings }: { listings: ListingCardModel[] }) {
  return (
    <section id="listings" className="py-16 px-6 lg:px-12 max-w-7xl mx-auto">
      <div className="mb-10">
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

      {listings.length === 0 ? (
        <div
          className="rounded-2xl p-10 text-center"
          style={{
            color: 'var(--muted-foreground)',
            fontFamily: 'var(--font-outfit)',
            background: 'var(--card)',
            border: '1px solid var(--border)'
          }}
        >
          <p className="font-semibold mb-2 m-0" style={{ color: 'var(--foreground)' }}>
            Nothing crawled yet
          </p>
          <p className="m-0 text-sm">
            Our directory is built by crawling operators&apos; own listings, and no crawl has run
            yet. Rather than show you places we have not seen, this section stays empty.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {listings.map((listing) => (
            <ListingCard key={listing.id} listing={listing} />
          ))}
        </div>
      )}
    </section>
  );
}

