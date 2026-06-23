/**
 * Reader for the Shape3d `.s3d` XML board format.
 *
 * Ported from `board.readers.S3dReader` (Java):
 *   - `loadFile(BezierBoard, String)`          lines 33–219
 *   - `readBezierAndGuidePoints(...)` lines 221–353
 *
 * The format is an XML document rooted at `<Shape3d_design>` containing a
 * `<Board>` child. The board geometry is stored as 3-D Bezier splines with
 * separate Control_points / Tangents_1 / Tangents_2 Polygone3d lists. Each
 * Point3d has `<x>`, `<y>`, `<z>` children. Index 0 in each list is a
 * "symmetry point" that the Java reader discards; real knots start at index 1.
 *
 * Plane projections (S3dReader.java lines 258–286):
 *   Outline  XY:  end=(cx,cy),  prev=(t1x,t1y),  next=(t2x,t2y)
 *   Bottom   XZ:  end=(cx,cz),  prev=(t1x,t1z),  next=(t2x,t2z)
 *   Deck     XZ:  same
 *   Sections YZ:  end=(cy,cz),  prev=(t1y,t1z),  next=(t2y,t2z)
 *
 * Cross-section position: `Control_points/Polygone3d/Point3d[1].x`
 * (S3dReader.java line 145–148 — Point3d at list-index 1, the first real
 * data point's x coordinate).
 *
 * After all sections are parsed (S3dReader.java lines 166–181):
 *   1. First section position → 0.2
 *   2. Last section position  → length − 0.2
 *   3. Dummy tail section (single zero-knot) prepended at position 0.0
 *   4. Dummy nose section (single zero-knot) appended at position = length
 *
 * Internal units are centimetres. Shape3d files store centimetres directly
 * (the Java reader applies no unit conversion).
 *
 * No DOM dependency: uses a minimal regex-based tolerant XML extractor so
 * this module remains pure (runs in Node tests without a browser).
 */

import {
  board,
  crossSection,
  knot,
  splineFromKnots,
  type BezierBoard,
  type CrossSection,
  type Knot,
} from '@openshaper/kernel';
import { vec2 } from '@openshaper/kernel';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ParsedS3d {
  readonly board: BezierBoard;
  /** Selected scalar fields from the Board element. */
  readonly metadata?: {
    model?: string;
    designer?: string;
    comments?: string;
  };
  /** Non-fatal issues (e.g. missing Deck — synthetic curve generated). */
  readonly warnings: string[];
}

/** `.s3dx` shares the parsed shape of `.s3d`. */
export type ParsedS3dx = ParsedS3d;

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

class S3dParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'S3dParseError';
  }
}

// ---------------------------------------------------------------------------
// Minimal tolerant XML parser
//
// We need to extract named child elements and their text content without a
// DOM. The strategy:
//   - Strip XML comments first.
//   - `getChildText(xml, tag)` — returns the trimmed text of the first
//     occurrence of <tag>…</tag>, or null.
//   - `getChildElement(xml, tag)` — returns the raw inner content of the
//     first <tag>…</tag> element.
//   - `getAllChildElements(xml, tag)` — returns all inner contents of every
//     <tag>…</tag> element in document order (handles nested elements).
// ---------------------------------------------------------------------------

const stripComments = (xml: string): string => xml.replace(/<!--[\s\S]*?-->/g, '');

/**
 * Returns the trimmed inner text content of the FIRST occurrence of `<tag>`
 * in `xml`. Returns null if the tag is absent.
 *
 * The regex matches non-greedy content that does NOT itself contain the same
 * opening tag, so it handles sibling elements but not deeply nested same-name
 * elements. For the Shape3d format's simple structure this is sufficient.
 */
const getChildText = (xml: string, tag: string): string | null => {
  // Escape any regex-special chars in tag names (Shape3d tags are plain
  // alphanumeric + underscore so this is defensive only).
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i');
  const m = xml.match(re);
  return m ? m[1]!.trim() : null;
};

/**
 * Returns the raw inner content (between open and close tags) of the FIRST
 * `<tag>` element found in `xml`, or null if absent. This is used when the
 * content is itself XML that we want to parse further.
 */
const getChildElement = (xml: string, tag: string): string | null => {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Use a non-greedy match that allows nested elements.
  const re = new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i');
  const m = xml.match(re);
  return m ? m[1]! : null;
};

