import type { BoardSpecs } from '@openshaper/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lengthUnitByKey } from './format';
import { openHtmlInNewTab, specSheetHtmlFor } from './spec-sheet-open';

const specs: BoardSpecs = {
  length: 183,
  lengthOverCurve: 184.2,
  maxWidth: 47,
  maxWidthPos: 90,
  centerWidth: 46.5,
  noseWidth: 30,
  tailWidth: 35,
  thickness: 6,
  maxThickness: 6.2,
  maxThicknessPos: 95,
  noseThickness: 2,
  tailThickness: 3,
  maxRocker: 10,
  noseRocker: 8,
  noseRocker1: 4,
  noseRocker2: 2,
  tailRocker: 5,
  tailRocker1: 2,
  tailRocker2: 1,
  volume: 30500,
  volumeLiters: 30.5,
  area: 5200,
  centerOfMass: 92,
};
const units = lengthUnitByKey('cm');

describe('specSheetHtmlFor', () => {
  it('HTML-escapes user-typed meta fields (no stored-XSS path)', () => {
    const html = specSheetHtmlFor(
      specs,
      {
        model: '<script>alert(1)</script>',
        designer: '"Al" <Merrick> & Co',
        surfer: '<img src=x onerror=alert(2)>',
        comments: 'fish </table><script>steal()</script>',
      },
      units,
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;Merrick&gt; &amp; Co');
  });

  it('includes the dimension rows and skips empty meta fields', () => {
    const html = specSheetHtmlFor(specs, { model: 'Test Fish' }, units);
    expect(html).toContain('Test Fish — Spec Sheet');
    expect(html).toContain('Length');
    expect(html).toContain('Volume');
    expect(html).not.toContain('Surfer:');
  });
});

describe('openHtmlInNewTab', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const stubUrl = () => {
    const createObjectURL = vi.fn(() => 'blob:test');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL }));
    return { createObjectURL, revokeObjectURL };
  };

  it('opens a Blob URL in a new tab and revokes it later', () => {
    vi.useFakeTimers();
    const { createObjectURL, revokeObjectURL } = stubUrl();
    const open = vi.fn(() => ({}) as Window);
    vi.stubGlobal('open', open);

    expect(openHtmlInNewTab('<!doctype html><title>x</title>')).toBe(true);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith('blob:test', '_blank');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  it('reports a blocked pop-up and revokes the URL immediately', () => {
    const { revokeObjectURL } = stubUrl();
    vi.stubGlobal(
      'open',
      vi.fn(() => null),
    );

    expect(openHtmlInNewTab('<!doctype html>')).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });
});
