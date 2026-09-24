/**
 * Composition root.
 *
 * HOUSE3 IS A DISCOVERY AND REFERRAL PLATFORM. It does not collect money, process
 * bookings, promise availability or act as merchant of record. A guest finds a place
 * here and deals with the accommodation directly, which is what `src/domain/contact.ts`
 * expresses.
 *
 * So this container wires DISCOVERY only. There is no payment gateway, because there
 * is no payment.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * This file previously required a Paystack secret key in production, or an explicit
 * `ALLOW_DEMO_PAYMENTS=true`, and threw at startup with neither. That gate exists to
 * stop a platform taking money it cannot process, and it is now unreachable, because
 * the platform does not take money at all. Requirement and capability had to agree, so
 * the requirement went.
 *
 * The Prisma schema still contains the payment tables (`Booking`, `LedgerEntry`,
 * `Payment`, `Payout`). They are intentionally left alone. Dropping them would be a
 * destructive migration against a live database for no benefit, and the migration
 * generator in this repo has already been observed trying to drop the hand-written
 * PostGIS indexes as "drift" - risk with no reward attached.
 *
 * NOTE for production: replace `InMemoryRepository` with a Prisma-backed implementation
 * of the same `Repository` interface. The in-memory store is process-local, so it is
 * correct for a single-instance demo and for tests, but it does not survive a restart
 * or a second server instance.
 */

import { allFeePolicies, defaultFeePolicy } from '@/data/feePolicies';
import {
  contactRoutes,
  primaryRoute,
  type ContactEvidence,
  type ContactRoute
} from '@/domain/contact';
import type { FeePolicy } from '@/domain/pricing';
import type { StayRange } from '@/domain/dates';
import { DEMO_PARTNERS, DEMO_UNITS, seedAvailability } from './demoInventory';
import {
  createPlaceSearch,
  type PlaceResult,
  type SearchOutcome,
  type SearchQuery
} from './placeSearch';
import { InMemoryRepository, type Repository } from './store';

/** Resolves the advertised fee policy for a state. Used to price a stay for context. */
export type FeePolicyLookup = (stateCode: string, area: string | null) => FeePolicy;

export type Container = {
  repo: Repository;
  /**
   * The discovery product: find places, see what a stay would cost, and reach them.
   *
   * Deliberately small. If a method is ever added here that reserves, holds, charges or
   * confirms anything, that method belongs to a different business, and the decision to
   * build that business should be made explicitly rather than by adding a method.
   */
  places: PlaceDirectory;
};

export type PlaceDirectory = {
  /** Places matching a query, each with a cost-for-these-dates for context. */
  search(query: SearchQuery): SearchOutcome;
  /** One place, priced for a stay. */
  quoteUnit(input: { unitId: string; stay: StayRange; guests: number }): PlaceResult;
  /** Every place we hold, as referral inventory. */
  list(): ReturnType<Repository['listUnits']>;
  /** How a guest reaches one place, best route first. */
  contactFor(unitId: string): ContactRoute[] | null;
  /** The route a guest should normally take for one place. */
  primaryContactFor(unitId: string): ContactRoute | null;
};

/**
 * Turn a stored place into the contact routes a guest may take.
 *
 * The `sourceUrl` fallback matters: a place we cannot attribute to an operator still
 * has a source listing, so a guest can always reach what they were looking at. That is
 * why `contactRoutes` can never return an empty list.
 */
function contactForUnit(repo: Repository, unitId: string): ContactRoute[] | null {
  const unit = repo.getUnit(unitId);
  if (!unit) return null;

  const evidence: ContactEvidence = {
    sourceUrl: unit.sourceUrl ?? '',
    sourceName: unit.sourceName ?? 'the original listing',
    operatorName: unit.operatorName ?? null,
    operatorWebsite: unit.operatorWebsite ?? null,
    phone: unit.contactPhone ?? null,
    instagram: unit.operatorInstagram ?? null,
    availabilityHintUrl: unit.availabilityHintUrl ?? null
  };

  // Without a source URL there is nothing honest to point at, so we return null rather
  // than inventing a destination. A place that cannot be reached is a data problem to
  // fix, not something to paper over with a guess.
  if (!evidence.sourceUrl) return null;

  return contactRoutes(evidence);
}

/** Build the discovery product over a repository. */
export function buildPlaceDirectory(
  repo: Repository,
  feePolicyFor: FeePolicyLookup
): PlaceDirectory {
  const search = createPlaceSearch({ repo, feePolicyFor });

  return {
    search: search.search,
    quoteUnit: search.quoteUnit,
    list: () => repo.listUnits({}),
    contactFor: (unitId) => contactForUnit(repo, unitId),
    primaryContactFor: (unitId) => {
      const routes = contactForUnit(repo, unitId);
      return routes ? primaryRoute(routes) : null;
    }
  };
}

let cached: Container | null = null;

export function getContainer(): Container {
  if (cached) return cached;

  const repo = new InMemoryRepository({
    partners: DEMO_PARTNERS,
    units: DEMO_UNITS,
    availability: seedAvailability(DEMO_UNITS, { from: '2026-01-01', days: 400 })
  });

  // The advertised fee policy for a state. It is used to compute the cost of a stay for
  // the guest's information. It is NOT a fee House3 collects, because House3 collects
  // nothing - the page says so beside the number.
  const feePolicyFor: FeePolicyLookup = (stateCode) => {
    const policies = allFeePolicies();
    return (
      policies.find((policy) => policy.subjectId === stateCode) ??
      policies.find((policy) => policy.subjectId === null) ??
      defaultFeePolicy()
    );
  };

  cached = { repo, places: buildPlaceDirectory(repo, feePolicyFor) };
  return cached;
}

/** Test helper. Also used by a fixture runner that needs a clean container. */
export function resetContainer(): void {
  cached = null;
}
