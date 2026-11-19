// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rails engine's build and mesh (docs/design/trim-blend-engine.md, "What the app asks of
 * an engine"): a rails board to its loop, rail laws, lofted panels and relief (`buildRails`),
 * and those to a closed mesh with its volume and areas (`meshRails`). Nothing here reads a
 * sections surface.
 */
import { compileChain, funcEval } from '../chain';
import { board2Err, board2Ok, makeIssue } from '../issues';
import {
  RADIUS_MAX,
  RAIL_DOMAIN,
  RAILS_COORD_MAX,
  RAILS_FEATURES_MAX,
  RAILS_HALF_WIDTH_MAX,
  RAILS_KEYS_MAX,
  RAILS_KNOTS_MAX,
  RAILS_LENGTH_MAX,
  RAILS_OUTLINE_PATH_MAX,
  RAILS_STATIONS_MAX,
  STATION_GAP,
  TRIM,
} from '../params';
import type { Board2Issue, Board2IssueCode, Board2Result, Chain } from '../types';
import type { RailsBoard, RailKey, StationCurves } from './board';
import { vertexCurvature } from './curvature';
import { lawsFromKeys, railsAlong } from './keys';
import { buildLoft, loftPanels } from './loft';
import type { CurveAt, PanelLoft } from './loft';
import { buildLoop } from './loop';
import type { Loop } from './loop';
import { filledOutline, halfWidthOf, loopDefOf } from './outline';
import type { RailLaws } from './rails';
import { compileRelief } from './relief';
import { sameChain, sameNumbers } from './same';
import { trimSeams } from './seams';
import type { Seams } from './seams';
import { buildTrimMesh } from './solid';
import type { Panels, TrimMesh } from './solid';

/**
 * What a rails build reports, in the fields the app reads from a sections build's
 * `BuildReport`, with the values that are true here: no section is fitted, nothing is clamped
 * and no blend overshoots, so the numbers are 0 and there are no knot spans to hint at.
 * `model` tells it from a sections report.
 */
export interface RailsBuildReport {
  readonly model: 'rails';
  readonly stationFitError: number;
  readonly clampedControls: number;
  readonly blendOvershoot: number;
  /** Empty: a rails board has no common knot vector, so a later build has no span to reuse. */
  readonly sectionSpans: readonly [];
}

/** A built rails board. */
export interface BuiltRails {
  readonly board: RailsBoard;
  /** The ends of the outline in x (the tail at x = 0). */
  readonly xiMin: number;
  readonly xiMax: number;
  readonly loop: Loop;
  readonly laws: RailLaws;
  /** The lofted base panels, with the board's features as their relief. */
  readonly panels: Panels;
  /** Plus side, minus side (the same function twice on a mirror board). */
  readonly halfWidth: readonly [(x: number) => number, (x: number) => number];
  readonly report: RailsBuildReport;
}

/** What `buildRails` is asked. */
export interface BuildRailsOptions {
  /** Refuse a board that cannot be built (default true). */
  readonly check?: boolean;
  /**
   * The last build of the same board: its loop and half widths are reused when the outline and
   * its corners are equal by value, and its rail laws when the rail keys and the symmetry are too.
   */
  readonly previous?: BuiltRails;
}

const REPORT: RailsBuildReport = Object.freeze({
  model: 'rails',
  stationFitError: 0,
  clampedControls: 0,
  blendOvershoot: 0,
  sectionSpans: Object.freeze([]) as readonly [],
});

/** The smallest and largest knot x of the chains. */
function xRange(chains: readonly Chain[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of chains) {
    for (const k of c.knots) {
      lo = Math.min(lo, k.p[0]);
      hi = Math.max(hi, k.p[0]);
    }
  }
  return [lo, hi];
}

const sorted = (xs: readonly number[]): boolean => {
  for (let i = 1; i < xs.length; i++) if (!(xs[i]! > xs[i - 1]!)) return false;
  return true;
};

type Located = NonNullable<Board2Issue['at']>;

