// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The DOF map `x = T z + x_fixed` (design §6.13, §10.3, decision 19):
 * structural constraints eliminated exactly, so they never enter the KKT
 * system and hold by construction for every solve.
 *
 * `x` holds the Euclidean control coordinates **interleaved**,
 * `x[i·dim + c]` (`dim` = 3 for surfaces, the curve's dimension for curves);
 * `z` the free unknowns. `x_fixed` is the configuration at `z = 0`: the
 * target's control points made consistent with the rules (a fixed coordinate
 * keeps its value; a slide or offset starts at `s = 0`; a mirrored or copied
 * point starts at the image of its master). So an edit's zero move returns the
 * target itself whenever the target already satisfies the rules.
 *
 * Rules (each claims coordinates of one control point `cp`; a coordinate
 * claimed twice throws `conflicting-dof-rules`):
 *
 * - `fix`: all coordinates fixed at the target's values.
 * - `fixAxes`: the coordinates in the bitmask (x = 1, y = 2, z = 4) fixed;
 *   the others free.
 * - `slide`: `cp = ref + Σ s_k d_k` (one unknown per direction).
 * - `offsetFrom`: `cp − master = (ref_cp − ref_master) + Σ s_k d_k`: the
 *   offset from the master stays what it was, plus motion along `dirs`.
 * - `mirror`: `cp` is the reflection of `master` in the plane
 *   `normal · x = d` (the normal need not be unit).
 * - `copy`: `cp = master + offset` (default offset 0).
 *
 * Masters may themselves be ruled (chains compose); a cycle throws
 * `conflicting-dof-rules`. A point with no rule is free. Directions and
 * normals are `Point3`; a 2D curve reads `x, y`, a 1D curve `x`.
 *
 * Exactness (§10.3): `fix`, `fixAxes`, `copy` with no offset and `mirror` in
 * a coordinate plane hold with `===` on the solver's Euclidean output (the
 * solver applies those rules last, from the master's final coordinates);
 * `slide`, `offsetFrom`, offset copies and general mirrors hold to the
 * rounding of `T z`. The returned net is homogeneous, so a control point
 * reads back as `(w·v)/w`: `fix` and `fixAxes` coordinates keep the
 * target's stored values and stay bitwise; a copied coordinate (a copy, or
 * the in-plane coordinates of a coordinate-plane mirror) reads back `===`
 * when the two points' weights are equal, the reflected coordinate when both
 * weights are 1 (always, on polynomial geometry); otherwise each read-back
 * is within the rounding of `w·v` and `/w` (≤ ε relative).
 */
import { fail } from '../errors';
import type { NurbsCurve, NurbsSurface, Point3, ReadonlyF64, ReadonlyI32 } from '../types';
import { euclidean } from './fairness';

export type DofRule =
  | { readonly kind: 'fix'; readonly cp: number }
  | { readonly kind: 'fixAxes'; readonly cp: number; readonly axes: number }
  | { readonly kind: 'slide'; readonly cp: number; readonly dirs: readonly Point3[] }
  | {
      readonly kind: 'offsetFrom';
      readonly cp: number;
      readonly master: number;
      readonly dirs: readonly Point3[];
    }
  | {
      readonly kind: 'mirror';
      readonly cp: number;
      readonly master: number;
      readonly plane: { readonly normal: Point3; readonly d: number };
    }
  | {
      readonly kind: 'copy';
      readonly cp: number;
      readonly master: number;
      readonly offset?: Point3;
    };

export interface DofMap {
  readonly cpCount: number;
  /** Coordinates per control point (3 for surfaces). */
  readonly dim: number;
  readonly dofCount: number;
  /** Every column of `T` acts on one coordinate axis only (`T` is block-diagonal by axis). */
  readonly separable: boolean;
  /** `T` in CSR, `dim · cpCount` rows (row `i·dim + c`), `dofCount` columns. */
  readonly rowPtr: ReadonlyI32;
  readonly col: ReadonlyI32;
  readonly val: ReadonlyF64;
  /** `x` at `z = 0`, interleaved. */
  readonly fixed: ReadonlyF64;
  /** The validated rules (deep, frozen copies), in the caller's order. */
  readonly rules: readonly DofRule[];
}

