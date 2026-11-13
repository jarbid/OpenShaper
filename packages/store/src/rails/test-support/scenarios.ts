// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only: sequences of rails-store actions, each written against whatever board is loaded (the
 * points it picks are found on that board), shared by the store's behaviour tests and its
 * characterization snapshots.
 */
import { vec2 } from '@openshaper/kernel';
import type { StoreApi } from 'zustand/vanilla';
import type { SplineTarget } from '../../edits';
import type { RailsState } from '../rails-store';

type Get = StoreApi<RailsState>['getState'];

const mid = (n: number): number => Math.max(1, Math.floor(n / 2));

/** An interior knot of a station curve, or the last knot of a two-knot one. */
const inner = (n: number): number => (n > 2 ? 1 : n - 1);

export const SCENARIOS: readonly [string, (g: Get) => void][] = [
  ['load only', () => {}],
  [
    'move an outline control point',
    (g) => {
      const o = g().board!.outline;
      const i = mid(o.knots.length);
      const k = o.knots[i]!;
      g().moveControlPoint({ kind: 'outline' }, i, vec2(k.end.x + 2, k.end.y + 0.3));
    },
  ],
  [
    'drag a rocker tangent as one grouped edit',
    (g) => {
      g().beginEdit();
      const k = g().board!.bottom.knots[1]!;
      for (let i = 1; i <= 5; i++) {
        g().moveTangent(
          { kind: 'bottom' },
          1,
          'next',
          vec2(k.tangentToNext.x + i, k.tangentToNext.y + i * 0.05),
        );
      }
      g().endEdit();
    },
  ],
  [
    'move a deck control point',
    (g) => {
      const d = g().board!.deck;
      const i = mid(d.knots.length);
      const k = d.knots[i]!;
      g().moveControlPoint({ kind: 'deck' }, i, vec2(k.end.x, k.end.y + 0.3));
    },
  ],
  [
    'drag a station bottom point',
    (g) => {
      const t: SplineTarget = { kind: 'stationBottom', index: 1 };
      const s = g().board!.stationCurves[1]!.bottom;
      const i = inner(s.knots.length);
      const k = s.knots[i]!;
      g().beginEdit();
      for (let j = 1; j <= 4; j++)
        g().moveControlPoint(t, i, vec2(k.end.x - j * 0.2, k.end.y + j * 0.05));
      g().endEdit();
    },
  ],
  [
    'drag a station deck handle and round it off',
    (g) => {
      const t: SplineTarget = { kind: 'stationDeck', index: 2 };
      const s = g().board!.stationCurves[2]!.deck;
      const k = s.knots[0]!;
      g().moveTangent(t, 0, 'next', vec2(k.tangentToNext.x * 1.3 + 0.5, k.tangentToNext.y + 1));
      const n = s.knots.length - 1;
      g().moveControlPoint(t, n, vec2(s.knots[n]!.end.x + 3, s.knots[n]!.end.y + 0.2));
      g().fairControlPoint(t, inner(s.knots.length));
    },
  ],
  [
    'add then delete a station-curve point',
    (g) => {
      const t: SplineTarget = { kind: 'stationBottom', index: 1 };
      const e = g().board!.stationCurves[1]!;
      g().addControlPoint(t, vec2(e.w * 0.55, 0));
      const sel = g().selection;
      if (sel) g().deleteControlPoint(sel.target, sel.index);
    },
  ],
  [
    'corner and smooth an outline point',
    (g) => {
      const o = g().board!.outline;
      const i = mid(o.knots.length);
      g().setContinuous({ kind: 'outline' }, i, false);
      g().setContinuous({ kind: 'outline' }, i, true);
      g().setContinuous({ kind: 'outline' }, i, false);
    },
  ],
  [
    'add, move and delete a station',
    (g) => {
      const st = g().doc!.stations;
      const x = (st[1]!.x + st[2]!.x) / 2;
      const i = g().addCrossSection(x);
      g().moveCrossSection(i, x + 1);
      g().addCrossSection((st[2]!.x + st[3]!.x) / 2);
      g().deleteCrossSection(i);
    },
  ],
  ['scale the board', (g) => g().scaleBoard(1.05, 0.97, 1.1)],
  [
    'fin edits',
    (g) => {
      g().setFinSetup('quad');
      g().setFinSystem('futures');
      g().updateFin(0, { cant: 4 });
      g().moveFin(1, vec2(20, 18));
      g().selectFin(1);
    },
  ],
  [
    'asymmetric: edit the minus side, then mirror keeping it',
    (g) => {
      g().setSymmetry('asymmetric');
      const m = g().board!.minus!;
      const i = mid(m.outline.knots.length);
      const k = m.outline.knots[i]!;
      g().moveControlPoint({ kind: 'outline', side: 'minus' }, i, vec2(k.end.x, k.end.y - 0.4));
      const s = m.stationCurves[1]!.deck;
      const j = inner(s.knots.length);
      g().moveControlPoint(
        { kind: 'stationDeck', index: 1, side: 'minus' },
        j,
        vec2(s.knots[j]!.end.x, s.knots[j]!.end.y + 0.2),
      );
      g().setSymmetry('mirror', 'minus');
    },
  ],
  [
    'tails: swallow, a deeper notch, fish, standard',
    (g) => {
      g().setTail('swallow');
      g().setNotchDepth(g().doc!.outline.plus.knots[0]!.p[0] + 2);
      g().setTail('fish');
      g().setTail('standard');
    },
  ],
  [
    'drag the notch bottom',
    (g) => {
      if (g().doc!.outline.plus.knots[0]!.p[0] === 0) g().setTail('swallow');
      const d = g().doc!.outline.plus.knots[0]!.p[0];
      g().beginEdit();
      for (let j = 1; j <= 3; j++) g().moveControlPoint({ kind: 'outline' }, 0, vec2(d + j, 0));
      g().endEdit();
    },
  ],
  [
    'bottom features',
    (g) => {
      g().addFeature('channels');
      g().addFeature('single-concave');
      const [a, b] = g().doc!.features.slice(-2);
      g().setFeatureParams(a!.id, { count: 3, width: 1 });
      g().setFeatureDepth(b!.id, 0.4);
      g().addFeatureKey(b!.id);
      g().setFeatureEnabled(a!.id, false);
    },
  ],
  [
    'undo, redo and jump through history',
    (g) => {
      g().scaleBoard(1.1, 1, 1);
      g().setFinSetup('twin');
      const t: SplineTarget = { kind: 'stationBottom', index: 0 };
      const s = g().board!.stationCurves[0]!.bottom;
      g().moveControlPoint(t, s.knots.length - 1, vec2(0, s.knots.at(-1)!.end.y + 0.1));
      g().undo();
      g().undo();
      g().redo();
      g().jumpTo(0);
    },
  ],
];
