// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The tab a fin sits on: its base. Two Futures tabs (futures-tab.ts), the FCS single
 * tab that plugs into an FCS 1 style single plug (small canard fins), and the FCS 1
 * base: two such tabs, one for each of the fin's two plugs. FCS II plugs take FCS 1
 * fins too. And the US box head: one long block for a longboard's single-fin box,
 * whose length follows the fin.
 *
 * All share one frame (cm): x from the base's rear end at 0 toward the nose, y up from
 * the tab bottom to its top at `height` (the blade root plane), extruded `thickness`
 * across, centred on its mid-plane. The outline of a fin is in this frame, so it places
 * the fin fore and aft on its base. A base is one or more separate tabs (`parts`).
 */
import type { Spline } from '../bezier-spline';
import { vec2, type Vec2 } from '../vec2';
import {
  FUTURES_TABS,
  futuresTabOutline,
  type FuturesTabKind,
  type TabSegment,
} from './futures-tab';

/** Which tab the fin sits on. */
export type FinBase = 'futures-side' | 'futures-centre' | 'fcs-single' | 'fcs-1' | 'us-box';

export const FIN_BASES: readonly FinBase[] = [
  'futures-side',
  'futures-centre',
  'fcs-single',
  'fcs-1',
  'us-box',
];

/** What the designer calls each base. */
export const FIN_BASE_LABEL: Record<FinBase, string> = {
  'futures-side': 'Futures 3/4"',
  'futures-centre': 'Futures 1/2"',
  'fcs-single': 'FCS single',
  'fcs-1': 'FCS 1',
  'us-box': 'US box',
};

/** The Futures tab a base is, or null for one that isn't Futures. */
export const futuresKind = (base: FinBase): FuturesTabKind | null =>
  base === 'futures-side' ? 'side' : base === 'futures-centre' ? 'centre' : null;

/**
 * The FCS single tab (cm): a plain block, held by a grub screw in the side of the plug,
 * so it needs no notch or slot. It drops straight in: no rocking, so no rear clearance
 * and no front grub screw to keep clear of. Cant comes from the plug (0°, 5° or 9°), so
 * the fin itself has none.
 */
export const FCS_SINGLE_TAB = { length: 2.05, height: 1.35, thickness: 0.635 } as const;

/**
 * The FCS 1 base (cm): two tabs the size of the FCS single tab, `gap` apart, their
 * lower corners rounded to `cornerRadius`. Fins are aligned from the back: the
 * trailing-edge root sits `rearBlade` behind the rear tab, so a bigger fin overhangs
 * further at the front. No cant: the plugs carry it. Owner's measurements of a stock
 * FCS 1 fin; aftermarket tabs have no grub-screw hole, so none is modelled.
 */
export const FCS1_BASE = {
  tabLength: 2.05,
  gap: 3.3,
  height: 1.35,
  thickness: 0.635,
  cornerRadius: 0.15,
  rearBlade: 2.05,
} as const;

/**
 * The US box fin head (cm), from the standard US box head drawing: 25 mm deep and
 * 9.6 mm (3/8") thick, 160–240 mm long. At the front, a 14.1 mm nose half the depth
 * (12.5 mm) carries the 4.5 mm screw hole (8-32 clearance), drilled down through it;
 * behind the nose a 12.7 mm radius scoop curves down to the full depth. The lower rear
 * corner is rounded (radius estimated from the drawing). The head's rear end is fixed
 * at x = 0 and its front follows the fin, `noseAhead` ahead of the leading-edge root
 * (at least `minLength` from the rear), with the screw hole just in front of the blade.
 * So sliding the fin fore and aft slides the blade along the head; a fin starts with
 * its trailing-edge root `rearStub` ahead of the rear end. No cant: centre fins.
 */
export const US_BOX_HEAD = {
  height: 2.5,
  thickness: 0.96,
  minLength: 16,
  maxLength: 24,
  noseDepth: 1.25,
  /** Key 9.6 mm, hole 4.5 mm, and a 0.5 mm land so the hole stays clear of the scoop. */
  noseAhead: 1.46,
  screwRadius: 0.225,
  /** Screw hole centre, behind the head's front. */
  screwFromFront: 1.185,
  scoopRadius: 1.27,
  rearRadius: 0.6,
  rearStub: 2.5,
} as const;

/**
 * A round hole straight down through a tab (along the blade's height), between two of
 * its flat horizontal faces: the US box head's screw hole.
 */
export interface FinTabBore {
  /** Centre, along the base (cm, frame above). */
  readonly x: number;
  readonly radius: number;
  /** Bottom and top of the hole (cm, frame above); each is a horizontal profile line. */
  readonly from: number;
  readonly to: number;
}

/** One tab of a base: its side profile and any holes through it. */
export interface FinTabPart {
  /** Closed, counter-clockwise (material on the left): lines and arcs. */
  readonly segments: readonly TabSegment[];
  /** Through-holes, each closed and clockwise (material outside): the Futures weight-saving slots. */
  readonly holes: readonly (readonly TabSegment[])[];
  /** Holes straight down through it, centred across its thickness. */
  readonly bores?: readonly FinTabBore[];
}

/** A base's tabs and overall size, in the frame above. */
export interface FinTabOutline {
  readonly base: FinBase;
  /** Where the rearmost tab starts (cm): 0, except on a US box, whose head follows the fin. */
  readonly rear: number;
  /** From the rear of the rearmost tab to the front of the foremost. */
  readonly length: number;
  readonly height: number;
  readonly thickness: number;
  /** The separate tabs, rearmost first. */
  readonly parts: readonly FinTabPart[];
}