/** A sparse row `Σ coef_k z_k + c`. */
interface Row {
  readonly dof: number[];
  readonly coef: number[];
  c: number;
}

function isSurface(g: NurbsCurve | NurbsSurface): g is NurbsSurface {
  return (g as NurbsSurface).u !== undefined;
}

function vecOf(p: Point3, dim: number, what: string, k: number): number[] {
  if (typeof p !== 'object' || p === null)
    fail('unsupported', `rule ${k}: ${what} is not a point`, { index: k });
  const v = [p.x, p.y, p.z].slice(0, dim);
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      fail('non-finite', `rule ${k}: ${what} is not finite`, { index: k });
    }
  }
  return v;
}

function checkIndex(i: number, n: number, what: string, k: number): void {
  if (!Number.isInteger(i) || i < 0 || i >= n) {
    fail('size-mismatch', `rule ${k}: ${what} ${i} is not a control point index in [0, ${n})`, {
      index: k,
      value: i,
    });
  }
}

/** Validated rule: directions/normals as arrays of length `dim`. */
interface Rule {
  readonly k: number;
  readonly kind: DofRule['kind'];
  readonly cp: number;
  readonly master: number;
  readonly axes: number;
  readonly dirs: number[][];
  /** mirror: unit normal and offset `n̂·x = d̂`; copy: offset. */
  readonly vec: number[];
  readonly d: number;
}

function validate(rules: readonly DofRule[], n: number, dim: number): Rule[] {
  if (!Array.isArray(rules)) fail('unsupported', 'rules must be an array');
  return rules.map((r, k): Rule => {
    if (typeof r !== 'object' || r === null)
      fail('unsupported', `rule ${k} is not an object`, { index: k });
    checkIndex(r.cp, n, 'cp', k);
    const base = {
      k,
      kind: r.kind,
      cp: r.cp,
      master: -1,
      axes: 0,
      dirs: [] as number[][],
      vec: [] as number[],
      d: 0,
    };
    const dirsOf = (ds: readonly Point3[]): number[][] => {
      if (!Array.isArray(ds) || ds.length < 1 || ds.length > dim) {
        fail('unsupported', `rule ${k}: dirs must hold 1 to ${dim} directions`, { index: k });
      }
      return ds.map((p, j) => {
        const v = vecOf(p, dim, `direction ${j}`, k);
        if (!v.some((x) => x !== 0))
          fail('unsupported', `rule ${k}: direction ${j} is zero`, { index: k });
        return v;
      });
    };
    switch (r.kind) {
      case 'fix':
        return { ...base, axes: (1 << dim) - 1 };
      case 'fixAxes':
        if (!Number.isInteger(r.axes) || r.axes < 1 || r.axes >= 1 << dim) {
          fail(
            'unsupported',
            `rule ${k}: axes must be a bitmask in 1…${(1 << dim) - 1}; got ${r.axes}`,
            {
              index: k,
            },
          );
        }
        return { ...base, axes: r.axes };
      case 'slide':
        return { ...base, dirs: dirsOf(r.dirs) };
      case 'offsetFrom':
        checkIndex(r.master, n, 'master', k);
        return { ...base, master: r.master, dirs: dirsOf(r.dirs) };
      case 'mirror': {
        checkIndex(r.master, n, 'master', k);
        const nv = vecOf(r.plane?.normal, dim, 'plane normal', k);
        const d = r.plane.d;
        if (typeof d !== 'number' || !Number.isFinite(d))
          fail('non-finite', `rule ${k}: plane d is not finite`, { index: k });
        let s = 0;
        for (const x of nv) s += x * x;
        if (!(s > 0)) fail('unsupported', `rule ${k}: plane normal is zero`, { index: k });
        const len = Math.sqrt(s);
        return { ...base, master: r.master, vec: nv.map((x) => x / len), d: d / len };
      }
      case 'copy':
        checkIndex(r.master, n, 'master', k);
        return {
          ...base,
          master: r.master,
          vec:
            r.offset === undefined
              ? new Array<number>(dim).fill(0)
              : vecOf(r.offset, dim, 'offset', k),
        };
      default:
        return fail(
          'unsupported',
          `rule ${k}: unknown kind ${JSON.stringify((r as { kind: unknown }).kind)}`,
          {
            index: k,
          },
        );
    }
  });
}

