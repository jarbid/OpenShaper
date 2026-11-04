// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  defaultFinDesign,
  defaultKeel,
  defaultSingleFin,
  defaultTwinFin,
  placeOnBase,
  finReadouts,
  knot,
  knotLock,
  nacaSection,
  nudgeFore,
  splineFromKnots,
  validateFinDesign,
  vec2,
  type FinDesign,
  type Spline,
} from '@openshaper/kernel';
import { FinJsonError, readFinJson, writeFinJson } from './fin-json';

/** A copy of `s` with handle locks on its middle knot, as the editor will set them. */
const withLock = (s: Spline): Spline =>
  splineFromKnots(
    s.knots.map((k, i) =>
      i === 1
        ? knot(
            k.end,
            k.tangentToPrev,
            k.tangentToNext,
            k.continuous,
            k.other,
            knotLock(vec2(-0.6, 0.8), vec2(0.6, -0.8)),
          )
        : k,
    ),
  );

const designs: [string, FinDesign][] = [
  ['side, right', defaultFinDesign('side', 'right')],
  [
    'with foil slices',
    {
      ...defaultFinDesign('side', 'left'),
      slices: [
        { height: 0.4, section: nacaSection('2410') },
        { height: 0.8, section: nacaSection('0008') },
      ],
    },
  ],
  ['side, left', defaultFinDesign('side', 'left')],
  ['quad rear', defaultFinDesign('quad-rear', 'right')],
  ['centre', defaultFinDesign('centre')],
  [
    'edited: NACA 2412, 12.5° cant, nudged, locked handles',
    (() => {
      const d = defaultFinDesign('side', 'left');
      const moved = nudgeFore(d, 0.13);
      return {
        ...moved,
        cant: 12.5,
        lateralOffset: 0.05,
        section: nacaSection('2412'),
        outline: withLock(moved.outline),
        taper: withLock(d.taper),
      };
    })(),
  ],
];

/** Every number of every knot, in order, for comparing designs. */
const numbers = (s: Spline): number[] =>
  s.knots.flatMap((k) => [
    k.end.x,
    k.end.y,
    k.tangentToPrev.x,
    k.tangentToPrev.y,
    k.tangentToNext.x,
    k.tangentToNext.y,
    k.lock?.prev?.x ?? 0,
    k.lock?.prev?.y ?? 0,
    k.lock?.next?.x ?? 0,
    k.lock?.next?.y ?? 0,
  ]);

const expectSameSpline = (a: Spline, b: Spline): void => {
  const x = numbers(a);
  const y = numbers(b);
  expect(y.length).toBe(x.length);
  x.forEach((v, i) => expect(Math.abs(v - y[i]!)).toBeLessThan(1e-12));
  b.knots.forEach((k, i) => {
    expect(k.continuous).toBe(a.knots[i]!.continuous);
    expect(Boolean(k.lock)).toBe(Boolean(a.knots[i]!.lock));
  });
};

describe.each(designs)('.fin.json round trip (%s)', (_, d) => {
  const text = writeFinJson(d, { name: 'Test fin' });
  const { design, metadata } = readFinJson(text);

  it('reads back the same design', () => {
    expect(design.position).toBe(d.position);
    expect(design.hand).toBe(d.hand);
    expect(design.cant).toBe(d.cant);
    expect(Math.abs(design.lateralOffset - d.lateralOffset)).toBeLessThan(1e-15);
    expectSameSpline(d.outline, design.outline);
    expectSameSpline(d.section.outside, design.section.outside);
    expect(design.section.inside === null).toBe(d.section.inside === null);
    if (d.section.inside) expectSameSpline(d.section.inside, design.section.inside!);
    expect(design.slices.map((sl) => sl.height)).toEqual(d.slices.map((sl) => sl.height));
    design.slices.forEach((sl, i) => {
      const was = d.slices[i]!.section;
      expectSameSpline(was.outside, sl.section.outside);
      expect(sl.section.inside === null).toBe(was.inside === null);
      if (was.inside) expectSameSpline(was.inside, sl.section.inside!);
    });
    expectSameSpline(d.taper, design.taper);
    expect(metadata).toEqual({ name: 'Test fin' });
  });

  it('reads back with the same readouts and rule results', () => {
    const a = finReadouts(d);
    const b = finReadouts(design);
    expect(b.area).toBeCloseTo(a.area, 10);
    expect(b.sweep).toBeCloseTo(a.sweep, 10);
    expect(validateFinDesign(design).map((i) => i.code)).toEqual(
      validateFinDesign(d).map((i) => i.code),
    );
  });

  it('saves the same bytes again after loading, so autosave does not drift', () => {
    let t = text;
    for (let i = 0; i < 5; i++) t = writeFinJson(readFinJson(t).design, { name: 'Test fin' });
    expect(t).toBe(text);
  });
});

