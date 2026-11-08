// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real Shape3D boards through the converter: all convert and build (docs/design/nurbs-plan.md,
 * decision 12). The boards are third-party designs in the gitignored `Sample board imports/`
 * folder, so the test skips where that folder is absent (CI, a fresh clone).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseS3dx } from '@openshaper/io';
import { describe, expect, it } from 'vitest';
import { buildBoard } from '../surface';
import { convertClassic } from './index';

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../Sample board imports/carlos',
);
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.s3dx')) : [];

describe.skipIf(files.length === 0)('Shape3D boards convert to the section model', () => {
  it.each(files)('%s converts and builds', (file) => {
    const { board } = parseS3dx(readFileSync(join(dir, file), 'latin1'));
    const r = convertClassic(board);
    expect(r.ok, r.ok ? '' : r.issues.map((i) => `${i.code}: ${i.message}`).join('; ')).toBe(true);
    if (!r.ok) return;
    const built = buildBoard(r.value.doc);
    expect(built.ok, built.ok ? '' : built.issues.map((i) => i.message).join('; ')).toBe(true);
  });
});
