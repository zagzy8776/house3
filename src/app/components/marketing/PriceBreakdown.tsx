'use client';

/**
 * Price breakdown - the design's centrepiece widget, driven by the real engine.
 *
 * The Figma version hardcoded the maths:
 *
 *     const fee = Math.round(room * 0.12)
 *     const vat = Math.round(fee * 0.075)
 *
 * This calls `computeQuote()` from src/domain/pricing.ts instead. Same numbers
 * today, but now the widget cannot drift from what the guest is actually
 * charged: the state fee policy, min/max caps, per-night floors, the NGN 50
 * rounding step and the VAT-on-fee-only rule all apply.
 *
 * Dates are pinned to a constant rather than `new Date()`, because the quote
 * renders on the server and again in the browser - a moving date would produce
 * a hydration mismatch.
 */

import { useMemo, useState } from 'react';
import { addDays, type StayRange } from '@/domain/dates';
import { formatNaira } from '@/domain/money';
import { computeQuote, type FeePolicy, type QuoteLine } from '@/domain/pricing';

const BASE_CHECK_IN = '2026-01-01';
const MAX_NIGHTS = 14;

export type PriceBreakdownProps = {
  operatorName: string;
  unitName: string;
  nightlyRateKobo: number;
  cleaningFeeKobo: number;
  policy: FeePolicy;
};

/** The design labels each row with where the money goes. Keep that. */
function subLabelFor(kind: QuoteLine['kind']): string {
  switch (kind) {
    case 'ROOM':
    case 'ADDON':
    case 'PASSTHROUGH':
      return 'to operator';
    case 'FEE':
      return 'service charge';
    case 'TAX':
      return 'to FIRS';
    case 'DISCOUNT':
      return 'discount';
  }
}

/** Brand accent marks our own lines; operator rows stay neutral. */
function colourFor(kind: QuoteLine['kind']): string {
  return kind === 'FEE' || kind === 'TAX' ? 'var(--accent)' : 'var(--foreground)';
}

function labelFor(line: QuoteLine, nights: number, feePercent: number, vatPercent: number): string {
  switch (line.kind) {
    case 'ROOM':
      return `Room × ${nights}`;
    case 'PASSTHROUGH':
      return 'Cleaning';
    case 'FEE':
      return `House3 fee (${feePercent}%)`;
    case 'TAX':
      return `VAT (${vatPercent}% on fee)`;
    default:
      return line.label;
  }
}

export function PriceBreakdown({
  operatorName,
  unitName,
  nightlyRateKobo,
  cleaningFeeKobo,
  policy
}: PriceBreakdownProps) {
  const [nights, setNights] = useState(2);

  const quote = useMemo(() => {
    const stay: StayRange = { checkIn: BASE_CHECK_IN, checkOut: addDays(BASE_CHECK_IN, nights) };
    return computeQuote({ stay, nightlyRateKobo, cleaningFeeKobo, policy });
  }, [nights, nightlyRateKobo, cleaningFeeKobo, policy]);

  const feePercent = policy.rateBps / 100;
  const vatPercent = policy.vatRateBps / 100;

  return (
    <div
      className="rounded-3xl p-8 h-full"
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center justify-between mb-6">
        <div>
          <p
            className="font-semibold mb-0.5 m-0"
            style={{ fontFamily: 'var(--font-outfit)', color: 'var(--foreground)' }}
          >
            {unitName}
          </p>
          <p className="text-sm m-0" style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}>
            {operatorName} · operator rate {formatNaira(nightlyRateKobo, { decimals: false })}/night
          </p>
        </div>
        <div
          className="flex items-center gap-2 rounded-xl overflow-hidden"
          style={{ border: '1px solid var(--border)' }}
        >
          <button
            type="button"
            onClick={() => setNights((current) => Math.max(1, current - 1))}
            aria-label="One night fewer"
            className="px-3 py-2 transition-colors hover:bg-secondary"
            style={{
              color: 'var(--foreground)',
              fontFamily: 'var(--font-outfit)',
              background: 'none',
              border: 'none',
              cursor: 'pointer'
            }}
          >
            −
          </button>
          <span
            className="px-2 text-sm font-medium"
            style={{ fontFamily: 'var(--font-jetbrains)', color: 'var(--foreground)' }}
          >
            {nights}n
          </span>
          <button
            type="button"
            onClick={() => setNights((current) => Math.min(MAX_NIGHTS, current + 1))}
            aria-label="One night more"
            className="px-3 py-2 transition-colors hover:bg-secondary"
            style={{
              color: 'var(--foreground)',
              fontFamily: 'var(--font-outfit)',
              background: 'none',
              border: 'none',
              cursor: 'pointer'
            }}
          >
            +
          </button>
        </div>
      </div>

      <div className="space-y-0">
        {quote.lines.map((line, index) => (
          <div
            key={line.key}
            className="flex justify-between items-start py-3"
            style={{ borderBottom: index < quote.lines.length - 1 ? '1px solid var(--border)' : 'none' }}
          >
            <div>
              <p className="text-sm m-0" style={{ fontFamily: 'var(--font-jetbrains)', color: colourFor(line.kind) }}>
                {labelFor(line, quote.nights, feePercent, vatPercent)}
              </p>
              <p
                className="text-xs mt-0.5 m-0"
                style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
              >
                {subLabelFor(line.kind)}
              </p>
            </div>
            <p
              className="text-sm font-medium m-0"
              style={{ fontFamily: 'var(--font-jetbrains)', color: colourFor(line.kind) }}
            >
              {formatNaira(line.amountKobo, { decimals: false })}
            </p>
          </div>
        ))}
      </div>

      <div className="h3-total-box">
        <p className="font-semibold m-0" style={{ fontFamily: 'var(--font-outfit)', color: 'var(--foreground)' }}>
          You pay
        </p>
        <p className="h3-total-box__amount m-0">{formatNaira(quote.totalKobo, { decimals: false })}</p>
      </div>

      <p className="h3-settlement">
        {operatorName} receives {formatNaira(quote.partnerNetKobo, { decimals: false })} · House3 keeps{' '}
        {formatNaira(quote.platformNetKobo, { decimals: false })}
      </p>
    </div>
  );
}
