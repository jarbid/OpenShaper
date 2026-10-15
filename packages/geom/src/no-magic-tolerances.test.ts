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
 * Exempt: `tolerance.ts` (the one place they belong), test files (each
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

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(path));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(path);
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
    expect(findLiterals('x.ts', 'const w = 0.0229353220105292;\nconst k = 1e6;')).toHaveLength(0);
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
