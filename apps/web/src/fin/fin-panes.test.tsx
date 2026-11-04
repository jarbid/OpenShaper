// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The section and taper panes, wired to the fin store: real pointer events on the
 * panes' canvases, checked in the store. Picking and drag maths are tested in
 * render2d; the store's clamping in store/fin-store.test.ts.
 */
import { defaultFinDesign, FIN_MIN_THICKNESS, foilShare } from '@openshaper/kernel';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFinJson } from '@openshaper/io';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lengthUnitByKey } from '../format';
import { MOUSE, installLayoutStubs, pane, removeLayoutStubs } from '../test/spline-editor-harness';
import { FinOutlinePane } from './FinOutlinePane';
import { FinSectionPane, FinSectionTools } from './FinSectionPane';
import { FinTaperPane } from './FinTaperPane';
import { finStore } from './fin-store';

beforeEach(installLayoutStubs);
afterEach(removeLayoutStubs);

const design = () => finStore.getState().design!;

/** Tests that build real geometry (STEP export, many pointer probes): CI runners are slower. */
const HEAVY = 20_000;

describe('FinSectionTools', () => {
  beforeEach(() => act(() => finStore.getState().load(defaultFinDesign('side', 'right'))));

  it('applies a NACA preset to the section', () => {
    render(<FinSectionTools store={finStore} units={lengthUnitByKey('mm')} />);
    fireEvent.change(screen.getByLabelText('NACA preset'), { target: { value: '2412' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(design().section.inside).not.toBeNull();
    expect(finStore.getState().past.at(-1)!.label).toBe('NACA 2412');
  });

  it('offers every preset again after one is applied', () => {
    render(<FinSectionTools store={finStore} units={lengthUnitByKey('mm')} />);
    fireEvent.change(screen.getByLabelText('NACA preset'), { target: { value: '2412' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('0010');
    expect(options).toContain('6409');
    fireEvent.change(screen.getByLabelText('NACA preset'), { target: { value: '0010' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(finStore.getState().past.at(-1)!.label).toBe('NACA 0010');
  });

  it('takes any other 4-digit code', () => {
    render(<FinSectionTools store={finStore} units={lengthUnitByKey('mm')} />);
    fireEvent.change(screen.getByLabelText('NACA preset'), { target: { value: 'other' } });
    fireEvent.change(screen.getByLabelText('NACA 4-digit code'), { target: { value: '3415' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(finStore.getState().past.at(-1)!.label).toBe('NACA 3415');
  });

  it('explains a code it cannot use', () => {
    render(<FinSectionTools store={finStore} units={lengthUnitByKey('mm')} />);
    fireEvent.change(screen.getByLabelText('NACA preset'), { target: { value: 'other' } });
    fireEvent.change(screen.getByLabelText('NACA 4-digit code'), { target: { value: '24' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert').textContent).toMatch(/NACA 4-digit code/);
    expect(finStore.getState().canUndo()).toBe(false);
  });

  it('keeps a centre fin symmetric', () => {
    act(() => finStore.getState().load(defaultFinDesign('centre')));
    render(<FinSectionTools store={finStore} units={lengthUnitByKey('mm')} />);
    expect(screen.queryByRole('button', { name: 'Asymmetric' })).toBeNull();
    expect(screen.queryByRole('option', { name: '2412' })).toBeNull(); // only 00xx offered
    fireEvent.change(screen.getByLabelText('NACA preset'), { target: { value: 'other' } });
    fireEvent.change(screen.getByLabelText('NACA 4-digit code'), { target: { value: '2412' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert').textContent).toMatch(/symmetric/);
    expect(design().section.inside).toBeNull();
  });

  it('switches a side fin between symmetric and asymmetric, highlighting the choice', () => {
    render(<FinSectionTools store={finStore} units={lengthUnitByKey('mm')} />);
    const sym = () => screen.getByRole('button', { name: 'Symmetric' });
    const asym = () => screen.getByRole('button', { name: 'Asymmetric' });
    fireEvent.click(sym());
    expect(design().section.inside).toBeNull();
    expect(sym().getAttribute('aria-pressed')).toBe('true');
    expect(asym().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(asym());
    // Starts flat inside: 100 / 0.
    expect(foilShare(design().section)).toBe(1);
    expect(asym().getAttribute('aria-pressed')).toBe('true');
    // Clicking it again keeps the faces.
    const faces = design().section;
    fireEvent.click(asym());
    expect(design().section).toBe(faces);
  });
});

describe('the outside / inside split', () => {
  beforeEach(() => act(() => finStore.getState().load(defaultFinDesign('side', 'right'))));
  const outside = () =>
    screen.getByLabelText('Outside share of the thickness (%)') as HTMLInputElement;
  const inside = () =>
    screen.getByLabelText('Inside share of the thickness (%)') as HTMLInputElement;

  it('shows for an asymmetric side fin, and not for a symmetric one', () => {
    const { unmount } = render(<FinSectionPane store={finStore} units={lengthUnitByKey('mm')} />);
    expect(outside().value).toBe('100'); // the starting side fin is flat inside
    expect(inside().value).toBe('0');
    unmount();
    act(() => finStore.getState().setInsideFace('symmetric'));
    render(<FinSectionPane store={finStore} units={lengthUnitByKey('mm')} />);
    expect(screen.queryByLabelText('Outside share of the thickness (%)')).toBeNull();
  });

  it('fills in the other box as you type, and builds the foil on Enter, as one undo step', () => {
    render(<FinSectionPane store={finStore} units={lengthUnitByKey('mm')} />);
    const before = finStore.getState().past.length;
    fireEvent.change(outside(), { target: { value: '70' } });
    expect(inside().value).toBe('30');
    fireEvent.keyDown(outside(), { key: 'Enter' });
    expect(foilShare(design().section)).toBeCloseTo(0.7, 5);
    expect(finStore.getState().past).toHaveLength(before + 1);
    expect(finStore.getState().past.at(-1)!.label).toBe('Foil 70 / 30');
    expect(outside().value).toBe('70');
    // Typing in the inside box works the same way round.
    fireEvent.change(inside(), { target: { value: '40' } });
    expect(outside().value).toBe('60');
    fireEvent.keyDown(inside(), { key: 'Enter' });
    expect(foilShare(design().section)).toBeCloseTo(0.6, 5);
  });

  it('stops at 51 / 49, leaving an even split to Symmetric, and ignores what isn’t a percentage', () => {
    render(<FinSectionPane store={finStore} units={lengthUnitByKey('mm')} />);
    for (const [box, value] of [
      [outside, '50'],
      [outside, '30'],
      [inside, '50'],
      [inside, '70'],
    ] as const) {
      fireEvent.change(box(), { target: { value } });
      fireEvent.keyDown(box(), { key: 'Enter' });
      expect(foilShare(design().section)).toBeCloseTo(0.51, 5);
      expect([outside().value, inside().value]).toEqual(['51', '49']);
    }
    expect(design().section.inside).not.toBeNull(); // still asymmetric
    const faces = design().section;
    fireEvent.change(outside(), { target: { value: '120' } });
    expect(inside().value).toBe('');
    fireEvent.keyDown(outside(), { key: 'Enter' });
    expect(design().section).toBe(faces);
    expect(outside().value).toBe('51');
  });
});

describe('dragging in the panes', () => {
  beforeEach(() => act(() => finStore.getState().load(defaultFinDesign('side', 'right'))));

  /**
   * Find a data point's client position by clicking candidates until the store
   * selects it: the panes don't expose their view, and a test that re-derives the
   * fit would only check the fit against itself.
   */
  const grab = (canvas: HTMLElement, curve: string, index: number) => {
    for (let y = 0; y < pane.h; y += 4) {
      for (let x = 0; x < pane.w; x += 4) {
        fireEvent.pointerDown(canvas, { ...MOUSE, clientX: x, clientY: y });
        const sel = finStore.getState().selection;
        if (sel?.curve === curve && sel.index === index && (sel.kind ?? 'end') === 'end') {
          return { clientX: x, clientY: y };
        }
        fireEvent.pointerUp(canvas, { ...MOUSE, clientX: x, clientY: y });
      }
    }
    throw new Error(`could not grab ${curve} ${index}`);
  };

  it(
    'stands the taper upright: root at the bottom, tip at the top',
    () => {
      render(<FinTaperPane store={finStore} units={lengthUnitByKey('mm')} />);
      const canvas = screen.getByRole('img', { name: 'Thickness taper' });
      const last = design().taper.knots.length - 1;
      const root = grab(canvas, 'taper', 0);
      fireEvent.pointerUp(canvas, { ...MOUSE, clientX: root.clientX, clientY: root.clientY });
      const tip = grab(canvas, 'taper', last);
      fireEvent.pointerUp(canvas, { ...MOUSE, clientX: tip.clientX, clientY: tip.clientY });
      expect(root.clientY).toBeGreaterThan(tip.clientY);
      expect(root.clientX).toBeGreaterThan(tip.clientX); // the root is the thicker end
    },
    HEAVY,
  );

  it('drags a taper point and stops it at the minimum thickness', () => {
    render(<FinTaperPane store={finStore} units={lengthUnitByKey('mm')} />);
    const canvas = screen.getByRole('img', { name: 'Thickness taper' });
    const i = 1; // the knot where the straight run turns into the curve
    const at = grab(canvas, 'taper', i);
    // The pane stands upright: thickness runs across, so thinner is to the left.
    fireEvent.pointerMove(canvas, { ...MOUSE, clientX: at.clientX - 2000, clientY: at.clientY });
    fireEvent.pointerUp(canvas, { ...MOUSE, clientX: at.clientX - 2000, clientY: at.clientY });
    const k = design().taper.knots[i]!.end;
    expect(k.y).toBeGreaterThanOrEqual(FIN_MIN_THICKNESS - 1e-9);
    expect(k.y).toBeLessThan(0.4); // it got thinner, as far as the rules allow
    expect(finStore.getState().past).toHaveLength(1); // one drag, one undo step
  });

  it('sets the minimum thickness from the thickness view, in the current unit', () => {
    // Owner request: 0.5 mm by default; set higher, the taper's tip and the line follow.
    render(<FinTaperPane store={finStore} units={lengthUnitByKey('mm')} />);
    const box = screen.getByLabelText('Fin minimum thickness') as HTMLInputElement;
    expect(box.value).toBe('0.50');
    fireEvent.change(box, { target: { value: '1.2' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(design().minThickness).toBeCloseTo(0.12, 9);
    expect(design().taper.knots.at(-1)!.end.y).toBeCloseTo(0.12, 9);
    expect(box.value).toBe('1.20');
    // Past 3 mm: 3 mm.
    fireEvent.change(box, { target: { value: '9' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(design().minThickness).toBeCloseTo(0.3, 9);
    expect(box.value).toBe('3.00');
  });

  it('drags the outside face of the foil', () => {
    render(<FinSectionPane store={finStore} units={lengthUnitByKey('mm')} />);
    const canvas = screen.getByRole('img', { name: 'Foil section' });
    const before = design().section.outside.knots[1]!.end;
    const at = grab(canvas, 'outside', 1);
    fireEvent.pointerMove(canvas, { ...MOUSE, clientX: at.clientX + 20, clientY: at.clientY });
    fireEvent.pointerUp(canvas, { ...MOUSE, clientX: at.clientX + 20, clientY: at.clientY });
    const after = design().section.outside.knots[1]!.end;
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeCloseTo(before.y, 9);
  });
});

describe('the thickness view on a swept-back fin', () => {
  it('notes when it is read along the sweep, and only then', () => {
    act(() => finStore.getState().load(defaultFinDesign('side', 'right')));
    const { unmount } = render(<FinTaperPane store={finStore} units={lengthUnitByKey('mm')} />);
    expect(screen.queryByTestId('taper-along-sweep')).toBeNull();
    unmount();
    // Tests run from apps/web.
    const file = resolve(process.cwd(), '../../docs/specs/fins/swept_back_tip.fin.json');
    act(() => finStore.getState().load(readFinJson(readFileSync(file, 'utf8')).design));
    render(<FinTaperPane store={finStore} units={lengthUnitByKey('mm')} />);
    expect(screen.getByTestId('taper-along-sweep').textContent).toMatch(/along the sweep/);
  });
});

describe('a slice that crosses the tip line, in the foil view', () => {
  beforeEach(() =>
    act(() => {
      finStore.getState().load(defaultFinDesign('side', 'right'));
      finStore.getState().addSlice(0.93); // made the active foil
    }),
  );

  it(
    'drags a point past the crossing: the tip foil shapes that part, nothing is locked',
    () => {
      // Owner testing: with the tip line moved forward, a slice's points there were locked.
      render(<FinSectionPane store={finStore} units={lengthUnitByKey('mm')} />);
      const canvas = screen.getByRole('img', { name: 'Foil section' });
      const knots = () => design().slices[0]!.section.outside.knots;
      const last = knots().length - 2; // the last point before the trailing edge
      const before = knots()[last]!.end;
      let at: { clientX: number; clientY: number } | null = null;
      for (let y = 0; y < pane.h && !at; y += 3) {
        for (let x = 0; x < pane.w && !at; x += 3) {
          fireEvent.pointerDown(canvas, { ...MOUSE, clientX: x, clientY: y });
          const sel = finStore.getState().selection;
          if (sel?.curve === 'outside' && sel.index === last && (sel.kind ?? 'end') === 'end') {
            at = { clientX: x, clientY: y };
          } else fireEvent.pointerUp(canvas, { ...MOUSE, clientX: x, clientY: y });
        }
      }
      expect(at).not.toBeNull();
      fireEvent.pointerMove(canvas, { ...MOUSE, clientX: at!.clientX, clientY: at!.clientY - 6 });
      fireEvent.pointerUp(canvas, { ...MOUSE, clientX: at!.clientX, clientY: at!.clientY - 6 });
      expect(knots()[last]!.end.y).toBeGreaterThan(before.y);
    },
    HEAVY,
  );
});

describe('selecting several points in a pane', () => {
  beforeEach(() => act(() => finStore.getState().load(defaultFinDesign('side', 'right'))));

  /** Where a point is on screen: clicked until selected, as in `grab` above. */
  const find = (canvas: HTMLElement, index: number) => {
    for (let y = 0; y < pane.h; y += 4) {
      for (let x = 0; x < pane.w; x += 4) {
        fireEvent.pointerDown(canvas, { ...MOUSE, clientX: x, clientY: y });
        fireEvent.pointerUp(canvas, { ...MOUSE, clientX: x, clientY: y });
        const sel = finStore.getState().selection;
        if (sel?.curve === 'outline' && sel.index === index && (sel.kind ?? 'end') === 'end') {
          return { clientX: x, clientY: y };
        }
      }
    }
    throw new Error(`could not find outline point ${index}`);
  };

  it(
    'draws the profile front on the left, as the foil view runs',
    () => {
      // Owner request: fin designers draw profiles front left, rear right.
      render(<FinOutlinePane store={finStore} units={lengthUnitByKey('mm')} />);
      const canvas = screen.getByRole('img', { name: 'Fin outline' });
      const last = design().outline.knots.length - 1;
      const front = find(canvas, 0); // the leading-edge root
      const rear = find(canvas, last); // the trailing-edge root
      expect(front.clientX).toBeLessThan(rear.clientX);
    },
    HEAVY,
  );

  it(
    'shift-clicks a second point, then drags both the same way',
    () => {
      render(<FinOutlinePane store={finStore} units={lengthUnitByKey('mm')} />);
      const canvas = screen.getByRole('img', { name: 'Fin outline' });
      const b = find(canvas, 2);
      const a = find(canvas, 1); // selected on its own
      const shift = { ...MOUSE, shiftKey: true };
      fireEvent.pointerDown(canvas, { ...shift, ...b });
      fireEvent.pointerUp(canvas, { ...shift, ...b });
      expect(finStore.getState().selection).toMatchObject({ index: 2, also: [1] });
      // A shift-click on empty space keeps the selection.
      fireEvent.pointerDown(canvas, { ...shift, clientX: 1, clientY: 1 });
      fireEvent.pointerUp(canvas, { ...shift, clientX: 1, clientY: 1 });
      expect(finStore.getState().selection).toMatchObject({ index: 2, also: [1] });
      const before = design().outline.knots.map((k) => k.end);
      const pastBefore = finStore.getState().past.length;
      // Grab the first point (no shift: the group stays) and drag it.
      fireEvent.pointerDown(canvas, { ...MOUSE, ...a });
      fireEvent.pointerMove(canvas, { ...MOUSE, clientX: a.clientX + 12, clientY: a.clientY - 8 });
      fireEvent.pointerUp(canvas, { ...MOUSE, clientX: a.clientX + 12, clientY: a.clientY - 8 });
      const after = design().outline.knots.map((k) => k.end);
      const d1 = { x: after[1]!.x - before[1]!.x, y: after[1]!.y - before[1]!.y };
      const d2 = { x: after[2]!.x - before[2]!.x, y: after[2]!.y - before[2]!.y };
      expect(Math.hypot(d1.x, d1.y)).toBeGreaterThan(0);
      expect(d2.x).toBeCloseTo(d1.x, 9);
      expect(d2.y).toBeCloseTo(d1.y, 9);
      expect(after[3]).toEqual(before[3]); // not selected: left alone
      expect(finStore.getState().past).toHaveLength(pastBefore + 1); // one drag, one step
    },
    HEAVY,
  );
});

describe('foil slices in the panes', () => {
  beforeEach(() =>
    act(() => {
      finStore.getState().load(defaultFinDesign('side', 'left'));
      finStore.getState().addSlice(0.5);
      finStore.getState().setActiveFoil(0);
    }),
  );

  it('drags a slice line in the profile up the blade, picking its foil', () => {
    render(<FinOutlinePane store={finStore} units={lengthUnitByKey('mm')} />);
    const canvas = screen.getByRole('img', { name: 'Fin outline' });
    // Find the line by probing down the pane, clear of where the thickness path crosses it.
    let hit: { clientX: number; clientY: number } | null = null;
    for (const x of [pane.w / 2, pane.w * 0.3, pane.w * 0.7]) {
      for (let y = 0; y < pane.h && !hit; y += 2) {
        fireEvent.pointerDown(canvas, { ...MOUSE, clientX: x, clientY: y });
        if (finStore.getState().activeFoil === 1) hit = { clientX: x, clientY: y };
        else fireEvent.pointerUp(canvas, { ...MOUSE, clientX: x, clientY: y });
      }
    }
    expect(hit).not.toBeNull();
    fireEvent.pointerMove(canvas, { ...MOUSE, clientX: hit!.clientX, clientY: hit!.clientY - 40 });
    fireEvent.pointerUp(canvas, { ...MOUSE, clientX: hit!.clientX, clientY: hit!.clientY - 40 });
    expect(design().slices[0]!.height).toBeGreaterThan(0.5);
    expect(finStore.getState().past.at(-1)!.label).toBe('Move foil slice');
  });
});