/** The points of a chain in order along it: each knot's in handle, the knot, its out handle. */
function* pointsOf(c: Chain): Generator<readonly [number, number]> {
  for (const k of c.knots) {
    yield k.in;
    yield k.p;
    yield k.out;
  }
}

/**
 * The first fault of a plan, rocker or deck chain, with its code, or null: a number that is not
 * finite, a coordinate beyond `RAILS_COORD_MAX` either way of the origin. With `plan`, also a point below
 * the stringer: each side's chain holds its half widths, y >= 0 (the minus side's too: the loop
 * mirrors it), so a point below y = 0 crosses to the other side (`outline-not-function`, the
 * sections model's code for an outline that is not a half width). A plan number that is not
 * finite is `geom`: the loop cannot be built from it, the refusal the loop's own build gives.
 */
function lineFault(
  c: Chain,
  plan: boolean,
): { readonly code: Board2IssueCode; readonly message: string } | null {
  if (c.knots.length > RAILS_KNOTS_MAX) {
    return {
      code: 'out-of-range',
      message: `has ${c.knots.length} knots; the limit is ${RAILS_KNOTS_MAX}`,
    };
  }
  let i = 0;
  for (const q of pointsOf(c)) {
    const knot = Math.floor(i++ / 3);
    if (!Number.isFinite(q[0]) || !Number.isFinite(q[1])) {
      return {
        code: plan ? 'geom' : 'out-of-range',
        message: `knot ${knot} holds a number that is not finite`,
      };
    }
    const r = Math.max(Math.abs(q[0]), Math.abs(q[1]));
    if (r > RAILS_COORD_MAX) {
      return {
        code: 'out-of-range',
        message: `knot ${knot} is at (${q[0].toPrecision(4)}, ${q[1].toPrecision(4)}): beyond ${RAILS_COORD_MAX} cm of the origin`,
      };
    }
    if (plan && q[1] < 0) {
      return {
        code: 'outline-not-function',
        message: `knot ${knot} is below the stringer (y = ${q[1]}): the outline must not cross it`,
      };
    }
  }
  return null;
}

/**
 * The first fault of a station curve, or null. A curve runs from the stringer (u = 0) to the
 * wall (u = 1) with its knots in increasing u, and every control point inside 0 <= u <= 1 (the
 * sections model's rule): the loft reads it on a u grid as a function of u, and samples each
 * segment in proportion to its extent in u.
 */
function curveFault(c: Chain): string | null {
  const k = c.knots;
  if (k.length > RAILS_KNOTS_MAX) return `has ${k.length} knots; the limit is ${RAILS_KNOTS_MAX}`;
  let i = 0;
  for (const q of pointsOf(c)) {
    if (!Number.isFinite(q[0]) || !Number.isFinite(q[1])) {
      return `knot ${Math.floor(i / 3)} holds a number that is not finite`;
    }
    i++;
  }
  if (k.length < 2) return 'has fewer than two knots';
  if (k[0]!.p[0] !== 0) return `starts at u = ${k[0]!.p[0]}, not at the stringer (u = 0)`;
  const last = k[k.length - 1]!.p[0];
  if (last !== 1) return `ends at u = ${last}, not at the wall (u = 1)`;
  for (let j = 1; j < k.length; j++) {
    if (k[j]!.p[0] < k[j - 1]!.p[0]) return `knot ${j} goes back in u`;
  }
  for (let j = 0; j < k.length; j++) {
    const handles = [...(j > 0 ? [k[j]!.in] : []), ...(j < k.length - 1 ? [k[j]!.out] : [])];
    for (const h of handles) {
      if (h[0] < 0 || h[0] > 1) return `knot ${j} has a handle at u = ${h[0]}, outside 0 to 1`;
    }
  }
  return null;
}

