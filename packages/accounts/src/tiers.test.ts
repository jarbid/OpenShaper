import { describe, expect, it } from 'vitest';
import { resolveTier, tierAllows } from './tiers';

describe('resolveTier — precedence: dev override > account > free', () => {
  it('falls back to free with no signal', () => {
    expect(resolveTier({})).toBe('free');
    expect(resolveTier({ devTier: null, accountTier: null })).toBe('free');
  });

  it('uses the account tier when signed in', () => {
    expect(resolveTier({ accountTier: 'pro' })).toBe('pro');
    expect(resolveTier({ accountTier: 'team' })).toBe('team');
  });

  it('lets the dev override win over the account tier', () => {
    expect(resolveTier({ devTier: 'pro', accountTier: 'free' })).toBe('pro');
    expect(resolveTier({ devTier: 'free', accountTier: 'team' })).toBe('free');
  });

  it('ignores unknown/empty values at each step', () => {
    expect(resolveTier({ devTier: 'platinum', accountTier: 'pro' })).toBe('pro');
    expect(resolveTier({ devTier: '', accountTier: 'bogus' })).toBe('free');
  });
});

describe('tierAllows — feature gating', () => {
  it('keeps free features open to everyone', () => {
    expect(tierAllows('free', 'export.pdf')).toBe(true);
  });

  it('gates STL/DXF behind Pro', () => {
    expect(tierAllows('free', 'export.stl')).toBe(false);
    expect(tierAllows('free', 'export.dxf')).toBe(false);
    expect(tierAllows('pro', 'export.stl')).toBe(true);
    expect(tierAllows('team', 'export.dxf')).toBe(true);
  });

  it('treats team as a superset of pro', () => {
    expect(tierAllows('team', 'cloud.sync')).toBe(true);
    expect(tierAllows('team', 'boards.unlimited')).toBe(true);
  });
});
