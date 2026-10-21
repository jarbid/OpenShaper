// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Benchmark regression guard (docs/design/geom-core.md §17).
 *
 *   pnpm --filter @openshaper/geom bench:check                 compare with bench-baseline.json
 *   pnpm --filter @openshaper/geom bench:check -- --factor 3   a different allowed slowdown
 *   pnpm --filter @openshaper/geom bench:check -- --update     record this machine as the baseline
 *
 * Runs `vitest bench` (src/eval.bench.ts writes each row's mean latency, in ms,
 * to the JSON-lines file named by GEOM_BENCH_JSONL) and fails when any row's mean
 * is more than FACTOR times its baseline. Rows missing from the baseline are
 * reported and fail (run --update); rows missing from the run fail too.
 * Only slowdowns fail: a faster row is reported, never an error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Allowed slowdown before a row fails: the design's "more than 2x" (§17). */
const DEFAULT_FACTOR = 2;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'bench-baseline.json');

const args = process.argv.slice(2).filter((a) => a !== '--');
const update = args.includes('--update');
const fi = args.indexOf('--factor');
const factor = fi >= 0 ? Number(args[fi + 1]) : DEFAULT_FACTOR;
if (!(factor > 1)) {
  console.error('--factor must be a number greater than 1');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'geom-bench-'));
const sink = join(dir, 'rows.jsonl');
let rows;
try {
  const run = spawnSync('pnpm', ['exec', 'vitest', 'bench', 'src', '--run'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, GEOM_BENCH_JSONL: sink },
  });
  if (run.status !== 0 || !existsSync(sink)) {
    console.error('bench run failed');
    process.exit(run.status || 1);
  }
  rows = readFileSync(sink, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const current = Object.fromEntries(rows.map((r) => [`${r.id} ${r.name}`, r.meanMs]));

if (update) {
  const doc = {
    note: 'Mean latency in ms per row of src/eval.bench.ts, recorded by `bench:check --update` on the machine below. Compare only on comparable hardware.',
    recorded: new Date().toISOString().slice(0, 10),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    rows: current,
  };
  writeFileSync(baselinePath, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`baseline written: ${Object.keys(current).length} rows`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error('no bench-baseline.json; run with --update first');
  process.exit(2);
}
const base = JSON.parse(readFileSync(baselinePath, 'utf8')).rows;
let failed = 0;
for (const [name, was] of Object.entries(base)) {
  const now = current[name];
  if (now === undefined) {
    console.log(`MISSING  ${name}`);
    failed++;
    continue;
  }
  const ratio = now / was;
  const bad = ratio > factor;
  if (bad) failed++;
  console.log(
    `${bad ? 'SLOWER ' : 'ok     '} ${ratio.toFixed(2)}x  ${name}  (${was.toFixed(4)} -> ${now.toFixed(4)} ms)`,
  );
}
for (const name of Object.keys(current)) {
  if (!(name in base)) {
    console.log(`NEW      ${name} (not in baseline; run --update)`);
    failed++;
  }
}
console.log(
  failed
    ? `\n${failed} row(s) failed (allowed slowdown ${factor}x)`
    : `\nall rows within ${factor}x`,
);
process.exit(failed ? 1 : 0);
