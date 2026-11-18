// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The slice against the real rails store: the section the engine gave for the map's cursor, drawn with its
 * dimensions and apex, and what it says in a blend; the zone's own slice for the panel; and that it keeps the
 * last section while the next is on its way.
 */
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import { resetMyRails } from '../my-rails';
import { publishProbes, resetProbes, setWantedProbes } from '../nurbs-probes';
import { resetRailChoice, setRailPlace } from '../rail-choice';
import { activeStore, boardStore } from '../store';
import { key, SAMPLE_LENGTH, showRails } from '../test/rails-board';
import type { SectionProbe } from '../workers/nurbs-protocol';
import { RailSlice, ZoneSlice } from './RailSlice';
import { RailsStep } from './RailsStep';

const CM = lengthUnitByKey('cm');
const KEYS = [key(20, 0.5), key(60, 0.5), key(100, 0.3), key(140, 0.4), key(180, 0.4)];
const MID = SAMPLE_LENGTH / 2;

/** A half section 10 cm wide and 2.5 cm thick with its apex at (10, 1.2), scaled in y by `k`. */
const half = (k = 1) => [0, 0, 4 * k, 0.1, 8 * k, 0.6, 10 * k, 1.2, 8.5 * k, 2, 4 * k, 2.4, 0, 2.5];
const probe = (xi: number, minus: number[] | null = null, k = 1): SectionProbe => ({
  xi,
  plus: half(k),
  minus,
});

beforeEach(async () => {
  resetMyRails();
  await showRails({ plus: KEYS });
});
afterEach(() => {
  resetRailChoice();
  resetProbes();
  publishProbes([]);
  activeStore.use(boardStore);
});

describe('the slice under the map', () => {
  it('says the section is being built until the engine answers', () => {
    render(<RailSlice units={CM} />);
    expect(screen.getByText('Building the section…')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('draws the section at the cursor with its half width and thickness in the display unit', () => {
    act(() => publishProbes([probe(MID)]));
    render(<RailSlice units={CM} />);
    const img = screen.getByRole('img');
    expect(img.getAttribute('aria-label')).toBe(
      'Section of the board at 93.98 cm: half width 10.00 cm, thickness 2.50 cm',
    );
    const text = img.textContent!;
    expect(text).toContain('Half width 10.00 cm');
    expect(text).toContain('Thickness');
    expect(text).toContain('2.50 cm');
    // a marker for the apex of each half, and the stringer
    expect(img.querySelectorAll('circle')).toHaveLength(2);
    expect(img.querySelector('line[stroke-dasharray]')).not.toBeNull();
    // the rail's apex as the board has it there: near the tick of apex 0.3, in the blend before it
    expect(text).toContain('Apex 70/30');
  });

  it('reads in the unit the editor is set to', () => {
    act(() => publishProbes([probe(MID)]));
    render(<RailSlice units={lengthUnitByKey('mm')} />);
    expect(screen.getByRole('img').textContent).toContain('Half width 100.0 mm');
  });

  it('says where the cursor is: in a zone, or how far across a blend', () => {
    act(() => publishProbes([probe(40), probe(80)]));
    render(<RailSlice units={CM} />);
    act(() => setRailPlace(40));
    expect(screen.getByText(/Slice at 40.00 cm, to scale\. In zone 1, Round\./)).toBeTruthy();
    act(() => setRailPlace(80));
    expect(screen.getByText(/Between Round and zone 2, 50% of the way\./)).toBeTruthy();
  });

  it('keeps the last section while the answer for the next place is on its way', () => {
    act(() => publishProbes([probe(40, null, 1)]));
    render(<RailSlice units={CM} />);
    act(() => setRailPlace(40));
    const first = screen.getByRole('img').innerHTML;
    act(() => setRailPlace(41));
    expect(screen.queryByText('Building the section…')).toBeNull();
    expect(screen.getByRole('img').innerHTML).toBe(first);
    act(() => publishProbes([probe(41, null, 1.5)]));
    expect(screen.getByRole('img').innerHTML).not.toBe(first);
  });

  it('says so, rather than draw nothing, at a place where the board has no width', () => {
    act(() => publishProbes([{ xi: MID, plus: [0, 0, 0, 1], minus: null }]));
    render(<RailSlice units={CM} />);
    expect(screen.getByText(/Nothing to draw here/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('draws the right side of a board that has one, apart from the left, and names the sides', () => {
    const minus = half(0.7);
    act(() => publishProbes([probe(MID, minus)]));
    render(<RailSlice units={CM} />);
    const text = screen.getByRole('img').textContent!;
    expect(text).toContain('Left half width 10.00 cm');
    expect(text).toContain('Right half width 7.00 cm');
  });
});

describe('the zone’s slice in the panel', () => {
  it('is the section at the zone’s start, with a caption, and a dashed outline at its end', () => {
    act(() => publishProbes([probe(20), probe(60, null, 1.4)]));
    render(<ZoneSlice from={20} to={60} units={CM} />);
    const figure = screen.getByRole('figure', { name: "This zone's rail" });
    expect(within(figure).getByRole('img')).toBeTruthy();
    expect(figure.textContent).toContain(
      'Section at the zone’s start, 20.00 cm; dashed: at its end, 60.00 cm.',
    );
    expect(figure.querySelectorAll('path[stroke-dasharray]')).toHaveLength(2);
  });

  it('has no second outline for a zone of no length', () => {
    act(() => publishProbes([probe(100)]));
    render(<ZoneSlice from={100} to={100} units={CM} />);
    const figure = screen.getByRole('figure');
    expect(figure.querySelectorAll('path[stroke-dasharray]')).toHaveLength(0);
    expect(figure.textContent).toContain('Section at the zone’s start, 100.00 cm.');
  });

  it('waits for the engine', () => {
    render(<ZoneSlice from={20} to={60} units={CM} />);
    expect(screen.getByText('Building the section…')).toBeTruthy();
  });
});

describe('the places the Rails step asks for', () => {
  it('are the cursor’s, then the chosen zone’s two ends, and are withdrawn when the step goes', async () => {
    const { getWantedProbes } = await import('../nurbs-probes');
    setWantedProbes([5]);
    const { unmount } = render(<RailsStep units={CM} />);
    expect(getWantedProbes()).toEqual([5, MID]);
    const { chooseRail } = await import('../patch-look');
    act(() => chooseRail({ side: 'plus', zone: 0 }, 40));
    expect(getWantedProbes()).toEqual([5, 40, 20, 60]);
    unmount();
    expect(getWantedProbes()).toEqual([5]);
  });

  it('hold the ends where they were while a drag is open, and take the new ones when it ends', async () => {
    const { getWantedProbes } = await import('../nurbs-probes');
    const { chooseRail } = await import('../patch-look');
    const { railsStore } = await import('../store');
    render(<RailsStep units={CM} />);
    act(() => chooseRail({ side: 'plus', zone: 0 }, 40));
    expect(getWantedProbes()).toEqual([40, 20, 60]);
    act(() => railsStore.getState().beginEdit());
    act(() => railsStore.getState().moveZoneEnd('both', 0, 'to', 70));
    expect(getWantedProbes()).toEqual([40, 20, 60]);
    act(() => railsStore.getState().endEdit());
    expect(getWantedProbes()).toEqual([40, 20, 70]);
  });
});
