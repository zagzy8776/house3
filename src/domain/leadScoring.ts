/**
 * Lead scoring: turning a raw prospect list into a call list.
 *
 * The pipeline will find far more operators than the team can phone. Scoring
 * exists so the top of the list is the operators most likely to sign AND most
 * valuable once signed - which is not the same as "the biggest".
 *
 * Two signals deserve explanation:
 *
 *  - PMS fingerprint. An operator already using a channel manager can onboard
 *    through PARTNER_API or ICAL_FEED, so their live calendar and rates arrive
 *    without anyone retyping them. Onboarding cost dominates our CAC, which makes
 *    this the most predictive signal we have.
 *
 *  - Rate position against the local median. Operators priced well BELOW their
 *    neighbourhood are the most receptive audience: we arrive with a benchmark
 *    showing them they are leaving money on the table, and our service fee is far
 *    easier to justify than it is to an operator already at the top of the market.
 */

import type { OperatorLead } from './lead';
import { isRetentionExpired } from './lead';

export type LeadTier = 'A' | 'B' | 'C';
export type OutreachChannel = 'PHONE' | 'INSTAGRAM' | 'EMAIL' | 'NONE';

export type LeadAssessment = {
  leadId: string;
  score: number;
  tier: LeadTier;
  /** Justification, shown beside the lead in the call list. */
  reasons: string[];
  channel: OutreachChannel;
  /** Set when the lead must not be contacted at all. */
  blockedReason: string | null;
  lowestRateKobo: number | null;
  /** How their rate sits against the neighbourhood median, in basis points. */
  ratePositionBps: number | null;
};

/** Neighbourhood rate context, produced by the benchmark pipeline. */
export type MarketBenchmark = {
  area: string;
  stateCode: string;
  medianNightlyRateKobo: number;
  sampleSize: number;
};

export const TIER_THRESHOLDS = { a: 70, b: 45 } as const;

/** States where demand and rates justify prioritising outreach. */
const TIER_ONE_STATES = new Set(['LA', 'FC']);

function toTier(score: number): LeadTier {
  if (score >= TIER_THRESHOLDS.a) return 'A';
  if (score >= TIER_THRESHOLDS.b) return 'B';
  return 'C';
}

export function bestChannel(lead: OperatorLead): OutreachChannel {
  if (lead.contact.phone) return 'PHONE';
  if (lead.contact.instagram) return 'INSTAGRAM';
  if (lead.contact.email) return 'EMAIL';
  if (lead.contact.website) return 'EMAIL';
  return 'NONE';
}

/** Median advertised rate for a neighbourhood, from observed leads. */
export function medianRateKobo(leads: readonly OperatorLead[]): number {
  const rates = leads
    .flatMap((lead) => lead.observedNightlyRatesKobo)
    .filter((rate) => rate > 0)
    .sort((a, b) => a - b);

  if (rates.length === 0) return 0;
  const middle = Math.floor(rates.length / 2);
  if (rates.length % 2 === 1) return rates[middle] as number;
  return Math.round(((rates[middle - 1] as number) + (rates[middle] as number)) / 2);
}

/**
 * Score one lead.
 *
 * `now` is injected so retention checks are deterministic in tests, and so a
 * nightly job can re-assess the whole list against the same instant.
 */