describe('.fin.json versions', () => {
  it('writes an FCS-tabbed fin with its base, and reads it back', () => {
    const d = { ...defaultFinDesign('side', 'left'), base: 'fcs-single' as const, cant: 0 };
    const doc = JSON.parse(writeFinJson(d)) as Record<string, unknown>;
    expect(doc.version).toBe(3);
    expect(doc.base).toBe('fcs-single');
    expect(readFinJson(writeFinJson(d)).design.base).toBe('fcs-single');
  });

  it('keeps a slice’s cant and toe change through a save', () => {
    const base = defaultFinDesign('side', 'left');
    const d = {
      ...base,
      slices: [{ height: 0.6, section: base.section, twist: { cant: 12, toe: -1 } }],
    };
    expect(readFinJson(writeFinJson(d)).design.slices[0]!.twist).toEqual({ cant: 12, toe: -1 });
  });

  it('reads an older file’s transition zone and drops it: the change eases over the whole span', () => {
    const base = defaultFinDesign('side', 'left');
    const d = {
      ...base,
      slices: [{ height: 0.6, section: base.section, twist: { cant: 12, toe: -1 } }],
    };
    const doc = JSON.parse(writeFinJson(d));
    doc.slices[0].twist.transition = 0.15;
    expect(readFinJson(JSON.stringify(doc)).design.slices[0]!.twist).toEqual({ cant: 12, toe: -1 });
  });

  it('writes a toe correction and reads it back', () => {
    const d = { ...defaultFinDesign('side', 'left'), toe: -1.25 };
    const doc = JSON.parse(writeFinJson(d)) as Record<string, unknown>;
    expect(doc.version).toBe(3);
    expect(readFinJson(writeFinJson(d)).design.toe).toBe(-1.25);
    expect(readFinJson(writeFinJson(defaultFinDesign('side'))).design.toe).toBe(0);
  });

  it('keeps the panel through a save, in mm, and leaves it out when none is set', () => {
    const d = { ...defaultFinDesign('side', 'left'), panel: { thickness: 0.9525, angle: -2.5 } };
    const doc = JSON.parse(writeFinJson(d)) as { version: number; panel: unknown };
    expect(doc.version).toBe(3);
    expect(doc.panel).toEqual({ thickness: 9.525, angle: -2.5 });
    const back = readFinJson(writeFinJson(d)).design.panel!;
    expect(back.thickness).toBeCloseTo(0.9525, 12);
    expect(back.angle).toBe(-2.5);
    const none = JSON.parse(writeFinJson(defaultFinDesign('side', 'left'))) as object;
    expect('panel' in none).toBe(false);
    expect(readFinJson(writeFinJson(defaultFinDesign('side'))).design.panel).toBeUndefined();
  });

  it('keeps a tilted panel’s tilt, and reads a panel without one as untilted', () => {
    const panel = { thickness: 0.9525, angle: 0, tilt: 5.5 };
    const d = { ...defaultFinDesign('side', 'left'), panel };
    expect(JSON.parse(writeFinJson(d)).panel).toEqual({ ...panel, thickness: 9.525 });
    expect(readFinJson(writeFinJson(d)).design.panel!.tilt).toBe(5.5);
    const flat = { ...d, panel: { thickness: 0.9525, angle: 0 } };
    expect('tilt' in JSON.parse(writeFinJson(flat)).panel).toBe(false);
    expect('tilt' in readFinJson(writeFinJson(flat)).design.panel!).toBe(false);
  });

  it('rejects a damaged panel', () => {
    const doc = JSON.parse(writeFinJson(defaultFinDesign('side', 'left')));
    expect(() =>
      readFinJson(JSON.stringify({ ...doc, version: 2, panel: { thickness: 9 } })),
    ).toThrow(/panel/);
    const tilted = { ...doc, version: 2, panel: { thickness: 9, angle: 0, tilt: 'x' } };
    expect(() => readFinJson(JSON.stringify(tilted))).toThrow(/panel/);
  });

  it('writes an FCS 1 fin with its base, and reads it back', () => {
    const d = placeOnBase(defaultFinDesign('side', 'left'), 'fcs-1');
    const doc = JSON.parse(writeFinJson(d));
    expect(doc.base).toBe('fcs-1');
    const back = readFinJson(writeFinJson(d)).design;
    expect(back.base).toBe('fcs-1');
    expect(back.cant).toBe(0);
    // Its place on the base comes back too.
    back.outline.knots.forEach((k, i) => {
      expect(k.end.x).toBeCloseTo(d.outline.knots[i]!.end.x, 12);
      expect(k.end.y).toBeCloseTo(d.outline.knots[i]!.end.y, 12);
    });
  });

  it('writes a US box single fin with its base, and reads it back', () => {
    const d = defaultSingleFin();
    expect(JSON.parse(writeFinJson(d)).base).toBe('us-box');
    const back = readFinJson(writeFinJson(d)).design;
    expect([back.base, back.position, back.cant, back.section.inside]).toEqual([
      'us-box',
      'centre',
      0,
      null,
    ]);
  });

  it('reads a file without a base as its position’s Futures tab', () => {
    expect(readFinJson(writeFinJson(defaultFinDesign('side'))).design.base).toBe('futures-side');
    expect(readFinJson(writeFinJson(defaultFinDesign('centre'))).design.base).toBe(
      'futures-centre',
    );
  });

  it('writes every fin as version 3, the swept loft, leaving out what isn’t set', () => {
    const doc = JSON.parse(writeFinJson(defaultFinDesign('centre'))) as Record<string, unknown>;
    expect(doc.version).toBe(3);
    expect(doc.slices).toBeUndefined();
    expect(doc.tipLine).toBeUndefined();
    expect(doc.thicknessPath).toBeUndefined();
    const d = {
      ...defaultFinDesign('centre'),
      slices: [{ height: 0.5, section: nacaSection('0010') }],
    };
    expect((JSON.parse(writeFinJson(d)) as Record<string, unknown>).version).toBe(3);
  });

  it('keeps the fin’s own minimum thickness through a save, in mm', () => {
    const base = defaultFinDesign('side', 'left');
    const doc = JSON.parse(writeFinJson({ ...base, minThickness: 0.12 }));
    expect(doc.minThickness).toBeCloseTo(1.2, 12);
    expect(readFinJson(JSON.stringify(doc)).design.minThickness).toBeCloseTo(0.12, 12);
    expect(JSON.parse(writeFinJson(base))).not.toHaveProperty('minThickness');
    expect(() => readFinJson(JSON.stringify({ ...doc, minThickness: -1 }))).toThrow(/minimum/);
  });

  it('keeps a moved tip line, the tip foil and the thickness path through a save', () => {
    const base = defaultFinDesign('side', 'left');
    const d = {
      ...base,
      tipLine: { start: 0.42, end: 0.61 },
      tipSection: nacaSection('2410'),
      thicknessMid: 0.35,
    };
    const back = readFinJson(writeFinJson(d)).design;
    expect(back.tipLine).toEqual({ start: 0.42, end: 0.61 });
    expect(back.thicknessMid).toBe(0.35);
    expectSameSpline(d.tipSection.outside, back.tipSection!.outside);
    const none = readFinJson(writeFinJson(base)).design;
    expect('tipSection' in none).toBe(false);
    expect('thicknessMid' in none).toBe(false);
  });

  it('rejects a damaged tip line, tip foil or thickness path', () => {
    const doc = JSON.parse(writeFinJson(defaultFinDesign('side', 'left')));
    expect(() => readFinJson(JSON.stringify({ ...doc, tipLine: { start: 0.4 } }))).toThrow(
      /tip line/,
    );
    expect(() => readFinJson(JSON.stringify({ ...doc, thicknessMid: 'x' }))).toThrow(
      /thickness path/,
    );
    expect(() => readFinJson(JSON.stringify({ ...doc, tipSection: { outside: [] } }))).toThrow();
  });

  it('drops the old tip scale: the thickness curve alone sets the thickness', () => {
    // Owner's choice: left by an editor that no longer set it, it thinned a hatchet's upper
    // blade by up to 1.8 mm below its thickness curve, out of sight.
    const doc = JSON.parse(writeFinJson(defaultFinDesign('side', 'left')));
    const d = readFinJson(JSON.stringify({ ...doc, tipScale: 0.61 })).design;
    expect('tipScale' in d).toBe(false);
    expect(JSON.parse(writeFinJson(d))).not.toHaveProperty('tipScale');
  });

  it('reads a version 1 file as a fin with no slices', () => {
    expect(readFinJson(writeFinJson(defaultFinDesign('side', 'left'))).design.slices).toEqual([]);
  });
});

