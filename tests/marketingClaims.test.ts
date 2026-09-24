import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CITIES, HERO, HERO_STATS, SECTION_COPY } from '@/content/marketing';

/**
 * Invented numbers must not be able to reach a page.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `content/marketing.ts` carries numbers that were fabricated for the Figma
 * design - "847 Lagos listings", "312 Abuja listings", "1,354 spaces across 5
 * states". They are flagged `illustrative: true` so a component can tell.
 *
 * The flag was being dropped on the way to the hero: `page.tsx` mapped
 * `HERO_STATS` down to `{ value, label }` and the landing page rendered "847 Lagos
 * listings" in large type beside "₦0 Booking fees", which is true. A guest had no
 * way to tell which of those statements were made up, and the honest one made the
 * other three believable.
 *
 * So the rule is enforced structurally rather than by remembering: nothing marked
 * illustrative may be RENDERED. It may sit in the content file as design
 * vocabulary.
 */

const REPO = process.cwd();

/** Files that produce what a guest sees. */
const RENDERED_SURFACES = [
  'src/app/page.tsx',
  'src/app/components/marketing/LandingPage.tsx',
  'src/app/components/marketing/sections/ListingsSection.tsx',
  'src/app/components/marketing/sections/CitiesSection.tsx',
  'src/app/components/marketing/ListingCard.tsx'
];

function read(relative: string): string {
  return readFileSync(path.join(REPO, relative), 'utf8');
}

/**
 * Source with comments removed.
 *
 * The checks below are about what a component RENDERS, and prose explaining a fix
 * is not a rendered claim - `page.tsx` legitimately names "847" while documenting
 * why it no longer displays it. Searching raw text would make the correct code
 * fail and only the undocumented version pass, which is backwards.
 *
 * Block and line comments are stripped; the content file's own `illustrative`
 * constants are checked directly rather than through this.
 */
function code(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('no invented number reaches a rendered surface', () => {
  it('the illustrative claims are still flagged, so they remain detectable', () => {
    // If someone deletes the flags the guard below silently stops guarding.
    const illustrativeStats = HERO_STATS.filter((stat) => stat.illustrative);
    expect(illustrativeStats.length).toBeGreaterThan(0);

    const illustrativeCities = CITIES.filter((city) => city.illustrative);
    expect(illustrativeCities.length).toBeGreaterThan(0);
  });

  it('does not render the fabricated hero stats', () => {
    // `HERO_STATS` must not be imported by any surface. The hero reads real counts
    // from the directory instead.
    for (const surface of RENDERED_SURFACES) {
      const source = code(surface);
      expect(source, `${surface} must not import HERO_STATS`).not.toContain('HERO_STATS');
    }
  });

  it('does not render a fabricated figure as literal text', () => {
    // The specific numbers, in case someone re-adds them as a literal rather than
    // through the content file - which is how they would come back.
    const fabricated = ['847', '312', '1,354'];

    for (const surface of RENDERED_SURFACES) {
      const source = code(surface);
      for (const figure of fabricated) {
        expect(source, `${surface} must not render ${figure}`).not.toContain(figure);
      }
    }
  });

  it('does not render an illustrative badge or CTA', () => {
    // These are the two claims that were false the longest, because they read as
    // positioning rather than as statistics.
    expect(HERO.badgeIllustrative).toBe(false);
    expect(SECTION_COPY.ctaIllustrative).toBe(false);
  });

  it('states the no-fee claim, which is the one thing that was never invented', () => {
    // The pitch has to survive the cleanup. If a future edit removes every claim
    // including this one, the page has stopped saying what the product is.
    expect(HERO.badge.toLowerCase()).toContain('no booking fee');
    expect(SECTION_COPY.listingsSub).toContain('fee');
  });
});
