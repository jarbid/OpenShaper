# 3D Guide Overlays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two independent toggles to every 3D view that draw an amber stringer-plane silhouette and a red ring at each real cross-section (the active one in brand cyan), replacing the existing translucent cross-section plane.

**Architecture:** A new, self-contained `packages/kernel/src/guides.ts` computes the lines from the _public_ surface definition (`getInterpolatedCrossSection` + `getRockerAtPos`, sampled by arc length). The loft surface is continuous, so a ring computed at any station lies on it — the mesh is just a faceted sample of the same surface. `render3d` gets a pure `guideLines()` builder plus a thin `<Guides3D>` wrapper modelled on the existing `Fins3D`.

**Tech Stack:** TypeScript (strict, ESM, `verbatimModuleSyntax`), React 18, three.js 0.171, @react-three/fiber 8, @react-three/drei 9 (`<Line>` = Line2/LineMaterial), Vitest 2, pnpm + Turborepo.

**Spec:** `docs/superpowers/specs/2026-08-04-3d-guide-overlays-design.md`

## Global Constraints

- **`packages/kernel/src/tessellate.ts` MUST NOT BE MODIFIED.** Not a rename, not an extracted helper, not a reordered import. It is the mesh hot path and the site of the crease bug fixed in PR #24. If a task seems to need a change there, stop and ask — the design is wrong, not the constraint.
- Every new source file starts with `// SPDX-License-Identifier: GPL-3.0-or-later`.
- `packages/kernel` is pure: no React, no DOM, no three.js imports. Ever.
- `verbatimModuleSyntax` is on — type-only imports MUST use `import type`.
- Tests are colocated as `*.test.ts` / `*.test.tsx` next to the code they test.
- Never modify `../boardcad-le`. It is read-only reference.
- Do not hand-format; a Prettier PostToolUse hook reformats edited files.
- Colours are fixed: stringer `#F59E0B`, section `#EF4444`, active section `#22D3EE`.
- `VIEW_STATE_VERSION` stays at `1`. Do not bump it (see Task 7).
- This feature displays no lengths, so the display-units convention in `apps/web/CLAUDE.md` does not apply. Do not add unit-formatted text.
- `.claude/CLAUDE.md` says "commit only when asked". Approving this plan is that ask: each task ends with a commit on the feature branch. Do **not** push or open a PR without a further explicit go-ahead.

## Test commands

```sh
pnpm --filter @openshaper/kernel test
pnpm --filter @openshaper/render3d test
pnpm --filter @openshaper/web test
pnpm typecheck
```

Single file:

```sh
pnpm --filter @openshaper/kernel exec vitest run src/guides.test.ts
```

## File Structure

| File                                                 | Responsibility                                           |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `packages/kernel/src/guides.ts` (create)             | `crossSectionRing` + `stringerLoop` on the public API.   |
| `packages/kernel/src/guides.test.ts` (create)        | Pins guides-land-on-the-mesh; stringer geometry.         |
| `packages/kernel/src/index.ts` (modify)              | `export * from './guides'`.                              |
| `packages/render3d/src/geometry.ts` (modify)         | Gains the shared `boardCenter` helper.                   |
| `packages/render3d/src/Fins3D.tsx` (modify)          | Drops its private `boardCenter`, imports the shared one. |
| `packages/render3d/src/guide-lines.ts` (create)      | Pure board → polylines builder. No React.                |
| `packages/render3d/src/guide-lines.test.ts` (create) | Add/remove-section behaviour, degenerate stations.       |
| `packages/render3d/src/Guides3D.tsx` (create)        | Thin R3F wrapper: centring group + drei `<Line>`s.       |
| `packages/render3d/src/Board3DView.tsx` (modify)     | Delete `SectionPlane`, render `<Guides3D>`, swap props.  |
| `packages/render3d/src/index.ts` (modify)            | Export `boardCenter`, `Guides3D`, `guideLines`.          |
| `apps/web/src/view3d-settings.ts` (create)           | React-free 3D settings type, defaults, option lists.     |
| `apps/web/src/view-toolkit.tsx` (modify)             | Imports/re-exports the above; two toggle buttons.        |
| `apps/web/src/view-toolkit.test.tsx` (create)        | Toggle rendering and patch behaviour.                    |
| `apps/web/src/section-index.ts` (create)             | `clampSectionIndex` — pure, testable.                    |
| `apps/web/src/section-index.test.ts` (create)        | Add/remove-station index clamping.                       |
| `apps/web/src/view-state.ts` (modify)                | Optional `view3d` field + per-field sanitiser.           |
| `apps/web/src/view-state.test.ts` (modify)           | Round-trip, garbage values, v1 back-compat.              |
| `apps/web/src/App.tsx` (modify)                      | Wiring: state init, persistence effect, props.           |
| `apps/web/src/pages/docs/Editing.tsx` (modify)       | New "Guides in 3D" section.                              |

---

### Task 0: Branch

- [ ] **Step 1: Confirm a clean tree on `main`**

```bash
git -C C:/Projects/Board_Studio/board-studio status --short --branch
```

Expected: `## main...origin/main` and no file lines. The spec and this plan under `docs/superpowers/` may be untracked — commit them first if so. Any _other_ uncommitted change: stop and ask the user.

- [ ] **Step 2: Create the feature branch**

```bash
git -C C:/Projects/Board_Studio/board-studio checkout -b feat/3d-guide-overlays
```

Expected: `Switched to a new branch 'feat/3d-guide-overlays'`

---

### Task 1: Kernel — `guides.ts`

**Why:** The overlay needs ring and centreline geometry. It gets it from the public surface definition, leaving the tessellator untouched.

**Files:**

- Create: `packages/kernel/src/guides.ts`, `packages/kernel/src/guides.test.ts`
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**

- Consumes: `getInterpolatedCrossSection`, `getLength`, `getRockerAtPos` (`./board`); `pointByCurveLengthAt`, `splineLength` (`./bezier-spline`); `CUTOUT_EPS`, `cachedOutlineSegments`, `hasTailCutout`, `yInOut` (`./outline-cutout`). All already exported.
- Produces:
  - `export interface GuidePoint { x: number; y: number; z: number }`
  - `export const crossSectionRing: (board: BezierBoard, x: number, steps: number) => GuidePoint[] | null`
  - `export const stringerLoop: (board: BezierBoard, steps: number, ringSteps: number) => GuidePoint[] | null`

- [ ] **Step 1: Write the failing test**