export function assessLead(
  lead: OperatorLead,
  options: { now: string; benchmark?: MarketBenchmark }
): LeadAssessment {
  const reasons: string[] = [];
  const channel = bestChannel(lead);

  // ---- hard blocks ---------------------------------------------------------
  if (isRetentionExpired(lead, options.now)) {
    return {
      leadId: lead.id,
      score: 0,
      tier: 'C',
      reasons: ['Retention window expired - re-observe or delete before contacting'],
      channel,
      blockedReason: 'RETENTION_EXPIRED',
      lowestRateKobo: null,
      ratePositionBps: null
    };
  }

  if (channel === 'NONE') {
    return {
      leadId: lead.id,
      score: 0,
      tier: 'C',
      reasons: ['No contact channel published - cannot be reached'],
      channel,
      blockedReason: 'NO_CONTACT_CHANNEL',
      lowestRateKobo: null,
      ratePositionBps: null
    };
  }

  // ---- portfolio size ------------------------------------------------------
  let score = 0;
  if (lead.listingCount >= 10) {
    score += 30;
    reasons.push(`${lead.listingCount} properties advertised - portfolio operator`);
  } else if (lead.listingCount >= 4) {
    score += 22;
    reasons.push(`${lead.listingCount} properties advertised`);
  } else if (lead.listingCount >= 2) {
    score += 12;
    reasons.push(`${lead.listingCount} properties advertised`);
  } else {
    score += 4;
    reasons.push('Single property - lower volume, still worth a call');
  }

  // ---- onboarding cost -----------------------------------------------------
  if (lead.pmsFingerprints.length > 0) {
    score += 25;
    reasons.push(
      `Runs ${lead.pmsFingerprints.join(', ')} - onboards via API/iCal, no manual rate entry`
    );
  } else {
    reasons.push('No booking system detected - onboard via partner dashboard');
  }

  // ---- reachability and professionalism ------------------------------------
  if (lead.contact.website) {
    score += 10;
    reasons.push('Has its own website');
  }
  if (lead.contact.instagram) {
    score += 5;
    reasons.push('Active on Instagram - likely already markets direct');
  }

  // ---- market tier ---------------------------------------------------------
  if (TIER_ONE_STATES.has(lead.stateCode)) {
    score += 10;
    reasons.push('Tier 1 market');
  }

  // ---- benchmark position --------------------------------------------------
  let ratePositionBps: number | null = null;
  const lowestRateKobo =
    lead.observedNightlyRatesKobo.length > 0 ? Math.min(...lead.observedNightlyRatesKobo) : null;

  if (options.benchmark && lowestRateKobo !== null && options.benchmark.medianNightlyRateKobo > 0) {
    const median = options.benchmark.medianNightlyRateKobo;
    ratePositionBps = Math.round(((lowestRateKobo - median) / median) * 10_000);

    if (ratePositionBps <= -2_000) {
      score += 15;
      reasons.push(
        `Advertises ${Math.abs(Math.round(ratePositionBps / 100))}% below the ${lead.area} median - strongest opening for a benchmark conversation`
      );
    } else if (ratePositionBps >= 2_500) {
      score += 10;
      reasons.push(`Advertises ${Math.round(ratePositionBps / 100)}% above the ${lead.area} median - premium stock`);
    } else {
      score += 6;
      reasons.push(`Priced in line with the ${lead.area} median`);
    }
  }

  // ---- already spoken to ---------------------------------------------------
  if (lead.contactedAt) {
    score -= 15;
    reasons.push(`Already contacted on ${lead.contactedAt.slice(0, 10)} - follow up, do not cold-call`);
  }

  const bounded = Math.max(0, Math.min(100, score));

  return {
    leadId: lead.id,
    score: bounded,
    tier: toTier(bounded),
    reasons,
    channel,
    blockedReason: null,
    lowestRateKobo,
    ratePositionBps
  };
}

/**
 * Build the call list: blocked leads removed, best first.
 *
 * Ties are broken by portfolio size, so of two equally-scored leads the one
 * bringing more rooms is called first.
 */
export function buildCallList(
  leads: readonly OperatorLead[],
  options: { now: string; benchmarks?: readonly MarketBenchmark[] }
): LeadAssessment[] {
  const benchmarkFor = (lead: OperatorLead) =>
    options.benchmarks?.find(
      (benchmark) => benchmark.area === lead.area && benchmark.stateCode === lead.stateCode
    );

  const byId = new Map(leads.map((lead) => [lead.id, lead]));

  return leads
    .map((lead) => assessLead(lead, { now: options.now, benchmark: benchmarkFor(lead) }))
    .filter((assessment) => assessment.blockedReason === null)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (byId.get(b.leadId)?.listingCount ?? 0) - (byId.get(a.leadId)?.listingCount ?? 0);
    });
}
