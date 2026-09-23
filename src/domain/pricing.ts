/**
 * The pricing engine.
 *
 * DESIGN CONTRACT - read this before changing anything here.
 *
 * House3 is a *disclosed* aggregator. The customer always sees a line-item
 * breakdown, and the inventory partner is always named. The platform's revenue
 * is a named SERVICE FEE on top of the partner's own published rate.
 *
 *     displayed total  =  partner room subtotal
 *                      -  length-of-stay discounts
 *                      +  platform service fee
 *                      +  VAT on the platform service fee
 *
 * We therefore never store a "markup" field and never mutate the partner's
 * rate. `partnerNetKobo` is what the partner is owed; `platformNetKobo` is what
 * the platform keeps. Both are computed, never guessed.
 *
 * VAT note: the platform service fee is the supply we make, so Nigerian VAT
 * (7.5%) attaches to our fee, not to the partner's room revenue. The partner
 * accounts for VAT on their own supply to us.
 */

import { applyBps, clampKobo, roundToStep, sumKobo, type Bps, type Kobo } from './money';
import { nightsBetween, type StayRange } from './dates';

export type FeePolicyScope = 'GLOBAL' | 'STATE' | 'PARTNER';

export type FeePolicy = {
  id: string;
  scope: FeePolicyScope;
  /** State code (e.g. "LA") for STATE scope, partner id for PARTNER scope. */
  subjectId?: string;
  /** Service fee as a share of the room subtotal, in basis points. */
  rateBps: Bps;
  minFeeKobo: Kobo;
  /** null = uncapped. */
  maxFeeKobo: Kobo | null;
  /** VAT applied to the platform's own fee, in basis points (750 = 7.5%). */
  vatRateBps: Bps;
  /** Display rounding step in kobo (5000 = NGN 50). */
  roundingStepKobo: number;
  /** Optional per-night floor, useful in high-ADP cities like Ikoyi/Maitama. */
  minNightlyFeeKobo?: Kobo;
};

export type LengthOfStayDiscount = {
  label: string;
  /** Applies when nights >= minNights. */
  minNights: number;
  /** Discount off the room subtotal, in basis points. */
  discountBps: Bps;
};

export type QuoteRequest = {
  stay: StayRange;
  nightlyRateKobo: Kobo;
  /** Extra guests beyond the unit's included occupancy, billed per night. */
  extraGuestFeePerNightKobo?: Kobo;
  extraGuests?: number;
  /** Partner's cleaning/turnover fee, passed through at cost. */
  cleaningFeeKobo?: Kobo;
  discounts?: readonly LengthOfStayDiscount[];
  policy: FeePolicy;
};

export type QuoteLineKind = 'ROOM' | 'ADDON' | 'DISCOUNT' | 'FEE' | 'TAX' | 'PASSTHROUGH';

export type QuoteLine = {
  key: string;
  label: string;
  kind: QuoteLineKind;
  amountKobo: Kobo;
  /** Shown to the customer. Every line is renderable in the UI. */
  customerVisible: boolean;
};

export type Quote = {
  stay: StayRange;
  nights: number;
  nightlyRateKobo: Kobo;
  /** Room subtotal before discounts and fees - the partner's own revenue. */
  roomSubtotalKobo: Kobo;
  discountTotalKobo: Kobo;
  addonTotalKobo: Kobo;
  cleaningFeeKobo: Kobo;
  serviceFeeKobo: Kobo;
  serviceFeeVatKobo: Kobo;
  /** Chargeable total presented to the customer. */
  totalKobo: Kobo;
  /** What the inventory partner must receive for the room. */
  partnerNetKobo: Kobo;
  /** Platform gross margin before processor fees. */
  platformNetKobo: Kobo;
  lines: QuoteLine[];
  policyId: string;
  currency: 'NGN';
};

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

/**
 * Fee policy precedence: a partner-specific policy beats a state policy, which
 * beats the global default. Within the same scope the first match wins, so
 * callers should pass state/partner policies most-specific-first.
 */
export function resolveFeePolicy(
  policies: readonly FeePolicy[],
  context: { stateCode?: string; partnerId?: string; globalPolicyId?: string }
): FeePolicy {
  const partnerPolicy = context.partnerId
    ? policies.find((p) => p.scope === 'PARTNER' && p.subjectId === context.partnerId)
    : undefined;
  if (partnerPolicy) return partnerPolicy;

  const statePolicy = context.stateCode
    ? policies.find((p) => p.scope === 'STATE' && p.subjectId === context.stateCode)
    : undefined;
  if (statePolicy) return statePolicy;

  const globalPolicy = context.globalPolicyId
    ? policies.find((p) => p.scope === 'GLOBAL' && p.id === context.globalPolicyId)
    : policies.find((p) => p.scope === 'GLOBAL');
  if (globalPolicy) return globalPolicy;

  throw new PricingError('No fee policy matched; refusing to quote without a fee policy');
}

function validatePolicy(policy: FeePolicy): void {
  if (policy.rateBps < 0 || policy.rateBps > 5_000) {
    throw new PricingError(`rateBps out of sane range [0, 5000]: ${policy.rateBps}`);
  }
  if (policy.minFeeKobo < 0) throw new PricingError('minFeeKobo must not be negative');
  if (policy.maxFeeKobo !== null && policy.maxFeeKobo < policy.minFeeKobo) {
    throw new PricingError('maxFeeKobo must be >= minFeeKobo');
  }
  if (policy.vatRateBps < 0 || policy.vatRateBps > 2_500) {
    throw new PricingError(`vatRateBps out of sane range [0, 2500]: ${policy.vatRateBps}`);
  }
}