/** The first rail number of `key` outside `RAIL_DOMAIN`, as a phrase, or null. */
function railFault(key: RailKey): string | null {
  if (!Number.isFinite(key.x) || Math.abs(key.x) > RAILS_COORD_MAX) {
    return `is at x = ${key.x}, beyond ${RAILS_COORD_MAX} cm`;
  }
  const rail = key.rail as unknown as Readonly<Record<string, unknown>>;
  for (const name of Object.keys(RAIL_DOMAIN) as (keyof typeof RAIL_DOMAIN)[]) {
    const v = rail[name];
    const [lo, hi] = RAIL_DOMAIN[name];
    if (typeof v !== 'number' || !(v >= lo && v <= hi)) {
      return `has ${name} ${String(v)}, outside ${lo} to ${hi}`;
    }
  }
  return null;
}

/**
 * The checks of a rails board that need nothing built: no more stations, rail keys, knots, corner
 * radii and features than the reader accepts (so a board that builds can be saved and opened
 * again), every number finite and within the limits a board is held to (`RAILS_*` in
 * `params.ts`), the outline on its side of the stringer,
 * station ids unique, stations in increasing x at least `STATION_GAP` apart, station curves
 * that run from the stringer to the wall, each side's rail keys present and in order, and each
 * rail number and corner radius in its range. A side's minus fields are checked whenever they are
 * present, as the engine reads them whenever they are. Each fault is one issue; a chain, a key
 * list or a station reports its first fault only, so a large hostile file gives few issues.
 */