/**
 * Returns inner contents of ALL occurrences of `<tag>` in `xml`, in
 * document order. Non-greedy — suitable for flat lists like Point3d children.
 */
const getAllChildElements = (xml: string, tag: string): string[] => {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'gi');
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1]!);
  }
  return results;
};

// ---------------------------------------------------------------------------
// Point3d extraction
// ---------------------------------------------------------------------------

interface Point3d {
  x: number;
  y: number;
  z: number;
}

const parsePoint3d = (inner: string): Point3d => {
  const xStr = getChildText(inner, 'x');
  const yStr = getChildText(inner, 'y');
  const zStr = getChildText(inner, 'z');
  const x = xStr !== null ? Number(xStr) : NaN;
  const y = yStr !== null ? Number(yStr) : NaN;
  const z = zStr !== null ? Number(zStr) : NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new S3dParseError(`Point3d has non-finite coordinates: x=${xStr} y=${yStr} z=${zStr}`);
  }
  return { x, y, z };
};

/**
 * Extract an ordered list of Point3d objects from a Polygone3d inner XML.
 * Returns them in document order (index 0 = symmetry dummy, 1..N = real data).
 */
const parsePolygone3d = (polygoneXml: string): Point3d[] => {
  const ptInners = getAllChildElements(polygoneXml, 'Point3d');
  return ptInners.map(parsePoint3d);
};

// ---------------------------------------------------------------------------
// Plane-projection constants (S3dReader.java lines 27–29)
// ---------------------------------------------------------------------------

const PLANE_XY = 0; // Outline
const PLANE_XZ = 1; // Bottom / Deck
const PLANE_YZ = 2; // Cross-sections

// ---------------------------------------------------------------------------
// readBezierAndGuidePoints (S3dReader.java lines 221–353)
// ---------------------------------------------------------------------------

/**
 * Parse a `<Bezier3d>` element, projecting 3-D points onto the chosen plane
 * and building kernel Knots. Guide points are parsed but discarded (not part
 * of the kernel board model). Returns knots in document order (symmetry dummy
 * at index 0 excluded — the Java loop runs `for (int i=1; i < nrOfPoints+1)`.
 */
const readBezierKnots = (bezierXml: string, plane: number): Knot[] => {
  const ctrlXml = getChildElement(bezierXml, 'Control_points');
  const tan1Xml = getChildElement(bezierXml, 'Tangents_1');
  const tan2Xml = getChildElement(bezierXml, 'Tangents_2');

  if (!ctrlXml || !tan1Xml || !tan2Xml) {
    throw new S3dParseError('Bezier3d is missing Control_points, Tangents_1, or Tangents_2');
  }

  const ctrlPoly = getChildElement(ctrlXml, 'Polygone3d');
  const tan1Poly = getChildElement(tan1Xml, 'Polygone3d');
  const tan2Poly = getChildElement(tan2Xml, 'Polygone3d');

  if (!ctrlPoly || !tan1Poly || !tan2Poly) {
    throw new S3dParseError('Bezier3d Polygone3d element missing');
  }

  const nbStr = getChildText(ctrlPoly, 'Nb_of_points');
  if (nbStr === null) {
    throw new S3dParseError('Nb_of_points missing from Polygone3d');
  }
  const nrOfPoints = parseInt(nbStr, 10);
  if (!Number.isFinite(nrOfPoints) || nrOfPoints < 0) {
    throw new S3dParseError(`Invalid Nb_of_points: ${nbStr}`);
  }

  const ctrlPts = parsePolygone3d(ctrlPoly);
  const tan1Pts = parsePolygone3d(tan1Poly);
  const tan2Pts = parsePolygone3d(tan2Poly);

  // Java: "Disregard first as it's the symmetry point" → loop starts at i=1.
  // Java: for (int i = 1; i < nrOfPoints + 1; i++)
  const knots: Knot[] = [];
  for (let i = 1; i <= nrOfPoints; i++) {
    const cp = ctrlPts[i];
    const t1 = tan1Pts[i];
    const t2 = tan2Pts[i];

    if (!cp || !t1 || !t2) {
      throw new S3dParseError(
        `Point3d index ${i} missing from Control_points/Tangents_1/Tangents_2`,
      );
    }

    // Plane projection (S3dReader.java lines 258–286)
    let p1x: number, p1y: number; // end
    let p2x: number, p2y: number; // tangentToPrev (Tangents_1)
    let p3x: number, p3y: number; // tangentToNext (Tangents_2)

    switch (plane) {
      case PLANE_XY:
        p1x = cp.x;
        p1y = cp.y;
        p2x = t1.x;
        p2y = t1.y;
        p3x = t2.x;
        p3y = t2.y;
        break;
      case PLANE_XZ:
        p1x = cp.x;
        p1y = cp.z;
        p2x = t1.x;
        p2y = t1.z;
        p3x = t2.x;
        p3y = t2.z;
        break;
      case PLANE_YZ:
      default:
        p1x = cp.y;
        p1y = cp.z;
        p2x = t1.y;
        p2y = t1.z;
        p3x = t2.y;
        p3y = t2.z;
        break;
    }

    // Tangent type: 0 → discontinuous, else → continuous
    // (S3dReader.java lines 293–303)
    const typeTag = `Tangent_type_point_${i - 1}`;
    const typeStr = getChildText(bezierXml, typeTag);
    const typeVal = typeStr !== null ? parseInt(typeStr.trim(), 10) : 1;
    const continuous = typeVal !== 0;

    knots.push(knot(vec2(p1x, p1y), vec2(p2x, p2y), vec2(p3x, p3y), continuous, false));
  }

  return knots;
};

