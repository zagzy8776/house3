/**
 * /design - the live review wall.
 *
 * Reads design/screens/ at request time, so any screen file that appears shows
 * up on the next refresh. Each frame carries the open questions for that screen,
 * so direction can be given without re-reading DESIGN.md.
 *
 * Not a Figma replacement: a shared surface to direct the work on.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';

const SCREENS_DIR = path.join(process.cwd(), 'design', 'screens');

type ScreenMeta = { title: string; purpose: string; openQuestions: string[] };

/** Keyed by filename prefix, so renaming a file cannot orphan its notes. */
const META: Record<string, ScreenMeta> = {
  '01-search-results': {
    title: 'Results',
    purpose: 'Default landing state. Price breakdown on every card.',
    openQuestions: [
      'Photo on the card, or price-first for metered data?',
      'Should "Operated by" sit above the price on very small screens?',
      'Show the fee percentage (12%) on the card, or only at checkout?'
    ]
  },
  '02-checkout-hold': {
    title: 'Checkout + hold',
    purpose: 'Guest details, live 15-minute hold, sticky pay bar.',
    openQuestions: [
      'Guest details before or after choosing a payment method?',
      'Is "Step 1 of 2" helpful or noise on a single-page flow?',
      'Should phone be required at all, or only for bank transfer?'
    ]
  },
  '03-payment-pending': {
    title: 'Payment pending',
    purpose: 'The screen guests actually sit on: bank transfer + USSD.',
    openQuestions: [
      'Is naming the amount on the button too long at 360px?',
      'Show polling status ("checking…") or stay quiet until confirmed?',
      'Do we need an explicit offline state for a dropped 3G connection?'
    ]
  },
  '05-confirmation': {
    title: 'Confirmed',
    purpose: 'What you paid, what the operator got, what House3 kept.',
    openQuestions: [
      'Show our margin to the guest at launch, or phase 2?',
      'Should the reference be larger, for reading aloud?',
      '"Add to calendar" or message the operator instead?'
    ]
  }
};

type Screen = { file: string; meta: ScreenMeta; width: number; height: number };

async function loadScreens(): Promise<Screen[]> {
  let files: string[];
  try {
    files = await readdir(SCREENS_DIR);
  } catch {
    return [];
  }

  const screens: Screen[] = [];
  for (const file of files.filter((name) => name.endsWith('.svg')).sort()) {
    const key = file.replace(/\.svg$/, '');
    const meta = META[key] ?? {
      title: key,
      purpose: 'Undocumented screen - add a META entry in src/app/design/page.tsx.',
      openQuestions: []
    };

    // Read real dimensions from the SVG so each frame renders at true size.
    const raw = await readFile(path.join(SCREENS_DIR, file), 'utf8');
    const width = Number(/width="(\d+)"/.exec(raw)?.[1] ?? 360);
    const height = Number(/height="(\d+)"/.exec(raw)?.[1] ?? 800);

    screens.push({ file, meta, width, height });
  }

  return screens;
}

/** Still to draw, with the question each one has to answer. */
const NOT_DRAWN: { name: string; question: string }[] = [
  { name: 'Hold expired', question: 'How blunt do we get that the room is gone? Copy is written, frame is not.' },
  { name: 'Empty results', question: 'Which alternatives: nearby areas with supply, date shift, or shorter stay?' },
  { name: 'Partially unavailable', question: 'Grey the card and show the engine reason ("Booked 11 Sep")?' },
  { name: 'Payment declined', question: 'Retry-first with alternate methods, or lead with support?' },
  { name: 'Amount mismatch', question: 'We throw and refund here. How much detail does the guest need?' },
  { name: 'Listing detail', question: 'Photo count, and where the rules block sits relative to the price.' },
  { name: 'Partner onboarding', question: 'Separate design language. Before or after Lagos supply is signed?' }
];

const SWATCHES: [string, string][] = [
  ['green.500', 'var(--h3-green-500)'],
  ['green.700', 'var(--h3-green-700)'],
  ['green.900', 'var(--h3-green-900)'],
  ['amber.500', 'var(--h3-amber-500)'],
  ['amber.700', 'var(--h3-amber-700)'],
  ['red.500', 'var(--h3-red-500)'],
  ['ink.900', 'var(--h3-ink-900)'],
  ['ink.700', 'var(--h3-ink-700)'],
  ['ink.500', 'var(--h3-ink-500)'],
  ['ink.100', 'var(--h3-ink-100)'],
  ['ink.50', 'var(--h3-ink-50)']
];