function checkBoard(board: RailsBoard): Board2Issue[] {
  const issues: Board2Issue[] = [];
  const err = (code: Board2IssueCode, message: string, at?: Located, value?: number): void => {
    issues.push(
      makeIssue(code, message, {
        ...(at === undefined ? {} : { at }),
        ...(value === undefined ? {} : { value }),
      }),
    );
  };
  const asym = board.symmetry === 'asymmetric';

  // the lines: finite, near the origin, the outline on its side of the stringer
  type Line = readonly [string, Chain, boolean, Located | undefined];
  const lines: Line[] = [['outline.plus', board.outline.plus, true, { side: 'plus' }]];
  if (board.outline.minus !== undefined) {
    lines.push(['outline.minus', board.outline.minus, true, { side: 'minus' }]);
  }
  lines.push(['rocker', board.rocker, false, undefined], ['deck', board.deck, false, undefined]);
  let linesOk = true;
  for (const [name, chain, plan, at] of lines) {
    const fault = lineFault(chain, plan);
    if (fault === null) continue;
    linesOk = false;
    err(fault.code, `${name}: ${fault.message}`, at);
  }
  // the outline's size: its extent along x, its widest control point and its control polygon's
  // length, which bounds the loop's samples
  if (linesOk) {
    const plan =
      board.outline.minus === undefined
        ? [board.outline.plus]
        : [board.outline.plus, board.outline.minus];
    const [lo, hi] = xRange(plan);
    if (hi - lo > RAILS_LENGTH_MAX) {
      err(
        'out-of-range',
        `the outline is ${(hi - lo).toPrecision(4)} cm long (the limit is ${RAILS_LENGTH_MAX} cm)`,
        undefined,
        hi - lo,
      );
    }
    for (const [side, chain] of plan.map((c, i) => [i === 0 ? 'plus' : 'minus', c] as const)) {
      let wide = 0;
      for (const q of pointsOf(chain)) wide = Math.max(wide, q[1]);
      if (wide > RAILS_HALF_WIDTH_MAX) {
        err(
          'out-of-range',
          `outline.${side}: the half width reaches ${wide.toPrecision(4)} cm (the limit is ${RAILS_HALF_WIDTH_MAX} cm)`,
          { side },
          wide,
        );
      }
      let path = 0;
      const k = chain.knots;
      for (let i = 0; i + 1 < k.length; i++) {
        const a = k[i]!;
        const b = k[i + 1]!;
        path +=
          Math.hypot(a.out[0] - a.p[0], a.out[1] - a.p[1]) +
          Math.hypot(b.in[0] - a.out[0], b.in[1] - a.out[1]) +
          Math.hypot(b.p[0] - b.in[0], b.p[1] - b.in[1]);
      }
      if (path > RAILS_OUTLINE_PATH_MAX) {
        err(
          'out-of-range',
          `outline.${side}: its control polygon is ${path.toPrecision(4)} cm long (the limit is ${RAILS_OUTLINE_PATH_MAX} cm)`,
          { side },
          path,
        );
      }
    }
  }

  // corner radii: at most one a corner knot, so no more than the reader accepts of knots
  const radiiFit = Math.max(board.corners.plus.length, board.corners.minus?.length ?? 0);
  if (radiiFit > RAILS_KNOTS_MAX) {
    err(
      'out-of-range',
      `the corner radii number ${radiiFit} a side; the limit is ${RAILS_KNOTS_MAX}`,
      undefined,
      radiiFit,
    );
  }
  const radii: [string, number][] =
    radiiFit > RAILS_KNOTS_MAX
      ? []
      : [
          ['nose', board.corners.nose],
          ['tail', board.corners.tail],
          ...board.corners.plus.map((r, i): [string, number] => [`plus[${i}]`, r]),
          ...(board.corners.minus ?? []).map((r, i): [string, number] => [`minus[${i}]`, r]),
        ];
  for (const [name, r] of radii) {
    if (!(r >= 0 && r <= RADIUS_MAX)) {
      err(
        'out-of-range',
        `corner radius ${name} is ${r}: it must be from 0 to ${RADIUS_MAX} cm`,
        undefined,
        r,
      );
      break;
    }
  }

  // stations: no more than the reader accepts, which are then the only ones looked at
  if (board.stations.length === 0) {
    err('too-few-sections', 'the board has no station');
  }
  const stationsFit = board.stations.length <= RAILS_STATIONS_MAX;
  if (!stationsFit) {
    err(
      'out-of-range',
      `the board has ${board.stations.length} stations; the limit is ${RAILS_STATIONS_MAX}`,
      undefined,
      board.stations.length,
    );
  }
  const stations = stationsFit ? board.stations : [];
  const ids = new Set<string>();
  stations.forEach((s, i) => {
    const at = { station: s.id };
    if (ids.has(s.id)) err('station-id', `station id '${s.id}' is used twice`, at);
    ids.add(s.id);
    if (!Number.isFinite(s.x)) {
      err('out-of-range', `station '${s.id}': x is ${s.x}, not a finite number`, at);
    } else if (i > 0) {
      const prev = stations[i - 1]!.x;
      if (!(s.x > prev)) {
        err(
          'station-order',
          `station '${s.id}': x ${s.x} must be greater than the previous station's ${prev}`,
          at,
          s.x,
        );
      } else if (s.x - prev < STATION_GAP) {
        err(
          'station-order',
          `station '${s.id}' is ${s.x - prev} cm from the previous station (the least is ${STATION_GAP} cm)`,
          at,
          s.x,
        );
      }
    }
    if (asym && s.minus === undefined) {
      err('symmetry-fields', `station '${s.id}' has no minus side on an asymmetric board`, at);
    }
    const sides: ['plus' | 'minus', StationCurves][] = [['plus', s.plus]];
    if (s.minus !== undefined) sides.push(['minus', s.minus]);
    for (const [side, curves] of sides) {
      for (const which of ['bottom', 'deck'] as const) {
        const fault = curveFault(curves[which]);
        if (fault !== null) {
          err('section-out-of-bounds', `station '${s.id}' (${side} ${which}): the curve ${fault}`, {
            station: s.id,
            side,
          });
        }
      }
    }
  });

  // bottom features
  if (board.features.length > RAILS_FEATURES_MAX) {
    err(
      'out-of-range',
      `the board has ${board.features.length} bottom features; the limit is ${RAILS_FEATURES_MAX}`,
      undefined,
      board.features.length,
    );
  }

  // rail keys
  const sides: ['plus' | 'minus', readonly RailKey[] | undefined][] = [['plus', board.rails.plus]];
  // an asymmetric board needs the minus keys; any board may have them
  if (asym || board.rails.minus !== undefined) sides.push(['minus', board.rails.minus]);
  for (const [side, keys] of sides) {
    if (keys === undefined || keys.length === 0) {
      err('too-few-sections', `the ${side} side has no rail key`, { side });
      continue;
    }
    if (keys.length > RAILS_KEYS_MAX) {
      err(
        'out-of-range',
        `the ${side} side has ${keys.length} rail keys; the limit is ${RAILS_KEYS_MAX}`,
        { side },
        keys.length,
      );
      continue;
    }
    const bad = keys.findIndex((k) => railFault(k) !== null);
    if (bad >= 0) {
      err('out-of-range', `the ${side} side's rail key ${bad} ${railFault(keys[bad]!)!}`, {
        side,
        key: bad,
      });
    } else if (!sorted(keys.map((k) => k.x))) {
      err('station-order', `the ${side} side's rail keys are not in increasing x`, { side });
    }
  }
  return issues;
}

