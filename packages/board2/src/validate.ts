// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `validateBoard`: the model invariants of a {@link BoardDoc} that do not need the
 * geometry (docs/design/board2.md §3.7, §3.8, §5.1, §5.2, §6.2), returning every
 * issue rather than the first.
 *
 * Step S1 added the structural and range part: the format tag and version,
 * symmetry and tail rules, the build parameters' ranges, the rail laws (keys,
 * tips, handles, symmetric domain, per-lane range certificate) and the bottom
 * features' parameters. Step S2 added the plan-loop invariants of §3.3 (tail at
 * the origin, the standard-tail certificate, the plan radius, bitwise pairing;
 * no corners; counter-clockwise; each half on its own side of the stringer, so
 * the loop is simple), the height fields' symmetric mode (§3.4) and
 * the domain check (the plan loop inside both height fields). Step S3 added
 * the checks that need the band's columns (§3.6, §4, §5.3; `bandChecks`): run
 * only on a document with no error so far, they build every column of the
 * station basis and report insets below `minInset` (`inset-invalid`), rail
 * heights below `minRailHeight` (`rail-height`), profiles with no convex half
 * (`rail-profile-invalid`), and inset loops that are not simple loops strictly
 * inside the plan loop and the height fields (`inset-loop-invalid`, geom's
 * certified trim checks). The offset layer's structure is checked before them
 * (`doc-malformed`). The band checks judge the columns of the station basis
 * only: a board that passes can still fail at a column `buildBand`'s
 * refinement inserts (S3 deviation 8). Step S4 added the bottom features'
 * geometric checks (`feature-invalid`: depth support inside the tuck loop's
 * x-range, zero at its ends, channels clear of the stringer) and their fit; the
 * band checks then run on the bottom with its features.
 *
 * It is pure and total: it never throws on a typed document, including one that
 * has not been through `reviveBoardDoc` (non-finite numbers are reported, not
 * evaluated).
 */
import { curvePoint, knotMultiplicities, periodicBasis, resolveTolerances } from '@openshaper/geom';
import type { PeriodicCurve, Tolerances } from '@openshaper/geom';
import { bandChecks, bandContext, geomIssue, insetPlanCurve } from './band/band';
import { stationBasis } from './band/stations';
import { bottomWithFeatures } from './features';
import { BOARD2_FORMAT, BOARD2_VERSION } from './doc';
import { causeOf, hasErrors, makeIssue } from './issues';
import { certifyLawRange, checkLawKeys } from './law';
import { laneRange, OFFSET_ROW_COMPONENTS, RAIL_LANES, validateBuildParams } from './params';
import {
  planCurve,
  planExtent,
  planMinRadius,
  planPieces,
  planSideViolation,
  planSignedArea,
  standardTailViolation,
  wrapUnit,
} from './plan';
import { checkHeightFieldSymmetry, checkPlanSymmetry } from './symmetry';
import type { Board2Issue, BoardDoc, BottomFeature, KeyedCurve } from './types';

const finite = (x: number): boolean => Number.isFinite(x);

function featureIssue(f: BottomFeature, message: string, value?: number): Board2Issue {
  return makeIssue('feature-invalid', `feature '${f.id}': ${message}`, {
    at: { feature: f.id },
    ...(value === undefined ? {} : { value }),
  });
}

