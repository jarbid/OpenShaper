/**
 * Tests for the Shape3d (.s3d) XML reader.
 *
 * FIXTURE NOTICE: No sample .s3d files exist in the legacy boardcad-le tree.
 * The XML fixtures below are SELF-AUTHORED — they pin this port's reading of
 * the Shape3d format as inferred from `board/readers/S3dReader.java` (the
 * Java source is the sole spec oracle). They do NOT represent a legacy oracle
 * golden output; they characterize the port's correctness.
 *
 * Reference: `C:\Projects\Board_Studio\boardcad-le\src\board\readers\S3dReader.java`
 *   - `loadFile`          lines 33–219
 *   - `readBezierAndGuidePoints` lines 221–353
 *
 * Internal units: centimetres. Shape3d files also store centimetres (the
 * Java reader applies no unit conversion — values are passed directly to
 * BezierKnot.getPoints()[i].setLocation() which works in the internal cm unit).
 */

import { describe, expect, it } from 'vitest';
import { getLength, getMaxWidth, getThickness } from '@openshaper/kernel';
import { parseS3d } from './s3d-reader';

// ---------------------------------------------------------------------------
// Minimal well-formed .s3d fixture
// ---------------------------------------------------------------------------
// Board dimensions (cm):
//   length   = 180 cm (nose at x=0, tail at x=180 per the TAIL_AT_ZERO repo convention)
//   max half-width ≈ 23 cm  → full width ≈ 46 cm
//   thickness ≈ 6 cm at midpoint (deck − bottom at x=90)
//
// Shape3d coordinate system (per S3dReader.java):
//   Outline  uses XY plane:  end=(cx,cy), tangentToPrev=(t1x,t1y), tangentToNext=(t2x,t2y)
//   Bottom   uses XZ plane:  end=(cx,cz), tangentToPrev=(t1x,t1z), tangentToNext=(t2x,t2z)
//   Deck     uses XZ plane:  same mapping
//   Sections use YZ plane:   end=(cy,cz), tangentToPrev=(t1y,t1z), tangentToNext=(t2y,t2z)
//
// The reader discards Point3d[0] (symmetry point, index 0 in the Java loop)
// and starts from index 1 (Nb_of_points real data points at indices 1..N).
//
// Outline knots (XY plane, tail→nose, half-width):
//   knot0:  end=(0,0)         prev=(0,0)         next=(0,3)
//   knot1:  end=(90,23)       prev=(50,23)        next=(130,23)
//   knot2:  end=(180,0)       prev=(180,3)        next=(180,0)
//
// Bottom (XZ plane, rocker):
//   knot0:  end=(0,0)         prev=(0,0)          next=(30,0)
//   knot1:  end=(90,0.5)      prev=(60,0.5)       next=(120,0.5)
//   knot2:  end=(180,4)       prev=(150,3)        next=(180,4)
//
// Deck (XZ plane):
//   knot0:  end=(0,0)         prev=(0,0)          next=(30,0)
//   knot1:  end=(90,6.5)      prev=(60,6.5)       next=(120,6.5)
//   knot2:  end=(180,4)       prev=(150,4.5)      next=(180,4)
//
// Cross-section 0 (Couples_0) — positioned at x=90 (the Java uses Point3d[1].x):
//   YZ plane knots (half-section, bottom→rail→deck at centerline):
//     knot0:  end=(0,0)       prev=(0,0)          next=(5,0)
//     knot1:  end=(23,3)      prev=(18,3)         next=(28,3)    ← rail
//     knot2:  end=(0,6)       prev=(5,6)          next=(0,6)     ← deck centerline
//   The reader subtracts knot[0].end.y (=0) from all y, so no change.
//
// Cross-section 1 (Couples_1) — positioned at x=150:
//   knot0:  end=(0,0)        prev=(0,0)           next=(3,0)
//   knot1:  end=(15,3)       prev=(12,3)          next=(18,3)
//   knot2:  end=(0,6)        prev=(3,6)           next=(0,6)
//
// After parsing the Java:
//   1. First section (Couples_0) position → 0.2
//   2. Last section (Couples_1) position → length − 0.2 = 179.8
//   3. Dummy tail section at 0.0 (single zero-knot)
//   4. Dummy nose section at length (single zero-knot)
// So final crossSections order: [0.0 (dummy), 0.2, 179.8, 180.0 (dummy)]

const makePoint3d = (x: number, y: number, z: number): string => `
        <Point3d>
          <x>${x}</x>
          <y>${y}</y>
          <z>${z}</z>
        </Point3d>`;