/**
 * The checks of a rails board's stations against its plan and lines, made once the half widths
 * and the outline's extent are known: each station inside the extent, with some width on each
 * side where it is not at an end (the outline closes to no width at its ends) and some thickness.
 */
function stationIssues(
  board: RailsBoard,
  halfWidth: BuiltRails['halfWidth'],
  xiMin: number,
  xiMax: number,
): Board2Issue[] {
  const issues: Board2Issue[] = [];
  const rocker = compileChain(board.rocker);
  const deck = compileChain(board.deck);
  const r = new Float64Array(3);
  const d = new Float64Array(3);
  for (const s of board.stations) {
    const at = { station: s.id };
    if (!(s.x >= xiMin && s.x <= xiMax)) {
      issues.push(
        makeIssue(
          'station-order',
          `station '${s.id}': x ${s.x} is outside the outline's extent [${xiMin}, ${xiMax}]`,
          { at, value: s.x },
        ),
      );
      continue;
    }
    if (s.x > xiMin && s.x < xiMax && !(halfWidth[0](s.x) > 0 && halfWidth[1](s.x) > 0)) {
      issues.push(
        makeIssue('station-order', `station '${s.id}': the board has no width at x ${s.x}`, {
          at,
          value: s.x,
        }),
      );
    }
    funcEval(rocker, s.x, r, 0);
    funcEval(deck, s.x, d, 0);
    const t = d[0]! - r[0]!;
    if (!(t > 0)) {
      issues.push(
        makeIssue(
          'thickness',
          `station '${s.id}': the board has no thickness at x ${s.x} (${t} cm)`,
          { at, value: t },
        ),
      );
    }
  }
  return issues;
}

/** Whether two boards have the same outline and corner radii by value: what the loop and the half widths depend on. */
function sameOutline(a: RailsBoard, b: RailsBoard): boolean {
  if (a.outline === b.outline && a.corners === b.corners) return true;
  const c = a.corners;
  const d = b.corners;
  return (
    sameChain(a.outline.plus, b.outline.plus) &&
    sameChain(a.outline.minus, b.outline.minus) &&
    c.nose === d.nose &&
    c.tail === d.tail &&
    sameNumbers(c.plus, d.plus) &&
    sameNumbers(c.minus, d.minus)
  );
}

function sameKeys(a: readonly RailKey[] | undefined, b: readonly RailKey[] | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (p.x !== q.x) return false;
    const r = p.rail;
    const t = q.rail;
    if (r.band !== t.band || r.hardness !== t.hardness || r.tuck !== t.tuck) return false;
    if (r.tuckShape !== t.tuckShape || r.bottomEdge !== t.bottomEdge) return false;
    if (r.deckEdge !== t.deckEdge || r.apex !== t.apex) return false;
  }
  return true;
}

/** Whether two boards have the same rail laws on the same loop: the same keys by value on each side. */
const sameLaws = (a: RailsBoard, b: RailsBoard): boolean =>
  sameKeys(a.rails.plus, b.rails.plus) && sameKeys(a.rails.minus, b.rails.minus);

