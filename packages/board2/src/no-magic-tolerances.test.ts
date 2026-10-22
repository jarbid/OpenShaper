// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * No magic tolerances in board2 (project principle 3; board2.md §13.1): every
 * threshold is a named, documented parameter in `params.ts` or a geom tolerance.
 * The same scan as geom's `no-magic-tolerances.test.ts`, with the same four
 * patterns (small e-notation, long-zero decimals, large e-notation, bare
 * `Number.EPSILON`), over every non-test source file under `src`.
 *
 * Exempt, by name: `params.ts` and `classic/params.ts` (the places named
 * parameters are written, like geom's `tolerance.ts`; the converter's defaults
 * of §12.2 live in the second, S6) and the `testing/` and `test-support/` directories
 * (test-only fixtures, like tests). The `Number.EPSILON` allow-list is empty:
 * the one use, `LAW_ROUNDING_REL`, is in `params.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const EXEMPT_FILES: ReadonlySet<string> = new Set(['params.ts', join('classic', 'params.ts')]);
const EXEMPT_DIRS: ReadonlySet<string> = new Set(['testing', 'test-support']);
const PATTERNS: readonly RegExp[] = [/\b\d+(\.\d+)?e-\d+\b/gi, /\b0\.0{4,}\d/g];
const LARGE_E = /\b\d+(\.\d+)?e\+?\d+\b/gi;
const EPSILON = /Number\.EPSILON/g;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (!EXEMPT_DIRS.has(e.name)) out.push(...sources(path));
    } else if (
      e.name.endsWith('.ts') &&
      !e.name.endsWith('.test.ts') &&
      !e.name.endsWith('.bench.ts')
    ) {
      out.push(path);
    }
  }
  return out;
}

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
    if (EPSILON.test(code)) hits.push(`${file}:${i + 1}: Number.EPSILON`);
    EPSILON.lastIndex = 0;
  });
  return hits;
}

describe('no magic tolerances', () => {
  it('finds the source files it is meant to scan, and every exemption names a real file', () => {
    const files = sources(SRC).map((f) => relative(SRC, f));
    expect(files).toContain('law.ts');
    expect(files).toContain('doc.ts');
    expect(files).toContain('validate.ts');
    expect(files).toContain(join('classic', 'convert.ts'));
    expect(files.some((f) => f.split(sep)[0] === 'testing')).toBe(false);
    expect(files.some((f) => f.split(sep).includes('test-support'))).toBe(false);
    for (const name of EXEMPT_FILES) expect(files).toContain(name);
    // Both exempt directories exist (`classic/test-support/` since step S6).
    expect(
      readdirSync(SRC, { withFileTypes: true }).some(
        (e) => e.isDirectory() && e.name === 'testing',
      ),
    ).toBe(true);
    expect(
      readdirSync(join(SRC, 'classic'), { withFileTypes: true }).some(
        (e) => e.isDirectory() && e.name === 'test-support',
      ),
    ).toBe(true);
  });

  it('detects every literal shape (so the scan can fail)', () => {
    expect(findLiterals('x.ts', 'const a = 1e-9;\nconst b = 2.5E-12;')).toHaveLength(2);
    expect(findLiterals('x.ts', 'if (d < 0.000001) return;')).toHaveLength(1);
    expect(findLiterals('x.ts', 'if (cond > 1e12) return;')).toHaveLength(1);
    expect(findLiterals('x.ts', 'if (d < 8 * Number.EPSILON) return;')).toHaveLength(1);
    expect(findLiterals('x.ts', ' * quotes 1e17\n// and 1e6 here')).toHaveLength(0);
    expect(findLiterals('x.ts', 'const k = 123456; const w = 0.005;')).toHaveLength(0);
  });

  it('allows tolerance literals only in the two params files', () => {
    const hits: string[] = [];
    for (const file of sources(SRC)) {
      const name = relative(SRC, file);
      if (EXEMPT_FILES.has(name)) continue;
      hits.push(...findLiterals(name, readFileSync(file, 'utf8')));
    }
    expect(hits).toEqual([]);
  });
});
