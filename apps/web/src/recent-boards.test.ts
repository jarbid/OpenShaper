/**
 * Tests for the recent-boards module.
 *
 * Storage key: localStorage 'bs.recent'
 * Format: JSON array of RecentEntry (newest first), capped at 8 entries and ~1 MB total.
 *
 * NOTE: localStorage is available and reset between tests via beforeEach.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRecentBoards,
  getRecentBoards,
  MAX_RECENT_BYTES,
  MAX_RECENT_ENTRIES,
  recordRecentBoard,
  STORAGE_KEY,
  type RecentEntry,
} from './recent-boards';

// Build a fake boardJson string of a given byte size.
function fakeBoardJson(sizeBytes: number): string {
  return 'x'.repeat(sizeBytes);
}

beforeEach(() => {
  localStorage.clear();
});

describe('getRecentBoards', () => {
  it('returns an empty array when nothing is stored', () => {
    expect(getRecentBoards()).toEqual([]);
  });

  it('returns the stored entries unchanged', () => {
    const entries: RecentEntry[] = [
      { name: 'Alpha', savedAt: '2026-01-01T00:00:00.000Z', boardJson: '{}' },
    ];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    expect(getRecentBoards()).toEqual(entries);
  });

  it('returns an empty array when the stored value is corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json{{');
    expect(getRecentBoards()).toEqual([]);
  });

  it('returns an empty array when the stored value is valid JSON but not an array', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ foo: 'bar' }));
    expect(getRecentBoards()).toEqual([]);
  });
});

describe('recordRecentBoard', () => {
  it('stores a new entry and returns it as the first element', () => {
    recordRecentBoard('My Board', '{"board":1}');
    const recent = getRecentBoards();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.name).toBe('My Board');
    expect(recent[0]!.boardJson).toBe('{"board":1}');
  });

  it('sets savedAt to a valid ISO date string', () => {
    recordRecentBoard('Board A', '{}');
    const { savedAt } = getRecentBoards()[0]!;
    expect(new Date(savedAt).getTime()).not.toBeNaN();
  });

  it('places newest entry first', () => {
    recordRecentBoard('First', '{}');
    recordRecentBoard('Second', '{}');
    const recent = getRecentBoards();
    expect(recent[0]!.name).toBe('Second');
    expect(recent[1]!.name).toBe('First');
  });

  it('de-dupes by name: moves an existing name to first position with fresh data', () => {
    recordRecentBoard('Alpha', '{"v":1}');
    recordRecentBoard('Beta', '{"v":2}');
    recordRecentBoard('Alpha', '{"v":3}'); // re-record Alpha with new json

    const recent = getRecentBoards();
    expect(recent).toHaveLength(2); // still 2 unique names
    expect(recent[0]!.name).toBe('Alpha');
    expect(recent[0]!.boardJson).toBe('{"v":3}'); // updated to latest
    expect(recent[1]!.name).toBe('Beta');
  });

  it('caps at MAX_RECENT_ENTRIES entries, evicting the oldest', () => {
    for (let i = 1; i <= MAX_RECENT_ENTRIES + 3; i++) {
      recordRecentBoard(`Board ${i}`, '{}');
    }
    const recent = getRecentBoards();
    expect(recent).toHaveLength(MAX_RECENT_ENTRIES);
    // newest at front
    expect(recent[0]!.name).toBe(`Board ${MAX_RECENT_ENTRIES + 3}`);
    // oldest evicted — the first 3 should be gone
    const names = recent.map((e) => e.name);
    expect(names).not.toContain('Board 1');
    expect(names).not.toContain('Board 2');
    expect(names).not.toContain('Board 3');
  });

  it('evicts oldest entries when total serialized size exceeds MAX_RECENT_BYTES', () => {
    // Each entry is ~250 kB; 5 would exceed 1 MB total.
    const bigJson = fakeBoardJson(250_000);
    for (let i = 1; i <= 5; i++) {
      recordRecentBoard(`Big Board ${i}`, bigJson);
    }
    const recent = getRecentBoards();
    // The raw stored bytes must not exceed MAX_RECENT_BYTES.
    const stored = localStorage.getItem(STORAGE_KEY)!;
    expect(stored.length).toBeLessThanOrEqual(MAX_RECENT_BYTES);
    // Newest should survive; oldest evicted.
    expect(recent[0]!.name).toBe('Big Board 5');
  });

  it('handles a single entry whose boardJson alone exceeds MAX_RECENT_BYTES gracefully', () => {
    // If a single board is oversized, we store just that one entry
    // (the invariant is "best effort" — at least the latest is kept).
    const giantJson = fakeBoardJson(MAX_RECENT_BYTES + 100);
    expect(() => recordRecentBoard('Giant', giantJson)).not.toThrow();
    // The list contains the entry (size constraint relaxed for last item).
    const recent = getRecentBoards();
    expect(recent[0]!.name).toBe('Giant');
  });

  it('does not throw when localStorage is full (quota exceeded)', () => {
    // Simulate quota error by temporarily breaking setItem.
    const original = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new DOMException('QuotaExceededError');
    };
    expect(() => recordRecentBoard('Board', '{}')).not.toThrow();
    localStorage.setItem = original;
  });
});

describe('clearRecentBoards', () => {
  it('removes all entries', () => {
    recordRecentBoard('A', '{}');
    recordRecentBoard('B', '{}');
    clearRecentBoards();
    expect(getRecentBoards()).toEqual([]);
  });

  it('does not throw when called on an empty list', () => {
    expect(() => clearRecentBoards()).not.toThrow();
  });
});

describe('constants', () => {
  it('MAX_RECENT_ENTRIES is 8', () => {
    expect(MAX_RECENT_ENTRIES).toBe(8);
  });

  it('MAX_RECENT_BYTES is approximately 1 MB', () => {
    expect(MAX_RECENT_BYTES).toBe(1_000_000);
  });
});
