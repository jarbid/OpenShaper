import { describe, expect, it } from 'vitest';
import { DEFAULT_REF_TOLERANCE, migrateRefTolerance } from './ref-tolerance';

describe('migrateRefTolerance', () => {
  it('keeps a positive number and falls back to 1 mm otherwise', () => {
    expect(migrateRefTolerance(0.25)).toBe(0.25);
    for (const bad of [0, -1, NaN, '0.2', null, undefined])
      expect(migrateRefTolerance(bad)).toBe(DEFAULT_REF_TOLERANCE);
    expect(DEFAULT_REF_TOLERANCE).toBe(0.1);
  });
});
