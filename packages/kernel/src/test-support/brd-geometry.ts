import { board, type BezierBoard } from '../board';
import { splineFromKnots } from '../bezier-spline';
import { crossSection, type CrossSection } from '../cross-section';
import { knotFromArray, type Knot } from '../knot';

/**
 * Minimal .brd geometry reader for kernel golden tests ONLY.
 *
 * Extracts just the spline (p32 outline / p33 bottom / p34 deck) and cross-section
 * (p35 / p36) control-point records needed to build a BezierBoard. The full,
 * hardened, all-fields .brd parser is `packages/io` (task #7). Tolerates the
 * shortboard missing-trailing-paren quirk by simply consuming what is present.
 */
const CP_RE = /\(cp \[([^\]]+)\]\s+(true|false)\s+(true|false)\)/;
const P36_RE = /^\(p36\s+([-\d.eE]+)/;
const FIELD_RE = /^p(\d+)\s*:/;

const parseCp = (line: string): Knot | null => {
  const m = line.match(CP_RE);
  if (!m) return null;
  const nums = m[1]!.split(',').map(Number);
  return knotFromArray(nums, m[2] === 'true', m[3] === 'true');
};

export const parseBrdGeometry = (text: string): BezierBoard => {
  const lines = text.split(/\r?\n/);
  const splines: Record<number, Knot[]> = { 32: [], 33: [], 34: [] };
  const sections: { pos: number; knots: Knot[] }[] = [];
  let current: number | 'other' = 'other';
  let curCs: { pos: number; knots: Knot[] } | null = null;

  for (const raw of lines) {
    const t = raw.trim();
    const field = t.match(FIELD_RE);
    if (field) {
      const n = Number(field[1]);
      current = n === 32 || n === 33 || n === 34 || n === 35 ? n : 'other';
      continue;
    }
    if (current === 35) {
      const p36 = t.match(P36_RE);
      if (p36) {
        curCs = { pos: Number(p36[1]), knots: [] };
        sections.push(curCs);
        continue;
      }
      const cp = parseCp(t);
      if (cp && curCs) curCs.knots.push(cp);
      continue;
    }
    if (current === 32 || current === 33 || current === 34) {
      const cp = parseCp(t);
      if (cp) splines[current]!.push(cp);
    }
  }

  const crossSections: CrossSection[] = sections
    .slice()
    .sort((a, b) => a.pos - b.pos)
    .map((s) => crossSection(s.pos, splineFromKnots(s.knots)));

  return board(
    splineFromKnots(splines[32]!),
    splineFromKnots(splines[33]!),
    splineFromKnots(splines[34]!),
    crossSections,
    'controlPoint',
  );
};