/** The loop of an outline, or null where it cannot be built. */
function tryLoop(board: RailsBoard, spacingMax?: number): Loop | null {
  let loop: Loop;
  try {
    const def = loopDefOf(board.outline, board.corners);
    loop = spacingMax === undefined ? buildLoop(def) : buildLoop(def, { spacingMax });
  } catch {
    return null;
  }
  if (!(loop.n >= 3)) return null;
  for (let i = 0; i < loop.n; i++) {
    if (!Number.isFinite(loop.x[i]!) || !Number.isFinite(loop.y[i]!)) return null;
    if (!Number.isFinite(loop.nx[i]!) || !Number.isFinite(loop.ny[i]!)) return null;
  }
  return loop;
}

/**
 * The rail laws of a board on a loop: each side's keys along x. A side's rail does not depend on
 * the outline's symmetry: the minus side has its own keys wherever the board gives it any, and the
 * plus keys otherwise.
 */
function lawsOf(board: RailsBoard, loop: Loop): RailLaws {
  const plus = railsAlong(board.rails.plus);
  const minus = board.rails.minus !== undefined ? railsAlong(board.rails.minus) : plus;
  return lawsFromKeys(loop, plus, minus);
}

/**
 * Builds a rails board: the loop from its outline and corners, the rail laws from its keys,
 * the four lofts (bottom and deck, each side) from its stations, and the relief from its
 * features. With `check` (the default) a board with no station, a side with no rail key,
 * stations or keys out of order, or an outline the loop cannot be built from is refused.
 */
export function buildRails(
  board: RailsBoard,
  opts: BuildRailsOptions = {},
): Board2Result<BuiltRails> {
  if (opts.check !== false) {
    const issues = checkBoard(board);
    if (issues.length > 0) return board2Err(issues);
  }
  const prev = opts.previous;
  const reuse = prev !== undefined && sameOutline(prev.board, board);
  let loop: Loop;
  if (reuse) {
    loop = prev.loop;
  } else {
    const built = tryLoop(board);
    if (built === null) {
      return board2Err([makeIssue('geom', 'the outline cannot be made into a closed loop')]);
    }
    loop = built;
  }
  const laws = reuse && sameLaws(prev.board, board) ? prev.laws : lawsOf(board, loop);

  const asym = board.symmetry === 'asymmetric';
  // the minus half width is the plus one on a mirror board
  const widths = reuse && prev.board.symmetry === board.symmetry;
  const plusWidth = widths ? prev.halfWidth[0] : halfWidthOf(board.outline);
  const minusWidth = widths
    ? prev.halfWidth[1]
    : asym && board.outline.minus !== undefined
      ? halfWidthOf(board.outline, 'minus')
      : plusWidth;
  const halfWidth = [plusWidth, minusWidth] as const;
  const filled = filledOutline(board.outline);
  const [xiMin, xiMax] = xRange(
    filled.minus === undefined ? [filled.plus] : [filled.plus, filled.minus],
  );
  if (opts.check !== false) {
    const issues = stationIssues(board, halfWidth, xiMin, xiMax);
    if (issues.length > 0) return board2Err(issues);
  }

  // the u grid: `loftSpacing` or finer at the widest half width, which the loop reaches
  let widest = 0;
  for (let i = 0; i < loop.n; i++) widest = Math.max(widest, Math.abs(loop.y[i]!));
  const samples = Math.max(2, Math.ceil(widest / TRIM.loftSpacing));
  const loftOf = (pick: (s: RailsBoard['stations'][number]) => Chain): PanelLoft =>
    buildLoft(
      board.stations.map((s): CurveAt => ({ x: s.x, curve: pick(s) })),
      samples,
    );
  const bottomPlus = loftOf((s) => s.plus.bottom);
  const topPlus = loftOf((s) => s.plus.deck);
  const bottomMinus = asym ? loftOf((s) => (s.minus ?? s.plus).bottom) : bottomPlus;
  const topMinus = asym ? loftOf((s) => (s.minus ?? s.plus).deck) : topPlus;
  const base = loftPanels({
    rocker: board.rocker,
    deck: board.deck,
    halfWidth,
    bottom: [bottomPlus, bottomMinus],
    top: [topPlus, topMinus],
    from: xiMin,
    to: xiMax,
  });
  const relief = compileRelief(board.features, halfWidth);
  const panels: Panels = relief === null ? base : { ...base, relief };

  return board2Ok(
    Object.freeze({
      board,
      xiMin,
      xiMax,
      loop,
      laws,
      panels,
      halfWidth,
      report: REPORT,
    }),
  );
}

