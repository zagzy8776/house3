/**
 * Listing media.
 *
 * THE QUESTION THIS FILE ANSWERS
 *
 * "Why doesn't the site show pictures of the houses?"
 *
 * It does - the moment we have the right to. This module is the gate, and it
 * exists because two different problems get confused for one:
 *
 *   1. A copyright problem. A photograph on someone else's listing belongs to
 *      the operator or their photographer. Robots.txt permission to crawl a
 *      page is not a licence to republish the pictures on it. This holds
 *      whether we fetched the page ourselves or paid an API to fetch it.
 *
 *   2. A much worse, purely practical problem. If we show a guest a photograph
 *      of a property we have no agreement over, and they book because of it, we
 *      cannot deliver the room. The photo did the selling and we cannot honour
 *      the sale. That is not a licensing issue, it is a broken product.
 *
 * Both have the same fix: photographs arrive WITH the signed partner, not with
 * the crawl. The operator uploads their own files while onboarding, or we
 * commission a shoot, and the supply agreement is what licenses the use. A unit
 * therefore has a gallery exactly when a person has signed something.
 *
 * WHY PROSE IS FINE HERE AND NOT IN THE SCRAPER
 *
 * services/acquisition/ refuses to collect descriptions; this module has no such
 * rule. That is not an inconsistency. Scraped copy is collected without a
 * licence, while a partner-supplied caption is licensed content under the very
 * agreement that lets us sell the room. Same words, different permission - the
 * distinction that matters is provenance, not format.
 */

import type { UnitRecord } from '@/inventory/types';

/** Why we are allowed to use a file. Every asset must name one. */
export type MediaLicence =
  // The operator uploaded it and the supply agreement covers it. The main path.
  | 'PARTNER_SUPPLIED'
  // We paid a photographer. Ours outright, subject to any model release.
  | 'HOUSE3_COMMISSIONED'
  // Bought from a portal or channel manager under a data/media licence.
  | 'LICENSED_FEED';

/** Partner lifecycle states that permit us to display their media. */
const DISPLAYABLE_PARTNER_STATUSES = ['ACTIVE'] as const;


export type MediaVariant = {
  /** Storage key or absolute URL. Never a third party's CDN URL. */
  key: string;
  width: number;
  height: number;
  /** Bytes, for enforcing a payload budget on listing pages. */
  sizeBytes: number;
};

export type MediaAsset = {
  id: string;
  /** The unit this depicts. Null only for operator-level media (a logo). */
  unitExternalId: string | null;
  /** The partner whose agreement covers it. */
  partnerId: string;
  licence: MediaLicence;
  /**
   * The contract, commission or licence reference that permits this use.
   * Always required, and always something a human can go and read.
   */
  licenceRef: string;
  /** ISO timestamp. */
  licenceGrantedAt: string;
  /** ISO timestamp, or null for open-ended. */
  licenceExpiresAt: string | null;
  /** Ordered. Position 0 is the card image. */
  position: number;
  /** Our own words. Written by us, never lifted from a listing page. */
  alt: string;
  variants: MediaVariant[];
};

/** The subset of a partner record this module needs, so it stays testable. */
export type MediaPartnerContext = {
  id: string;
  legalName: string;
  status: string;
  supplyAgreementRef: string | null;
  supplyAgreementSignedAt: string | null;
};

export class UnlicensedMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnlicensedMediaError';
  }
}


/**
 * Guard for a single asset.
 *
 * Throws rather than logging. A warning in a log is still a photograph on a page.
 */