// ---------------------------------------------------------------------------
// Outline post-processing (S3dReader.java lines 56–76)
//
// If the first or last outline control point's half-width (y) > 1.0, the Java
// inserts a sharpened end-cap knot to close the nose/tail to y=0. We replicate
// this so tails/noses with blunt outlines snap cleanly.
// ---------------------------------------------------------------------------

const postProcessOutlineKnots = (knots: Knot[]): Knot[] => {
  let result = [...knots];

  // First knot: if end.y > 1.0, set tangent and prepend a zero-y knot.
  // Java lines 56–63:
  //   controlPoint(0).setContinous(false)
  //   controlPoint(0).getPoints()[1].y = controlPoint(0).getPoints()[0].y * 2/3   (tangentToPrev)
  //   prepend a new BezierKnot with points[2].y = controlPoint(0).getPoints()[0].y / 3
  if (result.length > 0 && result[0]!.end.y > 1.0) {
    const first = result[0]!;
    // Java sets getPoints()[1].y = end.y * 2/3 — getPoints()[1] is tangentToPrev
    const newFirst = knot(
      first.end,
      vec2(first.tangentToPrev.x, first.end.y * (2 / 3)), // tangentToPrev.y = end.y * 2/3
      first.tangentToNext,
      false,
      first.other,
    );
    const prepended = knot(vec2(0, 0), vec2(0, 0), vec2(0, first.end.y / 3), true, false);
    result = [prepended, newFirst, ...result.slice(1)];
  }

  // Last knot: if end.y > 1.0, set tangent and append a zero-y knot.
  // Java lines 65–76:
  //   last.setContinous(false)
  //   last.getPoints()[2].x = last.getPoints()[0].x                         (tangentToNext.x)
  //   last.getPoints()[2].y = last.getPoints()[0].y * 2/3                   (tangentToNext.y)
  //   append new BezierKnot with points[0].x = last.end.x,
  //     points[1].x = same x, points[1].y = last.end.y / 3, points[2].x = same x
  const lastIdx = result.length - 1;
  if (lastIdx >= 0 && result[lastIdx]!.end.y > 1.0) {
    const last = result[lastIdx]!;
    const newLast = knot(
      last.end,
      last.tangentToPrev,
      vec2(last.end.x, last.end.y * (2 / 3)),
      false,
      last.other,
    );
    const appended = knot(
      vec2(last.end.x, 0),
      vec2(last.end.x, last.end.y / 3),
      vec2(last.end.x, 0),
      true,
      false,
    );
    result = [...result.slice(0, lastIdx), newLast, appended];
  }

  return result;
};

// ---------------------------------------------------------------------------
// Deck fallback (S3dReader.java lines 79–125)
//
// When the `<Deck>` element is absent, the Java builds a synthetic 3-knot deck
// from the bottom endpoints and a computed maximum thickness. We replicate the
// same formula (S3dReader.java lines 89–126) so import succeeds with a warning.
// ---------------------------------------------------------------------------

