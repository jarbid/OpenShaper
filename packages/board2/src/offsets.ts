// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The offset layer (docs/design/board2.md §6.1, decision 19): per-row periodic
 * spline fields over σ (period 1, one basis shared by every field), in the
 * **rail-local frame**, with only the components each row's structural rule
 * allows ({@link OFFSET_ROW_COMPONENTS}):
 *
 * | Row          | Components | Applied as                                              |
 * | ------------ | ---------- | ------------------------------------------------------- |
 * | `deckEdge`   | `n`        | added to the deck inset (moves the deck edge in plan)   |
 * | `deckHandle` | `l`        | row 1 moved along `τ̂_d`, the unit deck tangent          |
 * | `apexUpper`  | `z`        | row 2 moved along +ẑ                                    |
 * | `apexLower`  | `z`        | row 4 moved along +ẑ                                    |
 * | `tuckHandle` | `n`, `z`   | row 5 moved by `n · n̂ + z · ẑ`                          |
 * | `tuck`       | `n`        | added to the tuck inset                                 |
 *
 * Every component is a displacement along a frame vector (`n` along the inward
 * plan normal n̂, `z` along +ẑ, `l` along τ̂_d), so a positive `apexLower` value
 * shortens the lower apex handle and a positive `n` on an edge row moves it
 * inwards (a larger inset). The apex row has no offset (it moves only with the
 * outline and the apex-height law), and none of these moves can break the
 * apex's vertical handles, the deck join's tangent direction or the outline.
 *
 * A field is evaluated at each band column's σ and applied in that column's
 * frame, so a later law change, refinement or outline edit re-applies it in the
 * new geometry. The empty layer (`basis: null`) and absent rows apply nothing
 * (the identity, bitwise).
 */
import { createScratch, curveEvalInto, makeCurve, periodicBasis } from '@openshaper/geom';
import type { NurbsCurve, Tolerances } from '@openshaper/geom';
import { OFFSET_ROW_COMPONENTS } from './params';
import type { OffsetLayer, OffsetRow } from './types';

/** The offset of every component at one σ (0 where the layer has no field). */
export interface OffsetValues {
  /** Deck-inset tweak, cm (inwards positive). */
  readonly deckEdgeN: number;
  /** Deck-handle length tweak along τ̂_d, cm. */
  readonly deckHandleL: number;
  /** Vertical moves of the apex handles, cm (+ẑ positive). */
  readonly apexUpperZ: number;
  readonly apexLowerZ: number;
  /** Tuck-handle move in the station plane, cm. */
  readonly tuckHandleN: number;
  readonly tuckHandleZ: number;
  /** Tuck-inset tweak, cm. */
  readonly tuckN: number;
}

/** The identity offset. */
export const ZERO_OFFSETS: OffsetValues = Object.freeze({
  deckEdgeN: 0,
  deckHandleL: 0,
  apexUpperZ: 0,
  apexLowerZ: 0,
  tuckHandleN: 0,
  tuckHandleZ: 0,
  tuckN: 0,
});

/** Evaluates a layer at σ; `null` when the layer is empty (nothing to apply). */
export type OffsetEvaluator = ((sigma: number) => OffsetValues) | null;

/**
 * The evaluator of an offset layer. Each field becomes a periodic spline curve
 * of dimension = its component count over the layer's basis (values grouped
 * per basis function in the row's component order, §11 `OffsetField`), so
 * evaluation is geom's. Throws geom's error on a basis geom refuses and
 * `RangeError` on a field of the wrong size (a revived document has neither).
 */
export function offsetEvaluator(layer: OffsetLayer, tol?: Partial<Tolerances>): OffsetEvaluator {
  if (layer.basis === null || layer.rows.length === 0) return null;
  const basis = periodicBasis(layer.basis.degree, layer.basis.knots, 1, tol);
  const fields = new Map<OffsetRow, NurbsCurve>();
  for (const f of layer.rows) {
    const dim = OFFSET_ROW_COMPONENTS[f.row].length as 1 | 2;
    if (f.values.length !== basis.count * dim) {
      throw new RangeError(
        `offset field '${f.row}' needs ${basis.count * dim} values; got ${f.values.length}`,
      );
    }
    fields.set(f.row, makeCurve({ dim, basis, points: f.values }));
  }
  const t0 = basis.domain[0];
  const out = new Float64Array(2);
  const sc = createScratch({ maxDegree: basis.degree, maxDerivs: 0 });
  const at = (row: OffsetRow, s: number, k: number): number => {
    const c = fields.get(row);
    if (c === undefined) return 0;
    curveEvalInto(c, s, 0, out, 0, sc);
    return out[k]!;
  };
  return (sigma: number): OffsetValues => {
    // σ in the basis's own period [t0, t0 + 1).
    let s = sigma - Math.floor(sigma - t0);
    if (s >= t0 + 1) s -= 1;
    return Object.freeze({
      deckEdgeN: at('deckEdge', s, 0),
      deckHandleL: at('deckHandle', s, 0),
      apexUpperZ: at('apexUpper', s, 0),
      apexLowerZ: at('apexLower', s, 0),
      tuckHandleN: at('tuckHandle', s, 0),
      tuckHandleZ: at('tuckHandle', s, 1),
      tuckN: at('tuck', s, 0),
    });
  };
}
