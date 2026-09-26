/**
 * Tests for parseSrf() — the .srf binary reader.
 *
 * FIXTURE NOTE: No real .srf sample files exist in the legacy tree.
 * All fixtures below are SELF-AUTHORED: they are constructed programmatically
 * by writing exactly the binary layout that parseSrf() is ported to read.
 * They pin the port's interpretation of the format (SrfReader.java byte-by-
 * field order, little-endian IEEE 754 floats), not a legacy oracle output.
 *
 * Port source: boardcad-le/src/board/readers/SrfReader.java
 *   loadFile(BezierBoard, String) — the entire public entry point.
 *
 * Unit conversions from UnitUtils.java:
 *   CENTIMETER_PR_METER = 100
 *   INCH = 2.54
 *   INCHES_PR_FOOT = 12
 *   FOOT = 30.48 cm
 */

import { describe, it, expect } from 'vitest';
import { parseSrf, SrfReadError } from './srf-reader';

// ---------------------------------------------------------------------------
// Fixture builder: constructs a minimal valid .srf binary buffer
// that parseSrf() should be able to decode.
//
// .srf binary layout (little-endian, ported from SrfReader.java):
//
//  [variable] version string bytes terminated by ASCII space (0x20)
//  [variable] model  name bytes terminated by ASCII '*' (0x2A)
//  [variable] comments bytes terminated by ASCII '@' (0x40)
//  [11 bytes]  skip
//  [4]  float boardLength  (meters → ×100 = cm)
//  [4×4] floats initialOutline[4]  (half-widths, fractional meters)
//  [4]  float widepointPos (meters)
//  [4×4] floats initialRocker[4]
//  [4×4] floats initialRail[4]
//  [4×4] floats initialThickness[4]
//  [113 bytes] skip
//  [2]  short nrOfPointsOutline
//  per outline knot (×nrOfPointsOutline):
//    j=0: [4,4,4] float x,y,z  →  endPoint
//         [12 bytes] skip
//    j=1: [4,4,4] float x,y,z  →  tangentToPrev
//    j=2: [4,4,4] float x,y,z  →  tangentToNext
//    [28 bytes] skip after the 3 j-groups
//  [1 byte] skip
//  [2]  short nrOfPointsRocker
//  per rocker knot (same sub-layout as outline)
//  [1 byte] skip
//  [2]  short nrOfPointsRail
//  per rail knot (same sub-layout — stored but not currently used in output)
//  [1 byte] skip
//  [2]  short nrOfPointsDeck
//  per deck knot (same sub-layout)
//  [1 byte] skip
//  [2]  short nrOfPointsBottom
//  per bottom knot (same sub-layout)
//  [1 byte] skip
//  [2]  short nrOfDeckCaves
//  per deck cave (×nrOfDeckCaves):
//    [6 bytes] skip
//    [4,4,4] float x,y,z  → upper cave endpoint1 (deckCavePoints[i*4+0])
//    [12 bytes] skip
//    [4,4,4] float x,y,z  → upper cave tangent1  (deckCavePoints[i*4+1])
//    [40 bytes] skip
//    [4,4,4] float x,y,z  → upper cave tangent2  (deckCavePoints[i*4+2])
//    [24 bytes] skip
//    [4,4,4] float x,y,z  → upper cave endpoint2 (deckCavePoints[i*4+3])
//    [28 bytes] skip
//  [1 byte] skip
//  [2]  short nrOfBottomCaves
//  per bottom cave (same sub-layout as deck caves)
// ---------------------------------------------------------------------------

/** Write a LE float32 at offset into buf. */
function wf(buf: Uint8Array, offset: number, v: number): number {
  const dv = new DataView(buf.buffer);
  dv.setFloat32(offset, v, true);
  return offset + 4;
}

/** Write a LE int16 at offset into buf. */
function wi16(buf: Uint8Array, offset: number, v: number): number {
  const dv = new DataView(buf.buffer);
  dv.setInt16(offset, v, true);
  return offset + 2;
}

/** Write an ASCII string + terminator into buf. */
function wstr(buf: Uint8Array, offset: number, s: string, terminator: number): number {
  for (let i = 0; i < s.length; i++) {
    buf[offset++] = s.charCodeAt(i);
  }
  buf[offset++] = terminator;
  return offset;
}

/** Write a 3-float xyz group (12 bytes). Returns new offset. */
function wxyz(buf: Uint8Array, offset: number, x: number, y: number, z: number): number {
  let o = offset;
  o = wf(buf, o, x);
  o = wf(buf, o, y);
  o = wf(buf, o, z);
  return o;
}

/**
 * Write one spline knot group into buf at offset.
 * The per-knot layout (from SrfReader.java lines 109-132 for outline, repeated
 * identically for rocker/rail/deck/bottom):
 *   j=0: float x,y,z = endPoint; then +12 skip
 *   j=1: float x,y,z = tangentToPrev
 *   j=2: float x,y,z = tangentToNext
 *   then +28 skip
 *
 * All coords in meters (the reader multiplies by CENTIMETER_PR_METER=100).
 */
