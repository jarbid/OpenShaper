// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The document boundary: `reviveBoardDoc` turns untrusted JSON into a frozen
 * {@link BoardDoc}, and `boardDocToJson` writes the canonical text
 * (docs/design/m1-model.md §1).
 *
 * **What revive checks and what it leaves to `validateBoard`.** Revive checks
 * *shape*: the format tag, version and model, every field present, of the right
 * type, finite, in its enum, with no unknown keys (a field a later version adds
 * bumps `version`). It does not judge the *board* (the Phase 0 and notch rules,
 * ranges, ordering): that is `validateBoard`'s, so a document that is shaped right
 * but designed badly can still be opened and repaired.
 *
 * Every shape problem is `doc-malformed`, located by a path such as
 * `stations[2].plus.chain.knots[1].p`; `doc-version` is a recognised format with a
 * different version or model (nothing else is read then).
 *
 * The revived document is a fresh deep copy, deep-frozen, with keys in the fixed
 * order of the writer, so `boardDocToJson(reviveBoardDoc(JSON.parse(text)))` is
 * `text` for any text the writer produced.
 */
import { deepFreeze } from './freeze';
import { board2Err, board2Ok, makeIssue } from './issues';
import { BOARD_FORMAT, BOARD_MODEL, BOARD_VERSION } from './params';
import type {
  Board2Issue,
  Board2Result,
  BoardDoc,
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
  Section,
  Station,
  TailSpec,
} from './types';

