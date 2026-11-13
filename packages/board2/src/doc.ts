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
import {
  bad,
  bool,
  build,
  chain,
  describe,
  feature,
  isRecord,
  json,
  list,
  meta,
  num,
  oneOf,
  orderedBuild,
  orderedChain,
  orderedFeature,
  orderedMeta,
  orderedOutline,
  rec,
  str,
  outline,
} from './doc-shape';
import type { Reader } from './doc-shape';
import { board2Err, board2Ok, makeIssue } from './issues';
import { BOARD_FORMAT, BOARD_MODEL, BOARD_VERSION } from './params';
import type { Board2Result, BoardDoc, Section, Station, TailSpec } from './types';

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
  const o = rec(r, v, 'tail', ['kind'], ['zone', 'auto']);
  const kind = oneOf(r, o.kind, 'tail.kind', ['standard', 'notched'] as const);
  if (kind === 'standard') {
    if (o.zone !== undefined) bad(r, 'tail.zone', 'is only for a notched tail');
    if (o.auto !== undefined) bad(r, 'tail.auto', 'is only for a notched tail');
    return { kind };
  }
  if (o.zone === undefined) bad(r, 'tail.zone', 'is required for a notched tail');
  const zone = num(r, o.zone, 'tail.zone');
  return o.auto === undefined ? { kind, zone } : { kind, zone, auto: bool(r, o.auto, 'tail.auto') };
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
  const sec = (s: Section) => ({ chain: orderedChain(s.chain), apex: s.apex });
  return {
    format: doc.format,
    version: doc.version,
    model: doc.model,
    meta: orderedMeta(doc.meta),
    symmetry: doc.symmetry,
    tail:
      doc.tail.kind === 'standard'
        ? { kind: 'standard' }
        : doc.tail.auto === undefined
          ? { kind: 'notched', zone: doc.tail.zone }
          : { kind: 'notched', zone: doc.tail.zone, auto: doc.tail.auto },
    outline: orderedOutline(doc.outline),
    rocker: orderedChain(doc.rocker),
    deck: orderedChain(doc.deck),
    stations: doc.stations.map((s) => ({
      id: s.id,
      x: s.x,
      plus: sec(s.plus),
      ...(s.minus === undefined ? {} : { minus: sec(s.minus) }),
    })),
    features: doc.features.map(orderedFeature),
    ...(doc.fins === undefined ? {} : { fins: doc.fins }),
    build: orderedBuild(doc.build),
  };
}
