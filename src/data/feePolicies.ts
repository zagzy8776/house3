/**
 * Fee policy defaults, driven by environment configuration.
 *
 * Keeping this in one place means ops changes a number in .env (or, later, a row
 * in the FeePolicy table) instead of hunting through pricing code.
 */

import type { FeePolicy } from '@/domain/pricing';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new ConfigError(`${name} must be an integer, received "${raw}"`);
  return parsed;
}

export function envRequired(name: string): string {
  const raw = process.env[name];
  if (!raw) throw new ConfigError(`${name} is required`);
  return raw;
}

export function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(', ')}, received "${raw}"`);
  }
  return raw as T;
}

/** The global default policy every state/partner policy falls back to. */
export function defaultFeePolicy(): FeePolicy {
  return {
    id: 'global-default',
    scope: 'GLOBAL',
    rateBps: envInt('DEFAULT_FEE_RATE_BPS', 1_000),
    minFeeKobo: envInt('DEFAULT_FEE_MIN_KOBO', 200_000),
    maxFeeKobo: envInt('DEFAULT_FEE_MAX_KOBO', 4_000_000),
    vatRateBps: envInt('PLATFORM_VAT_RATE_BPS', 750),
    roundingStepKobo: envInt('PRICE_ROUNDING_STEP_KOBO', 5_000)
  };
}

/**
 * State-level overrides. High-demand markets support a higher service fee and a
 * higher cap; lower-ADP markets need a lower one to stay competitive.
 * These are *disclosed fee* levels, not hidden markups.
 */
export const STATE_FEE_POLICIES: readonly FeePolicy[] = [
  {
    id: 'state-la',
    scope: 'STATE',
    subjectId: 'LA',
    rateBps: 1_200,
    minFeeKobo: 300_000,
    maxFeeKobo: 8_000_000,
    vatRateBps: 750,
    roundingStepKobo: 5_000,
    minNightlyFeeKobo: 100_000
  },
  {
    id: 'state-fc',
    scope: 'STATE',
    subjectId: 'FC',
    rateBps: 1_200,
    minFeeKobo: 300_000,
    maxFeeKobo: 8_000_000,
    vatRateBps: 750,
    roundingStepKobo: 5_000
  },
  {
    id: 'state-oy',
    scope: 'STATE',
    subjectId: 'OY',
    rateBps: 900,
    minFeeKobo: 150_000,
    maxFeeKobo: 3_000_000,
    vatRateBps: 750,
    roundingStepKobo: 5_000
  },
  {
    id: 'state-im',
    scope: 'STATE',
    subjectId: 'IM',
    rateBps: 900,
    minFeeKobo: 150_000,
    maxFeeKobo: 3_000_000,
    vatRateBps: 750,
    roundingStepKobo: 5_000
  },
  {
    id: 'state-ak',
    scope: 'STATE',
    subjectId: 'AK',
    rateBps: 900,
    minFeeKobo: 150_000,
    maxFeeKobo: 3_000_000,
    vatRateBps: 750,
    roundingStepKobo: 5_000
  }
];

export function allFeePolicies(): FeePolicy[] {
  return [defaultFeePolicy(), ...STATE_FEE_POLICIES];
}
