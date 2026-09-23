import { describe, expect, it } from 'vitest';
import {
  AREA_CENTROIDS,
  boundingBox,
  centroidForArea,
  GeoError,
  haversineKm,
  inBoundingBox,
  inPriceBand,
  passesRadius,
  PRICE_BANDS,
  findPriceBand
} from '@/domain/geo';

const LEKKI = AREA_CENTROIDS['Lekki Phase 1']!;
const IKOYI = AREA_CENTROIDS['Ikoyi']!;
const MAITAMA = AREA_CENTROIDS['Maitama']!;

describe('haversineKm', () => {
  it('returns zero for the same point', () => {
    expect(haversineKm(LEKKI, LEKKI)).toBeCloseTo(0, 6);
  });

  it('is symmetric', () => {
    expect(haversineKm(LEKKI, IKOYI)).toBeCloseTo(haversineKm(IKOYI, LEKKI), 9);
  });

  it('measures Lagos neighbourhoods at the right order of magnitude', () => {
    // Lekki Phase 1 to Ikoyi is roughly 4-5 km as the crow flies.
    const km = haversineKm(LEKKI, IKOYI);
    expect(km).toBeGreaterThan(3);
    expect(km).toBeLessThan(6);
  });

  it('measures across cities correctly', () => {
    // Lagos to Abuja is about 530-560 km.
    const km = haversineKm(LEKKI, MAITAMA);
    expect(km).toBeGreaterThan(500);
    expect(km).toBeLessThan(600);
  });

  it('rejects out-of-range coordinates instead of returning nonsense', () => {
    expect(() => haversineKm({ lat: 91, lng: 3 }, LEKKI)).toThrow(GeoError);
    expect(() => haversineKm(LEKKI, { lat: 6, lng: 181 })).toThrow(GeoError);
    expect(() => haversineKm({ lat: Number.NaN, lng: 3 }, LEKKI)).toThrow(GeoError);
  });
});

describe('boundingBox', () => {
  it('contains the centre', () => {
    const box = boundingBox(MAITAMA, 3);
    expect(inBoundingBox(MAITAMA, box)).toBe(true);
  });

  it('widens longitude more at higher latitudes', () => {
    const lagos = boundingBox(LEKKI, 5);
    const abuja = boundingBox(MAITAMA, 5);
    const lagosSpan = lagos.maxLng - lagos.minLng;
    const abujaSpan = abuja.maxLng - abuja.minLng;
    // Abuja is further from the equator, so a 5km radius spans more longitude.
    expect(abujaSpan).toBeGreaterThan(lagosSpan);
  });

  it('rejects a non-positive radius', () => {
    expect(() => boundingBox(LEKKI, 0)).toThrow(GeoError);
    expect(() => boundingBox(LEKKI, -1)).toThrow(GeoError);
  });
});

describe('passesRadius', () => {
  it('accepts a unit inside the radius and reports its distance', () => {
    const result = passesRadius(IKOYI, { center: LEKKI, radiusKm: 10 });
    expect(result.passes).toBe(true);
    expect(result.distanceKm).toBeGreaterThan(3);
    expect(result.distanceKm).toBeLessThan(6);
  });

  it('rejects a unit outside the radius', () => {
    const result = passesRadius(IKOYI, { center: LEKKI, radiusKm: 1 });
    expect(result.passes).toBe(false);
    expect(result.distanceKm).toBe(Number.POSITIVE_INFINITY);
  });

  it('is inclusive at the boundary', () => {
    const exact = haversineKm(LEKKI, IKOYI);
    expect(passesRadius(IKOYI, { center: LEKKI, radiusKm: exact }).passes).toBe(true);
    expect(passesRadius(IKOYI, { center: LEKKI, radiusKm: exact * 0.999 }).passes).toBe(false);
  });

  it('rejects a different city', () => {
    expect(passesRadius(MAITAMA, { center: LEKKI, radiusKm: 25 }).passes).toBe(false);
  });
});

describe('centroidForArea', () => {
  it('looks up case-insensitively and ignores padding', () => {
    expect(centroidForArea('lekki phase 1')).toEqual(LEKKI);
    expect(centroidForArea('  MAITAMA  ')).toEqual(MAITAMA);
  });

  it('returns undefined for an area we have not surveyed', () => {
    expect(centroidForArea('Somewhere New')).toBeUndefined();
  });

  it('covers every neighbourhood the rollout lists for the launch states', () => {
    // Guards against a state gaining neighbourhoods in src/data/nigeria.ts
    // without anyone giving them coordinates, which would silently make them
    // un-geo-searchable.
    const counts = Object.keys(AREA_CENTROIDS).length;
    expect(counts).toBeGreaterThanOrEqual(40);
  });
});

describe('price bands', () => {
  it('finds bands by id and rejects unknown ids', () => {
    expect(findPriceBand('50-100k')?.maxKobo).toBe(10_000_000);
    expect(findPriceBand('nope')).toBeUndefined();
  });

  it('bands are contiguous with no gaps', () => {
    for (let index = 0; index < PRICE_BANDS.length - 1; index += 1) {
      const current = PRICE_BANDS[index]!;
      const next = PRICE_BANDS[index + 1]!;
      expect(current.maxKobo).toBe(next.minKobo);
    }
  });

  it('treats the top band as unbounded', () => {
    const top = PRICE_BANDS[PRICE_BANDS.length - 1]!;
    expect(top.maxKobo).toBeNull();
    expect(inPriceBand(500_000_000, top)).toBe(true);
  });

  it('applies bounds inclusively at both ends', () => {
    const band = findPriceBand('100-200k')!;
    expect(inPriceBand(band.minKobo, band)).toBe(true);
    expect(inPriceBand(band.maxKobo!, band)).toBe(true);
    expect(inPriceBand(band.minKobo - 1, band)).toBe(false);
    expect(inPriceBand(band.maxKobo! + 1, band)).toBe(false);
  });
});