const makePolygone3d = (pts: Array<[number, number, number]>): string => `
      <Polygone3d>
        <Nb_of_points>${pts.length - 1}</Nb_of_points>
${pts.map(([x, y, z]) => makePoint3d(x, y, z)).join('')}
      </Polygone3d>`;

// Build a Bezier3d element for a spline in a given plane.
// ends/prevs/nexts are [x,y,z] triples; the 0th element is the symmetry point (ignored).
const makeBezier3d = (
  ends: Array<[number, number, number]>,
  prevs: Array<[number, number, number]>,
  nexts: Array<[number, number, number]>,
  types: number[],
): string => {
  // Prepend a symmetry dummy point at index 0
  const symDummy: [number, number, number] = [0, 0, 0];
  const allEnds: Array<[number, number, number]> = [symDummy, ...ends];
  const allPrevs: Array<[number, number, number]> = [symDummy, ...prevs];
  const allNexts: Array<[number, number, number]> = [symDummy, ...nexts];

  return `
    <Bezier3d>
      <Control_points>${makePolygone3d(allEnds)}</Control_points>
      <Tangents_1>${makePolygone3d(allPrevs)}</Tangents_1>
      <Tangents_2>${makePolygone3d(allNexts)}</Tangents_2>
${types.map((t, i) => `      <Tangent_type_point_${i}>${t}</Tangent_type_point_${i}>`).join('\n')}
    </Bezier3d>`;
};

// Outline knots in XY: symmetry point + 3 real points
const outlineBezier = makeBezier3d(
  [
    [0, 0, 0],
    [90, 23, 0],
    [180, 0, 0],
  ],
  [
    [0, 0, 0],
    [50, 23, 0],
    [180, 3, 0],
  ],
  [
    [0, 3, 0],
    [130, 23, 0],
    [180, 0, 0],
  ],
  [0, 1, 0],
);

// Bottom knots in XZ
const bottomBezier = makeBezier3d(
  [
    [0, 0, 0],
    [90, 0, 0.5],
    [180, 0, 4],
  ],
  [
    [0, 0, 0],
    [60, 0, 0.5],
    [150, 0, 3],
  ],
  [
    [30, 0, 0],
    [120, 0, 0.5],
    [180, 0, 4],
  ],
  [0, 1, 0],
);

// Deck knots in XZ
const deckBezier = makeBezier3d(
  [
    [0, 0, 0],
    [90, 0, 6.5],
    [180, 0, 4],
  ],
  [
    [0, 0, 0],
    [60, 0, 6.5],
    [150, 0, 4.5],
  ],
  [
    [30, 0, 0],
    [120, 0, 6.5],
    [180, 0, 4],
  ],
  [0, 1, 0],
);

// Cross-section knots in YZ (half-section)
const makeSectionBezier = (
  ends: Array<[number, number, number]>,
  prevs: Array<[number, number, number]>,
  nexts: Array<[number, number, number]>,
  types: number[],
  posX: number,
): string => {
  // Position point at index 1 x-coordinate (what the Java reads as crossSection position)
  // The Java reads: Point3d[1].x from Control_points/Polygone3d
  // For YZ sections, the position is stored in the Point3d.x field of control point index 1
  const symDummy: [number, number, number] = [0, 0, 0];
  const posPoint: [number, number, number] = [posX, ends[0]![1], ends[0]![2]];
  const allEnds: Array<[number, number, number]> = [symDummy, posPoint, ...ends.slice(1)];
  const allPrevs: Array<[number, number, number]> = [
    symDummy,
    [posX, prevs[0]![1], prevs[0]![2]],
    ...prevs.slice(1),
  ];
  const allNexts: Array<[number, number, number]> = [
    symDummy,
    [posX, nexts[0]![1], nexts[0]![2]],
    ...nexts.slice(1),
  ];

  return `
    <Bezier3d>
      <Control_points>${makePolygone3d(allEnds)}</Control_points>
      <Tangents_1>${makePolygone3d(allPrevs)}</Tangents_1>
      <Tangents_2>${makePolygone3d(allNexts)}</Tangents_2>
${types.map((t, i) => `      <Tangent_type_point_${i}>${t}</Tangent_type_point_${i}>`).join('\n')}
    </Bezier3d>`;
};

// Re-read the Java for how cross-section position is determined:
// `String value = ((Element) controlPointsList.item(1)).getElementsByTagName("x").item(0).getTextContent();`
// i.e. Point3d at index 1 (0-indexed) in Control_points/Polygone3d → the x-coordinate.
// The Control_points list has Nb_of_points+1 entries (index 0 = symmetry dummy, 1..N = real).
// For a cross-section, Point3d[1].x is the board longitudinal position.

