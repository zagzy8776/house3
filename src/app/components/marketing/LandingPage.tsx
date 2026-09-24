'use client';

/* eslint-disable @next/next/no-img-element */

/**
 * Landing page shell - nav and hero ported from the Figma Make design.
 *
 * Changes from the original, all deliberate:
 *
 *  1. One floating card, not two. The right-hand card carries a real crawled
 *     place - its area and the operator's published rate. The left-hand card was
 *     a "Pay the operator direct / One payment. We never hold their money."
 *     panel, which described a payment flow that does not exist and dressed
 *     itself as a live notification; it is deleted rather than disabled, and the
 *     reason is recorded where it used to be.
 *  2. The floating card keeps `h3-desktop-only`. It uses
 *     `backdrop-filter: blur(20px)` and the design already hid it below xl; the
 *     class makes that a token decision and keeps the blur off phones.
 */

import { useState } from 'react';
import { BRAND, HERO, NAV_LINKS } from '@/content/marketing';
import { formatNaira } from '@/domain/money';
import { FloatingOrb, MOTION_KEYFRAMES } from './primitives';
import { SearchModal } from './SearchModal';
import { ShowcaseSection } from './sections/ShowcaseSection';
import { ListingsSection } from './sections/ListingsSection';
import { CitiesSection, type CityCard } from './sections/CitiesSection';
import { CtaAndFooter } from './sections/CtaAndFooter';
import type { ListingCardModel } from './ListingCard';

export type LandingPageProps = {
  listings: ListingCardModel[];
  cities: CityCard[];
  heroStats: { value: string; label: string }[];
};

