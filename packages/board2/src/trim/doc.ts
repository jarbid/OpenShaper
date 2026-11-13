// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rails board's text: `reviveRails` turns untrusted JSON into a frozen
 * {@link RailsBoard}, and `railsToJson` writes the canonical text. `docModel` says
 * which of the two readers (`reviveBoardDoc`, `reviveRails`) a parsed value is for.
 *
 * The file carries a `format` tag and a `version` that the board in memory does not:
 * the writer adds them, the reader checks them and drops them. `model` is the
 * board's own.
 *
 * **What revive checks and what it leaves to `buildRails`.** Revive checks *shape*:
 * the format tag, version and model, every field present, of the right type, finite,
 * in its enum, with no unknown keys. It does not judge the *board* (the order of
 * stations or rail keys, ranges, counts, whether a `minus` side goes with an
 * asymmetric board): that is `buildRails`'s check, so a document that is shaped right
 * but designed badly can still be opened and repaired.
 *
 * Every shape problem is `doc-malformed`, located by a path such as
 * `stations[2].plus.bottom.knots[1].p` or `rails.plus[0].rail.tuck`, and all of them
 * are reported; `doc-version` is a recognised format with a different version or
 * model (nothing else is read then).
 *
 * The revived board is a fresh deep copy, deep-frozen, with keys in the fixed order of
 * the writer, so `railsToJson(reviveRails(JSON.parse(text)).value)` is `text` for any
 * text the writer produced.
 */
import {
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
  outline,
  rec,
  str,
} from '../doc-shape';
import type { Reader } from '../doc-shape';
import { deepFreeze } from '../freeze';
import { board2Err, board2Ok, makeIssue } from '../issues';
import { BOARD_FORMAT, BOARD_MODEL, RAILS_MODEL, RAILS_VERSION } from '../params';
import type { Board2Result } from '../types';
import type { RailsBoard, RailKey, RailsCorners, RailsStation, StationCurves } from './board';
import type { RailRecipe } from './rails';

/** A rail's numbers, in the order the text writes them. */
const RAIL_FIELDS = [
  'band',
  'hardness',
  'tuck',
  'tuckShape',
  'bottomEdge',
  'deckEdge',
  'apex',
] as const satisfies readonly (keyof RailRecipe)[];

function numbers(r: Reader, v: unknown, path: string): number[] {
  return list(r, v, path).map((x, i) => num(r, x, `${path}[${i}]`));
}

function corners(r: Reader, v: unknown): RailsCorners {
  const o = rec(r, v, 'corners', ['nose', 'tail', 'plus'], ['minus']);
  return {
    nose: num(r, o.nose, 'corners.nose'),
    tail: num(r, o.tail, 'corners.tail'),
    plus: numbers(r, o.plus, 'corners.plus'),
    ...(o.minus === undefined ? {} : { minus: numbers(r, o.minus, 'corners.minus') }),
  };
}

function curves(r: Reader, v: unknown, path: string): StationCurves {
  const o = rec(r, v, path, ['bottom', 'deck']);
  return {
    bottom: chain(r, o.bottom, `${path}.bottom`),
    deck: chain(r, o.deck, `${path}.deck`),
  };
}

function station(r: Reader, v: unknown, path: string): RailsStation {
  const o = rec(r, v, path, ['id', 'x', 'plus'], ['minus']);
  return {
    id: str(r, o.id, `${path}.id`),
    x: num(r, o.x, `${path}.x`),
    plus: curves(r, o.plus, `${path}.plus`),
    ...(o.minus === undefined ? {} : { minus: curves(r, o.minus, `${path}.minus`) }),
  };
}

function recipe(r: Reader, v: unknown, path: string): RailRecipe {
  const o = rec(r, v, path, RAIL_FIELDS);
  const out: { -readonly [K in keyof RailRecipe]: RailRecipe[K] } = {
    band: 0,
    hardness: 0,
    tuck: 0,
    tuckShape: 0,
    bottomEdge: 0,
    deckEdge: 0,
    apex: 0,
  };
  for (const k of RAIL_FIELDS) out[k] = num(r, o[k], `${path}.${k}`);
  return out;
}

function railKeys(r: Reader, v: unknown, path: string): RailKey[] {
  return list(r, v, path).map((kv, i) => {
    const p = `${path}[${i}]`;
    const o = rec(r, kv, p, ['x', 'rail']);
    return { x: num(r, o.x, `${p}.x`), rail: recipe(r, o.rail, `${p}.rail`) };
  });
}

