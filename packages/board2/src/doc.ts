// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The document boundary: `reviveBoardDoc` turns untrusted JSON into a frozen
 * {@link BoardDoc}, and `boardDocToJson` writes the canonical text
 * (docs/design/board2.md §3.1, decision 1).
 *
 * **What revive checks and what it leaves to `validateBoard`.** Revive checks
 * *shape*: the format tag and version, every field present, of the right type,
 * finite, in its enum, with no unknown keys (a field a later version adds bumps
 * `version`), and that every spline basis is one geom accepts (knots sorted,
 * clamped on [0, 1] or periodic with period 1, multiplicity, counts, net sizes).
 * It does not judge the *board*: whether a law stays inside its lane's range,
 * whether keys are ordered, whether the tail is standard, whether an inset is
 * sensible. Those are `validateBoard`'s, so a document that is shaped right but
 * designed badly can still be opened and repaired.
 *
 * Every shape problem is `doc-malformed`, located by a path such as
 * `laws.deckInset.keys[2].value` in the message; `doc-version` is a recognised
 * format with a different version (nothing else is read then). A tail `kind`
 * other than `'standard'` is reported as `tail-not-standard` rather than as
 * malformed, since a notched tail is a valid document of a later phase.
 *
 * The revived document is a fresh deep copy, deep-frozen: it shares nothing with
 * the input, so later edits of the input cannot reach it.
 */
import { clampedBasis, periodicBasis, resolveTolerances } from '@openshaper/geom';
import type { Tolerances } from '@openshaper/geom';
import { deepFreeze } from './freeze';
import { board2Err, board2Ok, causeOf, makeIssue } from './issues';
import { EDGE_FIT_KEYS, GEOM_TOLERANCE_KEYS, OFFSET_ROW_COMPONENTS, RAIL_LANES } from './params';
import type {
  Board2Issue,
  Board2Result,
  BoardDoc,
  BoardMeta,
  BottomFeature,
  BuildParams,
  EaseHandle,
  HeightFieldJSON,
  JsonValue,
  KeyedCurve,
  LawCurve,
  LawKey,
  OffsetBasisJSON,
  OffsetField,
  OffsetLayer,
  OffsetRow,
  Passthrough,
  PlanLoopJSON,
  RailLane,
  RailLaws,
} from './types';

/** The format tag of a v2 document. */
export const BOARD2_FORMAT = 'openshaper.board2';
/** The document version this code reads and writes. */
export const BOARD2_VERSION = 1;

interface Reader {
  readonly issues: Board2Issue[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function bad(r: Reader, path: string, what: string, cause?: Board2Issue['cause']): void {
  r.issues.push(
    makeIssue('doc-malformed', `${path}: ${what}`, cause === undefined ? {} : { cause }),
  );
}

/** An object with exactly the `req` keys plus any of `opt`; `undefined` values count as absent. */
function rec(
  r: Reader,
  v: unknown,
  path: string,
  req: readonly string[],
  opt: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(v)) {
    bad(r, path, 'must be an object');
    return {};
  }
  for (const k of req) {
    if (!has(v, k) || v[k] === undefined) bad(r, `${path}.${k}`, 'is required');
  }
  for (const k of Object.keys(v)) {
    if (!req.includes(k) && !opt.includes(k)) bad(r, `${path}.${k}`, 'is not a known field');
  }
  return v;
}

function num(r: Reader, v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    bad(r, path, `must be a finite number; got ${describe(v)}`);
    return 0;
  }
  return v;
}

function int(r: Reader, v: unknown, path: string, min: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    bad(r, path, `must be an integer >= ${min}; got ${describe(v)}`);
    return min;
  }
  return v;
}

function str(r: Reader, v: unknown, path: string): string {
  if (typeof v !== 'string') {
    bad(r, path, `must be a string; got ${describe(v)}`);
    return '';
  }
  return v;
}

function bool(r: Reader, v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') {
    bad(r, path, `must be a boolean; got ${describe(v)}`);
    return false;
  }
  return v;
}

function oneOf<T extends string>(r: Reader, v: unknown, path: string, choices: readonly T[]): T {
  if (typeof v !== 'string' || !choices.includes(v as T)) {
    bad(r, path, `must be one of ${choices.map((c) => `'${c}'`).join(', ')}; got ${describe(v)}`);
    return choices[0]!;
  }
  return v as T;
}

