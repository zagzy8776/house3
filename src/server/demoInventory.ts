/**
 * Demo inventory used by the API routes and by the tests.
 *
 * These are illustrative operators in the five launch states. In production this
 * data arrives from the authorised channels in src/inventory, never hand-typed
 * into a fixture. Rates mirror realistic Lagos/Abuja/Ibadan/Owerri/Uyo shortlet
 * going rates so the pricing engine can be sanity-checked end to end.
 */

import { addDays, eachNight, type IsoDate } from '@/domain/dates';
import type { UnitNightState } from '@/domain/availability';
import type { ListedUnit, PartnerProfile } from './store';

export const DEMO_PARTNERS: PartnerProfile[] = [
  {
    id: 'p_lekki_homes',
    displayName: 'Lekki Homes Ltd',
    legalName: 'Lekki Homes Limited',
    stateCode: 'LA',
    area: 'Lekki Phase 1',
    status: 'ACTIVE',
    paystackSubaccountCode: 'ACCT_lekki_homes',
    settlementVerified: true
  },
  {
    id: 'p_island_suites',
    displayName: 'Island Suites Ikoyi',
    legalName: 'Island Suites Nigeria Ltd',
    stateCode: 'LA',
    area: 'Ikoyi',
    status: 'ACTIVE',
    paystackSubaccountCode: 'ACCT_island_suites',
    settlementVerified: true
  },
  {
    id: 'p_ajah_stays',
    displayName: 'Ajah Budget Stays',
    legalName: 'Ajah Stays Enterprises',
    stateCode: 'LA',
    area: 'Ajah',
    status: 'ACTIVE',
    // No settlement account yet: listed as onboarding, never sellable.
    paystackSubaccountCode: null,
    settlementVerified: false
  },
  {
    id: 'p_maitama_residences',
    displayName: 'Maitama Residences',
    legalName: 'Maitama Residences Ltd',
    stateCode: 'FC',
    area: 'Maitama',
    status: 'ACTIVE',
    paystackSubaccountCode: 'ACCT_maitama_res',
    settlementVerified: true
  },
  {
    id: 'p_ibadan_comfort',
    displayName: 'Ibadan Comfort Apartments',
    legalName: 'Ibadan Comfort Ltd',
    stateCode: 'OY',
    area: 'Jericho',
    status: 'ACTIVE',
    paystackSubaccountCode: 'ACCT_ibadan_comfort',
    settlementVerified: true
  },
  {
    id: 'p_owerri_garden',
    displayName: 'Owerri Garden Suites',
    legalName: 'Owerri Garden Suites Ltd',
    stateCode: 'IM',
    area: 'New Owerri',
    status: 'ACTIVE',
    paystackSubaccountCode: 'ACCT_owerri_garden',
    settlementVerified: true
  },
  {
    id: 'p_uyo_ewet',
    displayName: 'Ewet Housing Apartments',
    legalName: 'Ewet Housing Apartments Ltd',
    stateCode: 'AK',
    area: 'Ewet Housing Estate',
    status: 'ACTIVE',
    paystackSubaccountCode: 'ACCT_uyo_ewet',
    settlementVerified: true
  }
];

