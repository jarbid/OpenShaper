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

describe('attribute order, quoting and base', () => {
  const tags = [
    '<link href="/assets/nurbs-layer-a.js" rel="modulepreload" crossorigin="">',
    '<link crossorigin href="/assets/nurbs-worker-a.js" rel="modulepreload">',
    "<link rel='modulepreload' href='/assets/nurbs-core-a.js'>",
    '<link rel=modulepreload href=/assets/nurbs-core-a.js>',
    '<link rel="modulepreload" href="assets/nurbs-layer-a.js">',
    '<link rel="modulepreload" href="./assets/nurbs-layer-a.js">',
    '<link rel="modulepreload" href="/base/assets/nurbs-layer-a.js?v=1">',
    '<link rel="modulepreload" crossorigin href="https://cdn.example/assets/nurbs-layer-a.js">',
    '<LINK REL="modulepreload" HREF="/assets/nurbs-layer-a.js">',
    '<link as="script" rel="preload" href="/assets/nurbs-layer-a.js">',
    '<link rel="prefetch" href="/assets/nurbs-layer-a.js"/>',
  ];
  const keep = '<link href="/assets/App-abc.js" rel="modulepreload" crossorigin="">';

  it.each(tags)('strips %s', (tag) => {
    const html = `<head>${keep}${tag}</head>`;
    expect(stripNurbsPreloads(html)).toBe(`<head>${keep}</head>`);
    expect(() => assertNoNurbsPreloads('/app', html)).toThrow('/app');
    expect(() => assertNoNurbsPreloads('/app', stripNurbsPreloads(html))).not.toThrow();
  });

  it.each([
    '<link href="/assets/not-nurbs-x.js" rel="modulepreload">',
    '<link rel="modulepreload" href="/assets/nurbs.js">',
    '<link rel="stylesheet" href="/assets/nurbs-x.css">',
    '<link rel="icon" href="/assets/nurbs-icon.svg">',
    '<link rel="modulepreload" href="/images/assets-nurbs-x.js">',
    '<link rel="modulepreload">',
  ])('keeps %s', (tag) => {
    const html = `<head>${tag}</head>`;
    expect(stripNurbsPreloads(html)).toBe(html);
    expect(() => assertNoNurbsPreloads('/app', html)).not.toThrow();
  });
});

describe('assertNoNurbsPreloads', () => {
  it('passes a stripped page and throws on one that still preloads the viewer', () => {
    const html = page(['/assets/App-abc.js', '/assets/nurbs-core-BKUja8pc.js']);
    expect(() => assertNoNurbsPreloads('/app', html)).toThrow('/app');
    expect(() => assertNoNurbsPreloads('/app', stripNurbsPreloads(html))).not.toThrow();
  });
});
