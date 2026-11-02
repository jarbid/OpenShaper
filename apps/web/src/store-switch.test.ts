// SPDX-License-Identifier: GPL-3.0-or-later
import { createStore } from 'zustand/vanilla';
import { describe, expect, it } from 'vitest';
import { createStoreSwitch } from './store-switch';

const counter = (n: number) => createStore<{ n: number }>(() => ({ n }));

describe('createStoreSwitch', () => {
  it('stands for its target: reads, writes and subscriptions go to it', () => {
    const a = counter(1);
    const sw = createStoreSwitch(a);
    const seen: number[] = [];
    sw.subscribe((s) => seen.push(s.n));
    expect(sw.getState().n).toBe(1);
    sw.setState({ n: 2 });
    expect(a.getState().n).toBe(2);
    a.setState({ n: 3 });
    expect(seen).toEqual([2, 3]);
  });

  it('switching tells subscribers, who then read the other store; the old one falls silent', () => {
    const a = counter(1);
    const b = counter(10);
    const sw = createStoreSwitch<{ n: number }>(a);
    const seen: number[] = [];
    sw.subscribe((s) => seen.push(s.n));
    sw.use(b);
    expect(sw.target).toBe(b);
    expect(sw.getState().n).toBe(10);
    expect(seen).toEqual([10]);
    a.setState({ n: 99 });
    b.setState({ n: 11 });
    expect(seen).toEqual([10, 11]);
    // using the current target again is not a change
    sw.use(b);
    expect(seen).toEqual([10, 11]);
  });

  it('unsubscribing stops notifications, across a switch', () => {
    const a = counter(1);
    const b = counter(2);
    const sw = createStoreSwitch<{ n: number }>(a);
    let calls = 0;
    const off = sw.subscribe(() => calls++);
    sw.use(b);
    off();
    b.setState({ n: 5 });
    expect(calls).toBe(1);
  });
});