/** Pick the best length-of-stay discount for a given night count. */
export function selectLengthOfStayDiscount(
  discounts: readonly LengthOfStayDiscount[] | undefined,
  nights: number
): LengthOfStayDiscount | undefined {
  if (!discounts || discounts.length === 0) return undefined;
  let best: LengthOfStayDiscount | undefined;
  for (const candidate of discounts) {
    if (nights < candidate.minNights) continue;
    if (!best || candidate.discountBps > best.discountBps) best = candidate;
  }
  return best;
}
export function computeQuote(request: QuoteRequest): Quote {
  const { policy, stay, nightlyRateKobo } = request;
  validatePolicy(policy);

  if (!Number.isInteger(nightlyRateKobo) || nightlyRateKobo <= 0) {
    throw new PricingError(`nightlyRateKobo must be a positive integer, received ${nightlyRateKobo}`);
  }

  const nights = nightsBetween(stay);
  const roomSubtotalKobo = nightlyRateKobo * nights;

  const lines: QuoteLine[] = [
    {
      key: 'room',
      label: `${nights} night${nights === 1 ? '' : 's'} x ${nightlyRateKobo / 100} NGN`,
      kind: 'ROOM',
      amountKobo: roomSubtotalKobo,
      customerVisible: true
    }
  ];

  // ---- Add-ons (extra guests) ---------------------------------------------
  const extraGuests = request.extraGuests ?? 0;
  const perNight = request.extraGuestFeePerNightKobo ?? 0;
  let addonTotalKobo = 0;
  if (extraGuests > 0 && perNight > 0) {
    addonTotalKobo = perNight * extraGuests * nights;
    lines.push({
      key: 'extra_guests',
      label: `Extra guests (${extraGuests} x ${nights} night${nights === 1 ? '' : 's'})`,
      kind: 'ADDON',
      amountKobo: addonTotalKobo,
      customerVisible: true
    });
  }

  // ---- Length-of-stay discount --------------------------------------------
  const discount = selectLengthOfStayDiscount(request.discounts, nights);
  let discountTotalKobo = 0;
  if (discount) {
    discountTotalKobo = applyBps(roomSubtotalKobo, discount.discountBps);
    lines.push({
      key: 'los_discount',
      label: discount.label,
      kind: 'DISCOUNT',
      amountKobo: -discountTotalKobo,
      customerVisible: true
    });
  }

  // ---- Partner passthrough (cleaning / turnover) ---------------------------
  const cleaningFeeKobo = request.cleaningFeeKobo ?? 0;
  if (cleaningFeeKobo > 0) {
    lines.push({
      key: 'cleaning_fee',
      label: 'Cleaning & turnover (partner fee)',
      kind: 'PASSTHROUGH',
      amountKobo: cleaningFeeKobo,
      customerVisible: true
    });
  }

  // ---- Platform service fee ------------------------------------------------
  // Fee base is the partner's net room revenue: subtotal minus discounts plus
  // add-ons. Charging a fee on a discount that never happened would be double
  // counting, and a passthrough fee is not our supply.
  const feeBaseKobo = roomSubtotalKobo - discountTotalKobo + addonTotalKobo;
  const rawFeeKobo = applyBps(feeBaseKobo, policy.rateBps);
  const nightlyFloorTotalKobo = (policy.minNightlyFeeKobo ?? 0) * nights;
  const floorKobo = Math.max(policy.minFeeKobo, nightlyFloorTotalKobo);
  const clampedFeeKobo = clampKobo(rawFeeKobo, floorKobo, policy.maxFeeKobo);
  const serviceFeeKobo = roundToStep(clampedFeeKobo, policy.roundingStepKobo);

  lines.push({
    key: 'service_fee',
    label: 'House3 service fee',
    kind: 'FEE',
    amountKobo: serviceFeeKobo,
    customerVisible: true
  });

  const serviceFeeVatKobo = roundToStep(
    applyBps(serviceFeeKobo, policy.vatRateBps),
    policy.roundingStepKobo
  );
  if (serviceFeeVatKobo > 0) {
    lines.push({
      key: 'service_fee_vat',
      label: 'VAT on service fee (7.5%)',
      kind: 'TAX',
      amountKobo: serviceFeeVatKobo,
      customerVisible: true
    });
  }

  const totalKobo = sumKobo(lines.map((line) => line.amountKobo));

  // The partner is owed the room revenue net of discounts, plus their add-on
  // and passthrough revenue. They are NOT owed our service fee or our VAT.
  const partnerNetKobo = roomSubtotalKobo - discountTotalKobo + addonTotalKobo + cleaningFeeKobo;
  const platformNetKobo = serviceFeeKobo + serviceFeeVatKobo;

  if (partnerNetKobo + platformNetKobo !== totalKobo) {
    throw new PricingError(
      `Quote invariant violated: partner ${partnerNetKobo} + platform ${platformNetKobo} != total ${totalKobo}`
    );
  }
  if (partnerNetKobo <= 0) {
    throw new PricingError('Partner net must be positive; check discounts and policy');
  }

  return {
    stay,
    nights,
    nightlyRateKobo,
    roomSubtotalKobo,
    discountTotalKobo,
    addonTotalKobo,
    cleaningFeeKobo,
    serviceFeeKobo,
    serviceFeeVatKobo,
    totalKobo,
    partnerNetKobo,
    platformNetKobo,
    lines,
    policyId: policy.id,
    currency: 'NGN'
  };
}