// Section 0 at x=90
const section0Bezier = (() => {
  const symDummy: [number, number, number] = [0, 0, 0];
  // ends: index 0=symDummy, index 1 has x=90 (position), then remaining knots
  const allEnds: Array<[number, number, number]> = [
    symDummy,
    [90, 0, 0], // knot0: y=0 (half-width), z=0 (height) → end=(0,0) in YZ
    [90, 23, 3], // knot1: rail
    [90, 0, 6], // knot2: deck center
  ];
  const allPrevs: Array<[number, number, number]> = [symDummy, [90, 0, 0], [90, 18, 3], [90, 5, 6]];
  const allNexts: Array<[number, number, number]> = [symDummy, [90, 5, 0], [90, 28, 3], [90, 0, 6]];
  const types = [0, 1, 0];
  return `
    <Bezier3d>
      <Control_points>${makePolygone3d(allEnds)}</Control_points>
      <Tangents_1>${makePolygone3d(allPrevs)}</Tangents_1>
      <Tangents_2>${makePolygone3d(allNexts)}</Tangents_2>
${types.map((t, i) => `      <Tangent_type_point_${i}>${t}</Tangent_type_point_${i}>`).join('\n')}
    </Bezier3d>`;
})();

// Section 1 at x=150
const section1Bezier = (() => {
  const symDummy: [number, number, number] = [0, 0, 0];
  const allEnds: Array<[number, number, number]> = [
    symDummy,
    [150, 0, 0],
    [150, 15, 3],
    [150, 0, 6],
  ];
  const allPrevs: Array<[number, number, number]> = [
    symDummy,
    [150, 0, 0],
    [150, 12, 3],
    [150, 3, 6],
  ];
  const allNexts: Array<[number, number, number]> = [
    symDummy,
    [150, 3, 0],
    [150, 18, 3],
    [150, 0, 6],
  ];
  const types = [0, 1, 0];
  return `
    <Bezier3d>
      <Control_points>${makePolygone3d(allEnds)}</Control_points>
      <Tangents_1>${makePolygone3d(allPrevs)}</Tangents_1>
      <Tangents_2>${makePolygone3d(allNexts)}</Tangents_2>
${types.map((t, i) => `      <Tangent_type_point_${i}>${t}</Tangent_type_point_${i}>`).join('\n')}
    </Bezier3d>`;
})();

const MINIMAL_S3D = `<?xml version="1.0" encoding="UTF-8"?>
<Shape3d_design>
  <Board>
    <Name>Test Board</Name>
    <Author>Test Author</Author>
    <Comment>Self-authored fixture</Comment>
    <Outline>
      ${outlineBezier}
    </Outline>
    <Bottom>
      ${bottomBezier}
    </Bottom>
    <Deck>
      ${deckBezier}
    </Deck>
    <Couples_0>
      ${section0Bezier}
    </Couples_0>
    <Couples_1>
      ${section1Bezier}
    </Couples_1>
  </Board>
</Shape3d_design>`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseS3d — self-authored fixture', () => {
  it('parses without throwing', () => {
    expect(() => parseS3d(MINIMAL_S3D)).not.toThrow();
  });

  it('returns a board with the correct length (180 cm)', () => {
    const { board } = parseS3d(MINIMAL_S3D);
    expect(Math.abs(getLength(board) - 180)).toBeLessThan(0.1);
  });

  it('returns a board with correct max half-width ≈ 23 cm → full width ≈ 46 cm', () => {
    const { board } = parseS3d(MINIMAL_S3D);
    expect(Math.abs(getMaxWidth(board) - 46)).toBeLessThan(2);
  });

  it('returns a board with positive thickness at midpoint', () => {
    const { board } = parseS3d(MINIMAL_S3D);
    // Deck at 90 ≈ 6.5, bottom at 90 ≈ 0.5 → thickness ≈ 6.0
    expect(getThickness(board)).toBeGreaterThan(0);
  });

  it('has 4 cross-sections (2 real + 2 dummies)', () => {
    const { board } = parseS3d(MINIMAL_S3D);
    // Java adds dummy tail (0.0) + dummy nose (length) = 4 total
    expect(board.crossSections.length).toBe(4);
  });

  it('dummy tail section is at position 0', () => {
    const { board } = parseS3d(MINIMAL_S3D);
    expect(board.crossSections[0]!.position).toBe(0);
  });

  it('first real section is moved to 0.2', () => {
    const { board } = parseS3d(MINIMAL_S3D);
    expect(board.crossSections[1]!.position).toBeCloseTo(0.2, 5);
  });

  it('last real section is moved to length - 0.2', () => {
    const { board } = parseS3d(MINIMAL_S3D);
    const len = getLength(board);
    expect(board.crossSections[2]!.position).toBeCloseTo(len - 0.2, 5);
  });

  it('dummy nose section is at position = length', () => {
    const { board } = parseS3d(MINIMAL_S3D);
    const len = getLength(board);
    expect(board.crossSections[3]!.position).toBeCloseTo(len, 5);
  });

  it('cross-sections are sorted by position ascending', () => {
    const { board } = parseS3d(MINIMAL_S3D);
    const positions = board.crossSections.map((cs) => cs.position);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]!).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it('all cross-section knot coordinates are finite', () => {
    const { board } = parseS3d(MINIMAL_S3D);
    for (const cs of board.crossSections) {
      for (const k of cs.spline.knots) {
        expect(Number.isFinite(k.end.x)).toBe(true);
        expect(Number.isFinite(k.end.y)).toBe(true);
        expect(Number.isFinite(k.tangentToPrev.x)).toBe(true);
        expect(Number.isFinite(k.tangentToPrev.y)).toBe(true);
        expect(Number.isFinite(k.tangentToNext.x)).toBe(true);
        expect(Number.isFinite(k.tangentToNext.y)).toBe(true);
      }
    }
  });

  it('all outline knot coordinates are finite', () => {
    const { board } = parseS3d(MINIMAL_S3D);
    for (const k of board.outline.knots) {
      expect(Number.isFinite(k.end.x)).toBe(true);
      expect(Number.isFinite(k.end.y)).toBe(true);
    }
  });

  it('populates metadata name and author', () => {
    const { metadata } = parseS3d(MINIMAL_S3D);
    expect(metadata?.model).toBe('Test Board');
    expect(metadata?.designer).toBe('Test Author');
  });

  it('populates metadata comments', () => {
    const { metadata } = parseS3d(MINIMAL_S3D);
    expect(metadata?.comments).toBe('Self-authored fixture');
  });
});

