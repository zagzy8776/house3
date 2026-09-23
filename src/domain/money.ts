/**
 * Money primitives.
 *
 * Rule for the whole codebase: every monetary value is an integer number of
 * KOBO (1 NGN = 100 kobo). Floats are never used for money at rest or for
 * arithmetic that ends up in a ledger. Percentages are expressed in basis
 * points (bps) so that all rate maths stays in integer space.
 */

/** Branded-ish alias documented for readers; at runtime it is just a number. */
export type Kobo = number;
export type Bps = number;

export const KOBO_PER_NAIRA = 100;
export const BPS_DENOMINATOR = 10_000;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Convert a naira amount (may be fractional, e.g. 1500.5) to integer kobo. */
export function toKobo(naira: number): Kobo {
  if (!Number.isFinite(naira)) throw new MoneyError(`Not a finite naira amount: ${naira}`);
  return Math.round(naira * KOBO_PER_NAIRA);
}

/** Convert integer kobo to a naira number. Only for display / API boundaries. */
export function toNaira(kobo: Kobo): number {
  assertIntegerKobo(kobo);
  return kobo / KOBO_PER_NAIRA;
}

export function assertIntegerKobo(value: number, label = 'amount'): void {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} must be integer kobo, received ${value}`);
  }
}

export function assertNonNegativeKobo(value: number, label = 'amount'): void {
  assertIntegerKobo(value, label);
  if (value < 0) throw new MoneyError(`${label} must not be negative, received ${value}`);
}

/**
 * Integer percentage-of helper. Uses half-up rounding on the integer product so
 * that repeated calls are deterministic across platforms.
 */
export function applyBps(amountKobo: Kobo, bps: Bps): Kobo {
  assertIntegerKobo(amountKobo, 'amountKobo');
  if (!Number.isFinite(bps)) throw new MoneyError(`bps must be finite, received ${bps}`);
  return Math.round((amountKobo * bps) / BPS_DENOMINATOR);
}

/** Clamp a kobo amount into [min, max]; max === null means unbounded. */
export function clampKobo(value: Kobo, min: Kobo, max: Kobo | null): Kobo {
  assertIntegerKobo(value, 'value');
  if (max !== null && max < min) {
    throw new MoneyError(`max (${max}) is below min (${min})`);
  }
  let out = value;
  if (out < min) out = min;
  if (max !== null && out > max) out = max;
  return out;
}

/**
 * Round to the nearest display step (e.g. 5000 kobo = NGN 50). Ties round up.
 * step <= 1 returns the value unchanged.
 */
export function roundToStep(value: Kobo, stepKobo: number): Kobo {
  assertIntegerKobo(value, 'value');
  if (!Number.isInteger(stepKobo) || stepKobo <= 1) return value;
  return Math.round(value / stepKobo) * stepKobo;
}

/** Format kobo as a naira string: 19000000 -> "NGN 190,000.00" */
export function formatNaira(kobo: Kobo, options: { symbol?: string; decimals?: boolean } = {}): string {
  const { symbol = 'NGN ', decimals = true } = options;
  assertIntegerKobo(kobo, 'kobo');
  const negative = kobo < 0;
  const abs = Math.abs(kobo);
  const whole = Math.floor(abs / KOBO_PER_NAIRA);
  const frac = abs % KOBO_PER_NAIRA;
  const grouped = whole.toLocaleString('en-NG');
  const tail = decimals ? `.${frac.toString().padStart(2, '0')}` : '';
  return `${negative ? '-' : ''}${symbol}${grouped}${tail}`;
}

/** Sum a list of kobo amounts, asserting each entry is valid integer kobo. */
export function sumKobo(amounts: readonly Kobo[]): Kobo {
  let total = 0;
  for (const amount of amounts) {
    assertIntegerKobo(amount, 'summand');
    total += amount;
  }
  return total;
}
