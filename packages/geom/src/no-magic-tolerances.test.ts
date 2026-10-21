// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * No magic tolerances (project principle 3; design §7, decision 16): every
 * tolerance lives in `tolerance.ts`, as a named, documented entry of
 * `Tolerances`. This test scans every non-test source file under `src` for
 * tolerance-shaped literals and fails on any.
 *
 * Two patterns:
 * - the design's `/\b\d+(\.\d+)?e-\d+\b/i` (scientific notation: `1e-9`);
 * - a plain decimal with four or more leading zeros after the point
 *   (`0.00001`), which the first pattern would miss.
 *
 * Two more, for thresholds that are not small decimals (phase 1 exit review):
 * - large e-notation (`1e6`, `1e12`: condition-number and growth cut-offs), in
 *   code only (comment text may quote conditions such as `1e17`);
 * - any `Number.EPSILON` in code (a bare multiple of machine epsilon is a
 *   tolerance in disguise). Each existing use is in `EPSILON_USES` below with
 *   the reason it is not a tunable tolerance; a new one fails until it is
 *   either named in `tolerance.ts` or listed there with a reason.
 *
 * Exempt: `tolerance.ts`, benchmark files (`*.bench.ts`: rates and sizes, no tolerances) (the one place they belong), test files (each
 * test states its own tolerance and why) and vendored files, listed by name,
 * never by pattern: `mesh/vendor/robust-predicates.ts` (B2) holds Shewchuk's
 * unit roundoff `2⁻⁵³`, the exact-arithmetic constant its error bounds are
 * derived from, not a tolerance.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const EXEMPT: ReadonlySet<string> = new Set([
  'tolerance.ts',
  join('mesh', 'vendor', 'robust-predicates.ts'),
]);
const PATTERNS: readonly RegExp[] = [/\b\d+(\.\d+)?e-\d+\b/gi, /\b0\.0{4,}\d/g];

/** Large e-notation (`1e6`); the small-exponent forms are `PATTERNS`. */
const LARGE_E = /\b\d+(\.\d+)?e\+?\d+\b/gi;
const EPSILON = /Number\.EPSILON/g;

/**
 * Allowed `Number.EPSILON` uses: `file` plus a substring of the (trimmed) line.
 * Each is a floating-point rounding bound or a named, documented floor, not a
 * problem-scale tolerance.
 */
const EPSILON_USES: readonly { file: string; line: string; reason: string }[] = [
  {
    file: join('mesh', 'predicates.ts'),
    line: 'const EPS = Number.EPSILON / 2;',
    reason: 'unit roundoff u = 2^-53, the constant the filter error bounds are derived from',
  },
  {
    file: 'project.ts',
    line: 'const LM_DIAG_FLOOR = Number.EPSILON;',
    reason:
      'named constant, documented at its definition: relative floor of the LM diagonal, a rounding-level definiteness guard',
  },
  {
    file: 'project.ts',
    line: 'const ESCAPE_GAIN_FLOOR = Number.EPSILON;',
    reason:
      'named constant, documented at its definition: a second-order escape step must gain more than rounding',
  },
  {
    file: 'quadrature.ts',
    line: 'Math.abs(dx) <= Number.EPSILON',
    reason:
      'Newton iteration on a root in [-1, 1] stops when the step is below representable resolution',
  },
  {
    file: 'integrate.ts',
    line: 'n * Number.EPSILON * abs',
    reason:
      'rounding error estimate of a sum of n terms, reported in errorEstimate, not a stopping tolerance',
  },
  {
    file: 'integrate.ts',
    line: 'exactTerms * Number.EPSILON * exactAbs',
    reason: 'rounding error estimate of the exactly integrated terms, reported in errorEstimate',
  },
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(path));
    else if (
      e.name.endsWith('.ts') &&
      !e.name.endsWith('.test.ts') &&
      !e.name.endsWith('.bench.ts')
    )
      out.push(path);
  }
  return out;
}

/** `file:line: text` for every tolerance-shaped literal in `text`. */
function findLiterals(file: string, text: string): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((line, i) => {
    for (const re of PATTERNS) {
      for (const m of line.matchAll(re)) hits.push(`${file}:${i + 1}: ${m[0]}`);
    }
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) return;
    const code = line.replace(/\/\/.*$/, '');
    for (const m of code.matchAll(LARGE_E)) hits.push(`${file}:${i + 1}: ${m[0]}`);
    if (EPSILON.test(code) && !EPSILON_USES.some((u) => u.file === file && code.includes(u.line)))
      hits.push(`${file}:${i + 1}: Number.EPSILON`);
    EPSILON.lastIndex = 0;
  });
  return hits;
}

describe('no magic tolerances', () => {
  it('finds the source files it is meant to scan', () => {
    const files = sources(SRC).map((f) => relative(SRC, f));
    expect(files).toContain('curve.ts');
    expect(files).toContain(join('book', 'basis.ts'));
    expect(files).toContain('tolerance.ts');
    // Every exemption names a file that exists (no stale exemptions).
    for (const name of EXEMPT) expect(files).toContain(name);
  });

  it('detects both literal shapes (so the scan can fail)', () => {
    expect(findLiterals('x.ts', 'const a = 1e-9;\nconst b = 2.5E-12;')).toHaveLength(2);
    expect(findLiterals('x.ts', 'if (d < 0.000001) return;')).toHaveLength(1);
    expect(findLiterals('x.ts', 'const w = 0.0229353220105292;\nconst k = 123456;')).toHaveLength(
      0,
    );
  });

  it('detects large thresholds and bare epsilon (so the scan can fail)', () => {
    expect(findLiterals('x.ts', 'if (cond > 1e12) return;')).toHaveLength(1);
    expect(findLiterals('x.ts', 'if (d < 8 * Number.EPSILON) return;')).toHaveLength(1);
    // Comment text is not code; an allow-listed use passes only in its own file.
    expect(findLiterals('x.ts', ' * condition reaches 1e17\n// 1e6 here')).toHaveLength(0);
    expect(
      findLiterals('quadrature.ts', 'if (Math.abs(dx) <= Number.EPSILON) break;'),
    ).toHaveLength(0);
    expect(findLiterals('x.ts', 'if (Math.abs(dx) <= Number.EPSILON) break;')).toHaveLength(1);
  });

  it('keeps no stale epsilon allow-list entries', () => {
    for (const u of EPSILON_USES) {
      expect(readFileSync(join(SRC, u.file), 'utf8')).toContain(u.line);
      expect(u.reason.length).toBeGreaterThan(20);
    }
  });

  it('allows tolerance literals only in tolerance.ts', () => {
    const hits: string[] = [];
    for (const file of sources(SRC)) {
      const name = relative(SRC, file);
      if (EXEMPT.has(name)) continue;
      hits.push(...findLiterals(name, readFileSync(file, 'utf8')));
    }
    expect(hits).toEqual([]);
  });
});
