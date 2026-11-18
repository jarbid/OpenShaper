// SPDX-License-Identifier: GPL-3.0-or-later
import { BUILT_IN_RAILS } from '@openshaper/store/rails';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_NAME,
  MY_RAILS_KEY,
  cleanName,
  getMyRails,
  mergeRails,
  myRailsFromJson,
  myRailsOfMeta,
  myRailsToJson,
  nameProblem,
  removeRail,
  renameRail,
  resetMyRails,
  saveRail,
  setMyRails,
  useMyRails,
  usedRails,
  type SavedRail,
} from './my-rails';
import { key, rail } from './test/rails-board';

const surf: SavedRail = { name: 'Surf', rail: rail(0.3, { band: 3 }) };
const point: SavedRail = { name: 'Point', rail: rail(0.25, { tuck: 3 }) };

beforeEach(() => {
  localStorage.clear();
  resetMyRails();
});
afterEach(() => localStorage.clear());

describe('a name', () => {
  it('is trimmed, its spaces made one, and cut to the length a block can show', () => {
    expect(cleanName('  Point   break ')).toBe('Point break');
    expect(cleanName('x'.repeat(100))).toHaveLength(MAX_NAME);
  });

  it('is refused when empty, a built-in rail’s (in any case), Custom, or already used', () => {
    expect(nameProblem('   ', [])).toBe('Give the rail a name.');
    expect(nameProblem('tucked', [])).toMatch(/built-in rail/);
    expect(nameProblem('HARD EDGE', [])).toMatch(/built-in rail/);
    expect(nameProblem('Custom', [])).toMatch(/built-in rail/);
    expect(nameProblem('surf', [surf])).toMatch(/already have a rail called “surf”/);
    expect(nameProblem('Surf 2', [surf])).toBeNull();
    // a rail may keep its own name when it is renamed
    expect(nameProblem('Surf', [surf], 'Surf')).toBeNull();
  });
});

describe('saving, removing and renaming', () => {
  it('saves a rail under a name, at the end of the list, with nothing but its seven numbers', () => {
    const done = saveRail([surf], ' Point ', { ...point.rail, junk: 1 } as typeof point.rail);
    expect(done).toEqual({ ok: true, name: 'Point', list: [surf, point] });
    expect(Object.keys((done as unknown as { list: SavedRail[] }).list[1]!.rail)).toEqual([
      'band',
      'hardness',
      'tuck',
      'tuckShape',
      'bottomEdge',
      'deckEdge',
      'apex',
    ]);
  });

  it('does not save under a name it refuses, and says why', () => {
    expect(saveRail([surf], 'Surf', point.rail)).toMatchObject({ ok: false });
    expect(saveRail([], 'Round', point.rail)).toMatchObject({ ok: false });
  });

  it('removes a rail by its name, and is the same list when it has none', () => {
    expect(removeRail([surf, point], 'Surf')).toEqual([point]);
    const list = [surf];
    expect(removeRail(list, 'Nothing')).toBe(list);
  });

  it('renames a rail where it stands, to a name that is free', () => {
    expect(renameRail([surf, point], 'Surf', 'Reef')).toEqual({
      ok: true,
      name: 'Reef',
      list: [{ name: 'Reef', rail: surf.rail }, point],
    });
    expect(renameRail([surf, point], 'Surf', 'Point')).toMatchObject({ ok: false });
    expect(renameRail([surf], 'Nope', 'Reef')).toMatchObject({ ok: false });
  });
});

