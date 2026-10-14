// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Errors and results (design §8).
 *
 * - {@link GeomError} is thrown for contract violations: the caller passed
 *   something invalid. Factories and validating entry points check once; hot
 *   kernels never throw on data.
 * - `Result<T>` (in `types.ts`) is returned for data-dependent failures that valid
 *   input can produce. The helpers here build results and issues.
 *
 * Messages name the broken convention and the value; `details` carries the
 * indices and values that reproduce the failure. `GeomError` does not survive a
 * worker's structured clone, so worker code sends {@link issueOf} instead.
 */
import type { GeomErrorCode, GeomIssue, Point3, Result, UV } from './types';

/** A violated contract, with a stable machine-readable code. The only class in geom. */
export class GeomError extends Error {
  readonly code: GeomErrorCode;
  /** Indices and values that reproduce the failure. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: GeomErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GeomError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/** True if `e` is a {@link GeomError}, optionally with the given code. */
export function isGeomError(e: unknown, code?: GeomErrorCode): e is GeomError {
  return e instanceof GeomError && (code === undefined || e.code === code);
}

const isNum = (x: unknown): x is number => typeof x === 'number';
const isUV = (x: unknown): x is UV =>
  typeof x === 'object' && x !== null && isNum((x as UV).u) && isNum((x as UV).v);
const isPoint3 = (x: unknown): x is Point3 =>
  typeof x === 'object' &&
  x !== null &&
  isNum((x as Point3).x) &&
  isNum((x as Point3).y) &&
  isNum((x as Point3).z);

/**
 * The plain, cloneable issue for an error: what a worker posts back instead of
 * the error object. Location fields (`index`, `t`, `uv`, `point`, `vertex`,
 * `edge`, `face`, `coedge`) and `value` are taken from `details` when present
 * with the right type.
 */
export function issueOf(e: GeomError): GeomIssue {
  const d = e.details;
  const at: Record<string, unknown> = {};
  for (const key of ['index', 'vertex', 'edge', 'face', 't'] as const) {
    if (isNum(d[key])) at[key] = d[key];
  }
  if (isUV(d.uv)) at.uv = { u: d.uv.u, v: d.uv.v };
  if (isPoint3(d.point)) at.point = { x: d.point.x, y: d.point.y, z: d.point.z };
  const c = d.coedge;
  if (Array.isArray(c) && c.length === 3 && c.every(isNum)) at.coedge = [c[0], c[1], c[2]];
  return {
    code: e.code,
    severity: 'error',
    message: e.message,
    ...(Object.keys(at).length > 0 ? { at: at as GeomIssue['at'] } : {}),
    ...(isNum(d.value) ? { value: d.value } : {}),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported from index.ts)
// ---------------------------------------------------------------------------

/** Throws a {@link GeomError}. Typed `never` so callers narrow after it. */
export function fail(
  code: GeomErrorCode,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new GeomError(code, message, details);
}

/** A successful result, possibly carrying warnings. */
export function okResult<T>(value: T, issues: readonly GeomIssue[] = []): Result<T> {
  return { ok: true, value, issues };
}

/** A failed result; `issues` holds at least one error. */
export function errResult<T>(issues: readonly GeomIssue[]): Result<T> {
  return { ok: false, issues };
}
