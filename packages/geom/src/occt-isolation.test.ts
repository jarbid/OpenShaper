// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `occt-wasm` (a 21 MB LGPL WebAssembly kernel, geom-core.md §15) is a
 * test-only oracle: it must never be reachable from the web app or from
 * anything that ships. Three independent facts are checked here, so a change
 * that breaks the isolation fails a test and not just a review:
 *
 * 1. only `packages/geom/package.json` names it, and as a **devDependency**;
 *    pnpm's strict `node_modules` then makes it unresolvable elsewhere, and
 *    the lockfile lists it under that one importer only;
 * 2. no non-test source file of geom imports it (ESLint says the same);
 * 3. nothing reachable from geom's two entry points (`exports`: `.` and
 *    `./testing`) imports it, following relative imports transitively: what a
 *    dependent package, bundler or worker can pull in never touches it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const GEOM = resolve(SRC, '..');
const ROOT = resolve(GEOM, '..', '..');

function packageJsons(): string[] {
  const out = [join(ROOT, 'package.json')];
  for (const group of ['apps', 'packages']) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir)) {
      const p = join(dir, d, 'package.json');
      if (existsSync(p)) out.push(p);
    }
  }
  const worker = join(ROOT, 'worker', 'package.json');
  if (existsSync(worker)) out.push(worker);
  return out;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const SPECIFIER =
  /(?:import|export)[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;

function specifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(SPECIFIER)].map((m) => (m[1] ?? m[2] ?? m[3])!);
}

/** The file a relative specifier names (`./x` → `x.ts` or `x/index.ts`), or null. */
function resolveRelative(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const c of [`${base}.ts`, join(base, 'index.ts'), base]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

describe('occt-wasm stays a test-only oracle', () => {
  it('is named by exactly one package.json, as a devDependency of @openshaper/geom', () => {
    const holders: string[] = [];
    for (const p of packageJsons()) {
      const json = JSON.parse(readFileSync(p, 'utf8')) as Record<
        string,
        Record<string, string> | undefined
      >;
      for (const section of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        if (json[section]?.['occt-wasm'] !== undefined)
          holders.push(`${relative(ROOT, p)} (${section})`);
      }
    }
    expect(holders).toEqual([`${join('packages', 'geom', 'package.json')} (devDependencies)`]);
  });

  it('is pinned exactly in the lockfile and resolved for the geom importer only', () => {
    const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
    const importers = lock.slice(lock.indexOf('importers:'), lock.indexOf('\npackages:'));
    const blocks = importers.split(/\n {2}(?=\S)/);
    const withOcct = blocks
      .filter((b) => /\n\s+occt-wasm:\n/.test(b))
      .map((b) => b.split('\n')[0]!.trim());
    expect(withOcct).toEqual(['packages/geom:']);
    expect(lock).toMatch(/occt-wasm:\n\s+specifier: 5\.3\.5\n\s+version: 5\.3\.5/);
  });

  it('is not imported by any non-test source file of geom', () => {
    const offenders = sources(SRC)
      .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.bench.ts'))
      .filter((f) => specifiers(f).some((s) => s === 'occt-wasm' || s.startsWith('occt-wasm/')));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('is not reachable from the package entry points (index.ts and testing/index.ts)', () => {
    const seen = new Set<string>();
    const stack = [join(SRC, 'index.ts'), join(SRC, 'testing', 'index.ts')];
    while (stack.length > 0) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const s of specifiers(f)) {
        expect(
          s === 'occt-wasm' || s.startsWith('occt-wasm/'),
          `${relative(SRC, f)} imports ${s}`,
        ).toBe(false);
        if (s.startsWith('.')) {
          const r = resolveRelative(f, s);
          if (r !== null) stack.push(r);
        }
      }
    }
    // The walk really covered the package (a broken resolver would pass vacuously).
    const names = [...seen].map((f) => relative(SRC, f));
    expect(names).toContain(join('step', 'write.ts'));
    expect(names).toContain(join('brep', 'check.ts'));
    expect(names).toContain(join('testing', 'solids.ts'));
    expect(seen.size).toBeGreaterThan(40);
    // And the test file that does import it is not among them.
    expect(names.some((n) => n.endsWith('.occt.test.ts'))).toBe(false);
  });

  it('the detector can fail: the OCCT test file is seen importing it', () => {
    const occt = join(SRC, 'step', 'step.occt.test.ts');
    expect(specifiers(occt)).toContain('occt-wasm');
  });
});