describe('merging a board’s rails into the list', () => {
  it('adds the rails the list lacks, after its own', () => {
    expect(mergeRails([surf], [point])).toEqual([surf, point]);
  });

  it('is the same list when the board brings nothing new, and the same board twice changes nothing', () => {
    const list = [surf];
    expect(mergeRails(list, [])).toBe(list);
    expect(mergeRails(list, [{ name: 'Surf', rail: surf.rail }])).toBe(list);
    // a rail the list has under another name is the rail it has
    expect(mergeRails(list, [{ name: 'Wave', rail: surf.rail }])).toBe(list);
    const once = mergeRails(list, [point]);
    expect(mergeRails(once, [point])).toBe(once);
  });

  it('keeps a name that is taken by other numbers as Name (2), then (3)', () => {
    const other = { name: 'Surf', rail: rail(0.4, { band: 2.6 }) };
    const once = mergeRails([surf], [other]);
    expect(once.map((r) => r.name)).toEqual(['Surf', 'Surf (2)']);
    const third = { name: 'Surf', rail: rail(0.35, { band: 2.2 }) };
    expect(mergeRails(once, [third]).map((r) => r.name)).toEqual(['Surf', 'Surf (2)', 'Surf (3)']);
    // and merging the same board again adds no fourth
    expect(mergeRails(once, [other])).toBe(once);
  });

  it('renames a rail that came with a built-in rail’s name', () => {
    const merged = mergeRails([], [{ name: 'Round', rail: rail(0.33, { band: 2.9 }) }]);
    expect(merged.map((r) => r.name)).toEqual(['Round (2)']);
  });

  it('names a rail that came with no name', () => {
    expect(mergeRails([], [{ name: '  ', rail: surf.rail }]).map((r) => r.name)).toEqual([
      'My rail',
    ]);
  });
});

describe('the saved rails a board uses', () => {
  const rails = {
    plus: [key(20, 0.5), key(60, 0.5), key(100, 0.3, { band: 3 }), key(140, 0.25, { tuck: 3 })],
  };

  it('are those whose numbers a zone has, in the order they are met along the board', () => {
    expect(usedRails(rails, [point, surf])).toEqual([surf, point]);
  });

  it('leave out a rail no zone has, and a rail that is a built-in rail’s numbers', () => {
    expect(usedRails(rails, [{ name: 'Elsewhere', rail: rail(0.9) }])).toEqual([]);
    const asRound = { name: 'Mine', rail: BUILT_IN_RAILS.find((b) => b.id === 'round')!.rail };
    expect(usedRails({ plus: [key(20, 0.5)] }, [asRound])).toEqual([]);
  });

  it('look at the right side too, once', () => {
    const both = { plus: [key(20, 0.5)], minus: [key(20, 0.3, { band: 3 })] };
    expect(usedRails(both, [surf])).toEqual([surf]);
  });
});

describe('the JSON', () => {
  it('round trips the list, a rail as its seven numbers', () => {
    const json = myRailsToJson([surf, point]);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(myRailsFromJson(json)).toEqual([surf, point]);
  });

  it('drops what is not a saved rail: no name, a missing or infinite number, a repeated name', () => {
    expect(
      myRailsFromJson([
        surf,
        { name: 'No rail' },
        { rail: surf.rail },
        { name: 'Short', rail: { band: 1 } },
        { name: 'Inf', rail: { ...surf.rail, apex: Infinity } },
        { name: 'surf', rail: point.rail },
        null,
        7,
      ]),
    ).toEqual([surf]);
    expect(myRailsFromJson('nope')).toEqual([]);
    expect(myRailsFromJson(undefined)).toEqual([]);
  });

  it('reads a document’s own list from its meta', () => {
    expect(myRailsOfMeta({ extra: { myRails: myRailsToJson([surf]) } })).toEqual([surf]);
    expect(myRailsOfMeta({ extra: { surfer: 'x' } })).toEqual([]);
    expect(myRailsOfMeta({ extra: [1] })).toEqual([]);
    expect(myRailsOfMeta(undefined)).toEqual([]);
  });
});

describe('the list in this browser', () => {
  it('is empty to begin with, and kept under bs.myRails when set', () => {
    expect(getMyRails()).toEqual([]);
    setMyRails([surf]);
    expect(JSON.parse(localStorage.getItem(MY_RAILS_KEY)!)).toEqual(myRailsToJson([surf]));
    resetMyRails();
    expect(getMyRails()).toEqual([surf]);
  });

  it('survives storage that is blocked, and one that holds rubbish', () => {
    localStorage.setItem(MY_RAILS_KEY, '{not json');
    resetMyRails();
    expect(getMyRails()).toEqual([]);
    localStorage.setItem(MY_RAILS_KEY, JSON.stringify([surf, { name: 'bad' }]));
    resetMyRails();
    expect(getMyRails()).toEqual([surf]);
  });

  it('tells a component that shows it', () => {
    const { result } = renderHook(() => useMyRails());
    expect(result.current).toEqual([]);
    act(() => setMyRails([surf]));
    expect(result.current).toEqual([surf]);
  });
});
