'use client';

/* eslint-disable @next/next/no-img-element */

/**
 * Photo showcase - the auto-rotating carousel, ported from the design.
 *
 * Change: rotation pauses on hover/focus and is disabled entirely under
 * `prefers-reduced-motion`. The original rotated every 4s regardless, which
 * hijacks attention from someone who is reading, and the dots already give a
 * manual control.
 */

import { useEffect, useState } from 'react';
import { SHOWCASE } from '@/content/marketing';

const ROTATE_MS = 4000;

export function ShowcaseSection() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const timer = setInterval(() => setActive((current) => (current + 1) % SHOWCASE.length), ROTATE_MS);
    return () => clearInterval(timer);
  }, [paused]);

  return (
    <section className="py-8 px-6 lg:px-12 max-w-7xl mx-auto">
      <div
        className="relative rounded-3xl overflow-hidden"
        style={{ height: 'clamp(300px, 50vh, 520px)' }}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
      >
        {SHOWCASE.map((slide, index) => (
          <div
            key={slide.image}
            className="absolute inset-0 transition-opacity duration-1000"
            style={{ opacity: index === active ? 1 : 0 }}
          >
            <img src={slide.image} alt={slide.label} className="w-full h-full object-cover" loading="lazy" />
            <div
              className="absolute inset-0"
              style={{ background: 'linear-gradient(to right, rgba(14,12,10,0.5) 0%, transparent 60%)' }}
            />
          </div>
        ))}

        <div className="absolute bottom-6 left-6 flex gap-2">
          {SHOWCASE.map((slide, index) => (
            <button
              key={slide.label}
              type="button"
              onClick={() => setActive(index)}
              aria-label={`Show ${slide.label}`}
              aria-current={index === active}
              className="transition-all duration-300 rounded-full"
              style={{
                width: index === active ? 32 : 8,
                height: 8,
                background: index === active ? 'var(--primary)' : 'rgba(255,255,255,0.4)',
                border: 'none',
                padding: 0,
                cursor: 'pointer'
              }}
            />
          ))}
        </div>

        <div className="absolute bottom-6 right-6">
          <span
            className="px-3 py-1.5 rounded-full text-sm font-medium"
            style={{
              background: 'rgba(0,0,0,0.5)',
              backdropFilter: 'blur(12px)',
              color: 'var(--foreground)',
              fontFamily: 'var(--font-outfit)',
              border: '1px solid rgba(255,255,255,0.1)'
            }}
          >
            {SHOWCASE[active]?.label}
          </span>
        </div>
      </div>
    </section>
  );
}
