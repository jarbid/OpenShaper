// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  FIN_MESH_FINE,
  FUTURES_TABS,
  bladeTop,
  defaultFinDesign,
  finMesh,
  prepareBlade,
  type FinDesign,
} from '@openshaper/kernel';
import { exportFinStl } from './fin-stl';

/** Parse a binary STL into its triangles (vertices only). */
const parse = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  const tris: [number, number, number][][] = [];
  for (let t = 0; t < count; t++) {
    const o = 84 + t * 50 + 12; // skip the normal
    const v = (k: number): [number, number, number] => [
      view.getFloat32(o + k * 12, true),
      view.getFloat32(o + k * 12 + 4, true),
      view.getFloat32(o + k * 12 + 8, true),
    ];
    tris.push([v(0), v(1), v(2)]);
  }
  return { count, tris, header: new TextDecoder().decode(bytes.slice(0, 80)) };
};

const bounds = (tris: [number, number, number][][]) => {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const t of tris)
    for (const p of t)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, p[k]!);
        hi[k] = Math.max(hi[k]!, p[k]!);
      }
  return { lo, hi };
};

/** Every directed edge once, its reverse once: closed and consistently wound. */
const closed = (tris: [number, number, number][][]): boolean => {
  const key = (p: [number, number, number]) => p.join(',');
  const edges = new Map<string, number>();
  for (const t of tris) {
    for (let e = 0; e < 3; e++) {
      const k = `${key(t[e]!)}>${key(t[(e + 1) % 3]!)}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of edges) {
    const [a, b] = k.split('>');
    if (n !== 1 || edges.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
};

const volume = (tris: [number, number, number][][]) =>
  tris.reduce((v, [a, b, c]) => {
    const [ax, ay, az] = a!;
    const [bx, by, bz] = b!;
    const [cx, cy, cz] = c!;
    return v + (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }, 0);

describe.each([
  ['side, right', defaultFinDesign('side', 'right')],
  ['centre', defaultFinDesign('centre')],
] as [string, FinDesign][])('exportFinStl(%s)', (_, d) => {
  const stl = parse(exportFinStl(d, { name: 'test fin' }));
  const mesh = finMesh(d, FIN_MESH_FINE);

  it('writes both shells, every triangle', () => {
    expect(stl.count).toBe((mesh.blade.indices.length + mesh.tab.indices.length) / 3);
    expect(stl.header.startsWith('OpenFinShaper STL test fin')).toBe(true);
    expect(stl.header.startsWith('solid')).toBe(false); // would read as ASCII
  });

  it('is in millimetres', () => {
    const { lo, hi } = bounds(stl.tris);
    const tab = FUTURES_TABS[d.position === 'side' ? 'side' : 'centre'];
    expect(hi[0]! - Math.min(lo[0]!, 0)).toBeGreaterThan(tab.length * 10 - 1e-3);
    expect(lo[2]).toBeCloseTo(-tab.height * 10, 3); // the tab bottom
    expect(hi[2]).toBeCloseTo(bladeTop(prepareBlade(d), 0.01) * 10, 2); // just under the tip
  });

  it('is closed and wound outward (positive volume)', () => {
    expect(closed(stl.tris)).toBe(true);
    expect(volume(stl.tris)).toBeGreaterThan(0);
  });
});

describe('exportFinStl options', () => {
  it('scales to the unit asked for', () => {
    const d = defaultFinDesign('side', 'right');
    const mm = bounds(parse(exportFinStl(d)).tris);
    const cm = bounds(parse(exportFinStl(d, { unit: 'cm' })).tris);
    expect(cm.lo[2]).toBeCloseTo(mm.lo[2]! / 10, 4);
  });

  it('mirrors a left fin', () => {
    const r = bounds(parse(exportFinStl(defaultFinDesign('side', 'right'))).tris);
    const l = bounds(parse(exportFinStl(defaultFinDesign('side', 'left'))).tris);
    expect(l.lo[1]).toBeCloseTo(-r.hi[1]!, 4);
    expect(l.hi[1]).toBeCloseTo(-r.lo[1]!, 4);
  });
});