interface Reader {
  readonly issues: Board2Issue[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function bad(r: Reader, path: string, what: string): void {
  r.issues.push(makeIssue('doc-malformed', `${path}: ${what}`));
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

function describe(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' && v !== null ? 'an object' : String(v);
}

function num(r: Reader, v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    bad(r, path, `must be a finite number; got ${describe(v)}`);
    return 0;
  }
  // -0 and 0 are the same document (JSON writes both as 0)
  return v === 0 ? 0 : v;
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

function pair(r: Reader, v: unknown, path: string): Pair {
  const a = list(r, v, path);
  if (a.length !== 2) {
    bad(r, path, `must have exactly 2 numbers; got ${a.length}`);
    return [0, 0];
  }
  return [num(r, a[0], `${path}[0]`), num(r, a[1], `${path}[1]`)];
}

function json(r: Reader, v: unknown, path: string, depth = 0): JsonValue {
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

function knot(r: Reader, v: unknown, path: string): ChainKnot {
  const o = rec(r, v, path, ['p', 'in', 'out', 'smooth']);
  return {
    p: pair(r, o.p, `${path}.p`),
    in: pair(r, o.in, `${path}.in`),
    out: pair(r, o.out, `${path}.out`),
    smooth: bool(r, o.smooth, `${path}.smooth`),
  };
}

function chain(r: Reader, v: unknown, path: string): Chain {
  const o = rec(r, v, path, ['knots']);
  return {
    knots: list(r, o.knots, `${path}.knots`).map((k, i) => knot(r, k, `${path}.knots[${i}]`)),
  };
}

function section(r: Reader, v: unknown, path: string): Section {
  const o = rec(r, v, path, ['chain', 'apex']);
  const apex = o.apex;
  if (typeof apex !== 'number' || !Number.isInteger(apex)) {
    bad(r, `${path}.apex`, `must be an integer; got ${describe(apex)}`);
  }
  return { chain: chain(r, o.chain, `${path}.chain`), apex: typeof apex === 'number' ? apex : 0 };
}

function station(r: Reader, v: unknown, path: string): Station {
  const o = rec(r, v, path, ['id', 'x', 'plus'], ['minus']);
  return {
    id: str(r, o.id, `${path}.id`),
    x: num(r, o.x, `${path}.x`),
    plus: section(r, o.plus, `${path}.plus`),
    ...(o.minus === undefined ? {} : { minus: section(r, o.minus, `${path}.minus`) }),
  };
}

function tail(r: Reader, v: unknown): TailSpec {
  const o = rec(r, v, 'tail', ['kind'], ['zone']);
  const kind = oneOf(r, o.kind, 'tail.kind', ['standard', 'notched'] as const);
  if (kind === 'standard') {
    if (o.zone !== undefined) bad(r, 'tail.zone', 'is only for a notched tail');
    return { kind };
  }
  if (o.zone === undefined) bad(r, 'tail.zone', 'is required for a notched tail');
  return { kind, zone: num(r, o.zone, 'tail.zone') };
}

function outline(r: Reader, v: unknown): Outline {
  const o = rec(r, v, 'outline', ['plus'], ['minus']);
  return {
    plus: chain(r, o.plus, 'outline.plus'),
    ...(o.minus === undefined ? {} : { minus: chain(r, o.minus, 'outline.minus') }),
  };
}

function handle(r: Reader, v: unknown, path: string): EaseHandle {
  const o = rec(r, v, path, ['ds', 'dv']);
  return { ds: num(r, o.ds, `${path}.ds`), dv: num(r, o.dv, `${path}.dv`) };
}

function keyedCurve(r: Reader, v: unknown, path: string): KeyedCurve {
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

function feature(r: Reader, v: unknown, path: string): BottomFeature {
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

function build(r: Reader, v: unknown): BuildSettings {
  const o = rec(r, v, 'build', ['tolerance', 'railFade']);
  return {
    tolerance: num(r, o.tolerance, 'build.tolerance'),
    railFade: num(r, o.railFade, 'build.railFade'),
  };
}

/**
 * Revives untrusted JSON (already parsed) into a frozen, canonical-order {@link BoardDoc}.
 * Never throws.
 */
export function reviveBoardDoc(input: unknown): Board2Result<BoardDoc> {
  const r: Reader = { issues: [] };
  if (!isRecord(input))
    return board2Err([makeIssue('doc-malformed', 'the document must be an object')]);
  if (input.format !== BOARD_FORMAT) {
    return board2Err([
      makeIssue(
        'doc-malformed',
        `format: must be '${BOARD_FORMAT}'; got ${describe(input.format)}`,
      ),
    ]);
  }
  if (input.version !== BOARD_VERSION || input.model !== BOARD_MODEL) {
    return board2Err([
      makeIssue(
        'doc-version',
        `this reader handles ${BOARD_FORMAT} version ${BOARD_VERSION} model '${BOARD_MODEL}'; got version ${describe(input.version)} model ${describe(input.model)}`,
      ),
    ]);
  }
  const o = rec(
    r,
    input,
    'document',
    [
      'format',
      'version',
      'model',
      'meta',
      'symmetry',
      'tail',
      'outline',
      'rocker',
      'deck',
      'stations',
      'features',
      'build',
    ],
    ['fins'],
  );
  const doc: BoardDoc = {
    format: BOARD_FORMAT,
    version: BOARD_VERSION,
    model: BOARD_MODEL,
    meta: meta(r, o.meta),
    symmetry: oneOf(r, o.symmetry, 'symmetry', ['mirror', 'asymmetric'] as const),
    tail: tail(r, o.tail),
    outline: outline(r, o.outline),
    rocker: chain(r, o.rocker, 'rocker'),
    deck: chain(r, o.deck, 'deck'),
    stations: list(r, o.stations, 'stations').map((s, i) => station(r, s, `stations[${i}]`)),
    features: list(r, o.features, 'features').map((f, i) => feature(r, f, `features[${i}]`)),
    ...(o.fins === undefined ? {} : { fins: json(r, o.fins, 'fins') }),
    build: build(r, o.build),
  };
  if (r.issues.length > 0) return board2Err(r.issues);
  return board2Ok(deepFreeze(doc));
}

/**
 * The canonical text of a document: keys in the revive order, two-space indent,
 * a trailing newline. Plain JSON; `reviveBoardDoc(JSON.parse(text))` gives the
 * document back exactly.
 */
export function boardDocToJson(doc: BoardDoc): string {
  return `${JSON.stringify(ordered(doc), null, 2)}\n`;
}

function ordered(doc: BoardDoc): unknown {
  const k = (c: ChainKnot) => ({ p: [...c.p], in: [...c.in], out: [...c.out], smooth: c.smooth });
  const ch = (c: Chain) => ({ knots: c.knots.map(k) });
  const sec = (s: Section) => ({ chain: ch(s.chain), apex: s.apex });
  const keyed = (c: KeyedCurve) => ({
    keys: c.keys.map((key) => ({
      s: key.s,
      value: key.value,
      ...(key.in === undefined ? {} : { in: { ds: key.in.ds, dv: key.in.dv } }),
      ...(key.out === undefined ? {} : { out: { ds: key.out.ds, dv: key.out.dv } }),
    })),
  });
  const feat = (f: BottomFeature) => {
    const head = { kind: f.kind, id: f.id, enabled: f.enabled, depth: keyed(f.depth) };
    switch (f.kind) {
      case 'vee':
        return { ...head, stringerRadius: f.stringerRadius };
      case 'concave':
        return { ...head, layout: f.layout, centre: f.centre, width: f.width };
      case 'channels':
        return { ...head, count: f.count, width: f.width, pitch: f.pitch, railInset: f.railInset };
    }
  };
  return {
    format: doc.format,
    version: doc.version,
    model: doc.model,
    meta: {
      name: doc.meta.name,
      ...(doc.meta.author === undefined ? {} : { author: doc.meta.author }),
      ...(doc.meta.comment === undefined ? {} : { comment: doc.meta.comment }),
      ...(doc.meta.source === undefined ? {} : { source: doc.meta.source }),
    },
    symmetry: doc.symmetry,
    tail:
      doc.tail.kind === 'standard'
        ? { kind: 'standard' }
        : { kind: 'notched', zone: doc.tail.zone },
    outline: {
      plus: ch(doc.outline.plus),
      ...(doc.outline.minus === undefined ? {} : { minus: ch(doc.outline.minus) }),
    },
    rocker: ch(doc.rocker),
    deck: ch(doc.deck),
    stations: doc.stations.map((s) => ({
      id: s.id,
      x: s.x,
      plus: sec(s.plus),
      ...(s.minus === undefined ? {} : { minus: sec(s.minus) }),
    })),
    features: doc.features.map(feat),
    ...(doc.fins === undefined ? {} : { fins: doc.fins }),
    build: { tolerance: doc.build.tolerance, railFade: doc.build.railFade },
  };
}