function checkFeature(f: BottomFeature, out: Board2Issue[]): void {
  const curve: KeyedCurve = f.depth;
  // The depth keys are over x in cm; reuse the key checks and re-code them.
  for (const i of checkLawKeys(curve)) {
    out.push(
      makeIssue('feature-invalid', `feature '${f.id}': depth: ${i.message}`, {
        at: { feature: f.id, ...(i.at?.key === undefined ? {} : { key: i.at.key }) },
        ...(i.value === undefined ? {} : { value: i.value }),
      }),
    );
  }
  const frac = (name: string, x: number, lo: number, hi: number, loOpen: boolean): void => {
    if (!(finite(x) && (loOpen ? x > lo : x >= lo) && x <= hi)) {
      out.push(
        featureIssue(f, `${name} must be in ${loOpen ? '(' : '['}${lo}, ${hi}]; got ${x}`, x),
      );
    }
  };
  switch (f.kind) {
    case 'vee':
      // A blend half-width as a fraction of the tuck half-width h_t (§6.2).
      frac('stringerRadius', f.stringerRadius, 0, 1, true);
      break;
    case 'concave':
      frac('width', f.width, 0, 1, true);
      if (f.layout === 'single') {
        if (f.centre !== 0)
          out.push(
            featureIssue(
              f,
              `a single concave is centred; centre must be 0, got ${f.centre}`,
              f.centre,
            ),
          );
      } else {
        // Two bumps at ±centre: separate from each other and inside the tuck (η = ±1).
        frac('centre', f.centre, 0, 1, true);
        if (
          finite(f.centre) &&
          finite(f.width) &&
          !(f.centre >= f.width && f.centre + f.width <= 1)
        ) {
          out.push(
            featureIssue(
              f,
              `a double concave's bumps must not overlap (centre >= width) or reach the tuck (centre + width <= 1); centre ${f.centre}, width ${f.width}`,
            ),
          );
        }
      }
      break;
    case 'channels':
      if (!(Number.isInteger(f.count) && f.count >= 1)) {
        out.push(featureIssue(f, `count must be an integer >= 1; got ${f.count}`, f.count));
      }
      for (const name of ['width', 'pitch'] as const) {
        if (!(finite(f[name]) && f[name] > 0))
          out.push(featureIssue(f, `${name} must be > 0; got ${f[name]}`, f[name]));
      }
      if (!(finite(f.railInset) && f.railInset >= 0)) {
        out.push(featureIssue(f, `railInset must be >= 0; got ${f.railInset}`, f.railInset));
      }
      // Channels of width w at pitch p must not run into each other.
      if (finite(f.width) && finite(f.pitch) && f.pitch < f.width) {
        out.push(
          featureIssue(
            f,
            `pitch (${f.pitch}) must be at least the channel width (${f.width})`,
            f.pitch,
          ),
        );
      }
      break;
  }
}

/**
 * The model invariants of a document (module comment). Empty for a valid
 * document; warnings (a feature fit that missed `featureTol`) do not make it
 * invalid.
 */
export function validateBoard(doc: BoardDoc): readonly Board2Issue[] {
  const out = [...validateDocument(doc)];
  // The features and the band's columns need a sound plan, surfaces, laws, offsets and parameters.
  if (!hasErrors(out)) out.push(...geometryChecks(doc));
  return out;
}

/**
 * Stages 4–8 as checks (step S4): the tuck plan curve on the station basis, the
 * bottom features against it and fitted (`feature-invalid`, a `not-converged`
 * warning on a missed `featureTol`), then the band's columns on the bottom
 * with its features (`bandChecks`). Never throws.
 */
function geometryChecks(doc: BoardDoc): readonly Board2Issue[] {
  try {
    const ctx = bandContext(doc);
    const b = stationBasis(ctx.plan, ctx.arc, doc.build, ctx.symmetric, ctx.tol);
    const fb = bottomWithFeatures(doc, ctx.bottom, insetPlanCurve(ctx, b, 'tuck'), ctx.tol);
    if (fb.value === null) return fb.issues;
    return [...fb.issues, ...bandChecks(doc, fb.value.surface)];
  } catch (e) {
    return [geomIssue(e, 'geometry checks')];
  }
}

/**
 * Every check of {@link validateBoard} but the geometric ones of stages 4–8
 * (features and band columns), which `buildBoard` reports itself as it builds
 * them. Internal.
 */
