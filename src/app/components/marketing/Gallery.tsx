'use client';

/* eslint-disable @next/next/no-img-element */

/**
 * The listing gallery.
 *
 * THE PHOTOGRAPHS ARE THE LISTING'S OWN
 *
 * Every image here was published by the listing itself and was carried through
 * the acquisition pipeline unchanged - `extraction/media.py` reads them, the
 * field allowlist permits them, and the platform never substitutes an image the
 * source did not publish. That is why a place with no photographs gets the
 * panel below rather than a stock apartment: a guest about to phone an operator
 * has to be able to trust that what they are looking at is the room.
 *
 * WHY THE IMAGES ARE PLAIN <img> AND NOT next/image
 *
 * The URLs point at third-party hosts whose domains we do not control and cannot
 * enumerate ahead of time. `next/image` would need every one of them in
 * `remotePatterns`, so a newly discovered portal would render broken images until
 * someone redeployed a config. A plain `<img>` with `loading="lazy"` works for
 * any host we discover.
 *
 * THE FAILING IMAGE
 *
 * A remote host can withdraw an image between our crawl and the guest's visit.
 * `onError` removes that tile rather than leaving a broken-image icon in a
 * gallery of otherwise fine photographs. The primary image is exempt: blanking
 * it would leave the page with no photograph at all when the second image could
 * have stood in.
 */

import { useState } from 'react';

export function Gallery({ images, label }: { images: string[]; label: string }) {
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState<Record<number, boolean>>({});

  const visible = images.map((src, index) => ({ src, index })).filter((entry) => !failed[entry.index]);

  if (visible.length === 0) return <PhotoPlaceholder label={label} />;

  // `visible` is non-empty here, but this project compiles with
  // `noUncheckedIndexedAccess`, so every index is `T | undefined` and the guard
  // has to be explicit rather than asserted away. A non-null assertion would
  // compile and would also hide it if the filter above ever stopped guaranteeing
  // a first element.
  const first = visible[0];
  if (!first) return <PhotoPlaceholder label={label} />;

  const current = visible.find((entry) => entry.index === active) ?? first;
  const currentIndex = visible.findIndex((entry) => entry.index === current.index) + 1;

  return (
    <div>
      <div
        className="relative rounded-2xl overflow-hidden"
        style={{ height: 'clamp(260px, 52vh, 560px)', background: 'var(--muted)' }}
      >
        <img
          src={current.src}
          alt={label}
          className="w-full h-full object-cover"
          onError={() => setFailed((previous) => ({ ...previous, [current.index]: true }))}
        />

        {visible.length > 1 ? (
          <span
            className="absolute bottom-4 right-4 px-3 py-1 rounded-full text-xs font-medium"
            style={{
              background: 'rgba(0,0,0,0.6)',
              backdropFilter: 'blur(10px)',
              color: 'var(--foreground)',
              fontFamily: 'var(--font-outfit)'
            }}
          >
            {currentIndex} / {visible.length}
          </span>
        ) : null}
      </div>

      {visible.length > 1 ? (
        <div className="flex gap-2.5 mt-3 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
          {visible.map((entry) => (
            <button
              key={entry.src}
              type="button"
              onClick={() => setActive(entry.index)}
              aria-label={`Show photograph ${entry.index + 1}`}
              aria-current={entry.index === current.index}
              className="rounded-xl overflow-hidden shrink-0 transition-opacity duration-200"
              style={{
                width: 88,
                height: 66,
                padding: 0,
                cursor: 'pointer',
                border: `2px solid ${entry.index === current.index ? 'var(--primary)' : 'transparent'}`,
                opacity: entry.index === current.index ? 1 : 0.65,
                background: 'var(--muted)'
              }}
            >
              <img
                src={entry.src}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
                onError={() => setFailed((previous) => ({ ...previous, [entry.index]: true }))}
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * No photographs. States the fact instead of dressing it up.
 *
 * A stock image here would be the one genuinely dishonest thing on the page: the
 * guest would believe they were looking at the apartment they are about to call.
 */
function PhotoPlaceholder({ label }: { label: string }) {
  return (
    <div
      className="rounded-2xl flex flex-col items-center justify-center text-center px-8"
      style={{
        height: 'clamp(200px, 32vh, 320px)',
        background: 'linear-gradient(140deg, rgba(217,124,43,0.14) 0%, rgba(20,14,10,0.9) 70%)',
        border: '1px solid var(--border)'
      }}
    >
      <p className="text-lg font-semibold mb-2 m-0" style={{ fontFamily: 'var(--font-outfit)' }}>
        No photographs published
      </p>
      <p
        className="text-sm m-0 max-w-md"
        style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)', lineHeight: 1.7 }}
      >
        The listing for {label} did not include any images, so we have none to show you. We do not use
        stock photography: what you see here is always the operator&apos;s own.
      </p>
    </div>
  );
}
