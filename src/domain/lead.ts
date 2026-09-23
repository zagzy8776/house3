/**
 * Partner acquisition.
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT
 *
 * The scraping pipeline produces PROSPECTS, not inventory. A scraped listing
 * cannot be sold: there is no signed agreement, no settlement account, no live
 * calendar, so we could not confirm a booking even if a guest paid. What a
 * scraped listing CAN do is tell us which operator to phone, in which
 * neighbourhood, running how many units, at what rate.
 *
 * So the pipeline output is a lead list that feeds human outreach. Every lead
 * that converts goes through the same `assertAuthorized()` gate as any other
 * partner, and only then becomes bookable inventory.
 *
 * This module is typed so the distinction cannot be lost: a `PartnerLead` has no
 * unit id, no sellable rate and no calendar. There is no code path from a lead to
 * a bookable unit that does not pass through a signed agreement.
 */

import { centroidForArea, type LatLng } from './geo';
import type { TitleDocument } from './title';

/**
 * The only permitted use of a lead. Encoded rather than documented, because a
 * comment is not a control.
 */
export const PROSPECT_POLICY = {
  allowedUse: 'OPERATOR_OUTREACH',
  /**
   * Republishing a prospect's listing content (photographs, descriptions) and
   * offering it for sale is NOT a use of this record.
   */
  cannotBecomeInventoryWithout:
    'signed supply agreement + verified settlement account + live calendar',
  /** Media is never retained: photographs are the operator's copyright. */
  retainsMedia: false,
  retains: ['operator identity', 'contact channel', 'portfolio size', 'advertised rates', 'area']
} as const;

export type LeadSourceKind =
  | 'PUBLIC_LISTING_TITLE'
  | 'OPERATOR_WEBSITE'
  | 'SOCIAL_PROFILE'
  | 'REFERRAL'
  | 'EVENT_OR_ASSOCIATION';

export type LeadSource = {
  kind: LeadSourceKind;
  /** Where it came from, for auditability: a URL or a person's name. */
  reference: string;
  observedAt: string;
  /** False when the source publishes a restriction we chose to honour. */
  robotPermitted: boolean;
};

export type LeadContact = {
  /** Business phone as published. Held only where a lawful basis exists. */
  phone: string | null;
  email: string | null;
  website: string | null;
  instagram: string | null;
};

export type OperatorLead = {
  /** Canonical identity key - see leadDedupeKey. */
  id: string;
  displayName: string;
  /** Normalised form used for matching. */
  normalisedName: string;
  area: string;
  stateCode: string;
  location: LatLng | null;
  contact: LeadContact;
  /** Distinct properties we observed them advertising. */
  listingCount: number;
  /** Advertised nightly rates observed, in kobo. Benchmarking only. */
  observedNightlyRatesKobo: number[];
  claimedTitles: TitleDocument[];
  /**
   * Booking-system fingerprints found on their own site or calendar links. A hit
   * means they can onboard via PARTNER_API or ICAL_FEED instead of retyping
   * rates into our dashboard.
   */
  pmsFingerprints: string[];
  /** Set once a human has made contact, so nobody is cold-called twice. */
  contactedAt: string | null;
  sources: LeadSource[];
  /** NDPA retention: the date this record must be reviewed or deleted. */
  retainUntil: string;
};

export class LeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeadError';
  }
}

const LEGAL_SUFFIXES = [
  'limited',
  'ltd',
  'enterprises',
  'enterprise',
  'ventures',
  'venture',
  'nigeria',
  'nig',
  'and sons',
  'sons',
  'integrated',
  'services',
  'company',
  'co',
  'global',
  'group'
];

/**
 * Normalise a trading name for matching.
 *
 * Deliberately aggressive: the same operator appears as "Lekki Homes Ltd",
 * "LEKKI HOMES LIMITED" and "Lekki Homes Nig. Ltd" across three portals, and
 * they are one phone call, not three. Dropping legal suffixes and punctuation
 * collapses them.
 */
