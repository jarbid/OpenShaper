// SPDX-License-Identifier: GPL-3.0-or-later
import { useLayoutEffect, useState, type RefObject } from 'react';

/** A box's size in px. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * The size of an element, kept current as it resizes. `fallback` is what is returned until the element
 * has been measured and wherever it cannot be (no layout, as in tests and a prerender): a drawing that
 * has to be some size is then that size, not none.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>, fallback: Size): Size {
  const [size, setSize] = useState<Size>(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (width > 0 && height >= 0) {
        setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
      }
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref]);
  return size;
}