const INCH_CM = 2.54; // UnitUtils.INCH

const buildSyntheticDeck = (bottomKnots: Knot[], length: number): Knot[] => {
  // Java lines 89–125 (simplified):
  // clone bottom[0], shift y up 1.5, set tangentToNext.x=20, tangentToNext.y -= 0.5
  // middle knot at length/2 with y = thickness formula
  // clone bottom[last], shift y up 1.5, adjust tangents
  // Then at lines 117–125 prepend/append bottom endpoints to the deck too.

  const b0 = bottomKnots[0]!;
  const bLast = bottomKnots[bottomKnots.length - 1]!;

  // Synthetic thickness: ((length/(12*INCH_CM) - 5) / 4 * 1) + 2.125*INCH_CM
  const thickness = ((length / (12 * INCH_CM) - 5) / 4) * 1 + 2.125 * INCH_CM;

  const kFirst = knot(
    vec2(b0.end.x, b0.end.y + 1.5),
    vec2(b0.tangentToPrev.x, b0.tangentToPrev.y),
    vec2(20, b0.end.y + 1.5 - 0.5),
    false,
    false,
  );
  const kMid = knot(
    vec2(length / 2, thickness),
    vec2(length / 2 - 50, thickness),
    vec2(length / 2 + 50, thickness),
    true,
    false,
  );
  // Java: clone bottom[last], then:
  //   getPoints()[0].y += 1.5                                     (end.y)
  //   getPoints()[1].y += getPoints()[0].y / 2                    (tangentToPrev.y += newEnd.y / 2)
  //   getPoints()[2].x = getPoints()[0].x                         (tangentToNext.x = end.x)
  //   getPoints()[2].y += 0.8                                     (tangentToNext.y += 0.8)
  const kLast = knot(
    vec2(bLast.end.x, bLast.end.y + 1.5),
    vec2(bLast.tangentToPrev.x, bLast.tangentToPrev.y + (bLast.end.y + 1.5) / 2),
    vec2(bLast.end.x, bLast.tangentToNext.y + 0.8),
    false,
    false,
  );

  // Add bottom endpoints (lines 117–125)
  const deckFirst = knot(
    vec2(b0.end.x, b0.end.y),
    vec2(b0.end.x, b0.end.y),
    vec2(0, (kFirst.end.y - b0.end.y) / 2 + b0.end.y),
    b0.continuous,
    b0.other,
  );
  const deckLast = knot(
    vec2(bLast.end.x, bLast.end.y),
    vec2(bLast.end.x, (kLast.end.y - bLast.end.y) / 2 + bLast.end.y),
    vec2(bLast.end.x, bLast.end.y),
    bLast.continuous,
    bLast.other,
  );

  return [deckFirst, kFirst, kMid, kLast, deckLast];
};

// ---------------------------------------------------------------------------
// Deck endpoint injection (S3dReader.java lines 117–125)
//
// After reading the real deck (or building the synthetic one), the Java prepends
// and appends bottom endpoint clones with adjusted tangentToNext/tangentToPrev:
//   prepend: clone of bottom[0] with tangentToNext.x=0,
//            tangentToNext.y = (deck[0].end.y - bottom[0].end.y)/2 + bottom[0].end.y
//   append:  clone of bottom[last] with tangentToPrev.x = bottom[last].end.x,
//            tangentToPrev.y = (deck[last].end.y - bottom[last].end.y)/2 + bottom[last].end.y
// ---------------------------------------------------------------------------

const injectDeckEndpoints = (deckKnots: Knot[], bottomKnots: Knot[]): Knot[] => {
  const b0 = bottomKnots[0]!;
  const bLast = bottomKnots[bottomKnots.length - 1]!;
  const d0 = deckKnots[0]!;
  const dLast = deckKnots[deckKnots.length - 1]!;

  const prepended = knot(
    b0.end,
    b0.tangentToPrev,
    vec2(0, (d0.end.y - b0.end.y) / 2 + b0.end.y),
    b0.continuous,
    b0.other,
  );
  const appended = knot(
    bLast.end,
    vec2(bLast.end.x, (dLast.end.y - bLast.end.y) / 2 + bLast.end.y),
    bLast.tangentToNext,
    bLast.continuous,
    bLast.other,
  );

  return [prepended, ...deckKnots, appended];
};

