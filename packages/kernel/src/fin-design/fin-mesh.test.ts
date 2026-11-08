// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { BoardMesh } from '../tessellate';
import { vec2 } from '../vec2';
import { bladeSection, cosineStations, prepareBlade } from './blade';
import { sectionLoop } from './blade-surface';
import { defaultFinDesign } from './fin-defaults';
import { finTabKind, type FinDesign } from './fin-design';
import { FIN_MESH_FINE, finMesh } from './fin-mesh';
import { tabCentreY } from './fin-placement';
import { FUTURES_TABS, FUTURES_TAB_HOLES, futuresTabOutline } from './futures-tab';
import { nacaSection } from './naca';
import { raisedRearDesign } from '../test-support/fin-designs';
import { polygonArea } from './triangulate';

/**
 * A tab's profile area (cm²), by decomposition as in futures-tab.test.ts: the
 * rectangle less the rear slot, the rounded corner and the front notch.
 */
const tabArea = (kind: 'side' | 'centre'): number => {
  const { spec, front } = futuresTabOutline(kind);
  const r = spec.slotDiameter / 2;
  const R = spec.rearBottomCornerRadius;
  const slot = 2 * r * spec.slotArcCentreFromEnd + (Math.PI * r * r) / 2;
  const corner = R * R - (Math.PI * R * R) / 4;
  const notch = polygonArea([front.T, front.U, front.A, front.D, front.B, vec2(spec.length, 0)]);
  // Four weight-saving slots: a rectangle plus two half-discs each.
  const { count, length, height } = FUTURES_TAB_HOLES;
  const holes = count * ((length - height) * height + (Math.PI * height * height) / 4);
  return spec.length * spec.height - slot - corner - notch - holes;
};

const designs: [string, FinDesign][] = [
  ['side', defaultFinDesign('side', 'right')],
  ['left side, 20° cant', { ...defaultFinDesign('side', 'left'), cant: 20 }],
  ['quad rear', defaultFinDesign('quad-rear', 'left')],
  ['centre', defaultFinDesign('centre')],
  ['raised rear', raisedRearDesign()],
  ['side, NACA 4412', { ...defaultFinDesign('side', 'right'), section: nacaSection('4412') }],
  ['centre, NACA 0010', { ...defaultFinDesign('centre'), section: nacaSection('0010') }],
];

/** Every directed edge once, and its reverse once: closed and consistently wound. */
const closedAndOriented = (m: BoardMesh): boolean => {
  const directed = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3) {
    const v = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
    for (let e = 0; e < 3; e++) {
      const key = `${v[e]},${v[(e + 1) % 3]}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of directed) {
    const [a, b] = key.split(',');
    if (count !== 1 || directed.get(`${b},${a}`) !== 1) return false;
  }
  return true;
};

const volume = (m: BoardMesh): number => {
  const p = m.positions;
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]! * 3, m.indices[t + 1]! * 3, m.indices[t + 2]! * 3];
    v +=
      (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
        p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
        p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) /
      6;
  }
  return v;
};

/** Blade volume by integrating fine section areas up the height (Simpson). */
const sectionVolume = (d: FinDesign, tipGap = 0.01): number => {
  const b = prepareBlade(d);
  const top = b.depth - tipGap;
  const area = (z: number) => {
    const l = sectionLoop(bladeSection(b, z, cosineStations(240)));
    let s = 0;
    for (let i = 0; i < l.length - 1; i++) s += l[i]!.x * l[i + 1]!.y - l[i + 1]!.x * l[i]!.y;
    return Math.abs(s) / 2;
  };
  const n = 160;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const z0 = (top * i) / n;
    const z1 = (top * (i + 1)) / n;
    v += ((area(z0) + 4 * area((z0 + z1) / 2) + area(z1)) / 6) * (z1 - z0);
  }
  return v;
};

const bounds = (m: BoardMesh) => {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, m.positions[i + k]!);
      hi[k] = Math.max(hi[k]!, m.positions[i + k]!);
    }
  }
  return { lo, hi };
};

describe.each(designs)('finMesh(%s)', (_, d) => {
  const preview = finMesh(d);
  const fine = finMesh(d, FIN_MESH_FINE);
  const kind = finTabKind(d.position);

  it('closes both shells, wound consistently', () => {
    for (const m of [preview.blade, preview.tab, fine.blade, fine.tab]) {
      expect(closedAndOriented(m)).toBe(true);
    }
  });

  it('winds them outward: positive volume', () => {
    for (const m of [preview.blade, preview.tab]) expect(volume(m)).toBeGreaterThan(0);
  });

  it('has the blade volume the sections give', () => {
    const v = sectionVolume(d);
    // Two samplings of one surface: rows along the fin, level cuts here (more so at a raised rear).
    expect(Math.abs(volume(fine.blade) / v - 1)).toBeLessThan(0.015);
    expect(Math.abs(volume(preview.blade) / v - 1)).toBeLessThan(0.02);
  });

  it('has the tab volume of its profile area times its thickness', () => {
    const v = tabArea(kind) * FUTURES_TABS[kind].thickness;
    // Sampled arcs fall just inside the true ones: the holes' ends come out a hair
    // small, ~3.5 mm³ over the four slots on a side tab.
    expect(Math.abs(volume(fine.tab) / v - 1)).toBeLessThan(5e-4);
  });

  it('places the tab under the blade, touching on the tab top', () => {
    const t = bounds(preview.tab);
    const bl = bounds(preview.blade);
    const { height, thickness } = FUTURES_TABS[kind];
    expect(t.hi[2]).toBeCloseTo(0, 12);
    expect(t.lo[2]).toBeCloseTo(-height, 6);
    expect(bl.lo[2]).toBeCloseTo(0, 7);
    expect((t.lo[1]! + t.hi[1]!) / 2).toBeCloseTo(tabCentreY(d), 6);
    expect(t.hi[1]! - t.lo[1]!).toBeCloseTo(thickness, 6);
  });
});

describe('finMesh: hand', () => {
  it('meshes a left fin as the exact mirror of a right fin', () => {
    const r = finMesh(defaultFinDesign('side', 'right')).blade.positions;
    const l = finMesh(defaultFinDesign('side', 'left')).blade.positions;
    expect(l.length).toBe(r.length);
    for (let i = 0; i < r.length; i += 3) {
      expect(l[i]).toBe(r[i]);
      expect(l[i + 1]! + r[i + 1]!).toBe(0); // negated exactly (−0 and +0 alike)
      expect(l[i + 2]).toBe(r[i + 2]);
    }
  });
});
