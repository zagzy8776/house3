/**
 * Geospatial domain.
 *
 * Pure maths, no dependencies and no database: the same code runs in the server,
 * in tests, and (if needed) in the browser. PostGIS does this work in production
 * for large result sets; this exists so the rules are testable and so the
 * in-memory store behaves identically to the real database.
 *
 * Distance model: haversine on a spherical earth. Good to ~0.5% over the
 * distances involved here (a few km within a city), which is far beyond what a
 * "within 3km of Maitama" filter needs. Do not use it for legal boundaries.
 */

export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_KM = 6371.0088;
const DEG_TO_RAD = Math.PI / 180;

export class GeoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeoError';
  }
}

export function assertLatLng(point: LatLng, label = 'point'): LatLng {
  if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
    throw new GeoError(`${label}.lat must be between -90 and 90, received ${point.lat}`);
  }
  if (!Number.isFinite(point.lng) || point.lng < -180 || point.lng > 180) {
    throw new GeoError(`${label}.lng must be between -180 and 180, received ${point.lng}`);
  }
  return point;
}

/** Great-circle distance in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  assertLatLng(a, 'a');
  assertLatLng(b, 'b');

  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLng = (b.lng - a.lng) * DEG_TO_RAD;
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;

  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type BoundingBox = { minLat: number; maxLat: number; minLng: number; maxLng: number };

/**
 * A lat/lng box that fully contains a radius.
 *
 * This is a cheap pre-filter: a box test rejects most rows with two comparisons
 * before anything computes a haversine. It is exactly the shape PostGIS
 * accelerates with a GiST index on a `geography` column, so the same two-stage
 * approach works in both stores - box first, then exact distance.
 */
export function boundingBox(center: LatLng, radiusKm: number): BoundingBox {
  assertLatLng(center, 'center');
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
    throw new GeoError(`radiusKm must be positive, received ${radiusKm}`);
  }

  const latDelta = radiusKm / 111.32;
  const lngDelta = radiusKm / (111.32 * Math.cos(center.lat * DEG_TO_RAD));

  return {
    minLat: center.lat - latDelta,
    maxLat: center.lat + latDelta,
    minLng: center.lng - lngDelta,
    maxLng: center.lng + lngDelta
  };
}

export function inBoundingBox(point: LatLng, box: BoundingBox): boolean {
  return (
    point.lat >= box.minLat &&
    point.lat <= box.maxLat &&
    point.lng >= box.minLng &&
    point.lng <= box.maxLng
  );
}

export type RadiusFilter = { center: LatLng; radiusKm: number };

/**
 * Two-stage radius test. Returns the distance so callers can sort by proximity
 * or render "1.2 km from Maitama".
 */
export function passesRadius(
  point: LatLng,
  filter: RadiusFilter
): { passes: boolean; distanceKm: number } {
  const box = boundingBox(filter.center, filter.radiusKm);
  if (!inBoundingBox(point, box)) {
    // Outside the box, therefore outside the circle - and no trig needed.
    return { passes: false, distanceKm: Number.POSITIVE_INFINITY };
  }
  const distanceKm = haversineKm(filter.center, point);
  return { passes: distanceKm <= filter.radiusKm, distanceKm };
}

/**
 * Reference coordinates for the neighbourhoods we onboard first.
 *
 * Neighbourhood centroids, accurate to a few hundred metres - good enough for
 * "show me stays near Maitama", not for a property boundary. Replace with
 * surveyed points during partner onboarding and store the authoritative value on
 * the unit itself; this map only backs the search box lookup.
 */
