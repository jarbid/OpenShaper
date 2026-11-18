// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getWantedProbes,
  resetProbes,
  setWantedProbes,
  setWantedProbesFor,
  subscribeWantedProbes,
} from './nurbs-probes';

afterEach(resetProbes);

describe('the places wanted', () => {
  it('are the section pane’s list, as they always were', () => {
    setWantedProbes([10, 20]);
    expect(getWantedProbes()).toEqual([10, 20]);
    setWantedProbes([]);
    expect(getWantedProbes()).toEqual([]);
  });

  it('are the lists of every part that asks, each place once', () => {
    setWantedProbes([10, 20]);
    setWantedProbesFor('rails-step', [20, 30]);
    expect(getWantedProbes()).toEqual([10, 20, 30]);
  });

  it('keep one part’s places when another changes or withdraws its own', () => {
    setWantedProbesFor('rails-step', [30]);
    setWantedProbes([10]);
    setWantedProbes([]);
    expect(getWantedProbes()).toEqual([30]);
    setWantedProbes([5]);
    setWantedProbesFor('rails-step', []);
    expect(getWantedProbes()).toEqual([5]);
  });

  it('tell the layer only when the whole list changed', () => {
    const seen = vi.fn();
    const stop = subscribeWantedProbes(seen);
    setWantedProbesFor('rails-step', [30]);
    setWantedProbesFor('rails-step', [30]);
    expect(seen).toHaveBeenCalledTimes(1);
    // the same place asked by another part changes nothing
    setWantedProbes([30]);
    expect(seen).toHaveBeenCalledTimes(1);
    setWantedProbes([30, 40]);
    expect(seen).toHaveBeenCalledTimes(2);
    stop();
  });

  it('are the same list object while nothing changes', () => {
    setWantedProbes([1]);
    const first = getWantedProbes();
    setWantedProbesFor('rails-step', []);
    expect(getWantedProbes()).toBe(first);
  });
});