export function normaliseOperatorName(raw: string): string {
  const value = raw.toLowerCase().trim().replace(/[.,'"()[\]&/-]/g, ' ');

  const words = value.split(/\s+/).filter((word) => word.length > 0);
  const stripped = words.filter((word) => !LEGAL_SUFFIXES.includes(word));

  // If a name is nothing BUT suffixes, keep the original words rather than
  // collapsing to an empty key that would merge unrelated operators.
  const useful = stripped.length > 0 ? stripped : words;

  return useful.join(' ');
}

/**
 * Stable dedupe key. The same normalised name in the same neighbourhood is the
 * same operator; the same name in another city is usually a different business.
 */
export function leadDedupeKey(input: { displayName: string; area: string; stateCode: string }): string {
  const name = normaliseOperatorName(input.displayName);
  const area = input.area.toLowerCase().trim().replace(/\s+/g, '-');
  return `${input.stateCode.toLowerCase()}:${area}:${name.replace(/\s+/g, '-')}`;
}

/** Merge repeat observations of one operator into a single lead. */
export function mergeLeads(leads: readonly OperatorLead[]): OperatorLead {
  const [first, ...rest] = leads;
  if (!first) throw new LeadError('Cannot merge an empty list');

  const merged: OperatorLead = { ...first };

  for (const lead of rest) {
    merged.listingCount += lead.listingCount;
    merged.observedNightlyRatesKobo = [...merged.observedNightlyRatesKobo, ...lead.observedNightlyRatesKobo];
    merged.sources = [...merged.sources, ...lead.sources];
    merged.pmsFingerprints = [...new Set([...merged.pmsFingerprints, ...lead.pmsFingerprints])];
    merged.claimedTitles = [...new Set([...merged.claimedTitles, ...lead.claimedTitles])];

    // Prefer whichever contact channel we have; never lose one already held.
    merged.contact = {
      phone: merged.contact.phone ?? lead.contact.phone,
      email: merged.contact.email ?? lead.contact.email,
      website: merged.contact.website ?? lead.contact.website,
      instagram: merged.contact.instagram ?? lead.contact.instagram
    };

    // Earliest contact wins, so nobody is cold-called twice.
    merged.contactedAt = earliest(merged.contactedAt, lead.contactedAt);
    merged.retainUntil = latest(merged.retainUntil, lead.retainUntil);
  }

  return merged;
}

function earliest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function latest(a: string, b: string): string {
  return a > b ? a : b;
}

/** Dedupe a batch, merging repeat sightings of the same operator. */
export function dedupeLeads(leads: readonly OperatorLead[]): OperatorLead[] {
  const groups = new Map<string, OperatorLead[]>();
  for (const lead of leads) {
    const existing = groups.get(lead.id);
    if (existing) existing.push(lead);
    else groups.set(lead.id, [lead]);
  }
  return [...groups.values()].map(mergeLeads);
}

/** Retention window. Proportionate retention for B2B outreach data. */
export const LEAD_RETENTION_DAYS = 365;

export function retentionExpiry(observedAt: string, days = LEAD_RETENTION_DAYS): string {
  return new Date(new Date(observedAt).getTime() + days * 86_400_000).toISOString();
}

export function isRetentionExpired(lead: OperatorLead, now: string): boolean {
  return lead.retainUntil <= now;
}

/**
 * Keep only what outreach needs, in a comparable shape.
 *
 * A published listing page often carries an individual agent's mobile, a
 * WhatsApp link and a personal email. This normalises the channel and drops
 * everything else - including any prose, which is also where a scraped page's
 * copy would leak in if we were careless.
 */
export function sanitiseContact(raw: {
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  instagram?: string | null;
}): LeadContact {
  return {
    phone: normalisePhone(raw.phone ?? null),
    email: raw.email ? raw.email.trim().toLowerCase() : null,
    website: raw.website ? raw.website.trim().replace(/\/$/, '') : null,
    instagram: raw.instagram ? raw.instagram.trim().replace(/^@/, '') : null
  };
}

/** Nigerian numbers to a comparable form: +234XXXXXXXXXX, or unchanged if unrecognised. */
export function normalisePhone(raw: string | null): string | null {
  if (!raw) return null;
  const bare = raw.replace(/[^\d+]/g, '').replace(/^\+/, '');

  if (/^234\d{10}$/.test(bare)) return `+${bare}`;
  if (/^0\d{10}$/.test(bare)) return `+234${bare.slice(1)}`;
  if (/^\d{10}$/.test(bare)) return `+234${bare}`;

  // An unrecognised shape is kept verbatim rather than guessed at: a corrupted
  // lead costs a wasted call, and a silently wrong number costs a lost partner.
  return raw.trim();
}

/** Position an operator by its neighbourhood, for radius-based outreach rounds. */
export function leadLocation(area: string): LatLng | null {
  return centroidForArea(area) ?? null;
}