export const AREA_CENTROIDS: Record<string, LatLng> = {
  // Lagos
  'Lekki Phase 1': { lat: 6.4418, lng: 3.474 },
  'Lekki Phase 2': { lat: 6.4478, lng: 3.5286 },
  Ikoyi: { lat: 6.4541, lng: 3.4348 },
  'Victoria Island': { lat: 6.4281, lng: 3.4219 },
  Oniru: { lat: 6.4321, lng: 3.4599 },
  Ajah: { lat: 6.4667, lng: 3.5667 },
  Ikate: { lat: 6.4399, lng: 3.4906 },
  'Ikeja GRA': { lat: 6.5833, lng: 3.35 },
  Yaba: { lat: 6.5095, lng: 3.3711 },
  Surulere: { lat: 6.4998, lng: 3.3526 },
  Gbagada: { lat: 6.5556, lng: 3.3886 },
  Magodo: { lat: 6.6217, lng: 3.3733 },
  Ogudu: { lat: 6.5817, lng: 3.3867 },
  Festac: { lat: 6.4667, lng: 3.2833 },

  // Abuja
  Maitama: { lat: 9.0833, lng: 7.4951 },
  Asokoro: { lat: 9.0422, lng: 7.5242 },
  'Wuse 2': { lat: 9.0736, lng: 7.4764 },
  Garki: { lat: 9.0333, lng: 7.4833 },
  Gwarinpa: { lat: 9.1092, lng: 7.4022 },
  Jabi: { lat: 9.0705, lng: 7.4373 },
  'Katampe Extension': { lat: 9.0983, lng: 7.4719 },
  Lugbe: { lat: 8.9667, lng: 7.3667 },
  Guzape: { lat: 9.0558, lng: 7.5086 },
  Karsana: { lat: 9.0583, lng: 7.3667 },

  // Oyo (Ibadan)
  Bodija: { lat: 7.4206, lng: 3.909 },
  Jericho: { lat: 7.3915, lng: 3.8714 },
  'Ring Road': { lat: 7.3572, lng: 3.8772 },
  Dugbe: { lat: 7.3872, lng: 3.8842 },
  Akobo: { lat: 7.4444, lng: 3.8833 },
  'Oluyole Estate': { lat: 7.3392, lng: 3.8558 },
  Agodi: { lat: 7.4019, lng: 3.9019 },

  // Imo (Owerri)
  'New Owerri': { lat: 5.4667, lng: 7.0333 },
  Aladinma: { lat: 5.4833, lng: 7.0167 },
  Ikenegbu: { lat: 5.4931, lng: 7.0253 },
  'GRA Owerri': { lat: 5.4786, lng: 7.0289 },
  'MCC Road': { lat: 5.4725, lng: 7.0403 },
  Orji: { lat: 5.4967, lng: 7.0617 },

  // Akwa Ibom (Uyo)
  'Ewet Housing Estate': { lat: 5.0167, lng: 7.9167 },
  'Shelter Afrique': { lat: 5.05, lng: 7.9333 },
  Osongama: { lat: 5.0333, lng: 7.9 },
  'Oron Road': { lat: 5.0236, lng: 7.9514 },
  Itam: { lat: 5.0261, lng: 7.88 },
  Ibesikpo: { lat: 5.0, lng: 7.95 }
};

/** Case-insensitive centroid lookup, so "lekki phase 1" resolves. */
export function centroidForArea(area: string): LatLng | undefined {
  const wanted = area.trim().toLowerCase();
  const match = Object.keys(AREA_CENTROIDS).find((key) => key.toLowerCase() === wanted);
  return match ? AREA_CENTROIDS[match] : undefined;
}

/**
 * Price bands, expressed in kobo.
 *
 * The bands are set from observed Nigerian shortlet rates rather than round
 * numbers, so "under NGN 50k" is a band a guest would actually pick.
 */
export type PriceBand = { id: string; label: string; minKobo: number; maxKobo: number | null };

export const PRICE_BANDS: PriceBand[] = [
  { id: 'under-50k', label: 'Under ₦50,000', minKobo: 0, maxKobo: 5_000_000 },
  { id: '50-100k', label: '₦50,000 – ₦100,000', minKobo: 5_000_000, maxKobo: 10_000_000 },
  { id: '100-200k', label: '₦100,000 – ₦200,000', minKobo: 10_000_000, maxKobo: 20_000_000 },
  { id: '200-400k', label: '₦200,000 – ₦400,000', minKobo: 20_000_000, maxKobo: 40_000_000 },
  { id: 'above-400k', label: 'Above ₦400,000', minKobo: 40_000_000, maxKobo: null }
];

export function findPriceBand(id: string): PriceBand | undefined {
  return PRICE_BANDS.find((band) => band.id === id);
}

export function inPriceBand(amountKobo: number, band: PriceBand): boolean {
  if (amountKobo < band.minKobo) return false;
  return band.maxKobo === null || amountKobo <= band.maxKobo;
}