/** The axis of a coordinate-plane normal (one non-zero component), or −1. */
export function planeAxis(nrm: readonly number[]): number {
  let axis = -1;
  for (let c = 0; c < nrm.length; c++) {
    if (nrm[c] !== 0) {
      if (axis >= 0) return -1;
      axis = c;
    }
  }
  return axis;
}

/** Rules whose `cp` follows a master, in an order where every master comes first. */
function dependencyOrder(rules: readonly Rule[], n: number): Rule[] {
  const byCp = new Map<number, Rule>();
  for (const r of rules) if (r.master >= 0) byCp.set(r.cp, r);
  const state = new Uint8Array(n); // 0 new, 1 visiting, 2 done
  const out: Rule[] = [];
  const visit = (cp: number, path: number[]): void => {
    if (state[cp] === 2) return;
    if (state[cp] === 1) {
      fail(
        'conflicting-dof-rules',
        `rules form a cycle through control points ${[...path, cp].join(' → ')}`,
        {
          index: cp,
        },
      );
    }
    const r = byCp.get(cp);
    if (r === undefined) {
      state[cp] = 2;
      return;
    }
    state[cp] = 1;
    visit(r.master, [...path, cp]);
    state[cp] = 2;
    out.push(r);
  };
  for (const r of rules) if (r.master >= 0) visit(r.cp, []);
  return out;
}

/** A frozen copy of a flat object (a point), or the value itself when it is not one (validation reports it). */
function freezePoint<T>(p: T): T {
  return typeof p === 'object' && p !== null ? (Object.freeze({ ...p }) as T) : p;
}

/**
 * A deep, frozen copy of a rule: `plane`, its `normal`, `dirs` and `offset`
 * are copied too, so a caller mutating its own objects after `makeDofMap`
 * cannot change the rules a later solve re-reads (`derivedOps`). Malformed
 * input is passed through for `validate` to report.
 */
function freezeRule(r: DofRule): DofRule {
  if (typeof r !== 'object' || r === null) return r;
  const c: Record<string, unknown> = { ...r };
  if ('dirs' in r) c.dirs = Array.isArray(r.dirs) ? Object.freeze(r.dirs.map(freezePoint)) : r.dirs;
  if ('offset' in r) c.offset = freezePoint(r.offset);
  if ('plane' in r) {
    const pl = r.plane as unknown;
    c.plane =
      typeof pl === 'object' && pl !== null
        ? Object.freeze({ ...pl, normal: freezePoint(r.plane.normal) })
        : pl;
  }
  return Object.freeze(c) as unknown as DofRule;
}

/**
 * Builds the DOF map of `rules` on `target`'s control net (see the module
 * comment). Throws `conflicting-dof-rules` when a coordinate is claimed twice
 * or masters form a cycle. The map keeps deep, frozen copies of the rules.
 */
