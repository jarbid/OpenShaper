// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { assertNoNurbsPreloads, stripNurbsPreloads } from './nurbs-preload';

const page = (links: string[]) =>
  `<html><head>${links.map((h) => `<link rel="modulepreload" crossorigin="" href="${h}">`).join('')}</head><body></body></html>`;

describe('stripNurbsPreloads', () => {
  it('removes the hints for the NURBS chunks and keeps every other one', () => {
    const html = page([
      '/assets/App-abc.js',
      '/assets/nurbs-layer-g7YsENam.js',
      '/assets/src-BRlyJJmc.js',
      '/assets/nurbs-worker-BYmmXEs6.js',
      '/assets/nurbs-core-BKUja8pc.js',
    ]);
    expect(stripNurbsPreloads(html)).toBe(page(['/assets/App-abc.js', '/assets/src-BRlyJJmc.js']));
  });

  it('leaves a page without NURBS hints byte for byte alone', () => {
    const html = page(['/assets/App-abc.js', '/assets/specs-worker-x.js']);
    expect(stripNurbsPreloads(html)).toBe(html);
  });

  it('does not touch chunks that merely contain the word', () => {
    const html = page(['/assets/not-nurbs-x.js', '/assets/geometry-x.js']);
    expect(stripNurbsPreloads(html)).toBe(html);
  });
});

describe('assertNoNurbsPreloads', () => {
  it('passes a stripped page and throws on one that still preloads the viewer', () => {
    const html = page(['/assets/App-abc.js', '/assets/nurbs-core-BKUja8pc.js']);
    expect(() => assertNoNurbsPreloads('/app', html)).toThrow('/app');
    expect(() => assertNoNurbsPreloads('/app', stripNurbsPreloads(html))).not.toThrow();
  });
});
