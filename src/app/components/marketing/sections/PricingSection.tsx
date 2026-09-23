/**
 * Pricing section - the design's headline block plus the live breakdown widget.
 *
 * The right-hand column is `PriceBreakdown`, which runs the real pricing engine
 * rather than the design's hardcoded 12% / 7.5% maths.
 */

import { PRICING_COPY, PRICING_PILLARS } from '@/content/marketing';
import { PriceBreakdown } from '../PriceBreakdown';
import type { FeePolicy } from '@/domain/pricing';

export type PricingSectionProps = {
  breakdown: {
    operatorName: string;
    unitName: string;
    nightlyRateKobo: number;
    cleaningFeeKobo: number;
    policy: FeePolicy;
  };
};

export function PricingSection({ breakdown }: PricingSectionProps) {
  return (
    <section id="pricing" className="py-20 px-6 lg:px-12">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-start">
          <div>
            <h2
              className="font-light mb-6 leading-tight"
              style={{
                fontFamily: 'var(--font-fraunces)',
                color: 'var(--foreground)',
                fontSize: 'clamp(2.5rem, 5vw, 4rem)'
              }}
            >
              {PRICING_COPY.headlineFirst}
              <br />
              <em className="italic" style={{ color: 'var(--accent)' }}>
                {PRICING_COPY.headlineAccent}
              </em>
            </h2>

            <p
              className="text-lg mb-10 leading-relaxed"
              style={{ color: 'var(--secondary-foreground)', fontFamily: 'var(--font-outfit)' }}
            >
              {PRICING_COPY.body}
            </p>

            <div className="space-y-6">
              {PRICING_PILLARS.map((pillar) => (
                <div key={pillar.n} className="flex gap-5">
                  <span
                    className="text-xs font-medium mt-1 flex-shrink-0"
                    style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-jetbrains)' }}
                  >
                    {pillar.n}
                  </span>
                  <div>
                    <p
                      className="font-semibold mb-1 m-0"
                      style={{ fontFamily: 'var(--font-outfit)', color: 'var(--foreground)' }}
                    >
                      {pillar.head}
                    </p>
                    <p
                      className="text-sm leading-relaxed m-0"
                      style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
                    >
                      {pillar.body}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <PriceBreakdown {...breakdown} />
        </div>
      </div>
    </section>
  );
}