export function assertMediaUsable(
  asset: MediaAsset,
  partner: MediaPartnerContext | null | undefined,
  unit: Pick<UnitRecord, 'externalId' | 'partnerId'> | null | undefined,
  now: string = new Date().toISOString()
): MediaAsset {
  if (!partner) {
    throw new UnlicensedMediaError(
      `Media "${asset.id}" has no partner record, so there is no agreement to rely on.`
    );
  }

  if (!(DISPLAYABLE_PARTNER_STATUSES as readonly string[]).includes(partner.status)) {
    throw new UnlicensedMediaError(
      `Partner "${partner.legalName}" is ${partner.status}. Media is displayable only for ` +
        `${DISPLAYABLE_PARTNER_STATUSES.join(', ')} partners - a paused or terminated partner's ` +
        'photographs must come down along with their inventory.'
    );
  }

  if (!partner.supplyAgreementRef?.trim() || !partner.supplyAgreementSignedAt) {
    throw new UnlicensedMediaError(
      `Partner "${partner.legalName}" has no signed supply agreement. Photographs are the ` +
        "operator's copyright; permission to crawl their listing page is not a licence to " +
        'republish them.'
    );
  }

  if (asset.partnerId !== partner.id) {
    throw new UnlicensedMediaError(
      `Media "${asset.id}" belongs to partner "${asset.partnerId}", not "${partner.id}".`
    );
  }

  if (!unit) {
    throw new UnlicensedMediaError(
      `Media "${asset.id}" is attached to no unit. Unit media can only be shown alongside the ` +
        'unit it depicts.'
    );
  }

  if (unit.partnerId !== partner.id) {
    throw new UnlicensedMediaError(
      `Unit "${unit.externalId}" belongs to partner "${unit.partnerId}", not "${partner.id}".`
    );
  }

  if (asset.unitExternalId !== null && asset.unitExternalId !== unit.externalId) {
    throw new UnlicensedMediaError(
      `Media "${asset.id}" depicts unit "${asset.unitExternalId}" and cannot be shown on ` +
        `"${unit.externalId}".`
    );
  }

  if (!asset.licenceRef.trim()) {
    throw new UnlicensedMediaError(
      `Media "${asset.id}" declares licence ${asset.licence} but names no reference. Every asset ` +
        'must point at a contract, commission or licence someone can go and read.'
    );
  }

  if (asset.licence === 'LICENSED_FEED' && !asset.licenceExpiresAt) {
    throw new UnlicensedMediaError(
      `Media "${asset.id}" comes from a licensed feed with no expiry. A licence we cannot ` +
        'outlive is a licence we cannot audit.'
    );
  }

  if (
    asset.licenceExpiresAt &&
    new Date(asset.licenceExpiresAt).getTime() <= new Date(now).getTime()
  ) {
    throw new UnlicensedMediaError(
      `Media licence "${asset.licenceRef}" expired at ${asset.licenceExpiresAt}.`
    );
  }

  if (asset.variants.length === 0) {
    throw new UnlicensedMediaError(`Media "${asset.id}" has no rendered variants.`);
  }

  return asset;
}


/**
 * The gallery for a unit: licensed assets only, in order, or nothing.
 *
 * Returning an empty array rather than a placeholder is deliberate. A unit with
 * no photographs renders as a designed card with no image, which is honest. A
 * stock photograph standing in for a specific property is not a design choice,
 * it is a misrepresentation - the guest believes they are looking at the room.
 */
export function selectGallery(
  unit: Pick<UnitRecord, 'externalId' | 'partnerId'> | null | undefined,
  partner: MediaPartnerContext | null | undefined,
  assets: readonly MediaAsset[],
  now: string = new Date().toISOString()
): MediaAsset[] {
  if (!unit || !partner) return [];
  if (!(DISPLAYABLE_PARTNER_STATUSES as readonly string[]).includes(partner.status)) return [];
  if (!partner.supplyAgreementRef?.trim()) return [];

  return assets
    .filter((asset) => asset.partnerId === partner.id)
    .filter((asset) => asset.unitExternalId === null || asset.unitExternalId === unit.externalId)
    .map((asset) => {
      try {
        return assertMediaUsable(asset, partner, unit, now);
      } catch {
        // Dropped, not thrown: one unlicensed file must not blank a gallery that
        // is otherwise fine. The throw is still the right behaviour on the
        // single-asset upload path, which calls assertMediaUsable directly.
        return null;
      }
    })
    .filter((asset): asset is MediaAsset => asset !== null)
    .sort((a, b) => a.position - b.position);
}

/** Card image for a unit, or null when we have nothing we are allowed to show. */
export function primaryImage(
  unit: Pick<UnitRecord, 'externalId' | 'partnerId'>,
  partner: MediaPartnerContext | null | undefined,
  assets: readonly MediaAsset[],
  now?: string
): MediaAsset | null {
  return selectGallery(unit, partner, assets, now)[0] ?? null;
}

/**
 * What a search card should render in the image slot.
 *
 * `EMPTY` is a first-class outcome, not a fallback to be papered over. The card
 * shows a designed panel and the listing still works; what it must not do is
 * show a photograph of some other property.
 */
export type CardImage =
  | { kind: 'ASSET'; asset: MediaAsset }
  | { kind: 'EMPTY'; reason: 'NO_AGREEMENT' | 'NO_MEDIA' };

export function cardImage(
  unit: Pick<UnitRecord, 'externalId' | 'partnerId'>,
  partner: MediaPartnerContext | null | undefined,
  assets: readonly MediaAsset[],
  now?: string
): CardImage {
  const asset = primaryImage(unit, partner, assets, now);
  if (asset) return { kind: 'ASSET', asset };
  return {
    kind: 'EMPTY',
    reason: partner?.supplyAgreementRef ? 'NO_MEDIA' : 'NO_AGREEMENT'
  };
}