Create `packages/kernel/src/guides.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { board, getRockerAtPos, getThicknessAtPos, type BezierBoard } from './board';
import { crossSection } from './cross-section';
import { crossSectionRing, stringerLoop } from './guides';
import { tessellateBoard } from './tessellate';
import { parseBrdGeometry } from './test-support/brd-geometry';
import { polylineSpline } from './test-support/synthetic-boards';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, '../../../docs/specs/golden');

const loadBoard = (name: string) =>
  parseBrdGeometry(readFileSync(resolve(goldenDir, `${name}.brd`), 'utf8'));

const LENGTH_STEPS = 40;
const RING_STEPS = 24;
// A ring walks half = max(2, floor(24 / 2)) = 12 points up the +Y rail, then
// mirrors indices 10..1 back down the -Y rail — the two centreline points are
// shared, not duplicated. 12 + 10 = 22.
const RING_LEN = 22;

/** A board with no length at all — every guide query on it must return null. */
const zeroLengthBoard = (): BezierBoard => {
  const flat = polylineSpline([
    [0, 0],
    [0, 0],
  ]);
  return board(flat, flat, flat, [crossSection(0, flat), crossSection(0, flat)], 'controlPoint');
};

describe('crossSectionRing', () => {
  const b = loadBoard('shortboard');

  /**
   * The no-drift pin.
   *
   * `guides.ts` deliberately does NOT share code with the tessellator — the loft
   * surface is continuous, so a ring computed at any x lies on it. What the two
   * must share is the arc-length sampling convention, and this is what asserts
   * they still do. The station is read straight out of the mesh (every vertex in
   * one ring carries that ring's x), so the test never duplicates the
   * tessellator's station formula.
   */
  it('lands on the tessellated mesh at a station read from the mesh itself', () => {
    const mesh = tessellateBoard(b, { lengthSteps: LENGTH_STEPS, ringSteps: RING_STEPS });
    expect(mesh.positions.length / 3).toBe(LENGTH_STEPS * RING_LEN + 2); // +2 tip caps

    const x = mesh.positions[0]!; // ring 0's station
    const ring = crossSectionRing(b, x, RING_STEPS);
    expect(ring).not.toBeNull();
    expect(ring!).toHaveLength(RING_LEN);

    for (let i = 0; i < RING_LEN; i++) {
      const base = i * 3;
      // 4 decimal places = 1 micron. Not bit-exact only because `x` itself is a
      // float32 round-trip out of the mesh buffer.
      expect(ring![i]!.x).toBeCloseTo(mesh.positions[base]!, 4);
      expect(ring![i]!.y).toBeCloseTo(mesh.positions[base + 1]!, 4);
      expect(ring![i]!.z).toBeCloseTo(mesh.positions[base + 2]!, 4);
    }
  });

  it('closes around the hull: both rails, no duplicate centreline points', () => {
    const ring = crossSectionRing(b, 100, RING_STEPS)!;
    expect(ring.some((p) => p.y > 0)).toBe(true);
    expect(ring.some((p) => p.y < 0)).toBe(true);
    // Exactly two points sit on the centreline: the bottom and the deck.
    expect(ring.filter((p) => Math.abs(p.y) < 1e-9)).toHaveLength(2);
  });

  it('returns null for a degenerate board instead of throwing', () => {
    expect(crossSectionRing(zeroLengthBoard(), 0, RING_STEPS)).toBeNull();
  });
});

describe('stringerLoop', () => {
  const b = loadBoard('shortboard');

  it('returns two points per station — deck out, bottom back', () => {
    const loop = stringerLoop(b, LENGTH_STEPS, RING_STEPS);
    expect(loop).not.toBeNull();
    expect(loop!).toHaveLength(LENGTH_STEPS * 2);
  });

  it('stays on the centreline', () => {
    for (const v of stringerLoop(b, LENGTH_STEPS, RING_STEPS)!) {
      expect(Math.abs(v.y)).toBeLessThan(1e-9);
    }
  });

  it('is bounded by the rocker and the deck', () => {
    for (const v of stringerLoop(b, LENGTH_STEPS, RING_STEPS)!) {
      const rocker = getRockerAtPos(b, v.x);
      expect(v.z).toBeGreaterThanOrEqual(rocker - 1e-6);
      expect(v.z).toBeLessThanOrEqual(rocker + getThicknessAtPos(b, v.x) + 1e-6);
    }
  });

  it('visits both surfaces rather than tracing one of them twice', () => {
    const loop = stringerLoop(b, LENGTH_STEPS, RING_STEPS)!;
    const heightAbove = (i: number) => loop[i]!.z - getRockerAtPos(b, loop[i]!.x);
    const mid = LENGTH_STEPS >> 1;
    expect(heightAbove(mid)).toBeGreaterThan(2); // deck half
    expect(heightAbove(loop.length - 1 - mid)).toBeLessThan(0.5); // bottom half
  });

  it('returns null for a degenerate board instead of throwing', () => {
    expect(stringerLoop(zeroLengthBoard(), LENGTH_STEPS, RING_STEPS)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```sh
pnpm --filter @openshaper/kernel exec vitest run src/guides.test.ts
```

Expected: FAIL — cannot resolve `./guides`.

- [ ] **Step 3: Write the implementation**

Create `packages/kernel/src/guides.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Reference geometry for the 3D overlay: a ring around the hull at a station,
 * and the stringer plane's silhouette.
 *
 * Deliberately built on the PUBLIC surface definition — `getInterpolatedCrossSection`
 * plus `getRockerAtPos` — rather than by reaching into the tessellator. The loft
 * surface is continuous, so a ring computed at any x lies on it; the mesh is just
 * a faceted sample of that same surface. Keeping this separate means overlays can
 * never destabilise mesh generation.
 *
 * What IS shared with the tessellator is the sampling convention: fractional ARC
 * LENGTH, not fractional segment index. Adjacent stations can interpolate against
 * splines with different knot counts, and a segment-index parametrisation would
 * then land on different physical points for "the same" tt (the crease bug fixed
 * in PR #24). `guides.test.ts` pins guide rings to the mesh so the two conventions
 * cannot silently diverge.
 */
import { pointByCurveLengthAt, splineLength } from './bezier-spline';
import { getInterpolatedCrossSection, getLength, getRockerAtPos, type BezierBoard } from './board';
import { CUTOUT_EPS, cachedOutlineSegments, hasTailCutout, yInOut } from './outline-cutout';

/** A point on the board surface, in board cm: x = length, y = width, z = height. */
export interface GuidePoint {
  x: number;
  y: number;
  z: number;
}

const isFinite3 = (x: number, y: number, z: number): boolean =>
  Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);

/** Points sampled up one rail; the ring mirrors all but the two shared centreline points. */
const ringHalf = (steps: number): number =>
  Math.max(2, Math.floor(Math.max(4, Math.floor(steps)) / 2));

/**
 * A closed ring around the hull at station `x`.
 *
 * The profile spline runs (distance from centreline, height) and describes the
 * +Y rail half, so we walk it once by arc length and mirror it back.
 *
 * Returns null if the section is missing or degenerate.
 */
export const crossSectionRing = (
  board: BezierBoard,
  x: number,
  steps: number,
): GuidePoint[] | null => {
  const cs = getInterpolatedCrossSection(board, x);
  if (!cs) return null;

  const rocker = getRockerAtPos(board, x);
  if (!Number.isFinite(rocker)) return null;

  const total = splineLength(cs.spline);
  if (!Number.isFinite(total) || total <= 0) return null;

  const half = ringHalf(steps);
  const ring: GuidePoint[] = [];

  const push = (tt: number, mirror: boolean): boolean => {
    const p = pointByCurveLengthAt(cs.spline, tt * total, total);
    const y = mirror ? -p.x : p.x;
    const z = p.y + rocker;
    if (!isFinite3(x, y, z)) return false;
    ring.push({ x, y, z });
    return true;
  };

  // +Y rail: tt 0 (bottom centreline) -> tt 1 (deck centreline).
  for (let i = 0; i < half; i++) if (!push(i / (half - 1), false)) return null;
  // -Y rail: back down, skipping the two shared centreline endpoints.
  for (let i = half - 2; i >= 1; i--) if (!push(i / (half - 1), true)) return null;

  return ring.length >= 3 ? ring : null;
};

/** Stations along the length, inset a hair from the tips where the section goes null. */
const stations = (length: number, steps: number): number[] => {
  const n = Math.max(2, Math.floor(steps));
  const eps = Math.min(0.5, length * 1e-3);
  const span = length - 2 * eps;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(eps + (span * i) / (n - 1));
  return out;
};

