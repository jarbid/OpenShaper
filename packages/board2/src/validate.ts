// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `validateBoard`: the rules of the section-based model (docs/design/m1-model.md
 * §1 and §2), each violation reported under its own code.
 *
 * - **Phase 0 (sections):** the centre knots are fixed at (0, 0) and (0, 1)
 *   (`section-centre-moved`) with horizontal handles (`section-centre-tangent`);
 *   the apex knot is an interior knot (`section-apex-index`) with u = 1
 *   (`section-apex-moved`); every control point has 0 ≤ u ≤ 1
 *   (`section-out-of-bounds`), so by the convex hull property no section passes
 *   the outline or the stringer.
 * - **Plan:** a standard tail starts at (0, 0), a notched one at the notch
 *   bottom (d, 0) with its tips at x = 0; on the forward branch x does not
 *   decrease; the notch zone's chord map is increasing (`notch-chords-cross`)
 *   and every chord crosses the outline at 20 degrees or more
 *   (`notch-chord-angle`).
 * - **Lines and stations:** rocker and deck span [0, L] as functions of x and
 *   leave a positive thickness; stations are sorted, uniquely named, inside the
 *   station range.
 *
 * Document *shape* (types, finiteness, unknown keys) is `reviveBoardDoc`'s; this
 * judges the board. Never throws on a revived document.
 */
import { chainEval, chainMinX, compileChain, funcEval } from './chain';
import type { CompiledChain } from './chain';
import { featureIssues } from './features';
import { frameAt, makeFrame, outlineParam } from './frame';
import type { PlanFrame } from './frame';
import { makeIssue } from './issues';
import {
  LINE_CHECK_SAMPLES,
  MIN_CHORD_ANGLE,
  MIN_THICKNESS,
  NOTCH_CHECK_SAMPLES,
  OUTLINE_CHECK_SAMPLES,
  PLAN_EXACT_TOL,
  SECTION_EXACT_TOL,
} from './params';
import type { Board2Issue, BoardDoc, Chain, Section } from './types';

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

/** Every issue of a document, errors first in rule order; empty if the board is valid. */
export function validateBoard(doc: BoardDoc): readonly Board2Issue[] {
  const out: Board2Issue[] = [];
  const err = (
    code: Board2Issue['code'],
    message: string,
    at?: Board2Issue['at'],
    value?: number,
  ): void => {
    out.push(
      makeIssue(code, message, {
        ...(at === undefined ? {} : { at }),
        ...(value === undefined ? {} : { value }),
      }),
    );
  };

  // --- symmetry fields -------------------------------------------------------
  const asym = doc.symmetry === 'asymmetric';
  if (asym && doc.outline.minus === undefined) {
    err('symmetry-fields', 'an asymmetric board needs outline.minus');
  }
  if (!asym && doc.outline.minus !== undefined) {
    err('symmetry-fields', 'a mirror board has no outline.minus');
  }
  for (const s of doc.stations) {
    if (asym && s.minus === undefined) {
      err('symmetry-fields', `station '${s.id}': an asymmetric board needs a minus section`, {
        station: s.id,
      });
    }
    if (!asym && s.minus !== undefined) {
      err('symmetry-fields', `station '${s.id}': a mirror board has no minus section`, {
        station: s.id,
      });
    }
  }

  // --- chain lengths (everything after needs them) ----------------------------
  let short = false;
  const need = (c: Chain, min: number, what: string, at?: Board2Issue['at']): void => {
    if (c.knots.length < min) {
      short = true;
      err('chain-too-short', `${what} needs at least ${min} knots; got ${c.knots.length}`, at);
    }
  };
  need(doc.outline.plus, 2, 'outline.plus');
  if (doc.outline.minus) need(doc.outline.minus, 2, 'outline.minus');
  need(doc.rocker, 2, 'rocker');
  need(doc.deck, 2, 'deck');
  for (const s of doc.stations) {
    need(s.plus.chain, 3, `station '${s.id}' plus section`, { station: s.id, side: 'plus' });
    if (s.minus)
      need(s.minus.chain, 3, `station '${s.id}' minus section`, { station: s.id, side: 'minus' });
  }
  if (doc.stations.length === 0) err('too-few-sections', 'a board needs at least one station');
  if (short) return out;

  // --- sections (Phase 0) -------------------------------------------------------
  for (const s of doc.stations) {
    sectionIssues(s.plus, s.id, 'plus', err);
    if (s.minus) sectionIssues(s.minus, s.id, 'minus', err);
  }

  // --- stations ---------------------------------------------------------------
  const ids = new Set<string>();
  doc.stations.forEach((s, i) => {
    if (ids.has(s.id)) err('station-id', `station id '${s.id}' is used twice`, { station: s.id });
    ids.add(s.id);
    if (i > 0 && !(s.x > doc.stations[i - 1]!.x)) {
      err(
        'station-order',
        `station '${s.id}': x must be greater than the previous station's`,
        { station: s.id },
        s.x,
      );
    }
  });

  // --- plan -------------------------------------------------------------------
  const planOk = planIssues(doc, err);

  // --- rocker and deck ----------------------------------------------------------
  const rocker = compileChain(doc.rocker);
  const deck = compileChain(doc.deck);
  const L = doc.outline.plus.knots[doc.outline.plus.knots.length - 1]!.p[0];
  const linesOk = lineIssues(doc, rocker, deck, L, err);

  // --- stations inside the range -------------------------------------------------
  const xi0 = doc.outline.plus.knots[0]!.p[0];
  for (const s of doc.stations) {
    if (!(s.x >= xi0 && s.x <= L)) {
      err(
        'station-order',
        `station '${s.id}': x ${s.x} is outside the station range [${xi0}, ${L}]`,
        { station: s.id },
        s.x,
      );
    }
  }

  // --- features and build -------------------------------------------------------
  if (planOk) {
    const frames = [doc.outline.plus, doc.outline.minus ?? doc.outline.plus].map((o) =>
      makeFrame(compileChain(o), doc.tail),
    );
    out.push(
      ...featureIssues(doc.features, {
        xiMin: xi0,
        xiMax: L,
        minChord: (a, b) => minChord(frames, a, b),
      }),
    );
  }
  void linesOk;
  const b = doc.build;
  if (!(b.tolerance > 0))
    err('build-invalid', `build.tolerance must be > 0; got ${b.tolerance}`, undefined, b.tolerance);
  if (!(b.railFade > 0 && b.railFade <= 1)) {
    err(
      'build-invalid',
      `build.railFade must be in (0, 1]; got ${b.railFade}`,
      undefined,
      b.railFade,
    );
  }
  return out;
}