// ---------------------------------------------------------------------------
// Cross-section height normalisation (S3dReader.java lines 155–163)
//
// The Java subtracts `spline.getControlPoint(0).getPoints()[0].y` (the first
// knot's end.y) from every knot's y-coordinates. This shifts the section
// so the bottom centerline is at y=0.
// ---------------------------------------------------------------------------

const normaliseSectionHeight = (knots: Knot[]): Knot[] => {
  if (knots.length === 0) return knots;
  const height = knots[0]!.end.y;
  if (height === 0) return knots;
  return knots.map((k) =>
    knot(
      vec2(k.end.x, k.end.y - height),
      vec2(k.tangentToPrev.x, k.tangentToPrev.y - height),
      vec2(k.tangentToNext.x, k.tangentToNext.y - height),
      k.continuous,
      k.other,
    ),
  );
};

// ---------------------------------------------------------------------------
// Zero dummy knot (used for tail/nose dummies matching legacy BezierKnot())
// ---------------------------------------------------------------------------

const zeroDummyKnot = (): Knot => knot(vec2(0, 0), vec2(0, 0), vec2(0, 0), true, false);

// ---------------------------------------------------------------------------
// Main parser (shared core)
//
// The `.s3d` and `.s3dx` formats are structurally identical (same Bezier3d /
// Couples_N geometry). They differ only in which element names hold the three
// main curves, plus the `.s3dx`-only `<Protection>` flag and a `"Ref. point"`
// text fix-up. The core below is parameterized over those differences so both
// readers share the golden-tested geometry code.
// ---------------------------------------------------------------------------

interface Shape3dOptions {
  /** Human-readable format name for error messages, e.g. ".s3d" / ".s3dx". */
  readonly formatName: string;
  /** Element name holding the outline curve (XY). */
  readonly outlineTag: string;
  /**
   * Optional fallback outline element used when `outlineTag` is absent. Some
   * Shape3d `.s3dx` exports omit the apex outline (`curveDefTop2`) and only
   * carry the narrower top curve (`curveDefTop1`); falling back lets those
   * files load (with a warning) where the legacy reader would have failed.
   */
  readonly outlineFallbackTag?: string;
  /** Element name holding the bottom curve (XZ). */
  readonly bottomTag: string;
  /** Element name holding the deck/thickness curve (XZ); may be absent in the file. */
  readonly deckTag: string;
  /** When true, apply the `"Ref. point"` → `"Ref.point"` text fix-up (`.s3dx`). */
  readonly refPointFix?: boolean;
  /** When true, honour a `<Protection>` flag and reject protected boards (`.s3dx`). */
  readonly checkProtection?: boolean;
}

