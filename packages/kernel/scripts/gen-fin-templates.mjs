// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Generate `packages/kernel/src/fin-templates.generated.ts` from the curated FinFoil
 * (https://finfoil.io) reference outlines in `docs/specs/fins/*.foil`.
 *
 * A `.foil` file stores the blade outline as an OPEN cubic-bézier chain (mm, y negative
 * = depth downward): it starts at the leading-edge root `M(0,0)`, sweeps up the leading
 * edge to the tip, then back down the trailing edge to the trailing-edge root. We flatten
 * each bézier, then map into the kernel's normalized template space used by `finTemplate`:
 *   x: 0 = trailing-edge root → 1 = leading-edge root  (x can go < 0 for a raked tip)
 *   y: 0 = root → 1 = tip
 * The implicit base edge (trailing root → leading root, along y = 0) closes the polygon.
 *
 * Run:  node packages/kernel/scripts/gen-fin-templates.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const specDir = resolve(here, '../../../docs/specs/fins');
const outFile = resolve(here, '../src/fin-templates.generated.ts');

/** FinProfile name → source .foil. center/quad_back reuse `side`; single_fin reuses single. */
const SOURCES = {
  single: 'single.foil',
  noserider: 'noserider.foil',
  keel: 'keel.foil',
  thruster: 'side.foil',
};

const SAMPLES_PER_SEGMENT = 16;

/** Flatten one cubic bézier (p0..p3) into points for t in (0, 1]. */
function cubic(p0, p1, p2, p3, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push([
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    ]);
  }
  return out;
}

/** Read a .foil outline path into a flattened list of absolute [x, y] points (mm). */
function flattenOutline(file) {
  const doc = JSON.parse(readFileSync(resolve(specDir, file), 'utf8'));
  const cmds = doc.foil.outline.path.path;
  const pts = [];
  let cur = [0, 0];
  for (const cmd of cmds) {
    const [op] = cmd;
    if (op === 'M') {
      cur = [cmd[1], cmd[2]];
      pts.push(cur);
    } else if (op === 'C') {
      const p1 = [cmd[1], cmd[2]];
      const p2 = [cmd[3], cmd[4]];
      const p3 = [cmd[5], cmd[6]];
      for (const p of cubic(cur, p1, p2, p3, SAMPLES_PER_SEGMENT)) pts.push(p);
      cur = p3;
    } else {
      throw new Error(`Unsupported path op '${op}' in ${file}`);
    }
  }
  return pts;
}

/**
 * Map an absolute mm outline → normalized kernel template points, scaling BOTH axes by
 * the SAME factor (1 / maxDepth) so each fin keeps its true aspect ratio — the `.foil`
 * files are drawn to scale, so the proportions are what matter. Every template is sized
 * to depth = 1 ("the same size"); its real width survives as the root-chord fraction.
 *   x: 0 = trailing-edge root, +x toward the leading edge, x < 0 = raked tip past the
 *      trailing root. The leading root lands at x = chordFrac (= root chord / depth).
 *   y: 0 = root → 1 = tip.
 */
function normalize(pts) {
  const trailRootX = pts[pts.length - 1][0]; // last point = trailing-edge root
  let maxDepth = 0;
  for (const [, y] of pts) maxDepth = Math.max(maxDepth, -y);
  if (maxDepth <= 0) maxDepth = 1;
  const s = 1 / maxDepth; // uniform scale — preserves aspect ratio
  const points = pts.map(([x, y]) => [round((trailRootX - x) * s), round(-y * s)]);
  const chordFrac = round(trailRootX * s); // leading-root x = root chord / depth
  return { points, chordFrac };
}

const round = (n) => Math.round(n * 1e4) / 1e4;

const entries = Object.entries(SOURCES).map(([name, file]) => [name, normalize(flattenOutline(file))]);

const body = entries
  .map(([name, { points }]) => {
    const rows = points.map(([x, y]) => `    vec2(${x}, ${y}),`).join('\n');
    return `  ${name}: [\n${rows}\n  ],`;
  })
  .join('\n');

const chords = entries.map(([name, { chordFrac }]) => `  ${name}: ${chordFrac},`).join('\n');

const ts = `// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * GENERATED FILE — do not edit by hand.
 * Source: docs/specs/fins/*.foil (FinFoil reference outlines, https://finfoil.io).
 * Regenerate: node packages/kernel/scripts/gen-fin-templates.mjs
 *
 * Blade silhouettes in aspect-true template space (uniformly scaled so depth = 1): x = 0
 * at the trailing-edge root, +x toward the leading edge (x < 0 = raked tip), y: 0 root →
 * 1 tip. The leading-edge root sits at x = FIN_TEMPLATE_CHORD (root chord ÷ depth), which
 * preserves each fin's true width-to-height proportion. Consumed by finTemplate().
 */
import { vec2, type Vec2 } from './vec2';
import type { FinProfile } from './fins';

export const FIN_TEMPLATES: Record<FinProfile, readonly Vec2[]> = {
${body}
};

/** Root chord ÷ depth for each template (its undistorted base-to-depth aspect ratio). */
export const FIN_TEMPLATE_CHORD: Record<FinProfile, number> = {
${chords}
};
`;

writeFileSync(outFile, ts);
console.log(`Wrote ${outFile}`);
for (const [name, { points, chordFrac }] of entries) {
  console.log(`  ${name}: ${points.length} points, chordFrac ${chordFrac}`);
}
