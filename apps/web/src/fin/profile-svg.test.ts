// SPDX-License-Identifier: GPL-3.0-or-later
import { defaultFinDesign, defaultKeel, type Spline } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { profileSvg } from './profile-svg';
import { parseSvg, vectorOutline } from './vector-import';

/** Every point and handle, measured from the first point: the shape, wherever it sits. */
const shape = (o: Spline) => {
  const at = o.knots[0]!.end;
  return o.knots.flatMap((k) =>
    [k.end, k.tangentToPrev, k.tangentToNext].map((p) => [p.x - at.x, p.y - at.y]),
  );
};

describe('the profile as SVG', () => {
  it.each([
    ['a side fin', defaultFinDesign('side', 'left').outline],
    ['a centre fin', defaultFinDesign('centre').outline],
    ['a keel', defaultKeel('left').outline],
  ])('reads back as the same profile through Import vector outline, facing left: %s', (_, o) => {
    const back = vectorOutline(parseSvg(profileSvg(o)), 'left');
    expect(back.knots).toHaveLength(o.knots.length);
    const want = shape(o);
    shape(back).forEach(([x, y], i) => {
      expect(x).toBeCloseTo(want[i]![0]!, 4);
      expect(y).toBeCloseTo(want[i]![1]!, 4);
    });
  });

  it('is full size in mm, with the front on the left', () => {
    const o = defaultFinDesign('centre').outline;
    const text = profileSvg(o);
    const xs = o.knots.flatMap((k) => [k.end.x, k.tangentToPrev.x, k.tangentToNext.x]);
    const wide = (Math.max(...xs) - Math.min(...xs)) * 10 + 4; // 2 mm margins
    expect(text).toContain(`width="${+wide.toFixed(4)}mm"`);
    // The leading-edge root (the first point) is left of the trailing-edge root (the last).
    const [path] = parseSvg(text);
    const first = path!.segs[0]![0];
    const last = path!.segs[path!.segs.length - 2]![3];
    expect(first.x).toBeLessThan(last.x);
    expect(path!.closed).toBe(true);
  });

  it('escapes its title', () => {
    expect(profileSvg(defaultFinDesign('centre').outline, 'A & B <1>')).toContain(
      '<title>A &amp; B &lt;1&gt;</title>',
    );
  });
});
