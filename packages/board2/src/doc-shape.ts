// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The shape both kinds of board document share: a strict reader for untrusted JSON
 * (`rec`, `num`, `str`, ... each collecting a located `doc-malformed` issue instead of
 * throwing) and the readers of the parts a sections document and a rails document
 * have in common (meta, outline, curve chains, keyed curves, bottom features, build
 * settings), each with the ordered copy the canonical writers use. Internal to the
 * package: `reviveBoardDoc` and `reviveRails` are the public readers.
 */
import { makeIssue } from './issues';
import type {
  Board2Issue,
  BoardMeta,
  BottomFeature,
  BuildSettings,
  Chain,
  ChainKnot,
  EaseHandle,
  JsonValue,
  KeyedCurve,
  LawKey,
  Outline,
  Pair,
} from './types';

export interface Reader {
  readonly issues: Board2Issue[];
}

export const isRecord = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

export const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function bad(r: Reader, path: string, what: string): void {
  r.issues.push(makeIssue('doc-malformed', `${path}: ${what}`));
}

/** An object with exactly the `req` keys plus any of `opt`; `undefined` values count as absent. */
export function rec(
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

export function describe(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' && v !== null ? 'an object' : String(v);
}

export function num(r: Reader, v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    bad(r, path, `must be a finite number; got ${describe(v)}`);
    return 0;
  }
  // -0 and 0 are the same document (JSON writes both as 0)
  return v === 0 ? 0 : v;
}

export function str(r: Reader, v: unknown, path: string): string {
  if (typeof v !== 'string') {
    bad(r, path, `must be a string; got ${describe(v)}`);
    return '';
  }
  return v;
}

export function bool(r: Reader, v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') {
    bad(r, path, `must be a boolean; got ${describe(v)}`);
    return false;
  }
  return v;
}

export function oneOf<T extends string>(
  r: Reader,
  v: unknown,
  path: string,
  choices: readonly T[],
): T {
  if (typeof v !== 'string' || !choices.includes(v as T)) {
    bad(r, path, `must be one of ${choices.map((c) => `'${c}'`).join(', ')}; got ${describe(v)}`);
    return choices[0]!;
  }
  return v as T;
}

export function list(r: Reader, v: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(v)) {
    bad(r, path, `must be an array; got ${describe(v)}`);
    return [];
  }
  return v;
}

export function pair(r: Reader, v: unknown, path: string): Pair {
  const a = list(r, v, path);
  if (a.length !== 2) {
    bad(r, path, `must have exactly 2 numbers; got ${a.length}`);
    return [0, 0];
  }
  return [num(r, a[0], `${path}[0]`), num(r, a[1], `${path}[1]`)];
}

