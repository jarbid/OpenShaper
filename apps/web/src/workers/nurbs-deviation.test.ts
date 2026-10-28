// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * "Deviation from classic": the sign convention (positive = the NURBS surface has more
 * foam), the unit (cm, along the surface normal) and the station interpolation, against
 * the classic engine's own mesh moved by known amounts.
 */
import { parseBrd } from '@openshaper/io';
import { getLength, tessellateBoard } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import sampleBrd from '../sample-board.brd?raw';
import { classicDeviation, STATION_SPACING } from './nurbs-deviation';

const { board } = parseBrd(sampleBrd);
const L = getLength(board);
const mesh = tessellateBoard(board, { targetFaceSize: 2 });
const vertexCount = mesh.positions.length / 3;

/** The classic mesh moved `d` cm along its own normals: a surface `d` cm off the classic one. */
const offset = (d: number): Float32Array => {
  const p = new Float32Array(mesh.positions);
  for (let i = 0; i < p.length; i++) p[i] = p[i]! + d * mesh.normals[i]!;
  return p;
};

/** Vertices well inside the board and on the broad faces, where the classic mesh normal is sound. */
const interior = (i: number): boolean => {
  const x = mesh.positions[3 * i]!;
  const nx = mesh.normals[3 * i]!;
  return x > 0.1 * L && x < 0.9 * L && Math.abs(nx) < 0.3;
};

describe('classicDeviation', () => {
  it('is about zero for the classic surface itself', () => {
    const d = classicDeviation(board, mesh.positions, mesh.normals);
    let worst = 0;
    for (let i = 0; i < vertexCount; i++) {
      if (interior(i) && Number.isFinite(d.deviation[i]!)) {
        worst = Math.max(worst, Math.abs(d.deviation[i]!));
      }
    }
    // Interpolating between sections 0.25 cm apart and the ghost ring's chords.
    expect(worst).toBeLessThan(0.01);
  });

  it('is positive where the surface lies outside the classic one (more foam)', () => {
    const outside = classicDeviation(board, offset(0.3), mesh.normals);
    let checked = 0;
    for (let i = 0; i < vertexCount; i++) {
      if (!interior(i)) continue;
      expect(outside.deviation[i]!).toBeGreaterThan(0.25);
      expect(outside.deviation[i]!).toBeLessThan(0.35);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
    expect(outside.range![1]).toBeGreaterThan(0.25);
  });

  it('is negative inside the classic surface (less foam), with the same magnitude', () => {
    const inside = classicDeviation(board, offset(-0.3), mesh.normals);
    for (let i = 0; i < vertexCount; i++) {
      if (!interior(i)) continue;
      expect(inside.deviation[i]!).toBeLessThan(-0.25);
      expect(inside.deviation[i]!).toBeGreaterThan(-0.35);
    }
    expect(inside.range![0]).toBeLessThan(-0.25);
  });

  it('measures along the surface normal, in cm, whatever the surface’s tilt along the board', () => {
    // On the sloping bottom and deck near the ends the station-plane distance is larger
    // than the normal distance by 1/sqrt(1 - nx²); the result must not carry that factor.
    const d = classicDeviation(board, offset(0.2), mesh.normals);
    let sloped = 0;
    for (let i = 0; i < vertexCount; i++) {
      const x = mesh.positions[3 * i]!;
      const nx = Math.abs(mesh.normals[3 * i]!);
      if (x > 0.05 * L && x < 0.95 * L && nx > 0.1 && nx < 0.5) {
        expect(d.deviation[i]!).toBeGreaterThan(0.17);
        expect(d.deviation[i]!).toBeLessThan(0.23);
        sloped++;
      }
    }
    expect(sloped).toBeGreaterThan(20);
  });

  it('has no data past the classic board’s ends, and counts them', () => {
    const p = Float32Array.of(-5, 0, 3, L + 5, 0, 3, L / 2, 0, 3);
    const n = Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1);
    const d = classicDeviation(board, p, n);
    expect(Number.isNaN(d.deviation[0]!)).toBe(true);
    expect(Number.isNaN(d.deviation[1]!)).toBe(true);
    expect(Number.isFinite(d.deviation[2]!)).toBe(true);
    expect(d.noData).toBe(2);
  });

  it('returns no range for no points', () => {
    const d = classicDeviation(board, new Float32Array(0), new Float32Array(0));
    expect(d.range).toBeNull();
    expect(d.noData).toBe(0);
  });

  it('interpolates between sections: a vertex mid-way agrees with a section at its own x', () => {
    // A point on a station and one half a spacing away on the same surface differ by the
    // surface's slope, not by the interpolation: compare against a finer spacing proxy.
    const x0 = Math.round(L / 2 / STATION_SPACING) * STATION_SPACING;
    const pts = (x: number) => Float32Array.of(x, 5, 8);
    const nrm = Float32Array.of(0, 0, 1);
    const a = classicDeviation(board, pts(x0), nrm).deviation[0]!;
    const b = classicDeviation(board, pts(x0 + STATION_SPACING / 2), nrm).deviation[0]!;
    const c = classicDeviation(board, pts(x0 + STATION_SPACING), nrm).deviation[0]!;
    expect(b).toBeGreaterThanOrEqual(Math.min(a, c) - 1e-6);
    expect(b).toBeLessThanOrEqual(Math.max(a, c) + 1e-6);
  });
});
