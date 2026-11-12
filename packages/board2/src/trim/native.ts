// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rails engine's build and mesh (docs/design/trim-blend-engine.md, "What the app asks of
 * an engine"): a rails board to its loop, rail laws, lofted panels and relief (`buildRails`),
 * and those to a closed mesh with its volume and areas (`meshRails`). Nothing here reads a
 * sections surface.
 */
import { board2Err, board2Ok, makeIssue } from '../issues';
import { TRIM } from '../params';
import type { Board2Issue, Board2Result, Chain } from '../types';
import type { RailsBoard, RailKey } from './board';
import { lawsFromKeys, railsAlong } from './keys';
import { buildLoft, loftPanels } from './loft';
import type { CurveAt, PanelLoft } from './loft';
import { buildLoop } from './loop';
import type { Loop } from './loop';
import { filledOutline, halfWidthOf, loopDefOf } from './outline';
import type { RailLaws } from './rails';
import { compileRelief } from './relief';
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
  /** The last build of the same board: its loop is reused when the outline and its corners are the same objects. */
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

/** The structural checks of a rails board: stations, their order and sides, and rail keys. */
function checkBoard(board: RailsBoard): Board2Issue[] {
  const issues: Board2Issue[] = [];
  const asym = board.symmetry === 'asymmetric';
  if (board.stations.length === 0) {
    issues.push(makeIssue('too-few-sections', 'the board has no station'));
  } else if (!sorted(board.stations.map((s) => s.x))) {
    issues.push(makeIssue('station-order', 'the stations are not in increasing x'));
  }
  if (asym) {
    for (const s of board.stations) {
      if (s.minus === undefined) {
        issues.push(
          makeIssue(
            'symmetry-fields',
            `station '${s.id}' has no minus side on an asymmetric board`,
            {
              at: { station: s.id },
            },
          ),
        );
      }
    }
  }
  const sides: ['plus' | 'minus', readonly RailKey[] | undefined][] = [['plus', board.rails.plus]];
  if (asym) sides.push(['minus', board.rails.minus]);
  for (const [side, keys] of sides) {
    if (keys === undefined || keys.length === 0) {
      issues.push(
        makeIssue('too-few-sections', `the ${side} side has no rail key`, { at: { side } }),
      );
    } else if (!sorted(keys.map((k) => k.x))) {
      issues.push(
        makeIssue('station-order', `the ${side} side's rail keys are not in increasing x`, {
          at: { side },
        }),
      );
    }
  }
  return issues;
}

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

/** The rail laws of a board on a loop: each side's keys along x; a mirror board's minus side has the plus keys. */
function lawsOf(board: RailsBoard, loop: Loop): RailLaws {
  const plus = railsAlong(board.rails.plus);
  const minus =
    board.symmetry === 'asymmetric' && board.rails.minus !== undefined
      ? railsAlong(board.rails.minus)
      : plus;
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
  const reuse =
    prev !== undefined &&
    prev.board.outline === board.outline &&
    prev.board.corners === board.corners;
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
  const laws = reuse && prev.board.rails === board.rails ? prev.laws : lawsOf(board, loop);

  const asym = board.symmetry === 'asymmetric';
  const plusWidth = reuse ? prev.halfWidth[0] : halfWidthOf(board.outline);
  const minusWidth = reuse
    ? prev.halfWidth[1]
    : asym && board.outline.minus !== undefined
      ? halfWidthOf(board.outline, 'minus')
      : plusWidth;
  const halfWidth = [plusWidth, minusWidth] as const;
  const filled = filledOutline(board.outline);
  const [xiMin, xiMax] = xRange(
    filled.minus === undefined ? [filled.plus] : [filled.plus, filled.minus],
  );

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
  readonly vertexCount: number;
  /** cm³, from the closed mesh's signed tetrahedra. */
  readonly volume: number;
  /** The loop's area, cm². */
  readonly planArea: number;
  /** The triangles' area, cm². */
  readonly surfaceArea: number;
  /** Not computed by this engine: always undefined. */
  readonly k1?: Float32Array;
  readonly k2?: Float32Array;
}

/** What `meshRails` is asked. */
export interface MeshRailsOptions {
  /** Accepted for the app's call shape; the quality is set by `draft` and `maxEdge`. */
  readonly tolerance?: number;
  /** An STL face size, cm: a finer grid, more rows and a finer loop. */
  readonly maxEdge?: number;
  /** The coarser quality used while dragging. */
  readonly draft?: boolean;
  /** Accepted and not acted on: `k1` and `k2` are not computed. */
  readonly curvature?: boolean;
}

/**
 * The kernel mesh of a built board at the quality `opts` asks for (docs/design/trim-blend-
 * engine.md, "Cost"). An STL face size rebuilds the loop no coarser than the face, and the
 * laws on it; the other qualities use the built loop.
 */
export function trimMeshOf(built: BuiltRails, opts: MeshRailsOptions = {}): TrimMesh {
  const f = opts.maxEdge;
  if (f !== undefined && f > 0) {
    const spacing = Math.min(TRIM.spacingMax, f);
    const loop = tryLoop(built.board, spacing) ?? built.loop;
    const laws = loop === built.loop ? built.laws : lawsOf(built.board, loop);
    const scale = Math.max(1, TRIM.stlFace / f);
    return buildTrimMesh(loop, laws, built.panels, Math.min(TRIM.viewGrid, f), {
      deckRows: Math.max(TRIM.stlDeckRows, Math.ceil(TRIM.stlDeckRows * scale)),
      tuckRows: Math.max(TRIM.stlTuckRows, Math.ceil(TRIM.stlTuckRows * scale)),
    });
  }
  if (opts.draft === true) {
    return buildTrimMesh(built.loop, built.laws, built.panels, TRIM.draftGrid, {
      deckRows: TRIM.draftDeckRows,
      tuckRows: TRIM.draftTuckRows,
    });
  }
  return buildTrimMesh(built.loop, built.laws, built.panels, TRIM.viewGrid, {
    deckRows: TRIM.deckRows,
    tuckRows: TRIM.tuckRows,
  });
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
  const mesh = trimMeshOf(built, opts);
  const { volume, area } = measure(mesh.positions, mesh.indices);
  // `curvature` is not acted on: k1 and k2 are left out
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    indices: mesh.indices,
    vertexCount: mesh.positions.length / 3,
    volume,
    planArea: loopArea(mesh.loop),
    surfaceArea: area,
  };
}