/**
 * The stringer plane's silhouette as one polyline: the deck centreline from one
 * tip to the other, then the bottom/rocker centreline back.
 *
 * Stations whose centreline has been cut away by a tail notch (swallow / fish)
 * are skipped — there is no foam at y = 0 there for a line to lie on.
 *
 * Returns null when fewer than two stations yield a usable ring.
 */
export const stringerLoop = (
  board: BezierBoard,
  steps: number,
  ringSteps: number,
): GuidePoint[] | null => {
  const length = getLength(board);
  if (!Number.isFinite(length) || length <= 0) return null;

  const half = ringHalf(ringSteps);
  const segments = hasTailCutout(board.outline) ? cachedOutlineSegments(board.outline) : null;

  const deck: GuidePoint[] = [];
  const bottom: GuidePoint[] = [];
  for (const x of stations(length, steps)) {
    if (segments && yInOut(segments, x).yIn > CUTOUT_EPS) continue;
    const ring = crossSectionRing(board, x, ringSteps);
    if (!ring || ring.length < half) continue;
    bottom.push(ring[0]!); // tt = 0: bottom centreline
    deck.push(ring[half - 1]!); // tt = 1: deck centreline
  }

  if (deck.length < 2) return null;
  return [...deck, ...bottom.reverse()];
};
```

- [ ] **Step 4: Export from the kernel index**

In `packages/kernel/src/index.ts`, add alongside the other `export *` lines:

```ts
export * from './guides';
```

- [ ] **Step 5: Run the tests**

```sh
pnpm --filter @openshaper/kernel exec vitest run src/guides.test.ts
```

Expected: PASS, 8 tests. The mesh-landing test is the important one — if it fails, the sampling convention has diverged and that must be understood before continuing, not patched around with a looser tolerance.

- [ ] **Step 6: Prove the tessellator was not touched**

```bash
git -C C:/Projects/Board_Studio/board-studio status --short packages/kernel/src/tessellate.ts
```

Expected: **no output**. If this file shows as modified, revert it — the design does not require any change there.

- [ ] **Step 7: Run the full kernel suite**

```sh
pnpm --filter @openshaper/kernel test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/kernel/src/guides.ts packages/kernel/src/guides.test.ts packages/kernel/src/index.ts
git commit -m "feat(kernel): guide geometry for 3D overlays"
```

---

### Task 2: render3d — share `boardCenter`

**Why:** `meshToGeometry` calls `geometry.center()`. Anything drawn in board coordinates must be translated by the same offset. `Fins3D` already has this helper privately; `Guides3D` needs it too, and one definition beats two.

**Files:**

- Modify: `packages/render3d/src/geometry.ts`, `packages/render3d/src/Fins3D.tsx`, `packages/render3d/src/index.ts`
- Test: `packages/render3d/src/geometry.test.ts`

**Interfaces:**

- Produces: `export const boardCenter: (mesh: BoardMesh) => [number, number, number]`

- [ ] **Step 1: Write the failing test**

Append to `packages/render3d/src/geometry.test.ts`. Add `boardCenter` to its existing import from `./geometry`, and `type BoardMesh` to its `@openshaper/kernel` import.

```ts
describe('boardCenter', () => {
  it('is the bounding-box centre, not the average vertex', () => {
    // bbox x[0,2] y[0,4] z[0,6] → centre (1, 2, 3). The vertex mean is
    // (1, 5/3, 7/3), so a centroid implementation fails this.
    const mesh: BoardMesh = {
      positions: new Float32Array([0, 0, 0, 2, 4, 6, 1, 1, 1]),
      indices: new Uint32Array([0, 1, 2]),
      normals: new Float32Array(9),
    };
    expect(boardCenter(mesh)).toEqual([1, 2, 3]);
  });

  it('is exactly what geometry.center() subtracts from a real board', () => {
    const mesh = tessellateBoard(makeBoard());
    const c = boardCenter(mesh);
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      minX = Math.min(minX, mesh.positions[i]!);
      maxX = Math.max(maxX, mesh.positions[i]!);
    }
    expect(c[0]).toBeCloseTo((minX + maxX) / 2, 4);

    // And the centred geometry really is centred on the origin.
    const g = boardGeometry(makeBoard());
    g.computeBoundingBox();
    expect(Math.abs((g.boundingBox!.min.x + g.boundingBox!.max.x) / 2)).toBeLessThan(1e-3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```sh
pnpm --filter @openshaper/render3d exec vitest run src/geometry.test.ts
```

Expected: FAIL — `boardCenter` is not exported from `./geometry`.

- [ ] **Step 3: Move the helper into `geometry.ts`**

Add to `packages/render3d/src/geometry.ts`, after `meshToGeometry`:

```ts
/**
 * The bounding-box centre of a board mesh — exactly what `geometry.center()`
 * subtracts in {@link meshToGeometry}.
 *
 * Anything built in board coordinates (fins, guide lines) must be wrapped in a
 * group translated by the negation of this to stay aligned with the hull.
 */
export const boardCenter = (mesh: BoardMesh): [number, number, number] => {
  const p = mesh.positions;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!;
    const y = p[i + 1]!;
    const z = p[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
};
```

- [ ] **Step 4: Delete the copy in `Fins3D.tsx`**

Remove the whole `boardCenter` const from `packages/render3d/src/Fins3D.tsx` (its doc comment plus the function, roughly lines 24-45), and change the import on line 9 from:

```ts
import { tessellateAsync } from './geometry';
```

to:

```ts
import { boardCenter, tessellateAsync } from './geometry';
```

- [ ] **Step 5: Export from the package index**

In `packages/render3d/src/index.ts`, add `boardCenter` to the existing export list from `./geometry`.

- [ ] **Step 6: Run the tests**

```sh
pnpm --filter @openshaper/render3d test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/render3d/src/geometry.ts packages/render3d/src/geometry.test.ts packages/render3d/src/Fins3D.tsx packages/render3d/src/index.ts
git commit -m "refactor(render3d): share boardCenter between fins and overlays"
```

---

### Task 3: render3d — `guideLines` builder and `Guides3D` component

**Why:** Separating the pure builder from the R3F component makes the add/remove-station behaviour testable without rendering WebGL.

**Files:**

- Create: `packages/render3d/src/guide-lines.ts`, `packages/render3d/src/guide-lines.test.ts`, `packages/render3d/src/Guides3D.tsx`
- Modify: `packages/render3d/src/index.ts`

**Interfaces:**

- Consumes: `crossSectionRing`, `stringerLoop`, `GuidePoint`, `tessellationSteps` (Task 1 + existing kernel); `boardCenter`, `tessellateAsync` (Task 2).
- Produces:
  - `export interface GuideLine { key: string; points: [number, number, number][] }`
  - `export interface GuideLines { stringer: GuideLine | null; sections: GuideLine[]; activeKey: string | null }`
  - `export function guideLines(board: BezierBoard, targetFaceSize: number, activeX: number | null): GuideLines`
  - `export function Guides3D(props: { board: BezierBoard; targetFaceSize: number; showStringer: boolean; showSections: boolean; activeSectionX: number | null }): JSX.Element | null`

- [ ] **Step 1: Write the failing test**

Create `packages/render3d/src/guide-lines.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  board,
  crossSection,
  knot,
  splineFromKnots,
  vec2,
  type BezierBoard,
  type CrossSection,
} from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { guideLines } from './guide-lines';

const FACE = 1.5; // draft density — fewer stations, faster tests

/** Rounded rail profile, reused at every station. */
const prof = () =>
  splineFromKnots([
    knot(vec2(0, 5), vec2(0, 5), vec2(10, 5)),
    knot(vec2(10, 8), vec2(10, 6), vec2(10, 8)),
  ]);

/**
 * A well-formed 100 cm board whose REAL cross-sections sit at `positions`. The
 * first and last entries are the nose/tail dummies the kernel expects, and are
 * the ones `guideLines` must skip.
 */
function makeBoard(positions: number[]): BezierBoard {
  const k = (ex: number, ey: number) => knot(vec2(ex, ey), vec2(ex - 5, ey), vec2(ex + 5, ey));
  const outline = splineFromKnots([k(0, 0), k(50, 20), k(100, 0)]);
  const bottom = splineFromKnots([k(0, 5), k(100, 5)]);
  const deck = splineFromKnots([k(0, 11), k(100, 11)]);
  const cs: CrossSection[] = [
    crossSection(0, prof()),
    ...positions.map((p) => crossSection(p, prof())),
    crossSection(100, prof()),
  ];
  return board(outline, bottom, deck, cs);
}

describe('guideLines', () => {
  it('draws a ring per REAL cross-section, skipping the nose/tail dummies', () => {
    expect(guideLines(makeBoard([25, 50, 75]), FACE, null).sections).toHaveLength(3);
  });

  it('closes every ring so the polyline meets itself', () => {
    const pts = guideLines(makeBoard([50]), FACE, null).sections[0]!.points;
    expect(pts.length).toBeGreaterThan(3);
    expect(pts[pts.length - 1]).toEqual(pts[0]);
  });

  it('produces a stringer loop that stays on the centreline', () => {
    const g = guideLines(makeBoard([50]), FACE, null);
    expect(g.stringer).not.toBeNull();
    expect(g.stringer!.points.length).toBeGreaterThan(3);
    for (const [, y] of g.stringer!.points) expect(Math.abs(y)).toBeLessThan(1e-9);
  });

  it('gains a ring when a station is added', () => {
    const before = guideLines(makeBoard([25, 75]), FACE, null).sections.length;
    const after = guideLines(makeBoard([25, 50, 75]), FACE, null).sections.length;
    expect(after).toBe(before + 1);
  });

  it('loses a ring when a station is deleted', () => {
    const before = guideLines(makeBoard([25, 50, 75]), FACE, null).sections.length;
    const after = guideLines(makeBoard([25, 75]), FACE, null).sections.length;
    expect(after).toBe(before - 1);
  });

  it('keys rings by station position, so an insert does not renumber the rest', () => {
    const before = guideLines(makeBoard([25, 75]), FACE, null).sections.map((s) => s.key);
    const after = guideLines(makeBoard([25, 50, 75]), FACE, null).sections.map((s) => s.key);
    for (const key of before) expect(after).toContain(key);
    expect(new Set(after).size).toBe(after.length);
  });

  it('marks the ring at activeX as active', () => {
    const g = guideLines(makeBoard([25, 50, 75]), FACE, 50);
    expect(g.activeKey).not.toBeNull();
    expect(g.sections.filter((s) => s.key === g.activeKey)).toHaveLength(1);
  });

  it('has no active ring when activeX matches no station', () => {
    expect(guideLines(makeBoard([25, 75]), FACE, 50).activeKey).toBeNull();
    expect(guideLines(makeBoard([25, 75]), FACE, null).activeKey).toBeNull();
  });

  it('renders nothing for a board with no real cross-sections', () => {
    const g = guideLines(makeBoard([]), FACE, null);
    expect(g.sections).toEqual([]);
    expect(g.activeKey).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```sh
pnpm --filter @openshaper/render3d exec vitest run src/guide-lines.test.ts
```

Expected: FAIL — cannot resolve `./guide-lines`.

- [ ] **Step 3: Write the builder**

Create `packages/render3d/src/guide-lines.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  crossSectionRing,
  stringerLoop,
  tessellationSteps,
  type BezierBoard,
  type GuidePoint,
} from '@openshaper/kernel';

/** A polyline to draw over the hull, in board cm. */
export interface GuideLine {
  /** Stable React key. Rings key by station position so an insert does not remount the rest. */
  key: string;
  points: [number, number, number][];
}

export interface GuideLines {
  stringer: GuideLine | null;
  sections: GuideLine[];
  /** Key of the ring at `activeX`, or null when no station matches. */
  activeKey: string | null;
}

const toPoints = (ring: readonly GuidePoint[]): [number, number, number][] =>
  ring.map((v) => [v.x, v.y, v.z]);

/** Rings are loops but a polyline is not, so repeat the first point to close it. */
const closed = (pts: [number, number, number][]): [number, number, number][] =>
  pts.length > 1 ? [...pts, pts[0]!] : pts;

/**
 * Guide polylines for the 3D overlay.
 *
 * Rings are drawn only at REAL cross-sections — `crossSections.slice(1, -1)`, the
 * same slice the 2D panes mark — because index 0 and the last index are the
 * nose/tail dummies, which are degenerate and would render as dots.
 *
 * The kernel is immutable and swaps the board reference on every edit, so callers
 * can memoise on `board` and get correct results across added and deleted
 * stations for free.
 */
export function guideLines(
  board: BezierBoard,
  targetFaceSize: number,
  activeX: number | null,
): GuideLines {
  const { lengthSteps, ringSteps } = tessellationSteps(board, targetFaceSize);

  const loop = stringerLoop(board, lengthSteps, ringSteps);
  const stringer =
    loop && loop.length > 1 ? { key: 'stringer', points: closed(toPoints(loop)) } : null;

  const sections: GuideLine[] = [];
  let activeKey: string | null = null;
  for (const cs of board.crossSections.slice(1, -1)) {
    const ring = crossSectionRing(board, cs.position, ringSteps);
    // One degenerate station must not blank the whole overlay.
    if (!ring || ring.length < 3) continue;
    const key = `s${cs.position}`;
    sections.push({ key, points: closed(toPoints(ring)) });
    if (activeX !== null && Math.abs(cs.position - activeX) < 1e-6) activeKey = key;
  }

  return { stringer, sections, activeKey };
}
```

- [ ] **Step 4: Run the tests**

```sh
pnpm --filter @openshaper/render3d exec vitest run src/guide-lines.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Write the component**

Create `packages/render3d/src/Guides3D.tsx`:

```tsx
// SPDX-License-Identifier: GPL-3.0-or-later
import type { BezierBoard } from '@openshaper/kernel';
import { Line } from '@react-three/drei';
import { useEffect, useMemo, useState } from 'react';
import { boardCenter, tessellateAsync } from './geometry';
import { guideLines } from './guide-lines';

/** Amber centreline, red stations, brand cyan for the station being edited. */
const STRINGER_COLOR = '#F59E0B';
const SECTION_COLOR = '#EF4444';
const ACTIVE_COLOR = '#22D3EE';

/**
 * A depth bias, not a geometric one: the guides sit exactly on the surface, and
 * this pushes them toward the camera in the depth buffer only, so they win the
 * z-fight without being displaced off the hull.
 */
const OFFSET = {
  polygonOffset: true,
  polygonOffsetFactor: -4,
  polygonOffsetUnits: -4,
} as const;

/**
 * Reference lines drawn on the hull: the stringer plane's silhouette, and a ring
 * at every real cross-section with the active one highlighted.
 *
 * `meshToGeometry` centres the board mesh by its bounding box, so — exactly like
 * `Fins3D` — these are built in board coordinates and wrapped in a group carrying
 * the same offset.
 */
export function Guides3D({
  board,
  targetFaceSize,
  showStringer,
  showSections,
  activeSectionX,
}: {
  board: BezierBoard;
  targetFaceSize: number;
  showStringer: boolean;
  showSections: boolean;
  activeSectionX: number | null;
}) {
  const [offset, setOffset] = useState<[number, number, number] | null>(null);

  useEffect(() => {
    let cancelled = false;
    tessellateAsync(board, targetFaceSize)
      .then((mesh) => {
        if (cancelled) return;
        const c = boardCenter(mesh);
        setOffset([-c[0], -c[1], -c[2]]);
      })
      .catch(() => {
        /* keep the previous offset on failure */
      });
    return () => {
      cancelled = true;
    };
  }, [board, targetFaceSize]);

  // The kernel swaps `board` on every edit, so adding or deleting a
  // cross-section invalidates this automatically.
  const lines = useMemo(
    () => guideLines(board, targetFaceSize, activeSectionX),
    [board, targetFaceSize, activeSectionX],
  );

  if (!offset || (!showStringer && !showSections)) return null;

  return (
    <group position={offset}>
      {showStringer && lines.stringer && (
        <Line points={lines.stringer.points} color={STRINGER_COLOR} lineWidth={2} {...OFFSET} />
      )}
      {showSections &&
        lines.sections.map((s) => {
          const active = s.key === lines.activeKey;
          return (
            <Line
              key={s.key}
              points={s.points}
              color={active ? ACTIVE_COLOR : SECTION_COLOR}
              lineWidth={active ? 2.5 : 1.5}
              {...OFFSET}
            />
          );
        })}
    </group>
  );
}
```

- [ ] **Step 6: Export from the package index**

In `packages/render3d/src/index.ts`, add:

```ts
export { Guides3D } from './Guides3D';
export { guideLines, type GuideLine, type GuideLines } from './guide-lines';
```

- [ ] **Step 7: Typecheck and test**

```sh
pnpm --filter @openshaper/render3d typecheck && pnpm --filter @openshaper/render3d test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/render3d/src/guide-lines.ts packages/render3d/src/guide-lines.test.ts packages/render3d/src/Guides3D.tsx packages/render3d/src/index.ts
git commit -m "feat(render3d): stringer and cross-section guide overlays"
```

---

### Task 4: apps/web — extract `view3d-settings.ts`

**Why:** `view-state.ts` must validate persisted 3D settings against their allowed values. It cannot import them from `view-toolkit.tsx` without dragging React into a module whose tests are plain node. This task is a pure move — no behaviour changes yet.

**Files:**

- Create: `apps/web/src/view3d-settings.ts`
- Modify: `apps/web/src/view-toolkit.tsx`

**Interfaces:**

- Produces, all from `./view3d-settings`: `View3DSettings`, `MeshQuality`, `DEFAULT_VIEW_3D`, `faceSizeFor`, `MODE_3D`, `LIGHTING_3D`, `MATERIAL_3D`, `ANALYSIS_3D`, `QUALITY_3D`.

**Note:** `showSection` is _kept_ here and renamed in Task 6. Keeping the move and the rename separate means this task's diff is reviewable as a no-op.

- [ ] **Step 1: Create the module**

Create `apps/web/src/view3d-settings.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * 3D view settings: the type, its defaults, and the option lists the controls
 * render from.
 *
 * Deliberately free of React, so `view-state.ts` can sanitise a persisted blob
 * against these values without pulling the component tree into its tests.
 */
import type {
  AnalysisMode,
  Board3DMode,
  LightingPreset,
  MaterialPreset,
} from '@openshaper/render3d';

/** Viewport mesh density. Maps to a kernel target face size (cm) — smaller = finer. */
export type MeshQuality = 'draft' | 'standard' | 'fine';

export const MODE_3D: { value: Board3DMode; label: string }[] = [
  { value: 'shaded', label: 'Shaded' },
  { value: 'shaded-wire', label: '+Wire' },
  { value: 'wireframe', label: 'Wire' },
  { value: 'normals', label: 'Normals' },
];

export const LIGHTING_3D: { value: LightingPreset; label: string }[] = [
  { value: 'studio', label: 'Studio' },
  { value: 'shaping-bay', label: 'Shaping bay' },
  { value: 'neutral', label: 'Neutral' },
];

export const MATERIAL_3D: { value: MaterialPreset; label: string }[] = [
  { value: 'gloss', label: 'Glassed gloss' },
  { value: 'foam', label: 'Raw foam' },
  { value: 'matte', label: 'Matte' },
];

export const ANALYSIS_3D: { value: AnalysisMode; label: string }[] = [
  { value: 'none', label: 'No analysis' },
  { value: 'zebra', label: 'Zebra' },
  { value: 'curvature', label: 'Curvature' },
  { value: 'slope', label: 'Slope' },
];

export const QUALITY_3D: { value: MeshQuality; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'standard', label: 'Standard' },
  { value: 'fine', label: 'Fine' },
];

const FACE_SIZE: Record<MeshQuality, number> = {
  draft: 1.5,
  standard: 0.9,
  fine: 0.5,
};

/** Resolve a mesh-quality setting to a kernel target face size in cm. */
export const faceSizeFor = (q: MeshQuality): number => FACE_SIZE[q];

/** All 3D-view appearance + analysis settings, lifted so quad + full views share them. */
export interface View3DSettings {
  mode: Board3DMode;
  lighting: LightingPreset;
  material: MaterialPreset;
  color: string;
  analysis: AnalysisMode;
  meshQuality: MeshQuality;
  /** Highlight the active cross-section's location on the 3D mesh. */
  showSection: boolean;
}

export const DEFAULT_VIEW_3D: View3DSettings = {
  mode: 'shaded',
  lighting: 'studio',
  material: 'gloss',
  color: '#E8EEF5',
  analysis: 'none',
  meshQuality: 'standard',
  showSection: false,
};
```

- [ ] **Step 2: Strip the moved definitions from `view-toolkit.tsx`**

Delete from `apps/web/src/view-toolkit.tsx`:

- the `MODE_3D`, `LIGHTING_3D`, `MATERIAL_3D`, `ANALYSIS_3D`, `QUALITY_3D` consts,
- `export type MeshQuality = ...`,
- `const FACE_SIZE` and `export const faceSizeFor`,
- `export interface View3DSettings { ... }`,
- the now-unused `import type { AnalysisMode, Board3DMode, LightingPreset, MaterialPreset } from '@openshaper/render3d';`

Add near the other imports:

```ts
import {
  ANALYSIS_3D,
  LIGHTING_3D,
  MATERIAL_3D,
  MODE_3D,
  QUALITY_3D,
  type View3DSettings,
} from './view3d-settings';
```

And re-export, so existing importers of `view-toolkit` keep working:

```ts
export { faceSizeFor } from './view3d-settings';
export type { MeshQuality, View3DSettings } from './view3d-settings';
```

- [ ] **Step 3: Typecheck and test — this must be a behavioural no-op**

```sh
pnpm --filter @openshaper/web typecheck && pnpm --filter @openshaper/web test
```

Expected: PASS with no test changes. If something fails to resolve, a re-export is missing.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/view3d-settings.ts apps/web/src/view-toolkit.tsx
git commit -m "refactor(web): extract 3D view settings into a React-free module"
```

---

### Task 5: apps/web — `clampSectionIndex`

**Why:** Deleting the active station leaves `csIndex` pointing past the end. `App.tsx` re-derives a clamped value inline; extracting it makes the guarantee testable, which is the behaviour most at risk when stations are added and removed.

**Files:**

- Create: `apps/web/src/section-index.ts`, `apps/web/src/section-index.test.ts`

**Interfaces:**

- Produces: `export const clampSectionIndex: (csIndex: number, sectionCount: number) => number`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/section-index.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { clampSectionIndex } from './section-index';

// `sectionCount` counts ALL cross-sections, including the nose/tail dummies at
// index 0 and the last index. Real, selectable stations are 1..count-2.
describe('clampSectionIndex', () => {
  it('leaves a valid index alone', () => {
    expect(clampSectionIndex(2, 6)).toBe(2);
  });

  it('clamps down when the active station is deleted', () => {
    // 6 sections → real 1..4. Delete one: 5 sections → real 1..3.
    expect(clampSectionIndex(4, 5)).toBe(3);
  });

  it('never selects a nose/tail dummy', () => {
    expect(clampSectionIndex(0, 6)).toBe(1);
    expect(clampSectionIndex(-3, 6)).toBe(1);
  });

  it('degrades to 1 for a board with no real stations', () => {
    expect(clampSectionIndex(3, 2)).toBe(1);
    expect(clampSectionIndex(3, 0)).toBe(1);
  });

  it('is stable when a station is added', () => {
    expect(clampSectionIndex(3, 6)).toBe(3);
    expect(clampSectionIndex(3, 7)).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```sh
pnpm --filter @openshaper/web exec vitest run src/section-index.test.ts
```

Expected: FAIL — cannot resolve `./section-index`.

- [ ] **Step 3: Implement**

Create `apps/web/src/section-index.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Clamp a cross-section index to the board's real, selectable stations.
 *
 * Index 0 and the last index are the nose/tail dummies, so the selectable range
 * is 1..count-2. The active index is raw state that survives edits, and deleting
 * a station leaves it pointing past the end — deriving through this on every
 * render is what keeps the selection (and the 3D highlight) on a station that
 * exists.
 */
export const clampSectionIndex = (csIndex: number, sectionCount: number): number => {
  const lastReal = Math.max(1, sectionCount - 2);
  return Math.min(Math.max(csIndex, 1), lastReal);
};
```

- [ ] **Step 4: Run the tests**

```sh
pnpm --filter @openshaper/web exec vitest run src/section-index.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/section-index.ts apps/web/src/section-index.test.ts
git commit -m "refactor(web): extract clampSectionIndex with add/remove coverage"
```

---

### Task 6: Wire it up — two toggles replace the section plane

**Why:** This is the one task that must change props and their consumers together, or the build breaks between commits.

**Files:**

- Create: `apps/web/src/view-toolkit.test.tsx`
- Modify: `packages/render3d/src/Board3DView.tsx`, `apps/web/src/view3d-settings.ts`, `apps/web/src/view-toolkit.tsx`, `apps/web/src/App.tsx`

**Interfaces:**

- Consumes: `Guides3D` (Task 3), `View3DSettings`/`DEFAULT_VIEW_3D` (Task 4), `clampSectionIndex` (Task 5).
- Produces: `Board3DViewProps` loses `sectionX` and gains `showStringer?: boolean`, `showSections?: boolean`, `activeSectionX?: number | null`.

- [ ] **Step 1: Swap the settings fields**

In `apps/web/src/view3d-settings.ts`, replace:

```ts
/** Highlight the active cross-section's location on the 3D mesh. */
showSection: boolean;
```

with:

```ts
/** Draw the stringer plane's silhouette on the hull. */
showStringer: boolean;
/** Draw a ring at every real cross-section, the active one highlighted. */
showSections: boolean;
```

and in `DEFAULT_VIEW_3D` replace `showSection: false,` with:

```ts
  showStringer: false,
  showSections: false,
```

- [ ] **Step 2: Write the failing control test**

Create `apps/web/src/view-toolkit.test.tsx`:

```tsx
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Component tests for ThreeDControls' guide toggles.
 *
 * Covers:
 *  - Both toggles render, in the compact (quad mini-pane) variant too.
 *  - Clicking each one patches only its own field.
 *  - An enabled toggle looks different from a disabled one.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThreeDControls } from './view-toolkit';
import { DEFAULT_VIEW_3D } from './view3d-settings';

describe('ThreeDControls guide toggles', () => {
  it('renders both toggles', () => {
    render(<ThreeDControls settings={DEFAULT_VIEW_3D} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Stringer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sections' })).toBeTruthy();
  });

  it('renders both toggles in the compact quad-view variant', () => {
    render(<ThreeDControls settings={DEFAULT_VIEW_3D} onChange={vi.fn()} compact />);
    expect(screen.getByRole('button', { name: 'Stringer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sections' })).toBeTruthy();
  });

  it('patches only showStringer when Stringer is clicked', () => {
    const onChange = vi.fn();
    render(<ThreeDControls settings={DEFAULT_VIEW_3D} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stringer' }));
    expect(onChange).toHaveBeenCalledWith({ showStringer: true });
  });

  it('patches only showSections when Sections is clicked', () => {
    const onChange = vi.fn();
    render(<ThreeDControls settings={DEFAULT_VIEW_3D} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sections' }));
    expect(onChange).toHaveBeenCalledWith({ showSections: true });
  });

  it('turns a toggle back off', () => {
    const onChange = vi.fn();
    render(
      <ThreeDControls settings={{ ...DEFAULT_VIEW_3D, showSections: true }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sections' }));
    expect(onChange).toHaveBeenCalledWith({ showSections: false });
  });

  it('shows an enabled toggle as visually distinct from a disabled one', () => {
    const { rerender } = render(<ThreeDControls settings={DEFAULT_VIEW_3D} onChange={vi.fn()} />);
    const off = screen.getByRole('button', { name: 'Stringer' }).className;
    rerender(
      <ThreeDControls settings={{ ...DEFAULT_VIEW_3D, showStringer: true }} onChange={vi.fn()} />,
    );
    const on = screen.getByRole('button', { name: 'Stringer' }).className;
    expect(on).not.toBe(off);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```sh
pnpm --filter @openshaper/web exec vitest run src/view-toolkit.test.tsx
```

Expected: FAIL — there is no `Stringer` button yet.

- [ ] **Step 4: Replace the button in `ThreeDControls`**

In `apps/web/src/view-toolkit.tsx`, replace the single `Section` button:

```tsx
<Button
  size="sm"
  variant={settings.showSection ? 'secondary' : 'ghost'}
  onClick={() => set({ showSection: !settings.showSection })}
  title="Highlight the active cross-section's location on the mesh"
>
  Section
</Button>
```

with:

```tsx
<Button
  size="sm"
  variant={settings.showStringer ? 'secondary' : 'ghost'}
  onClick={() => set({ showStringer: !settings.showStringer })}
  title="Draw the stringer line down the centre of the board"
>
  Stringer
</Button>
<Button
  size="sm"
  variant={settings.showSections ? 'secondary' : 'ghost'}
  onClick={() => set({ showSections: !settings.showSections })}
  title="Draw a ring at every cross-section (the active one in cyan)"
>
  Sections
</Button>
```

Both stay outside the `!compact` branch, so the quad-view mini-pane gets them too.

- [ ] **Step 5: Replace `SectionPlane` with `Guides3D`**

In `packages/render3d/src/Board3DView.tsx`:

Delete the entire `SectionPlane` function and its doc comment (roughly lines 293-317).

Replace the top import block:

```ts
import {
  getLength,
  getMaxRocker,
  getMaxThickness,
  getMaxWidth,
  type BezierBoard,
} from '@openshaper/kernel';
```

with:

```ts
import type { BezierBoard } from '@openshaper/kernel';
```

Change the drei import from:

```ts
import { Edges, GizmoHelper, GizmoViewport, OrbitControls } from '@react-three/drei';
```

to:

```ts
import { GizmoHelper, GizmoViewport, OrbitControls } from '@react-three/drei';
```

Add below the `Fins3D` import:

```ts
import { Guides3D } from './Guides3D';
```

In `Board3DViewProps`, replace:

```ts
  /** Board-length position of the active cross-section to highlight on the mesh, or null. */
  sectionX?: number | null;
```

with:

```ts
  /** Draw the stringer plane's silhouette on the hull (defaults to false). */
  showStringer?: boolean;
  /** Draw a ring at every real cross-section (defaults to false). */
  showSections?: boolean;
  /** Board-length position of the active cross-section, drawn in cyan. */
  activeSectionX?: number | null;
```

In the `Board3DView` parameter list, replace `sectionX = null,` with:

```ts
  showStringer = false,
  showSections = false,
  activeSectionX = null,
```

And in the JSX, replace:

```tsx
{
  board && sectionX != null && <SectionPlane board={board} x={sectionX} />;
}
```

with:

```tsx
{
  board && (showStringer || showSections) && (
    <Guides3D
      board={board}
      targetFaceSize={targetFaceSize}
      showStringer={showStringer}
      showSections={showSections}
      activeSectionX={activeSectionX}
    />
  );
}
```

- [ ] **Step 6: Update `App.tsx` state and derivation**

In `apps/web/src/App.tsx`, add to the imports:

```ts
import { clampSectionIndex } from './section-index';
import { DEFAULT_VIEW_3D } from './view3d-settings';
```

Replace the `view3d` initialiser (around line 261):

```ts
const [view3d, setView3d] = useState<View3DSettings>({
  mode: 'shaded',
  lighting: 'studio',
  material: 'gloss',
  color: '#E8EEF5',
  analysis: 'none',
  meshQuality: 'standard',
  showSection: false,
});
```

with:

```ts
const [view3d, setView3d] = useState<View3DSettings>(DEFAULT_VIEW_3D);
```

Replace the clamp (around line 355):

```ts
const lastReal = Math.max(1, sectionCount - 2);
const clampedCs = Math.min(Math.max(csIndex, 1), lastReal);

// Active cross-section's length position, for the optional 3D mesh highlight.
const sectionX =
  view3d.showSection && board ? (board.crossSections[clampedCs]?.position ?? null) : null;
```

with:

```ts
const clampedCs = clampSectionIndex(csIndex, sectionCount);

// The active station's length position. Derived unconditionally — the toggle
// governs whether the guide is drawn, not whether the position is known.
const activeSectionX = board ? (board.crossSections[clampedCs]?.position ?? null) : null;
```

**Careful:** `lastReal` may be used elsewhere. Check first:

```bash
grep -n "lastReal" C:/Projects/Board_Studio/board-studio/apps/web/src/App.tsx
```

If any use remains after the replacement, keep the `const lastReal = Math.max(1, sectionCount - 2);` line alongside the new `clampedCs`.

- [ ] **Step 7: Update both `ThreeDPane` call sites**

In `App.tsx` there are two `<ThreeDPane ...>` blocks (around lines 985 and 1184). In **each**, replace:

```tsx
sectionX = { sectionX };
```

with:

```tsx
showStringer={view3d.showStringer}
showSections={view3d.showSections}
activeSectionX={activeSectionX}
```

Verify both were changed:

```bash
grep -c "activeSectionX={activeSectionX}" C:/Projects/Board_Studio/board-studio/apps/web/src/App.tsx
```

Expected: `2`

- [ ] **Step 8: Confirm nothing still references the old field**

```bash
grep -rn "showSection\b\|sectionX=" C:/Projects/Board_Studio/board-studio/apps/web/src C:/Projects/Board_Studio/board-studio/packages/render3d/src
```

Expected: no matches. (`showSections` and `activeSectionX` will not match `showSection\b`.)

- [ ] **Step 9: Typecheck and test everything**

```sh
pnpm typecheck && pnpm --filter @openshaper/web test && pnpm --filter @openshaper/render3d test
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/render3d/src/Board3DView.tsx apps/web/src/view3d-settings.ts apps/web/src/view-toolkit.tsx apps/web/src/view-toolkit.test.tsx apps/web/src/App.tsx
git commit -m "feat(web): replace the 3D section plane with stringer + section guides"
```

---

### Task 7: apps/web — persist the 3D settings

**Why:** All eight 3D settings reset on reload today. The new toggles are the ones a user will most notice resetting.

**Files:**

- Modify: `apps/web/src/view-state.ts`, `apps/web/src/view-state.test.ts`, `apps/web/src/App.tsx`

**Interfaces:**

- Consumes: `View3DSettings`, `DEFAULT_VIEW_3D`, the option lists (Tasks 4/6).
- Produces: `ViewState` gains `view3d?: View3DSettings`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/view-state.test.ts`, adding `import { DEFAULT_VIEW_3D } from './view3d-settings';`:

```ts
describe('view3d persistence', () => {
  it('round-trips the 3D settings', () => {
    const s: ViewState = {
      ...DEFAULT_VIEW_STATE,
      view3d: { ...DEFAULT_VIEW_3D, showStringer: true, showSections: true, meshQuality: 'fine' },
    };
    saveViewState(s);
    expect(loadViewState().view3d).toEqual(s.view3d);
  });

  it('falls back per field, leaving valid siblings intact', () => {
    saveViewState({
      ...DEFAULT_VIEW_STATE,
      view3d: { ...DEFAULT_VIEW_3D, showSections: true },
    });
    const raw = JSON.parse(localStorage.getItem('bs.viewState')!);
    raw.view3d.lighting = 'disco';
    raw.view3d.meshQuality = 42;
    raw.view3d.showStringer = 'yes';
    localStorage.setItem('bs.viewState', JSON.stringify(raw));

    const v = loadViewState().view3d!;
    expect(v.lighting).toBe(DEFAULT_VIEW_3D.lighting);
    expect(v.meshQuality).toBe(DEFAULT_VIEW_3D.meshQuality);
    expect(v.showStringer).toBe(DEFAULT_VIEW_3D.showStringer);
    expect(v.showSections).toBe(true); // the one good field survives
  });

  it('rejects a colour that is not a hex triplet', () => {
    saveViewState({ ...DEFAULT_VIEW_STATE, view3d: DEFAULT_VIEW_3D });
    const raw = JSON.parse(localStorage.getItem('bs.viewState')!);
    raw.view3d.color = 'javascript:alert(1)';
    localStorage.setItem('bs.viewState', JSON.stringify(raw));
    expect(loadViewState().view3d!.color).toBe(DEFAULT_VIEW_3D.color);
  });

  it('omits view3d entirely when the stored blob has none', () => {
    saveViewState(DEFAULT_VIEW_STATE);
    expect(loadViewState().view3d).toBeUndefined();
  });

  it('still restores an older blob written before view3d existed', () => {
    // The no-bump guarantee: adding an optional field must not orphan saved
    // camera poses and pane framing.
    localStorage.setItem(
      'bs.viewState',
      JSON.stringify({
        version: 1,
        view: 'outline',
        views2d: { outline: { cx: 1, cy: 2, scale: 3 } },
        camera3d: { position: [1, 2, 3], target: [0, 0, 0] },
      }),
    );
    const v = loadViewState();
    expect(v.view).toBe('outline');
    expect(v.views2d.outline).toEqual({ cx: 1, cy: 2, scale: 3 });
    expect(v.camera3d).toEqual({ position: [1, 2, 3], target: [0, 0, 0] });
    expect(v.view3d).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```sh
pnpm --filter @openshaper/web exec vitest run src/view-state.test.ts
```

Expected: FAIL — `view3d` is not a property of `ViewState`.

- [ ] **Step 3: Add the field and sanitiser**

In `apps/web/src/view-state.ts`, add to the imports:

```ts
import {
  ANALYSIS_3D,
  DEFAULT_VIEW_3D,
  LIGHTING_3D,
  MATERIAL_3D,
  MODE_3D,
  QUALITY_3D,
  type View3DSettings,
} from './view3d-settings';
```

Add to the `ViewState` interface, after `camera3d`:

```ts
  /** 3D appearance + analysis settings; absent on blobs written before they were saved. */
  view3d?: View3DSettings;
```

Add after `sanitizeCamera`:

```ts
const oneOf = <T extends string>(v: unknown, allowed: readonly { value: T }[], fallback: T): T =>
  allowed.some((o) => o.value === v) ? (v as T) : fallback;

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/**
 * Per-field sanitising: an unrecognised value falls back to that field's default
 * and leaves its siblings alone, matching the policy the 2D and camera
 * sanitisers follow. A colour must be a hex triplet — it reaches a DOM attribute.
 */
const sanitizeView3D = (v: unknown): View3DSettings | undefined => {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const d = DEFAULT_VIEW_3D;
  return {
    mode: oneOf(o.mode, MODE_3D, d.mode),
    lighting: oneOf(o.lighting, LIGHTING_3D, d.lighting),
    material: oneOf(o.material, MATERIAL_3D, d.material),
    color: typeof o.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color : d.color,
    analysis: oneOf(o.analysis, ANALYSIS_3D, d.analysis),
    meshQuality: oneOf(o.meshQuality, QUALITY_3D, d.meshQuality),
    showStringer: bool(o.showStringer, d.showStringer),
    showSections: bool(o.showSections, d.showSections),
  };
};
```

In `loadViewState`, after the `const camera3d = ...` line, add:

```ts
const view3d = sanitizeView3D(parsed.view3d);
```

and extend the returned object's tail from:

```ts
      ...(camera3d ? { camera3d } : {}),
```

to:

```ts
      ...(camera3d ? { camera3d } : {}),
      ...(view3d ? { view3d } : {}),
```

**Do not** change `VIEW_STATE_VERSION`. It stays `1`.

- [ ] **Step 4: Run the tests**

```sh
pnpm --filter @openshaper/web exec vitest run src/view-state.test.ts
```

Expected: PASS, including the pre-existing tests.

- [ ] **Step 5: Wire it into `App.tsx`**

Replace:

```ts
const [view3d, setView3d] = useState<View3DSettings>(DEFAULT_VIEW_3D);
```

with:

```ts
const [view3d, setView3d] = useState<View3DSettings>(
  bootViewState.current.view3d ?? DEFAULT_VIEW_3D,
);
```

This must sit _after_ `const bootViewState = useRef(loadViewState());` (around line 220) — it already does at line ~261, but verify.

Then add an effect next to the existing `view` persistence effect:

```ts
useEffect(() => {
  liveViewState.current = { ...liveViewState.current, view3d };
  scheduleViewSave();
}, [view3d, scheduleViewSave]);
```

- [ ] **Step 6: Typecheck and run the web suite**

```sh
pnpm --filter @openshaper/web typecheck && pnpm --filter @openshaper/web test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/view-state.ts apps/web/src/view-state.test.ts apps/web/src/App.tsx
git commit -m "feat(web): persist 3D view settings across reloads"
```

---

### Task 8: Docs and full verification

**Why:** `.claude/CLAUDE.md` requires user-facing features to be documented. The coverage test cannot enforce this one (there is no `FeatureKind` for view toggles, and inventing an id would trip the stale-entry assertion), so it is on us.

**Files:**

- Modify: `apps/web/src/pages/docs/Editing.tsx`

- [ ] **Step 1: Add the section**

In `apps/web/src/pages/docs/Editing.tsx`, add to the `toc` array, after the `views` entry:

```ts
        { id: 'guides', label: 'Guides in 3D' },
```

And insert this `Section` immediately after the closing `</Section>` of `id="views"`:

```tsx
<Section id="guides" title="Guides in 3D">
  <p>
    The 3D view can draw reference lines directly on the surface. Two buttons in the 3D controls
    toggle them independently.
  </p>
  <Terms>
    <Term name="Stringer">
      An amber line tracing the centreline: down the deck from nose to tail, and back along the
      bottom. Together they outline the stringer plane, so you are reading the rocker and the deck
      crown at the same time.
    </Term>
    <Term name="Sections">
      A red ring around the board at every cross-section, with the station you are currently editing
      drawn in cyan. Useful for judging whether your stations are spaced sensibly, and for seeing
      which one a change belongs to.
    </Term>
  </Terms>
  <p>
    The lines are computed from the same surface the mesh is built from, so they sit on the board
    rather than floating near it. Both toggles are remembered between sessions, along with the rest
    of the 3D appearance settings.
  </p>
</Section>
```

`Section`, `Term` and `Terms` are already imported by this file.

- [ ] **Step 2: Run the docs coverage test**

```sh
pnpm --filter @openshaper/web exec vitest run src/docs/coverage.test.ts
```

Expected: PASS. No `registry.ts` entry is added — doing so would fail the stale-entry assertion.

- [ ] **Step 3: Full verification sweep**

```sh
pnpm typecheck && pnpm --filter @openshaper/kernel test && pnpm --filter @openshaper/render3d test && pnpm --filter @openshaper/web test
```

Expected: PASS across all four.

Then confirm the constraint held for the whole feature:

```bash
git -C C:/Projects/Board_Studio/board-studio diff main --stat -- packages/kernel/src/tessellate.ts
```

Expected: **no output.** The tessellator was never touched.

**Note:** `apps/web` has 6 known pre-existing e2e failures on `main` (Playwright, not Vitest). Those are not run here and are unrelated. A failing _Vitest_ test is ours.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/docs/Editing.tsx
git commit -m "docs: describe the 3D stringer and section guides"
```

- [ ] **Step 5: Manual verification in the browser**

```sh
pnpm --filter @openshaper/web dev
```

Check each, and report results honestly rather than assuming:

1. Open the editor, switch to 3D. Toggle **Stringer** — an amber line runs down the deck centreline. Orbit underneath: it continues along the bottom.
2. Toggle **Sections** — a red ring appears at each station, exactly one of them cyan.
3. Page to another station (`,` / `.` — see `/docs/shortcuts`). The cyan ring follows.
4. Add a station (right-click in the rocker or outline view). A new red ring appears without a reload.
5. Delete the active station. The cyan ring moves to a station that still exists; nothing disappears or throws.
6. Zoom in close on a rail. The lines stay on the surface — no dashed z-fighting shimmer. **If shimmer appears**, raise `polygonOffsetFactor`/`polygonOffsetUnits` in `Guides3D.tsx` from `-4` toward `-8` and re-check.
7. Reload. Both toggles come back on, along with the mesh quality and lighting you left set.
8. Switch to the quad view. The 3D mini-pane shows the same guides and both toggle buttons.

---

## Known limitations (record, do not fix here)

- A ring drawn at a station inside a swallow/fish tail notch traces through the cut-away area, because `crossSectionRing` is not cutout-aware (only `stringerLoop` skips notched stations). Real stations that far aft are unusual, and making rings cutout-aware means reproducing `tessellateCutout`'s clipping — far more change than this feature warrants.
- The stringer loop stops a fraction of a millimetre short of each tip, where the interpolated section goes null. Invisible at any usable zoom.