const parseShape3d = (text: string, opts: Shape3dOptions): ParsedS3d => {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new S3dParseError(`parse${opts.formatName} expects a non-empty string`);
  }

  // S3dxReader.java line 44: normalise the "Ref. point" tag spelling.
  const fixed = opts.refPointFix ? text.replace(/Ref\. point/g, 'Ref.point') : text;
  const xml = stripComments(fixed);

  // --- Root element: <Shape3d_design> ---
  const shape3dXml = getChildElement(xml, 'Shape3d_design');
  if (!shape3dXml) {
    throw new S3dParseError(
      `No <Shape3d_design> root element found — not a valid ${opts.formatName} file`,
    );
  }

  // --- <Board> child ---
  const boardXml = getChildElement(shape3dXml, 'Board');
  if (!boardXml) {
    throw new S3dParseError('No <Board> element found inside <Shape3d_design>');
  }

  // --- Protection flag (S3dxReader.java lines 50–54) ---
  if (opts.checkProtection) {
    const protStr = getChildText(boardXml, 'Protection');
    if (protStr !== null && Number(protStr) > 0) {
      throw new S3dParseError(
        'This board is password-protected in Shape3d and cannot be imported.',
      );
    }
  }

  const warnings: string[] = [];

  // --- Outline (XY plane) ---
  let outlineTagUsed = opts.outlineTag;
  let outlineXml = getChildElement(boardXml, opts.outlineTag);
  if (!outlineXml && opts.outlineFallbackTag) {
    outlineXml = getChildElement(boardXml, opts.outlineFallbackTag);
    if (outlineXml) {
      outlineTagUsed = opts.outlineFallbackTag;
      warnings.push(
        `No <${opts.outlineTag}> (apex outline) element — falling back to ` +
          `<${opts.outlineFallbackTag}>; outline width may be slightly narrower than nominal`,
      );
    }
  }
  if (!outlineXml) {
    throw new S3dParseError(`Missing <${opts.outlineTag}> (outline) element in <Board>`);
  }
  const outlineBezierXml = getChildElement(outlineXml, 'Bezier3d');
  if (!outlineBezierXml) {
    throw new S3dParseError(`<${outlineTagUsed}> (outline) has no <Bezier3d> child`);
  }
  let outlineKnots = readBezierKnots(outlineBezierXml, PLANE_XY);
  if (outlineKnots.length < 2) {
    throw new S3dParseError(
      `Outline Bezier3d has ${outlineKnots.length} knot(s); at least 2 required`,
    );
  }
  // Post-process end-cap zeroing (S3dReader.java lines 56–76)
  outlineKnots = postProcessOutlineKnots(outlineKnots);

  // --- Bottom (XZ plane) ---
  const bottomXml = getChildElement(boardXml, opts.bottomTag);
  if (!bottomXml) {
    throw new S3dParseError(`Missing <${opts.bottomTag}> (bottom) element in <Board>`);
  }
  const bottomBezierXml = getChildElement(bottomXml, 'Bezier3d');
  if (!bottomBezierXml) {
    throw new S3dParseError(`<${opts.bottomTag}> (bottom) has no <Bezier3d> child`);
  }
  const bottomKnots = readBezierKnots(bottomBezierXml, PLANE_XZ);
  if (bottomKnots.length < 2) {
    throw new S3dParseError(
      `Bottom Bezier3d has ${bottomKnots.length} knot(s); at least 2 required`,
    );
  }

  // --- Board length: max end.x from outline knots ---
  let length = 0;
  for (const k of outlineKnots) {
    if (k.end.x > length) length = k.end.x;
  }

  // --- Deck (XZ plane, S3dReader.java lines 79–125) ---
  let deckKnots: Knot[];
  const deckXml = getChildElement(boardXml, opts.deckTag);
  if (deckXml) {
    const deckBezierXml = getChildElement(deckXml, 'Bezier3d');
    if (!deckBezierXml) {
      throw new S3dParseError(`<${opts.deckTag}> (deck) has no <Bezier3d> child`);
    }
    const rawDeckKnots = readBezierKnots(deckBezierXml, PLANE_XZ);
    if (rawDeckKnots.length < 1) {
      throw new S3dParseError('Deck Bezier3d has no knots');
    }
    // Inject bottom endpoints (S3dReader.java lines 117–125)
    deckKnots = injectDeckEndpoints(rawDeckKnots, bottomKnots);
  } else {
    // No deck element → generate synthetic deck (S3dReader.java lines 86–113)
    warnings.push(
      `No <${opts.deckTag}> (deck) element found — generating a synthetic deck curve from ` +
        'thickness formula (S3dReader.java lines 86–113); deck shape may not be accurate',
    );
    deckKnots = buildSyntheticDeck(bottomKnots, length);
  }

  // --- Cross-sections (S3dReader.java lines 128–163) ---
  const rawSections: { position: number; knots: Knot[] }[] = [];
  for (let i = 0; ; i++) {
    const tag = `Couples_${i}`;
    const sliceXml = getChildElement(boardXml, tag);
    if (!sliceXml) break;

    // Position: Control_points/Polygone3d/Point3d[1].x
    // (S3dReader.java lines 140–148: item(1) is index 1 in the NodeList)
    const sectionBezierXml = getChildElement(sliceXml, 'Bezier3d');
    if (!sectionBezierXml) {
      warnings.push(`<${tag}> has no <Bezier3d> — skipped`);
      continue;
    }
    const sectionCtrlXml = getChildElement(sectionBezierXml, 'Control_points');
    const sectionPolyXml = sectionCtrlXml ? getChildElement(sectionCtrlXml, 'Polygone3d') : null;
    if (!sectionPolyXml) {
      warnings.push(`<${tag}> Bezier3d missing Control_points/Polygone3d — skipped`);
      continue;
    }
    const allPts = getAllChildElements(sectionPolyXml, 'Point3d');
    // index 1 = first real data point (after symmetry dummy at index 0)
    if (allPts.length < 2) {
      warnings.push(`<${tag}> has fewer than 2 Point3d entries in Control_points — skipped`);
      continue;
    }
    const posXStr = getChildText(allPts[1]!, 'x');
    const pos = posXStr !== null ? Number(posXStr) : NaN;
    if (!Number.isFinite(pos)) {
      warnings.push(`<${tag}> position x is non-finite (${posXStr}) — skipped`);
      continue;
    }

    let sectionKnots = readBezierKnots(sectionBezierXml, PLANE_YZ);
    if (sectionKnots.length < 1) {
      warnings.push(`<${tag}> at position ${pos} has no knots — skipped`);
      continue;
    }

    // Normalise height (S3dReader.java lines 155–163)
    sectionKnots = normaliseSectionHeight(sectionKnots);

    rawSections.push({ position: pos, knots: sectionKnots });
  }

  // --- Post-process sections (S3dReader.java lines 166–181) ---
  // Move first and last section positions to 0.2 and length-0.2
  if (rawSections.length >= 1) {
    rawSections[0]!.position = 0.2;
    rawSections[rawSections.length - 1]!.position = length - 0.2;
  }

  // Build kernel CrossSection objects sorted by position
  const interiorSections: CrossSection[] = rawSections
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((s) => crossSection(s.position, splineFromKnots(s.knots)));

  // Prepend dummy tail (position 0.0) and append dummy nose (position = length)
  // matching legacy `new BezierKnot(0,0,0,0,0,0)` (S3dReader.java lines 171–181)
  const tailDummy = crossSection(0, splineFromKnots([zeroDummyKnot()]));
  const noseDummy = crossSection(length, splineFromKnots([zeroDummyKnot()]));
  const allSections: CrossSection[] = [tailDummy, ...interiorSections, noseDummy];

  // --- Scalar metadata (S3dReader.java lines 183–187) ---
  const model = getChildText(boardXml, 'Name') ?? undefined;
  const designer = getChildText(boardXml, 'Author') ?? undefined;
  const comments = getChildText(boardXml, 'Comment') ?? undefined;

  // --- Build board ---
  const builtBoard = board(
    splineFromKnots(outlineKnots),
    splineFromKnots(bottomKnots),
    splineFromKnots(deckKnots),
    allSections,
    'controlPoint',
  );

  return {
    board: builtBoard,
    metadata: { model, designer, comments },
    warnings,
  };
};

