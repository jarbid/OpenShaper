/**
 * Characterization: key store actions on a real board produce the same state.
 *
 * Each scenario loads the reference shortboard, runs a sequence of actions, and
 * snapshots (a) the readable parts of the resulting state — history labels,
 * selection, fins, knot counts, headline specs — and (b) a hash of the whole board
 * with every number rounded to 8 significant digits, so any change to the edit
 * maths shows up without a multi-kilobyte snapshot per scenario.
 *
 * A changed snapshot here means an edit now produces a different board. That is a
 * behaviour change, not a refactor.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { vec2, type BezierBoard } from '@openshaper/kernel';
import { parseBrd } from '@openshaper/io';
import { createBoardStore } from './board-store';
import { selectSpecs } from './selectors';

const here = dirname(fileURLToPath(import.meta.url));
const shortboard = (): BezierBoard =>
  parseBrd(readFileSync(resolve(here, '../../../docs/specs/golden/shortboard.brd'), 'utf8'))
    .board;

const round = (v: unknown): unknown => {
  if (typeof v === 'number') return Number.isFinite(v) ? Number(v.toPrecision(8)) : String(v);
  if (Array.isArray(v)) return v.map(round);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]));
  }
  return v;
};

type Store = ReturnType<typeof createBoardStore>;

const digest = (store: Store) => {
  const s = store.getState();
  const b = s.board!;
  const specs = selectSpecs(b);
  return {
    past: s.past.map((h) => h.label),
    future: s.future.map((h) => h.label),
    editing: s.editing,
    selection: s.selection,
    selectedFin: s.selectedFin,
    interpolationType: b.interpolationType,
    knots: {
      outline: b.outline.knots.length,
      bottom: b.bottom.knots.length,
      deck: b.deck.knots.length,
      sections: b.crossSections.map((cs) => cs.spline.knots.length),
    },
    stations: round(b.crossSections.map((cs) => cs.position)),
    fins: round(b.fins),
    specs: round({
      length: specs.length,
      maxWidth: specs.maxWidth,
      thickness: specs.thickness,
      maxRocker: specs.maxRocker,
      volume: specs.volume,
    }),
    boardHash: createHash('sha256')
      .update(JSON.stringify(round(b)))
      .digest('hex')
      .slice(0, 16),
  };
};

const withBoard = (): Store => {
  const store = createBoardStore();
  store.getState().load(shortboard());
  return store;
};

const SCENARIOS: [string, (s: Store['getState']) => void][] = [
  ['load only', () => {}],
  [
    'move an outline control point',
    (g) => {
      const k = g().board!.outline.knots[2]!;
      g().moveControlPoint({ kind: 'outline' }, 2, vec2(k.end.x + 3, k.end.y + 0.5));
    },
  ],
  [
    'drag a rocker tangent as one grouped edit',
    (g) => {
      g().beginEdit('Drag');
      const k = g().board!.bottom.knots[1]!;
      for (let i = 1; i <= 5; i++) {
        g().moveTangent(
          { kind: 'bottom' },
          1,
          'next',
          vec2(k.tangentToNext.x + i, k.tangentToNext.y + i * 0.1),
        );
      }
      g().endEdit();
    },
  ],
  [
    'add then delete a deck control point',
    (g) => {
      g().addControlPoint({ kind: 'deck' }, vec2(90, 8));
      const sel = g().selection;
      if (sel) g().deleteControlPoint(sel.target, sel.index);
    },
  ],
  [
    'knot tools on a cross-section',
    (g) => {
      const t = { kind: 'crossSection', index: 3 } as const;
      g().setContinuous(t, 1, false);
      g().fairControlPoint(t, 1);
      g().zeroTangent(t, 1, 'next');
      g().extendTangent(t, 1, 'next');
      g().alignTangentsHorizontal(t, 0);
      g().alignTangentsVertical(t, 1);
    },
  ],
  [
    'add, move and delete a cross-section',
    (g) => {
      const i = g().addCrossSection(100);
      g().moveCrossSection(i, 110);
      g().deleteCrossSection(i);
    },
  ],
  [
    'paste a section shape and apply a rail preset',
    (g) => {
      const src = g().board!.crossSections[2]!.spline;
      g().pasteCrossSection(4, src);
      g().applyRailPreset(3, '60-40-tucked');
    },
  ],
  ['scale the board', (g) => g().scaleBoard(1.05, 0.97, 1.1)],
  ['switch to sLinear interpolation', (g) => g().setInterpolationType('sLinear')],
  [
    'fin edits',
    (g) => {
      g().setFinSetup('quad');
      g().setFinSystem('futures');
      g().setFinSymmetrical(false);
      g().updateFin(0, { cant: 4 });
      g().moveFin(1, vec2(20, 18));
      g().selectFin(1);
    },
  ],
  [
    'edit with thickness adjustment off',
    (g) => {
      g().setAdjustThickness(false);
      const k = g().board!.deck.knots[1]!;
      g().moveControlPoint({ kind: 'deck' }, 1, vec2(k.end.x, k.end.y + 1));
    },
  ],
  [
    'undo, redo and jump through history',
    (g) => {
      g().scaleBoard(1.1, 1, 1);
      g().setFinSetup('twin');
      g().setInterpolationType('sLinear');
      g().undo();
      g().undo();
      g().redo();
      g().jumpTo(0);
    },
  ],
];

describe('characterization: store actions on the reference shortboard', () => {
  for (const [name, run] of SCENARIOS) {
    it(name, () => {
      const store = withBoard();
      run(store.getState);
      expect(digest(store)).toMatchSnapshot();
    });
  }
});