export const DEMO_UNITS: ListedUnit[] = [
  {
    id: 'u_lekki_2bed',
    partnerId: 'p_lekki_homes',
    name: '2-Bedroom Apartment, Lekki Phase 1',
    unitType: 'APARTMENT',
    maxGuests: 4,
    bedrooms: 2,
    bathrooms: 2,
    nightlyRateKobo: 15_000_000, // NGN 150,000
    cleaningFeeKobo: 1_000_000,
    extraGuestFeePerNightKobo: 500_000,
    includedGuests: 2,
    minNights: 1,
    maxNights: 30,
    bookable: true,
    status: 'LISTED',
    stateCode: 'LA',
    area: 'Lekki Phase 1'
  },
  {
    id: 'u_lekki_studio',
    partnerId: 'p_lekki_homes',
    name: 'Serviced Studio, Lekki Phase 1',
    unitType: 'STUDIO',
    maxGuests: 2,
    bedrooms: 1,
    bathrooms: 1,
    nightlyRateKobo: 8_500_000, // NGN 85,000
    cleaningFeeKobo: 500_000,
    extraGuestFeePerNightKobo: 0,
    includedGuests: 2,
    minNights: 2,
    maxNights: 30,
    bookable: true,
    status: 'LISTED',
    stateCode: 'LA',
    area: 'Lekki Phase 1'
  },
  {
    id: 'u_ikoyi_3bed',
    partnerId: 'p_island_suites',
    name: '3-Bedroom Serviced Flat, Ikoyi',
    unitType: 'APARTMENT',
    maxGuests: 6,
    bedrooms: 3,
    bathrooms: 3,
    nightlyRateKobo: 45_000_000, // NGN 450,000
    cleaningFeeKobo: 2_000_000,
    extraGuestFeePerNightKobo: 1_000_000,
    includedGuests: 4,
    minNights: 2,
    maxNights: 30,
    bookable: true,
    status: 'LISTED',
    stateCode: 'LA',
    area: 'Ikoyi'
  },
  {
    id: 'u_ajah_room',
    partnerId: 'p_ajah_stays',
    name: 'Private Room, Ajah',
    unitType: 'ROOM',
    maxGuests: 2,
    bedrooms: 1,
    bathrooms: 1,
    nightlyRateKobo: 2_500_000, // NGN 25,000
    cleaningFeeKobo: 200_000,
    extraGuestFeePerNightKobo: 0,
    includedGuests: 2,
    minNights: 1,
    maxNights: 14,
    bookable: true,
    status: 'LISTED',
    stateCode: 'LA',
    area: 'Ajah'
  },
  {
    id: 'u_maitama_2bed',
    partnerId: 'p_maitama_residences',
    name: '2-Bedroom Apartment, Maitama',
    unitType: 'APARTMENT',
    maxGuests: 4,
    bedrooms: 2,
    bathrooms: 2,
    nightlyRateKobo: 20_000_000, // NGN 200,000
    cleaningFeeKobo: 1_200_000,
    extraGuestFeePerNightKobo: 600_000,
    includedGuests: 2,
    minNights: 1,
    maxNights: 30,
    bookable: true,
    status: 'LISTED',
    stateCode: 'FC',
    area: 'Maitama'
  },
  {
    id: 'u_ibadan_1bed',
    partnerId: 'p_ibadan_comfort',
    name: '1-Bedroom Apartment, Jericho',
    unitType: 'APARTMENT',
    maxGuests: 2,
    bedrooms: 1,
    bathrooms: 1,
    nightlyRateKobo: 5_500_000, // NGN 55,000
    cleaningFeeKobo: 400_000,
    extraGuestFeePerNightKobo: 0,
    includedGuests: 2,
    minNights: 1,
    maxNights: 30,
    bookable: true,
    status: 'LISTED',
    stateCode: 'OY',
    area: 'Jericho'
  },
  {
    id: 'u_owerri_2bed',
    partnerId: 'p_owerri_garden',
    name: '2-Bedroom Suite, New Owerri',
    unitType: 'APARTMENT',
    maxGuests: 4,
    bedrooms: 2,
    bathrooms: 2,
    nightlyRateKobo: 7_000_000, // NGN 70,000
    cleaningFeeKobo: 500_000,
    extraGuestFeePerNightKobo: 300_000,
    includedGuests: 2,
    minNights: 1,
    maxNights: 30,
    bookable: true,
    status: 'LISTED',
    stateCode: 'IM',
    area: 'New Owerri'
  },
  {
    id: 'u_uyo_hostel_bed',
    partnerId: 'p_uyo_ewet',
    name: 'Hostel Bed, Ewet Housing Estate',
    unitType: 'HOSTEL_BED',
    maxGuests: 1,
    bedrooms: 1,
    bathrooms: 1,
    nightlyRateKobo: 700_000, // NGN 7,000
    cleaningFeeKobo: 0,
    extraGuestFeePerNightKobo: 0,
    includedGuests: 1,
    minNights: 1,
    maxNights: 30,
    bookable: true,
    status: 'LISTED',
    stateCode: 'AK',
    area: 'Ewet Housing Estate'
  }
];

/** Publishes OPEN nights with the unit's base rate for a rolling window. */
export function seedAvailability(
  units: readonly ListedUnit[],
  options: { from: IsoDate; days: number; closedNights?: Record<string, IsoDate[]> }
): Record<string, UnitNightState[]> {
  const availability: Record<string, UnitNightState[]> = {};
  for (const unit of units) {
    const closed = new Set(options.closedNights?.[unit.id] ?? []);
    const nights: UnitNightState[] = [];
    for (let offset = 0; offset < options.days; offset += 1) {
      const night = addDays(options.from, offset);
      nights.push({
        unitId: unit.id,
        night,
        state: closed.has(night) ? 'CLOSED' : 'OPEN',
        nightlyRateKobo: unit.nightlyRateKobo,
        source: 'PARTNER_DASHBOARD'
      });
    }
    availability[unit.id] = nights;
  }
  return availability;
}

/** Convenience for tests that need every night between two dates. */
export function nightsOf(checkIn: IsoDate, checkOut: IsoDate): IsoDate[] {
  return eachNight({ checkIn, checkOut });
}