function wKnot(
  buf: Uint8Array,
  offset: number,
  end: [number, number],
  prev: [number, number],
  next: [number, number],
): number {
  let o = offset;
  // j=0: end point (z unused, stored as 0)
  o = wxyz(buf, o, end[0], end[1], 0);
  o += 12; // skip
  // j=1: tangentToPrev
  o = wxyz(buf, o, prev[0], prev[1], 0);
  // j=2: tangentToNext
  o = wxyz(buf, o, next[0], next[1], 0);
  o += 28; // skip after knot
  return o;
}

/**
 * Build a minimal self-authored .srf buffer.
 *
 * Board: length = 1.83 m (183 cm), two outline knots, two rocker knots,
 * two rail knots, two deck knots, two bottom knots, zero caves.
 * Coordinates in meters.
 */
function buildMinimalSrfBuffer(): ArrayBuffer {
  // Generously sized — actual bytes used are well under 2 KB
  const buf = new Uint8Array(4096);
  let o = 0;

  // --- header strings ---
  // version string (terminated by space 0x20); the reader reads but discards this
  o = wstr(buf, o, '1.0', 0x20);
  // model name (terminated by '*' 0x2A)
  o = wstr(buf, o, 'TestModel', 0x2a);
  // comments (terminated by '@' 0x40)
  o = wstr(buf, o, 'Test comment', 0x40);

  // +11 skip
  o += 11;

  // boardLength in meters → reader converts to cm via ×100
  // 1.83 m → 183 cm
  o = wf(buf, o, 1.83);

  // initialOutline[4]: half-width fractions (meters). We just write dummy values.
  for (let i = 0; i < 4; i++) o = wf(buf, o, 0.25);

  // widepointPos (meters)
  o = wf(buf, o, 0.5);

  // initialRocker[4]
  for (let i = 0; i < 4; i++) o = wf(buf, o, 0.01);

  // initialRail[4]
  for (let i = 0; i < 4; i++) o = wf(buf, o, 0.05);

  // initialThickness[4]
  for (let i = 0; i < 4; i++) o = wf(buf, o, 0.06);

  // +113 skip
  o += 113;

  // --- outline (2 knots, in SRF coords) ---
  // SRF stores the nose at x_srf=0 and the tail at x_srf=boardLength (metres). The
  // reader walks the knots in reverse and maps kernel_x = boardLength − x_srf·100
  // (SrfReader.java:429-436), so the tail lands at kernel x=0 and the nose at 183:
  //   knot 1 (x_srf=1.83, tail) → kernel x = 183 − 183 = 0
  //   knot 0 (x_srf=0.00, nose) → kernel x = 183 − 0   = 183
  // Two knots on the centreline (y=0) keep the fixture minimal.

  o = wi16(buf, o, 2); // nrOfPointsOutline = 2

  // Knot 0: nose tip — x_srf=0.0 m, y_srf=0.0 m (zero half-width at nose)
  o = wKnot(buf, o, [0.0, 0.0], [0.0, 0.0], [0.0, 0.0]);
  // Knot 1: tail tip — x_srf=1.83 m, y_srf=0.0 m
  o = wKnot(buf, o, [1.83, 0.0], [1.83, 0.0], [1.83, 0.0]);

  // +1 skip before rocker
  o += 1;
  o = wi16(buf, o, 2); // nrOfPointsRocker = 2

  // Rocker knot 0: nose, x=0 m, y=0.05 m (5 cm rocker at nose)
  o = wKnot(buf, o, [0.0, 0.05], [0.0, 0.05], [0.0, 0.05]);
  // Rocker knot 1: tail, x=1.83 m, y=0.0 m (0 cm rocker at tail = origin)
  o = wKnot(buf, o, [1.83, 0.0], [1.83, 0.0], [1.83, 0.0]);

  // +1 skip before rail
  o += 1;
  o = wi16(buf, o, 2); // nrOfPointsRail = 2
  o = wKnot(buf, o, [0.0, 0.0], [0.0, 0.0], [0.0, 0.0]);
  o = wKnot(buf, o, [1.83, 0.05], [1.83, 0.05], [1.83, 0.05]);

  // +1 skip before deck
  o += 1;
  o = wi16(buf, o, 2); // nrOfPointsDeck = 2

  // Deck knot 0: nose, x=0 m, y=0.06 m (6 cm thickness at nose)
  o = wKnot(buf, o, [0.0, 0.06], [0.0, 0.06], [0.0, 0.06]);
  // Deck knot 1: tail, x=1.83 m, y=0.03 m
  o = wKnot(buf, o, [1.83, 0.03], [1.83, 0.03], [1.83, 0.03]);

  // +1 skip before bottom (concave)
  o += 1;
  o = wi16(buf, o, 2); // nrOfPointsBottom = 2
  o = wKnot(buf, o, [0.0, 0.0], [0.0, 0.0], [0.0, 0.0]);
  o = wKnot(buf, o, [1.83, 0.0], [1.83, 0.0], [1.83, 0.0]);

  // +1 skip before deck caves
  o += 1;
  o = wi16(buf, o, 0); // nrOfDeckCaves = 0

  // +1 skip before bottom caves
  o += 1;
  o = wi16(buf, o, 0); // nrOfBottomCaves = 0

  return buf.buffer.slice(0, o);
}

