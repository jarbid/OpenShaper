import {
  board,
  crossSection,
  knot,
  splineFromKnots,
  vec2,
  type BezierBoard,
  type Knot,
  type Spline,
} from '@openshaper/kernel';

/**
 * Native OpenShaper document format (`.board.json`) — a clean, versioned,
 * lossless serialization of a kernel BezierBoard. Unlike the legacy `.brd` text
 * format this is schema-stable and round-trips exactly.
 *
 * The `format` marker is written as `'openshaper'`; documents written by the
 * project's former name (`'board-studio'`) are still accepted on read.
 */
export const BOARD_JSON_VERSION = 1;

type Vec2Tuple = [number, number];
interface KnotJson {
  e: Vec2Tuple; // endpoint
  p: Vec2Tuple; // tangent to prev
  n: Vec2Tuple; // tangent to next
  c: boolean; // continuous
  o: boolean; // "other" flag
}
interface CrossSectionJson {
  position: number;
  knots: KnotJson[];
}
export interface BoardJson {
  format: 'openshaper' | 'board-studio';
  version: number;
  interpolationType: BezierBoard['interpolationType'];
  outline: KnotJson[];
  bottom: KnotJson[];
  deck: KnotJson[];
  crossSections: CrossSectionJson[];
  metadata?: Record<string, unknown>;
}

const knotToJson = (k: Knot): KnotJson => ({
  e: [k.end.x, k.end.y],
  p: [k.tangentToPrev.x, k.tangentToPrev.y],
  n: [k.tangentToNext.x, k.tangentToNext.y],
  c: k.continuous,
  o: k.other,
});

const knotFromJson = (j: KnotJson): Knot =>
  knot(vec2(j.e[0], j.e[1]), vec2(j.p[0], j.p[1]), vec2(j.n[0], j.n[1]), j.c, j.o);

const splineToJson = (s: Spline): KnotJson[] => s.knots.map(knotToJson);
const splineFromJson = (ks: KnotJson[]): Spline => splineFromKnots(ks.map(knotFromJson));

/** Serialize a board to a `.board.json` string. */
export const writeBoardJson = (b: BezierBoard, metadata?: Record<string, unknown>): string => {
  const doc: BoardJson = {
    format: 'openshaper',
    version: BOARD_JSON_VERSION,
    interpolationType: b.interpolationType,
    outline: splineToJson(b.outline),
    bottom: splineToJson(b.bottom),
    deck: splineToJson(b.deck),
    crossSections: b.crossSections.map((cs) => ({
      position: cs.position,
      knots: splineToJson(cs.spline),
    })),
    ...(metadata ? { metadata } : {}),
  };
  return JSON.stringify(doc, null, 2);
};

export class BoardJsonError extends Error {}

/** Parse a `.board.json` string back into a board (+ any metadata). */
export const readBoardJson = (
  text: string,
): { board: BezierBoard; metadata?: Record<string, unknown> } => {
  let doc: BoardJson;
  try {
    doc = JSON.parse(text) as BoardJson;
  } catch (e) {
    throw new BoardJsonError(`Not valid JSON: ${(e as Error).message}`);
  }
  if (doc.format !== 'openshaper' && doc.format !== 'board-studio') {
    throw new BoardJsonError('Not an OpenShaper document (missing format marker)');
  }
  if (doc.version > BOARD_JSON_VERSION) {
    throw new BoardJsonError(
      `Document version ${doc.version} is newer than supported (${BOARD_JSON_VERSION})`,
    );
  }
  const b = board(
    splineFromJson(doc.outline),
    splineFromJson(doc.bottom),
    splineFromJson(doc.deck),
    doc.crossSections.map((cs) => crossSection(cs.position, splineFromJson(cs.knots))),
    doc.interpolationType ?? 'controlPoint',
  );
  return doc.metadata ? { board: b, metadata: doc.metadata } : { board: b };
};