/** A rails board's mesh, in the units of `BoardMesh`: cm, cm², cm³. */
export interface RailsMesh {
  readonly positions: Float32Array;
  /** Unit outward normals, exact from the surfaces. */
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  /**
   * The part of the board each vertex belongs to, one value of `FACE` (the deck panel, the bottom
   * panel, a deck blend or a tuck, each along a side, a tail's straight edge or round a corner).
   * The panels and the strips have their own vertices along the band edge, so a triangle's three
   * vertices share one value.
   */
  readonly face: Uint8Array;
  /** The lines that mark where one patch ends and the next begins, on this mesh's own vertices. */
  readonly seams: Seams;
  readonly vertexCount: number;
  /** cm³: the closed mesh's signed tetrahedra plus the panels' gap to their flat triangles (`TrimMesh.panelGap`), so it does not fall with a coarser grid. */
  readonly volume: number;
  /** The loop's area, cm². */
  readonly planArea: number;
  /** The triangles' area, cm². */
  readonly surfaceArea: number;
  /** Principal curvatures per vertex (1/cm, convex positive, k1 >= k2), only with `curvature`. */
  readonly k1?: Float32Array;
  readonly k2?: Float32Array;
  /**
   * Present, and true, only when the board's mesh budget (`TRIM.panelCellBudget`,
   * `TRIM.loopSampleBudget`) made the mesh coarser than asked: a board larger than any made.
   */
  readonly coarsened?: true;
  /** The panel grid (cm) used, with `coarsened`. */
  readonly grid?: number;
}

/** What `meshRails` is asked. */
export interface MeshRailsOptions {
  /** Accepted for the app's call shape; the quality is set by `draft` and `maxEdge`. */
  readonly tolerance?: number;
  /** An STL face size, cm: a finer grid, more rows and a finer loop. */
  readonly maxEdge?: number;
  /** The coarser quality used while dragging. */
  readonly draft?: boolean;
  /** Fill `k1` and `k2` from the mesh's exact normals. */
  readonly curvature?: boolean;
}

/** How a mesh is cut: the panel grid, the loop's spacing (the built loop's when absent) and the strips' rows. */
interface MeshPlan {
  readonly grid: number;
  readonly spacing?: number;
  readonly deckRows: number;
  readonly tuckRows: number;
  /** The budget made it coarser than asked. */
  readonly coarsened: boolean;
}

/**
 * The finest grid and loop spacing (cm) the mesh budget allows a built board: its loop's
 * bounding box over `TRIM.panelCellBudget` cells, and its perimeter over `TRIM.loopSampleBudget`.
 */
function budgetOf(built: BuiltRails): { readonly grid: number; readonly spacing: number } {
  const loop = built.loop;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < loop.n; i++) {
    x0 = Math.min(x0, loop.x[i]!);
    x1 = Math.max(x1, loop.x[i]!);
    y0 = Math.min(y0, loop.y[i]!);
    y1 = Math.max(y1, loop.y[i]!);
  }
  return {
    grid: Math.sqrt(((x1 - x0) * (y1 - y0)) / TRIM.panelCellBudget),
    spacing: loop.s[loop.n]! / TRIM.loopSampleBudget,
  };
}

/**
 * The cut of a mesh at the quality `opts` asks for (docs/design/trim-blend-engine.md, "Cost"),
 * held to the board's budget (`budgetOf`): a grid finer than the budget allows becomes the
 * budget's, and an STL face size finer than it becomes the coarsest of the two floors, which
 * sets its grid, loop spacing and rows as if it had been asked.
 */