function list(r: Reader, v: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(v)) {
    bad(r, path, `must be an array; got ${describe(v)}`);
    return [];
  }
  return v;
}

function numList(r: Reader, v: unknown, path: string): number[] {
  return list(r, v, path).map((x, i) => num(r, x, `${path}[${i}]`));
}

function pair(r: Reader, v: unknown, path: string): readonly [number, number] {
  const a = list(r, v, path);
  if (a.length !== 2) {
    bad(r, path, `must have exactly 2 numbers; got ${a.length}`);
    return [0, 0];
  }
  return [num(r, a[0], `${path}[0]`), num(r, a[1], `${path}[1]`)];
}

function describe(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' && v !== null ? 'an object' : String(v);
}

/** Runs a geom constructor, reporting its refusal as a malformed field with the geom cause. */
function geomCheck(r: Reader, path: string, check: () => void): void {
  try {
    check();
  } catch (e) {
    bad(r, path, e instanceof Error ? e.message : String(e), causeOf(e));
  }
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function meta(r: Reader, v: unknown): BoardMeta {
  const o = rec(r, v, 'meta', ['name'], ['author', 'comment', 'source']);
  const out: { -readonly [K in keyof BoardMeta]: BoardMeta[K] } = {
    name: str(r, o.name, 'meta.name'),
  };
  for (const k of ['author', 'comment', 'source'] as const) {
    if (o[k] !== undefined) out[k] = str(r, o[k], `meta.${k}`);
  }
  return out;
}

function handle(r: Reader, v: unknown, path: string): EaseHandle {
  const o = rec(r, v, path, ['ds', 'dv']);
  return { ds: num(r, o.ds, `${path}.ds`), dv: num(r, o.dv, `${path}.dv`) };
}

function keys(r: Reader, v: unknown, path: string): LawKey[] {
  return list(r, v, path).map((kv, i) => {
    const p = `${path}[${i}]`;
    const o = rec(r, kv, p, ['s', 'value'], ['in', 'out']);
    return {
      s: num(r, o.s, `${p}.s`),
      value: num(r, o.value, `${p}.value`),
      ...(o.in === undefined ? {} : { in: handle(r, o.in, `${p}.in`) }),
      ...(o.out === undefined ? {} : { out: handle(r, o.out, `${p}.out`) }),
    };
  });
}

function keyedCurve(r: Reader, v: unknown, path: string): KeyedCurve {
  const o = rec(r, v, path, ['keys']);
  return { keys: keys(r, o.keys, `${path}.keys`) };
}

function lawCurve(r: Reader, v: unknown, path: string): LawCurve {
  const o = rec(r, v, path, ['domain', 'keys']);
  return {
    domain: oneOf(r, o.domain, `${path}.domain`, ['half', 'full'] as const),
    keys: keys(r, o.keys, `${path}.keys`),
  };
}

function laws(r: Reader, v: unknown): RailLaws {
  const o = rec(r, v, 'laws', RAIL_LANES);
  const out = {} as { -readonly [L in RailLane]: LawCurve };
  for (const lane of RAIL_LANES) out[lane] = lawCurve(r, o[lane], `laws.${lane}`);
  return out;
}

function planLoop(r: Reader, v: unknown, tol: Partial<Tolerances>): PlanLoopJSON {
  const o = rec(r, v, 'plan', ['degree', 'knots', 'points']);
  // The Phase 2 plan loop is a periodic cubic (§3.3).
  const degree = 3;
  if (o.degree !== degree) {
    bad(r, 'plan.degree', `must be 3 (a periodic cubic); got ${describe(o.degree)}`);
  }
  const knots = numList(r, o.knots, 'plan.knots');
  const points = numList(r, o.points, 'plan.points');
  if (points.length !== 2 * knots.length) {
    bad(
      r,
      'plan.points',
      `must hold one (x, y) pair per knot: ${2 * knots.length} numbers; got ${points.length}`,
    );
  }
  geomCheck(r, 'plan.knots', () => void periodicBasis(degree, knots, 1, tol));
  return { degree, knots, points };
}

function heightField(
  r: Reader,
  v: unknown,
  path: string,
  tol: Partial<Tolerances>,
): HeightFieldJSON {
  const o = rec(r, v, path, ['degreeU', 'degreeV', 'knotsU', 'knotsV', 'x', 'y', 'z']);
  const degreeU = int(r, o.degreeU, `${path}.degreeU`, 1);
  const degreeV = int(r, o.degreeV, `${path}.degreeV`, 1);
  const knotsU = numList(r, o.knotsU, `${path}.knotsU`);
  const knotsV = numList(r, o.knotsV, `${path}.knotsV`);
  const x = pair(r, o.x, `${path}.x`);
  const y = pair(r, o.y, `${path}.y`);
  const z = numList(r, o.z, `${path}.z`);
  for (const [name, [lo, hi]] of [
    ['x', x],
    ['y', y],
  ] as const) {
    if (!(hi > lo)) bad(r, `${path}.${name}`, `must be an increasing interval; got [${lo}, ${hi}]`);
  }
  let countU = -1;
  let countV = -1;
  for (const [name, degree, knots] of [
    ['knotsU', degreeU, knotsU],
    ['knotsV', degreeV, knotsV],
  ] as const) {
    geomCheck(r, `${path}.${name}`, () => {
      const b = clampedBasis(degree, knots, tol);
      // The parametrisation is fixed to [0, 1] so x and y are affine in (u, v) (§3.4).
      if (b.domain[0] !== 0 || b.domain[1] !== 1) {
        throw new Error(`the domain must be [0, 1]; got [${b.domain[0]}, ${b.domain[1]}]`);
      }
      if (name === 'knotsU') countU = b.count;
      else countV = b.count;
    });
  }
  if (countU >= 0 && countV >= 0 && z.length !== countU * countV) {
    bad(
      r,
      `${path}.z`,
      `must hold ${countU} × ${countV} = ${countU * countV} heights; got ${z.length}`,
    );
  }
  return { degreeU, degreeV, knotsU, knotsV, x, y, z };
}

const OFFSET_ROWS = Object.keys(OFFSET_ROW_COMPONENTS) as OffsetRow[];

function offsets(r: Reader, v: unknown, tol: Partial<Tolerances>): OffsetLayer {
  const o = rec(r, v, 'offsets', ['basis', 'rows']);
  let basis: OffsetBasisJSON | null = null;
  let count = 0;
  if (o.basis !== null) {
    const b = rec(r, o.basis, 'offsets.basis', ['degree', 'knots']);
    const degree = int(r, b.degree, 'offsets.basis.degree', 1);
    const knots = numList(r, b.knots, 'offsets.basis.knots');
    geomCheck(r, 'offsets.basis.knots', () => {
      count = periodicBasis(degree, knots, 1, tol).count;
    });
    basis = { degree, knots };
  }
  const seen = new Set<string>();
  const rows: OffsetField[] = list(r, o.rows, 'offsets.rows').map((fv, i) => {
    const p = `offsets.rows[${i}]`;
    const f = rec(r, fv, p, ['row', 'values']);
    const row = oneOf(r, f.row, `${p}.row`, OFFSET_ROWS);
    const values = numList(r, f.values, `${p}.values`);
    if (seen.has(row)) bad(r, `${p}.row`, `'${row}' appears twice`);
    seen.add(row);
    const want = count * OFFSET_ROW_COMPONENTS[row].length;
    if (basis !== null && values.length !== want) {
      bad(
        r,
        `${p}.values`,
        `'${row}' needs ${count} × ${OFFSET_ROW_COMPONENTS[row].length} = ${want} values; got ${values.length}`,
      );
    }
    return { row, values };
  });
  if (basis === null && rows.length > 0) bad(r, 'offsets.rows', 'must be empty when basis is null');
  return { basis, rows };
}

const FEATURE_KINDS = ['vee', 'concave', 'channels'] as const;

function features(r: Reader, v: unknown): BottomFeature[] {
  return list(r, v, 'features').map((fv, i): BottomFeature => {
    const p = `features[${i}]`;
    const kind = isRecord(fv) ? fv.kind : undefined;
    const common = ['kind', 'id', 'enabled', 'depth'];
    const base = (o: Record<string, unknown>) => ({
      id: str(r, o.id, `${p}.id`),
      enabled: bool(r, o.enabled, `${p}.enabled`),
      depth: keyedCurve(r, o.depth, `${p}.depth`),
    });
    switch (kind) {
      case 'vee': {
        const o = rec(r, fv, p, [...common, 'stringerRadius']);
        return {
          kind,
          ...base(o),
          stringerRadius: num(r, o.stringerRadius, `${p}.stringerRadius`),
        };
      }
      case 'concave': {
        const o = rec(r, fv, p, [...common, 'layout', 'centre', 'width']);
        return {
          kind,
          ...base(o),
          layout: oneOf(r, o.layout, `${p}.layout`, ['single', 'double'] as const),
          centre: num(r, o.centre, `${p}.centre`),
          width: num(r, o.width, `${p}.width`),
        };
      }
      case 'channels': {
        const o = rec(r, fv, p, [...common, 'count', 'width', 'pitch', 'railInset']);
        return {
          kind,
          ...base(o),
          count: int(r, o.count, `${p}.count`, 0),
          width: num(r, o.width, `${p}.width`),
          pitch: num(r, o.pitch, `${p}.pitch`),
          railInset: num(r, o.railInset, `${p}.railInset`),
        };
      }
      default:
        if (!isRecord(fv)) bad(r, p, 'must be an object');
        else if (kind === undefined) bad(r, `${p}.kind`, 'is required');
        else {
          bad(
            r,
            `${p}.kind`,
            `must be one of ${FEATURE_KINDS.map((k) => `'${k}'`).join(', ')}; got ${describe(kind)}`,
          );
        }
        return { kind: 'vee', id: '', enabled: false, depth: { keys: [] }, stringerRadius: 0 };
    }
  });
}

function sparse(
  r: Reader,
  v: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, number> {
  const o = rec(r, v, path, [], allowed);
  const out: Record<string, number> = {};
  for (const k of Object.keys(o)) if (o[k] !== undefined) out[k] = num(r, o[k], `${path}.${k}`);
  return out;
}

function build(r: Reader, v: unknown): BuildParams {
  const names = [
    'minInset',
    'insetCurvatureFraction',
    'minRailHeight',
    'apexHeightRange',
    'fullnessRange',
    'maxFrameTurn',
    'maxStationSpacing',
    'lawTolerance',
    'deckJoinAngleTol',
    'apexJoinAngleTol',
    'maxBandRefinePasses',
    'planMargin',
    'featureTol',
    'tolerances',
    'edgeFit',
  ];
  const o = rec(r, v, 'build', names);
  const n = (k: string): number => num(r, o[k], `build.${k}`);
  const lt = rec(r, o.lawTolerance, 'build.lawTolerance', RAIL_LANES);
  const lawTolerance = {} as { -readonly [L in RailLane]: number };
  for (const lane of RAIL_LANES)
    lawTolerance[lane] = num(r, lt[lane], `build.lawTolerance.${lane}`);
  return {
    minInset: n('minInset'),
    insetCurvatureFraction: n('insetCurvatureFraction'),
    minRailHeight: n('minRailHeight'),
    apexHeightRange: pair(r, o.apexHeightRange, 'build.apexHeightRange'),
    fullnessRange: pair(r, o.fullnessRange, 'build.fullnessRange'),
    maxFrameTurn: n('maxFrameTurn'),
    maxStationSpacing: n('maxStationSpacing'),
    lawTolerance,
    deckJoinAngleTol: n('deckJoinAngleTol'),
    apexJoinAngleTol: n('apexJoinAngleTol'),
    maxBandRefinePasses: int(r, o.maxBandRefinePasses, 'build.maxBandRefinePasses', 0),
    planMargin: n('planMargin'),
    featureTol: n('featureTol'),
    tolerances: sparse(
      r,
      o.tolerances,
      'build.tolerances',
      GEOM_TOLERANCE_KEYS,
    ) as Partial<Tolerances>,
    edgeFit: sparse(r, o.edgeFit, 'build.edgeFit', EDGE_FIT_KEYS) as BuildParams['edgeFit'],
  };
}

/** A copy of opaque JSON, rejecting anything JSON text cannot hold (and cycles, and `__proto__`). */
function jsonValue(r: Reader, v: unknown, path: string, stack: object[] = []): JsonValue {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) bad(r, path, `must be a finite number; got ${v}`);
    return v;
  }
  if (typeof v === 'object') {
    if (stack.includes(v)) {
      bad(r, path, 'contains a cycle');
      return null;
    }
    stack.push(v);
    try {
      if (Array.isArray(v)) return v.map((x, i) => jsonValue(r, x, `${path}[${i}]`, stack));
      if (isRecord(v)) {
        const out: Record<string, JsonValue> = {};
        for (const k of Object.keys(v)) {
          if (k === '__proto__') {
            bad(r, `${path}.${k}`, 'is not allowed as a key');
            continue;
          }
          out[k] = jsonValue(r, v[k], `${path}.${k}`, stack);
        }
        return out;
      }
    } finally {
      stack.pop();
    }
  }
  bad(r, path, `is not JSON data (${describe(v)})`);
  return null;
}