export function validateDocument(doc: BoardDoc): readonly Board2Issue[] {
  const out: Board2Issue[] = [];
  if (doc.format !== BOARD2_FORMAT) {
    out.push(
      makeIssue('doc-malformed', `format must be '${BOARD2_FORMAT}'; got '${String(doc.format)}'`),
    );
  }
  if (doc.version !== BOARD2_VERSION) {
    out.push(
      makeIssue('doc-version', `unsupported version ${String(doc.version)}`, {
        value: Number(doc.version),
      }),
    );
  }
  // §3.7: 'none' is Phase 6; no half-tested path ships.
  if (doc.symmetry !== 'mirror-y') {
    out.push(
      makeIssue(
        'asymmetric-unsupported',
        `symmetry '${String(doc.symmetry)}' is not supported yet; use 'mirror-y'`,
      ),
    );
  }
  if (doc.tail.kind !== 'standard') {
    out.push(
      makeIssue(
        'tail-not-standard',
        `tail.kind '${String(doc.tail.kind)}' is not supported yet; use 'standard'`,
      ),
    );
  }
  out.push(...validateBuildParams(doc.build));

  for (const lane of RAIL_LANES) {
    const law = doc.laws[lane];
    const ctx = { lane };
    if (doc.symmetry === 'mirror-y' && law.domain !== 'half') {
      out.push(
        makeIssue(
          'symmetry-broken',
          `lane '${lane}': a symmetric board needs a half-domain law; this one is '${law.domain}'`,
          {
            at: { lane },
          },
        ),
      );
    }
    const keyIssues = checkLawKeys(law, ctx, doc.build.tolerances);
    out.push(...keyIssues);
    // The range certificate needs usable keys, and a lane range that is itself valid.
    if (keyIssues.length === 0) {
      const [lo, hi] = laneRange(lane, doc.build);
      if (finite(lo) && lo <= hi) out.push(...certifyLawRange(law, lo, hi, ctx));
    }
  }

  const ids = new Set<string>();
  for (const f of doc.features) {
    if (ids.has(f.id)) out.push(featureIssue(f, 'id is used by more than one feature'));
    ids.add(f.id);
    checkFeature(f, out);
  }

  const tol = usableTolerances(doc);
  checkPlan(doc, tol, out);
  if (doc.symmetry === 'mirror-y') {
    out.push(...checkHeightFieldSymmetry(doc.deck, 'deck', tol));
    out.push(...checkHeightFieldSymmetry(doc.bottom, 'bottom', tol));
  }
  checkOffsets(doc, tol, out);
  return out;
}

/**
 * The offset layer's structure (§6.1, §11 `OffsetField`), as `reviveBoardDoc`
 * checks it, for a typed document that has not been revived: a basis geom
 * accepts (or `null` with no rows), each row named once with one value group
 * per basis function in its component count, every value finite.
 * `doc-malformed`, located by row; the band checks need all of it.
 */
function checkOffsets(doc: BoardDoc, tol: Tolerances, out: Board2Issue[]): void {
  const layer = doc.offsets;
  const malformed = (message: string, extras: Parameters<typeof makeIssue>[2] = {}): void => {
    out.push(makeIssue('doc-malformed', `offsets: ${message}`, extras));
  };
  let count: number | null = null;
  if (layer.basis === null) {
    if (layer.rows.length > 0) malformed('rows must be empty when basis is null');
    return;
  }
  try {
    count = periodicBasis(layer.basis.degree, layer.basis.knots, 1, tol).count;
  } catch (e) {
    const cause = causeOf(e);
    malformed(`basis: ${e instanceof Error ? e.message : String(e)}`, {
      ...(cause === undefined ? {} : { cause }),
    });
  }
  const seen = new Set<string>();
  for (const f of layer.rows) {
    if (!Object.hasOwn(OFFSET_ROW_COMPONENTS, f.row)) {
      malformed(`unknown row '${String(f.row)}'`);
      continue;
    }
    const at = { at: { row: f.row } };
    if (seen.has(f.row)) malformed(`row '${f.row}' appears twice`, at);
    seen.add(f.row);
    const dim = OFFSET_ROW_COMPONENTS[f.row].length;
    if (count !== null && f.values.length !== count * dim) {
      malformed(
        `row '${f.row}' needs ${count} × ${dim} = ${count * dim} values; got ${f.values.length}`,
        { ...at, value: f.values.length },
      );
    }
    const bad = f.values.findIndex((v) => !finite(v));
    if (bad >= 0) malformed(`row '${f.row}' value ${bad} is not finite`, at);
  }
}

/** The document's geom tolerances, or geom's defaults when the record is unusable (reported elsewhere). */
function usableTolerances(doc: BoardDoc): Tolerances {
  try {
    return resolveTolerances(doc.build.tolerances);
  } catch {
    return resolveTolerances();
  }
}

/**
 * The plan-loop invariants of §3.3 (1–4), the Phase 2 refusal of corners and
 * of a clockwise loop (decisions 3, 4), and the domain check.
 */