function meshPlan(built: BuiltRails, opts: MeshRailsOptions): MeshPlan {
  const floor = budgetOf(built);
  const f = opts.maxEdge;
  if (f !== undefined && f > 0) {
    const face = Math.max(f, floor.grid, floor.spacing);
    const grid = Math.max(Math.min(TRIM.viewGrid, face), floor.grid);
    const scale = Math.max(1, TRIM.stlFace / face);
    return {
      grid,
      spacing: Math.min(TRIM.spacingMax, face),
      deckRows: Math.max(TRIM.stlDeckRows, Math.ceil(TRIM.stlDeckRows * scale)),
      tuckRows: Math.max(TRIM.stlTuckRows, Math.ceil(TRIM.stlTuckRows * scale)),
      coarsened: face !== f || grid !== Math.min(TRIM.viewGrid, f),
    };
  }
  const [grid, deckRows, tuckRows] =
    opts.draft === true
      ? [TRIM.draftGrid, TRIM.draftDeckRows, TRIM.draftTuckRows]
      : [TRIM.viewGrid, TRIM.deckRows, TRIM.tuckRows];
  return {
    grid: Math.max(grid, floor.grid),
    deckRows,
    tuckRows,
    coarsened: floor.grid > grid,
  };
}

/** The kernel mesh of a built board cut as `plan` says. An STL's spacing rebuilds the loop no coarser than it, and the laws on it. */
function meshOf(built: BuiltRails, plan: MeshPlan): TrimMesh {
  let loop = built.loop;
  let laws = built.laws;
  if (plan.spacing !== undefined) {
    loop = tryLoop(built.board, plan.spacing) ?? built.loop;
    if (loop !== built.loop) laws = lawsOf(built.board, loop);
  }
  return buildTrimMesh(loop, laws, built.panels, plan.grid, {
    deckRows: plan.deckRows,
    tuckRows: plan.tuckRows,
  });
}

/**
 * The kernel mesh of a built board at the quality `opts` asks for (docs/design/trim-blend-
 * engine.md, "Cost"), within the board's budget (`meshPlan`). An STL face size rebuilds the loop
 * no coarser than the face, and the laws on it; the other qualities use the built loop.
 */
export function trimMeshOf(built: BuiltRails, opts: MeshRailsOptions = {}): TrimMesh {
  return meshOf(built, meshPlan(built, opts));
}

/** The area enclosed by a loop, cm² (shoelace). */
export function loopArea(loop: Loop): number {
  let a = 0;
  for (let i = 0; i < loop.n; i++) {
    const k = (i + 1) % loop.n;
    a += loop.x[i]! * loop.y[k]! - loop.x[k]! * loop.y[i]!;
  }
  return Math.abs(a) / 2;
}

/** A mesh's volume (signed tetrahedra from the origin) and surface area, read from its triangles as they are. */
function measure(p: Float32Array, t: Uint32Array): { volume: number; area: number } {
  let volume = 0;
  let area = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = 3 * t[i]!;
    const b = 3 * t[i + 1]!;
    const c = 3 * t[i + 2]!;
    const ax = p[a]!;
    const ay = p[a + 1]!;
    const az = p[a + 2]!;
    const bx = p[b]!;
    const by = p[b + 1]!;
    const bz = p[b + 2]!;
    const cx = p[c]!;
    const cy = p[c + 1]!;
    const cz = p[c + 2]!;
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return { volume: volume / 6, area: area / 2 };
}

/** Meshes a built rails board, with its volume, plan area and surface area. */
export function meshRails(built: BuiltRails, opts: MeshRailsOptions = {}): RailsMesh {
  const plan = meshPlan(built, opts);
  const mesh = meshOf(built, plan);
  const facets = measure(mesh.positions, mesh.indices);
  const area = facets.area;
  const volume = facets.volume + mesh.panelGap;
  const k =
    opts.curvature === true
      ? vertexCurvature(mesh.positions, mesh.normals, mesh.indices)
      : undefined;
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    indices: mesh.indices,
    face: mesh.vertexFace,
    seams: trimSeams(mesh),
    vertexCount: mesh.positions.length / 3,
    volume,
    planArea: loopArea(mesh.loop),
    surfaceArea: area,
    ...(k === undefined ? {} : { k1: k.k1, k2: k.k2 }),
    ...(plan.coarsened ? { coarsened: true as const, grid: plan.grid } : {}),
  };
}
