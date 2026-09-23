/**
 * Payment splitting.
 *
 * This is the mechanic that makes the business work: the guest pays once, the
 * processor settles the partner's share into the partner's own bank account
 * (via a Paystack/Flutterwave subaccount) and the platform keeps its fee.
 *
 * HARD INVARIANT (asserted below and fuzz-tested):
 *
 *     partnerShare + platformShare + processorFee === quote.totalKobo
 *
 * Nothing may be invented or lost in the split. If this invariant ever fails we
 * throw rather than charging a guest.
 */

import { assertIntegerKobo, applyBps, clampKobo, type Kobo } from './money';
import type { Quote } from './pricing';

export type FeeBearer = 'platform' | 'partner';

/** Processor pricing model, e.g. Paystack local NGN cards: 1.5% + NGN 100, capped at NGN 2,000. */
export type ProcessorFeeModel = {
  rateBps: number;
  flatKobo: Kobo;
  /** null = uncapped. */
  capKobo: Kobo | null;
};

export type SplitInput = {
  quote: Quote;
  processorFee: ProcessorFeeModel;
  bearer: FeeBearer;
  /**
   * Flat amount (kobo) the platform wants to withhold from the partner, if any.
   * Used for partner-specific billing arrangements. Must be <= partnerShare.
   */
  platformWithholdingFromPartnerKobo?: Kobo;
};

export type SplitLeg = {
  recipient: 'PARTNER' | 'PLATFORM';
  label: string;
  amountKobo: Kobo;
};

export type SplitResult = {
  totalKobo: Kobo;
  partnerShareKobo: Kobo;
  platformShareKobo: Kobo;
  processorFeeKobo: Kobo;
  bearer: FeeBearer;
  legs: SplitLeg[];
  /** Ready-to-send Paystack initialisation fields. */
  paystack: {
    /** Flat kobo routed to the partner subaccount. */
    transactionChargeKobo: Kobo;
    /** Who absorbs the Paystack fee. */
    bearer: FeeBearer;
  };
  /** Ready-to-send Flutterwave split ratios (integers summing to 100). */
  flutterwave: {
    partnerRatioPercent: number;
    platformRatioPercent: number;
  };
};

export class SplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplitError';
  }
}

/** Forecast the processor's cut for a given charge amount. */
export function computeProcessorFee(amountKobo: Kobo, model: ProcessorFeeModel): Kobo {
  assertIntegerKobo(amountKobo, 'amountKobo');
  if (amountKobo <= 0) return 0;
  const variable = applyBps(amountKobo, model.rateBps);
  const uncapped = variable + model.flatKobo;
  return clampKobo(uncapped, 0, model.capKobo);
}

/**
 * Split one charged total into partner share, platform share and processor fee.
 *
 * When the partner bears the processor fee, the fee is deducted from the
 * partner's share (so the platform's fee is protected) - this is how Paystack
 * behaves when `bearer` is set to the subaccount.
 */
export function computeSplits(input: SplitInput): SplitResult {
  const { quote, processorFee: model, bearer } = input;
  const totalKobo = quote.totalKobo;

  const processorFeeKobo = computeProcessorFee(totalKobo, model);
  const withholding = input.platformWithholdingFromPartnerKobo ?? 0;
  assertIntegerKobo(withholding, 'platformWithholdingFromPartnerKobo');
  if (withholding < 0) throw new SplitError('withholding must not be negative');

  const partnerGrossKobo = quote.partnerNetKobo - withholding;
  if (partnerGrossKobo <= 0) {
    throw new SplitError('Partner share would be zero or negative; refusing to split');
  }

  const partnerShareKobo = bearer === 'partner' ? partnerGrossKobo - processorFeeKobo : partnerGrossKobo;

  if (partnerShareKobo <= 0) {
    throw new SplitError(
      `Partner share (${partnerShareKobo}) cannot cover processor fee (${processorFeeKobo}); ` +
        'move the fee bearer to the platform or raise the partner rate'
    );
  }

  const platformShareKobo = totalKobo - partnerShareKobo - processorFeeKobo;

  if (platformShareKobo <= 0) {
    throw new SplitError(
      `Platform share is negative or zero (${platformShareKobo}); the service fee does not cover ` +
        'the processor fee under the current bearer arrangement'
    );
  }

  const invariant = partnerShareKobo + platformShareKobo + processorFeeKobo;
  if (invariant !== totalKobo) {
    throw new SplitError(`Split invariant violated: ${invariant} !== ${totalKobo}`);
  }

  return {
    totalKobo,
    partnerShareKobo,
    platformShareKobo,
    processorFeeKobo,
    bearer,
    legs: [
      { recipient: 'PARTNER', label: 'Room revenue to inventory partner', amountKobo: partnerShareKobo },
      { recipient: 'PLATFORM', label: 'House3 service fee + VAT', amountKobo: platformShareKobo },
      { recipient: 'PLATFORM', label: 'Payment processing fee', amountKobo: processorFeeKobo }
    ],
    paystack: {
      transactionChargeKobo: partnerShareKobo,
      bearer
    },
    flutterwave: toFlutterwaveRatios(partnerShareKobo, platformShareKobo + processorFeeKobo)
  };
}

/**
 * Flutterwave `transaction_split_ratio` values are integer percentages that
 * must total 100 across subaccounts. We give the partner the floor percentage
 * and hand the rounding remainder to the platform, so the totals still match.
 */
export function toFlutterwaveRatios(
  partnerKobo: Kobo,
  platformKobo: Kobo
): { partnerRatioPercent: number; platformRatioPercent: number } {
  const total = partnerKobo + platformKobo;
  if (total <= 0) throw new SplitError('Cannot compute split ratios for a zero total');
  const partnerRatioPercent = Math.floor((partnerKobo * 100) / total);
  return { partnerRatioPercent, platformRatioPercent: 100 - partnerRatioPercent };
}