function checkPlan(doc: BoardDoc, tol: Tolerances, out: Board2Issue[]): void {
  let curve: PeriodicCurve<2>;
  try {
    curve = planCurve(doc.plan, tol);
  } catch (e) {
    // A revived document always builds; a hand-typed one may not.
    const cause = causeOf(e);
    out.push(
      makeIssue('doc-malformed', `plan: ${e instanceof Error ? e.message : String(e)}`, {
        ...(cause === undefined ? {} : { cause }),
      }),
    );
    return;
  }

  // Decision 4: the Phase 2 plan is C² (simple knots); full multiplicity is a corner (Phase 5).
  const { values, mults } = knotMultiplicities(curve.basis);
  for (let k = 0; k < values.length; k++) {
    if (mults[k]! > 1) {
      const corner = mults[k]! >= curve.basis.degree;
      out.push(
        makeIssue(
          'plan-corner',
          corner
            ? `plan: a knot of full multiplicity (a corner) is not supported yet`
            : `plan: a repeated knot (multiplicity ${mults[k]}) breaks the C² plan loop`,
          { at: { u: wrapUnit(values[k]!) }, value: mults[k]! },
        ),
      );
    }
  }

  // Invariant 1: the tail centre is at the origin.
  const p0 = curvePoint(curve, 0);
  const off = Math.hypot(p0.x, p0.y);
  if (!(off <= tol.point)) {
    out.push(
      makeIssue(
        'tail-not-at-origin',
        `plan(0) must be (0, 0) within ${tol.point}; it is (${p0.x}, ${p0.y})`,
        { at: { u: 0 }, value: off },
      ),
    );
  }

  const pieces = planPieces(curve, tol);
  // Decision 3: counter-clockwise seen from +z, so u ∈ (0, ½) is the −y side.
  const area = planSignedArea(pieces);
  if (!(area > 0)) {
    out.push(
      makeIssue(
        'doc-malformed',
        `plan: the loop must run counter-clockwise seen from +z (signed area ${area})`,
        { value: area },
      ),
    );
  }

  // Invariant 2: each half of the loop is a graph over x (§3.8).
  let graphs = false;
  if (doc.tail.kind === 'standard') {
    const u = standardTailViolation(pieces, tol);
    graphs = u === null;
    if (u !== null) {
      out.push(
        makeIssue(
          'tail-not-standard',
          `plan: x′ must be > 0 on (0, ½) and < 0 on (½, 1); it changes sign at u = ${u}`,
          { at: { u } },
        ),
      );
    }
  }

  // §3.2: u ∈ (0, ½) is the −y side. With the halves graphs over x, this makes the
  // loop simple (no figure 8). Judged only on a counter-clockwise loop of two
  // graphs, so a clockwise or non-standard loop is not reported twice.
  if (doc.symmetry === 'mirror-y' && graphs && area > 0) {
    const u = planSideViolation(pieces, tol);
    if (u !== null) {
      out.push(
        makeIssue(
          'doc-malformed',
          `plan: the loop must keep y < 0 on (0, ½) and y > 0 on (½, 1) (a simple outline, §3.2); it crosses the stringer near u = ${u}`,
          { at: { u } },
        ),
      );
    }
  }

  // Invariant 3: the plan can host the minimum band (§4). Needs usable parameters.
  const { minInset, insetCurvatureFraction: kappa } = doc.build;
  if (minInset > 0 && Number.isFinite(minInset) && kappa > 0 && kappa < 1) {
    const limit = minInset / kappa;
    const r = planMinRadius(pieces);
    if (!(r.radius >= limit)) {
      out.push(
        makeIssue(
          'plan-radius',
          `plan: radius of curvature ${r.radius} at u = ${r.u} is below minInset / insetCurvatureFraction = ${limit}`,
          { at: { u: r.u }, value: r.radius },
        ),
      );
    }
  }

  // Invariant 4: symmetric pairing, bitwise.
  if (doc.symmetry === 'mirror-y') out.push(...checkPlanSymmetry(curve, tol));

  // The loop must lie inside both height fields' domains (§3.4, §3.6).
  const ext = planExtent(pieces);
  for (const face of ['deck', 'bottom'] as const) {
    const hf = doc[face];
    if (
      !(ext.xMin >= hf.x[0] && ext.xMax <= hf.x[1] && ext.yMin >= hf.y[0] && ext.yMax <= hf.y[1])
    ) {
      out.push(
        makeIssue(
          'domain-too-small',
          `${face}: the extent x [${hf.x[0]}, ${hf.x[1]}], y [${hf.y[0]}, ${hf.y[1]}] does not contain the plan loop (x [${ext.xMin}, ${ext.xMax}], y [${ext.yMin}, ${ext.yMax}])`,
          { at: { face } },
        ),
      );
    }
  }
}