describe('parseS3d — error handling', () => {
  it('throws on empty string', () => {
    expect(() => parseS3d('')).toThrow();
  });

  it('throws on XML without Shape3d_design root', () => {
    expect(() => parseS3d('<root><Board></Board></root>')).toThrow(/Shape3d_design/i);
  });

  it('throws on missing Outline element', () => {
    const noOutline = MINIMAL_S3D.replace(/<Outline>[\s\S]*?<\/Outline>/, '');
    expect(() => parseS3d(noOutline)).toThrow(/[Oo]utline/);
  });

  it('throws on missing Bottom element', () => {
    const noBottom = MINIMAL_S3D.replace(/<Bottom>[\s\S]*?<\/Bottom>/, '');
    expect(() => parseS3d(noBottom)).toThrow(/[Bb]ottom/);
  });

  it('throws on fewer than 2 control points in outline', () => {
    // An outline Bezier3d with only 1 real point (Nb_of_points=0 means 0 real CPs
    // since the loop goes 1..N+1 but N=0 means 0 iterations)
    const badOutline = `<?xml version="1.0" encoding="UTF-8"?>
<Shape3d_design>
  <Board>
    <Name>Bad</Name>
    <Author>Bad</Author>
    <Comment></Comment>
    <Outline>
      <Bezier3d>
        <Control_points>
          <Polygone3d>
            <Nb_of_points>0</Nb_of_points>
            <Point3d><x>0</x><y>0</y><z>0</z></Point3d>
          </Polygone3d>
        </Control_points>
        <Tangents_1><Polygone3d><Nb_of_points>0</Nb_of_points><Point3d><x>0</x><y>0</y><z>0</z></Point3d></Polygone3d></Tangents_1>
        <Tangents_2><Polygone3d><Nb_of_points>0</Nb_of_points><Point3d><x>0</x><y>0</y><z>0</z></Point3d></Polygone3d></Tangents_2>
        <Tangent_type_point_0>0</Tangent_type_point_0>
      </Bezier3d>
    </Outline>
    <Bottom>${bottomBezier}</Bottom>
    <Deck>${deckBezier}</Deck>
    <Couples_0>${section0Bezier}</Couples_0>
  </Board>
</Shape3d_design>`;
    expect(() => parseS3d(badOutline)).toThrow();
  });
});

describe('parseS3d — deck fallback when Deck element absent', () => {
  it('generates a synthetic deck curve and emits a warning', () => {
    const noDeck = MINIMAL_S3D.replace(/<Deck>[\s\S]*?<\/Deck>/, '');
    const result = parseS3d(noDeck);
    expect(result.board.deck.knots.length).toBeGreaterThanOrEqual(2);
    expect(result.warnings.some((w) => /deck/i.test(w.message))).toBe(true);
  });
});