const lineLoop = (corners: readonly Vec2[]): TabSegment[] =>
  corners.map((from, i) => ({
    kind: 'line' as const,
    from,
    to: corners[(i + 1) % corners.length]!,
  }));

/** A block from x0 to x1, `h` tall, its two lower corners rounded to `r`. */
const roundedBlock = (x0: number, x1: number, h: number, r: number): TabSegment[] => {
  const arc = (from: Vec2, to: Vec2, center: Vec2): TabSegment => ({
    kind: 'arc',
    from,
    to,
    center,
    radius: r,
    ccw: true,
  });
  return [
    { kind: 'line', from: vec2(x0 + r, 0), to: vec2(x1 - r, 0) },
    arc(vec2(x1 - r, 0), vec2(x1, r), vec2(x1 - r, r)),
    { kind: 'line', from: vec2(x1, r), to: vec2(x1, h) },
    { kind: 'line', from: vec2(x1, h), to: vec2(x0, h) },
    { kind: 'line', from: vec2(x0, h), to: vec2(x0, r) },
    arc(vec2(x0, r), vec2(x0 + r, 0), vec2(x0 + r, r)),
  ];
};

/**
 * Where a base puts a fin's trailing-edge root (cm, x in the frame above) when the fin
 * is moved onto it, or null where the fin is centred over the tab instead.
 */
export const baseTrailingRoot = (base: FinBase): number | null =>
  futuresKind(base) ? 0 : base === 'fcs-1' ? -FCS1_BASE.rearBlade : null;

/**
 * The US box head's length (cm) under a fin whose leading-edge root is at `le`: from its
 * rear end at 0 to the nose ahead of the leading edge, and never under the minimum. Over
 * the maximum is a broken rule (fin-rules.ts), not clamped, so the nose stays in place.
 */
export const usBoxHeadLength = (le: number): number =>
  Math.max(US_BOX_HEAD.minLength, le + US_BOX_HEAD.noseAhead);

/** The US box head under a fin whose leading-edge root is at `le`. */
const usBoxHead = (le: number): FinTabOutline => {
  const h = US_BOX_HEAD;
  const length = usBoxHeadLength(le);
  const front = length;
  const rear = 0;
  const body = le; // where the scoop leaves the nose
  const r = h.rearRadius;
  const s = h.scoopRadius;
  // The scoop's centre sits just below the bottom, so it meets the nose's underside
  // level and the bottom square, as drawn (12.7 mm radius over a 12.5 mm drop).
  const cy = h.noseDepth - s;
  const scoopFoot = body - Math.sqrt(s * s - cy * cy);
  const H = h.height;
  const segments: TabSegment[] = [
    { kind: 'line', from: vec2(rear + r, 0), to: vec2(scoopFoot, 0) },
    {
      kind: 'arc',
      from: vec2(scoopFoot, 0),
      to: vec2(body, h.noseDepth),
      center: vec2(body, cy),
      radius: s,
      ccw: false,
    },
    { kind: 'line', from: vec2(body, h.noseDepth), to: vec2(front, h.noseDepth) },
    { kind: 'line', from: vec2(front, h.noseDepth), to: vec2(front, H) },
    { kind: 'line', from: vec2(front, H), to: vec2(rear, H) },
    { kind: 'line', from: vec2(rear, H), to: vec2(rear, r) },
    {
      kind: 'arc',
      from: vec2(rear, r),
      to: vec2(rear + r, 0),
      center: vec2(rear + r, r),
      radius: r,
      ccw: true,
    },
  ];
  return {
    base: 'us-box',
    rear,
    length,
    height: H,
    thickness: h.thickness,
    parts: [
      {
        segments,
        holes: [],
        bores: [{ x: front - h.screwFromFront, radius: h.screwRadius, from: h.noseDepth, to: H }],
      },
    ],
  };
};

/**
 * A base's tabs. A US box head's front follows its fin, so it needs the fin's
 * `outline`; without one it is a nominal 200 mm head from x = 0.
 */
export const finTabOutline = (base: FinBase, outline?: Spline): FinTabOutline => {
  if (base === 'us-box') {
    const k = outline?.knots;
    return usBoxHead(k && k.length ? k[0]!.end.x : 20 - US_BOX_HEAD.noseAhead);
  }
  const kind = futuresKind(base);
  if (kind) {
    const spec = FUTURES_TABS[kind];
    return {
      base,
      rear: 0,
      length: spec.length,
      height: spec.height,
      thickness: spec.thickness,
      parts: [{ segments: futuresTabOutline(kind).segments, holes: futuresTabOutline(kind).holes }],
    };
  }
  if (base === 'fcs-1') {
    const { tabLength: l, gap, height: H, thickness, cornerRadius: r } = FCS1_BASE;
    const front = l + gap;
    return {
      base,
      rear: 0,
      length: front + l,
      height: H,
      thickness,
      parts: [
        { segments: roundedBlock(0, l, H, r), holes: [] },
        { segments: roundedBlock(front, front + l, H, r), holes: [] },
      ],
    };
  }
  const { length: L, height: H, thickness } = FCS_SINGLE_TAB;
  return {
    base,
    rear: 0,
    length: L,
    height: H,
    thickness,
    parts: [{ segments: lineLoop([vec2(0, 0), vec2(L, 0), vec2(L, H), vec2(0, H)]), holes: [] }],
  };
};
