/**
 * Shape3D `.s3dx` import fidelity: which element is the outline, which slices are the
 * board's, which curve is the deck. See docs/design/shape3d-import.md.
 *
 * The synthetic cases are built from the self-authored fixtures. The real-board checks
 * (further down) read third-party designs from `Sample board imports/`, which is
 * gitignored and never committed, so they skip when the folder is absent.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseS3dx } from './s3d-reader';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(join(here, '__fixtures__', name), 'latin1');
const block = (xml: string, tag: string): string =>
  new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`).exec(xml)![0];
const rename = (xml: string, from: string, to: string): string =>
  xml.replace(new RegExp(`(</?)${from}>`, 'g'), `$1${to}>`);

describe('parseS3dx element choice (synthetic)', () => {
  const clean = fixture('synthetic-clean-6x22x2-75.s3dx');

  it('reads the outline from <Otl>, not from the narrower curveDefTop1 or a lone curveDefTop2', () => {
    const rail = rename(
      block(fixture('synthetic-fallback-outline-5x10.s3dx'), 'curveDefTop1'),
      'curveDefTop1',
      'curveDefTop2',
    );
    const withOtl = clean.replace(
      block(clean, 'curveDefTop2'),
      `${rename(block(clean, 'curveDefTop2'), 'curveDefTop2', 'Otl')}\n${rail}`,
    );
    const { board, warnings } = parseS3dx(withOtl);
    expect(board.outline).toEqual(parseS3dx(clean).board.outline);
    expect(warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Real boards, against the figures Shape3D stores in the same file.
// ---------------------------------------------------------------------------

const carlos = join(here, '../../../Sample board imports/carlos');
const haveBoards = existsSync(carlos);
const boards = haveBoards ? readdirSync(carlos).filter((f) => f.endsWith('.s3dx')) : [];

describe.skipIf(!haveBoards)('real Shape3D boards match their own stored figures', () => {
  it('finds the eight boards', () => expect(boards).toHaveLength(8));
});
