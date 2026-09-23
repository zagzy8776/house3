import { describe, expect, it } from 'vitest';
import {
  ALL_STATES,
  EXPANSION_STATES,
  findState,
  LAUNCH_STATES,
  liveStates,
  totalStates
} from '@/data/nigeria';

describe('launch coverage', () => {
  it('starts with the five agreed states in order', () => {
    expect(LAUNCH_STATES.map((state) => state.name)).toEqual([
      'Lagos',
      'Federal Capital Territory',
      'Oyo',
      'Imo',
      'Akwa Ibom'
    ]);
  });

  it('numbers launch order contiguously from 1', () => {
    expect(LAUNCH_STATES.map((state) => state.launchOrder)).toEqual([1, 2, 3, 4, 5]);
  });

  it('gives every state a primary city and at least one anchor neighbourhood', () => {
    for (const state of ALL_STATES) {
      expect(state.primaryCity.length).toBeGreaterThan(2);
      expect(state.areas.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('gives each launch state deep neighbourhood coverage', () => {
    for (const state of LAUNCH_STATES) {
      expect(state.areas.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('uses unique state codes', () => {
    const codes = ALL_STATES.map((state) => state.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('never duplicates a neighbourhood within the same state', () => {
    for (const state of ALL_STATES) {
      expect(new Set(state.areas).size).toBe(state.areas.length);
    }
  });
});

describe('rollout gating', () => {
  it('exposes only Lagos before ops opens the next state', () => {
    expect(liveStates('phased', 1).map((state) => state.name)).toEqual(['Lagos']);
  });

  it('exposes the full launch set at gate 5', () => {
    expect(liveStates('phased', 5)).toHaveLength(5);
  });

  it('exposes everything in national mode', () => {
    expect(liveStates('all')).toBe(ALL_STATES);
  });

  it('covers 36 states plus the FCT', () => {
    expect(totalStates()).toBe(37);
    expect(EXPANSION_STATES).toHaveLength(32);
    expect(findState('FC')?.primaryCity).toBe('Abuja');
    expect(findState('ZZ')).toBeUndefined();
  });
});