export function makeDofMap(target: NurbsCurve | NurbsSurface, rules: readonly DofRule[]): DofMap {
  const surf = isSurface(target);
  const dim = surf ? 3 : (target as NurbsCurve).dim;
  const n = surf ? target.u.count * target.v.count : (target as NurbsCurve).basis.count;
  const ref = euclidean(target.cw, n, dim);
  const owned: readonly DofRule[] = Array.isArray(rules)
    ? Object.freeze(rules.map(freezeRule))
    : rules;
  const rs = validate(owned, n, dim);
  // Claims: one rule per coordinate.
  const claimed = new Int32Array(n * dim).fill(-1);
  for (const r of rs) {
    const mask = r.kind === 'fixAxes' ? r.axes : (1 << dim) - 1;
    for (let c = 0; c < dim; c++) {
      if (!(mask & (1 << c))) continue;
      const prev = claimed[r.cp * dim + c]!;
      if (prev >= 0) {
        fail(
          'conflicting-dof-rules',
          `control point ${r.cp} coordinate ${'xyz'[c]} is claimed by rules ${prev} and ${r.k}`,
          { index: r.cp, value: r.k },
        );
      }
      claimed[r.cp * dim + c] = r.k;
    }
  }
  const order = dependencyOrder(rs, n);
  // DOFs in control-point order: free coordinates, then each point's slide/offset unknowns.
  const rows: (Row | null)[] = new Array<Row | null>(n * dim).fill(null);
  const ruleOf = new Map<number, Rule>(); // the one rule of a point, other than fixAxes
  const fixMask = new Int32Array(n); // union of a point's fixAxes rules
  for (const r of rs) {
    if (r.kind === 'fixAxes') fixMask[r.cp] = fixMask[r.cp]! | r.axes;
    else ruleOf.set(r.cp, r);
  }
  const dofAxis: number[] = [];
  const own = (axis: number): number => {
    dofAxis.push(axis);
    return dofAxis.length - 1;
  };
  const extra = new Map<number, number[]>(); // cp → its slide/offset DOFs
  for (let i = 0; i < n; i++) {
    const r = ruleOf.get(i);
    if (r === undefined) {
      for (let c = 0; c < dim; c++) {
        const fixed = (fixMask[i]! & (1 << c)) !== 0;
        rows[i * dim + c] = fixed
          ? { dof: [], coef: [], c: ref[i * dim + c]! }
          : { dof: [own(c)], coef: [1], c: ref[i * dim + c]! };
      }
    } else if (r.kind === 'fix') {
      for (let c = 0; c < dim; c++) rows[i * dim + c] = { dof: [], coef: [], c: ref[i * dim + c]! };
    } else if (r.kind === 'slide' || r.kind === 'offsetFrom') {
      extra.set(
        i,
        r.dirs.map((d) => own(planeAxis(d))),
      );
      if (r.kind === 'slide') {
        const ds = extra.get(i)!;
        for (let c = 0; c < dim; c++) {
          const row: Row = { dof: [], coef: [], c: ref[i * dim + c]! };
          r.dirs.forEach((d, k) => {
            if (d[c] !== 0) {
              row.dof.push(ds[k]!);
              row.coef.push(d[c]!);
            }
          });
          rows[i * dim + c] = row;
        }
      }
    }
  }
  // Dependent points, masters first.
  for (const r of order) {
    const m = r.master;
    const mr = (c: number): Row => rows[m * dim + c]!;
    for (let c = 0; c < dim; c++) {
      const acc = new Map<number, number>();
      let cst = 0;
      const addRow = (src: Row, f: number): void => {
        for (let e = 0; e < src.dof.length; e++) {
          const d = src.dof[e]!;
          acc.set(d, (acc.get(d) ?? 0) + f * src.coef[e]!);
        }
      };
      if (r.kind === 'offsetFrom') {
        addRow(mr(c), 1);
        cst = mr(c).c - ref[m * dim + c]! + ref[r.cp * dim + c]!;
        const ds = extra.get(r.cp)!;
        r.dirs.forEach((d, k) => {
          if (d[c] !== 0) acc.set(ds[k]!, (acc.get(ds[k]!) ?? 0) + d[c]!);
        });
      } else if (r.kind === 'copy') {
        addRow(mr(c), 1);
        cst = mr(c).c + r.vec[c]!;
      } else {
        // mirror: x' = x − 2 (n̂·x − d̂) n̂
        const nh = r.vec;
        const ax = planeAxis(nh);
        if (ax >= 0) {
          const plane = r.d / nh[ax]!; // the plane is x_ax = plane
          if (c === ax) {
            addRow(mr(c), -1);
            cst = 2 * plane - mr(c).c;
          } else {
            addRow(mr(c), 1);
            cst = mr(c).c;
          }
        } else {
          for (let cc = 0; cc < dim; cc++) {
            const R = (c === cc ? 1 : 0) - 2 * nh[c]! * nh[cc]!;
            if (R === 0) continue;
            addRow(mr(cc), R);
            cst += R * mr(cc).c;
          }
          cst += 2 * r.d * nh[c]!;
        }
      }
      const dof = [...acc.keys()].filter((d) => acc.get(d) !== 0).sort((a, b) => a - b);
      rows[r.cp * dim + c] = { dof, coef: dof.map((d) => acc.get(d)!), c: cst };
    }
  }
  // CSR and separability.
  const nr = n * dim;
  const rowPtr = new Int32Array(nr + 1);
  for (let i = 0; i < nr; i++) rowPtr[i + 1] = rowPtr[i]! + rows[i]!.dof.length;
  const col = new Int32Array(rowPtr[nr]!);
  const val = new Float64Array(rowPtr[nr]!);
  const fixed = new Float64Array(nr);
  const colAxis = new Int32Array(dofAxis.length).fill(-2);
  let separable = true;
  for (let i = 0; i < nr; i++) {
    const row = rows[i]!;
    const order2 = row.dof.map((_, e) => e).sort((a, b) => row.dof[a]! - row.dof[b]!);
    order2.forEach((e, k) => {
      const d = row.dof[e]!;
      col[rowPtr[i]! + k] = d;
      val[rowPtr[i]! + k] = row.coef[e]!;
      const axis = i % dim;
      if (colAxis[d] === -2) colAxis[d] = axis;
      else if (colAxis[d] !== axis) separable = false;
    });
    fixed[i] = row.c;
  }
  return Object.freeze({
    cpCount: n,
    dim,
    dofCount: dofAxis.length,
    separable,
    rowPtr,
    col,
    val,
    fixed,
    rules: owned,
  });
}