// ---------------------------------------------------------------------------

describe('parseSrf', () => {
  it('parses a minimal self-authored .srf buffer without throwing', () => {
    const buf = buildMinimalSrfBuffer();
    const result = parseSrf(buf);
    expect(result).toBeDefined();
    expect(result.board).toBeDefined();
  });

  it('extracts model name from the header', () => {
    const buf = buildMinimalSrfBuffer();
    const result = parseSrf(buf);
    // SrfReader.java:58: `new String(strBytes, 0, i-2)` — the do-while post-increments i
    // after the sentinel match, so i-2 strips the byte immediately before the '*'.
    // "TestModel*" → i=10 after loop → i-2=8 → "TestMode".
    // This is the legacy behaviour we pin.
    expect(result.model).toBe('TestMode');
  });

  it('extracts comments from the header', () => {
    const buf = buildMinimalSrfBuffer();
    const result = parseSrf(buf);
    // The reader includes the '@' terminator byte in the loop per Java code
    // SrfReader.java:65-66:  while(strBytes[i++] != '@'); name = new String(strBytes,0,i-1)
    // So comments includes the text up to (but not including) '@'.
    expect(result.comments).toBe('Test comment');
  });

  it('converts boardLength from meters to cm (183 cm for 1.83 m input)', () => {
    const buf = buildMinimalSrfBuffer();
    const result = parseSrf(buf);
    const { board } = result;
    // Outline spans from x=0 (tail) to x≈183 (nose).
    let maxX = 0;
    for (const k of board.outline.knots) {
      if (k.end.x > maxX) maxX = k.end.x;
    }
    expect(maxX).toBeCloseTo(183, 1);
  });

  it('produces finite coordinates for all outline knots', () => {
    const buf = buildMinimalSrfBuffer();
    const { board } = parseSrf(buf);
    for (const k of board.outline.knots) {
      expect(Number.isFinite(k.end.x)).toBe(true);
      expect(Number.isFinite(k.end.y)).toBe(true);
      expect(Number.isFinite(k.tangentToPrev.x)).toBe(true);
      expect(Number.isFinite(k.tangentToPrev.y)).toBe(true);
      expect(Number.isFinite(k.tangentToNext.x)).toBe(true);
      expect(Number.isFinite(k.tangentToNext.y)).toBe(true);
    }
  });

  it('produces finite coordinates for all bottom (rocker) knots', () => {
    const buf = buildMinimalSrfBuffer();
    const { board } = parseSrf(buf);
    for (const k of board.bottom.knots) {
      expect(Number.isFinite(k.end.x)).toBe(true);
      expect(Number.isFinite(k.end.y)).toBe(true);
    }
  });

  it('produces finite coordinates for all deck knots', () => {
    const buf = buildMinimalSrfBuffer();
    const { board } = parseSrf(buf);
    for (const k of board.deck.knots) {
      expect(Number.isFinite(k.end.x)).toBe(true);
      expect(Number.isFinite(k.end.y)).toBe(true);
    }
  });

  it('has cross-sections including tail (pos=0) and nose dummy sections', () => {
    const buf = buildMinimalSrfBuffer();
    const { board } = parseSrf(buf);
    // The reader always adds two dummy cross-sections (tail pos=0, nose pos=length)
    // mirroring what BrdReader does (SrfReader.java:542-551).
    expect(board.crossSections.length).toBeGreaterThanOrEqual(2);
    const positions = board.crossSections.map((cs) => cs.position);
    expect(positions).toContain(0);
  });

  it('board length is plausible (> 100 cm for a standard shortboard)', () => {
    const buf = buildMinimalSrfBuffer();
    const { board } = parseSrf(buf);
    let maxX = 0;
    for (const k of board.outline.knots) {
      if (k.end.x > maxX) maxX = k.end.x;
    }
    // 1.83 m = 183 cm
    expect(maxX).toBeGreaterThan(100);
    expect(maxX).toBeLessThan(400);
  });

  it('throws SrfReadError on truncated input (empty buffer)', () => {
    expect(() => parseSrf(new ArrayBuffer(0))).toThrow(SrfReadError);
  });

  it('throws SrfReadError on buffer too short to contain header strings', () => {
    // A buffer with just a few bytes — no space terminator, no model or comments
    const tiny = new Uint8Array([0x31, 0x2e, 0x30]); // "1.0" but no space terminator
    expect(() => parseSrf(tiny.buffer)).toThrow(SrfReadError);
  });

  it('throws SrfReadError on truncated buffer (header OK but missing measurement fields)', () => {
    // Write header strings but nothing else (no measurements section)
    const buf = new Uint8Array(64);
    let o = 0;
    o = wstr(buf, o, '1.0', 0x20);
    o = wstr(buf, o, 'Model', 0x2a);
    o = wstr(buf, o, 'Cmnt', 0x40);
    // Stop here — no 11-byte skip, no boardLength, etc.
    expect(() => parseSrf(buf.buffer.slice(0, o + 3))).toThrow(SrfReadError);
  });
});