type Err = (
  code: Board2Issue['code'],
  message: string,
  at?: Board2Issue['at'],
  value?: number,
) => void;

function sectionIssues(sec: Section, id: string, side: 'plus' | 'minus', err: Err): void {
  const k = sec.chain.knots;
  const at = { station: id, side };
  const n = k.length;
  const first = k[0]!;
  const last = k[n - 1]!;
  if (!(near(first.p[0], 0, SECTION_EXACT_TOL) && near(first.p[1], 0, SECTION_EXACT_TOL))) {
    err(
      'section-centre-moved',
      `station '${id}' (${side}): the bottom centre knot must be (0, 0); got (${first.p[0]}, ${first.p[1]})`,
      at,
    );
  }
  if (!(near(last.p[0], 0, SECTION_EXACT_TOL) && near(last.p[1], 1, SECTION_EXACT_TOL))) {
    err(
      'section-centre-moved',
      `station '${id}' (${side}): the deck centre knot must be (0, 1); got (${last.p[0]}, ${last.p[1]})`,
      at,
    );
  }
  if (!near(first.out[1], first.p[1], SECTION_EXACT_TOL)) {
    err(
      'section-centre-tangent',
      `station '${id}' (${side}): the bottom centre handle must be horizontal`,
      at,
    );
  }
  if (!near(last.in[1], last.p[1], SECTION_EXACT_TOL)) {
    err(
      'section-centre-tangent',
      `station '${id}' (${side}): the deck centre handle must be horizontal`,
      at,
    );
  }
  if (!(Number.isInteger(sec.apex) && sec.apex >= 1 && sec.apex <= n - 2)) {
    err(
      'section-apex-index',
      `station '${id}' (${side}): the apex must be an interior knot (1 to ${n - 2}); got ${sec.apex}`,
      at,
      sec.apex,
    );
  } else if (!near(k[sec.apex]!.p[0], 1, SECTION_EXACT_TOL)) {
    err(
      'section-apex-moved',
      `station '${id}' (${side}): the apex knot must have u = 1; got ${k[sec.apex]!.p[0]}`,
      at,
      k[sec.apex]!.p[0],
    );
  }
  for (let i = 0; i < n; i++) {
    const pts: (readonly [number, number])[] = [k[i]!.p];
    if (i > 0) pts.push(k[i]!.in);
    if (i < n - 1) pts.push(k[i]!.out);
    for (const q of pts) {
      if (q[0] < -SECTION_EXACT_TOL || q[0] > 1 + SECTION_EXACT_TOL) {
        err(
          'section-out-of-bounds',
          `station '${id}' (${side}): knot ${i} has a control point at u = ${q[0]}, outside [0, 1]`,
          { ...at, key: i },
          q[0],
        );
        break;
      }
    }
  }
}

