'use client';

/* eslint-disable @next/next/no-img-element */

/**
 * Closing CTA and footer, ported from the design.
 */

import { BRAND, CITIES, SECTION_COPY } from '@/content/marketing';

export function CtaAndFooter({ onSearch }: { onSearch: () => void }) {
  return (
    <>
      <section className="py-20 px-6 lg:px-12">
        <div
          className="max-w-6xl mx-auto relative rounded-3xl overflow-hidden"
          style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
        >
          <img
            src="https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=1400&h=600&fit=crop&auto=format"
            alt=""
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover"
            style={{ opacity: 0.15 }}
          />
          <div
            className="absolute inset-0"
            style={{
              background: 'radial-gradient(ellipse at 70% 50%, rgba(217,124,43,0.15) 0%, transparent 60%)'
            }}
          />
          <div className="relative z-10 py-20 px-10 lg:px-20 text-center">
            <h2
              className="font-light mb-6"
              style={{
                fontFamily: 'var(--font-fraunces)',
                color: 'var(--foreground)',
                fontSize: 'clamp(2.5rem, 5vw, 4.5rem)'
              }}
            >
              {SECTION_COPY.ctaHeadline}
            </h2>
            <p
              className="text-xl mb-10 max-w-xl mx-auto"
              style={{ color: 'var(--secondary-foreground)', fontFamily: 'var(--font-outfit)', lineHeight: 1.7 }}
            >
              {SECTION_COPY.ctaBody}
            </p>
            <button
              type="button"
              onClick={onSearch}
              className="px-12 py-5 rounded-2xl font-semibold text-lg transition-all duration-300 hover:scale-105"
              style={{
                background: 'var(--primary)',
                color: 'var(--primary-foreground)',
                fontFamily: 'var(--font-outfit)',
                boxShadow: '0 0 60px rgba(217,124,43,0.4)',
                border: 'none',
                cursor: 'pointer'
              }}
            >
              {SECTION_COPY.ctaButton} →
            </button>
          </div>
        </div>
      </section>

      <footer className="border-t py-10 px-6 lg:px-12" style={{ borderColor: 'var(--border)' }}>
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'var(--primary)' }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M7 1L1.5 5v7h4V9h3v3h4V5L7 1z" fill="var(--primary-foreground)" />
              </svg>
            </div>
            <span className="font-semibold" style={{ fontFamily: 'var(--font-fraunces)', color: 'var(--foreground)' }}>
              {BRAND.name}
            </span>
          </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-6 text-sm" style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}>
          {CITIES.map((city) => (
            <a
              key={city.city}
              href={`/search?state=${city.stateCode}`}
              className="hover:text-white transition-colors"
              style={{ color: 'inherit', textDecoration: 'none' }}
            >
              {city.city}
            </a>
          ))}
        </div>

          <p className="text-sm m-0" style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}>
            © {new Date().getFullYear()} {BRAND.name}
          </p>
        </div>
      </footer>
    </>
  );
}