function rails(r: Reader, v: unknown): RailsBoard['rails'] {
  const o = rec(r, v, 'rails', ['plus'], ['minus']);
  return {
    plus: railKeys(r, o.plus, 'rails.plus'),
    ...(o.minus === undefined ? {} : { minus: railKeys(r, o.minus, 'rails.minus') }),
  };
}

/**
 * Revives untrusted JSON (already parsed) into a frozen, canonical-order {@link RailsBoard}.
 * Never throws.
 */
export function reviveRails(input: unknown): Board2Result<RailsBoard> {
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
  if (input.version !== RAILS_VERSION || input.model !== RAILS_MODEL) {
    return board2Err([
      makeIssue(
        'doc-version',
        `this reader handles ${BOARD_FORMAT} version ${RAILS_VERSION} model '${RAILS_MODEL}'; got version ${describe(input.version)} model ${describe(input.model)}`,
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
      'outline',
      'corners',
      'rocker',
      'deck',
      'stations',
      'rails',
      'features',
      'build',
    ],
    ['fins'],
  );
  const board: RailsBoard = {
    model: RAILS_MODEL,
    meta: meta(r, o.meta),
    symmetry: oneOf(r, o.symmetry, 'symmetry', ['mirror', 'asymmetric'] as const),
    outline: outline(r, o.outline),
    corners: corners(r, o.corners),
    rocker: chain(r, o.rocker, 'rocker'),
    deck: chain(r, o.deck, 'deck'),
    stations: list(r, o.stations, 'stations').map((s, i) => station(r, s, `stations[${i}]`)),
    rails: rails(r, o.rails),
    features: list(r, o.features, 'features').map((f, i) => feature(r, f, `features[${i}]`)),
    ...(o.fins === undefined ? {} : { fins: json(r, o.fins, 'fins') }),
    build: build(r, o.build),
  };
  if (r.issues.length > 0) return board2Err(r.issues);
  return board2Ok(deepFreeze(board));
}

/**
 * The canonical text of a rails board: keys in the revive order, two-space indent, a
 * trailing newline. Plain JSON; `reviveRails(JSON.parse(text))` gives the board back
 * exactly.
 */
export function railsToJson(board: RailsBoard): string {
  return `${JSON.stringify(ordered(board), null, 2)}\n`;
}

function ordered(board: RailsBoard): unknown {
  const side = (s: StationCurves) => ({
    bottom: orderedChain(s.bottom),
    deck: orderedChain(s.deck),
  });
  const keys = (ks: readonly RailKey[]) =>
    ks.map((k) => ({
      x: k.x,
      rail: {
        band: k.rail.band,
        hardness: k.rail.hardness,
        tuck: k.rail.tuck,
        tuckShape: k.rail.tuckShape,
        bottomEdge: k.rail.bottomEdge,
        deckEdge: k.rail.deckEdge,
        apex: k.rail.apex,
      },
    }));
  return {
    format: BOARD_FORMAT,
    version: RAILS_VERSION,
    model: board.model,
    meta: orderedMeta(board.meta),
    symmetry: board.symmetry,
    outline: orderedOutline(board.outline),
    corners: {
      nose: board.corners.nose,
      tail: board.corners.tail,
      plus: [...board.corners.plus],
      ...(board.corners.minus === undefined ? {} : { minus: [...board.corners.minus] }),
    },
    rocker: orderedChain(board.rocker),
    deck: orderedChain(board.deck),
    stations: board.stations.map((s) => ({
      id: s.id,
      x: s.x,
      plus: side(s.plus),
      ...(s.minus === undefined ? {} : { minus: side(s.minus) }),
    })),
    rails: {
      plus: keys(board.rails.plus),
      ...(board.rails.minus === undefined ? {} : { minus: keys(board.rails.minus) }),
    },
    features: board.features.map(orderedFeature),
    ...(board.fins === undefined ? {} : { fins: board.fins }),
    build: orderedBuild(board.build),
  };
}

/**
 * Which reader an already-parsed value is for: `null` unless it is an object whose
 * `format` is `'openshaper'` and whose `model` is one of the two.
 */
export function docModel(input: unknown): 'sections' | 'rails' | null {
  if (!isRecord(input) || input.format !== BOARD_FORMAT) return null;
  return input.model === BOARD_MODEL || input.model === RAILS_MODEL ? input.model : null;
}