/** A rule applied after the solve, from the master's final coordinates (exactness, §10.3). */
export type DerivedOp =
  | {
      readonly kind: 'copy';
      readonly cp: number;
      readonly master: number;
      readonly offset: readonly number[];
    }
  | {
      readonly kind: 'mirrorAxis';
      readonly cp: number;
      readonly master: number;
      readonly axis: number;
      readonly plane: number;
    }
  | {
      readonly kind: 'mirror';
      readonly cp: number;
      readonly master: number;
      /** Row-major `dim × dim` reflection and translation `2 d̂ n̂`. */
      readonly R: readonly number[];
      readonly t: readonly number[];
    };

/** The `copy` and `mirror` rules of a map, masters first (§10.3: these are re-applied exactly after a solve). */
export function derivedOps(map: DofMap): DerivedOp[] {
  const dim = map.dim;
  const rs = validate(map.rules, map.cpCount, dim);
  const order = dependencyOrder(rs, map.cpCount);
  const out: DerivedOp[] = [];
  for (const r of order) {
    if (r.kind === 'copy') out.push({ kind: 'copy', cp: r.cp, master: r.master, offset: r.vec });
    else if (r.kind === 'mirror') {
      const ax = planeAxis(r.vec);
      if (ax >= 0)
        out.push({
          kind: 'mirrorAxis',
          cp: r.cp,
          master: r.master,
          axis: ax,
          plane: r.d / r.vec[ax]!,
        });
      else {
        const R: number[] = [];
        for (let c = 0; c < dim; c++) {
          for (let cc = 0; cc < dim; cc++) R.push((c === cc ? 1 : 0) - 2 * r.vec[c]! * r.vec[cc]!);
        }
        out.push({
          kind: 'mirror',
          cp: r.cp,
          master: r.master,
          R,
          t: r.vec.map((x) => 2 * r.d * x),
        });
      }
    }
    // offsetFrom keeps T z (rounding-level, §10.3); a chain through it is applied in order.
  }
  return out;
}