export function json(r: Reader, v: unknown, path: string, depth = 0): JsonValue {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return num(r, v, path);
  if (depth > 64) {
    bad(r, path, 'is nested too deeply');
    return null;
  }
  if (Array.isArray(v)) return v.map((x, i) => json(r, x, `${path}[${i}]`, depth + 1));
  if (isRecord(v)) {
    const out: Record<string, JsonValue> = {};
    for (const k of Object.keys(v)) {
      if (v[k] !== undefined) out[k] = json(r, v[k], `${path}.${k}`, depth + 1);
    }
    return out;
  }
  bad(r, path, `must be JSON data; got ${describe(v)}`);
  return null;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

export function meta(r: Reader, v: unknown): BoardMeta {
  const o = rec(r, v, 'meta', ['name'], ['author', 'comment', 'source', 'extra']);
  const out: { -readonly [K in keyof BoardMeta]: BoardMeta[K] } = {
    name: str(r, o.name, 'meta.name'),
  };
  for (const k of ['author', 'comment', 'source'] as const) {
    if (o[k] !== undefined) out[k] = str(r, o[k], `meta.${k}`);
  }
  if (o.extra !== undefined) out.extra = json(r, o.extra, 'meta.extra');
  return out;
}

export function lock(r: Reader, v: unknown, path: string): NonNullable<ChainKnot['lock']> {
  const o = rec(r, v, path, [], ['prev', 'next']);
  return {
    ...(o.prev === undefined ? {} : { prev: pair(r, o.prev, `${path}.prev`) }),
    ...(o.next === undefined ? {} : { next: pair(r, o.next, `${path}.next`) }),
  };
}

export function knot(r: Reader, v: unknown, path: string): ChainKnot {
  const o = rec(r, v, path, ['p', 'in', 'out', 'smooth'], ['lock']);
  return {
    p: pair(r, o.p, `${path}.p`),
    in: pair(r, o.in, `${path}.in`),
    out: pair(r, o.out, `${path}.out`),
    smooth: bool(r, o.smooth, `${path}.smooth`),
    ...(o.lock === undefined ? {} : { lock: lock(r, o.lock, `${path}.lock`) }),
  };
}

export function chain(r: Reader, v: unknown, path: string): Chain {
  const o = rec(r, v, path, ['knots']);
  return {
    knots: list(r, o.knots, `${path}.knots`).map((k, i) => knot(r, k, `${path}.knots[${i}]`)),
  };
}

export function outline(r: Reader, v: unknown): Outline {
  const o = rec(r, v, 'outline', ['plus'], ['minus']);
  return {
    plus: chain(r, o.plus, 'outline.plus'),
    ...(o.minus === undefined ? {} : { minus: chain(r, o.minus, 'outline.minus') }),
  };
}

export function handle(r: Reader, v: unknown, path: string): EaseHandle {
  const o = rec(r, v, path, ['ds', 'dv']);
  return { ds: num(r, o.ds, `${path}.ds`), dv: num(r, o.dv, `${path}.dv`) };
}

export function keyedCurve(r: Reader, v: unknown, path: string): KeyedCurve {
  const o = rec(r, v, path, ['keys']);
  const keys: LawKey[] = list(r, o.keys, `${path}.keys`).map((kv, i) => {
    const p = `${path}.keys[${i}]`;
    const k = rec(r, kv, p, ['s', 'value'], ['in', 'out']);
    return {
      s: num(r, k.s, `${p}.s`),
      value: num(r, k.value, `${p}.value`),
      ...(k.in === undefined ? {} : { in: handle(r, k.in, `${p}.in`) }),
      ...(k.out === undefined ? {} : { out: handle(r, k.out, `${p}.out`) }),
    };
  });
  return { keys };
}

export function feature(r: Reader, v: unknown, path: string): BottomFeature {
  if (!isRecord(v)) {
    bad(r, path, 'must be an object');
    return { kind: 'vee', id: '', enabled: false, depth: { keys: [] }, stringerRadius: 0 };
  }
  const kind = oneOf(r, v.kind, `${path}.kind`, ['vee', 'concave', 'channels'] as const);
  const common = ['kind', 'id', 'enabled', 'depth'];
  const base = (o: Record<string, unknown>) => ({
    id: str(r, o.id, `${path}.id`),
    enabled: bool(r, o.enabled, `${path}.enabled`),
    depth: keyedCurve(r, o.depth, `${path}.depth`),
  });
  switch (kind) {
    case 'vee': {
      const o = rec(r, v, path, [...common, 'stringerRadius']);
      return {
        kind,
        ...base(o),
        stringerRadius: num(r, o.stringerRadius, `${path}.stringerRadius`),
      };
    }
    case 'concave': {
      const o = rec(r, v, path, [...common, 'layout', 'centre', 'width']);
      return {
        kind,
        ...base(o),
        layout: oneOf(r, o.layout, `${path}.layout`, ['single', 'double'] as const),
        centre: num(r, o.centre, `${path}.centre`),
        width: num(r, o.width, `${path}.width`),
      };
    }
    case 'channels': {
      const o = rec(r, v, path, [...common, 'count', 'width', 'pitch', 'railInset']);
      return {
        kind,
        ...base(o),
        count: num(r, o.count, `${path}.count`),
        width: num(r, o.width, `${path}.width`),
        pitch: num(r, o.pitch, `${path}.pitch`),
        railInset: num(r, o.railInset, `${path}.railInset`),
      };
    }
  }
}

export function build(r: Reader, v: unknown): BuildSettings {
  const o = rec(r, v, 'build', ['tolerance', 'railFade']);
  return {
    tolerance: num(r, o.tolerance, 'build.tolerance'),
    railFade: num(r, o.railFade, 'build.railFade'),
  };
}

// ---------------------------------------------------------------------------
// Ordered copies, for the canonical writers
// ---------------------------------------------------------------------------

export const orderedKnot = (c: ChainKnot): unknown => ({
  p: [...c.p],
  in: [...c.in],
  out: [...c.out],
  smooth: c.smooth,
  ...(c.lock === undefined
    ? {}
    : {
        lock: {
          ...(c.lock.prev === undefined ? {} : { prev: [...c.lock.prev] }),
          ...(c.lock.next === undefined ? {} : { next: [...c.lock.next] }),
        },
      }),
});

export const orderedChain = (c: Chain): unknown => ({ knots: c.knots.map(orderedKnot) });

export const orderedKeyed = (c: KeyedCurve): unknown => ({
  keys: c.keys.map((key) => ({
    s: key.s,
    value: key.value,
    ...(key.in === undefined ? {} : { in: { ds: key.in.ds, dv: key.in.dv } }),
    ...(key.out === undefined ? {} : { out: { ds: key.out.ds, dv: key.out.dv } }),
  })),
});

export const orderedFeature = (f: BottomFeature): unknown => {
  const head = { kind: f.kind, id: f.id, enabled: f.enabled, depth: orderedKeyed(f.depth) };
  switch (f.kind) {
    case 'vee':
      return { ...head, stringerRadius: f.stringerRadius };
    case 'concave':
      return { ...head, layout: f.layout, centre: f.centre, width: f.width };
    case 'channels':
      return { ...head, count: f.count, width: f.width, pitch: f.pitch, railInset: f.railInset };
  }
};

export const orderedMeta = (m: BoardMeta): unknown => ({
  name: m.name,
  ...(m.author === undefined ? {} : { author: m.author }),
  ...(m.comment === undefined ? {} : { comment: m.comment }),
  ...(m.source === undefined ? {} : { source: m.source }),
  ...(m.extra === undefined ? {} : { extra: m.extra }),
});

export const orderedOutline = (o: Outline): unknown => ({
  plus: orderedChain(o.plus),
  ...(o.minus === undefined ? {} : { minus: orderedChain(o.minus) }),
});

export const orderedBuild = (b: BuildSettings): unknown => ({
  tolerance: b.tolerance,
  railFade: b.railFade,
});
