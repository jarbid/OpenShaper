// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The cross-section tab with the rails store active: the Deck | Bottom control picks the curve the tab
 * edits (its target counts the document's stations, converted from the tab's slice with `stationOfSlice`),
 * a drag of a knot changes that curve of that station and nothing else, undo restores it, the closed
 * section and the other curve are guides, and an end slice has nothing to edit.
 */
import type { RailsBoard } from '@openshaper/board2';
import { parseBrd } from '@openshaper/io';
import {
  SplineEditor,
  viewportFromCenter,
  worldToScreen,
  type ViewCenter,
} from '@openshaper/render2d';
import { stationCurvesOf } from '@openshaper/store';
import { createRailsStore, sliceOfStation } from '@openshaper/store/rails';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CrossSectionControls } from './CrossSectionControls';
import { railsSectionGuides, railsSectionTargets, type RailsCurve } from './rails-section-pane';
import sampleBrd from './sample-board.brd?raw';
import { installLayoutStubs, MOUSE, pane, removeLayoutStubs } from './test/spline-editor-harness';
import { lengthUnitByKey } from './format';

type Core = typeof import('./workers/nurbs-core');
let railsDoc: RailsBoard;
beforeAll(async () => {
  const core: Core = await import('./workers/nurbs-core');
  const made = core.toRails({ classic: parseBrd(sampleBrd).board });
  if (!made.ok) throw new Error(made.error);
  railsDoc = made.board;
}, 60_000);

beforeEach(installLayoutStubs);
afterEach(removeLayoutStubs);

const STATION = 2;
const SLICE = sliceOfStation(STATION);

describe('the tab’s targets', () => {
  it('count the document’s stations: the slice index is converted, not used as it is', () => {
    expect(railsSectionTargets(SLICE, 7, 'deck', false)).toEqual([
      { kind: 'stationDeck', index: STATION },
    ]);
    expect(railsSectionTargets(1, 7, 'bottom', false)).toEqual([
      { kind: 'stationBottom', index: 0 },
    ]);
    expect(railsSectionTargets(7, 7, 'bottom', false)).toEqual([
      { kind: 'stationBottom', index: 6 },
    ]);
  });

  it('name the minus side too on an asymmetric board', () => {
    expect(railsSectionTargets(SLICE, 7, 'deck', true)).toEqual([
      { kind: 'stationDeck', index: STATION },
      { kind: 'stationDeck', index: STATION, side: 'minus' },
    ]);
  });

  it('leave an end slice nothing to edit: only the read-only closed section', () => {
    expect(railsSectionTargets(0, 7, 'deck', false)).toEqual([{ kind: 'crossSection', index: 0 }]);
    expect(railsSectionTargets(8, 7, 'deck', false)).toEqual([{ kind: 'crossSection', index: 8 }]);
    const store = createRailsStore();
    store.getState().loadDoc(railsDoc);
    const doc = store.getState().doc;
    store.getState().moveControlPoint({ kind: 'crossSection', index: 0 }, 0, { x: 1, y: 1 });
    expect(store.getState().doc).toBe(doc);
  });

  it('draw the closed section and the other curve as guides', () => {
    const store = createRailsStore();
    store.getState().loadDoc(railsDoc);
    const board = store.getState().board!;
    const guides = railsSectionGuides(board, SLICE, 'deck', false);
    expect(guides).toEqual([
      board.crossSections[SLICE]!.spline,
      stationCurvesOf(board)![STATION]!.bottom,
    ]);
    expect(railsSectionGuides(board, SLICE, 'bottom', false)[1]).toBe(
      stationCurvesOf(board)![STATION]!.deck,
    );
  });
});

/** The tab as the app builds it: the controls and the editor over the rails store. */
function Tab({
  store,
  onView,
}: {
  store: ReturnType<typeof createRailsStore>;
  onView: (v: ViewCenter) => void;
}) {
  const [curve, setCurve] = useState<RailsCurve>('deck');
  const stations = store.getState().doc!.stations.length;
  return (
    <>
      <CrossSectionControls
        index={SLICE}
        total={stations}
        onPrev={() => {}}
        onNext={() => {}}
        onAdd={() => {}}
        onDelete={() => {}}
        onCopy={() => {}}
        onPaste={() => {}}
        canPaste={false}
        positionCm={50}
        units={lengthUnitByKey('cm')}
        onMoveTo={() => {}}
        curve={curve}
        onCurve={setCurve}
      />
      <SplineEditor
        key={`cs-${SLICE}-${curve}`}
        store={store}
        targets={railsSectionTargets(SLICE, stations, curve, false)}
        colors={['#fff']}
        mirrorX
        onViewChange={onView}
      />
    </>
  );
}

describe('the Deck | Bottom control and a drag', () => {
  it('Deck is the editable curve by default; Bottom makes the bottom curve the one', () => {
    const store = createRailsStore();
    act(() => store.getState().loadDoc(railsDoc));
    const { container } = render(<Tab store={store} onView={() => {}} />);
    expect(screen.getByRole('button', { name: 'Deck' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Bottom' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    // a rails board has no closed section to copy or paste
    expect(screen.queryByRole('button', { name: /copy cross-section/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /paste cross-section/i })).toBeNull();
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it.each([
    ['deck', 'stationDeck'],
    ['bottom', 'stationBottom'],
  ] as const)(
    'a drag of a %s knot changes that curve of that station and nothing else; undo restores it',
    (curve, kind) => {
      const store = createRailsStore();
      act(() => store.getState().loadDoc(railsDoc));
      let view: ViewCenter | null = null;
      const { container } = render(
        <Tab
          store={store}
          onView={(v) => {
            view = v;
          }}
        />,
      );
      if (curve === 'bottom') fireEvent.click(screen.getByRole('button', { name: 'Bottom' }));
      const canvas = container.querySelector('canvas')!;
      const screenOf = (x: number, y: number) => {
        const p = worldToScreen(viewportFromCenter(view!, pane.w, pane.h), { x, y });
        return { clientX: p.x, clientY: p.y };
      };
      const before = store.getState().doc!;
      const spline = stationCurvesOf(store.getState().board!)![STATION]![curve];
      const k = spline.knots[1]!.end;
      const on = screenOf(k.x, k.y);
      fireEvent.pointerDown(canvas, { ...MOUSE, ...on });
      expect(store.getState().selection).toMatchObject({
        target: { kind, index: STATION },
        index: 1,
      });
      const to = screenOf(k.x, k.y + 0.3);
      fireEvent.pointerMove(canvas, { ...MOUSE, ...to });
      fireEvent.pointerUp(canvas, { ...MOUSE, ...to });

      const after = store.getState().doc!;
      expect(after).not.toBe(before);
      const same = (name: keyof RailsBoard) => expect(after[name]).toBe(before[name]);
      for (const name of ['outline', 'corners', 'rocker', 'deck', 'rails', 'features'] as const)
        same(name);
      after.stations.forEach((s, i) => {
        if (i !== STATION) expect(s).toBe(before.stations[i]);
      });
      const was = before.stations[STATION]!;
      const now = after.stations[STATION]!;
      const other = curve === 'deck' ? 'bottom' : 'deck';
      expect(now.plus[curve]).not.toBe(was.plus[curve]);
      expect(now.plus[other]).toBe(was.plus[other]);
      // the knot moved up by what the drag moved it
      expect(
        stationCurvesOf(store.getState().board!)![STATION]![curve].knots[1]!.end.y - k.y,
      ).toBeCloseTo(0.3, 1);

      act(() => store.getState().undo());
      expect(store.getState().doc).toBe(before);
    },
  );
});
