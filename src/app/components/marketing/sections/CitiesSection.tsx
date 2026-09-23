/* eslint-disable @next/next/no-img-element */

/**
 * Cities section - ported from the design.
 *
 * The listing counts render from the prop. When the caller can compute a real
 * count (from the repository) it passes one; otherwise the count is marked
 * `countIsReal: false` and the card shows the city without a number rather than
 * a fabricated one. The design's 847/312/93/58/44 were placeholders.
 */

import { SECTION_COPY } from '@/content/marketing';
import { Card3D } from '../primitives';

export type CityCard = {
  city: string;
  /** Needed for the link: the search service matches `area` exactly, so a city
   *  name would never match a neighbourhood like "Lekki Phase 1". */
  stateCode: string;
  count: number;
  image: string;
  countIsReal: boolean;
};

export function CitiesSection({ cities }: { cities: CityCard[] }) {
  return (
    <section id="cities" className="py-20 px-6 lg:px-12 max-w-7xl mx-auto">
      <h2
        className="font-light mb-10"
        style={{
          fontFamily: 'var(--font-fraunces)',
          color: 'var(--foreground)',
          fontSize: 'clamp(2rem, 4vw, 3rem)'
        }}
      >
        {SECTION_COPY.citiesHeadline}
      </h2>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {cities.map((city) => (
          <Card3D key={city.city}>
            <a
              href={`/search?state=${city.stateCode}`}
              className="relative rounded-2xl overflow-hidden cursor-pointer group block"
              style={{ height: 260, textDecoration: 'none' }}
            >
              <img
                src={city.image}
                alt={city.city}
                loading="lazy"
                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                style={{ opacity: 0.6 }}
              />
              <div
                className="absolute inset-0"
                style={{ background: 'linear-gradient(to top, rgba(14,12,10,0.95) 0%, rgba(14,12,10,0.2) 60%)' }}
              />
              <div className="absolute bottom-4 left-4">
                <p
                  className="font-semibold text-lg m-0"
                  style={{ fontFamily: 'var(--font-fraunces)', color: 'var(--foreground)' }}
                >
                  {city.city}
                </p>
                <p className="text-sm m-0" style={{ color: 'var(--accent)', fontFamily: 'var(--font-jetbrains)' }}>
                  {city.countIsReal ? `${city.count} listings` : 'Opening soon'}
                </p>
              </div>
            </a>
          </Card3D>
        ))}
      </div>
    </section>
  );
}
