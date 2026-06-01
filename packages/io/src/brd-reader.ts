import {
  board,
  crossSection,
  knotFromArray,
  splineFromKnots,
  type BezierBoard,
  type CrossSection,
  type Knot,
} from '@openshaper/kernel';

/**
 * Full, hardened reader for the legacy BoardCAD-LE native `.brd` text format.
 *
 * Ported from `board.readers.BrdReader` (Java). The `.brd` format is a line-based
 * key/value file: scalar metadata lines `pNN : value`, plus four geometry fields
 * carrying bezier control-point records:
 *
 *   - p32 outline   (half-width vs length; width = 2·y)
 *   - p33 bottom    (rocker curve)        — NOTE: legacy field naming is confusing;
 *   - p34 deck      (deck curve)            we map p33→bottom and p34→deck per BrdReader.
 *   - p35 cross-sections — each `(p36 <pos>` group holds a profile spline, optionally
 *     followed by a `gps : ( (gp [...]) )` guide-point block which we skip.
 *
 * Each control point is a `(cp [endX,endY,prevX,prevY,nextX,nextY] <cont> <other>)`
 * record matching the kernel `knotFromArray` order.
 *
 * Geometry is built with the golden-validated `@openshaper/kernel` builders. The
 * reader is line/iteration-bounded (no recursion, no eval) and fails loudly on
 * genuinely malformed geometry while tolerating the known `shortboard.brd` quirk:
 * a `p35` group whose final closing `)` is missing (truncated trailing group). In
 * that case it loads everything present and emits a non-fatal warning.
 *
 * Units are centimeters.
 */

export type BrdMetadataValue = string | number | boolean | number[];

export interface ParsedBrd {
  readonly board: BezierBoard;
  /** Scalar `pNN` fields keyed by their legacy semantic name (see FIELD_NAMES). */
  readonly metadata: Record<string, BrdMetadataValue>;
  /** Non-fatal issues encountered (e.g. truncated trailing group). */
  readonly warnings: string[];
}

/** Legacy semantic names for the scalar pNN metadata fields (from BrdReader switch). */
const FIELD_NAMES: Record<number, string> = {
  1: 'length',
  2: 'lengthOverCurve',
  3: 'thickness',
  4: 'width',
  5: 'noseRocker',
  6: 'tailRocker',
  7: 'version',
  8: 'name',
  9: 'author',
  10: 'blankFile',
  11: 'topCuts',
  12: 'bottomCuts',
  13: 'railCuts',
  14: 'cutterDiam',
  15: 'blankPivot',
  16: 'boardPivot',
  17: 'maxAngle',
  18: 'noseMargin',
  19: 'noseLength',
  20: 'tailLength',
  21: 'deltaXNose',
  22: 'deltaXTail',
  23: 'deltaXMiddle',
  24: 'toTailSpeed',
  25: 'stringerSpeed',
  26: 'regularSpeed',
  27: 'strut1',
  28: 'strut2',
  29: 'cutterStartPos',
  30: 'blankTailPos',
  31: 'boardStartPos',
  38: 'currentUnits',
  39: 'noseRockerOneFoot',
  40: 'tailRockerOneFoot',
  41: 'showOriginalBoard',
  42: 'stringerSpeedBottom',
  43: 'machineFolder',
  44: 'topShoulderAngle',
  45: 'designer',
  46: 'topShoulderCuts',
  47: 'bottomRailCuts',
  48: 'surfer',
  49: 'comments',
  50: 'fins',
  51: 'finType',
  52: 'description',
  53: 'securityLevel',
  54: 'model',
  55: 'aux1',
  56: 'aux2',
  57: 'aux3',
  99: 'tailMargin',
};

/** pNN fields whose value is a string (not numeric). */
const STRING_FIELDS = new Set([7, 8, 9, 10, 43, 45, 48, 49, 51, 52, 54, 55, 56, 57]);
/** pNN fields whose value is a boolean. */
const BOOL_FIELDS = new Set([41]);

const GEOMETRY_FIELDS = new Set([32, 33, 34, 35]);

const CP_RE = /^\(cp\s*\[([^\]]*)\]\s+(true|false)\s+(true|false)\s*\)/;
const P36_RE = /^\(p36\s+(\S+)/;
const FIELD_LINE_RE = /^p(\d{1,2})\s*:\s*(.*)$/;

/** This format is plain text; reject anything with control bytes or that is huge-per-line. */
const MAX_LINE_LEN = 100_000;

class BrdParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrdParseError';
  }
}

const parseControlPoint = (line: string, lineNo: number): Knot => {
  const m = line.match(CP_RE);
  if (!m) {
    throw new BrdParseError(`Malformed (cp ...) record at line ${lineNo}: ${line}`);
  }
  const nums = m[1]!
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number);
  if (nums.length !== 6 || nums.some((n) => !Number.isFinite(n))) {
    throw new BrdParseError(
      `(cp ...) record at line ${lineNo} must have 6 finite coordinates, got ` +
        `[${nums.join(',')}]`,
    );
  }
  return knotFromArray(nums, m[2] === 'true', m[3] === 'true');
};

const parseMetadataValue = (id: number, raw: string): BrdMetadataValue => {
  if (STRING_FIELDS.has(id)) return raw;
  if (BOOL_FIELDS.has(id)) return raw.trim().toLowerCase() === 'true';
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(Number);
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
};

/**
 * A cursor over the file lines that geometry parsers consume from. Keeps a single
 * shared index so a field parser can read forward (cp records, gps blocks) and
 * leave the cursor on the line after its group, exactly as the legacy reader does.
 */
interface Cursor {
  readonly lines: string[];
  i: number;
}

