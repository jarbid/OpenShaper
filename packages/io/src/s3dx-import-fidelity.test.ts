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
import { getLength, getMaxWidth, getThickness, getVolume } from '@openshaper/kernel';
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

  it('does not mistake a 3D layer for the board: its slices never reach the board', () => {
    const slice = block(clean, 'Couples_0');
    const layer = `<Calque3D><Number_of_slices>2</Number_of_slices>${slice}${rename(slice, 'Couples_0', 'Couples_1')}</Calque3D>`;
    expect(parseS3dx(clean.replace('<Board>', `<Board>\n${layer}`))).toEqual(parseS3dx(clean));
  });

  it('prefers the absolute <StrDeck> over a curveDefSide4 that holds thickness', () => {
    const thick = fixture('synthetic-rocker-thickness-deck.s3dx');
    const abs = fixture('synthetic-rocker-absolute-deck.s3dx');
    const withStrDeck = thick.replace(
      '<curveDefSide4>',
      `${rename(block(abs, 'curveDefSide4'), 'curveDefSide4', 'StrDeck')}\n<curveDefSide4>`,
    );
    const parsed = parseS3dx(withStrDeck);
    expect(parsed.board.deck).toEqual(parseS3dx(abs).board.deck);
    expect(parsed.warnings.some((w) => /thickness above the bottom/.test(w.message))).toBe(false);
  });
});

describe('parseS3dx fin boxes (synthetic)', () => {
  const clean = fixture('synthetic-clean-6x22x2-75.s3dx');
  const pt = (x: number, y: number) =>
    `<Point3d><x>${x}</x><y>${y}</y><z>3</z><u>-1</u><color>0</color></Point3d>`;
  const box = (n: number, name: string, f: Record<string, string | number>, c: [number, number]) =>
    `<Box_${n}><Box><Name>${name}</Name>` +
    Object.entries(f)
      .map(([k, v]) => `<${k}>${v}</${k}>`)
      .join('') +
    `<Ref. point>${pt(c[0] - 5.5, c[1])}</Ref. point><PointCenter>${pt(c[0], c[1])}</PointCenter></Box></Box_${n}>`;
  const withBoxes = clean.replace(
    '</Board>',
    '<Nb_Boxes>3</Nb_Boxes>' +
      box(
        0,
        'Fin_center',
        { Length: 11, Width: 3.8, Central: 1, Even: 0, Face: 1, Style: 6, AngleOz: 0 },
        [12, 0],
      ) +
      box(
        1,
        'Fin_sides',
        { Length: 11, Width: 3.8, Central: 0, Even: 1, Face: 1, Style: 6, AngleOz: 0.0863 },
        [34, 15],
      ) +
      box(
        2,
        'Plug 0',
        { Length: 2.7, Width: 2.7, Diameter: 2.7, Even: 0, Face: 0, Style: 4 },
        [5, 0],
      ) +
      '</Board>',
  );

  it('imports a centre fin and a mirrored pair, and reports the leash plug instead of importing it', () => {
    const { board, warnings } = parseS3dx(withBoxes);
    expect(board.fins.setup).toBe('thruster');
    expect(board.fins.fins.map((f) => f.side)).toEqual([0, -1, 1]);
    const centre = board.fins.fins[0]!;
    expect(centre.trailingFromTail).toBeCloseTo(12 - 5.5, 6);
    expect(centre.base).toBe(11);
    const [, port, starboard] = board.fins.fins;
    expect(port!.toe).toBeCloseTo((0.0863 * 180) / Math.PI, 6); // radians to degrees, toed in
    expect(starboard).toEqual({ ...port, side: 1 });
    expect(warnings.filter((w) => /Plug 0/.test(w.message))).toHaveLength(1);
  });

  it('leaves the fin config empty when there are no boxes', () => {
    expect(parseS3dx(clean).board.fins.setup).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Real boards, against the figures Shape3D stores in the same file.
// ---------------------------------------------------------------------------

const carlos = join(here, '../../../Sample board imports/carlos');
const haveBoards = existsSync(carlos);
const boards = haveBoards ? readdirSync(carlos).filter((f) => f.endsWith('.s3dx')) : [];

/**
 * Per board: how far (fraction) our volume may sit from Shape3D's own, and the number of
 * fins imported. The tolerance is 1% except where the board is known to differ:
 *  - Go fish: Shape3D's thickness and volume include its 'canaleta fish' bottom-channel
 *    3D layer, which we do not import (thickness is therefore not compared either).
 *  - Diamond twin, long classico, Master Trusther: Shape3D blends the slices along its
 *    rail and apex guide curves; we blend them by the outline, which costs more the
 *    further apart the slices are (94 to 108 cm on the diamond twin).
 */
const EXPECTED: Record<string, { volumeTol: number; fins: number; skipThickness?: boolean }> = {
  '5.10_x_19.8_x_2.6_MLC_4.3_NR_VOL_31.7_L': { volumeTol: 0.01, fins: 0 },
  '5.8_x_20_x_2.6_TRUSTHER_5_FIN_WHITE_TIGER': { volumeTol: 0.01, fins: 3 },
  '6.0_x_22_x_2.75_MASTER_TRUSTHER_3': { volumeTol: 0.015, fins: 0 },
  '6.11_x_21.3_x_2.8_DIAMOND_TWIN': { volumeTol: 0.07, fins: 2 },
  Go_fish: { volumeTol: 0.08, fins: 2, skipThickness: true },
  gremilin56: { volumeTol: 0.01, fins: 5 },
  hyptocrypto: { volumeTol: 0.01, fins: 5 },
  long_classico96: { volumeTol: 0.025, fins: 1 },
};

describe.skipIf(!haveBoards)('real Shape3D boards match their own stored figures', () => {
  it('finds the eight boards', () => expect(boards).toHaveLength(8));

  it.each(Object.keys(EXPECTED))('%s: length, width, thickness, volume and fins', (name) => {
    const text = readFileSync(join(carlos, `${name}.s3dx`), 'latin1');
    const stored = (tag: string): number =>
      Number(new RegExp(`<Board>[\\s\\S]*?<${tag}>([-\\d.]+)<`).exec(text)![1]);
    const want = EXPECTED[name]!;
    const { board } = parseS3dx(text);
    const near = (got: number, ref: number, tol: number): void =>
      expect(Math.abs(got - ref) / ref).toBeLessThanOrEqual(tol);
    near(getLength(board), stored('Length'), 0.01);
    near(getMaxWidth(board), stored('Width'), 0.01);
    if (!want.skipThickness) near(getThickness(board), stored('Thickness'), 0.01);
    // Shape3D's Volume divided by 10 is litres; the kernel's volume is in cm3.
    near(getVolume(board, { sectionSplits: 100 }), stored('Volume') * 100, want.volumeTol);
    expect(board.fins.fins).toHaveLength(want.fins);
  });
});