const panel = {
  background: 'var(--h3-bg-surface)',
  border: '1px solid var(--h3-border-default)',
  borderRadius: 'var(--h3-radius-lg)',
  padding: 'var(--h3-space-5)',
  boxShadow: 'var(--h3-shadow-sm)'
} as const;

export default async function DesignWall() {
  const screens = await loadScreens();

  return (
    <main className="h3-page" style={{ maxWidth: 1400 }}>
      <h1>House3 — design wall</h1>
      <p className="h3-lede">
        {screens.length} screen{screens.length === 1 ? '' : 's'} on the wall. Reload after a change; new files appear
        automatically. Every frame is 360px wide — the Android baseline, not 375.
      </p>

      <div style={{ display: 'flex', gap: 'var(--h3-space-5)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {screens.map((screen) => (
          <section key={screen.file} style={{ width: screen.width + 34 }}>
            <div style={panel}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <strong>{screen.meta.title}</strong>
                <span className="h3-meta">
                  {screen.width}×{screen.height}
                </span>
              </div>
              <p className="h3-note" style={{ marginTop: 'var(--h3-space-2)' }}>
                {screen.meta.purpose}
              </p>

              <div
                style={{
                  marginTop: 'var(--h3-space-4)',
                  borderRadius: 'var(--h3-radius-md)',
                  overflow: 'hidden',
                  border: '1px solid var(--h3-border-default)'
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/design/${screen.file}`}
                  width={screen.width}
                  height={screen.height}
                  alt={`${screen.meta.title} screen`}
                  style={{ display: 'block', width: '100%', height: 'auto' }}
                />
              </div>

              <p className="h3-meta" style={{ marginTop: 'var(--h3-space-3)', fontSize: 'var(--h3-text-micro)' }}>
                design/screens/{screen.file}
              </p>
            </div>

            {screen.meta.openQuestions.length > 0 ? (
              <div
                style={{
                  marginTop: 'var(--h3-space-4)',
                  background: 'var(--h3-hold-bg)',
                  borderRadius: 'var(--h3-radius-md)',
                  padding: 'var(--h3-space-4)'
                }}
              >
                <p
                  className="h3-hold__title"
                  style={{ fontSize: 'var(--h3-text-small)', color: 'var(--h3-hold-text)' }}
                >
                  Needs your call
                </p>
                <ul style={{ margin: 'var(--h3-space-2) 0 0', paddingLeft: 18 }}>
                  {screen.meta.openQuestions.map((question) => (
                    <li
                      key={question}
                      style={{ fontSize: 'var(--h3-text-small)', color: 'var(--h3-text-secondary)' }}
                    >
                      {question}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ))}
      </div>

      <h2 style={{ marginTop: 'var(--h3-space-9)' }}>Not drawn yet</h2>
      <ul className="h3-ledger">
        {NOT_DRAWN.map((item) => (
          <li key={item.name}>
            <strong>{item.name}</strong> — {item.question}
          </li>
        ))}
      </ul>

      <h2 style={{ marginTop: 'var(--h3-space-9)' }}>Tokens in use</h2>
      <div style={{ display: 'flex', gap: 'var(--h3-space-3)', flexWrap: 'wrap' }}>
        {SWATCHES.map(([name, value]) => (
          <div key={name} style={{ textAlign: 'center' }}>
            <div
              style={{
                width: 72,
                height: 48,
                borderRadius: 'var(--h3-radius-md)',
                background: value,
                border: '1px solid var(--h3-border-default)'
              }}
            />
            <div className="h3-meta" style={{ fontSize: 'var(--h3-text-micro)' }}>
              {name}
            </div>
          </div>
        ))}
      </div>

      <p className="h3-meta" style={{ marginTop: 'var(--h3-space-7)' }}>
        Tokens: design/tokens.tokens.json (Figma) mirrored by src/app/globals.css (app) · live app <a href="/">/</a> ·
        confirmation page <a href="/checkout/return">/checkout/return</a>
      </p>
    </main>
  );
}
