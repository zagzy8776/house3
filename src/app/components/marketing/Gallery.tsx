'use client';

/* eslint-disable @next/next/no-img-element */

/**
 * The listing gallery.
 *
 * WHY THERE ARE USUALLY NO PHOTOGRAPHS HERE
 *
 * Most listings on a Nigerian portal publish their photographs through the
 * portal, and the portal stamps its own brand across every one of them. The
 * measured case: every image on a Nigeria Property Centre listing carries
 * "Nigeria property centre" and its house logo burned into the pixels, dead
 * centre. We refuse those - see `extraction/media.py`, `publishing.py` and
 * `mediaUrls()` for the three gates - because publishing one would put the
 * portal's brand on our page, which is the use the stamp exists to forbid.
 *
 * So the placeholder below is the COMMON case, not the rare one, and it is not a
 * bug to be fixed by loosening a filter. When a listing's page does carry
 * photographs, they are the publication's own and unwatermarked, and the caption
 * says who published them.
 *
 * WHY THE IMAGES ARE PLAIN <img> AND NOT next/image
 *
 * The URLs point at hosts we do not control and cannot enumerate ahead of time.
 * `next/image` would need every one in `remotePatterns`, so a newly discovered
 * source would render broken images until someone redeployed a config. A plain
 * `<img>` with `loading="lazy"` works for any host.
 *
 * THE FAILING IMAGE
 *
 * A remote host can withdraw an image between our crawl and the guest's visit.
 * `onError` removes that tile rather than leaving a broken-image icon in a
 * gallery of otherwise fine photographs.
 */

import { useState } from 'react';

export function Gallery({
  images,
  label,
  attribution,
  sourceUrl
}: {
  images: string[];
  label: string;
  attribution: string;
  sourceUrl: string;
}) {
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

      {/*
        Who published these. A guest has no way to know whether a photograph came
        from the operator or from a portal the operator never heard of, and the
        difference decides whether it is worth trusting.
      */}
      <p
        className="text-xs mt-3 m-0"
        style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
      >
        {visible.length === 1 ? 'Photograph' : `${visible.length} photographs`} published by{' '}
        {attribution}.{' '}
        <a href={sourceUrl} target="_blank" rel="noopener noreferrer nofollow" style={{ color: 'var(--primary)' }}>
          See the original listing
        </a>
      </p>
    </div>
  );
}

/**
 * No photographs. States the fact instead of dressing it up.
 *
 * ONE LINE, NOT A PARAGRAPH. This panel used to explain the whole sourcing
 * policy - which publication watermarks its images, why we do not republish
 * them, that we never substitute stock photography - which is a page of internal
 * policy shown to somebody who came to look at a room. The guest needs to know
 * there are no pictures and that the absence is not a bug; the reasoning is ours
 * to hold, and `extraction/watermark.py` is where it is recorded and tested.
 *
 * It says "no photographs yet" rather than blaming the listing or the publisher,
 * because the truthful short answer is that we do not have pictures to show.
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
      <p className="text-lg font-semibold mb-1 m-0" style={{ fontFamily: 'var(--font-outfit)' }}>
        No photographs yet
      </p>
      <p
        className="text-sm m-0 max-w-sm"
        style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)', lineHeight: 1.7 }}
      >
        Nothing to show for {label} — ask the property for pictures directly.
      </p>
    </div>
  );
}