describe('.fin.json units', () => {
  const d = defaultFinDesign('side', 'right');
  const doc = JSON.parse(writeFinJson(d)) as {
    units: string;
    outline: { e: [number, number] }[];
    taper: { e: [number, number] }[];
    section: { outside: { e: [number, number] }[] };
  };

  it('writes lengths in mm', () => {
    expect(doc.units).toBe('mm');
    // The leading-edge root of the default side fin, 101.7 mm from the tab's rear end.
    expect(doc.outline[0]!.e[0]).toBeCloseTo(finReadouts(d).rootChord * 10, 9);
    // Root thickness 8 mm, at height fraction 0.
    expect(doc.taper[0]!.e).toEqual([0, 8]);
  });

  it('keeps unitless curves unitless', () => {
    const last = doc.section.outside[doc.section.outside.length - 1]!;
    expect(last.e).toEqual([1, 0]); // the trailing edge, at chord fraction 1
    expect(doc.taper[doc.taper.length - 1]!.e[0]).toBe(1); // the tip, at height fraction 1
  });
});

describe('.fin.json rejects damaged files', () => {
  const good = (): Record<string, unknown> =>
    JSON.parse(writeFinJson(defaultFinDesign('side', 'right'))) as Record<string, unknown>;
  const read = (doc: unknown) => () => readFinJson(JSON.stringify(doc));

  it.each([
    ['not JSON', () => readFinJson('{')],
    ['a board document', read({ format: 'openshaper', version: 2 })],
    ['a newer version', read({ ...good(), version: 99 })],
    ['an unknown position', read({ ...good(), position: 'nose' })],
    ['a bad hand', read({ ...good(), hand: 'up' })],
    ['an unknown base', read({ ...good(), version: 2, base: 'glass-on' })],
    ['a non-numeric cant', read({ ...good(), cant: '7' })],
    ['other units', read({ ...good(), units: 'in' })],
    ['a missing outline', read({ ...good(), outline: undefined })],
    ['a one-point taper', read({ ...good(), taper: [(good().taper as unknown[])[0]] })],
    ['a missing section', read({ ...good(), section: undefined })],
    ['slices that are not a list', read({ ...good(), version: 2, slices: {} })],
    [
      'a slice with no height',
      read({ ...good(), version: 2, slices: [{ section: good().section }] }),
    ],
    ['a slice with no foil', read({ ...good(), version: 2, slices: [{ height: 0.5 }] })],
    [
      'a damaged section point',
      read({
        ...good(),
        section: { outside: [{ e: [0, 'x'], p: [0, 0], n: [0, 0] }], inside: null },
      }),
    ],
  ])('%s', (_, load) => {
    expect(load).toThrow(FinJsonError);
  });

  it('loads a design that breaks the fin rules: saving mid-edit is allowed', () => {
    const d = { ...defaultFinDesign('side', 'right'), cant: 30 };
    expect(validateFinDesign(readFinJson(writeFinJson(d)).design).map((i) => i.code)).toEqual([
      'cant',
    ]);
  });
});