export function LandingPage({ listings, cities, heroStats }: LandingPageProps) {
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <div style={{ background: 'var(--background)', color: 'var(--foreground)', overflowX: 'hidden' }}>
      <style>{MOTION_KEYFRAMES}</style>

      {/* Nav */}
      <nav
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 lg:px-12 py-4"
        style={{
          background: 'rgba(14,12,10,0.7)',
          backdropFilter: 'blur(24px)',
          borderBottom: '1px solid var(--border)'
        }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center"
            style={{ background: 'var(--primary)', boxShadow: '0 0 20px rgba(217,124,43,0.4)' }}
          >
            <svg width="16" height="16" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 1L1.5 5v7h4V9h3v3h4V5L7 1z" fill="var(--primary-foreground)" />
            </svg>
          </div>
          <span
            className="text-xl font-semibold tracking-tight"
            style={{ fontFamily: 'var(--font-fraunces)', color: 'var(--foreground)' }}
          >
            {BRAND.name}
          </span>
        </div>

        <div
          className="hidden md:flex items-center gap-8 text-sm"
          style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
        >
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="hover:text-white transition-colors"
              style={{ color: 'inherit', textDecoration: 'none' }}
            >
              {link.label}
            </a>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium transition-all duration-200 hover:opacity-90"
          style={{
            background: 'var(--primary)',
            color: 'var(--primary-foreground)',
            fontFamily: 'var(--font-outfit)',
            boxShadow: '0 0 24px rgba(217,124,43,0.35)',
            border: 'none',
            cursor: 'pointer'
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9.5 9.5L13 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          Search
        </button>
      </nav>

      {searchOpen ? <SearchModal onClose={() => setSearchOpen(false)} /> : null}

      {/* Hero */}
      <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
        <div className="absolute inset-0 z-0">
          <img
            src="https://images.unsplash.com/photo-1613977257363-707ba9348227?w=1920&h=1080&fit=crop&auto=format"
            alt=""
            className="w-full h-full object-cover"
            style={{ opacity: 0.3 }}
          />
          <div
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(135deg, rgba(14,12,10,0.95) 0%, rgba(14,12,10,0.5) 50%, rgba(14,12,10,0.85) 100%)'
            }}
          />
        </div>

        <FloatingOrb size={400} x="60%" y="10%" color="radial-gradient(circle, rgba(217,124,43,0.3), transparent)" blur={80} delay="0s" />
        <FloatingOrb size={300} x="5%" y="50%" color="radial-gradient(circle, rgba(232,164,74,0.2), transparent)" blur={60} delay="3s" />
        <FloatingOrb size={200} x="75%" y="65%" color="radial-gradient(circle, rgba(180,80,20,0.25), transparent)" blur={50} delay="1.5s" />

        {/* Floating cards: desktop only, heavy blur, no pointer value on touch */}
        <div className="h3-desktop-only absolute right-8 top-1/3 drift" style={{ zIndex: 5 }}>
          <div
            className="rounded-2xl p-4 w-52"
            style={{
              background: 'rgba(26,23,20,0.85)',
              border: '1px solid rgba(255,255,255,0.1)',
              backdropFilter: 'blur(20px)',
              boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
              transform: 'perspective(800px) rotateY(-8deg) rotateX(4deg)'
            }}
          >
            {listings[0]?.image ? (
              <img
                src={listings[0].image}
                alt=""
                className="rounded-xl w-full mb-3 object-cover"
                style={{ height: 110 }}
              />
            ) : (
              <div
                className="rounded-xl w-full mb-3 flex items-center justify-center"
                style={{ height: 110, background: 'var(--muted)' }}
              >
                <span className="text-xs" style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}>
                  no photo
                </span>
              </div>
            )}
            <p className="text-xs font-semibold mb-0.5 m-0" style={{ fontFamily: 'var(--font-outfit)', color: 'var(--foreground)' }}>
              {listings[0]?.name ?? 'Our latest finds'}
            </p>
            <p className="text-xs m-0" style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}>
              {listings[0]?.area ?? 'Lagos, Abuja, Ibadan, Owerri, Uyo'}
            </p>
            <p className="text-sm font-bold mt-2 m-0" style={{ fontFamily: 'var(--font-jetbrains)', color: 'var(--primary)' }}>
              {listings[0]?.rateKobo
                ? `${formatNaira(listings[0].rateKobo, { decimals: false })}/night`
                : 'rate on request'}
            </p>
          </div>
        </div>

        {/*
          The second floating card is GONE.

          It was a decorative panel whose entire content was the `recentBooking`
          fallback - and `recentBooking` is always null, because House3 takes no
          bookings, so this branch was the only one that ever rendered. It read
          "Pay the operator direct / One payment. We never hold their money."

          Two things were wrong with it. It describes a payment flow: "one payment"
          and "we never hold their money" only mean something if money passes
          through us, and none does - there is no checkout, no Paystack call, no
          basket anywhere in this application. And it sat on the hero as a floating
          notification, the visual language of a live transaction feed, which is
          the same objection as the invented booking it was written to replace.

          The first card stays because it is real: a crawled place, its area and
          the operator's published rate.
        */}

        <div className="relative z-10 text-center px-6 max-w-5xl mx-auto">
          <div
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full mb-8 text-xs"
            style={{
              background: 'rgba(217,124,43,0.1)',
              border: '1px solid rgba(217,124,43,0.25)',
              color: 'var(--accent)',
              fontFamily: 'var(--font-outfit)',
              letterSpacing: '0.05em'
            }}
          >
            <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--accent)' }} />
            {HERO.badge}
          </div>

          <h1
            className="font-light leading-[1.05] mb-8"
            style={{
              fontFamily: 'var(--font-fraunces)',
              color: 'var(--foreground)',
              fontSize: 'clamp(3rem, 8vw, 7rem)'
            }}
          >
            {HERO.headlineFirst}
            <br />
            <em className="italic" style={{ color: 'var(--accent)' }}>
              {HERO.headlineAccent}
            </em>
          </h1>

          <p
            className="text-lg md:text-xl mb-12 max-w-2xl mx-auto"
            style={{ color: 'var(--secondary-foreground)', fontFamily: 'var(--font-outfit)', lineHeight: 1.7 }}
          >
            {HERO.subhead}
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="px-10 py-4 rounded-2xl font-semibold text-base transition-all duration-300 hover:scale-105"
              style={{
                background: 'var(--primary)',
                color: 'var(--primary-foreground)',
                fontFamily: 'var(--font-outfit)',
                boxShadow: '0 0 40px rgba(217,124,43,0.4)',
                border: 'none',
                cursor: 'pointer'
              }}
            >
              Search spaces
            </button>
            <a
              href="#listings"
              className="text-base transition-colors hover:text-white flex items-center gap-2"
              style={{ textDecoration: 'none', color: 'var(--secondary-foreground)', fontFamily: 'var(--font-outfit)' }}
            >
              See what&apos;s available
              <span aria-hidden="true">↓</span>
            </a>
          </div>

          {/* Stats row */}
          <div
            className="flex flex-wrap justify-center gap-6 mt-20 pt-16 border-t"
            style={{ borderColor: 'var(--border)' }}
          >
            {heroStats.map((stat) => (
              <div key={stat.label} className="text-center px-6">
                <p
                  className="font-light mb-1 m-0"
                  style={{
                    fontFamily: 'var(--font-fraunces)',
                    color: 'var(--foreground)',
                    fontSize: 'clamp(1.75rem, 3vw, 2.5rem)'
                  }}
                >
                  {stat.value}
                </p>
                <p className="text-sm m-0" style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}>
                  {stat.label}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <ShowcaseSection />
      <ListingsSection listings={listings} />
      <CitiesSection cities={cities} />
      <CtaAndFooter onSearch={() => setSearchOpen(true)} />
    </div>
  );
}