function passthrough(r: Reader, v: unknown): Passthrough {
  const o = rec(r, v, 'passthrough', [], ['fins']);
  return o.fins === undefined ? {} : { fins: jsonValue(r, o.fins, 'passthrough.fins') };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Validates untrusted JSON (a parsed file, a worker message) and returns the
 * frozen document, or every shape problem found (`doc-malformed`, `doc-version`,
 * `tail-not-standard`). See the module comment for what is and is not checked.
 */
export function reviveBoardDoc(json: unknown): Board2Result<BoardDoc> {
  const r: Reader = { issues: [] };
  if (!isRecord(json)) {
    bad(r, 'document', 'must be an object');
    return board2Err(r.issues);
  }
  if (json.format !== BOARD2_FORMAT) {
    bad(r, 'format', `must be '${BOARD2_FORMAT}'; got ${describe(json.format)}`);
    return board2Err(r.issues);
  }
  if (json.version !== BOARD2_VERSION) {
    if (typeof json.version === 'number') {
      return board2Err([
        makeIssue(
          'doc-version',
          `unsupported version ${json.version}; this code reads version ${BOARD2_VERSION}`,
          {
            value: json.version,
          },
        ),
      ]);
    }
    bad(r, 'version', `must be the number ${BOARD2_VERSION}; got ${describe(json.version)}`);
    return board2Err(r.issues);
  }
  const o = rec(
    r,
    json,
    'document',
    [
      'format',
      'version',
      'meta',
      'symmetry',
      'tail',
      'plan',
      'deck',
      'bottom',
      'laws',
      'offsets',
      'features',
      'build',
    ],
    ['passthrough'],
  );
  const buildParams = build(r, o.build);
  // The bases are checked under the document's own tolerances, when those are usable.
  let tol: Partial<Tolerances> = {};
  try {
    resolveTolerances(buildParams.tolerances);
    tol = buildParams.tolerances;
  } catch (e) {
    bad(r, 'build.tolerances', e instanceof Error ? e.message : String(e), causeOf(e));
  }
  const tailObj = rec(r, o.tail, 'tail', ['kind']);
  if (typeof tailObj.kind === 'string' && tailObj.kind !== 'standard') {
    r.issues.push(
      makeIssue(
        'tail-not-standard',
        `tail.kind '${tailObj.kind}' is not supported in Phase 2 (only 'standard')`,
      ),
    );
  } else if (tailObj.kind !== 'standard') {
    bad(r, 'tail.kind', `must be 'standard'; got ${describe(tailObj.kind)}`);
  }
  const doc: BoardDoc = {
    format: BOARD2_FORMAT,
    version: BOARD2_VERSION,
    meta: meta(r, o.meta),
    symmetry: oneOf(r, o.symmetry, 'symmetry', ['mirror-y', 'none'] as const),
    tail: { kind: 'standard' },
    plan: planLoop(r, o.plan, tol),
    deck: heightField(r, o.deck, 'deck', tol),
    bottom: heightField(r, o.bottom, 'bottom', tol),
    laws: laws(r, o.laws),
    offsets: offsets(r, o.offsets, tol),
    features: features(r, o.features),
    build: buildParams,
    ...(o.passthrough === undefined ? {} : { passthrough: passthrough(r, o.passthrough) }),
  };
  if (r.issues.some((i) => i.severity === 'error')) return board2Err(r.issues);
  return board2Ok(deepFreeze(doc), r.issues);
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = canonical(x);
    }
    return out;
  }
  return v;
}

/**
 * The canonical JSON text of a document: object keys sorted at every level, so
 * the same document gives the same bytes whatever order its fields were built in.
 * `reviveBoardDoc(JSON.parse(boardDocToJson(d)))` returns an equal document and
 * serialising that again gives the same text. (JSON has no negative zero: `-0`
 * is written `0`.) `indent` is passed to `JSON.stringify`.
 */
export function boardDocToJson(doc: BoardDoc, indent?: number): string {
  return JSON.stringify(canonical(doc), null, indent);
}