/** Plan rules for both outlines; false if the frames cannot be trusted afterwards. */
function planIssues(doc: BoardDoc, err: Err): boolean {
  let ok = true;
  const outlines: ['plus' | 'minus', Chain][] = [['plus', doc.outline.plus]];
  if (doc.outline.minus) outlines.push(['minus', doc.outline.minus]);
  const plus = doc.outline.plus.knots;
  for (const [side, o] of outlines) {
    const k = o.knots;
    const at = { side };
    const first = k[0]!;
    const last = k[k.length - 1]!;
    if (!(near(first.p[1], 0, PLAN_EXACT_TOL) && near(last.p[1], 0, PLAN_EXACT_TOL))) {
      ok = false;
      err(
        'outline-endpoints',
        `outline.${side}: it must start and end on the stringer (y = 0)`,
        at,
      );
    }
    if (
      side === 'minus' &&
      !(
        near(first.p[0], plus[0]!.p[0], PLAN_EXACT_TOL) &&
        near(last.p[0], plus[plus.length - 1]!.p[0], PLAN_EXACT_TOL)
      )
    ) {
      ok = false;
      err(
        'outline-endpoints',
        'outline.minus must start and end at the same stringer points as outline.plus',
        at,
      );
    }
    const below = k.some(
      (q) => q.p[1] < -PLAN_EXACT_TOL || q.in[1] < -PLAN_EXACT_TOL || q.out[1] < -PLAN_EXACT_TOL,
    );
    if (below) {
      ok = false;
      err('outline-endpoints', `outline.${side}: every control point must have y >= 0`, at);
    }
    if (doc.tail.kind === 'standard') {
      if (!near(first.p[0], 0, PLAN_EXACT_TOL)) {
        ok = false;
        err(
          'tail-start',
          `outline.${side}: a standard tail starts at x = 0; got ${first.p[0]}`,
          at,
          first.p[0],
        );
      }
    } else if (!(first.p[0] > PLAN_EXACT_TOL)) {
      ok = false;
      err(
        'tail-start',
        `outline.${side}: a notched tail starts at the notch bottom (d, 0) with d > 0; got x = ${first.p[0]}`,
        at,
        first.p[0],
      );
    }
    if (!ok) continue;
    const ch = compileChain(o);
    const L = last.p[0];
    let sFrom = 0;
    if (doc.tail.kind === 'notched') {
      const tip = chainMinX(ch);
      if (!near(tip.x, 0, PLAN_EXACT_TOL)) {
        ok = false;
        err(
          'notch-tip',
          `outline.${side}: the tips of a notched tail are at x = 0; its rearmost point is x = ${tip.x}`,
          at,
          tip.x,
        );
        continue;
      }
      if (!decreasing(ch, 0, tip.s)) {
        ok = false;
        err('notch-tip', `outline.${side}: x must decrease from the notch bottom to the tip`, at);
        continue;
      }
      sFrom = tip.s;
      const zone = doc.tail.zone;
      const d = first.p[0];
      if (!(zone > 0 && d + zone < L)) {
        ok = false;
        err(
          'notch-zone',
          `the notch zone must be > 0 and end before the nose; got d = ${d}, zone = ${zone}, length ${L}`,
          at,
          zone,
        );
        continue;
      }
    }
    if (!increasing(ch, sFrom, ch.segments)) {
      ok = false;
      err(
        'outline-not-function',
        `outline.${side}: x must not decrease along the board${doc.tail.kind === 'notched' ? ' after the tip' : ''}`,
        at,
      );
      continue;
    }
    if (doc.tail.kind === 'notched') {
      const frame = makeFrame(ch, doc.tail);
      if (!notchIssues(frame, side, err)) ok = false;
    }
  }
  return ok;
}

const stepsOf = (s0: number, s1: number): number =>
  Math.max(1, Math.ceil(s1 - s0)) * OUTLINE_CHECK_SAMPLES;

function increasing(ch: CompiledChain, s0: number, s1: number): boolean {
  const o = new Float64Array(4);
  const n = stepsOf(s0, s1);
  for (let i = 0; i <= n; i++) {
    chainEval(ch, s0 + ((s1 - s0) * i) / n, 1, o, 0);
    if (o[2]! < -PLAN_EXACT_TOL) return false;
  }
  return true;
}

