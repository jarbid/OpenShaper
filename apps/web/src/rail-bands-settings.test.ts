import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_RAIL_BANDS,
  RAIL_BANDS_VERSION,
  loadRailBands,
  migrateRailBands,
  saveRailBands,
} from './rail-bands-settings';

beforeEach(() => {
  localStorage.clear();
});

describe('loadRailBands', () => {
  it('returns defaults when localStorage is empty', () => {
    expect(loadRailBands()).toEqual(DEFAULT_RAIL_BANDS);
    expect(DEFAULT_RAIL_BANDS.version).toBe(RAIL_BANDS_VERSION);
  });

  it('defaults to three deck bands and a 12 in target station spacing', () => {
    expect(DEFAULT_RAIL_BANDS.bands).toBe(3);
    expect(DEFAULT_RAIL_BANDS.stationSpacingCm).toBeCloseTo(30.48, 4); // 12 in, in cm
  });

  it('round-trips through save/load under bs.railBands', () => {
    const custom = { ...DEFAULT_RAIL_BANDS, bands: 2, bottomAngle: 45, paperId: 'a3' };
    saveRailBands(custom);
    expect(localStorage.getItem('bs.railBands')).not.toBeNull();
    expect(loadRailBands()).toEqual(custom);
  });

  it('returns defaults when the stored JSON is malformed', () => {
    localStorage.setItem('bs.railBands', 'not-json{{{');
    expect(loadRailBands()).toEqual(DEFAULT_RAIL_BANDS);
  });
});

describe('migrateRailBands', () => {
  it('fills keys added since the blob was written, and stamps the version', () => {
    const stale = { version: 0, bands: 2 } as never;
    const migrated = migrateRailBands(stale);
    expect(migrated.version).toBe(RAIL_BANDS_VERSION);
    expect(migrated.bands).toBe(2);
    expect(migrated.bottomAngle).toBe(DEFAULT_RAIL_BANDS.bottomAngle);
    expect(migrated.endMarginCm).toBe(DEFAULT_RAIL_BANDS.endMarginCm);
  });

  it('gives a v1 blob the new default placement, not the ladder it used to get', () => {
    // The halving ladder was the only behaviour v1 had, so it was never a preference —
    // carrying it forward would freeze people out of the placement that replaced it.
    const v1 = { version: 1, bands: 3, bottomAngle: 30, stationIntervalCm: 40 } as never;
    const migrated = migrateRailBands(v1);
    expect(migrated.angleMode).toBe('least-foam');
    expect(migrated.stationSpacingCm).toBe(40);
  });

  it('retires a v2 blob still asking for the placement that was removed', () => {
    // `balanced` duplicated `least-foam` everywhere but its first band and was dropped;
    // passing it through would reach the kernel as an unknown mode.
    const v2 = { ...DEFAULT_RAIL_BANDS, version: 2, angleMode: 'balanced' } as never;
    expect(migrateRailBands(v2).angleMode).toBe('least-foam');
  });

  it('carries the manual marks a shaper set', () => {
    const mine = { ...DEFAULT_RAIL_BANDS, railPercent: 52, deckInCm: [2, 4, 7] };
    expect(migrateRailBands(mine).railPercent).toBe(52);
    expect(migrateRailBands(mine).deckInCm).toEqual([2, 4, 7]);
  });

  it('keeps a placement the user did choose', () => {
    const chosen = { ...DEFAULT_RAIL_BANDS, angleMode: 'ladder' as const };
    expect(migrateRailBands(chosen).angleMode).toBe('ladder');
  });
});
