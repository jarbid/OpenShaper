// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { defaultFinDesign, FUTURES_TABS, prepareBlade } from '@openshaper/kernel';
import { Vector3 } from 'three';
import {
  sectionPlaneCorners,
  FIN_PREVIEW_FOV,
  ZEBRA_STRIPES,
  finCameraPosition,
  finScene,
  zebraTexture,
} from './fin-preview';

describe('finScene', () => {
  const d = defaultFinDesign('side', 'right');
  const s = finScene(d);

  it('keeps the kernel frame: tab under the blade, touching at z = 0', () => {
    const blade = s.blade.boundingBox!;
    const tab = s.tab.boundingBox!;
    expect(blade.min.z).toBeCloseTo(0, 5);
    expect(blade.max.z).toBeCloseTo(prepareBlade(d).depth, 3); // up to the top of the tip
    expect(tab.max.z).toBeCloseTo(0, 5);
    expect(tab.min.z).toBeCloseTo(-FUTURES_TABS.side.height, 5);
    expect(tab.max.x - tab.min.x).toBeCloseTo(FUTURES_TABS.side.length, 5);
  });

  it('frames everything', () => {
    const c = new Vector3(...s.center);
    for (const b of [s.blade.boundingBox!, s.tab.boundingBox!]) {
      for (const p of [b.min, b.max]) expect(c.distanceTo(p)).toBeLessThanOrEqual(s.radius + 1e-6);
    }
  });

  it('has normals for every vertex', () => {
    expect(s.blade.getAttribute('normal').count).toBe(s.blade.getAttribute('position').count);
  });
});

describe('finCameraPosition', () => {
  it('looks at the outside face of either hand', () => {
    expect(finCameraPosition([0, 0, 5], 10, 1)[1]).toBeGreaterThan(0);
    expect(finCameraPosition([0, 0, 5], 10, -1)[1]).toBeLessThan(0);
  });

  it('stands far enough back to fit the sphere in the view', () => {
    const p = new Vector3(...finCameraPosition([0, 0, 0], 10, 1));
    const half = ((FIN_PREVIEW_FOV / 2) * Math.PI) / 180;
    // The sphere's angular radius is under half the field of view.
    expect(Math.asin(10 / p.length())).toBeLessThan(half);
    // A narrow view (aspect < 1) stands further back.
    expect(new Vector3(...finCameraPosition([0, 0, 0], 10, 1, 0.5)).length()).toBeGreaterThan(
      p.length(),
    );
  });
});

describe('sectionPlaneCorners', () => {
  const scene = finScene(defaultFinDesign('side', 'left'));

  it('lays a horizontal plane across the fin at its height, with a margin', () => {
    const c = sectionPlaneCorners(scene, { axis: 'z', at: 3 });
    for (const p of c) expect(p[2]).toBe(3);
    expect(Math.min(...c.map((p) => p[0]))).toBeLessThan(scene.min[0]);
    expect(Math.max(...c.map((p) => p[0]))).toBeGreaterThan(scene.max[0]);
    expect(Math.min(...c.map((p) => p[1]))).toBeLessThan(scene.min[1]);
    expect(Math.max(...c.map((p) => p[1]))).toBeGreaterThan(scene.max[1]);
  });

  it('stands an upright plane across the fin at its point along the base', () => {
    const c = sectionPlaneCorners(scene, { axis: 'x', at: 4 });
    for (const p of c) expect(p[0]).toBe(4);
    expect(Math.min(...c.map((p) => p[2]))).toBeLessThan(scene.min[2]);
    expect(Math.max(...c.map((p) => p[2]))).toBeGreaterThan(scene.max[2]);
  });
});

describe('the panel fit view', () => {
  it('looks along the panel from behind the fin, level, turned with the fin', () => {
    const c: [number, number, number] = [5, 0, 4];
    const straight = new Vector3(...finCameraPosition(c, 10, 1, 1, 'panel')).sub(new Vector3(...c));
    // From behind (−X, the tail end), level with the centre.
    expect(straight.x).toBeLessThan(0);
    expect(straight.y).toBeCloseTo(0, 9);
    expect(straight.z).toBeCloseTo(0, 9);
    const turned = new Vector3(...finCameraPosition(c, 10, 1, 1, 'panel', 10)).sub(
      new Vector3(...c),
    );
    expect((Math.atan2(turned.y, turned.x) * 180) / Math.PI).toBeCloseTo(-170, 6);
    // Far back, for its narrow field of view: all but flat.
    expect(straight.length()).toBeGreaterThan(
      20 * new Vector3(...finCameraPosition(c, 10, 1)).sub(new Vector3(...c)).length(),
    );
  });
});

describe('the zebra stripes', () => {
  it('alternate black and white across the texture, the same all the way up', () => {
    const t = zebraTexture(1024);
    const px = (x: number, y: number) => (t.image.data as Uint8Array)[(y * 1024 + x) * 4]!;
    const w = 1024 / ZEBRA_STRIPES;
    // The middle of each stripe, light then dark.
    for (let k = 0; k < ZEBRA_STRIPES; k++) {
      const v = px(Math.floor((k + 0.5) * w), 100);
      if (k % 2 === 0) expect(v).toBeGreaterThan(200);
      else expect(v).toBeLessThan(40);
      expect(px(Math.floor((k + 0.5) * w), 3)).toBe(v);
    }
  });

  it('are drawn on a finer mesh than the preview', () => {
    const d = defaultFinDesign('side', 'left');
    const plain = finScene(d).blade.getAttribute('position').count;
    expect(finScene(d, true).blade.getAttribute('position').count).toBeGreaterThan(2 * plain);
  });
});