// ---------------------------------------------------------------------------
// Public readers
// ---------------------------------------------------------------------------

/**
 * Parse a Shape3d `.s3d` XML string into a kernel `BezierBoard`.
 *
 * TypeScript port of `S3dReader.loadFile(BezierBoard, String)`. Accepts the
 * full text content of a `.s3d` file and returns the parsed board plus any
 * non-fatal warnings.
 *
 * @throws {S3dParseError} on malformed or structurally invalid input.
 */
export const parseS3d = (text: string): ParsedS3d =>
  parseShape3d(text, {
    formatName: '.s3d',
    outlineTag: 'Outline',
    bottomTag: 'Bottom',
    deckTag: 'Deck',
  });

/**
 * Parse a Shape3d `.s3dx` XML string into a kernel `BezierBoard`.
 *
 * TypeScript port of `S3dxReader.loadFile(BezierBoard, String)`. The `.s3dx`
 * format is identical to `.s3d` except the three main curves live in
 * `<curveDefTop2>` (outline), `<curveDefSide0>` (bottom) and `<curveDefSide4>`
 * (deck); it applies a `"Ref. point"` text fix-up; and a `<Protection>` flag
 * `> 0` marks a password-protected board, which we reject with a clear error.
 *
 * @throws {S3dParseError} on malformed input or a password-protected board.
 */
export const parseS3dx = (text: string): ParsedS3dx =>
  parseShape3d(text, {
    formatName: '.s3dx',
    outlineTag: 'curveDefTop2',
    outlineFallbackTag: 'curveDefTop1',
    bottomTag: 'curveDefSide0',
    deckTag: 'curveDefSide4',
    refPointFix: true,
    checkProtection: true,
  });