function decreasing(ch: CompiledChain, s0: number, s1: number): boolean {
  const o = new Float64Array(4);
  const n = stepsOf(s0, s1);
  // the end is the next segment's start (a corner tip): leave it out
  for (let i = 0; i < n; i++) {
    chainEval(ch, s0 + ((s1 - s0) * i) / n, 1, o, 0);
    if (o[2]! > PLAN_EXACT_TOL) return false;
  }
  return true;
}

/** The chord map and the chord angles over the notch zone. */
function notchIssues(frame: PlanFrame, side: 'plus' | 'minus', err: Err): boolean {
  const n = frame.notch!;
  const s = new Float64Array(3);
  const p = new Float64Array(6);
  const o = new Float64Array(4);
  let ok = true;
  let minAngle = Infinity;
  let at = 0;
  for (let i = 0; i <= NOTCH_CHECK_SAMPLES; i++) {
    const xi = n.d + (n.zone * i) / NOTCH_CHECK_SAMPLES;
    outlineParam(frame, xi, s);
    if (!(s[1]! > 0)) {
      ok = false;
      err(
        'notch-chords-cross',
        `outline.${side}: the notch zone's chord map is not increasing at x = ${xi}; chords would cross`,
        { side, x: xi },
        s[1],
      );
      break;
    }
    if (i === 0) continue;
    frameAt(frame, xi, p);
    const wx = p[0]! - xi;
    const wy = p[1]!;
    chainEval(frame.chain, s[0]!, 1, o, 0);
    const len = Math.hypot(wx, wy) * Math.hypot(o[2]!, o[3]!);
    if (len > 0) {
      const sin = Math.abs(wx * o[3]! - wy * o[2]!) / len;
      const angle = Math.asin(Math.min(1, sin));
      if (angle < minAngle) {
        minAngle = angle;
        at = xi;
      }
    }
  }
  if (ok && minAngle < MIN_CHORD_ANGLE) {
    ok = false;
    err(
      'notch-chord-angle',
      `outline.${side}: a notch-zone chord crosses the outline at ${((minAngle * 180) / Math.PI).toFixed(1)} degrees (minimum ${((MIN_CHORD_ANGLE * 180) / Math.PI).toFixed(0)}) at x = ${at}`,
      { side, x: at },
      minAngle,
    );
  }
  return ok;
}

function lineIssues(
  doc: BoardDoc,
  rocker: CompiledChain,
  deck: CompiledChain,
  L: number,
  err: Err,
): boolean {
  let ok = true;
  for (const [name, ch] of [
    ['rocker', rocker],
    ['deck', deck],
  ] as const) {
    const x0 = ch.c[0]!;
    const x1 = ch.c[8 * ch.segments - 2]!;
    if (!(near(x0, 0, PLAN_EXACT_TOL) && near(x1, L, PLAN_EXACT_TOL))) {
      ok = false;
      err(
        'line-domain',
        `${name} must span x = 0 to the board length ${L}; got ${x0} to ${x1}`,
        undefined,
        x0,
      );
      continue;
    }
    for (let k = 0; k < ch.segments; k++) {
      const b = 8 * k;
      if (
        !(ch.c[b]! <= ch.c[b + 2]! && ch.c[b + 2]! <= ch.c[b + 4]! && ch.c[b + 4]! <= ch.c[b + 6]!)
      ) {
        ok = false;
        err(
          'line-not-function',
          `${name} segment ${k}: the control points' x must not decrease (z must be a function of x)`,
          { key: k },
        );
        break;
      }
    }
  }
  if (!ok) return false;
  const r = new Float64Array(3);
  const d = new Float64Array(3);
  const n = Math.max(rocker.segments, deck.segments) * LINE_CHECK_SAMPLES;
  for (let i = 0; i <= n; i++) {
    const x = (L * i) / n;
    funcEval(rocker, x, r, 0);
    funcEval(deck, x, d, 0);
    if (!(d[0]! - r[0]! > MIN_THICKNESS)) {
      err(
        'thickness',
        `the deck must be above the rocker; at x = ${x} the thickness is ${d[0]! - r[0]!}`,
        { x },
        d[0]! - r[0]!,
      );
      return false;
    }
  }
  void doc;
  return true;
}

/** The smallest chord length over [a, b] on every side. */
function minChord(frames: readonly PlanFrame[], a: number, b: number): number {
  const p = new Float64Array(6);
  let m = Infinity;
  const n = NOTCH_CHECK_SAMPLES;
  for (const f of frames) {
    for (let i = 0; i <= n; i++) {
      const xi = a + ((b - a) * i) / n;
      frameAt(f, xi, p);
      m = Math.min(m, Math.hypot(p[0]! - xi, p[1]!));
    }
  }
  return m;
}