describe('the owner’s twin fin and keel', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const owner = (name: string) =>
    readFinJson(readFileSync(resolve(here, `../../../docs/specs/fins/${name}.fin.json`), 'utf8'))
      .design;

  /** Every knot's point and handles, flat, in cm. */
  const coords = (s: { knots: readonly { end: Vec; tangentToPrev: Vec; tangentToNext: Vec }[] }) =>
    s.knots.flatMap((k) => [k.end, k.tangentToPrev, k.tangentToNext].flatMap((p) => [p.x, p.y]));
  type Vec = { x: number; y: number };
  // The file is mm and the reader divides by 10; the starting fins multiply by 0.1, which
  // can differ in the last bit. A millionth of a millimetre is the same drawing.
  const same = (a: number[], b: number[]) => {
    expect(a).toHaveLength(b.length);
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 7));
  };

  it.each([
    ['twin_fin_default', defaultTwinFin],
    ['keel_default', defaultKeel],
  ] as const)('starts %s exactly as the owner drew it', (name, make) => {
    const drawn = owner(name);
    const start = make('right');
    same(coords(start.outline), coords(drawn.outline));
    expect(start.outline.knots.map((k) => k.continuous)).toEqual(
      drawn.outline.knots.map((k) => k.continuous),
    );
    same(coords(start.taper), coords(drawn.taper));
    same(coords(start.section.outside), coords(drawn.section.outside));
    same(coords(start.section.inside!), coords(drawn.section.inside!));
    expect([start.position, start.hand, start.cant, start.base]).toEqual([
      drawn.position,
      drawn.hand,
      drawn.cant,
      drawn.base,
    ]);
  });
});