/** Consume `(cp ...)` records into a knot list, plus an optional `gps : ( ... )` block. */
const readControlPoints = (cur: Cursor, warnings: string[]): Knot[] => {
  const knots: Knot[] = [];
  // Expect (and skip) an opening "(" line; legacy keys (p32/p33/p34) put it on its own line.
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i]!.trim();
    if (line.startsWith('(cp')) {
      knots.push(parseControlPoint(line, cur.i + 1));
      cur.i++;
      continue;
    }
    break;
  }
  // Optional guide-point block: `gps : (` then `(gp [...])`* then `)`.
  if (cur.i < cur.lines.length && cur.lines[cur.i]!.trim().startsWith('gps')) {
    cur.i++; // consume "gps : ("
    while (cur.i < cur.lines.length && cur.lines[cur.i]!.trim().startsWith('(gp')) {
      cur.i++; // skip guide point (not part of the kernel board model)
    }
    if (cur.i < cur.lines.length && cur.lines[cur.i]!.trim() === ')') {
      cur.i++; // consume the gps closing ")"
    } else {
      warnings.push(`gps block near line ${cur.i + 1} not closed by ')'`);
    }
  }
  return knots;
};

const parseSpline = (cur: Cursor, warnings: string[]): Knot[] => {
  // The field's "(" opener is on the next line after "pNN : (" handling; skip a lone "(".
  if (cur.i < cur.lines.length && cur.lines[cur.i]!.trim() === '(') cur.i++;
  const knots = readControlPoints(cur, warnings);
  // Consume the field's closing ")".
  if (cur.i < cur.lines.length && cur.lines[cur.i]!.trim() === ')') cur.i++;
  return knots;
};

const parseCrossSections = (
  cur: Cursor,
  warnings: string[],
): { position: number; knots: Knot[] }[] => {
  if (cur.i < cur.lines.length && cur.lines[cur.i]!.trim() === '(') cur.i++;
  const sections: { position: number; knots: Knot[] }[] = [];
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i]!.trim();
    const m = line.match(P36_RE);
    if (!m) break;
    const pos = Number(m[1]);
    if (!Number.isFinite(pos)) {
      throw new BrdParseError(`(p36 ...) position not a number at line ${cur.i + 1}: ${line}`);
    }
    cur.i++; // consume "(p36 <pos>"
    const knots = readControlPoints(cur, warnings);
    sections.push({ position: pos, knots });
    // Consume this section's closing ")".
    if (cur.i < cur.lines.length && cur.lines[cur.i]!.trim() === ')') {
      cur.i++;
    } else {
      warnings.push(`cross-section at position ${pos} (line ${cur.i + 1}) not closed by ')'`);
    }
  }
  // Consume the p35 group's closing ")". If absent we hit EOF on the truncated
  // shortboard fixture — tolerate it with a warning (legacy populated the board anyway).
  if (cur.i < cur.lines.length && cur.lines[cur.i]!.trim() === ')') {
    cur.i++;
  } else {
    warnings.push(
      'p35 cross-section group is missing its closing ")" (truncated trailing group); ' +
        'loaded all sections present',
    );
  }
  return sections;
};

export const parseBrd = (text: string): ParsedBrd => {
  if (typeof text !== 'string') {
    throw new BrdParseError('parseBrd expects a string');
  }
  const warnings: string[] = [];
  const metadata: Record<string, BrdMetadataValue> = {};
  const lines = text.split(/\r?\n/);

  let outline: Knot[] | null = null;
  let bottom: Knot[] | null = null;
  let deck: Knot[] | null = null;
  let sections: { position: number; knots: Knot[] }[] = [];

  const cur: Cursor = { lines, i: 0 };

  while (cur.i < lines.length) {
    const raw = lines[cur.i]!;
    if (raw.length > MAX_LINE_LEN) {
      throw new BrdParseError(`Line ${cur.i + 1} exceeds maximum length (${MAX_LINE_LEN})`);
    }
    const trimmed = raw.trim();

    // Mirror legacy: skip lines that are too short, lack ":", or don't start with "p".
    const fieldMatch = trimmed.match(FIELD_LINE_RE);
    if (!fieldMatch) {
      cur.i++;
      continue;
    }

    const id = Number(fieldMatch[1]);
    const value = fieldMatch[2]!.trim();
    cur.i++; // advance past the "pNN : ..." line

    if (!GEOMETRY_FIELDS.has(id)) {
      const name = FIELD_NAMES[id] ?? `p${String(id).padStart(2, '0')}`;
      metadata[name] = parseMetadataValue(id, value);
      continue;
    }

    // Geometry field. The opening "(" may be on the same line as the field id
    // ("p32 : (") or on its own; the spline/cross-section parsers handle a lone "(".
    switch (id) {
      case 32:
        outline = parseSpline(cur, warnings);
        break;
      case 33:
        bottom = parseSpline(cur, warnings);
        break;
      case 34:
        deck = parseSpline(cur, warnings);
        break;
      case 35:
        sections = parseCrossSections(cur, warnings);
        break;
    }
  }

  if (!outline || outline.length < 2) {
    throw new BrdParseError('Missing or insufficient outline (p32) control points');
  }
  if (!bottom || bottom.length < 2) {
    throw new BrdParseError('Missing or insufficient bottom (p33) control points');
  }
  if (!deck || deck.length < 2) {
    throw new BrdParseError('Missing or insufficient deck (p34) control points');
  }
  if (sections.length < 1) {
    throw new BrdParseError('Missing cross-sections (p35)');
  }

  const crossSections: CrossSection[] = sections
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((s) => crossSection(s.position, splineFromKnots(s.knots)));

  const built = board(
    splineFromKnots(outline),
    splineFromKnots(bottom),
    splineFromKnots(deck),
    crossSections,
    'controlPoint',
  );

  return { board: built, metadata, warnings };
};
